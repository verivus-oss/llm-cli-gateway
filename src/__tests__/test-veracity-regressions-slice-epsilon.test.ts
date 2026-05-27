/**
 * Phase 4 slice ε — test-veracity regressions for Gemini `-o stream-json`.
 *
 * Mirrors the REGRESSIONS pattern from `test-veracity-regressions.test.ts`:
 * every test below is mutation-probe-friendly. The audit spec at
 * `docs/plans/test-veracity-audit-slice-epsilon.spec.md` documents the
 * counterexample mutations each LLM reviewer must run before approving
 * this slice.
 *
 * Probe targets:
 *
 *   P-Eα-1/2/3 — Zod enum widening (registered tool inputSchema, sync + async).
 *   P-Eβ-1/2/3 — prepareGeminiRequest argv emission for stream-json.
 *   P-Eδ-1/2  — extractUsageAndCost routing branches on outputFormat.
 *   P-Eε-1/2/3 — UPSTREAM_CLI_CONTRACTS gemini -o enum widening + fixture.
 *
 * Eγ probes live in `gemini-json-parser.test.ts` (the parser is its own
 * module, so its falsifiability surface naturally lives there).
 */
import { describe, expect, it } from "vitest";
import { createGatewayServer, extractUsageAndCost, prepareGeminiRequest } from "../index.js";
import { UPSTREAM_CLI_CONTRACTS, validateUpstreamCliArgs } from "../upstream-contracts.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

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

// ─── REGRESSIONS Eα — registered MCP schemas accept stream-json ────────
//
// Falsifiability: reverting either Zod enum to ["text","json"] fails the
// matching assertion; loosening to `z.string()` fails the rejection cases.
describe("REGRESSIONS Eα — registered tool outputFormat enum (slice ε)", () => {
  it.each(["gemini_request", "gemini_request_async"])(
    "%s.outputFormat accepts text, json, stream-json",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.outputFormat;
      expect(f.safeParse("text").success).toBe(true);
      expect(f.safeParse("json").success).toBe(true);
      expect(f.safeParse("stream-json").success).toBe(true);
    }
  );

  it.each(["gemini_request", "gemini_request_async"])(
    "%s.outputFormat rejects unrelated strings",
    name => {
      const { shape } = getRegisteredToolSchema(name);
      const f = shape.outputFormat;
      expect(f.safeParse("ndjson").success).toBe(false);
      expect(f.safeParse("event-stream").success).toBe(false);
      expect(f.safeParse("STREAM-JSON").success).toBe(false);
      expect(f.safeParse(42).success).toBe(false);
    }
  );
});

// ─── REGRESSIONS Eβ — prepareGeminiRequest argv emission ───────────────
//
// Falsifiability: removing the `outputFormat === "stream-json"` branch
// fails Eβ-1; changing it to emit a different value fails Eβ-1 and Eβ-4.
describe("REGRESSIONS Eβ — prepareGeminiRequest emits -o stream-json", () => {
  const baseParams = {
    prompt: "hello",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "gemini_request",
  };

  it("emits ['-o','stream-json'] as adjacent tokens when outputFormat=stream-json", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "stream-json" });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("-o");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("stream-json");
  });

  it("still emits ['-o','json'] when outputFormat=json (no regression)", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "json" });
    if (!("args" in prep)) throw new Error("expected args");
    const idx = prep.args.indexOf("-o");
    expect(idx).toBeGreaterThan(-1);
    expect(prep.args[idx + 1]).toBe("json");
  });

  it("emits no -o token at all when outputFormat=text (the default)", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "text" });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-o");
  });

  // REGRESSIONS D-style end-to-end: prepare → contract consistency.
  // The exact regression class that bit slices α/γ/δ — a contract-table
  // gap masking a real flag we emit.
  it("argv from prepareGeminiRequest({outputFormat:'stream-json'}) passes validateUpstreamCliArgs", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "stream-json" });
    if (!("args" in prep)) throw new Error("expected args");
    const validation = validateUpstreamCliArgs("gemini", prep.args);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});

// ─── REGRESSIONS Eδ — extractUsageAndCost routing ──────────────────────
//
// Falsifiability: swapping the parser routes or removing the
// "stream-json" branch fails the matching assertion. The two output
// formats share a result shape but differ in stdout shape — a swap
// silently corrupts usage extraction.
describe("REGRESSIONS Eδ — extractUsageAndCost routes outputFormat correctly", () => {
  const ndjson =
    JSON.stringify({ type: "init", session_id: "x", model: "auto-gemini-3" }) +
    "\n" +
    JSON.stringify({ type: "message", role: "assistant", content: "4", delta: true }) +
    "\n" +
    JSON.stringify({
      type: "result",
      status: "success",
      stats: { input_tokens: 33, output_tokens: 7, cached: 5 },
    }) +
    "\n";

  const singleObj = JSON.stringify({
    response: "4",
    usageMetadata: {
      promptTokenCount: 11,
      candidatesTokenCount: 2,
      cachedContentTokenCount: 0,
      totalTokenCount: 13,
    },
  });

  it("extracts usage from NDJSON when outputFormat=stream-json", () => {
    const result = extractUsageAndCost("gemini", ndjson, "stream-json");
    expect(result.inputTokens).toBe(33);
    expect(result.outputTokens).toBe(7);
    expect(result.cacheReadTokens).toBe(5);
  });

  it("extracts usage from single-object JSON when outputFormat=json (no regression)", () => {
    const result = extractUsageAndCost("gemini", singleObj, "json");
    expect(result.inputTokens).toBe(11);
    expect(result.outputTokens).toBe(2);
  });

  // Routes are wired to the correct parser: feeding NDJSON to the `json`
  // branch (single-object parser) should produce no usage, because
  // `parseGeminiJson` JSON.parses the whole stdout — multi-line NDJSON
  // is not a valid single JSON document.
  it("returns empty usage when NDJSON is mis-fed to the json branch (parser swap guard)", () => {
    const result = extractUsageAndCost("gemini", ndjson, "json");
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });

  // And feeding the single-object payload to the stream-json branch
  // should also produce no usage, because the single object lacks the
  // `type: "result"` event entirely.
  it("returns empty usage when single-object JSON is mis-fed to the stream-json branch", () => {
    const result = extractUsageAndCost("gemini", singleObj, "stream-json");
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
  });
});

// ─── REGRESSIONS Eε — UPSTREAM_CLI_CONTRACTS gemini -o enum + fixture ──
//
// Falsifiability: removing "stream-json" from the values array, or
// dropping the conformance fixture, fails the matching assertion.
describe("REGRESSIONS Eε — gemini contract accepts -o stream-json", () => {
  it("validateUpstreamCliArgs accepts ['-p','x','-o','stream-json']", () => {
    const validation = validateUpstreamCliArgs("gemini", ["-p", "x", "-o", "stream-json"]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });

  it("validateUpstreamCliArgs rejects ['-p','x','-o','ndjson'] (still bounded)", () => {
    const validation = validateUpstreamCliArgs("gemini", ["-p", "x", "-o", "ndjson"]);
    expect(validation.ok).toBe(false);
  });

  it("contract introspection: gemini.flags['-o'].values includes 'stream-json'", () => {
    const flag = UPSTREAM_CLI_CONTRACTS.gemini.flags["-o"];
    expect(flag).toBeDefined();
    expect(flag.values).toContain("stream-json");
    expect(flag.values).toContain("json");
  });

  // Eε-4: the round-1 Codex audit flagged a real gap here. The presence
  // check below is necessary but not sufficient — under P-Eε-1 (revert
  // `gemini.flags["-o"].values` back to `["json"]`) the fixture object
  // still exists, so a `toContain("gemini-stream-json")` assertion
  // stayed green even though the contract had silently broken. The
  // mechanical assertion underneath actually runs the fixture through
  // `validateUpstreamCliArgs` so the test goes red whenever the contract
  // and the fixture drift apart.
  it("gemini-stream-json fixture exists AND mechanically validates against the contract", () => {
    const fixture = UPSTREAM_CLI_CONTRACTS.gemini.conformanceFixtures.find(
      f => f.id === "gemini-stream-json"
    );
    expect(fixture, "gemini-stream-json fixture must be registered").toBeDefined();
    expect(fixture?.expect).toBe("pass");
    expect(fixture?.args).toEqual(["-p", "hello", "-o", "stream-json"]);

    // Mechanical end-to-end: the fixture must actually pass
    // validateUpstreamCliArgs. If `stream-json` were removed from the
    // -o enum (P-Eε-1) this assertion goes red even though the fixture
    // object still exists in the array — closing the round-1 gap.
    const validation = validateUpstreamCliArgs("gemini", fixture?.args as readonly string[]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});
