import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import { FlightRecorder } from "../flight-recorder.js";
import { createGatewayServer } from "../index.js";
import {
  PostgresJobStore,
  computeRequestKey,
  isValidationRunStore,
  type JobStore,
  type ValidationRunStore,
} from "../job-store.js";
import { noopLogger } from "../logger.js";
import { FileSessionManager } from "../session-manager.js";
import { cleanTestDatabase, setupTestDatabase } from "./setup.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test";

describe("PostgresJobStore", () => {
  let store: JobStore & ValidationRunStore;
  let tempDir: string;

  beforeEach(async () => {
    await setupTestDatabase();
    await cleanTestDatabase();
    tempDir = mkdtempSync(join(tmpdir(), "pg-job-store-"));
    store = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
    });
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips a completed process job", () => {
    const startedAt = new Date().toISOString();
    const finishedAt = new Date().toISOString();
    const requestKey = computeRequestKey("claude", ["-p", "postgres"]);

    store.recordStart({
      id: "pg-job-1",
      correlationId: "pg-corr-1",
      requestKey,
      cli: "claude",
      args: ["-p", "postgres"],
      outputFormat: "text",
      startedAt,
      pid: 123,
      ownerPrincipal: "alice@example.com",
    });
    store.recordOutput("pg-job-1", "partial", "", false);
    store.recordComplete({
      id: "pg-job-1",
      status: "completed",
      exitCode: 0,
      stdout: "done",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt,
    });

    const row = store.getById("pg-job-1");
    expect(row).toMatchObject({
      id: "pg-job-1",
      correlationId: "pg-corr-1",
      requestKey,
      cli: "claude",
      argsJson: JSON.stringify(["-p", "postgres"]),
      outputFormat: "text",
      status: "completed",
      exitCode: 0,
      stdout: "done",
      stderr: "",
      outputTruncated: false,
      error: null,
      pid: 123,
      ownerPrincipal: "alice@example.com",
      transport: "process",
      httpStatus: null,
      payloadJson: null,
    });
    expect(store.findByRequestKey(requestKey)?.id).toBe("pg-job-1");
  });

  it("round-trips an HTTP job without persisting an API key", () => {
    const payloadJson = JSON.stringify({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hello" }],
    });
    store.recordStart({
      id: "pg-http-1",
      correlationId: "pg-http-corr",
      requestKey: "http-key",
      cli: "openai",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      transport: "http",
      payloadJson,
    });
    store.recordComplete({
      id: "pg-http-1",
      status: "failed",
      exitCode: 1,
      stdout: "",
      stderr: "unauthorized",
      outputTruncated: false,
      error: "unauthorized",
      finishedAt: new Date().toISOString(),
      httpStatus: 401,
    });

    const row = store.getById("pg-http-1");
    expect(row?.transport).toBe("http");
    expect(row?.payloadJson).toBe(payloadJson);
    expect(row?.payloadJson).not.toContain("apiKey");
    expect(row?.httpStatus).toBe(401);
  });

  it("marks lease-expired (dead-owner) rows orphaned on startup (#139 lease shim)", () => {
    // #139: markOrphanedOnStartup is now a lease shim. Simulate a dead owner by
    // constructing the store with an already-expired lease so recordStart writes
    // lease_deadline in the past; the shim then orphans it.
    const dead = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
      leaseTtlMs: -60_000,
    });
    try {
      const startedAt = new Date().toISOString();
      dead.recordStart({
        id: "pg-running",
        correlationId: "pg-running-corr",
        requestKey: "running-key",
        cli: "mistral",
        args: ["--prompt", "x"],
        startedAt,
        pid: null,
      });

      const result = dead.markOrphanedOnStartup();
      expect(result.count).toBe(1);
      expect(result.orphaned[0]).toMatchObject({
        id: "pg-running",
        correlationId: "pg-running-corr",
        startedAt,
        stdout: "",
        stderr: "",
        transport: "process",
      });
      expect(dead.getById("pg-running")?.status).toBe("orphaned");
      expect(dead.getById("pg-running")?.error).toContain("no longer alive");
    } finally {
      dead.close();
    }
  });

  it("#139: does NOT orphan a fresh-lease running job; DOES after the lease expires", () => {
    store.recordStart({
      id: "pg-live",
      correlationId: "c",
      requestKey: "k-live",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: "inst-A",
    });
    store.markRunning("pg-live", { pid: 4321 });
    expect(store.getById("pg-live")?.status).toBe("running");
    expect(store.getById("pg-live")?.pid).toBe(4321);
    // Fresh lease: not swept.
    expect(store.recoverStaleJobs(90_000, 300_000)).toHaveLength(0);
    expect(store.getById("pg-live")?.status).toBe("running");

    // A separate dead-owner store writes an expired-lease row that IS swept.
    const dead = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
      leaseTtlMs: -60_000,
    });
    try {
      dead.recordStart({
        id: "pg-dead",
        correlationId: "c2",
        requestKey: "k-dead",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerInstance: "inst-B",
      });
      const orphaned = dead.recoverStaleJobs(90_000, 300_000);
      expect(orphaned.map(o => o.id)).toContain("pg-dead");
      // completion wins over the mistaken orphan (guarded recordComplete)
      dead.recordComplete({
        id: "pg-dead",
        status: "completed",
        exitCode: 0,
        stdout: "late",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: new Date().toISOString(),
      });
      expect(dead.getById("pg-dead")?.status).toBe("completed");
    } finally {
      dead.close();
    }
    // the live job remained running throughout
    expect(store.getById("pg-live")?.status).toBe("running");
  });

  it("persists validation runs and receipts", () => {
    expect(isValidationRunStore(store)).toBe(true);
    store.recordValidationRun({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      intent: "review",
      createdAt: new Date().toISOString(),
      requestJson: JSON.stringify({ question: "ship?" }),
      providerLinks: [{ provider: "openai", jobId: "job-openai", correlationId: "corr-openai" }],
      judgeLink: null,
      status: "running",
    });
    store.setValidationJudgeLink("val-pg-1", {
      provider: "anthropic",
      jobId: "job-judge",
      correlationId: "corr-judge",
    });
    store.setValidationRunStatus("val-pg-1", "finalized");
    store.recordValidationReceipt({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      mintedAt: new Date().toISOString(),
      schemaVersion: "validation-report.v1",
      reportJson: JSON.stringify({ ok: true }),
      canonicalSha256: "abc123",
      prevSha256: null,
      seq: null,
      signature: null,
      models: ["openai", "anthropic"],
      hasMaterialDisagreement: false,
      confidence: "high",
    });

    expect(store.getValidationRun("val-pg-1")).toMatchObject({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      status: "finalized",
      judgeLink: { provider: "anthropic", jobId: "job-judge", correlationId: "corr-judge" },
    });
    expect(store.getValidationRunIdByJobId("job-openai")).toBe("val-pg-1");
    expect(store.getValidationRunIdByJobId("job-judge")).toBe("val-pg-1");
    expect(store.getValidationReceipt("val-pg-1")).toMatchObject({
      validationId: "val-pg-1",
      models: ["openai", "anthropic"],
      hasMaterialDisagreement: false,
      confidence: "high",
    });
  });

  it("registers and serves validation_receipt through a postgres-backed gateway", async () => {
    const now = new Date().toISOString();
    for (const id of ["pg-v-claude", "pg-v-codex"]) {
      store.recordStart({
        id,
        correlationId: `corr-${id}`,
        requestKey: `key-${id}`,
        cli: "claude",
        args: [],
        startedAt: now,
        pid: null,
        ownerPrincipal: "local",
      });
      store.recordComplete({
        id,
        status: "completed",
        exitCode: 0,
        stdout: "Verdict: approve",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: now,
      });
    }
    store.recordValidationRun({
      validationId: "val-pg-tool",
      ownerPrincipal: "local",
      intent: "validate",
      createdAt: now,
      requestJson: JSON.stringify({
        question: "Is this safe?",
        modelList: ["claude", "codex"],
      }),
      providerLinks: [
        { provider: "claude", jobId: "pg-v-claude", correlationId: "corr-pg-v-claude" },
        { provider: "codex", jobId: "pg-v-codex", correlationId: "corr-pg-v-codex" },
      ],
      judgeLink: null,
      status: "running",
    });
    store.setValidationRunStatus("val-pg-tool", "finalized");

    const flight = new FlightRecorder(join(tempDir, "logs.db"));
    try {
      const server = createGatewayServer({
        sessionManager: new FileSessionManager(join(tempDir, "sessions.json")),
        asyncJobManager: new AsyncJobManager(noopLogger, undefined, store),
        persistence: postgresPersistence(),
        flightRecorder: flight,
      });
      const tool = registeredTools(server)["validation_receipt"];
      expect(tool).toBeDefined();

      const result = await tool.handler(
        { validationId: "val-pg-tool", format: "json", includeRawResponses: false },
        {}
      );
      const body = JSON.parse(result.content[0].text);
      expect(body.status).toBe("minted");
      expect(body.receipt.validationId).toBe("val-pg-tool");
      expect(body.receipt.models).toEqual(["claude", "codex"]);
    } finally {
      flight.close();
    }
  });
});

function postgresPersistence(): PersistenceConfig {
  return {
    backend: "postgres",
    path: null,
    dsn: TEST_DATABASE_URL,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function registeredTools(server: unknown): Record<string, RegisteredTool> {
  return (server as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}
