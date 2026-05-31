import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";
import {
  readPersistedRequest,
  PERSISTED_REQUEST_DEFAULT_MAX_CHARS,
} from "../cache-stats.js";

describe("readPersistedRequest", () => {
  let tmpDir: string;
  let rec: FlightRecorder;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "read-persisted-test-"));
    rec = new FlightRecorder(path.join(tmpDir, "logs.db"));
  });

  afterEach(() => {
    rec.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedSync(opts: {
    id: string;
    prompt?: string;
    response?: string;
    sessionId?: string;
  }): void {
    rec.logStart({
      correlationId: opts.id,
      cli: "gemini",
      model: "gemini-2.5-pro",
      prompt: opts.prompt ?? "the prompt",
      sessionId: opts.sessionId,
    });
    rec.logComplete(opts.id, {
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
    });
  }

  it("recovers a persisted SYNC response by correlation id (the core gap)", () => {
    seedSync({ id: "corr-sync-1", response: "GEMINI SAYS APPROVED" });

    const rec1 = readPersistedRequest(rec, "corr-sync-1");
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

  it("returns null for an unknown correlation id", () => {
    expect(readPersistedRequest(rec, "does-not-exist")).toBeNull();
  });

  it("omits the prompt unless includePrompt is set, but always reports promptChars", () => {
    seedSync({ id: "corr-prompt", prompt: "abcdef", response: "r" });

    const without = readPersistedRequest(rec, "corr-prompt");
    expect(without!.prompt).toBeUndefined();
    expect(without!.promptChars).toBe(6);

    const withPrompt = readPersistedRequest(rec, "corr-prompt", { includePrompt: true });
    expect(withPrompt!.prompt).toBe("abcdef");
    expect(withPrompt!.promptChars).toBe(6);
  });

  it("truncates the response to maxChars and reports the full length", () => {
    const big = "x".repeat(5000);
    seedSync({ id: "corr-big", response: big });

    const clipped = readPersistedRequest(rec, "corr-big", { maxChars: 1000 });
    expect(clipped!.response).toHaveLength(1000);
    expect(clipped!.responseChars).toBe(5000);
    expect(clipped!.responseTruncated).toBe(true);

    const full = readPersistedRequest(rec, "corr-big", { maxChars: 10000 });
    expect(full!.response).toHaveLength(5000);
    expect(full!.responseTruncated).toBe(false);
  });

  it("defaults maxChars to the documented constant", () => {
    seedSync({ id: "corr-default", response: "short" });
    const r = readPersistedRequest(rec, "corr-default");
    // Sanity: a short response is never truncated under the default budget.
    expect(PERSISTED_REQUEST_DEFAULT_MAX_CHARS).toBeGreaterThan("short".length);
    expect(r!.responseTruncated).toBe(false);
  });

  it("surfaces a failed request's error message and exit code", () => {
    rec.logStart({ correlationId: "corr-fail", cli: "gemini", model: "default", prompt: "p" });
    rec.logComplete("corr-fail", {
      response: "partial output",
      durationMs: 50,
      retryCount: 2,
      circuitBreakerState: "open",
      optimizationApplied: false,
      exitCode: 1,
      errorMessage: "boom",
      status: "failed",
    });

    const r = readPersistedRequest(rec, "corr-fail");
    expect(r!.status).toBe("failed");
    expect(r!.exitCode).toBe(1);
    expect(r!.errorMessage).toBe("boom");
    expect(r!.retryCount).toBe(2);
    expect(r!.circuitBreakerState).toBe("open");
  });

  it("reports a started-but-never-completed row with a null response", () => {
    rec.logStart({ correlationId: "corr-pending", cli: "gemini", model: "default", prompt: "p" });
    const r = readPersistedRequest(rec, "corr-pending");
    expect(r).not.toBeNull();
    expect(r!.status).toBe("started");
    expect(r!.response).toBeNull();
    expect(r!.responseChars).toBe(0);
    expect(r!.responseTruncated).toBe(false);
  });

  it("parses persisted thinking blocks back into an array", () => {
    rec.logStart({ correlationId: "corr-think", cli: "claude", model: "opus", prompt: "p" });
    rec.logComplete("corr-think", {
      response: "answer",
      durationMs: 10,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      thinkingBlocks: ["step one", "step two"],
      exitCode: 0,
      status: "completed",
    });
    const r = readPersistedRequest(rec, "corr-think");
    expect(r!.thinkingBlocks).toEqual(["step one", "step two"]);
  });

  it("returns null against a NoopFlightRecorder (flight recording disabled)", () => {
    const noop = new NoopFlightRecorder();
    expect(readPersistedRequest(noop, "anything")).toBeNull();
  });
});
