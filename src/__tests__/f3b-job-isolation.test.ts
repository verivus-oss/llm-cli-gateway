import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { FlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";

// F3b-2: end-to-end ownership enforcement on the llm_job_* and
// llm_request_result MCP tools, driven through the real registered handlers
// under different request-context principals. Jobs are seeded directly into the
// store (no process spawn); the flight recorder is a real SQLite instance.

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function ctx(authPrincipal?: string): GatewayRequestContext {
  return authPrincipal
    ? { transport: "http", authScopes: [], authPrincipal }
    : { transport: "stdio", authScopes: [] };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

describe("F3b-2 job / request ownership isolation", () => {
  const PROVIDER_SESSION_ID = "019ec070-26ab-7fa3-b66b-72fc6964f250";
  let tmp: string;
  let store: MemoryJobStore;
  let flight: FlightRecorder;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "f3b2-"));
    store = new MemoryJobStore();
    flight = new FlightRecorder(join(tmp, "logs.db"));
    server = createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, store),
      persistence: mkPersistence(),
      flightRecorder: flight,
    });
  });

  afterEach(async () => {
    await flight.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function call(
    name: string,
    args: Record<string, unknown>,
    principal?: string
  ): Promise<Record<string, any>> {
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const result = await runWithRequestContext(ctx(principal), () => reg[name].handler(args, {}));
    return JSON.parse(result.content[0].text);
  }

  async function seedAliceJob(): Promise<void> {
    const now = new Date().toISOString();
    await store.recordStart({
      id: "job-alice",
      correlationId: "corr-alice",
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: now,
      pid: null,
      ownerPrincipal: "alice",
    });
    await store.recordComplete({
      id: "job-alice",
      status: "completed",
      exitCode: 0,
      stdout: "alice private output",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: now,
    });
  }

  async function seedJobWithHostEvidence(id: string, ownerPrincipal: string): Promise<void> {
    const now = new Date().toISOString();
    await store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `host-evidence-${id}`,
      cli: "devin",
      args: [],
      startedAt: now,
      pid: null,
      ownerPrincipal,
      ownerInstance: "test-instance",
      cwd: { scope: "caller", path: "/private/alice/workspace", workspaceAlias: null },
      replayContext: {
        version: 1,
        repositoryHead: "a".repeat(40),
        instructionFiles: [
          {
            path: "/private/alice/workspace/AGENTS.md",
            sha256: "b".repeat(64),
            sourceBytes: 18,
            effectiveBytes: 18,
            effectiveLimitBytes: null,
            truncated: false,
            status: "captured",
          },
        ],
      },
      captureFormat: "atif-v1.7",
    });
    await store.recordComplete({
      id,
      status: "completed",
      exitCode: 0,
      stdout: "alice result",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: now,
    });
    await store.recordCapture({
      id,
      ownerInstance: "test-instance",
      captureStatus: "captured_whole",
      outputDroppedBytes: 0,
      nativeTranscript: "private ATIF transcript",
      nativeTranscriptBytes: 23,
      nativeTranscriptTruncated: false,
      nativeTranscriptDroppedBytes: 0,
      captureError: null,
    });
  }

  it("llm_job_status is own-or-not-found across principals", async () => {
    await seedAliceJob();

    const bob = await call("llm_job_status", { jobId: "job-alice" }, "bob");
    expect(bob.success).toBe(false);
    expect(bob.error).toMatch(/not found/i);

    const alice = await call("llm_job_status", { jobId: "job-alice" }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.job.id).toBe("job-alice");
  });

  it("llm_job_result does not leak another principal's output", async () => {
    await seedAliceJob();

    const bob = await call("llm_job_result", { jobId: "job-alice", maxChars: 200000 }, "bob");
    expect(bob.success).toBe(false);
    expect(JSON.stringify(bob)).not.toContain("alice private output");

    const alice = await call("llm_job_result", { jobId: "job-alice", maxChars: 200000 }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.result.stdout).toContain("alice private output");
  });

  it("validation job_status is own-or-not-found across principals (receipts §5a)", async () => {
    await seedAliceJob();

    const bob = await call("job_status", { jobId: "job-alice" }, "bob");
    expect(bob.success).toBe(false);
    expect(bob.error).toMatch(/not found/i);

    const alice = await call("job_status", { jobId: "job-alice" }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.job.id).toBe("job-alice");
  });

  it("validation job_result does not leak another principal's output (receipts §5a)", async () => {
    await seedAliceJob();

    const bob = await call("job_result", { jobId: "job-alice", maxChars: 200000 }, "bob");
    expect(bob.success).toBe(false);
    expect(JSON.stringify(bob)).not.toContain("alice private output");

    const alice = await call("job_result", { jobId: "job-alice", maxChars: 200000 }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.result.stdout).toContain("alice private output");
  });

  it("withholds host replay evidence on every remote job read surface", async () => {
    await seedJobWithHostEvidence("job-alice-host-evidence", "alice");
    const jobId = "job-alice-host-evidence";

    const responses = [
      await call("llm_job_status", { jobId }, "alice"),
      await call("llm_job_watch", { jobId, waitMs: 0 }, "alice"),
      await call("llm_job_result", { jobId, maxChars: 200000 }, "alice"),
      await call("job_status", { jobId }, "alice"),
      await call("job_result", { jobId, maxChars: 200000 }, "alice"),
    ];

    for (const response of responses) {
      const encoded = JSON.stringify(response);
      expect(response.success).toBe(true);
      expect(encoded).not.toContain("/private/alice/workspace");
      expect(encoded).not.toContain("private ATIF transcript");
      expect(encoded).not.toContain("executionContext");
      expect(encoded).not.toContain("nativeTranscript");
    }

    await seedJobWithHostEvidence("job-local-host-evidence", "local");
    const local = await call("job_result", {
      jobId: "job-local-host-evidence",
      maxChars: 200000,
    });
    expect(local.result.executionContext.cwd.path).toBe("/private/alice/workspace");
    expect(local.result.nativeTranscript).toBe("private ATIF transcript");
  });

  it("llm_job_cancel reports another principal's job as not found", async () => {
    await seedAliceJob();
    const bob = await call("llm_job_cancel", { jobId: "job-alice" }, "bob");
    expect(bob.success).toBe(false);
    expect(bob.reason).toMatch(/not found/i);
  });

  it("llm_request_result is own-or-not-found (no cross-principal prompt readback)", async () => {
    await runWithRequestContext(ctx("alice"), () =>
      flight.logStart({
        correlationId: "req-alice",
        cli: "claude",
        model: "sonnet",
        prompt: "alice secret prompt",
      })
    );
    await flight.logComplete("req-alice", {
      response: "resp",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });

    const bob = await call(
      "llm_request_result",
      { correlationId: "req-alice", maxChars: 200000, includePrompt: true },
      "bob"
    );
    expect(bob.success).toBe(false);
    expect(JSON.stringify(bob)).not.toContain("alice secret prompt");

    const alice = await call(
      "llm_request_result",
      { correlationId: "req-alice", maxChars: 200000, includePrompt: true },
      "alice"
    );
    expect(alice.success).toBe(true);
    expect(alice.request.correlationId).toBe("req-alice");
  });

  it("llm_request_result exposes the linked complete job record only to local stdio", async () => {
    const now = new Date().toISOString();
    await store.recordStart({
      id: "job-local-record",
      correlationId: "req-local-record",
      requestKey: "complete-record",
      cli: "claude",
      args: ["--output-format", "stream-json"],
      outputFormat: "text",
      startedAt: now,
      pid: null,
      ownerPrincipal: "local",
      cwd: { scope: "caller", path: "/private/workspace", workspaceAlias: null },
      replayContext: {
        version: 1,
        repositoryHead: "a".repeat(40),
        instructionFiles: [
          {
            path: "/private/workspace/CLAUDE.md",
            sha256: "b".repeat(64),
            sourceBytes: 12,
            effectiveBytes: 12,
            effectiveLimitBytes: null,
            truncated: false,
            status: "captured",
          },
        ],
      },
      captureFormat: "stream-json",
    });
    await store.recordComplete({
      id: "job-local-record",
      status: "completed",
      exitCode: 0,
      stdout: '{"type":"assistant","message":{"content":[]}}',
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: now,
    });
    await flight.logStart({
      correlationId: "req-local-record",
      cli: "claude",
      model: "sonnet",
      prompt: "prompt",
      asyncJobId: "job-local-record",
      ownerPrincipal: "local",
    });
    await flight.logComplete("req-local-record", {
      response: "response",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });

    const local = await call("llm_request_result", {
      correlationId: "req-local-record",
      maxChars: 200000,
      includeJobRecord: true,
    });
    expect(local.jobRecord.stdout).toContain('"type":"assistant"');
    expect(local.jobRecord.executionContext.cwd.path).toBe("/private/workspace");
    expect(local.jobRecord.executionContext.replay.repositoryHead).toBe("a".repeat(40));

    await runWithRequestContext(ctx("alice"), () =>
      flight.logStart({
        correlationId: "req-remote-record",
        cli: "claude",
        model: "sonnet",
        prompt: "prompt",
        asyncJobId: "job-local-record",
      })
    );
    await flight.logComplete("req-remote-record", {
      response: "response",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });

    const remote = await call(
      "llm_request_result",
      {
        correlationId: "req-remote-record",
        maxChars: 200000,
        includeJobRecord: true,
      },
      "alice"
    );
    expect(remote.jobRecord).toBeNull();
    expect(remote.jobRecordWithheld).toMatch(/local stdio/);
    expect(JSON.stringify(remote)).not.toContain("/private/workspace");
  });

  it("llm_request_result redacts native provider ids for the remote owner before slicing", async () => {
    const response = `${"x".repeat(995)}${PROVIDER_SESSION_ID} trailing response`;
    await runWithRequestContext(ctx("alice"), () =>
      flight.logStart({
        correlationId: "req-native-id",
        cli: "grok",
        model: "grok-4.5",
        prompt: `prompt ${PROVIDER_SESSION_ID}`,
      })
    );
    await flight.logComplete("req-native-id", {
      response,
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
      providerSessionId: PROVIDER_SESSION_ID,
    });

    const sliced = await call(
      "llm_request_result",
      { correlationId: "req-native-id", maxChars: 1000, includePrompt: true },
      "alice"
    );
    expect(sliced.success).toBe(true);
    expect(JSON.stringify(sliced)).not.toContain(PROVIDER_SESSION_ID);
    expect(sliced.request.response).not.toContain(PROVIDER_SESSION_ID.slice(0, 5));
    // The replacement begins before the original native id would have crossed
    // the public slice boundary. A slice-first implementation would leak xxxxx.
    expect(sliced.request.response).toContain("[reda");

    const full = await call(
      "llm_request_result",
      { correlationId: "req-native-id", maxChars: 200000, includePrompt: true },
      "alice"
    );
    expect(full.request.response).toContain("[redacted-session-id]");
    expect(full.request.prompt).toBe("prompt [redacted-session-id]");
  });

  it("llm_request_result scrubs error and thinking fields for a remote owner", async () => {
    await runWithRequestContext(ctx("alice"), () =>
      flight.logStart({
        correlationId: "req-native-failure-fields",
        cli: "grok",
        model: "grok-4.5",
        prompt: `prompt ${PROVIDER_SESSION_ID}`,
        sessionId: PROVIDER_SESSION_ID,
      })
    );
    await flight.logComplete("req-native-failure-fields", {
      response: `response ${PROVIDER_SESSION_ID}`,
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 1,
      errorMessage: `error ${PROVIDER_SESSION_ID}`,
      thinkingBlocks: [`thinking ${PROVIDER_SESSION_ID}`],
      status: "failed",
      providerSessionId: PROVIDER_SESSION_ID,
    });

    const remote = await call(
      "llm_request_result",
      { correlationId: "req-native-failure-fields", maxChars: 200000, includePrompt: true },
      "alice"
    );

    expect(remote.success).toBe(true);
    expect(JSON.stringify(remote)).not.toContain(PROVIDER_SESSION_ID);
    expect(remote.request.sessionId).toBe("[redacted-session-id]");
    expect(remote.request.errorMessage).toBe("error [redacted-session-id]");
    expect(remote.request.thinkingBlocks).toEqual(["thinking [redacted-session-id]"]);
  });

  it("local principal can read legacy-unowned jobs/requests; a remote principal cannot", async () => {
    const now = new Date().toISOString();
    // Legacy job: no ownerPrincipal stamped (pre-F3 row).
    await store.recordStart({
      id: "job-legacy",
      correlationId: "corr-legacy",
      requestKey: "k2",
      cli: "claude",
      args: [],
      startedAt: now,
      pid: null,
    });

    const local = await call("llm_job_status", { jobId: "job-legacy" }, undefined);
    expect(local.success).toBe(true);

    const remote = await call("llm_job_status", { jobId: "job-legacy" }, "alice");
    expect(remote.success).toBe(false);
  });
});
