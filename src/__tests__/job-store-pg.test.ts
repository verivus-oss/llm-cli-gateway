import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";
import type { Pool } from "pg";
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
import type { KitExecutionRef } from "../personal-config-types.js";
import { FileSessionManager } from "../session-manager.js";
import { cleanTestDatabase, setupTestDatabase } from "./setup.js";
import { eagerMintFromJobId } from "../validation-receipt.js";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test";

function kitExecution(overrides: Partial<KitExecutionRef> = {}): KitExecutionRef {
  return {
    version: 1,
    releaseId: "release-pg-job",
    configStamp: "stamp-pg-job",
    scopeRoot: "/workspace/pg-job",
    scopeHead: "head-pg-job",
    contextIdentity: "context-pg-job",
    ...overrides,
  };
}

function roleScopedDsn(role: string, password: string, schema: string): string {
  const dsn = new URL(TEST_DATABASE_URL);
  dsn.username = role;
  dsn.password = password;
  dsn.searchParams.set("options", `-c search_path=${schema}`);
  return dsn.toString();
}

describe("PostgresJobStore", () => {
  let store: JobStore & ValidationRunStore;
  let tempDir: string;
  let pool: Pool;

  beforeEach(async () => {
    ({ pool } = await setupTestDatabase());
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

  it("round-trips async failure classification", () => {
    const now = new Date().toISOString();
    store.recordStart({
      id: "pg-job-e2big",
      correlationId: "pg-corr-e2big",
      requestKey: computeRequestKey("codex", ["exec", "--", "-"]),
      cli: "codex",
      args: ["exec", "--", "-"],
      startedAt: now,
      pid: null,
    });
    store.recordComplete({
      id: "pg-job-e2big",
      status: "failed",
      exitCode: 126,
      stdout: "",
      stderr: "input too large",
      outputTruncated: false,
      error: "input too large",
      errorCategory: "input_too_large",
      retryable: false,
      finishedAt: now,
    });

    expect(store.getById("pg-job-e2big")).toMatchObject({
      status: "failed",
      exitCode: 126,
      errorCategory: "input_too_large",
      retryable: false,
    });
  });

  it("rejects Kit plus MCP provenance before writing a job or attempt fence", async () => {
    const id = "pg-kit-mcp-admission";
    expect(() =>
      store.recordStart({
        id,
        correlationId: "pg-kit-mcp-admission-correlation",
        requestKey: "pg-kit-mcp-admission-key",
        cli: "claude",
        args: ["-p", "review"],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerHostname: "pg-origin-host",
        transport: "process",
        mcpArtifactPath: "/tmp/pg-kit-mcp-admission.json",
        mcpArtifactScope: "pg-kit-mcp-admission-scope",
        kitExecution: kitExecution({ contextIdentity: "pg-kit-mcp-admission-context" }),
        kitSessionId: "pg-kit-mcp-admission-session",
      })
    ).toThrow(/Kit jobs cannot carry Claude MCP artifact provenance/);
    expect(store.getById(id)).toBeNull();
    const fences = await pool.query(
      "SELECT attempt_id FROM kit_attempt_fences WHERE attempt_id = $1",
      [id]
    );
    expect(fences.rows).toEqual([]);
  });

  it("persists nullable response compression decisions across a worker restart", () => {
    const startedAt = new Date().toISOString();
    const decisions: ReadonlyArray<readonly [string, boolean | undefined]> = [
      ["pg-compression-enabled", true],
      ["pg-compression-disabled", false],
      ["pg-compression-legacy", undefined],
    ];

    for (const [id, compressResponse] of decisions) {
      store.recordStart({
        id,
        correlationId: `${id}-corr`,
        requestKey: `${id}-key`,
        cli: "claude",
        args: ["-p", id],
        compressResponse,
        startedAt,
        pid: null,
      });
    }
    store.recordStart({
      id: "pg-kit-compression-enabled",
      correlationId: "pg-kit-compression-enabled-corr",
      requestKey: "pg-kit-compression-enabled-key",
      cli: "claude",
      args: ["-p", "redacted Kit request"],
      compressResponse: true,
      startedAt,
      pid: null,
      kitExecution: kitExecution({ contextIdentity: "pg-kit-compression-enabled-context" }),
      kitSessionId: "pg-kit-compression-enabled-session",
      ownerPrincipal: "local",
    });

    store.close();
    const restarted = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
    });
    try {
      expect(restarted.getById("pg-compression-enabled")?.compressResponse).toBe(true);
      expect(restarted.getById("pg-compression-disabled")?.compressResponse).toBe(false);
      expect(restarted.getById("pg-compression-legacy")?.compressResponse).toBeNull();
      expect(restarted.getById("pg-kit-compression-enabled")?.compressResponse).toBe(true);
    } finally {
      restarted.close();
    }
  });

  it("permanently fences recovered Kit attempts before normal durable admission", () => {
    const execution = kitExecution({ contextIdentity: "pg-fenced-context" });
    const fence = {
      attemptId: "pg-fenced-attempt",
      cli: "claude",
      kitExecution: execution,
      kitSessionId: "pg-fenced-session",
      ownerPrincipal: "local",
      fencedAt: new Date().toISOString(),
    };

    expect(store.fenceUnadmittedKitAttempt(fence)).toBe("reserved");
    expect(store.fenceUnadmittedKitAttempt(fence)).toBe("already_recovered");
    expect(store.fenceUnadmittedKitAttempt({ ...fence, kitSessionId: "pg-other-session" })).toBe(
      "conflict"
    );
    expect(() =>
      store.recordStart({
        id: fence.attemptId,
        correlationId: "pg-late-admission",
        requestKey: "pg-late-admission-key",
        cli: "claude",
        args: ["-p", "late"],
        startedAt: new Date().toISOString(),
        pid: null,
        kitExecution: execution,
        kitSessionId: fence.kitSessionId,
        ownerPrincipal: "local",
      })
    ).toThrow(/permanently recovered/);
    expect(store.getById(fence.attemptId)).toBeNull();

    store.recordStart({
      id: "pg-admitted-attempt",
      correlationId: "pg-admitted-corr",
      requestKey: "pg-admitted-key",
      cli: "claude",
      args: ["-p", "admitted"],
      startedAt: new Date().toISOString(),
      pid: null,
      kitExecution: execution,
      kitSessionId: "pg-admitted-session",
      ownerPrincipal: "local",
    });
    expect(
      store.fenceUnadmittedKitAttempt({
        ...fence,
        attemptId: "pg-admitted-attempt",
        kitSessionId: "pg-admitted-session",
      })
    ).toBe("conflict");
  });

  it("allows only local replay of an exact legacy-unowned recovered Kit fence", async () => {
    const execution = kitExecution({ contextIdentity: "pg-legacy-unowned-fence-context" });
    const fence = {
      attemptId: "pg-legacy-unowned-fence",
      cli: "claude",
      kitExecution: execution,
      kitSessionId: "pg-legacy-unowned-fence-session",
      ownerPrincipal: null,
      fencedAt: new Date().toISOString(),
    };

    expect(store.fenceUnadmittedKitAttempt(fence)).toBe("reserved");
    expect(store.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: "local" })).toBe(
      "already_recovered"
    );
    expect(store.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: "remote-reviewer" })).toBe(
      "conflict"
    );
    expect(store.fenceUnadmittedKitAttempt(fence)).toBe("conflict");
    expect(store.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: undefined })).toBe(
      "conflict"
    );
    expect(
      store.fenceUnadmittedKitAttempt({
        ...fence,
        ownerPrincipal: 42 as unknown as string,
      })
    ).toBe("conflict");

    const persisted = await pool.query(
      "SELECT owner_principal FROM kit_attempt_fences WHERE attempt_id = $1",
      [fence.attemptId]
    );
    expect(persisted.rows).toEqual([{ owner_principal: null }]);
  });

  it("canonicalizes Kit execution before PostgreSQL persistence", async () => {
    const privateContext = "PRIVATE_PG_KIT_EXECUTION_SENTINEL";
    const canonical = kitExecution({ contextIdentity: "pg-canonical-execution-context" });
    const untrusted = {
      ...canonical,
      leaked: privateContext,
    } as unknown as KitExecutionRef;

    store.recordStart({
      id: "pg-canonical-kit-execution",
      correlationId: "pg-canonical-kit-execution-corr",
      requestKey: "pg-canonical-kit-execution-key",
      cli: "claude",
      args: ["-p", "safe"],
      startedAt: new Date().toISOString(),
      pid: null,
      kitExecution: untrusted,
      kitSessionId: "pg-canonical-kit-session",
    });

    expect(store.getById("pg-canonical-kit-execution")?.kitExecution).toEqual(canonical);
    expect(store.getById("pg-canonical-kit-execution")?.requestKey).toBe(
      "kit:pg-canonical-kit-execution"
    );
    const rows = await pool.query<{ kit_execution_json: string }>(
      `SELECT kit_execution_json
       FROM jobs
       WHERE id = 'pg-canonical-kit-execution'
       UNION ALL
       SELECT kit_execution_json
       FROM kit_attempt_fences
       WHERE attempt_id = 'pg-canonical-kit-execution'`
    );
    expect(rows.rows).toHaveLength(2);
    expect(JSON.stringify(rows.rows)).not.toContain(privateContext);
    expect(rows.rows.map(row => JSON.parse(row.kit_execution_json))).toEqual([
      canonical,
      canonical,
    ]);
  });

  it("scrubs legacy Kit material on PostgreSQL worker startup", async () => {
    const privateContext = "PRIVATE_PG_WORKER_KIT_PRIVACY_SENTINEL";
    const legacyRows = [
      {
        id: "pg-worker-legacy-failed-kit",
        status: "failed",
        nativeSessionId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      },
      {
        id: "pg-worker-legacy-queued-kit",
        status: "queued",
        nativeSessionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      },
      {
        id: "pg-worker-legacy-running-kit",
        status: "running",
        nativeSessionId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
      },
    ] as const;
    for (const { id, status, nativeSessionId } of legacyRows) {
      await pool.query(
        `INSERT INTO jobs (
          id, correlation_id, request_key, cli, args_json, status, stdout, stderr,
          error, started_at, expires_at, payload_json, kit_execution_json,
          kit_session_id, kit_terminal_metadata_json
        ) VALUES (
          $1, $2, $3, 'claude', $4, $5, $6, $6, $6, $7, $8, $6, $9, $10, $11
        )`,
        [
          id,
          `${id}-corr`,
          `${id}-key`,
          JSON.stringify(["-p", privateContext]),
          status,
          privateContext,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          JSON.stringify(kitExecution({ contextIdentity: `${id}-context` })),
          `${id}-session`,
          JSON.stringify({ version: 1, nativeSessionId }),
        ]
      );
    }

    const reopened = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
    });
    try {
      const row = await pool.query<{
        id: string;
        status: string;
        request_key: string;
        args_json: string;
        stdout: string | null;
        stderr: string | null;
        error: string | null;
        payload_json: string | null;
        kit_terminal_metadata_json: string | null;
      }>(
        `SELECT id, status, request_key, args_json, stdout, stderr, error, payload_json,
                kit_terminal_metadata_json
         FROM jobs
         WHERE id = ANY($1::text[])`,
        [legacyRows.map(({ id }) => id)]
      );
      const rowsById = new Map(row.rows.map(item => [item.id, item]));
      expect(rowsById.get("pg-worker-legacy-failed-kit")).toEqual({
        id: "pg-worker-legacy-failed-kit",
        status: "failed",
        request_key: "kit:pg-worker-legacy-failed-kit",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: "Personal Agent Config Kit provider execution failed; detailed output is withheld",
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(rowsById.get("pg-worker-legacy-queued-kit")).toMatchObject({
        id: "pg-worker-legacy-queued-kit",
        status: "queued",
        request_key: "kit:pg-worker-legacy-queued-kit",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: null,
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(rowsById.get("pg-worker-legacy-running-kit")).toMatchObject({
        id: "pg-worker-legacy-running-kit",
        status: "running",
        request_key: "kit:pg-worker-legacy-running-kit",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: null,
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(JSON.stringify(row.rows)).not.toContain(privateContext);

      // Startup privacy repair must remain available for dirty legacy rows,
      // without creating a new Postgres row version for rows that already meet
      // the boundary. `ctid` makes the otherwise-invisible no-op UPDATE
      // observable across a second worker start.
      const beforeCleanRestart = await pool.query<{ id: string; row_version: string }>(
        `SELECT id, ctid::text AS row_version
         FROM jobs
         WHERE id = ANY($1::text[])
         ORDER BY id`,
        [legacyRows.map(({ id }) => id)]
      );
      const cleanRestart = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
        retentionMs: 60_000,
        dedupWindowMs: 60_000,
      });
      try {
        const afterCleanRestart = await pool.query<{ id: string; row_version: string }>(
          `SELECT id, ctid::text AS row_version
           FROM jobs
           WHERE id = ANY($1::text[])
           ORDER BY id`,
          [legacyRows.map(({ id }) => id)]
        );
        expect(afterCleanRestart.rows).toEqual(beforeCleanRestart.rows);
      } finally {
        cleanRestart.close();
      }
    } finally {
      reopened.close();
    }
  });

  it("starts and writes through a complete schema with a DML-only runtime role", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `job_store_runtime_${suffix}`;
    const role = `job_store_runtime_${suffix}`;
    const password = `pw_${suffix}`;
    let isolated: PostgresJobStore | null = null;
    try {
      await pool.query(`CREATE SCHEMA ${schema}`);
      for (const table of [
        "jobs",
        "gateway_instances",
        "validation_runs",
        "validation_run_jobs",
        "validation_receipts",
        "kit_attempt_fences",
      ]) {
        await pool.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
      }
      await pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${password}'`);
      await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`
      );
      const privilege = await pool.query<{ can_create: boolean }>(
        "SELECT has_schema_privilege($1, $2, 'CREATE') AS can_create",
        [role, schema]
      );
      expect(privilege.rows[0]?.can_create).toBe(false);

      // A runtime worker that still runs CREATE/ALTER on every startup would
      // fail here. The catalog preflight must take the DML-only path instead.
      isolated = new PostgresJobStore(roleScopedDsn(role, password, schema), undefined, {
        retentionMs: 60_000,
        dedupWindowMs: 60_000,
      });
      isolated.recordStart({
        id: "dml-only-job",
        correlationId: "dml-only-corr",
        requestKey: "dml-only-key",
        cli: "claude",
        args: ["-p", "DML only"],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerInstance: "dml-only-instance",
      });
      expect(isolated.getById("dml-only-job")).toMatchObject({
        id: "dml-only-job",
        status: "queued",
        ownerInstance: "dml-only-instance",
      });
    } finally {
      isolated?.close();
      await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await pool.query(`DROP ROLE IF EXISTS ${role}`);
    }
  });

  it("persists and compare-and-sets pending Kit terminal finalization", () => {
    const execution = kitExecution();
    const privateContext = "PRIVATE_PG_KIT_CONTEXT_SENTINEL";
    store.recordStart({
      id: "pg-kit-finalization",
      correlationId: "pg-kit-finalization-corr",
      requestKey: "pg-kit-finalization-key",
      cli: "claude",
      args: ["-p", privateContext],
      outputFormat: "stream-json",
      startedAt: new Date().toISOString(),
      pid: null,
      kitExecution: execution,
      kitSessionId: "gateway-pg-kit-session",
    });
    store.recordOutput("pg-kit-finalization", privateContext, privateContext, false);
    store.recordComplete({
      id: "pg-kit-finalization",
      status: "completed",
      exitCode: 0,
      stdout: privateContext,
      stderr: privateContext,
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
      kitTerminalMetadata: {
        version: 1,
        nativeSessionId: "33333333-3333-4333-8333-333333333333",
      },
    });

    expect(store.getPinnedKitReleaseIds?.()).toEqual(["release-pg-job"]);
    expect(store.getPendingKitFinalizations()).toMatchObject([
      {
        jobId: "pg-kit-finalization",
        kitSessionId: "gateway-pg-kit-session",
        kitExecution: execution,
        terminalMetadata: null,
      },
    ]);
    expect(store.getById("pg-kit-finalization")).toMatchObject({
      argsJson: JSON.stringify(["[personal-config-kit arguments redacted]"]),
      stdout: "",
      stderr: "",
      error: null,
    });
    expect(JSON.stringify(store.getById("pg-kit-finalization"))).not.toContain(privateContext);
    expect(store.markKitTerminalFinalized("pg-kit-finalization", "wrong-session")).toBe(false);
    expect(store.markKitTerminalFinalized("pg-kit-finalization", "gateway-pg-kit-session")).toBe(
      true
    );
    expect(store.markKitTerminalFinalized("pg-kit-finalization", "gateway-pg-kit-session")).toBe(
      true
    );
    expect(store.getPendingKitFinalizations()).toEqual([]);
    expect(store.getPinnedKitReleaseIds?.()).toEqual([]);
    expect(store.getById("pg-kit-finalization")).toMatchObject({
      kitSessionId: "gateway-pg-kit-session",
      kitTerminalFinalized: true,
      kitTerminalFinalizedAt: expect.any(String),
    });
  });

  it("uses in-memory worker replies when TMPDIR is unavailable and preserves a 50 MiB result", () => {
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = join(tempDir, "missing-runtime-dir");
    const isolated = new PostgresJobStore(TEST_DATABASE_URL, undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
    });
    try {
      const stdout = "x".repeat(50 * 1024 * 1024);
      isolated.recordStart({
        id: "pg-message-port-large-result",
        correlationId: "pg-message-port-large-result-corr",
        requestKey: "pg-message-port-large-result-key",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: null,
      });
      isolated.recordComplete({
        id: "pg-message-port-large-result",
        status: "completed",
        exitCode: 0,
        stdout,
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: new Date().toISOString(),
      });

      expect(isolated.getById("pg-message-port-large-result")?.stdout).toBe(stdout);
      isolated.close();
      expect(() => isolated.getById("pg-message-port-large-result")).toThrow(/closed/);
    } finally {
      isolated.close();
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }
  }, 30_000);

  it("recreates a retired worker before accepting the next durable operation", async () => {
    const errors: string[] = [];
    const isolated = new PostgresJobStore(
      TEST_DATABASE_URL,
      {
        info: () => {},
        warn: () => {},
        debug: () => {},
        error: message => errors.push(String(message)),
      },
      {
        retentionMs: 60_000,
        dedupWindowMs: 60_000,
      }
    );
    const internals = isolated as unknown as {
      worker: Worker | null;
      workerTerminationPending: boolean;
      retireWorker: (worker: Worker | null) => void;
    };
    const worker = internals.worker;
    if (!worker) throw new Error("Expected PostgresJobStore to have a live worker");
    const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));

    try {
      // This is the same controlled-retirement path used after a bridge
      // timeout. Waiting for exit proves the replacement cannot overlap a
      // possibly still-running predecessor operation.
      internals.retireWorker(worker);
      await exited;
      expect(internals.workerTerminationPending).toBe(false);
      expect(errors).not.toContain("PostgresJobStore worker exited unexpectedly");

      isolated.recordStart({
        id: "pg-worker-recovery",
        correlationId: "pg-worker-recovery-corr",
        requestKey: "pg-worker-recovery-key",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: null,
      });
      expect(isolated.getById("pg-worker-recovery")?.status).toBe("queued");
    } finally {
      isolated.close();
    }
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

  it("#139: selects a durable same-host orphan after gateway-instance GC", async () => {
    const ownerInstance = "pg-owner-hostname-instance";
    const ownerHostname = "pg-owner-hostname";
    store.registerInstance({
      instanceId: ownerInstance,
      role: "gateway",
      hostname: ownerHostname,
      pid: 1234,
    });
    store.recordStart({
      id: "pg-owner-hostname-orphan",
      correlationId: "pg-owner-hostname-corr",
      requestKey: "pg-owner-hostname-key",
      cli: "claude",
      args: ["-p", "review"],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance,
      ownerHostname,
    });
    await pool.query("UPDATE jobs SET lease_deadline = 1 WHERE id = $1", [
      "pg-owner-hostname-orphan",
    ]);

    expect(store.recoverStaleJobs(90_000, 300_000).map(row => row.id)).toContain(
      "pg-owner-hostname-orphan"
    );
    expect(store.gcInstances(-1)).toBe(1);

    expect(store.selectOrphanedProcessCandidates(ownerHostname)).toEqual([
      {
        id: "pg-owner-hostname-orphan",
        pid: null,
        transport: "process",
        ownerInstance,
        hostname: ownerHostname,
      },
    ]);
    expect(store.selectOrphanedProcessCandidates("other-host")).toEqual([]);
  });

  it("retains a pending Claude MCP artifact until the exact origin-host acknowledgement", async () => {
    const ownerInstance = "pg-mcp-pending-instance";
    const ownerHostname = "pg-mcp-pending-host";
    const artifactScope = "pg-mcp-pending-installation:1:1";
    const artifactPath =
      "/home/gateway/.llm-cli-gateway/claude-mcp/request.123.11111111-1111-4111-8111-111111111111.json";
    const pgStore = store as PostgresJobStore;
    store.recordStart({
      id: "pg-mcp-pending",
      correlationId: "pg-mcp-pending-corr",
      requestKey: "pg-mcp-pending-key",
      cli: "claude",
      args: ["-p", "review", "--mcp-config", artifactPath],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance,
      ownerHostname,
      mcpArtifactPath: artifactPath,
      mcpArtifactScope: artifactScope,
    });
    await pool.query("UPDATE jobs SET lease_deadline = 1 WHERE id = $1", ["pg-mcp-pending"]);
    expect(store.recoverStaleJobs(90_000, 300_000).map(row => row.id)).toContain("pg-mcp-pending");
    await pool.query("UPDATE jobs SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = $1", [
      "pg-mcp-pending",
    ]);

    expect(store.evictExpired()).toBe(0);
    expect(pgStore.selectPendingMcpArtifactCleanups(ownerHostname)).toEqual([
      {
        id: "pg-mcp-pending",
        ownerInstance,
        hostname: ownerHostname,
        artifactScope,
        artifactPath,
      },
    ]);
    expect(
      pgStore.acknowledgeMcpArtifactCleanup(
        "pg-mcp-pending",
        "other-host",
        artifactScope,
        artifactPath
      )
    ).toBe(false);
    expect(
      pgStore.acknowledgeMcpArtifactCleanup(
        "pg-mcp-pending",
        ownerHostname,
        "other-installation:2:2",
        artifactPath
      )
    ).toBe(false);
    expect(
      pgStore.acknowledgeMcpArtifactCleanup(
        "pg-mcp-pending",
        ownerHostname,
        artifactScope,
        artifactPath
      )
    ).toBe(true);
    expect(store.evictExpired()).toBe(1);
  });

  it("persists validation runs and receipts", () => {
    expect(isValidationRunStore(store)).toBe(true);
    store.recordValidationRun({
      validationId: "val-pg-1",
      ownerPrincipal: "alice",
      intent: "review",
      createdAt: new Date().toISOString(),
      requestJson: JSON.stringify({ question: "ship?" }),
      providerLinks: [],
      judgeLink: null,
      status: "admitting",
    });
    store.recordStart({
      id: "job-openai",
      correlationId: "corr-openai",
      requestKey: "request-openai",
      cli: "openai",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerPrincipal: "alice",
      transport: "http",
      validationAdmission: { validationId: "val-pg-1", provider: "openai" },
    });
    expect(() =>
      store.recordStart({
        id: "job-rejected",
        correlationId: "corr-rejected",
        requestKey: "request-rejected",
        cli: "codex",
        args: [],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerPrincipal: "mallory",
        validationAdmission: { validationId: "val-pg-1", provider: "codex" },
      })
    ).toThrow(/missing or owned by another principal/);
    expect(store.getById("job-rejected")).toBeNull();
    expect(store.transitionValidationRunStatus("val-pg-1", "alice", "admitting", "running")).toBe(
      true
    );
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

  it.each([
    ["provider_links", "pg-malformed-provider-job", /provider links are malformed/],
    ["judge_link", "pg-malformed-judge-job", /judge link is malformed/],
  ] as const)(
    "fails closed when durable PostgreSQL %s is malformed despite a surviving reverse link",
    async (column, reverseJobId, expectedError) => {
      const validationId = `val-pg-malformed-${column}`;
      store.recordValidationRun({
        validationId,
        ownerPrincipal: "alice",
        intent: "validate",
        createdAt: new Date().toISOString(),
        requestJson: JSON.stringify({ question: "?", modelList: ["claude"] }),
        providerLinks:
          column === "provider_links"
            ? [{ provider: "claude", jobId: reverseJobId, correlationId: "corr-claude" }]
            : [],
        judgeLink: null,
        status: "running",
      });
      if (column === "judge_link") {
        store.setValidationJudgeLink(validationId, {
          provider: "codex",
          jobId: reverseJobId,
          correlationId: "corr-judge",
        });
      }

      await pool.query(`UPDATE validation_runs SET ${column} = $1 WHERE validation_id = $2`, [
        "not-json",
        validationId,
      ]);

      expect(store.getValidationRunIdByJobId(reverseJobId)).toBe(validationId);
      expect(() => store.getValidationRun(validationId)).toThrow(expectedError);
      eagerMintFromJobId(
        { validationRunStore: store, asyncJobManager: {} as AsyncJobManager },
        reverseJobId
      );
      expect(store.getValidationReceipt(validationId)).toBeNull();
    }
  );

  it("atomically admits the planned review judge once and rolls back rejected claims", () => {
    const requestJson = JSON.stringify({
      judgeProvider: "judge-api",
      reviewAuthorization: { judgeProvider: "judge-api" },
    });
    store.recordValidationRun({
      validationId: "val-pg-judge",
      ownerPrincipal: "alice",
      intent: "review",
      createdAt: new Date().toISOString(),
      requestJson,
      providerLinks: [],
      judgeLink: null,
      status: "running",
    });
    store.recordStart({
      id: "pg-judge-job",
      correlationId: "pg-judge-correlation",
      requestKey: "pg-judge-request",
      cli: "judge-api",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerPrincipal: "alice",
      transport: "http",
      validationAdmission: {
        validationId: "val-pg-judge",
        provider: "judge-api",
        role: "judge",
      },
    });
    expect(store.getValidationRun("val-pg-judge")?.judgeLink).toEqual({
      provider: "judge-api",
      jobId: "pg-judge-job",
      correlationId: "pg-judge-correlation",
    });
    expect(store.getValidationRunIdByJobId("pg-judge-job")).toBe("val-pg-judge");

    for (const [id, provider, owner] of [
      ["pg-judge-duplicate", "judge-api", "alice"],
      ["pg-judge-wrong-plan", "other-judge", "alice"],
      ["pg-judge-wrong-owner", "judge-api", "mallory"],
    ] as const) {
      expect(() =>
        store.recordStart({
          id,
          correlationId: `corr-${id}`,
          requestKey: `request-${id}`,
          cli: provider,
          args: [],
          startedAt: new Date().toISOString(),
          pid: null,
          ownerPrincipal: owner,
          validationAdmission: {
            validationId: "val-pg-judge",
            provider,
            role: "judge",
          },
        })
      ).toThrow();
      expect(store.getById(id)).toBeNull();
    }
  });

  it("owner-scopes review admission transitions and atomically records a skipped judge", () => {
    store.recordValidationRun({
      validationId: "val-pg-transition",
      ownerPrincipal: "alice",
      intent: "review",
      createdAt: new Date().toISOString(),
      requestJson: JSON.stringify({
        judgeProvider: "judge-api",
        reviewAuthorization: { judgeProvider: "judge-api" },
      }),
      providerLinks: [],
      judgeLink: null,
      status: "admitting",
    });
    expect(
      store.transitionValidationRunStatus("val-pg-transition", "mallory", "admitting", "running")
    ).toBe(false);
    expect(
      store.transitionValidationRunStatus("val-pg-transition", "alice", "admitting", "running")
    ).toBe(true);
    store.skipValidationJudge("val-pg-transition", "judge-api", "alice");
    expect(store.getValidationRun("val-pg-transition")?.status).toBe("judge_skipped");
  });

  it("registers and serves validation_receipt through a postgres-backed gateway", async () => {
    const now = new Date().toISOString();
    for (const [id, cli] of [
      ["pg-v-claude", "claude"],
      ["pg-v-codex", "codex"],
    ] as const) {
      store.recordStart({
        id,
        correlationId: `corr-${id}`,
        requestKey: `key-${id}`,
        cli,
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
