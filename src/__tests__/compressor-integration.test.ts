import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { buildCliResponse, createGatewayServer, resolveEffectiveCompression } from "../index.js";
import { readPersistedRequest } from "../cache-stats.js";
import { FlightRecorder } from "../flight-recorder.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { runWithRequestContext } from "../request-context.js";

const require = createRequire(import.meta.url);

// Wired-path integration coverage for the invariants the spec's Section 9
// merge gate mandates (C1 byte-identity, review-integrity ordering, the
// content/structuredContent mirror, the llm_job_result async swap + compact
// envelope + parity, the async dedup-key fold, and the byte-recovery escape
// hatch). The compressor unit tests cover the transforms; this file proves
// the wiring.

// A codex --json event stream whose agent_message is a repetitive reply.
function codexStdout(reply: string): string {
  return (
    JSON.stringify({ type: "thread.started", thread_id: "019f-abc" }) +
    "\n" +
    JSON.stringify({
      type: "item.completed",
      item: { id: "i0", type: "agent_message", text: reply },
    }) +
    "\n" +
    JSON.stringify({
      type: "turn.completed",
      usage: { input_tokens: 1234, cached_input_tokens: 1000, output_tokens: 56 },
    }) +
    "\n"
  );
}

const REPLY = Array(24).fill("waiting for lock, will retry shortly").join("\n");

function minimalPrep(overrides: Record<string, unknown> = {}): any {
  return {
    corrId: "c",
    effectivePrompt: "p",
    resolvedModel: "gpt-5.5",
    requestedMcpServers: [],
    mcpConfig: undefined,
    approvalDecision: null,
    reviewIntegrity: undefined,
    args: [],
    stablePrefixHash: null,
    stablePrefixTokens: null,
    ...overrides,
  };
}

describe("C1/C7 byte-identity through buildCliResponse (spec 9.1)", () => {
  it("extractUsageAndCost sees identical raw stdout with compression on and off", () => {
    const stdout = codexStdout(REPLY);
    const off = buildCliResponse(
      "codex",
      stdout,
      false,
      "c-off",
      undefined,
      minimalPrep(),
      10,
      undefined,
      "text",
      undefined,
      false
    );
    const on = buildCliResponse(
      "codex",
      stdout,
      false,
      "c-on",
      undefined,
      minimalPrep(),
      10,
      undefined,
      "text",
      undefined,
      true
    );

    // The usage/cost fields are derived from raw stdout by extractUsageAndCost.
    // If compression had changed the extractor's input, these would differ.
    const usageKeys = [
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheCreationTokens",
      "costUsd",
      "codexSessionId",
    ];
    for (const k of usageKeys) {
      expect((on.structuredContent as any)[k]).toEqual((off.structuredContent as any)[k]);
    }
    expect((off.structuredContent as any).inputTokens).toBe(1234);
    // The caller-facing text DID change (on is compressed), proving the
    // extractor path and the display path are independent.
    expect(on.content[0].text.length).toBeLessThan(off.content[0].text.length);
  });

  it("content[0].text and structuredContent.response mirror the same compressed string", () => {
    const on = buildCliResponse(
      "codex",
      codexStdout(REPLY),
      false,
      "c-mir",
      undefined,
      minimalPrep(),
      10,
      undefined,
      "text",
      undefined,
      true
    );
    expect(on.content[0].text).toBe((on.structuredContent as any).response);
    expect(on.content[0].text.startsWith("[[gateway-note")).toBe(true);
  });
});

describe("review-integrity ordering (spec 5.1 / 9.8)", () => {
  it("appends warnings uncompressed AFTER the compressed body", () => {
    const prep = minimalPrep({
      reviewIntegrity: {
        violations: [
          { type: "tool_suppression", detail: "waiting for lock, will retry shortly", score: 5 },
        ],
        totalScore: 5,
      },
    });
    const on = buildCliResponse(
      "codex",
      codexStdout(REPLY),
      false,
      "c-ri",
      undefined,
      prep,
      10,
      undefined,
      "text",
      undefined,
      true
    );
    const text = on.content[0].text;
    // The compressed body folds the repeated reply lines...
    expect(text).toContain("[[gateway-repeat:v1");
    // ...but the warning block is appended verbatim after it, and its detail
    // line (identical to the folded reply text) is NOT folded away.
    const warnIdx = text.indexOf("⚠️ Review Integrity Warnings");
    expect(warnIdx).toBeGreaterThan(0);
    expect(text.slice(warnIdx)).toContain(
      "- [tool_suppression] waiting for lock, will retry shortly"
    );
    // The warning is after every gateway marker (append happened post-compress).
    expect(text.lastIndexOf("[[gateway-")).toBeLessThan(warnIdx);
  });
});

describe("byte-recovery escape hatch (spec 5.3 / 9.10)", () => {
  let tmpDir: string;
  let dbPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "compress-escape-"));
    dbPath = path.join(tmpDir, "logs.db");
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("llm_request_result returns the pre-compression stored response", () => {
    const fr = new FlightRecorder(dbPath);
    const raw = REPLY; // what a codex/gemini FR site would store (pre-compression)
    fr.logStart({ correlationId: "corr-esc", cli: "codex", model: "gpt-5.5", prompt: "p" });
    fr.logComplete("corr-esc", {
      response: raw,
      durationMs: 5,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    // Even after compression telemetry is recorded, the stored response is raw.
    fr.recordCompressionTelemetry("corr-esc", {
      route: "log",
      transforms: ["dedup", "leading-note"],
      originalChars: raw.length,
      compressedChars: 100,
      estimatedTokensSaved: 40,
    });
    const record = readPersistedRequest(fr, "corr-esc", { maxChars: 100000 });
    expect(record?.response).toBe(raw);
    expect(record?.response).not.toContain("[[gateway-");
    fr.close();
  });
});

describe("async llm_job_result wiring (spec 5.2 / 5.4 / 9.9)", () => {
  function seed(store: MemoryJobStore, id: string, compress: boolean, ndjson: string): void {
    const now = new Date().toISOString();
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `k-${id}`,
      cli: "claude",
      args: [],
      outputFormat: "stream-json",
      compressResponse: compress,
      startedAt: now,
      pid: null,
      ownerPrincipal: "local",
    });
    store.recordComplete({
      id,
      status: "completed",
      exitCode: 0,
      stdout: ndjson,
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: now,
    });
  }

  function claudeNdjson(reply: string): string {
    return (
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: reply }] } }) +
      "\n" +
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: reply,
        total_cost_usd: 0.01,
        usage: { input_tokens: 100, output_tokens: 40 },
      }) +
      "\n"
    );
  }

  async function callJobResult(
    store: MemoryJobStore,
    jobId: string,
    params: Record<string, unknown> = {}
  ): Promise<any> {
    const mgr = new AsyncJobManager(undefined, undefined, store, new NoopFlightRecorder());
    const server = createGatewayServer({
      asyncJobManager: mgr,
      compression: { enabled: false, sources: { configFile: null } },
    });
    const tool = (server as any)._registeredTools["llm_job_result"];
    const res = await runWithRequestContext({ principal: "local" } as any, () =>
      tool.handler({ jobId, maxChars: 200000, ...params }, {})
    );
    return JSON.parse(res.content[0].text);
  }

  it("off keeps raw NDJSON, indented envelope, and parsed.text", async () => {
    const store = new MemoryJobStore();
    const nd = claudeNdjson(REPLY);
    seed(store, "joff", false, nd);
    const env = await callJobResult(store, "joff");
    expect(env.result.stdout).toContain('"type":"assistant"');
    expect(typeof env.parsed.text).toBe("string");
  });

  it("on swaps NDJSON for compressed prose, compacts the envelope, omits parsed.text, keeps usage", async () => {
    const store = new MemoryJobStore();
    const nd = claudeNdjson(REPLY);
    seed(store, "jon", true, nd);
    const raw = await callJobResult(store, "jon");
    expect(raw.result.stdout.startsWith("[[gateway-note")).toBe(true);
    expect(raw.result.stdout).not.toContain('"type":"assistant"');
    expect(raw.result.stdout.length).toBeLessThan(REPLY.length);
    expect("text" in raw.parsed).toBe(false);
    expect(raw.parsed.usage).toBeTruthy();
  });

  it("returns concatenable raw pages for complete forensic retrieval", async () => {
    const store = new MemoryJobStore();
    const nd = claudeNdjson(REPLY);
    seed(store, "jpages", false, nd);

    const first = await callJobResult(store, "jpages", {
      maxChars: 20,
      rawOutput: true,
      stdoutOffsetChars: 0,
      stderrOffsetChars: 0,
    });
    const second = await callJobResult(store, "jpages", {
      maxChars: 20,
      rawOutput: true,
      stdoutOffsetChars: first.result.stdoutNextOffsetChars,
      stderrOffsetChars: first.result.stderrNextOffsetChars ?? 0,
    });

    expect(first.result.stdout).toContain('{"type":"assistant"');
    expect(first.result.stdoutOffsetChars).toBe(0);
    expect(first.result.stdoutTotalChars).toBe(nd.length);
    expect(first.result.stdoutNextOffsetChars).toBe(20);
    expect(first.parsed).toBeUndefined();
    expect(first.result.stdout + second.result.stdout).toBe(nd.slice(0, 40));
  });

  it("rejects display-mode offsets because transformed pages cannot concatenate", async () => {
    const store = new MemoryJobStore();
    seed(store, "jdisplay-offset", false, claudeNdjson(REPLY));

    const response = await callJobResult(store, "jdisplay-offset", {
      maxChars: 20,
      stdoutOffsetChars: 20,
    });

    expect(response.success).toBe(false);
    expect(response.error).toMatch(/rawOutput:true/);
  });

  it("dedup key folds the effective decision in both directions (spec 9.9)", () => {
    const mgr = new AsyncJobManager(
      undefined,
      undefined,
      new MemoryJobStore(),
      new NoopFlightRecorder()
    );
    const key = (compress?: boolean) =>
      (mgr as any).buildRequestKey(
        "claude",
        ["-p", "hi"],
        undefined,
        undefined,
        undefined,
        "text",
        compress
      );
    // Effective-on never shares a key with effective-off.
    expect(key(true)).not.toBe(key(false));
    // Absent and explicit-off share the pre-compressor key shape.
    expect(key(false)).toBe(key(undefined));
  });
});

describe("resolveEffectiveCompression codex outputSchema bypass (spec 5.2)", () => {
  it("bypasses when an output schema is declared even with the flag on", () => {
    const on = { enabled: true, sources: { configFile: null } };
    expect(resolveEffectiveCompression(on, { outputSchemaDeclared: true })).toBe(false);
    expect(
      resolveEffectiveCompression(on, { compressResponse: true, outputSchemaDeclared: true })
    ).toBe(false);
    expect(resolveEffectiveCompression(on, { outputSchemaDeclared: false })).toBe(true);
  });
});
