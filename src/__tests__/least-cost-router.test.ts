import { describe, expect, it } from "vitest";
import { selectCandidate } from "../least-cost-router.js";
import type {
  Candidate,
  CandidateCapabilities,
  RouteRequestInput,
  RouterConfig,
  RouterEnv,
} from "../least-cost-router.js";
import type { ModelCost } from "../least-cost-types.js";

// ---------------------------------------------------------------------------
// Mock RouterEnv builder. No CLI spawn, no I/O: everything is a plain lookup
// table keyed by "provider:model" (or "provider" for provider-level facts).
// ---------------------------------------------------------------------------

const DEFAULT_CAPS: CandidateCapabilities = {
  acceptsImages: true,
  acceptsAttachments: true,
  toolCalling: true,
  jsonSchema: true,
  outputFormats: ["text", "json"],
  capabilityScope: "full",
  effortLevels: ["low", "medium", "high"],
};

function priced(family: string, inputUsd: number, outputUsd: number): ModelCost {
  return {
    inputUsdPerMTok: inputUsd,
    outputUsdPerMTok: outputUsd,
    cacheReadMultiplier: 0.1,
    cacheWriteUsdPerMTok: inputUsd,
    accountingMode: "inclusive",
    family,
    source: "table",
    asOf: "2026-06-13",
  };
}

const UNPRICED: ModelCost = {
  inputUsdPerMTok: 0,
  outputUsdPerMTok: 0,
  cacheReadMultiplier: 0,
  cacheWriteUsdPerMTok: 0,
  accountingMode: "inclusive",
  family: "unknown",
  source: "unknown",
  asOf: "2026-06-13",
};

interface MockEnvOptions {
  providers: readonly string[];
  models: Record<string, readonly string[]>;
  authed?: Set<string>;
  breaker?: Record<string, string>;
  atCapacity?: Set<string>;
  caps?: Record<string, CandidateCapabilities>;
  costs: Record<string, ModelCost>;
  successRate?: Record<string, number>;
  meanLatencyMs?: Record<string, number>;
}

function makeEnv(opts: MockEnvOptions): RouterEnv {
  const key = (provider: string, model: string): string => `${provider}:${model}`;
  return {
    providers: () => opts.providers,
    models: (provider: string) => opts.models[provider] ?? [],
    isAuthed: (provider: string) => opts.authed?.has(provider) ?? true,
    breakerState: (provider: string) => opts.breaker?.[provider] ?? "CLOSED",
    atCapacity: (provider: string) => opts.atCapacity?.has(provider) ?? false,
    capabilities: (provider: string) => opts.caps?.[provider] ?? DEFAULT_CAPS,
    modelCost: (provider: string, model: string) => opts.costs[key(provider, model)] ?? UNPRICED,
    successRate: (provider: string, model: string) => opts.successRate?.[key(provider, model)] ?? 0,
    meanLatencyMs: (provider: string, model: string) =>
      opts.meanLatencyMs?.[key(provider, model)] ?? 0,
  };
}

const BASE_CONFIG: RouterConfig = {
  minTier: "standard",
  maxCostUsd: 1,
  defaultExpectedOutputTokens: 500,
  budgetOutputSafetyFactor: 2,
  allowUnpriced: false,
  tiers: {
    "cheap:claude-haiku": "standard",
    "mid:claude-sonnet": "standard",
    "pricey:claude-opus": "frontier",
  },
  candidates: { allow: [], deny: [] },
};

const CHEAP: Candidate = { provider: "cheap", model: "cheap-haiku-1" };
const MID: Candidate = { provider: "mid", model: "mid-sonnet-1" };
const PRICEY: Candidate = { provider: "pricey", model: "pricey-opus-1" };

function twoTierPool(): { env: RouterEnv; config: RouterConfig } {
  const env = makeEnv({
    providers: ["cheap", "mid"],
    models: { cheap: ["cheap-haiku-1"], mid: ["mid-sonnet-1"] },
    costs: {
      "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2),
      "mid:mid-sonnet-1": priced("claude-sonnet", 5, 10),
    },
  });
  return { env, config: BASE_CONFIG };
}

const REQ: RouteRequestInput = { prompt: "hello world, please help me with this task" };

describe("least-cost-router: eligibility filters", () => {
  it("rejects an unauthenticated provider with reason 'auth'", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      authed: new Set(),
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const decision = selectCandidate(REQ, env, BASE_CONFIG);
    expect(decision.chosen).toBeNull();
    expect(decision.error).toBe("NoEligibleCandidate");
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "auth" });
  });

  it("rejects a candidate whose breaker is OPEN with reason 'breaker'", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      breaker: { cheap: "OPEN" },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const decision = selectCandidate(REQ, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "breaker" });
  });

  it("rejects a candidate whose breaker is HALF_OPEN with reason 'breaker'", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      breaker: { cheap: "HALF_OPEN" },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const decision = selectCandidate(REQ, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "breaker" });
  });

  it("rejects a provider at capacity with reason 'capacity'", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      atCapacity: new Set(["cheap"]),
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const decision = selectCandidate(REQ, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "capacity" });
  });

  it("rejects a candidate missing a required capability with a capability:* reason", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      caps: { cheap: { ...DEFAULT_CAPS, acceptsImages: false } },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const req: RouteRequestInput = { ...REQ, requiredCapabilities: { images: true } };
    const decision = selectCandidate(req, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "capability:images" });
  });

  it("rejects an outputFormat not offered by the provider", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const req: RouteRequestInput = { ...REQ, requiredCapabilities: { outputFormat: "xml" } };
    const decision = selectCandidate(req, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({
      candidate: CHEAP,
      reason: "capability:outputFormat",
    });
  });

  it("rejects an effort level not offered by the provider", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const req: RouteRequestInput = { ...REQ, requiredCapabilities: { effort: "ultra" } };
    const decision = selectCandidate(req, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({
      candidate: CHEAP,
      reason: "capability:effort",
    });
  });

  it("rejects a maintain-only provider unless explicitly listed in req.candidates", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      caps: { cheap: { ...DEFAULT_CAPS, capabilityScope: "maintain-only" } },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const implicit = selectCandidate(REQ, env, BASE_CONFIG);
    expect(implicit.rejected).toContainEqual({ candidate: CHEAP, reason: "maintain-only" });

    const explicit = selectCandidate({ ...REQ, candidates: [CHEAP] }, env, BASE_CONFIG);
    expect(explicit.chosen).toEqual(CHEAP);
  });

  it("rejects an untiered candidate unless explicitly listed in req.candidates", () => {
    const env = makeEnv({
      providers: ["ghost"],
      models: { ghost: ["ghost-model"] },
      costs: { "ghost:ghost-model": priced("ghost-family", 0.1, 0.2) },
    });
    const ghost: Candidate = { provider: "ghost", model: "ghost-model" };

    const implicit = selectCandidate(REQ, env, BASE_CONFIG);
    expect(implicit.rejected).toContainEqual({ candidate: ghost, reason: "untiered" });

    const explicit = selectCandidate({ ...REQ, candidates: [ghost] }, env, BASE_CONFIG);
    expect(explicit.chosen).toEqual(ghost);
  });

  it("rejects a tier below minTier with reason 'below-min-tier'", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      costs: { "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2) },
    });
    const config: RouterConfig = {
      ...BASE_CONFIG,
      tiers: { "cheap:claude-haiku": "economy" },
      minTier: "frontier",
    };
    const decision = selectCandidate(REQ, env, config);
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "below-min-tier" });
  });

  it("rejects an unpriced candidate with reason 'unpriced' when allowUnpriced is false", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      costs: {}, // falls through to UNPRICED
    });
    const decision = selectCandidate(REQ, env, BASE_CONFIG);
    expect(decision.rejected).toContainEqual({ candidate: CHEAP, reason: "unpriced" });
  });
});

describe("least-cost-router: selection", () => {
  it("picks the cheaper of two priced, tier-eligible candidates", () => {
    const { env, config } = twoTierPool();
    const decision = selectCandidate(REQ, env, config);
    expect(decision.chosen).toEqual(CHEAP);
    expect(decision.error).toBeUndefined();
    expect(decision.consideredCount).toBe(2);
  });

  it("is deterministic: stable chosen candidate across repeated identical calls", () => {
    const { env, config } = twoTierPool();
    const first = selectCandidate(REQ, env, config);
    const second = selectCandidate(REQ, env, config);
    const third = selectCandidate(REQ, env, config);
    expect(first.chosen).toEqual(CHEAP);
    expect(second.chosen).toEqual(first.chosen);
    expect(third.chosen).toEqual(first.chosen);
    expect(second.estCostUsd).toBe(first.estCostUsd);
  });

  it("re-selects the next-cheapest when the cheapest is excluded", () => {
    const { env, config } = twoTierPool();
    const first = selectCandidate(REQ, env, config);
    expect(first.chosen).toEqual(CHEAP);

    const excluded = new Set<string>(["cheap:cheap-haiku-1"]);
    const second = selectCandidate(REQ, env, config, excluded);
    expect(second.chosen).toEqual(MID);
  });

  it("flags nearTie when the top two rankCosts are within 1%", () => {
    const env = makeEnv({
      providers: ["a", "b"],
      models: { a: ["a-haiku-1"], b: ["b-sonnet-1"] },
      costs: {
        "a:a-haiku-1": priced("claude-haiku", 1, 2),
        "b:b-sonnet-1": priced("claude-sonnet", 1.005, 2), // within 1% of a
      },
    });
    const config: RouterConfig = {
      ...BASE_CONFIG,
      maxCostUsd: 1000,
      tiers: { "a:claude-haiku": "standard", "b:claude-sonnet": "standard" },
    };
    const decision = selectCandidate(REQ, env, config);
    expect(decision.nearTie).toBe(true);
  });

  it("does not flag nearTie when candidates are clearly separated", () => {
    const { env, config } = twoTierPool();
    const decision = selectCandidate(REQ, env, { ...config, maxCostUsd: 1000 });
    expect(decision.nearTie).toBe(false);
  });
});

describe("least-cost-router: budget gate", () => {
  it("fails closed with BudgetExceeded when the cheapest candidate is over budget", () => {
    const env = makeEnv({
      providers: ["pricey"],
      models: { pricey: ["pricey-opus-1"] },
      costs: { "pricey:pricey-opus-1": priced("claude-opus", 1000, 2000) },
    });
    const config: RouterConfig = { ...BASE_CONFIG, maxCostUsd: 0.0001 };
    const decision = selectCandidate(REQ, env, config);
    expect(decision.chosen).toBeNull();
    expect(decision.error).toBe("BudgetExceeded");
    expect(decision.rejected.some(r => r.reason === "budget")).toBe(true);
  });

  it("admits an over-budget candidate only with an explicit budgetWaiver", () => {
    const env = makeEnv({
      providers: ["pricey"],
      models: { pricey: ["pricey-opus-1"] },
      costs: { "pricey:pricey-opus-1": priced("claude-opus", 1000, 2000) },
    });
    const config: RouterConfig = { ...BASE_CONFIG, maxCostUsd: 0.0001 };

    const withoutWaiver = selectCandidate(REQ, env, config);
    expect(withoutWaiver.error).toBe("BudgetExceeded");

    const withWaiver = selectCandidate({ ...REQ, budgetWaiver: true }, env, config);
    expect(withWaiver.chosen).toEqual(PRICEY);
  });

  it("admits an unpriced candidate only when allowUnpriced AND budgetWaiver are both set", () => {
    const env = makeEnv({
      providers: ["ghost"],
      models: { ghost: ["ghost-model"] },
      costs: {},
    });
    const ghost: Candidate = { provider: "ghost", model: "ghost-model" };
    const req: RouteRequestInput = { ...REQ, candidates: [ghost] };

    // Without allowUnpriced, the candidate never survives eligibility (the
    // "unpriced" filter), so the pool empties before budget is even checked.
    const neither = selectCandidate(req, env, BASE_CONFIG);
    expect(neither.chosen).toBeNull();
    expect(neither.error).toBe("NoEligibleCandidate");

    const onlyWaiver = selectCandidate({ ...req, budgetWaiver: true }, env, BASE_CONFIG);
    expect(onlyWaiver.chosen).toBeNull();
    expect(onlyWaiver.error).toBe("NoEligibleCandidate");

    // allowUnpriced alone gets the candidate into the eligible pool, but the
    // budget gate still fails closed without an explicit waiver.
    const onlyAllowUnpriced = selectCandidate({ ...req, allowUnpriced: true }, env, BASE_CONFIG);
    expect(onlyAllowUnpriced.chosen).toBeNull();
    expect(onlyAllowUnpriced.error).toBe("BudgetExceeded");

    const both = selectCandidate(
      { ...req, allowUnpriced: true, budgetWaiver: true },
      env,
      BASE_CONFIG
    );
    expect(both.chosen).toEqual(ghost);
  });
});

describe("least-cost-router: fallback", () => {
  it("returns the fallback only when the eligible pool is empty", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      authed: new Set(["fallback"]), // cheap is unauthenticated -> pool empties; fallback stays healthy
      costs: {
        "cheap:cheap-haiku-1": priced("claude-haiku", 0.1, 0.2),
        "fallback:fallback-model": priced("claude-sonnet", 1, 2),
      },
    });
    const fallback: Candidate = { provider: "fallback", model: "fallback-model" };
    // The fallback bypasses cost RANKING only; it must still pass the
    // eligibility (auth/breaker/capacity/capability, tier) and budget gates
    // (spec 4.7). It is treated as explicitly listed, so its untiered model is
    // admitted without a tiers entry.
    const decision = selectCandidate({ ...REQ, fallback }, env, BASE_CONFIG);
    expect(decision.chosen).toEqual(fallback);
    expect(decision.error).toBeUndefined();
  });

  it("does not use the fallback when the eligible pool is non-empty", () => {
    const { env, config } = twoTierPool();
    const fallback: Candidate = { provider: "fallback", model: "fallback-model" };
    const decision = selectCandidate({ ...REQ, fallback }, env, config);
    expect(decision.chosen).toEqual(CHEAP);
  });

  it("still applies the budget/waiver rule to an unpriced fallback", () => {
    const env = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      authed: new Set(["fallback"]), // pool provider unauthed; fallback healthy but unpriced
      costs: {},
    });
    const fallback: Candidate = { provider: "fallback", model: "fallback-model" };

    const withoutWaiver = selectCandidate({ ...REQ, fallback }, env, BASE_CONFIG);
    expect(withoutWaiver.chosen).toBeNull();
    expect(withoutWaiver.error).toBe("BudgetExceeded");

    const withWaiver = selectCandidate(
      { ...REQ, fallback, allowUnpriced: true, budgetWaiver: true },
      env,
      BASE_CONFIG
    );
    expect(withWaiver.chosen).toEqual(fallback);
  });

  it("rejects an ineligible fallback (unhealthy provider) with NoEligibleCandidate", () => {
    // A caller-pinned fallback must NOT bypass the safety eligibility gates
    // (spec 4.7, contract decision 13): routing to an unauthed or breaker-open
    // provider is never allowed, even as a last resort.
    const unauthedEnv = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      authed: new Set(), // neither cheap nor fallback is authed
      costs: { "fallback:fallback-model": priced("claude-sonnet", 1, 2) },
    });
    const fallback: Candidate = { provider: "fallback", model: "fallback-model" };
    const authDecision = selectCandidate({ ...REQ, fallback }, unauthedEnv, BASE_CONFIG);
    expect(authDecision.chosen).toBeNull();
    expect(authDecision.error).toBe("NoEligibleCandidate");
    expect(authDecision.rejected).toContainEqual({ candidate: fallback, reason: "auth" });

    const breakerEnv = makeEnv({
      providers: ["cheap"],
      models: { cheap: ["cheap-haiku-1"] },
      authed: new Set(["fallback"]),
      breaker: { cheap: "OPEN", fallback: "OPEN" }, // fallback breaker OPEN
      costs: { "fallback:fallback-model": priced("claude-sonnet", 1, 2) },
    });
    const breakerDecision = selectCandidate({ ...REQ, fallback }, breakerEnv, BASE_CONFIG);
    expect(breakerDecision.chosen).toBeNull();
    expect(breakerDecision.error).toBe("NoEligibleCandidate");
    expect(breakerDecision.rejected).toContainEqual({ candidate: fallback, reason: "breaker" });
  });
});
