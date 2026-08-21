import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";
import { readPersistedRequest, PERSISTED_REQUEST_DEFAULT_MAX_CHARS } from "../cache-stats.js";

describe("readPersistedRequest", () => {
  let tmpDir: string;
  let rec: FlightRecorder;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "read-persisted-test-"));
    rec = new FlightRecorder(path.join(tmpDir, "logs.db"));
  });

  afterEach(async () => {
    await rec.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function seedSync(opts: {
    id: string;
    prompt?: string;
    response?: string;
    sessionId?: string;
    providerSessionId?: string;
  }): Promise<void> {
    await rec.logStart({
      correlationId: opts.id,
      cli: "gemini",
      model: "gemini-2.5-pro",
      prompt: opts.prompt ?? "the prompt",
      sessionId: opts.sessionId,
    });
    await rec.logComplete(opts.id, {
      response: opts.response ?? "the verdict",
      durationMs: 1234,
      inputTokens: 100,
      outputTokens: 200,
      retryCount: 0,
      circuitBreakerState: "closed",
      costUsd: 0.01,
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      providerSessionId: opts.providerSessionId,
    });
  }

  it("recovers a persisted SYNC response by correlation id (the core gap)", async () => {
    await seedSync({ id: "corr-sync-1", response: "GEMINI SAYS APPROVED" });

    const rec1 = await readPersistedRequest(rec, "corr-sync-1");
    expect(rec1).not.toBeNull();
    expect(rec1!.correlationId).toBe("corr-sync-1");
    expect(rec1!.cli).toBe("gemini");
    expect(rec1!.response).toBe("GEMINI SAYS APPROVED");
    expect(rec1!.status).toBe("completed");
    // Sync requests carry no async job id — this is what distinguishes them.
    expect(rec1!.asyncJobId).toBeNull();
    expect(rec1!.durationMs).toBe(1234);
    expect(rec1!.inputTokens).toBe(100);
    expect(rec1!.outputTokens).toBe(200);
    expect(rec1!.costUsd).toBeCloseTo(0.01);
  });

  it("returns null for an unknown correlation id", async () => {
    expect(await readPersistedRequest(rec, "does-not-exist")).toBeNull();
  });

  it("omits the prompt unless includePrompt is set, but always reports promptChars", async () => {
    await seedSync({ id: "corr-prompt", prompt: "abcdef", response: "r" });

    const without = await readPersistedRequest(rec, "corr-prompt");
    expect(without!.prompt).toBeUndefined();
    expect(without!.promptChars).toBe(6);

    const withPrompt = await readPersistedRequest(rec, "corr-prompt", { includePrompt: true });
    expect(withPrompt!.prompt).toBe("abcdef");
    expect(withPrompt!.promptChars).toBe(6);
  });

  it("truncates the response to maxChars and reports the full length", async () => {
    const big = "x".repeat(5000);
    await seedSync({ id: "corr-big", response: big });

    const clipped = await readPersistedRequest(rec, "corr-big", { maxChars: 1000 });
    expect(clipped!.response).toHaveLength(1000);
    expect(clipped!.responseChars).toBe(5000);
    expect(clipped!.responseTruncated).toBe(true);

    const full = await readPersistedRequest(rec, "corr-big", { maxChars: 10000 });
    expect(full!.response).toHaveLength(5000);
    expect(full!.responseTruncated).toBe(false);
  });

  it("redacts a known native provider id before persisted-response slicing", async () => {
    const nativeId = "019ec070-26ab-7fa3-b66b-72fc6964f250";
    await seedSync({
      id: "corr-native-id",
      prompt: `prompt ${nativeId}`,
      response: `${"x".repeat(995)}${nativeId} trailing response`,
      providerSessionId: nativeId,
    });

    const sliced = await readPersistedRequest(rec, "corr-native-id", {
      maxChars: 1000,
      includePrompt: true,
      redactProviderSessionId: true,
    });
    expect(sliced!.response).not.toContain(nativeId.slice(0, 5));
    expect(sliced!.response).toContain("[reda");
    expect(sliced!.prompt).toBe("prompt [redacted-session-id]");

    const local = await readPersistedRequest(rec, "corr-native-id", {
      maxChars: 200000,
      includePrompt: true,
    });
    expect(local!.response).toContain(nativeId);
    expect(local!.prompt).toContain(nativeId);
  });

  it("redacts every caller-visible persisted text field for remote readback", async () => {
    const nativeId = "019ec070-26ab-7fa3-b66b-72fc6964f250";
    await rec.logStart({
      correlationId: "corr-native-fields",
      cli: "grok",
      model: "grok-build",
      prompt: `prompt ${nativeId}`,
      sessionId: nativeId,
    });
    await rec.logComplete("corr-native-fields", {
      response: `response ${nativeId}`,
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 1,
      errorMessage: `error ${nativeId}`,
      thinkingBlocks: [`thinking ${nativeId}`],
      status: "failed",
      providerSessionId: nativeId,
    });

    const remote = await readPersistedRequest(rec, "corr-native-fields", {
      includePrompt: true,
      redactProviderSessionId: true,
    });
    expect(JSON.stringify(remote)).not.toContain(nativeId);
    expect(remote!.sessionId).toBe("[redacted-session-id]");
    expect(remote!.errorMessage).toBe("error [redacted-session-id]");
    expect(remote!.thinkingBlocks).toEqual(["thinking [redacted-session-id]"]);

    const local = await readPersistedRequest(rec, "corr-native-fields", { includePrompt: true });
    expect(JSON.stringify(local)).toContain(nativeId);
    expect(local!.sessionId).toBe(nativeId);
    expect(local!.errorMessage).toBe(`error ${nativeId}`);
    expect(local!.thinkingBlocks).toEqual([`thinking ${nativeId}`]);
  });

  it("defaults maxChars to the documented constant", async () => {
    await seedSync({ id: "corr-default", response: "short" });
    const r = await readPersistedRequest(rec, "corr-default");
    // Sanity: a short response is never truncated under the default budget.
    expect(PERSISTED_REQUEST_DEFAULT_MAX_CHARS).toBeGreaterThan("short".length);
    expect(r!.responseTruncated).toBe(false);
  });

  it("surfaces a failed request's error message and exit code", async () => {
    await rec.logStart({
      correlationId: "corr-fail",
      cli: "gemini",
      model: "default",
      prompt: "p",
    });
    await rec.logComplete("corr-fail", {
      response: "partial output",
      durationMs: 50,
      retryCount: 2,
      circuitBreakerState: "open",
      optimizationApplied: false,
      exitCode: 1,
      errorMessage: "boom",
      status: "failed",
    });

    const r = await readPersistedRequest(rec, "corr-fail");
    expect(r!.status).toBe("failed");
    expect(r!.exitCode).toBe(1);
    expect(r!.errorMessage).toBe("boom");
    expect(r!.retryCount).toBe(2);
    expect(r!.circuitBreakerState).toBe("open");
  });

  it("reports a started-but-never-completed row with a null response", async () => {
    await rec.logStart({
      correlationId: "corr-pending",
      cli: "gemini",
      model: "default",
      prompt: "p",
    });
    const r = await readPersistedRequest(rec, "corr-pending");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("started");
    expect(r!.response).toBeNull();
    expect(r!.responseChars).toBe(0);
    expect(r!.responseTruncated).toBe(false);
  });

  it("parses persisted thinking blocks back into an array", async () => {
    await rec.logStart({ correlationId: "corr-think", cli: "claude", model: "opus", prompt: "p" });
    await rec.logComplete("corr-think", {
      response: "answer",
      durationMs: 10,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      thinkingBlocks: ["step one", "step two"],
      exitCode: 0,
      status: "completed",
    });
    const r = await readPersistedRequest(rec, "corr-think");
    expect(r!.thinkingBlocks).toEqual(["step one", "step two"]);
  });

  it("returns null against a NoopFlightRecorder (flight recording disabled)", async () => {
    const noop = new NoopFlightRecorder();
    expect(await readPersistedRequest(noop, "anything")).toBeNull();
  });
});
