/**
 * Least-cost-routing (LCR) feedback aggregator (phase_2, DAG step
 * `feedback-aggregator`; spec section 4.6).
 *
 * Pure, read-only sibling of `cache-stats.ts`. It READS flight-recorder rows
 * (the `requests` + `gateway_metadata` tables) through the SAME
 * `FlightRecorderQuery.queryRequests` read path the cache aggregates use, and
 * computes ANONYMIZED MODEL-LEVEL economics only. It NEVER writes the DB, spawns
 * a process, or uses `Math.random`; it is deterministic over its input rows.
 *
 * Four aggregates (spec 4.6, enhancements 2 + 5):
 *   1. Per-`(provider, model)` rolling median + p90 of `output_tokens` (feeds the
 *      ranking and budget output priors, spec 4.2).
 *   2. Per-`(content-type, resolved-family)` input-token calibration factor
 *      `k = median(actual_input_tokens / base_estimate)`, its sample count, and
 *      the residual p10/p50/p90 of `actual/base` (feeds token-estimator layer 3
 *      and the confidence band).
 *   3. Per-`(provider, model)` estimate-vs-actual cost accuracy
 *      (`route_est_cost_usd / cost_usd`), SPLIT BY `cost_basis` so a T2 provider's
 *      derived accuracy is not mixed with a T4 provider's estimate accuracy.
 *   4. A confidence label derived from calibration quality (see
 *      `confidenceFromQuality`).
 *
 * Two calibration caveats keep `k` honest (spec 4.2 layer 3):
 *   (a) DISJOINT families (claude/anthropic; family starts with "claude-") log
 *       `input_tokens` as FRESH-only, so `actual_input` is reconstructed as
 *       `input_tokens + cache_read_tokens + cache_creation_tokens` to be
 *       comparable to the whole-prompt base estimate. Inclusive families use
 *       `input_tokens` as-is.
 *   (b) mistral `session_*` counts can be cumulative across a multi-turn session,
 *       so session-continued mistral rows are EXCLUDED from `k` (see
 *       `LcrPriorRow.sessionContinued` and `loadLcrPriorRows`).
 *
 * The priors carry no caller-identifying content. `priorsScope` scopes learning
 * to the caller's own `owner_principal` rows (`principal`), disables it (`off`),
 * or uses all rows (`global`). The output shape has no principal field, so no
 * cross-principal identity can leak by construction.
 */

import type { FlightRecorderQuery } from "./flight-recorder.js";
import type { Confidence } from "./least-cost-types.js";
import { estimateInputTokens, classifyContent } from "./token-estimator.js";
import type { ContentType } from "./token-estimator.js";
import { modelIdToFamily } from "./pricing.js";

/** Learning scope for the feedback loop (spec 4.6; config `priors_scope`). */
export type PriorsScope = "global" | "principal" | "off";

/**
 * Minimum bucket sample count before a learned `k` is applied by
 * `lookupCalibrationK`. Below this floor the estimator falls back to the neutral
 * `k = 1` (cold-start behaviour, token-estimator layer 3).
 */
export const CALIBRATION_K_MIN_SAMPLES = 5;

/**
 * Confidence-label thresholds (spec 4.2 enhancement 5; DAG
 * `test_matrix.unit.calibration_confidence`). `spread = p90 / p10` of the
 * per-bucket `actual/base` residual:
 *   - "high":   samples >= 30 AND spread <= 1.5
 *   - "medium": samples >= 10 AND spread <= 3.0
 *   - "low":    otherwise (too few samples or too wide a residual spread)
 * A non-positive p10 makes the spread undefined and is treated as "low".
 */
export const CONFIDENCE_HIGH_MIN_SAMPLES = 30;
export const CONFIDENCE_HIGH_MAX_SPREAD = 1.5;
export const CONFIDENCE_MEDIUM_MIN_SAMPLES = 10;
export const CONFIDENCE_MEDIUM_MAX_SPREAD = 3.0;

/**
 * One flight-recorder row projected down to exactly the fields the aggregator
 * consumes. Accepting an array of these keeps `computeLcrPriors` trivially
 * unit-testable; `loadLcrPriorRows` builds them from the live recorder.
 */
export interface LcrPriorRow {
  /** Logged CLI brand (e.g. "claude", "codex", "mistral", "grok-api"). */
  provider: string;
  /** Resolved model id / alias (bucketed to a family via `modelIdToFamily`). */
  model: string;
  /** Full persisted prompt (drives `base_estimate` and the content classifier). */
  prompt: string;
  /** Reported input tokens. For disjoint families this is FRESH-only. */
  inputTokens: number | null;
  /** Reported output tokens (feeds the output priors). */
  outputTokens: number | null;
  /** Reported cache-read tokens (added back for disjoint reconstruction). */
  cacheReadTokens: number | null;
  /** Reported cache-creation tokens (added back for disjoint reconstruction). */
  cacheCreationTokens: number | null;
  /** Recorded actual/derived cost (`gateway_metadata.cost_usd`). */
  costUsd: number | null;
  /** How `costUsd` was derived (`requests.cost_basis`); splits the accuracy map. */
  costBasis: string | null;
  /** Pre-flight routing cost estimate (`gateway_metadata.route_est_cost_usd`). */
  routeEstCostUsd: number | null;
  /** Ownership principal (`requests.owner_principal`); used only for scoping. */
  ownerPrincipal: string | null;
  /**
   * True when this row is a resumed/continued turn whose reported token counts
   * may be cumulative across the session and must NOT feed calibration `k`.
   * Only ever set for mistral by `loadLcrPriorRows` (see the module header
   * caveat b); other providers keep it false.
   */
  sessionContinued: boolean;
}

/** Per-`(provider, model)` output-token prior. */
export interface OutputPrior {
  median: number;
  p90: number;
  samples: number;
}

/** Per-`(content-type, resolved-family)` input-token calibration bucket. */
export interface CalibrationBucket {
  /** `median(actual_input / base_estimate)` for the bucket. */
  k: number;
  samples: number;
  /** Residual `actual/base` percentiles (feed the confidence band). */
  p10: number;
  p50: number;
  p90: number;
  confidence: Confidence;
}

/** Per-`(provider, model, cost_basis)` estimate-vs-actual accuracy bucket. */
export interface AccuracyBucket {
  provider: string;
  model: string;
  costBasis: string;
  /** `median(route_est_cost_usd / cost_usd)` for the bucket. */
  medianAccuracy: number;
  samples: number;
  p10: number;
  p50: number;
  p90: number;
}

/**
 * The computed priors. All maps are keyed by anonymized model-level identifiers;
 * NO principal or caller-identifying field appears anywhere in this shape.
 *   - `outputPriors`: keyed by `"provider:model"`.
 *   - `calibration`:  keyed by `"content-type:family"`.
 *   - `accuracyByBasis`: keyed by `"provider:model::cost_basis"`.
 */
export interface LcrPriors {
  outputPriors: Map<string, OutputPrior>;
  calibration: Map<string, CalibrationBucket>;
  accuracyByBasis: Map<string, AccuracyBucket>;
}

export interface ComputeLcrPriorsOptions {
  priorsScope: PriorsScope;
  /** The caller's owner_principal; required for `priorsScope === "principal"`. */
  ownerPrincipal?: string;
}

function isFiniteNumber(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

function num(n: number | null | undefined): number {
  return isFiniteNumber(n) ? n : 0;
}

/**
 * Linear-interpolation percentile (the "R-7" / Excel PERCENTILE.INC method) over
 * an ascending-sorted array. `q` is in [0, 1]. Empty => 0; single element => that
 * element. Deterministic (no clock, no randomness).
 */
function percentile(sortedAsc: number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const idx = (n - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  // `.at()` (not `arr[lo]`) keeps the computed-index access off the
  // security/detect-object-injection sink; lo/hi are always in range here.
  const loVal = sortedAsc.at(lo) ?? 0;
  const hiVal = sortedAsc.at(hi) ?? 0;
  if (lo === hi) return loVal;
  return loVal + (hiVal - loVal) * (idx - lo);
}

const outputKey = (provider: string, model: string): string => `${provider}:${model}`;
const calibrationKey = (contentType: ContentType, family: string): string =>
  `${contentType}:${family}`;
const accuracyKey = (provider: string, model: string, costBasis: string): string =>
  `${provider}:${model}::${costBasis}`;

/**
 * Reconstruct the whole-prompt "actual" input token count for calibration.
 * Disjoint families (claude/anthropic) log `input_tokens` as FRESH-only, so the
 * cache subsets are added back; inclusive families already include the cache-read
 * subset in `input_tokens` and use it as-is (spec 4.2 layer 3 caveat a).
 */
function reconstructActualInput(row: LcrPriorRow, family: string): number {
  const input = num(row.inputTokens);
  if (family.startsWith("claude-")) {
    return input + num(row.cacheReadTokens) + num(row.cacheCreationTokens);
  }
  return input;
}

/**
 * Map calibration quality to an advisory confidence label. Thresholds are the
 * module constants above; `spread = p90 / p10`. A non-positive `p10` yields "low"
 * (the spread is undefined). Pure and deterministic.
 */
export function confidenceFromQuality(samples: number, p10: number, p90: number): Confidence {
  if (p10 <= 0) return "low";
  const spread = p90 / p10;
  if (samples >= CONFIDENCE_HIGH_MIN_SAMPLES && spread <= CONFIDENCE_HIGH_MAX_SPREAD) {
    return "high";
  }
  if (samples >= CONFIDENCE_MEDIUM_MIN_SAMPLES && spread <= CONFIDENCE_MEDIUM_MAX_SPREAD) {
    return "medium";
  }
  return "low";
}

/**
 * Look up the learned input-token calibration factor for a
 * `(content-type, resolved-family)` bucket. Returns the bucket's `k` when it
 * exists and meets the `CALIBRATION_K_MIN_SAMPLES` floor, else the neutral 1.
 * This is what token-estimator layer 3 calls (spec 4.2).
 */
export function lookupCalibrationK(
  priors: LcrPriors,
  contentType: ContentType,
  family: string
): number {
  const bucket = priors.calibration.get(calibrationKey(contentType, family));
  if (!bucket) return 1;
  if (bucket.samples < CALIBRATION_K_MIN_SAMPLES) return 1;
  return bucket.k;
}

/**
 * Compute the LCR priors over an array of flight-recorder rows.
 *
 * `priorsScope`:
 *   - "off":       learning disabled. Returns empty priors (so
 *                  `lookupCalibrationK` yields the neutral `k = 1`).
 *   - "principal": restricts input rows to those whose `owner_principal` equals
 *                  `ownerPrincipal` (no match / missing => empty). No
 *                  cross-principal rows are ever aggregated.
 *   - "global":    aggregates all rows, emitting anonymized model-level output
 *                  only (no principal appears in the result).
 */
export function computeLcrPriors(rows: LcrPriorRow[], opts: ComputeLcrPriorsOptions): LcrPriors {
  const empty: LcrPriors = {
    outputPriors: new Map(),
    calibration: new Map(),
    accuracyByBasis: new Map(),
  };

  // "off" disables learning entirely: neutral, empty priors.
  if (opts.priorsScope === "off") return empty;

  // "principal" scopes to the caller's own rows; without a principal there is
  // nothing to scope to, so learning is empty (never a cross-principal fallback).
  let scoped = rows;
  if (opts.priorsScope === "principal") {
    const owner = opts.ownerPrincipal;
    if (owner === undefined) return empty;
    scoped = rows.filter(r => r.ownerPrincipal === owner);
  }

  const outputSamples = new Map<string, number[]>();
  const calibrationRatios = new Map<string, number[]>();
  const accuracyRatios = new Map<string, number[]>();

  for (const row of scoped) {
    // (1) Output-token priors: any row with a finite output_tokens.
    if (isFiniteNumber(row.outputTokens) && row.outputTokens >= 0) {
      const key = outputKey(row.provider, row.model);
      const arr = outputSamples.get(key) ?? [];
      arr.push(row.outputTokens);
      outputSamples.set(key, arr);
    }

    // (2) Input-token calibration k, bucketed by (content-type, RESOLVED family).
    const family = modelIdToFamily(row.model);
    // Skip rows we cannot calibrate: unknown family (no meaningful bucket),
    // session-continued mistral rows (cumulative counts, caveat b), rows with no
    // reported input tokens, and empty/zero base estimates (no ratio).
    if (family !== "unknown" && !row.sessionContinued && isFiniteNumber(row.inputTokens)) {
      const base = estimateInputTokens(row.prompt, { family });
      if (base > 0) {
        const actual = reconstructActualInput(row, family);
        const contentType = classifyContent(row.prompt);
        const key = calibrationKey(contentType, family);
        const arr = calibrationRatios.get(key) ?? [];
        arr.push(actual / base);
        calibrationRatios.set(key, arr);
      }
    }

    // (3) Estimate-vs-actual cost accuracy, split BY cost_basis.
    if (
      isFiniteNumber(row.routeEstCostUsd) &&
      isFiniteNumber(row.costUsd) &&
      row.costUsd > 0 &&
      row.costBasis
    ) {
      const key = accuracyKey(row.provider, row.model, row.costBasis);
      const arr = accuracyRatios.get(key) ?? [];
      arr.push(row.routeEstCostUsd / row.costUsd);
      accuracyRatios.set(key, arr);
    }
  }

  const outputPriors = new Map<string, OutputPrior>();
  for (const [key, values] of outputSamples) {
    values.sort((a, b) => a - b);
    outputPriors.set(key, {
      median: percentile(values, 0.5),
      p90: percentile(values, 0.9),
      samples: values.length,
    });
  }

  const calibration = new Map<string, CalibrationBucket>();
  for (const [key, values] of calibrationRatios) {
    values.sort((a, b) => a - b);
    const p10 = percentile(values, 0.1);
    const p50 = percentile(values, 0.5);
    const p90 = percentile(values, 0.9);
    calibration.set(key, {
      k: p50,
      samples: values.length,
      p10,
      p50,
      p90,
      confidence: confidenceFromQuality(values.length, p10, p90),
    });
  }

  const accuracyByBasis = new Map<string, AccuracyBucket>();
  for (const [key, values] of accuracyRatios) {
    values.sort((a, b) => a - b);
    // Key is `provider:model::costBasis`; recover the parts for the value shape.
    const sep = key.lastIndexOf("::");
    const pm = key.slice(0, sep);
    const costBasis = key.slice(sep + 2);
    const colon = pm.indexOf(":");
    const provider = pm.slice(0, colon);
    const model = pm.slice(colon + 1);
    accuracyByBasis.set(key, {
      provider,
      model,
      costBasis,
      medianAccuracy: percentile(values, 0.5),
      samples: values.length,
      p10: percentile(values, 0.1),
      p50: percentile(values, 0.5),
      p90: percentile(values, 0.9),
    });
  }

  return { outputPriors, calibration, accuracyByBasis };
}

/** Raw joined row shape returned by the flight-recorder read query. */
interface LcrPriorRawRow {
  cli: string;
  model: string;
  prompt: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_basis: string | null;
  owner_principal: string | null;
  session_id: string | null;
  datetime_utc: string;
  cost_usd: number | null;
  route_est_cost_usd: number | null;
}

/**
 * Load LCR prior rows from the live flight recorder, using the SAME read path
 * (`FlightRecorderQuery.queryRequests`) that `cache-stats.ts` uses. Pure
 * read-only: a single parameterless SELECT over `requests` LEFT JOIN
 * `gateway_metadata`, ordered by time so the mistral session-continued marker can
 * be derived deterministically.
 *
 * mistral session-continued heuristic (module caveat b): mistral rows are
 * scanned in ascending `datetime_utc` order and the FIRST row seen per
 * `session_id` is treated as the fresh turn; every later row that reuses an
 * already-seen mistral `session_id` is marked `sessionContinued = true` (its
 * cumulative `session_*` counts would poison `k`). Non-mistral rows are never
 * flagged. Rows with no session id are treated as fresh single-turn requests.
 */
export function loadLcrPriorRows(db: FlightRecorderQuery): LcrPriorRow[] {
  const raw = db.queryRequests<LcrPriorRawRow>(
    `SELECT r.cli, r.model, r.prompt,
            r.input_tokens, r.output_tokens,
            r.cache_read_tokens, r.cache_creation_tokens,
            r.cost_basis, r.owner_principal, r.session_id, r.datetime_utc,
            m.cost_usd, m.route_est_cost_usd
     FROM requests r
     LEFT JOIN gateway_metadata m ON m.request_id = r.id
     ORDER BY r.datetime_utc ASC`
  );

  const seenMistralSessions = new Set<string>();

  return raw.map(row => {
    let sessionContinued = false;
    if (row.cli === "mistral" && row.session_id) {
      if (seenMistralSessions.has(row.session_id)) {
        sessionContinued = true;
      } else {
        seenMistralSessions.add(row.session_id);
      }
    }
    return {
      provider: row.cli,
      model: row.model,
      prompt: row.prompt ?? "",
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      costUsd: row.cost_usd,
      costBasis: row.cost_basis,
      routeEstCostUsd: row.route_est_cost_usd,
      ownerPrincipal: row.owner_principal,
      sessionContinued,
    };
  });
}

/**
 * Thin convenience wrapper: load rows from the live flight recorder and compute
 * the priors in one call. Reuses `loadLcrPriorRows` (the cache-stats read path)
 * and `computeLcrPriors` (the pure aggregation).
 */
export function computeLcrPriorsFromDb(
  db: FlightRecorderQuery,
  opts: ComputeLcrPriorsOptions
): LcrPriors {
  return computeLcrPriors(loadLcrPriorRows(db), opts);
}
