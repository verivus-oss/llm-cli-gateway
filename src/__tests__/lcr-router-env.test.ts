import { describe, expect, it } from "vitest";
import { buildRouterEnv, toRouterConfig, type RouterEnvDeps } from "../lcr-router-env.js";
import { PerformanceMetrics } from "../metrics.js";
import { CLI_TYPES } from "../provider-types.js";
import { defaultLeastCostConfig } from "../config.js";
import type { JobLimiterSnapshot } from "../async-job-manager.js";

function snapshot(overrides: Partial<JobLimiterSnapshot> = {}): JobLimiterSnapshot {
  return {
    maxRunning: 32,
    maxRunningPerProvider: 16,
    maxQueued: 128,
    running: 0,
    queued: 0,
    runningByProvider: {},
    queuedByProvider: {},
    rejected: 0,
    timedOut: 0,
    saturated: false,
    ...overrides,
  };
}

function deps(overrides: Partial<RouterEnvDeps> = {}): RouterEnvDeps {
  return {
    performanceMetrics: new PerformanceMetrics(),
    limiterSnapshot: snapshot(),
    apiProviders: [],
    ...overrides,
  };
}

describe("buildRouterEnv", () => {
  it("enumerates the CLI_TYPES pool plus enabled API providers", () => {
    const env = buildRouterEnv(deps());
    for (const cli of CLI_TYPES) {
      expect(env.providers()).toContain(cli);
    }
  });

  it("lists concrete model ids per CLI that resolve to priced families", () => {
    const env = buildRouterEnv(deps());
    const claudeModels = env.models("claude");
    expect(claudeModels).toContain("sonnet");
    expect(claudeModels).toContain("opus");
    // A priced model cost is produced for a known family.
    const cost = env.modelCost("claude", "sonnet");
    expect(cost.source).toBe("table");
    expect(cost.family).toBe("claude-sonnet");
    expect(cost.outputUsdPerMTok).toBeGreaterThan(0);
  });

  it("reports an unknown model as source 'unknown' (never a free zero)", () => {
    const env = buildRouterEnv(deps());
    expect(env.modelCost("claude", "totally-made-up-model").source).toBe("unknown");
  });

  it("defaults breaker CLOSED and capacity available", () => {
    const env = buildRouterEnv(deps());
    expect(env.breakerState("claude")).toBe("CLOSED");
    expect(env.atCapacity("claude")).toBe(false);
  });

  it("reports at-capacity when a provider hits its per-provider running cap", () => {
    const env = buildRouterEnv(
      deps({ limiterSnapshot: snapshot({ runningByProvider: { claude: 16 } }) })
    );
    expect(env.atCapacity("claude")).toBe(true);
    expect(env.atCapacity("codex")).toBe(false);
  });

  it("surfaces explicit capability flags from provider-definitions", () => {
    const env = buildRouterEnv(deps());
    const caps = env.capabilities("claude");
    expect(caps.toolCalling).toBe(true);
    expect(caps.jsonSchema).toBe(true);
    expect(Array.isArray(caps.outputFormats)).toBe(true);
    expect(caps.capabilityScope).toBe("full");
  });

  it("treats cursor as maintain-only (excluded unless explicitly listed)", () => {
    const env = buildRouterEnv(deps());
    expect(env.capabilities("cursor").capabilityScope).toBe("maintain-only");
  });

  it("returns 0 success-rate / latency when no history exists", () => {
    const env = buildRouterEnv(deps());
    expect(env.successRate("claude", "sonnet")).toBe(0);
    expect(env.meanLatencyMs("claude", "sonnet")).toBe(0);
  });

  it("reflects recorded per-provider success-rate for tie-break", () => {
    const metrics = new PerformanceMetrics();
    metrics.recordRequest("claude", 100, true);
    metrics.recordRequest("claude", 300, true);
    const env = buildRouterEnv(deps({ performanceMetrics: metrics }));
    expect(env.successRate("claude", "sonnet")).toBe(1);
    expect(env.meanLatencyMs("claude", "sonnet")).toBe(200);
  });

  it("honors an injected auth resolver (tests exercise the auth filter)", () => {
    const env = buildRouterEnv(deps({ isAuthed: p => p === "claude" }));
    expect(env.isAuthed("claude")).toBe(true);
    expect(env.isAuthed("codex")).toBe(false);
  });

  it("production auth is optimistic for installed CLI providers", () => {
    const env = buildRouterEnv(deps());
    // No spawn in the hot path: CLI providers are optimistically authed.
    expect(env.isAuthed("claude")).toBe(true);
  });
});

describe("toRouterConfig", () => {
  it("projects a LeastCostConfig into the pure RouterConfig", () => {
    const cfg = defaultLeastCostConfig();
    const rc = toRouterConfig(cfg);
    expect(rc.minTier).toBe("standard");
    expect(rc.maxCostUsd).toBe(cfg.maxCostUsd);
    expect(rc.tiers["claude:claude-sonnet"]).toBe("standard");
    expect(rc.candidates).toEqual({ allow: [], deny: [] });
    // Empty preference order maps to undefined (no tie-break preference).
    expect(rc.preferenceOrder).toBeUndefined();
  });

  it("passes a non-empty preference order through", () => {
    const cfg = { ...defaultLeastCostConfig(), preferenceOrder: ["grok", "gemini"] };
    expect(toRouterConfig(cfg).preferenceOrder).toEqual(["grok", "gemini"]);
  });
});
