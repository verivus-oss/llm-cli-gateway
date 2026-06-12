/**
 * Phase 4 slice δ — test-veracity regressions.
 *
 * Codex + Grok ran the test-veracity audit (docs/plans/test-veracity-audit.spec.md)
 * with mutation probes and BOTH rejected the prior test set as
 * non-falsifiable on multiple axes. This file closes the concrete
 * blockers their probes identified:
 *
 *   P-A5b — Schema drift between MAX_*_SCHEMA constants and the
 *           registered MCP tool fields is invisible because A5/A6
 *           test the bare constants. → REGRESSIONS A: probe the
 *           REGISTERED tool's inputSchema directly.
 *
 *   P-B-retry — handleMistralRequest's stale-model recovery retry
 *           rebuilds argv without re-running prepareMistralRequest.
 *           No test asserts trust/maxTurns/maxPrice survive the
 *           retry. → REGRESSIONS B: test the extracted
 *           `buildMistralRetryPrep` helper directly.
 *
 *   P-C4 — `MCP request schemas expose the provider contract
 *          parameters` walks `mcpParameters` as the source of truth;
 *          removing a field from BOTH the contract and the schema
 *          leaves the test green. → REGRESSIONS C: explicit
 *          allowlist assertion for slice α/γ/δ params.
 *
 *   D-gap end-to-end — prepare*Request output is never validated
 *          against UPSTREAM_CLI_CONTRACTS in the same test.
 *          → REGRESSIONS D: thread argv from prepare* into
 *          validateUpstreamCliArgs and assert ok=true.
 *
 *   P-C4 sync-only — the existing C4 also skipped `_async` tools.
 *          → REGRESSIONS E: explicitly assert both sync + async tool
 *          registrations expose the slice fields.
 */
import { describe, expect, it } from "vitest";
import { createGatewayServer, buildMistralRetryPrep } from "../index.js";
import {
  UPSTREAM_CLI_CONTRACTS,
  validateUpstreamCliArgs,
  validateUpstreamCliEnv,
} from "../upstream-contracts.js";
import { prepareGrokRequest, prepareCodexRequest } from "../index.js";
import { prepareMistralRequest } from "../request-helpers.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

// Construct a gateway server with async tools enabled so the
// `_async`-suffixed registrations are inspectable. Without injecting a
// MemoryJobStore + asyncJobsEnabled the structural invariant in
// createGatewayServer leaves the `*_request_async` tools unregistered.
function makeServerWithAsyncTools(): ReturnType<typeof createGatewayServer> {
  const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  return createGatewayServer({
    asyncJobManager: manager,
    persistence: {
      backend: "sqlite",
      logsDbPath: ":memory:",
      jobsDbPath: ":memory:",
      jobRetentionDays: 7,
      dedupWindowMs: 0,
      asyncJobsEnabled: true,
      sources: { configFile: null, envOverrides: [] },
    },
  });
}

// Mirror the registry-walking trick the existing C4 test uses; this is
// the only way to inspect a registered tool's Zod schema in @modelcontextprotocol/sdk v0.x.
function getRegisteredToolSchema(toolName: string): {
  shape: Record<string, { safeParse: (v: unknown) => { success: boolean } }>;
} {
  const server = makeServerWithAsyncTools();
  const registry = (server as unknown as Record<string, Record<string, { inputSchema?: unknown }>>)
    ._registeredTools;
  const tool = registry[toolName];
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  const schema = tool.inputSchema as { _def?: { shape?: () => Record<string, unknown> } };
  const shape = (schema._def?.shape?.() ?? {}) as Record<
    string,
    { safeParse: (v: unknown) => { success: boolean } }
  >;
  return { shape };
}

// ─── REGRESSIONS A — registered MCP schemas reject invalid bounds ────
//
// Falsifiability: removing `.safe()`/`.max(10_000)`/`.min(1e-6)` from
// MAX_TURNS_SCHEMA / MAX_PRICE_SCHEMA in src/index.ts, OR swapping any
// of the four tool registrations to a looser inline schema, will fail
// at least one assertion below.
describe("REGRESSIONS A — registered tool inputSchema bounds", () => {
  const grokToolSchemas = (toolName: string) => {
    const { shape } = getRegisteredToolSchema(toolName);
    return shape.maxTurns;
  };
  const mistralToolSchemas = (toolName: string) => {
    const { shape } = getRegisteredToolSchema(toolName);
    return { maxTurns: shape.maxTurns, maxPrice: shape.maxPrice };
  };

  it.each(["grok_request", "grok_request_async"])(
    "%s.maxTurns rejects 1e21 / negative / 10_001 / fractional",
    name => {
      const f = grokToolSchemas(name);
      expect(f.safeParse(1).success).toBe(true);
      expect(f.safeParse(10_000).success).toBe(true);
      expect(f.safeParse(1e21).success).toBe(false);
      expect(f.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
      expect(f.safeParse(0).success).toBe(false);
      expect(f.safeParse(-1).success).toBe(false);
      expect(f.safeParse(1.5).success).toBe(false);
      expect(f.safeParse(10_001).success).toBe(false);
    }
  );

  it.each(["mistral_request", "mistral_request_async"])(
    "%s.maxTurns + maxPrice enforce the bounded schemas",
    name => {
      const { maxTurns, maxPrice } = mistralToolSchemas(name);
      // maxTurns
      expect(maxTurns.safeParse(1).success).toBe(true);
      expect(maxTurns.safeParse(10_001).success).toBe(false);
      expect(maxTurns.safeParse(1e21).success).toBe(false);
      // maxPrice
      expect(maxPrice.safeParse(0.001).success).toBe(true);
      expect(maxPrice.safeParse(10_000).success).toBe(true);
      expect(maxPrice.safeParse(1e-6).success).toBe(true);
      expect(maxPrice.safeParse(1e-7).success).toBe(false);
      expect(maxPrice.safeParse(Infinity).success).toBe(false);
      expect(maxPrice.safeParse(NaN).success).toBe(false);
      expect(maxPrice.safeParse(10_001).success).toBe(false);
      expect(maxPrice.safeParse(-1).success).toBe(false);
    }
  );
});

// ─── REGRESSIONS B — Mistral stale-model retry preserves slice flags ──
//
// Falsifiability: dropping any of `trust`, `maxTurns`, `maxPrice` from
// the `buildMistralRetryPrep` body (the exact regression Codex's
// P-B-retry probe demonstrated would otherwise be silent) fails the
// matching assertion below.
describe("REGRESSIONS B — buildMistralRetryPrep forwards slice γ/δ flags", () => {
  const baseParams = {
    outputFormat: undefined,
    permissionMode: undefined,
    allowedTools: undefined,
    disallowedTools: undefined,
    approvalStrategy: "legacy" as const,
    effectivePrompt: "hello",
  };

  it("emits --trust on retry when trust=true", () => {
    const { args } = buildMistralRetryPrep(
      { ...baseParams, trust: true, maxTurns: undefined, maxPrice: undefined },
      "mistral-medium-3.5"
    );
    expect(args).toContain("--trust");
  });

  it("emits --max-turns N on retry when maxTurns set", () => {
    const { args } = buildMistralRetryPrep(
      { ...baseParams, trust: undefined, maxTurns: 5, maxPrice: undefined },
      "mistral-medium-3.5"
    );
    const idx = args.indexOf("--max-turns");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("5");
  });

  it("emits --max-price DOLLARS on retry when maxPrice set", () => {
    const { args } = buildMistralRetryPrep(
      { ...baseParams, trust: undefined, maxTurns: undefined, maxPrice: 0.01 },
      "mistral-medium-3.5"
    );
    const idx = args.indexOf("--max-price");
    expect(idx).toBeGreaterThan(-1);
    expect(args[idx + 1]).toBe("0.01");
  });

  it("emits all three flags together on retry when all three are set", () => {
    const { args } = buildMistralRetryPrep(
      { ...baseParams, trust: true, maxTurns: 3, maxPrice: 0.5 },
      "mistral-medium-3.5"
    );
    expect(args).toContain("--trust");
    expect(args).toContain("--max-turns");
    expect(args).toContain("--max-price");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("3");
    expect(args[args.indexOf("--max-price") + 1]).toBe("0.5");
  });

  it("emits none of the slice flags when all three are undefined", () => {
    const { args } = buildMistralRetryPrep(
      { ...baseParams, trust: undefined, maxTurns: undefined, maxPrice: undefined },
      "mistral-medium-3.5"
    );
    expect(args).not.toContain("--trust");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--max-price");
  });
});

// ─── REGRESSIONS C — explicit Phase-4 mcpParameters assertions ────────
//
// Falsifiability: removing any of the listed parameter names from the
// matching contract's `mcpParameters` array fails the precise
// assertion (P-C4 showed the prior derived-equality test went silent
// when a field was removed from BOTH the contract and the schema).
describe("REGRESSIONS C — Phase 4 contracts must expose slice α/γ/δ params", () => {
  it("Codex contract exposes slice α params (outputSchema, configOverrides)", () => {
    const params = UPSTREAM_CLI_CONTRACTS.codex.mcpParameters;
    expect(params).toContain("outputSchema");
    expect(params).toContain("configOverrides");
  });

  it("Gemini contract exposes slice γ param skipTrust", () => {
    expect(UPSTREAM_CLI_CONTRACTS.gemini.mcpParameters).toContain("skipTrust");
  });

  it("Grok contract exposes slice δ param maxTurns", () => {
    expect(UPSTREAM_CLI_CONTRACTS.grok.mcpParameters).toContain("maxTurns");
  });

  it("Grok contract exposes 0.2.x headless MCP params", () => {
    const params = UPSTREAM_CLI_CONTRACTS.grok.mcpParameters;
    for (const name of [
      "agent",
      "bestOfN",
      "check",
      "disableWebSearch",
      "todoGate",
      "verbatim",
      "agents",
      "promptFile",
      "promptJson",
      "single",
      "experimentalMemory",
      "noAltScreen",
      "noMemory",
      "noPlan",
      "noSubagents",
      "oauth",
      "restoreCode",
      "nativeWorktree",
    ]) {
      expect(params).toContain(name);
    }
  });

  it("Mistral contract exposes slice γ trust + slice δ maxTurns + maxPrice", () => {
    const params = UPSTREAM_CLI_CONTRACTS.mistral.mcpParameters;
    expect(params).toContain("trust");
    expect(params).toContain("maxTurns");
    expect(params).toContain("maxPrice");
  });
});

// ─── REGRESSIONS D — prepare-to-contract end-to-end ───────────────────
//
// Falsifiability: if a prepare* function emits argv that the contract
// doesn't recognise (the latent slice α/γ break that escaped the
// 744-test suite), these assertions fail.
describe("REGRESSIONS D — prepared argv validates against the contract", () => {
  it("prepareGrokRequest({maxTurns:5}) → validateUpstreamCliArgs OK", () => {
    const prep = prepareGrokRequest({
      prompt: "hello",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "grok_request",
      maxTurns: 5,
    } as Parameters<typeof prepareGrokRequest>[0]);
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("grok", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("prepareMistralRequest({trust:true,maxTurns:3,maxPrice:0.01}) → contract OK (args+env)", () => {
    const prep = prepareMistralRequest({
      prompt: "hello",
      resolvedModel: "mistral-medium-3.5",
      trust: true,
      maxTurns: 3,
      maxPrice: 0.01,
    });
    const args = validateUpstreamCliArgs("mistral", prep.args);
    const env = validateUpstreamCliEnv("mistral", prep.env);
    expect(args.ok, JSON.stringify(args.violations)).toBe(true);
    expect(env.ok, JSON.stringify(env.violations)).toBe(true);
  });

  it("prepareCodexRequest on resume with outputSchema+configOverrides → contract OK", () => {
    const prep = prepareCodexRequest({
      prompt: "hello",
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      approvalStrategy: "legacy",
      mcpServers: [],
      optimizePrompt: false,
      operation: "codex_request",
      sessionId: "01940000-0000-7000-8000-000000000abc",
      outputSchema: "/tmp/schema.json",
      configOverrides: { "model.foo": "bar" },
    } as Parameters<typeof prepareCodexRequest>[0]);
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("codex", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});

// ─── REGRESSIONS E — sync AND async tool registrations expose params ──
//
// Falsifiability: removing a slice field from any of the FOUR tool
// registrations (sync OR async variants for grok/mistral; sync OR
// async for gemini; ditto codex) fails the matching assertion.
describe("REGRESSIONS E — both sync and async tools expose slice fields", () => {
  it.each(["gemini_request", "gemini_request_async"])("%s exposes skipTrust", name => {
    const { shape } = getRegisteredToolSchema(name);
    expect(Object.keys(shape)).toContain("skipTrust");
  });

  it.each(["grok_request", "grok_request_async"])("%s exposes maxTurns", name => {
    const { shape } = getRegisteredToolSchema(name);
    expect(Object.keys(shape)).toContain("maxTurns");
  });

  it.each(["grok_request", "grok_request_async"])("%s exposes Grok 0.2.x headless params", name => {
    const { shape } = getRegisteredToolSchema(name);
    const fields = Object.keys(shape);
    for (const param of [
      "agent",
      "bestOfN",
      "check",
      "disableWebSearch",
      "todoGate",
      "verbatim",
      "agents",
      "promptFile",
      "promptJson",
      "single",
      "experimentalMemory",
      "noAltScreen",
      "noMemory",
      "noPlan",
      "noSubagents",
      "oauth",
      "restoreCode",
      "nativeWorktree",
    ]) {
      expect(fields).toContain(param);
    }
  });

  it.each(["mistral_request", "mistral_request_async"])(
    "%s exposes trust + maxTurns + maxPrice",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const fields = Object.keys(shape);
      expect(fields).toContain("trust");
      expect(fields).toContain("maxTurns");
      expect(fields).toContain("maxPrice");
    }
  );
});

// ─── REGRESSIONS F — flag-fixture coverage map ─────────────────────────
//
// Falsifiability: if a new flag lands in any contract.flags table
// without a matching conformance fixture exercising it, this test
// names it explicitly. Per Grok's P-C3 finding the fixture iteration
// goes silent when a fixture is removed; this test inverts the
// relationship — every flag MUST have a fixture.
describe("REGRESSIONS F — every contract flag has at least one passing fixture", () => {
  // A short curated list of flags that are inherently exercised by
  // every fixture (the bare-minimum scaffolding) and therefore don't
  // need an isolation fixture. Anything else added to a contract's
  // `flags` table without a fixture should fail this test loudly.
  const SCAFFOLDING_FLAGS = new Set([
    "-p",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--last",
    // session-resume continuation flags exercised implicitly via the
    // contract's resumeOnlyFlags machinery, not via per-flag fixtures.
    "--continue",
    "--resume",
    "--session-id",
  ]);

  for (const [cliName, contract] of Object.entries(UPSTREAM_CLI_CONTRACTS)) {
    it(`${cliName}: every non-scaffolding flag in contract has a passing fixture`, () => {
      const exercised = new Set<string>();
      for (const fixture of contract.conformanceFixtures) {
        if (fixture.expect !== "pass") continue;
        for (const tok of fixture.args) {
          if (typeof tok === "string" && tok.startsWith("-")) exercised.add(tok);
        }
      }
      const missing: string[] = [];
      for (const flag of Object.keys(contract.flags)) {
        if (SCAFFOLDING_FLAGS.has(flag)) continue;
        if (!exercised.has(flag)) missing.push(flag);
      }
      // Intentionally tolerant: pre-existing flags shipped without
      // fixtures predate this audit; this assertion ENFORCES that any
      // NEWLY-added flag must come with a fixture. The allowlist below
      // is the pre-audit baseline; future flags must NOT be added to
      // it — they must come with a fixture instead.
      const PREAUDIT_BASELINE: Record<string, string[]> = {
        claude: [
          "--model",
          "--output-format",
          "--include-partial-messages",
          "--allowed-tools",
          "--disallowed-tools",
          "--permission-mode",
          "--mcp-config",
          "--strict-mcp-config",
          "--agent",
          "--agents",
          "--fork-session",
          "--system-prompt",
          "--append-system-prompt",
          "--max-budget-usd",
          "--max-turns",
          "--effort",
          "--exclude-dynamic-system-prompt-sections",
        ],
        codex: [
          "--model",
          "--sandbox",
          "--json",
          "--profile",
          "--ephemeral",
          "-i",
          "--ignore-user-config",
          "--ignore-rules",
        ],
        gemini: ["--model", "--prompt", "-c"],
        grok: [
          "--model",
          "--output-format",
          "--always-approve",
          "--permission-mode",
          "--effort",
          "--reasoning-effort",
          "--tools",
          "--disallowed-tools",
        ],
        mistral: ["--agent", "--enabled-tools"],
      };
      const allowed = new Set(PREAUDIT_BASELINE[cliName] ?? []);
      const reallyMissing = missing.filter(f => !allowed.has(f));
      expect(
        reallyMissing,
        `${cliName} contract has flags without conformance fixtures — add fixtures or update the PREAUDIT_BASELINE only for grandfathered entries`
      ).toEqual([]);
    });
  }
});
