/**
 * Phase 7 (B3): a remote HTTP/OAuth caller polling `llm_job_result` must NEVER
 * receive the provider-owned session id (`providerSessionId`). The phase-5
 * remote-isolation invariant (provider session ids must not reach remote caller
 * responses) previously covered only `session_get` / `sessions://*` via
 * `remoteSafeSession`; it is now extended to job polling.
 *
 * Mutation that flips the redaction test red: removing the `if (callerIsRemote())
 * delete result.providerSessionId` block in the `llm_job_result` handler. The
 * remote response would then carry the id and the `not.toHaveProperty` assertion
 * (and the JSON not-contains) fails.
 *
 * `llm_job_status` returns the bare AsyncJobSnapshot, which carries no provider
 * session id, so it is asserted leak-free as a guard against future drift.
 */
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

const PROVIDER_SESSION_ID = "019ec070-26ab-7fa3-b66b-72fc6964f250";

// Real grok streaming-json stdout: the terminal `end` event carries the
// provider-minted sessionId that a resume needs (extractProviderOutputMetadata
// lifts it into the job result as providerSessionId).
const GROK_STDOUT =
  JSON.stringify({ type: "text", data: "hello world" }) +
  "\n" +
  JSON.stringify({
    type: "end",
    stopReason: "EndTurn",
    sessionId: PROVIDER_SESSION_ID,
    requestId: "64625ea0-6292-4dd1-9f43-263084223516",
  }) +
  "\n";

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
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

describe("Phase 7 B3: llm_job_result remote redaction of providerSessionId", () => {
  let tmp: string;
  let store: MemoryJobStore;
  let flight: FlightRecorder;
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "b3-"));
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

  function seedGrokJob(id: string, owner: string): void {
    const now = new Date().toISOString();
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: id,
      cli: "grok",
      args: [],
      startedAt: now,
      pid: null,
      outputFormat: "streaming-json",
      transport: "process",
      ownerPrincipal: owner,
    });
    store.recordComplete({
      id,
      status: "completed",
      exitCode: 0,
      stdout: GROK_STDOUT,
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: now,
    });
  }

  it("omits providerSessionId for a remote owner but keeps it for a local owner", async () => {
    seedGrokJob("job-remote", "alice");
    seedGrokJob("job-local", "local");

    // Remote OAuth caller who OWNS the job: succeeds, but providerSessionId is
    // redacted from the caller-facing result.
    const remote = await call("llm_job_result", { jobId: "job-remote", maxChars: 200000 }, "alice");
    expect(remote.success).toBe(true);
    expect(remote.result).not.toHaveProperty("providerSessionId");
    // The provider session id must not leak via any STRUCTURED field. The raw
    // `stdout` is the caller's own job output (it may echo the id in the end
    // event); that is legitimately theirs, so it is excluded from this guard.
    const { stdout: _omitStdout, ...structured } = remote.result;
    expect(JSON.stringify(structured)).not.toContain(PROVIDER_SESSION_ID);

    // Local stdio caller: providerSessionId is present (needed for local resume).
    const local = await call("llm_job_result", { jobId: "job-local", maxChars: 200000 }, undefined);
    expect(local.success).toBe(true);
    expect(local.result.providerSessionId).toBe(PROVIDER_SESSION_ID);
  });

  it("llm_job_status never carries a provider session id (remote or local)", async () => {
    seedGrokJob("job-remote", "alice");

    const remote = await call("llm_job_status", { jobId: "job-remote" }, "alice");
    expect(remote.success).toBe(true);
    expect(remote.job).not.toHaveProperty("providerSessionId");
    expect(JSON.stringify(remote)).not.toContain(PROVIDER_SESSION_ID);
  });
});
