import { describe, it, expect } from "vitest";
import {
  computeLcrPriors,
  computeLcrPriorsFromDb,
  confidenceFromQuality,
  lookupCalibrationK,
  loadLcrPriorRows,
  CALIBRATION_K_MIN_SAMPLES,
  type LcrPriorRow,
} from "../lcr-priors.js";
import { estimateInputTokens, classifyContent } from "../token-estimator.js";
import { modelIdToFamily } from "../pricing.js";
import type { FlightRecorderQuery } from "../flight-recorder.js";

// Deterministic prose prompt (classifies as "prose"; no clock, no randomness).
const PROSE = "Please summarize the meeting notes and list the action items for the team today.";

function row(overrides: Partial<LcrPriorRow>): LcrPriorRow {
  return {
    provider: "codex",
    model: "gpt-5.5",
    prompt: PROSE,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    costUsd: null,
    costBasis: null,
    routeEstCostUsd: null,
    ownerPrincipal: null,
    sessionContinued: false,
    ...overrides,
  };
}

const GLOBAL = { priorsScope: "global" as const };

describe("output-token priors", () => {
  it("computes median and p90 per (provider, model)", () => {
    const rows = [10, 20, 30, 40, 50].map(n =>
      row({ provider: "codex", model: "gpt-5.5", outputTokens: n })
    );
    const priors = computeLcrPriors(rows, GLOBAL);
    const prior = priors.outputPriors.get("codex:gpt-5.5");
    expect(prior).toBeDefined();
    expect(prior!.samples).toBe(5);
    // R-7 percentile: p50 => arr[2] = 30; p90 => 40 + (50-40)*0.6 = 46.
    expect(prior!.median).toBe(30);
    expect(prior!.p90).toBeCloseTo(46, 10);
  });

  it("keys output priors by provider+model, not by family", () => {
    const rows = [
      row({ provider: "cursor", model: "claude-sonnet-4.5", outputTokens: 100 }),
      row({ provider: "claude", model: "claude-sonnet-4.5", outputTokens: 200 }),
    ];
    const priors = computeLcrPriors(rows, GLOBAL);
    // Different providers => different output-prior keys even at the same model.
    expect(priors.outputPriors.has("cursor:claude-sonnet-4.5")).toBe(true);
    expect(priors.outputPriors.has("claude:claude-sonnet-4.5")).toBe(true);
  });
});

describe("input-token calibration k", () => {
  it("computes k = median(actual/base) for an inclusive family using input_tokens as-is", () => {
    const family = modelIdToFamily("gpt-5.5"); // openai-gpt5 (inclusive)
    const base = estimateInputTokens(PROSE, { family });
    // Inclusive: actual = input_tokens; cache_* MUST be ignored. Set a huge cache
    // read to prove it is not added back for inclusive families.
    const r = row({
      provider: "codex",
      model: "gpt-5.5",
      inputTokens: 2 * base,
      cacheReadTokens: 999999,
      cacheCreationTokens: 999999,
    });
    const priors = computeLcrPriors([r], GLOBAL);
    const key = `${classifyContent(PROSE)}:${family}`;
    const bucket = priors.calibration.get(key);
    expect(bucket).toBeDefined();
    expect(bucket!.samples).toBe(1);
    expect(bucket!.k).toBeCloseTo(2, 10);
  });

  it("reconstructs disjoint (claude) actual_input as fresh + cache_read + cache_creation", () => {
    const family = modelIdToFamily("claude-sonnet-4.5"); // claude-sonnet (disjoint)
    expect(family.startsWith("claude-")).toBe(true);
    const base = estimateInputTokens(PROSE, { family });
    // fresh=base, cache_read=base, cache_creation=0 => actual=2*base => ratio 2.
    const r = row({
      provider: "claude",
      model: "claude-sonnet-4.5",
      inputTokens: base,
      cacheReadTokens: base,
      cacheCreationTokens: 0,
    });
    const priors = computeLcrPriors([r], GLOBAL);
    const key = `${classifyContent(PROSE)}:${family}`;
    const bucket = priors.calibration.get(key);
    expect(bucket).toBeDefined();
    expect(bucket!.k).toBeCloseTo(2, 10);
  });

  it("excludes mistral session-continued rows from k", () => {
    const family = modelIdToFamily("mistral-medium-3.5"); // mistral-medium (inclusive)
    const base = estimateInputTokens(PROSE, { family });
    const fresh = row({
      provider: "mistral",
      model: "mistral-medium-3.5",
      inputTokens: base, // ratio 1
      sessionContinued: false,
    });
    const continued = row({
      provider: "mistral",
      model: "mistral-medium-3.5",
      inputTokens: 100 * base, // ratio 100 (cumulative) -> would poison k
      sessionContinued: true,
    });
    const priors = computeLcrPriors([fresh, continued], GLOBAL);
    const key = `${classifyContent(PROSE)}:${family}`;
    const bucket = priors.calibration.get(key);
    expect(bucket).toBeDefined();
    expect(bucket!.samples).toBe(1); // only the fresh row
    expect(bucket!.k).toBeCloseTo(1, 10);
  });

  it("buckets by resolved family via modelIdToFamily, not the CLI brand", () => {
    const family = modelIdToFamily("claude-sonnet-4.5"); // claude-sonnet
    const base = estimateInputTokens(PROSE, { family });
    // cursor and devin brands both running a claude-family model: they MUST merge
    // into the same (content-type, claude-sonnet) bucket as a claude-brand row.
    const rows = [
      row({ provider: "cursor", model: "claude-sonnet-4.5", inputTokens: base }),
      row({ provider: "devin", model: "claude-sonnet-4.5", inputTokens: base }),
      row({ provider: "claude", model: "claude-sonnet-4.5", inputTokens: base }),
    ];
    const priors = computeLcrPriors(rows, GLOBAL);
    const key = `${classifyContent(PROSE)}:claude-sonnet`;
    const bucket = priors.calibration.get(key);
    expect(bucket).toBeDefined();
    expect(bucket!.samples).toBe(3);
    // No brand-keyed calibration bucket exists.
    expect(priors.calibration.has(`${classifyContent(PROSE)}:cursor`)).toBe(false);
  });

  it("computes residual p10/p50/p90 for the bucket", () => {
    const family = modelIdToFamily("gpt-5.5");
    const base = estimateInputTokens(PROSE, { family });
    const rows = [1, 2, 3].map(mult =>
      row({ provider: "codex", model: "gpt-5.5", inputTokens: mult * base })
    );
    const priors = computeLcrPriors(rows, GLOBAL);
    const bucket = priors.calibration.get(`${classifyContent(PROSE)}:${family}`)!;
    // Ratios sorted [1,2,3]: p10 => 1.2, p50 => 2, p90 => 2.8.
    expect(bucket.p10).toBeCloseTo(1.2, 10);
    expect(bucket.p50).toBeCloseTo(2, 10);
    expect(bucket.p90).toBeCloseTo(2.8, 10);
    expect(bucket.confidence).toBe("low"); // only 3 samples
  });
});

describe("confidenceFromQuality mapping", () => {
  it("labels high when samples >= 30 and spread <= 1.5", () => {
    expect(confidenceFromQuality(30, 1.0, 1.4)).toBe("high");
    expect(confidenceFromQuality(50, 1.0, 1.5)).toBe("high");
  });

  it("labels medium at the middle band", () => {
    expect(confidenceFromQuality(30, 1.0, 2.0)).toBe("medium"); // wide-ish but <=3
    expect(confidenceFromQuality(15, 1.0, 1.2)).toBe("medium"); // <30 samples
  });

  it("labels low when too few samples or too wide a spread", () => {
    expect(confidenceFromQuality(5, 1.0, 1.0)).toBe("low"); // <10 samples
    expect(confidenceFromQuality(30, 1.0, 4.0)).toBe("low"); // spread > 3
    expect(confidenceFromQuality(30, 0, 1.0)).toBe("low"); // undefined spread
  });
});

describe("lookupCalibrationK", () => {
  it("returns 1 for a missing bucket", () => {
    const priors = computeLcrPriors([], GLOBAL);
    expect(lookupCalibrationK(priors, "prose", "openai-gpt5")).toBe(1);
  });

  it("returns 1 below the min-sample floor, and the learned k at/above it", () => {
    const family = modelIdToFamily("gpt-5.5");
    const base = estimateInputTokens(PROSE, { family });
    const contentType = classifyContent(PROSE);

    // Below floor: one sample of ratio 2 => bucket stores k=2 but lookup floors to 1.
    const few = computeLcrPriors(
      [row({ provider: "codex", model: "gpt-5.5", inputTokens: 2 * base })],
      GLOBAL
    );
    expect(few.calibration.get(`${contentType}:${family}`)!.k).toBeCloseTo(2, 10);
    expect(lookupCalibrationK(few, contentType, family)).toBe(1);

    // At/above floor: CALIBRATION_K_MIN_SAMPLES rows of ratio 2 => lookup returns 2.
    const many = computeLcrPriors(
      Array.from({ length: CALIBRATION_K_MIN_SAMPLES }, () =>
        row({ provider: "codex", model: "gpt-5.5", inputTokens: 2 * base })
      ),
      GLOBAL
    );
    expect(lookupCalibrationK(many, contentType, family)).toBeCloseTo(2, 10);
  });
});

describe("accuracy split by cost_basis", () => {
  it("keeps derived and provider-reported accuracy in separate buckets", () => {
    const rows = [
      row({
        provider: "codex",
        model: "gpt-5.5",
        costBasis: "derived-from-tokens",
        routeEstCostUsd: 1,
        costUsd: 1, // ratio 1
      }),
      row({
        provider: "codex",
        model: "gpt-5.5",
        costBasis: "derived-from-tokens",
        routeEstCostUsd: 2,
        costUsd: 1, // ratio 2
      }),
      row({
        provider: "codex",
        model: "gpt-5.5",
        costBasis: "provider-reported",
        routeEstCostUsd: 1,
        costUsd: 2, // ratio 0.5
      }),
    ];
    const priors = computeLcrPriors(rows, GLOBAL);
    const derived = priors.accuracyByBasis.get("codex:gpt-5.5::derived-from-tokens");
    const reported = priors.accuracyByBasis.get("codex:gpt-5.5::provider-reported");
    expect(derived).toBeDefined();
    expect(reported).toBeDefined();
    expect(derived!.samples).toBe(2);
    expect(derived!.medianAccuracy).toBeCloseTo(1.5, 10);
    expect(derived!.costBasis).toBe("derived-from-tokens");
    expect(reported!.samples).toBe(1);
    expect(reported!.medianAccuracy).toBeCloseTo(0.5, 10);
  });
});

describe("priors_scope", () => {
  it("principal restricts to the caller's owner_principal rows (no cross-principal leakage)", () => {
    const rows = [
      row({ provider: "codex", model: "gpt-5.5", outputTokens: 10, ownerPrincipal: "alice" }),
      row({ provider: "codex", model: "gpt-5.5", outputTokens: 20, ownerPrincipal: "alice" }),
      row({ provider: "grok", model: "grok-4", outputTokens: 999, ownerPrincipal: "bob" }),
    ];
    const priors = computeLcrPriors(rows, {
      priorsScope: "principal",
      ownerPrincipal: "alice",
    });
    // Only alice's model appears; bob's row is invisible.
    expect(priors.outputPriors.has("codex:gpt-5.5")).toBe(true);
    expect(priors.outputPriors.get("codex:gpt-5.5")!.samples).toBe(2);
    expect(priors.outputPriors.has("grok:grok-4")).toBe(false);
  });

  it("principal with no matching principal yields empty priors", () => {
    const rows = [
      row({ provider: "codex", model: "gpt-5.5", outputTokens: 10, ownerPrincipal: "alice" }),
    ];
    const priors = computeLcrPriors(rows, { priorsScope: "principal", ownerPrincipal: "carol" });
    expect(priors.outputPriors.size).toBe(0);
    expect(priors.calibration.size).toBe(0);
    expect(priors.accuracyByBasis.size).toBe(0);
  });

  it("off disables learning: empty priors and neutral k = 1", () => {
    const family = modelIdToFamily("gpt-5.5");
    const base = estimateInputTokens(PROSE, { family });
    const rows = Array.from({ length: 50 }, () =>
      row({ provider: "codex", model: "gpt-5.5", inputTokens: 2 * base, outputTokens: 42 })
    );
    const priors = computeLcrPriors(rows, { priorsScope: "off" });
    expect(priors.outputPriors.size).toBe(0);
    expect(priors.calibration.size).toBe(0);
    expect(priors.accuracyByBasis.size).toBe(0);
    expect(lookupCalibrationK(priors, classifyContent(PROSE), family)).toBe(1);
  });

  it("the priors shape carries no principal field (anonymized model-level only)", () => {
    const rows = [
      row({ provider: "codex", model: "gpt-5.5", outputTokens: 10, ownerPrincipal: "alice" }),
    ];
    const priors = computeLcrPriors(rows, GLOBAL);
    const serialized = JSON.stringify([
      ...priors.outputPriors.values(),
      ...priors.calibration.values(),
      ...priors.accuracyByBasis.values(),
    ]);
    expect(serialized).not.toContain("alice");
  });
});

describe("loadLcrPriorRows (flight-recorder read path)", () => {
  // Minimal FlightRecorderQuery stub returning fixed raw rows in datetime order.
  function stubDb(rawRows: Record<string, unknown>[]): FlightRecorderQuery {
    return {
      queryRequests<T = Record<string, unknown>>(): T[] {
        return rawRows as T[];
      },
    };
  }

  it("marks the second mistral row that reuses a session_id as sessionContinued", () => {
    const db = stubDb([
      {
        cli: "mistral",
        model: "mistral-medium-3.5",
        prompt: PROSE,
        input_tokens: 100,
        output_tokens: 50,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        cost_basis: null,
        owner_principal: "alice",
        session_id: "gw-abc",
        datetime_utc: "2026-07-01T00:00:00.000Z",
        cost_usd: null,
        route_est_cost_usd: null,
      },
      {
        cli: "mistral",
        model: "mistral-medium-3.5",
        prompt: PROSE,
        input_tokens: 300, // cumulative
        output_tokens: 120,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        cost_basis: null,
        owner_principal: "alice",
        session_id: "gw-abc",
        datetime_utc: "2026-07-01T00:05:00.000Z",
        cost_usd: null,
        route_est_cost_usd: null,
      },
    ]);
    const rows = loadLcrPriorRows(db);
    expect(rows).toHaveLength(2);
    expect(rows[0].sessionContinued).toBe(false); // first occurrence = fresh
    expect(rows[1].sessionContinued).toBe(true); // reused session id = continued
    expect(rows[0].provider).toBe("mistral");
    expect(rows[0].costUsd).toBeNull();
  });

  it("computeLcrPriorsFromDb reads via queryRequests and aggregates", () => {
    const db = stubDb([
      {
        cli: "codex",
        model: "gpt-5.5",
        prompt: PROSE,
        input_tokens: null,
        output_tokens: 30,
        cache_read_tokens: null,
        cache_creation_tokens: null,
        cost_basis: null,
        owner_principal: null,
        session_id: null,
        datetime_utc: "2026-07-01T00:00:00.000Z",
        cost_usd: null,
        route_est_cost_usd: null,
      },
    ]);
    const priors = computeLcrPriorsFromDb(db, GLOBAL);
    expect(priors.outputPriors.get("codex:gpt-5.5")!.median).toBe(30);
  });
});
