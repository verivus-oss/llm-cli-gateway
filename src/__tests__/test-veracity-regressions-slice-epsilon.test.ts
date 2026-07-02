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
import { parseGrokStreamingJson } from "../grok-json-parser.js";
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

// ─── REGRESSIONS Eβ — Antigravity text-only output guard ───────────────
//
// Antigravity CLI has no Gemini-compatible `-o` output flag. The gateway keeps
// the schema enum for compatibility but rejects non-text modes before spawn.
describe("REGRESSIONS Eβ — prepareGeminiRequest rejects legacy Gemini output modes", () => {
  const baseParams = {
    prompt: "hello",
    approvalStrategy: "legacy" as const,
    optimizePrompt: false,
    operation: "gemini_request",
  };

  it("rejects outputFormat=stream-json before argv emission", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "stream-json" });
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("outputFormat");
  });

  it("rejects outputFormat=json before argv emission", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "json" });
    expect("args" in prep).toBe(false);
    if ("args" in prep) throw new Error("expected error response");
    expect(prep.content[0].text).toContain("outputFormat");
  });

  it("emits no -o token at all when outputFormat=text (the default)", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "text" });
    if (!("args" in prep)) throw new Error("expected args");
    expect(prep.args).not.toContain("-o");
  });

  it("argv from prepareGeminiRequest({outputFormat:'text'}) passes validateUpstreamCliArgs", () => {
    const prep = prepareGeminiRequest({ ...baseParams, outputFormat: "text" });
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

  // #44: codex now always runs with `--json`, so its usage must be extracted
  // regardless of the caller-facing `outputFormat`. Before #44 the codex branch
  // was gated on `outputFormat === "json"`, leaving the default `text` path
  // telemetry-blind. Falsifiability: re-introducing that gate fails the `text`
  // assertion below.
  const codexJsonl =
    `{"type":"thread.started","thread_id":"t-eδ"}` +
    "\n" +
    `{"type":"item.completed","item":{"type":"agent_message","text":"hi"}}` +
    "\n" +
    `{"type":"turn.completed","usage":{"input_tokens":14112,"output_tokens":17,"cached_input_tokens":4992}}`;

  it("extracts codex usage when outputFormat=text (default path — #44)", () => {
    const result = extractUsageAndCost("codex", codexJsonl, "text");
    expect(result.inputTokens).toBe(14112);
    expect(result.outputTokens).toBe(17);
    expect(result.cacheReadTokens).toBe(4992);
  });

  it("extracts codex usage when outputFormat=json (opt-in path — unchanged)", () => {
    const result = extractUsageAndCost("codex", codexJsonl, "json");
    expect(result.inputTokens).toBe(14112);
    expect(result.cacheReadTokens).toBe(4992);
  });

  it("extracts codex usage even when outputFormat is undefined", () => {
    const result = extractUsageAndCost("codex", codexJsonl, undefined);
    expect(result.inputTokens).toBe(14112);
    expect(result.cacheReadTokens).toBe(4992);
  });
});

// ─── REGRESSIONS Eθ — grok `-p` headless surface emits no per-request usage ──
//
// Scope: the gateway invokes grok via its HEADLESS `-p` surface (prepareGrokRequest
// builds `["-p", <prompt>, … --output-format …]`), which is what extractUsageAndCost
// parses. That surface emits no per-request usage — verified against the live Grok
// Build CLI (2026-06-13); these are the EXACT real captures. (The ACP `grok agent
// stdio` surface DOES expose usage in its `session/prompt` `_meta`, but the gateway
// does not route grok over ACP today, so it never reaches extractUsageAndCost — see
// the comment in src/index.ts.)
//
// Falsifiability: if someone adds a speculative grok `--json` usage branch to
// extractUsageAndCost that guesses at field names (the #44 caveat trap), it would
// pull non-usage fields (text/stopReason/sessionId/totalTokens) into the usage shape
// and break these `toEqual({})` assertions. The grok-api HTTP path (cli "grok",
// xai-api-provider) is a SEPARATE code path that never routes through this function.
describe("REGRESSIONS Eθ — grok `-p` headless output carries no per-request usage", () => {
  // Real `grok --output-format json -p "…"` stdout. No token fields exist.
  const grokJson = JSON.stringify({
    text: "hello world",
    stopReason: "EndTurn",
    sessionId: "019ec06f-ea71-7cd0-905d-691215c0440d",
    requestId: "33b49a2c-efc9-4051-ac24-381990f6c248",
    thought: 'The user wants me to reply with exactly "hello world".',
  });

  // Real `grok --output-format streaming-json` event stream. The terminal
  // `end` event carries stopReason/sessionId/requestId — but no usage.
  const grokStreamingJson =
    JSON.stringify({ type: "thought", data: "hello" }) +
    "\n" +
    JSON.stringify({ type: "text", data: "hello" }) +
    "\n" +
    JSON.stringify({ type: "text", data: " world" }) +
    "\n" +
    JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "019ec070-26ab-7fa3-b66b-72fc6964f250",
      requestId: "64625ea0-6292-4dd1-9f43-263084223516",
    }) +
    "\n";

  it("returns no usage for grok json output", () => {
    expect(extractUsageAndCost("grok", grokJson, "json")).toEqual({});
  });

  it("returns no usage for grok streaming-json output", () => {
    expect(extractUsageAndCost("grok", grokStreamingJson, "streaming-json")).toEqual({});
  });

  // B1: the REAL streaming-json capture carries each delta in a `data` field.
  // Assert the parser concatenates it into the reply text (not just that usage is
  // absent). Mutation that flips this red: reverting deltaText to omit
  // `str(event.data)` so the real-shape reply is dropped.
  it("parses the real-capture streaming-json stream to the expected reply text", () => {
    const parsed = parseGrokStreamingJson(grokStreamingJson);
    expect(parsed?.text).toBe("hello world");
    expect(parsed?.thought).toBe("hello");
    expect(parsed?.stopReason).toBe("EndTurn");
  });

  it("returns no usage for grok plain output (default) and unknown formats", () => {
    expect(extractUsageAndCost("grok", "hello world", "plain")).toEqual({});
    expect(extractUsageAndCost("grok", grokJson, undefined)).toEqual({});
  });

  // Guard against a future parser leaking grok's cumulative context gauge
  // (totalTokens / contextTokensUsed) as if it were per-request input tokens.
  it("does not surface grok's cumulative context-window gauge as per-request usage", () => {
    const withContextGauge = JSON.stringify({
      type: "end",
      stopReason: "EndTurn",
      sessionId: "s",
      requestId: "r",
      _meta: { totalTokens: 15395 },
    });
    expect(extractUsageAndCost("grok", withContextGauge, "streaming-json")).toEqual({});
  });
});

// ─── REGRESSIONS Eε — UPSTREAM_CLI_CONTRACTS Antigravity output guard ──
//
// Antigravity print mode has no `-o`; stale Gemini output flags must remain
// rejected by the mechanical contract.
describe("REGRESSIONS Eε — gemini-compatible contract rejects legacy -o output modes", () => {
  it("validateUpstreamCliArgs rejects ['--print','x','-o','stream-json']", () => {
    const validation = validateUpstreamCliArgs("gemini", ["--print", "x", "-o", "stream-json"]);
    expect(validation.ok).toBe(false);
  });

  it("validateUpstreamCliArgs rejects ['--print','x','-o','json']", () => {
    const validation = validateUpstreamCliArgs("gemini", ["--print", "x", "-o", "json"]);
    expect(validation.ok).toBe(false);
  });

  it("contract introspection: gemini.flags has no legacy '-o' entry", () => {
    const flag = UPSTREAM_CLI_CONTRACTS.gemini.flags["-o"];
    expect(flag).toBeUndefined();
  });

  it("Antigravity minimal fixture exists AND mechanically validates against the contract", () => {
    const fixture = UPSTREAM_CLI_CONTRACTS.gemini.conformanceFixtures.find(
      f => f.id === "gemini-minimal"
    );
    expect(fixture, "gemini-minimal fixture must be registered").toBeDefined();
    expect(fixture?.expect).toBe("pass");
    expect(fixture?.args).toEqual(["--print", "hello"]);

    const validation = validateUpstreamCliArgs("gemini", fixture?.args as readonly string[]);
    expect(validation.ok, JSON.stringify(validation.violations)).toBe(true);
  });
});
