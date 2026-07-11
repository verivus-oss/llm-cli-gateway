/**
 * Least-cost-routing (LCR) selector: a PURE function that picks the cheapest
 * eligible `(provider, model)` candidate for a request, subject to auth,
 * health, capability, quality-tier, and budget constraints.
 *
 * This module never spawns a CLI, never reads live provider state directly,
 * and never uses `Math.random` / `Date.now` (contract decision 11). All
 * environment-dependent signals (auth, breaker state, capacity, model lists,
 * capabilities, historical metrics, prices) are injected via {@link RouterEnv}
 * so the selector is unit-testable without any of the five modules it
 * composes (provider-status, executor, async-job-manager, provider-definitions,
 * metrics). A later phase builds a production `RouterEnv` from those and calls
 * {@link selectCandidate} from the dispatcher.
 *
 * See docs/least-cost-routing-contract.md and
 * docs/plans/least-cost-routing.draft.md sections 4.3-4.5, 4.7.
 */

import type {
  ModelCost,
  CostBasis,
  Confidence,
  QualityTier,
  PriceSource,
} from "./least-cost-types.js";
import { modelIdToFamily, composeCost } from "./pricing.js";
import { estimateInputTokens } from "./token-estimator.js";

/** A routing unit: a concrete `(provider, model)` pair (contract "Scope"). */
export interface Candidate {
  provider: string;
  model: string;
}

/** Capability facts for a provider, used for capability-eligibility (4.3.3). */
export interface CandidateCapabilities {
  acceptsImages: boolean;
  acceptsAttachments: boolean;
  toolCalling: boolean;
  jsonSchema: boolean;
  outputFormats: readonly string[];
  /** `"maintain-only"` excludes the provider unless explicitly listed in `req.candidates`. */
  capabilityScope: string;
  effortLevels: readonly string[];
}

/**
 * Environment seam: every fact the selector needs about the outside world,
 * injected so tests can mock it without spawning anything real.
 */
export interface RouterEnv {
  /** CLI_TYPES union enabled api-provider names. */
  providers(): readonly string[];
  /** Candidate model ids a given provider can serve. */
  models(provider: string): readonly string[];
  isAuthed(provider: string): boolean;
  /** `"CLOSED" | "OPEN" | "HALF_OPEN"`. */
  breakerState(provider: string): string;
  atCapacity(provider: string): boolean;
  capabilities(provider: string): CandidateCapabilities;
  /** Production: `getModelCost` from src/pricing.ts. */
  modelCost(provider: string, model: string): ModelCost;
  /** 0..1 for tie-break; default 0 is acceptable when no history exists. */
  successRate(provider: string, model: string): number;
  /** Mean latency in ms for tie-break; default 0 is acceptable. */
  meanLatencyMs(provider: string, model: string): number;
  /**
   * Learned input-token calibration factor `k` for `(content-type of prompt,
   * resolved family)` (token-estimator layer 3, spec 4.2). Production reads the
   * flight-recorder priors; default 1 (neutral, cold-start) is always safe. Feeds
   * the point estimate only, so determinism is preserved for a fixed env.
   */
  calibrationK(prompt: string, family: string): number;
}

/** Per-request capability constraints (4.3.3). */
export interface RequiredCapabilities {
  images?: boolean;
  attachments?: boolean;
  toolCalling?: boolean;
  jsonSchema?: boolean;
  outputFormat?: string;
  effort?: string;
}

export interface RouteRequestInput {
  prompt: string;
  /** Explicit pool restriction; also whitelists untiered/maintain-only candidates. */
  candidates?: Candidate[];
  minTier?: QualityTier;
  maxCostUsd?: number;
  expectedOutputTokens?: number;
  /** Caller output cap; bounds the conservative budget estimate. */
  maxOutputTokens?: number;
  requiredCapabilities?: RequiredCapabilities;
  allowUnpriced?: boolean;
  /** Explicit acknowledgment to admit unpriced/over-budget candidates. */
  budgetWaiver?: boolean;
  fallback?: Candidate;
}

export interface RouterConfig {
  /** Default `"standard"`. */
  minTier: QualityTier;
  maxCostUsd: number;
  defaultExpectedOutputTokens: number;
  budgetOutputSafetyFactor: number;
  allowUnpriced: boolean;
  /** Key `"provider:family"` -> tier. */
  tiers: Record<string, QualityTier>;
  /** Entries are `"provider"` or `"provider:model"`; empty `allow` means allow-all. */
  candidates: { allow: string[]; deny: string[] };
  /** Provider preference order for tie-break; missing providers rank last. */
  preferenceOrder?: string[];
}

export interface RejectedCandidate {
  candidate: Candidate;
  reason: string;
}

export interface RouteDecision {
  chosen: Candidate | null;
  tier?: QualityTier;
  estCostUsd?: number;
  costBasis?: CostBasis;
  confidence?: Confidence;
  nearTie?: boolean;
  estInputTokens?: number;
  estOutputTokens?: number;
  priceAsOf?: string;
  priceSource?: PriceSource;
  consideredCount: number;
  rejected: RejectedCandidate[];
  /** Always 0 from the pure selector; the dispatcher increments it on re-select. */
  reroutes: number;
  error?: "NoEligibleCandidate" | "BudgetExceeded";
}

const TIER_ORDER: Record<QualityTier, number> = {
  economy: 0,
  standard: 1,
  frontier: 2,
};

function candidateKey(c: Candidate): string {
  return `${c.provider}:${c.model}`;
}

function isExplicitlyListed(c: Candidate, explicit: readonly Candidate[] | undefined): boolean {
  if (!explicit) return false;
  return explicit.some(e => e.provider === c.provider && e.model === c.model);
}

/** Apply config.candidates allow/deny to the pool. Empty `allow` means allow-all. */
function passesAllowDeny(c: Candidate, config: RouterConfig): boolean {
  const providerKey = c.provider;
  const pairKey = candidateKey(c);
  const matches = (entry: string): boolean => entry === providerKey || entry === pairKey;

  if (config.candidates.deny.some(matches)) return false;
  if (config.candidates.allow.length === 0) return true;
  return config.candidates.allow.some(matches);
}

function buildPool(req: RouteRequestInput, env: RouterEnv, config: RouterConfig): Candidate[] {
  const source: Candidate[] =
    req.candidates && req.candidates.length > 0
      ? req.candidates
      : env
          .providers()
          .flatMap(provider => env.models(provider).map(model => ({ provider, model })));

  return source.filter(c => passesAllowDeny(c, config));
}

interface CapabilityCheckResult {
  ok: boolean;
  reason?: string;
}

function checkCapabilities(
  caps: CandidateCapabilities,
  required: RequiredCapabilities | undefined
): CapabilityCheckResult {
  if (!required) return { ok: true };

  if (required.images === true && !caps.acceptsImages) {
    return { ok: false, reason: "capability:images" };
  }
  if (required.attachments === true && !caps.acceptsAttachments) {
    return { ok: false, reason: "capability:attachments" };
  }
  if (required.toolCalling === true && !caps.toolCalling) {
    return { ok: false, reason: "capability:toolCalling" };
  }
  if (required.jsonSchema === true && !caps.jsonSchema) {
    return { ok: false, reason: "capability:jsonSchema" };
  }
  if (required.outputFormat !== undefined && !caps.outputFormats.includes(required.outputFormat)) {
    return { ok: false, reason: "capability:outputFormat" };
  }
  if (required.effort !== undefined && !caps.effortLevels.includes(required.effort)) {
    return { ok: false, reason: "capability:effort" };
  }
  return { ok: true };
}

interface TierCheckResult {
  ok: boolean;
  reason?: string;
  tier?: QualityTier;
}

function checkTier(
  candidate: Candidate,
  req: RouteRequestInput,
  config: RouterConfig
): TierCheckResult {
  const family = modelIdToFamily(candidate.model);
  const tierKey = `${candidate.provider}:${family}`;
  const tier = config.tiers[tierKey];

  if (tier === undefined) {
    if (isExplicitlyListed(candidate, req.candidates)) {
      // Explicitly listed but untiered: no floor to check against, admit as-is.
      return { ok: true, tier: undefined };
    }
    return { ok: false, reason: "untiered" };
  }

  const effectiveMinTier = req.minTier ?? config.minTier;
  if (TIER_ORDER[tier] < TIER_ORDER[effectiveMinTier]) {
    return { ok: false, reason: "below-min-tier" };
  }
  return { ok: true, tier };
}

interface EligibilityResult {
  ok: boolean;
  reason?: string;
}

/**
 * Run the auth/breaker/capacity/capability portion of the eligibility chain
 * (4.3.1-4.3.3). Tier and price are checked separately by the caller since
 * they need config and the resolved ModelCost.
 */
function evaluateBaseEligibility(
  candidate: Candidate,
  req: RouteRequestInput,
  env: RouterEnv
): EligibilityResult {
  if (!env.isAuthed(candidate.provider)) {
    return { ok: false, reason: "auth" };
  }

  if (env.breakerState(candidate.provider) !== "CLOSED") {
    return { ok: false, reason: "breaker" };
  }

  if (env.atCapacity(candidate.provider)) {
    return { ok: false, reason: "capacity" };
  }

  const caps = env.capabilities(candidate.provider);
  const capResult = checkCapabilities(caps, req.requiredCapabilities);
  if (!capResult.ok) {
    return { ok: false, reason: capResult.reason };
  }
  if (caps.capabilityScope === "maintain-only" && !isExplicitlyListed(candidate, req.candidates)) {
    return { ok: false, reason: "maintain-only" };
  }

  return { ok: true };
}

interface RankedCandidate {
  candidate: Candidate;
  tier?: QualityTier;
  modelCost: ModelCost;
  estInputTokens: number;
  estOutputTokens: number;
  /** Reported estimate (the composeCost figure); 0 for an unpriced candidate. */
  rankCostUsd: number;
  /**
   * Sort key for argmin/tie-break: `rankCostUsd` for priced candidates, but
   * +Infinity for an unpriced (source "unknown") candidate so it can never be
   * the argmin (contract decision 5, invariant unknown_price_never_wins). An
   * unpriced candidate is therefore ranked strictly last and only chosen when no
   * priced candidate is eligible.
   */
  rankKey: number;
  costBasis: CostBasis;
  confidence: Confidence;
}

function rankCandidate(
  candidate: Candidate,
  tier: QualityTier | undefined,
  modelCost: ModelCost,
  req: RouteRequestInput,
  config: RouterConfig,
  env: RouterEnv
): RankedCandidate {
  const family =
    modelCost.family !== "unknown" ? modelCost.family : modelIdToFamily(candidate.model);
  // Layer-3 calibration: the env supplies the learned k for this prompt's
  // content-type and family (1 when uncalibrated). It refines the point estimate
  // only; the tie-break and budget gate stay deterministic for a fixed env.
  const calibrationK = env.calibrationK(req.prompt, family);
  const estInputTokens = estimateInputTokens(req.prompt, { family, calibrationK });
  const estOutputTokens = req.expectedOutputTokens ?? config.defaultExpectedOutputTokens;
  const rankResult = composeCost(null, { estInputTokens, estOutputTokens }, modelCost);
  return {
    candidate,
    tier,
    modelCost,
    estInputTokens,
    estOutputTokens,
    rankCostUsd: rankResult.costUsd,
    rankKey: modelCost.source === "unknown" ? Number.POSITIVE_INFINITY : rankResult.costUsd,
    costBasis: rankResult.cost_basis,
    confidence: rankResult.confidence,
  };
}

function preferenceIndex(provider: string, preferenceOrder: readonly string[] | undefined): number {
  if (!preferenceOrder) return Number.MAX_SAFE_INTEGER;
  const idx = preferenceOrder.indexOf(provider);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/**
 * Deterministic comparator implementing the tie-break chain (4.5.3): lower
 * rankKey (unpriced sorts last via +Infinity), then higher successRate, then
 * lower meanLatencyMs, then lower preferenceOrder index, then lexical
 * `provider/model`.
 */
function compareCandidates(
  a: RankedCandidate,
  b: RankedCandidate,
  env: RouterEnv,
  config: RouterConfig
): number {
  if (a.rankKey !== b.rankKey) return a.rankKey - b.rankKey;

  const successA = env.successRate(a.candidate.provider, a.candidate.model);
  const successB = env.successRate(b.candidate.provider, b.candidate.model);
  if (successA !== successB) return successB - successA;

  const latencyA = env.meanLatencyMs(a.candidate.provider, a.candidate.model);
  const latencyB = env.meanLatencyMs(b.candidate.provider, b.candidate.model);
  if (latencyA !== latencyB) return latencyA - latencyB;

  const prefA = preferenceIndex(a.candidate.provider, config.preferenceOrder);
  const prefB = preferenceIndex(b.candidate.provider, config.preferenceOrder);
  if (prefA !== prefB) return prefA - prefB;

  const lexA = `${a.candidate.provider}/${a.candidate.model}`;
  const lexB = `${b.candidate.provider}/${b.candidate.model}`;
  return lexA.localeCompare(lexB);
}

interface BudgetCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * Conservative budget gate (4.2, 4.5.4, 4.7): fail safe, never silently admit.
 *
 * - Unpriced (source "unknown") has no cost upper bound, so it is admissible
 *   only when the caller sets BOTH allowUnpriced and budgetWaiver (spec 4.5),
 *   in normal selection or as a fallback.
 * - A priced over-budget candidate FAILS CLOSED in normal selection (spec 4.5;
 *   raise maxCostUsd rather than waiving), but an explicit `fallback` may be
 *   admitted over budget under an explicit budgetWaiver (spec 4.7). `isFallback`
 *   distinguishes the two.
 */
function checkBudget(
  ranked: RankedCandidate,
  req: RouteRequestInput,
  config: RouterConfig,
  isFallback: boolean
): BudgetCheckResult {
  const { modelCost, estInputTokens } = ranked;
  const allowUnpriced = req.allowUnpriced ?? config.allowUnpriced;
  const budgetWaiver = req.budgetWaiver ?? false;

  if (modelCost.source === "unknown") {
    if (allowUnpriced && budgetWaiver) return { ok: true };
    return { ok: false, reason: "budget" };
  }

  const budgetOutput =
    req.maxOutputTokens ?? config.defaultExpectedOutputTokens * config.budgetOutputSafetyFactor;
  const budgetResult = composeCost(
    null,
    { estInputTokens, estOutputTokens: budgetOutput },
    modelCost
  );
  const budgetCost = budgetResult.costUsd;
  const effectiveMax = req.maxCostUsd ?? config.maxCostUsd;

  if (budgetCost > effectiveMax) {
    if (isFallback && budgetWaiver) return { ok: true };
    return { ok: false, reason: "budget" };
  }
  return { ok: true };
}

function toDecisionFromRanked(
  ranked: RankedCandidate,
  consideredCount: number,
  rejected: RejectedCandidate[],
  nearTie: boolean
): RouteDecision {
  return {
    chosen: ranked.candidate,
    tier: ranked.tier,
    estCostUsd: ranked.rankCostUsd,
    costBasis: ranked.costBasis,
    confidence: ranked.confidence,
    nearTie,
    estInputTokens: ranked.estInputTokens,
    estOutputTokens: ranked.estOutputTokens,
    priceAsOf: ranked.modelCost.asOf,
    priceSource: ranked.modelCost.source,
    consideredCount,
    rejected,
    reroutes: 0,
  };
}

/**
 * Select the cheapest eligible candidate for a request. Pure: no CLI spawn,
 * no I/O, no clock/random reads. See module doc and contract sections 4.3-4.5,
 * 4.7 for the full algorithm this implements.
 */
export function selectCandidate(
  req: RouteRequestInput,
  env: RouterEnv,
  config: RouterConfig,
  excluded?: ReadonlySet<string>
): RouteDecision {
  const pool = buildPool(req, env, config).filter(c => !excluded?.has(candidateKey(c)));

  const rejected: RejectedCandidate[] = [];
  const eligible: { candidate: Candidate; tier?: QualityTier; modelCost: ModelCost }[] = [];

  for (const candidate of pool) {
    const baseEligibility = evaluateBaseEligibility(candidate, req, env);
    if (!baseEligibility.ok) {
      rejected.push({ candidate, reason: baseEligibility.reason as string });
      continue;
    }

    const tierResult = checkTier(candidate, req, config);
    if (!tierResult.ok) {
      rejected.push({ candidate, reason: tierResult.reason as string });
      continue;
    }

    const modelCost = env.modelCost(candidate.provider, candidate.model);
    const allowUnpriced = req.allowUnpriced ?? config.allowUnpriced;
    if (modelCost.source === "unknown" && !allowUnpriced) {
      rejected.push({ candidate, reason: "unpriced" });
      continue;
    }

    eligible.push({ candidate, tier: tierResult.tier, modelCost });
  }

  if (eligible.length === 0) {
    if (req.fallback) {
      // A caller-pinned fallback bypasses cost RANKING only; it must still pass
      // the eligibility (auth/breaker/capacity/capability, tier) and budget
      // gates (spec 4.7, contract decision 13). Treat it as explicitly listed so
      // an untiered or maintain-only pin is admitted, mirroring req.candidates.
      const fallbackReq: RouteRequestInput = {
        ...req,
        candidates: [...(req.candidates ?? []), req.fallback],
      };
      const fbBase = evaluateBaseEligibility(req.fallback, fallbackReq, env);
      if (!fbBase.ok) {
        return {
          chosen: null,
          consideredCount: 0,
          rejected: [...rejected, { candidate: req.fallback, reason: fbBase.reason as string }],
          reroutes: 0,
          error: "NoEligibleCandidate",
        };
      }
      const fbTier = checkTier(req.fallback, fallbackReq, config);
      if (!fbTier.ok) {
        return {
          chosen: null,
          consideredCount: 0,
          rejected: [...rejected, { candidate: req.fallback, reason: fbTier.reason as string }],
          reroutes: 0,
          error: "NoEligibleCandidate",
        };
      }
      const fallbackModelCost = env.modelCost(req.fallback.provider, req.fallback.model);
      const fallbackRanked = rankCandidate(
        req.fallback,
        fbTier.tier,
        fallbackModelCost,
        req,
        config,
        env
      );
      const budget = checkBudget(fallbackRanked, req, config, true);
      if (!budget.ok) {
        return {
          chosen: null,
          consideredCount: 0,
          rejected: [...rejected, { candidate: req.fallback, reason: budget.reason as string }],
          reroutes: 0,
          error: "BudgetExceeded",
        };
      }
      return toDecisionFromRanked(fallbackRanked, 0, rejected, false);
    }
    return {
      chosen: null,
      consideredCount: 0,
      rejected,
      reroutes: 0,
      error: "NoEligibleCandidate",
    };
  }

  const ranked = eligible.map(e =>
    rankCandidate(e.candidate, e.tier, e.modelCost, req, config, env)
  );
  ranked.sort((a, b) => compareCandidates(a, b, env, config));

  const best = ranked[0];
  const secondBest = ranked.length > 1 ? ranked[1] : undefined;
  const nearTie =
    secondBest !== undefined &&
    Number.isFinite(best.rankKey) &&
    best.rankKey > 0 &&
    Math.abs(secondBest.rankKey - best.rankKey) / best.rankKey <= 0.01;

  const budget = checkBudget(best, req, config, false);
  if (!budget.ok) {
    return {
      chosen: null,
      consideredCount: eligible.length,
      rejected: [...rejected, { candidate: best.candidate, reason: budget.reason as string }],
      reroutes: 0,
      error: "BudgetExceeded",
    };
  }

  return toDecisionFromRanked(best, eligible.length, rejected, nearTie);
}
