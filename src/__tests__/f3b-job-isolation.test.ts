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
  let tmp: string;
  let store: MemoryJobStore;
  let flight: FlightRecorder;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
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

  afterEach(() => {
    flight.close();
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

  function seedAliceJob(): void {
    const now = new Date().toISOString();
    store.recordStart({
      id: "job-alice",
      correlationId: "corr-alice",
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: now,
      pid: null,
      ownerPrincipal: "alice",
    });
    store.recordComplete({
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

  it("llm_job_status is own-or-not-found across principals", async () => {
    seedAliceJob();

    const bob = await call("llm_job_status", { jobId: "job-alice" }, "bob");
    expect(bob.success).toBe(false);
    expect(bob.error).toMatch(/not found/i);

    const alice = await call("llm_job_status", { jobId: "job-alice" }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.job.id).toBe("job-alice");
  });

  it("llm_job_result does not leak another principal's output", async () => {
    seedAliceJob();

    const bob = await call("llm_job_result", { jobId: "job-alice", maxChars: 200000 }, "bob");
    expect(bob.success).toBe(false);
    expect(JSON.stringify(bob)).not.toContain("alice private output");

    const alice = await call("llm_job_result", { jobId: "job-alice", maxChars: 200000 }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.result.stdout).toContain("alice private output");
  });

  it("validation job_status is own-or-not-found across principals (receipts §5a)", async () => {
    seedAliceJob();

    const bob = await call("job_status", { jobId: "job-alice" }, "bob");
    expect(bob.success).toBe(false);
    expect(bob.error).toMatch(/not found/i);

    const alice = await call("job_status", { jobId: "job-alice" }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.job.id).toBe("job-alice");
  });

  it("validation job_result does not leak another principal's output (receipts §5a)", async () => {
    seedAliceJob();

    const bob = await call("job_result", { jobId: "job-alice", maxChars: 200000 }, "bob");
    expect(bob.success).toBe(false);
    expect(JSON.stringify(bob)).not.toContain("alice private output");

    const alice = await call("job_result", { jobId: "job-alice", maxChars: 200000 }, "alice");
    expect(alice.success).toBe(true);
    expect(alice.result.stdout).toContain("alice private output");
  });

  it("llm_job_cancel reports another principal's job as not found", async () => {
    seedAliceJob();
    const bob = await call("llm_job_cancel", { jobId: "job-alice" }, "bob");
    expect(bob.success).toBe(false);
    expect(bob.reason).toMatch(/not found/i);
  });

  it("llm_request_result is own-or-not-found (no cross-principal prompt readback)", async () => {
    runWithRequestContext(ctx("alice"), () =>
      flight.logStart({
        correlationId: "req-alice",
        cli: "claude",
        model: "sonnet",
        prompt: "alice secret prompt",
      })
    );
    flight.logComplete("req-alice", {
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

  it("local principal can read legacy-unowned jobs/requests; a remote principal cannot", async () => {
    const now = new Date().toISOString();
    // Legacy job: no ownerPrincipal stamped (pre-F3 row).
    store.recordStart({
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
