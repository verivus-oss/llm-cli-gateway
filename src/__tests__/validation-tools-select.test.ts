/**
 * LCR phase_3: opt-in `select: "cheapest" | "cheapest_per_tier"` on the
 * validation tools. The default path (explicit provider list, no `select`) MUST
 * stay byte-identical; `select` fills the target list via the PURE LCR selector
 * and FAILS CLOSED (never falls back to the default list) when routing is
 * disabled or nothing is eligible.
 */
import { describe, expect, it } from "vitest";
import type { AsyncJobResult, AsyncJobSnapshot, JobLimiterSnapshot } from "../async-job-manager.js";
import { registerValidationTools, type ValidationToolDeps } from "../validation-tools.js";
import { defaultLeastCostConfig, type LeastCostConfig } from "../config.js";
import type { ValidationProvider } from "../validation-normalizer.js";

function snapshot(id: string, cli: string): AsyncJobSnapshot {
  return {
    id,
    cli,
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    exitCode: null,
    correlationId: `corr-${id}`,
    outputTruncated: false,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    exited: false,
  };
}

const EMPTY_LIMITER: JobLimiterSnapshot = {
  maxRunning: 100,
  maxRunningPerProvider: 100,
  maxQueued: 100,
  running: 0,
  queued: 0,
  runningByProvider: {},
  queuedByProvider: {},
  rejected: 0,
  timedOut: 0,
  saturated: false,
};

function makeManager() {
  const startJobCalls: string[] = [];
  let n = 0;
  return {
    startJobCalls,
    manager: {
      startJob(cli: string): AsyncJobSnapshot {
        startJobCalls.push(cli);
        return snapshot(`cli-${++n}`, cli);
      },
      getLimiterSnapshot(): JobLimiterSnapshot {
        return EMPTY_LIMITER;
      },
      getJobResult(): AsyncJobResult | null {
        return null;
      },
      getJobSnapshot(): AsyncJobSnapshot | null {
        return null;
      },
    },
  };
}

// CLI runtime stub: every provider reports installed + authenticated so the
// orchestrator dispatches it (no host probe).
const cliInstalled = (provider: ValidationProvider) =>
  ({
    provider,
    displayName: provider,
    command: provider,
    installed: true,
    version: `${provider}-fake`,
    versionCommand: [provider, "--version"],
    loginStatus: "authenticated",
    loginCheck: {
      method: "not_checked",
      command: null,
      credentialStore: "not_checked",
      detail: "",
    },
    guidance: {
      provider,
      displayName: provider,
      install: { summary: "", commands: [] },
      login: { summary: "", commands: [], credentialHandling: "none" },
      verification: { command: "", expected: "" },
    },
  }) as any;

/** Register the tools onto a capture server and return each handler by name. */
function registerAndCapture(leastCost: LeastCostConfig) {
  const fake = makeManager();
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = {
    tool(
      name: string,
      _desc: string,
      _schema: unknown,
      _ann: unknown,
      cb: (args: any) => Promise<any>
    ) {
      handlers.set(name, cb);
    },
  };
  const deps: ValidationToolDeps = {
    asyncJobManager: fake.manager as any,
    getProviderRuntimeStatus: cliInstalled,
    leastCost,
  };
  registerValidationTools(server as any, deps);
  return { handlers, startJobCalls: fake.startJobCalls };
}

function enabledConfig(overrides: Partial<LeastCostConfig> = {}): LeastCostConfig {
  return { ...defaultLeastCostConfig(), enabled: true, minTier: "economy", ...overrides };
}

describe("validation tools: select opt-in (LCR phase_3)", () => {
  it("default (no select) is unchanged: the explicit provider list is used verbatim", async () => {
    const { handlers, startJobCalls } = registerAndCapture(enabledConfig());
    const res = await handlers.get("validate_with_models")!({
      question: "is this correct?",
      models: ["claude", "codex"],
      focus: "correctness",
    });
    expect(res.structuredContent.success).toBe(true);
    // No routing occurred: the two explicit providers were dispatched as-is.
    expect(startJobCalls).toEqual(["claude", "codex"]);
  });

  it("select:'cheapest' overrides the explicit list with the single cheapest eligible provider", async () => {
    // Restrict the pool to gemini; its cheapest model wins, so gemini is routed
    // even though the caller listed claude + codex.
    const { handlers, startJobCalls } = registerAndCapture(
      enabledConfig({ candidates: { allow: ["gemini"], deny: [] } })
    );
    const res = await handlers.get("validate_with_models")!({
      question: "is this correct?",
      models: ["claude", "codex"],
      focus: "correctness",
      select: "cheapest",
    });
    expect(res.structuredContent.success).toBe(true);
    expect(startJobCalls).toEqual(["gemini"]);
  });

  it("select:'cheapest_per_tier' fans out to the distinct cheapest provider per tier", async () => {
    // gemini owns the economy tier (flash is cheaper than claude haiku); claude
    // owns the frontier tier (opus). So both providers appear, deduped.
    const { handlers, startJobCalls } = registerAndCapture(
      enabledConfig({ candidates: { allow: ["gemini", "claude"], deny: [] } })
    );
    const res = await handlers.get("validate_with_models")!({
      question: "is this correct?",
      models: ["codex"],
      focus: "correctness",
      select: "cheapest_per_tier",
    });
    expect(res.structuredContent.success).toBe(true);
    // Distinct providers only (dedupe across tiers); both gemini and claude present.
    expect(new Set(startJobCalls)).toEqual(new Set(["gemini", "claude"]));
    expect(startJobCalls.length).toBe(new Set(startJobCalls).size);
  });

  it("fails closed when routing is disabled: no fallback to the default list, no jobs started", async () => {
    const { handlers, startJobCalls } = registerAndCapture(enabledConfig({ enabled: false }));
    const res = await handlers.get("validate_with_models")!({
      question: "is this correct?",
      models: ["claude", "codex"],
      focus: "correctness",
      select: "cheapest",
    });
    expect(res.structuredContent.success).toBe(false);
    expect(res.structuredContent.error).toContain("least_cost");
    expect(startJobCalls).toEqual([]);
  });

  it("fails closed when the selector finds no eligible candidate", async () => {
    // allow only a non-existent key: the pool is empty, so nothing is eligible.
    const { handlers, startJobCalls } = registerAndCapture(
      enabledConfig({ candidates: { allow: ["does-not-exist"], deny: [] } })
    );
    const res = await handlers.get("validate_with_models")!({
      question: "is this correct?",
      models: ["claude", "codex"],
      focus: "correctness",
      select: "cheapest",
    });
    expect(res.structuredContent.success).toBe(false);
    expect(res.structuredContent.error).toContain("fail closed");
    expect(startJobCalls).toEqual([]);
  });

  it("single-provider tool (ask_model) routes to the single cheapest under select", async () => {
    const { handlers, startJobCalls } = registerAndCapture(
      enabledConfig({ candidates: { allow: ["gemini"], deny: [] } })
    );
    const res = await handlers.get("ask_model")!({
      question: "explain this",
      model: "claude",
      select: "cheapest",
    });
    expect(res.structuredContent.success).toBe(true);
    expect(startJobCalls).toEqual(["gemini"]);
  });

  it("single-provider tool (second_opinion) is unchanged without select", async () => {
    const { handlers, startJobCalls } = registerAndCapture(enabledConfig());
    const res = await handlers.get("second_opinion")!({
      answer: "the answer",
      question: "the question",
      model: "codex",
    });
    expect(res.structuredContent.success).toBe(true);
    expect(startJobCalls).toEqual(["codex"]);
  });

  it("second_opinion fails closed when routing is disabled", async () => {
    const { handlers, startJobCalls } = registerAndCapture(enabledConfig({ enabled: false }));
    const res = await handlers.get("second_opinion")!({
      answer: "the answer",
      model: "codex",
      select: "cheapest",
    });
    expect(res.structuredContent.success).toBe(false);
    expect(startJobCalls).toEqual([]);
  });
});
