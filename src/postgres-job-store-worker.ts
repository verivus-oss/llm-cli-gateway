import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import type { Pool, PoolClient } from "pg";
import {
  cloneKitExecutionRef,
  isKitExecutionRef,
  personalKitJobRequestKey,
  sameKitExecutionRef,
  type KitExecutionRef,
} from "./personal-config-types.js";
import { assertMcpArtifactAdmissionInvariant } from "./mcp-artifact-admission.js";
import { POSTGRES_JOB_STORE_REQUIRED_COLUMNS } from "./postgres-job-store-schema.js";
import { principalCanAccess } from "./request-context.js";

let pool: Pool | null = null;

/**
 * #139: the Postgres DB-clock as epoch milliseconds, used inline in the
 * lease/sweep SQL so the fencing comparison never depends on the client clock
 * (mirrors the sqlite SQLITE_NOW_MS expression on the other backend).
 */
const PG_NOW_MS = "(EXTRACT(EPOCH FROM now()) * 1000)::bigint";
const PG_BOOTSTRAP_LOCK_KEY = 13_920_260_713;
const PG_POOL_MAX = 1;
const PG_STATEMENT_TIMEOUT_MS = 25_000;
const PG_LOCK_TIMEOUT_MS = 5_000;
const PG_QUERY_TIMEOUT_MS = 27_000;
const PERSONAL_KIT_REDACTED_ARGS_JSON = '["[personal-config-kit arguments redacted]"]';
const PERSONAL_KIT_FAILURE_WITHHELD =
  "Personal Agent Config Kit provider execution failed; detailed output is withheld";

function serializeKitTerminalMetadata(value: unknown): string | null {
  // Provider-native continuation handles are process-local and must never
  // cross this worker's durable database boundary.
  void value;
  return null;
}

interface JobStoreSchemaColumnRow {
  logical_table: string;
  relation_name: string | null;
  column_name: string | null;
}

function reportDiagnostic(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  parentPort?.postMessage({
    type: "postgres-job-store-diagnostic",
    kind,
    message,
    stack,
  });
}

function signal(shared: SharedArrayBuffer, status: number): void {
  const view = new Int32Array(shared);
  Atomics.store(view, 0, status);
  Atomics.notify(view, 0, 1);
}

function ok(value: unknown): { ok: true; value: unknown } {
  return { ok: true, value };
}

function fail(error: unknown): {
  ok: false;
  error: { message: string; stack?: string };
} {
  return {
    ok: false,
    error: {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  };
}

function canonicalKitExecution(value: unknown): KitExecutionRef {
  if (!isKitExecutionRef(value)) {
    throw new Error("Invalid Personal Agent Config Kit execution reference");
  }
  return cloneKitExecutionRef(value);
}

function assertReviewJudgeClaim(
  run: {
    intent?: unknown;
    request_json?: unknown;
    judge_link?: unknown;
    status?: unknown;
  },
  provider: string
): void {
  if (run.intent !== "review" || run.status !== "running") {
    throw new Error("Validation run is not an open admitted review");
  }
  if (run.judge_link !== null && run.judge_link !== undefined) {
    throw new Error("Validation review judge is already claimed");
  }
  let request: unknown;
  try {
    request = JSON.parse(String(run.request_json));
  } catch {
    throw new Error("Validation review request is invalid");
  }
  if (
    typeof request !== "object" ||
    request === null ||
    (request as { judgeProvider?: unknown }).judgeProvider !== provider
  ) {
    throw new Error(`Validation review does not authorize judge ${provider}`);
  }
  const authorization = (request as { reviewAuthorization?: unknown }).reviewAuthorization;
  if (
    typeof authorization !== "object" ||
    authorization === null ||
    (authorization as { judgeProvider?: unknown }).judgeProvider !== provider
  ) {
    throw new Error(`Validation review authorization does not permit judge ${provider}`);
  }
}

function sameKitExecution(left: unknown, right: unknown): boolean {
  return isKitExecutionRef(left) && isKitExecutionRef(right) && sameKitExecutionRef(left, right);
}

function recoveredFenceOwnerMatches(storedOwner: unknown, callerOwner: unknown): boolean {
  if (typeof callerOwner !== "string") return false;
  if (storedOwner !== null && storedOwner !== undefined && typeof storedOwner !== "string") {
    return false;
  }
  return principalCanAccess(storedOwner, callerOwner);
}

async function insertKitAttemptFence(
  client: Pool | PoolClient,
  input: {
    attemptId: string;
    cli: string;
    kitExecution: unknown;
    kitSessionId: string;
    ownerPrincipal?: string | null;
    fencedAt: string;
  },
  state: "admitted" | "recovered"
): Promise<boolean> {
  const kitExecution = canonicalKitExecution(input.kitExecution);
  const result = await client.query(
    `INSERT INTO kit_attempt_fences
       (attempt_id, state, cli, kit_execution_json, kit_session_id, owner_principal, fenced_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (attempt_id) DO NOTHING
     RETURNING attempt_id`,
    [
      input.attemptId,
      state,
      input.cli,
      JSON.stringify(kitExecution),
      input.kitSessionId,
      input.ownerPrincipal ?? null,
      input.fencedAt,
    ]
  );
  return (result.rowCount ?? 0) === 1;
}

function getPool(): Pool {
  if (!pool) throw new Error("PostgresJobStore worker pool is not initialized");
  return pool;
}

/**
 * Match migrations 011, 013, and 014 at the runtime boundary. This is
 * deliberately run on every worker startup so a database that has its columns
 * but missed or partially completed a privacy migration cannot replay private
 * Kit material. Its dirty-row predicate avoids rewriting already-clean
 * records. Provider-native terminal metadata is retired as part of the same
 * repair.
 */
async function scrubLegacyPersonalKitJobMaterial(): Promise<void> {
  await getPool().query(
    `UPDATE jobs
     SET args_json = '${PERSONAL_KIT_REDACTED_ARGS_JSON}',
         request_key = 'kit:' || id,
         stdout = '',
         stderr = '',
         payload_json = NULL,
         kit_terminal_metadata_json = NULL,
         error = CASE
           WHEN status IN ('queued', 'running', 'completed') THEN NULL
           ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
         END
     WHERE kit_execution_json IS NOT NULL
       AND (
         args_json IS DISTINCT FROM '${PERSONAL_KIT_REDACTED_ARGS_JSON}'
         OR request_key IS DISTINCT FROM ('kit:' || id)
         OR stdout IS DISTINCT FROM ''
         OR stderr IS DISTINCT FROM ''
         OR payload_json IS NOT NULL
         OR kit_terminal_metadata_json IS NOT NULL
         OR error IS DISTINCT FROM (
           CASE
             WHEN status IN ('queued', 'running', 'completed') THEN NULL
             ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
           END
         )
       )`
  );
}

/**
 * Migration 017 compatibility repair. A pre-015 job gains host provenance
 * only while its original gateway-instance row still survives. Missing rows
 * remain NULL because guessing a hostname could authorize cleanup in the wrong
 * filesystem namespace.
 */
async function backfillLegacyOwnerHostnames(): Promise<void> {
  await getPool().query(
    `UPDATE jobs AS j
     SET owner_hostname = gi.hostname
     FROM gateway_instances AS gi
     WHERE j.owner_hostname IS NULL
       AND j.owner_instance IS NOT NULL
       AND j.owner_instance = gi.instance_id
       AND gi.hostname IS NOT NULL
       AND gi.hostname <> ''`
  );
}

/**
 * Check the exact unqualified relations which normal worker queries will use.
 * Catalogs are readable to the DML-only role and do not take DDL locks.
 */
async function isJobStoreSchemaReady(): Promise<boolean> {
  const result = await getPool().query<JobStoreSchemaColumnRow>(`
    WITH required_tables(logical_table) AS (
      VALUES
        ('jobs'::text),
        ('gateway_instances'::text),
        ('validation_runs'::text),
        ('validation_run_jobs'::text),
        ('validation_receipts'::text),
        ('kit_attempt_fences'::text)
    ),
    resolved AS (
      SELECT logical_table, to_regclass(logical_table) AS relation_oid
      FROM required_tables
    )
    SELECT resolved.logical_table,
           resolved.relation_oid::text AS relation_name,
           attribute.attname AS column_name
    FROM resolved
    LEFT JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = resolved.relation_oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
  `);
  const columnsByTable = new Map<string, Set<string>>();
  const foundTables = new Set<string>();
  for (const row of result.rows) {
    if (row.relation_name) foundTables.add(row.logical_table);
    if (!row.column_name) continue;
    const columns = columnsByTable.get(row.logical_table) ?? new Set<string>();
    columns.add(row.column_name);
    columnsByTable.set(row.logical_table, columns);
  }
  for (const [table, requiredColumns] of Object.entries(POSTGRES_JOB_STORE_REQUIRED_COLUMNS)) {
    if (!foundTables.has(table)) return false;
    const columns = columnsByTable.get(table);
    if (!columns || requiredColumns.some(column => !columns.has(column))) return false;
  }
  return true;
}

function isInsufficientPrivilegeError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "42501";
}

function incompleteJobStoreSchemaError(cause: unknown): Error {
  return new Error(
    "Postgres job-store schema is missing or incomplete. Run `npm run migrate` with the migration role before starting a DML-only gateway runtime.",
    { cause }
  );
}

async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

async function init(): Promise<void> {
  let pg;
  try {
    pg = await import("pg");
  } catch (error: unknown) {
    const code = (error as { code?: string })?.code;
    if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
      throw new Error(
        "Postgres persistence requires optional peer dependency 'pg'. Install it alongside llm-cli-gateway to use backend = 'postgres'.",
        { cause: error }
      );
    }
    throw error;
  }

  pool = new pg.Pool({
    connectionString: workerData.dsn,
    connectionTimeoutMillis: workerData.connectionTimeoutMillis,
    // The parent JobStore interface is synchronous, so it can issue only one
    // operation at a time. A larger pool merely consumes connections across
    // short-lived stdio gateway instances without adding throughput.
    max: PG_POOL_MAX,
    idleTimeoutMillis: 30_000,
    // Ensure PostgreSQL aborts a blocked or pathological operation before the
    // parent's watchdog makes the mutation outcome ambiguous.
    statement_timeout: PG_STATEMENT_TIMEOUT_MS,
    lock_timeout: PG_LOCK_TIMEOUT_MS,
    query_timeout: PG_QUERY_TIMEOUT_MS,
    application_name: "llm-cli-gateway-job-store",
  });
  getPool().on("error", error => reportDiagnostic("pool_error", error));
  await getPool().query("SELECT 1");
  if (await isJobStoreSchemaReady()) {
    await backfillLegacyOwnerHostnames();
    await scrubLegacyPersonalKitJobMaterial();
    return;
  }
  try {
    await withClient(async client => {
      await client.query("BEGIN");
      try {
        // Legacy and development databases may not have been migrated yet.
        // Serialize the compatibility bootstrap so concurrent short-lived
        // stdio instances do not churn on PostgreSQL DDL locks. A migrated
        // runtime returned above and never reaches this DDL path.
        await client.query("SET LOCAL lock_timeout = 0");
        await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [PG_BOOTSTRAP_LOCK_KEY]);
        await client.query(`SET LOCAL lock_timeout = '${PG_LOCK_TIMEOUT_MS}ms'`);
        await client.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      correlation_id TEXT NOT NULL,
      request_key TEXT NOT NULL,
      cli TEXT NOT NULL,
      args_json TEXT NOT NULL,
      output_format TEXT,
      compress_response BOOLEAN,
      status TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      error_category TEXT,
      retryable BOOLEAN,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      pid INTEGER,
      expires_at TEXT NOT NULL,
      owner_principal TEXT,
      transport TEXT NOT NULL DEFAULT 'process',
      http_status INTEGER,
      payload_json TEXT,
      owner_instance TEXT,
      owner_hostname TEXT,
      mcp_artifact_path TEXT,
      mcp_artifact_scope TEXT,
      mcp_artifact_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
      lease_deadline BIGINT,
      kit_execution_json TEXT,
      kit_session_id TEXT,
      kit_terminal_metadata_json TEXT,
      kit_terminal_finalized BOOLEAN NOT NULL DEFAULT FALSE,
      kit_terminal_finalized_at TEXT,
      progress_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_request_key ON jobs(request_key);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_request_key_finished ON jobs(request_key, finished_at);

    CREATE TABLE IF NOT EXISTS gateway_instances (
      instance_id TEXT PRIMARY KEY,
      role TEXT,
      hostname TEXT,
      pid INTEGER,
      started_at BIGINT NOT NULL,
      last_heartbeat BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_gateway_instances_heartbeat
      ON gateway_instances(last_heartbeat);

    CREATE TABLE IF NOT EXISTS kit_attempt_fences (
      attempt_id TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state IN ('admitted', 'recovered')),
      cli TEXT NOT NULL,
      kit_execution_json TEXT NOT NULL,
      kit_session_id TEXT NOT NULL,
      owner_principal TEXT,
      fenced_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS validation_runs (
      validation_id TEXT PRIMARY KEY,
      owner_principal TEXT NOT NULL,
      intent TEXT NOT NULL,
      created_at TEXT NOT NULL,
      request_json TEXT NOT NULL,
      provider_links TEXT NOT NULL,
      judge_link TEXT,
      status TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validation_runs_owner ON validation_runs(owner_principal);

    CREATE TABLE IF NOT EXISTS validation_run_jobs (
      job_id TEXT PRIMARY KEY,
      validation_id TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validation_run_jobs_run ON validation_run_jobs(validation_id);

    CREATE TABLE IF NOT EXISTS validation_receipts (
      validation_id TEXT PRIMARY KEY,
      owner_principal TEXT NOT NULL,
      minted_at TEXT NOT NULL,
      schema_version TEXT NOT NULL,
      report_json TEXT NOT NULL,
      canonical_sha256 TEXT NOT NULL,
      prev_sha256 TEXT,
      seq INTEGER,
      signature TEXT,
      models TEXT NOT NULL,
      has_material_disagreement BOOLEAN NOT NULL,
      confidence TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_validation_receipts_owner ON validation_receipts(owner_principal);
      `);
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_principal TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS compress_response BOOLEAN");
        await client.query(
          "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'process'"
        );
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS http_status INTEGER");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload_json TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error_category TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retryable BOOLEAN");
        // #139: idempotent durable ownership and lease columns for a pre-existing jobs table.
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_instance TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_hostname TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mcp_artifact_path TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mcp_artifact_scope TEXT");
        await client.query(
          "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mcp_artifact_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE"
        );
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_deadline BIGINT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_execution_json TEXT");
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_session_id TEXT");
        await client.query(
          "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_terminal_metadata_json TEXT"
        );
        await client.query(
          "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_terminal_finalized BOOLEAN NOT NULL DEFAULT FALSE"
        );
        await client.query(
          "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_terminal_finalized_at TEXT"
        );
        await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress_json TEXT");
        // The owner/status index references owner_instance, so it can only be created
        // AFTER the ALTER adds that column to a pre-existing (migration-created) table.
        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status)"
        );
        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_jobs_owner_hostname_status ON jobs(owner_hostname, status)"
        );
        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_cleanup ON jobs(owner_hostname, mcp_artifact_cleanup_pending, status)"
        );
        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_scope_cleanup ON jobs(owner_hostname, mcp_artifact_scope, mcp_artifact_cleanup_pending, status)"
        );
        await client.query(
          "CREATE INDEX IF NOT EXISTS idx_jobs_kit_finalization ON jobs(kit_terminal_finalized, status)"
        );
        await client.query("COMMIT");
      } catch (error: unknown) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError: unknown) {
          reportDiagnostic("bootstrap_rollback_error", rollbackError);
        }
        throw error;
      }
    });
  } catch (error: unknown) {
    if (isInsufficientPrivilegeError(error)) throw incompleteJobStoreSchemaError(error);
    throw error;
  }
  if (!(await isJobStoreSchemaReady())) {
    throw incompleteJobStoreSchemaError(
      new Error("compatibility bootstrap did not produce schema")
    );
  }
  await backfillLegacyOwnerHostnames();
  await scrubLegacyPersonalKitJobMaterial();
}

async function op(method: string, args: any[]): Promise<unknown> {
  switch (method) {
    case "init":
      await init();
      return null;
    case "recordStart": {
      const input = args[0];
      // #139: persist status='queued' (markRunning flips to 'running' at launch)
      // with the owner instance stamped and lease_deadline = db_now + leaseTtl.
      assertMcpArtifactAdmissionInvariant(input);
      if (input.kitExecution) {
        const kitExecution = canonicalKitExecution(input.kitExecution);
        const kitSessionId =
          typeof input.kitSessionId === "string" ? input.kitSessionId.trim() : "";
        if (!kitSessionId) throw new Error("Kit job admission requires a gateway kitSessionId");
        await withClient(async client => {
          await client.query("BEGIN");
          try {
            const claimed = await insertKitAttemptFence(
              client,
              {
                attemptId: input.id,
                cli: input.cli,
                kitExecution,
                kitSessionId,
                ownerPrincipal: input.ownerPrincipal ?? null,
                fencedAt: input.startedAt,
              },
              "admitted"
            );
            if (!claimed) {
              throw new Error(
                `Kit job id ${input.id} is already admitted or permanently recovered`
              );
            }
            await client.query(
              `INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                                 compress_response, status, exit_code, stdout, stderr, output_truncated, error,
                                 started_at, finished_at, pid, expires_at, owner_principal,
                                 transport, http_status, payload_json, owner_instance, owner_hostname,
                                 mcp_artifact_path, mcp_artifact_scope, mcp_artifact_cleanup_pending, lease_deadline,
                                 kit_execution_json, kit_session_id, kit_terminal_finalized,
                                 kit_terminal_finalized_at, kit_terminal_metadata_json)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', NULL, '', '', FALSE, NULL,
                       $8, NULL, $9, $10, $11, $12, NULL, $13, $14, $15, NULL, NULL, FALSE,
                       ${PG_NOW_MS} + $16, $17, $18,
                       FALSE, NULL, NULL)`,
              [
                input.id,
                input.correlationId,
                personalKitJobRequestKey(input.id),
                input.cli,
                PERSONAL_KIT_REDACTED_ARGS_JSON,
                input.outputFormat ?? null,
                input.compressResponse ?? null,
                input.startedAt,
                input.pid,
                workerData.farFutureIso,
                input.ownerPrincipal ?? null,
                input.transport ?? "process",
                null,
                input.ownerInstance ?? null,
                input.ownerHostname ?? null,
                workerData.leaseTtlMs,
                JSON.stringify(kitExecution),
                kitSessionId,
              ]
            );
            await client.query("COMMIT");
          } catch (error) {
            try {
              await client.query("ROLLBACK");
            } catch {
              // Preserve the admission failure which determines whether launch is safe.
            }
            throw error;
          }
        });
        return null;
      }
      const insertSql = `INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                           compress_response, status, exit_code, stdout, stderr, output_truncated, error,
                           started_at, finished_at, pid, expires_at, owner_principal,
                           transport, http_status, payload_json, owner_instance, owner_hostname,
                           mcp_artifact_path, mcp_artifact_scope, mcp_artifact_cleanup_pending, lease_deadline,
                           kit_execution_json, kit_session_id, kit_terminal_finalized,
                           kit_terminal_finalized_at, kit_terminal_metadata_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued', NULL, '', '', FALSE, NULL,
                 $8, NULL, $9, $10, $11, $12, NULL, $13, $14, $15, $16, $17, $18,
                 ${PG_NOW_MS} + $19, $20, $21,
                 FALSE, NULL, NULL)`;
      const insertArgs = [
        input.id,
        input.correlationId,
        input.requestKey,
        input.cli,
        JSON.stringify(input.args),
        input.outputFormat ?? null,
        input.compressResponse ?? null,
        input.startedAt,
        input.pid,
        workerData.farFutureIso,
        input.ownerPrincipal ?? null,
        input.transport ?? "process",
        input.payloadJson ?? null,
        input.ownerInstance ?? null,
        input.ownerHostname ?? null,
        input.mcpArtifactPath ?? null,
        input.mcpArtifactScope ?? null,
        Boolean(input.mcpArtifactPath && input.mcpArtifactScope),
        workerData.leaseTtlMs,
        input.kitExecution ? JSON.stringify(input.kitExecution) : null,
        input.kitSessionId ?? null,
      ];
      if (!input.validationAdmission) {
        await getPool().query(insertSql, insertArgs);
        return null;
      }
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          await client.query(insertSql, insertArgs);
          const selected = await client.query(
            "SELECT owner_principal, intent, request_json, provider_links, judge_link, status FROM validation_runs WHERE validation_id = $1 FOR UPDATE",
            [input.validationAdmission.validationId]
          );
          const run = selected.rows[0];
          if (!run || run.owner_principal !== (input.ownerPrincipal ?? null)) {
            throw new Error("Validation run is missing or owned by another principal");
          }
          const role = input.validationAdmission.role ?? "provider";
          if (role === "judge") {
            assertReviewJudgeClaim(run, input.validationAdmission.provider);
            const link = {
              provider: input.validationAdmission.provider,
              jobId: input.id,
              correlationId: input.correlationId,
            };
            await client.query(
              "UPDATE validation_runs SET judge_link = $2 WHERE validation_id = $1",
              [input.validationAdmission.validationId, JSON.stringify(link)]
            );
            await client.query(
              `INSERT INTO validation_run_jobs (job_id, validation_id, role)
               VALUES ($1, $2, 'judge')`,
              [input.id, input.validationAdmission.validationId]
            );
            await client.query("COMMIT");
            return;
          }
          if (run.intent !== "review" || run.status !== "admitting") {
            throw new Error("Validation review run is not admitting provider jobs");
          }
          const providerLinks = JSON.parse(String(run.provider_links));
          if (!Array.isArray(providerLinks)) {
            throw new Error("Validation run provider links are invalid");
          }
          if (
            providerLinks.some(
              (link: { provider?: unknown }) => link.provider === input.validationAdmission.provider
            )
          ) {
            throw new Error(
              `Validation provider ${input.validationAdmission.provider} is already admitted`
            );
          }
          providerLinks.push({
            provider: input.validationAdmission.provider,
            jobId: input.id,
            correlationId: input.correlationId,
          });
          await client.query(
            "UPDATE validation_runs SET provider_links = $2 WHERE validation_id = $1",
            [input.validationAdmission.validationId, JSON.stringify(providerLinks)]
          );
          await client.query(
            `INSERT INTO validation_run_jobs (job_id, validation_id, role)
             VALUES ($1, $2, 'provider')`,
            [input.id, input.validationAdmission.validationId]
          );
          await client.query("COMMIT");
        } catch (error: unknown) {
          try {
            await client.query("ROLLBACK");
          } catch {
            // Preserve the admission failure which determines whether launch is safe.
          }
          throw error;
        }
      });
      return null;
    }
    case "fenceUnadmittedKitAttempt": {
      const input = args[0];
      const kitExecution = canonicalKitExecution(input.kitExecution);
      const canonicalInput = { ...input, kitExecution };
      const inserted = await insertKitAttemptFence(getPool(), canonicalInput, "recovered");
      if (inserted) return "reserved";
      const result = await getPool().query(
        `SELECT state, cli, kit_execution_json, kit_session_id, owner_principal
         FROM kit_attempt_fences
         WHERE attempt_id = $1`,
        [input.attemptId]
      );
      const existing = result.rows[0] as
        | {
            state?: unknown;
            cli?: unknown;
            kit_execution_json?: unknown;
            kit_session_id?: unknown;
            owner_principal?: unknown;
          }
        | undefined;
      let existingExecution: unknown = null;
      if (typeof existing?.kit_execution_json === "string") {
        try {
          existingExecution = JSON.parse(existing.kit_execution_json);
        } catch {
          existingExecution = null;
        }
      }
      if (
        existing?.state === "recovered" &&
        existing.cli === input.cli &&
        existing.kit_session_id === input.kitSessionId &&
        recoveredFenceOwnerMatches(existing.owner_principal, input.ownerPrincipal) &&
        sameKitExecution(existingExecution, kitExecution)
      ) {
        return "already_recovered";
      }
      return "conflict";
    }
    case "markRunning": {
      const [id, opts] = args as [string, { pid: number | null }];
      // Returns true iff a queued row actually transitioned (rowCount > 0); a
      // zero-row result means the row was already recovered/terminal and the
      // caller must fail-close a process launch.
      const result = await getPool().query(
        `UPDATE jobs
         SET status = 'running', pid = $2, lease_deadline = ${PG_NOW_MS} + $3::bigint
         WHERE id = $1 AND status = 'queued'`,
        [id, opts?.pid ?? null, workerData.leaseTtlMs]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "registerInstance": {
      const meta = args[0];
      await getPool().query(
        `INSERT INTO gateway_instances (instance_id, role, hostname, pid, started_at, last_heartbeat)
         VALUES ($1, $2, $3, $4, ${PG_NOW_MS}, ${PG_NOW_MS})
         ON CONFLICT (instance_id) DO UPDATE SET
           role = EXCLUDED.role, hostname = EXCLUDED.hostname, pid = EXCLUDED.pid,
           last_heartbeat = EXCLUDED.last_heartbeat`,
        [meta.instanceId, meta.role ?? null, meta.hostname ?? null, meta.pid ?? null]
      );
      return null;
    }
    case "heartbeat": {
      const instanceId = args[0];
      // Advance the observability row AND the authoritative per-job lease so
      // heartbeat and sweep are same-row UPDATEs (serialize on the row lock).
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          await client.query(
            `UPDATE gateway_instances SET last_heartbeat = ${PG_NOW_MS} WHERE instance_id = $1`,
            [instanceId]
          );
          await client.query(
            `UPDATE jobs SET lease_deadline = ${PG_NOW_MS} + $2
             WHERE owner_instance = $1 AND status IN ('queued', 'running')`,
            [instanceId, workerData.leaseTtlMs]
          );
          await client.query("COMMIT");
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
      return null;
    }
    case "deregisterInstance": {
      await getPool().query("DELETE FROM gateway_instances WHERE instance_id = $1", [args[0]]);
      return null;
    }
    case "selectStaleProcessCandidates": {
      // Read-only candidate list for the manager's advisory kill(pid,0) check
      // and same-host request-artifact cleanup. Queued/pre-spawn process rows
      // have a null pid and are not pid-probed by the manager.
      const result = await getPool().query(
        `SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
                j.owner_instance AS owner_instance,
                COALESCE(j.owner_hostname, gi.hostname) AS hostname
         FROM jobs j
         LEFT JOIN gateway_instances gi ON gi.instance_id = j.owner_instance
         WHERE j.status IN ('queued', 'running')
           AND j.transport = 'process'
           AND (j.lease_deadline IS NULL OR j.lease_deadline < ${PG_NOW_MS})`
      );
      return result.rows.map(r => ({
        id: r.id,
        pid: r.pid,
        transport: r.transport ?? "process",
        ownerInstance: r.owner_instance ?? null,
        hostname: r.hostname ?? null,
      }));
    }
    case "selectOrphanedProcessCandidates": {
      // A local host may later restart after another gateway instance performed
      // the durable orphan transition. Return only that host's own process rows
      // so startup reconciliation never follows a remote artifact path.
      const result = await getPool().query(
        `SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
                j.owner_instance AS owner_instance, j.owner_hostname AS hostname
         FROM jobs j
         WHERE j.status = 'orphaned'
           AND j.transport = 'process'
           AND j.owner_hostname = $1`,
        [args[0]]
      );
      return result.rows.map(r => ({
        id: r.id,
        pid: r.pid,
        transport: r.transport ?? "process",
        ownerInstance: r.owner_instance ?? null,
        hostname: r.hostname ?? null,
      }));
    }
    case "selectPendingMcpArtifactCleanups": {
      // This is deliberately limited to the origin host and an explicit path
      // recorded at admission. A different workstation may orphan the job, but
      // it must never acknowledge or follow a foreign filesystem path. Scope
      // validation is per request artifact, after the local remover opens its
      // descriptor-pinned directory.
      const result = await getPool().query(
        `SELECT j.id AS id, j.owner_instance AS owner_instance,
                j.owner_hostname AS hostname, j.mcp_artifact_scope AS artifact_scope,
                j.mcp_artifact_path AS artifact_path
         FROM jobs j
         WHERE j.owner_hostname = $1
           AND j.cli = 'claude'
           AND j.transport = 'process'
           AND COALESCE(j.mcp_artifact_cleanup_pending, FALSE) = TRUE
           AND j.mcp_artifact_path IS NOT NULL
           AND j.mcp_artifact_scope IS NOT NULL
           AND j.status IN ('completed', 'failed', 'canceled', 'orphaned')`,
        [args[0]]
      );
      return result.rows.map(row => ({
        id: row.id,
        ownerInstance: row.owner_instance ?? null,
        hostname: row.hostname,
        artifactScope: row.artifact_scope,
        artifactPath: row.artifact_path,
      }));
    }
    case "acknowledgeMcpArtifactCleanup": {
      const [id, hostname, artifactScope, artifactPath] = args as [string, string, string, string];
      const result = await getPool().query(
        `UPDATE jobs
         SET mcp_artifact_cleanup_pending = FALSE
         WHERE id = $1
           AND owner_hostname = $2
           AND mcp_artifact_scope = $3
           AND mcp_artifact_path = $4
           AND COALESCE(mcp_artifact_cleanup_pending, FALSE) = TRUE
           AND status IN ('completed', 'failed', 'canceled', 'orphaned')`,
        [id, hostname, artifactScope, artifactPath]
      );
      return (result.rowCount ?? 0) === 1;
    }
    case "recoverStaleJobs": {
      const [leaseTtlMs, httpJobGraceMs, liveConfirmedIds] = args as [
        number,
        number,
        string[] | undefined,
      ];
      const excludeIds = liveConfirmedIds ?? [];
      // Cutoff for the http grace: db_now (epoch ms) minus the grace window.
      const httpGraceCutoffMs = "(" + PG_NOW_MS + " - $1::bigint)";
      return await withClient(async client => {
        await client.query("BEGIN");
        try {
          // (a) Advisory grace: advance the lease by ONE leaseTtl for
          // pid-confirmed-live rows AND clear the pid, making the grace strictly
          // one-shot (the next sweep no longer treats it as a process candidate,
          // so pid reuse cannot strand a row past a single extra leaseTtl).
          if (excludeIds.length > 0) {
            await client.query(
              `UPDATE jobs SET lease_deadline = ${PG_NOW_MS} + $1::bigint, pid = NULL
               WHERE status IN ('queued', 'running') AND id = ANY($2::text[])`,
              [leaseTtlMs, excludeIds]
            );
          }
          // (b) Fencing sweep: orphan the remaining expired rows. The http grace
          // is IN the predicate; started_at is compared to a DB-clock cutoff in
          // epoch ms. The row lock serializes this against any heartbeat. Params
          // are numbered from $1 so every declared parameter is referenced (an
          // unreferenced param makes Postgres reject the statement).
          const orphan = await client.query(
            `UPDATE jobs
             SET status = 'orphaned',
                 stdout = CASE WHEN kit_execution_json IS NULL THEN stdout ELSE '' END,
                 stderr = CASE WHEN kit_execution_json IS NULL THEN stderr ELSE '' END,
                 payload_json = CASE WHEN kit_execution_json IS NULL THEN payload_json ELSE NULL END,
                 error = CASE
                   WHEN kit_execution_json IS NULL THEN COALESCE(error, 'owning gateway instance is no longer alive')
                   ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
                 END,
                 finished_at = COALESCE(finished_at, $2),
                 expires_at = $3,
                 lease_deadline = NULL
             WHERE status IN ('queued', 'running')
               AND (lease_deadline IS NULL OR lease_deadline < ${PG_NOW_MS})
               AND (transport <> 'http'
                    OR (EXTRACT(EPOCH FROM started_at::timestamptz) * 1000)::bigint < ${httpGraceCutoffMs})
               AND NOT (id = ANY($4::text[]))
             RETURNING id, correlation_id, started_at, stdout, stderr, exit_code, transport, http_status,
                       kit_execution_json IS NOT NULL AS is_personal_config_kit`,
            [
              httpJobGraceMs,
              new Date().toISOString(),
              new Date(Date.now() + workerData.retentionMs).toISOString(),
              excludeIds,
            ]
          );
          await client.query("COMMIT");
          return { orphaned: orphan.rows };
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    }
    case "gcInstances": {
      const result = await getPool().query(
        `DELETE FROM gateway_instances WHERE last_heartbeat < ${PG_NOW_MS} - $1::bigint`,
        [args[0]]
      );
      return result.rowCount ?? 0;
    }
    case "recordOutput":
      await getPool().query(
        `UPDATE jobs
         SET stdout = CASE WHEN kit_execution_json IS NULL THEN $2 ELSE '' END,
             stderr = CASE WHEN kit_execution_json IS NULL THEN $3 ELSE '' END,
             output_truncated = $4
         WHERE id = $1`,
        args
      );
      return null;
    case "recordProgress":
      await getPool().query("UPDATE jobs SET progress_json = $2 WHERE id = $1", args);
      return null;
    case "recordProgressIfStatus": {
      const result = await getPool().query(
        "UPDATE jobs SET progress_json = $3 WHERE id = $1 AND status = $2",
        args
      );
      return (result.rowCount ?? 0) === 1;
    }
    case "recordComplete": {
      const input = args[0];
      const expiresAt = new Date(
        Date.parse(input.finishedAt) + workerData.retentionMs
      ).toISOString();
      // #139: guarded completion. A terminal result may only land on a still-open
      // (queued/running) row or a mistakenly-orphaned one; a no-op on an
      // already-terminal row (last committed terminal state wins).
      await getPool().query(
        `UPDATE jobs
         SET status = $2, exit_code = $3,
             stdout = CASE WHEN kit_execution_json IS NULL THEN $4 ELSE '' END,
             stderr = CASE WHEN kit_execution_json IS NULL THEN $5 ELSE '' END,
             output_truncated = $6,
             error = CASE
               WHEN kit_execution_json IS NULL THEN $7
               WHEN $2 = 'completed' THEN NULL
               ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
             END,
             error_category = $8,
             retryable = $9,
             finished_at = $10,
             expires_at = $11, http_status = $12, lease_deadline = NULL,
             kit_terminal_metadata_json = $13,
             progress_json = COALESCE($14, progress_json)
         WHERE id = $1 AND status IN ('queued', 'running', 'orphaned')`,
        [
          input.id,
          input.status,
          input.exitCode,
          input.stdout,
          input.stderr,
          input.outputTruncated,
          input.error,
          input.errorCategory ?? null,
          input.retryable ?? null,
          input.finishedAt,
          expiresAt,
          input.httpStatus ?? null,
          serializeKitTerminalMetadata(input.kitTerminalMetadata),
          input.progressJson ?? null,
        ]
      );
      return null;
    }
    case "getById": {
      const result = await getPool().query("SELECT * FROM jobs WHERE id = $1", [args[0]]);
      return result.rows[0] ?? null;
    }
    case "findByRequestKey": {
      const cutoff = new Date(Date.now() - workerData.dedupWindowMs).toISOString();
      // #139: reuse running/completed, or a still-live (lease-valid) queued job;
      // never an orphaned/canceled/failed row or an expired-lease queued row.
      const result = await getPool().query(
        `SELECT * FROM jobs
         WHERE request_key = $1
           AND started_at >= $2
           AND (
             status IN ('running', 'completed')
             OR (status = 'queued' AND lease_deadline IS NOT NULL AND lease_deadline >= ${PG_NOW_MS})
           )
         ORDER BY started_at DESC
         LIMIT 1`,
        [args[0], cutoff]
      );
      return result.rows[0] ?? null;
    }
    case "getPinnedKitReleaseIds": {
      const result = await getPool().query(
        `SELECT kit_execution_json FROM jobs
         WHERE kit_execution_json IS NOT NULL
           AND (
             status IN ('queued', 'running')
             OR (
               status NOT IN ('queued', 'running')
               AND COALESCE(kit_terminal_finalized, FALSE) = FALSE
             )
           )`
      );
      return result.rows;
    }
    case "getPendingKitFinalizations": {
      const result = await getPool().query(
        `SELECT * FROM jobs
         WHERE kit_execution_json IS NOT NULL
           AND kit_session_id IS NOT NULL
           AND COALESCE(kit_terminal_finalized, FALSE) = FALSE
           AND status IN ('completed', 'failed', 'canceled')
         ORDER BY finished_at ASC, id ASC`
      );
      return result.rows;
    }
    case "getAcknowledgedKitAttemptReleases": {
      const result = await getPool().query(
        `SELECT * FROM jobs
         WHERE kit_execution_json IS NOT NULL
           AND kit_session_id IS NOT NULL
           AND COALESCE(kit_terminal_finalized, FALSE) = TRUE
           AND status IN ('completed', 'failed', 'canceled')
         ORDER BY finished_at ASC, id ASC`
      );
      return result.rows;
    }
    case "markKitTerminalFinalized": {
      const [id, kitSessionId] = args as [string, string];
      const result = await getPool().query(
        `UPDATE jobs
         SET kit_terminal_finalized = TRUE,
             kit_terminal_finalized_at = COALESCE(kit_terminal_finalized_at, $3)
         WHERE id = $1
           AND kit_session_id = $2
           AND kit_execution_json IS NOT NULL
           AND status IN ('completed', 'failed', 'canceled')`,
        [id, kitSessionId, new Date().toISOString()]
      );
      return (result.rowCount ?? 0) > 0;
    }
    case "evictExpired": {
      const result = await getPool().query(
        `DELETE FROM jobs
         WHERE expires_at < $1
           AND (
             kit_execution_json IS NULL
             OR COALESCE(kit_terminal_finalized, FALSE) = TRUE
           )
           AND COALESCE(mcp_artifact_cleanup_pending, FALSE) = FALSE`,
        [new Date().toISOString()]
      );
      return result.rowCount ?? 0;
    }
    case "recordValidationRun": {
      const run = args[0];
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          await client.query(
            `INSERT INTO validation_runs
               (validation_id, owner_principal, intent, created_at, request_json,
                provider_links, judge_link, status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (validation_id) DO NOTHING`,
            [
              run.validationId,
              run.ownerPrincipal,
              run.intent,
              run.createdAt,
              run.requestJson,
              JSON.stringify(run.providerLinks),
              run.judgeLink ? JSON.stringify(run.judgeLink) : null,
              run.status,
            ]
          );
          for (const link of run.providerLinks) {
            await client.query(
              `INSERT INTO validation_run_jobs (job_id, validation_id, role)
               VALUES ($1, $2, 'provider')
               ON CONFLICT (job_id) DO NOTHING`,
              [link.jobId, run.validationId]
            );
          }
          await client.query("COMMIT");
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
      return null;
    }
    case "getValidationRun": {
      const result = await getPool().query(
        "SELECT * FROM validation_runs WHERE validation_id = $1",
        [args[0]]
      );
      return result.rows[0] ?? null;
    }
    case "setValidationProviderLinks": {
      const [validationId, providerLinks] = args;
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          const updated = await client.query(
            "UPDATE validation_runs SET provider_links = $2 WHERE validation_id = $1",
            [validationId, JSON.stringify(providerLinks)]
          );
          if ((updated.rowCount ?? 0) !== 1) {
            throw new Error(`Unknown validation run: ${validationId}`);
          }
          await client.query(
            "DELETE FROM validation_run_jobs WHERE validation_id = $1 AND role = 'provider'",
            [validationId]
          );
          for (const link of providerLinks) {
            await client.query(
              `INSERT INTO validation_run_jobs (job_id, validation_id, role)
               VALUES ($1, $2, 'provider')`,
              [link.jobId, validationId]
            );
          }
          await client.query("COMMIT");
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
      return null;
    }
    case "setValidationJudgeLink": {
      const [validationId, judgeLink] = args;
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          const result = await client.query(
            `UPDATE validation_runs SET judge_link = $2
             WHERE validation_id = $1
               AND status = 'running'
               AND judge_link IS NULL
               AND NOT EXISTS (
                 SELECT 1 FROM validation_receipts WHERE validation_id = $1
               )`,
            [validationId, JSON.stringify(judgeLink)]
          );
          if (result.rowCount !== 1) {
            throw new Error("Validation judge link is not open for a one-shot claim");
          }
          await client.query(
            `INSERT INTO validation_run_jobs (job_id, validation_id, role)
             VALUES ($1, $2, 'judge')`,
            [judgeLink.jobId, validationId]
          );
          await client.query("COMMIT");
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
      return null;
    }
    case "transitionValidationRunStatus": {
      const [validationId, ownerPrincipal, expectedStatus, status] = args;
      const result = await getPool().query(
        `UPDATE validation_runs SET status = $4
         WHERE validation_id = $1 AND owner_principal = $2 AND status = $3`,
        [validationId, ownerPrincipal, expectedStatus, status]
      );
      return (result.rowCount ?? 0) === 1;
    }
    case "skipValidationJudge": {
      const [validationId, provider, ownerPrincipal] = args;
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          const selected = await client.query(
            `SELECT owner_principal, intent, request_json, judge_link, status
             FROM validation_runs WHERE validation_id = $1 FOR UPDATE`,
            [validationId]
          );
          const run = selected.rows[0];
          if (!run || run.owner_principal !== ownerPrincipal) {
            throw new Error("Validation run is missing or owned by another principal");
          }
          assertReviewJudgeClaim(run, provider);
          await client.query(
            "UPDATE validation_runs SET status = 'judge_skipped' WHERE validation_id = $1",
            [validationId]
          );
          await client.query("COMMIT");
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
      return null;
    }
    case "setValidationRunStatus":
      await getPool().query(
        "UPDATE validation_runs SET status = $2 WHERE validation_id = $1",
        args
      );
      return null;
    case "getValidationRunIdByJobId": {
      const result = await getPool().query(
        "SELECT validation_id FROM validation_run_jobs WHERE job_id = $1",
        [args[0]]
      );
      return result.rows[0] ? result.rows[0].validation_id : null;
    }
    case "recordValidationReceipt": {
      const receipt = args[0];
      await getPool().query(
        `INSERT INTO validation_receipts
           (validation_id, owner_principal, minted_at, schema_version, report_json,
            canonical_sha256, prev_sha256, seq, signature, models,
            has_material_disagreement, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (validation_id) DO NOTHING`,
        [
          receipt.validationId,
          receipt.ownerPrincipal,
          receipt.mintedAt,
          receipt.schemaVersion,
          receipt.reportJson,
          receipt.canonicalSha256,
          receipt.prevSha256,
          receipt.seq,
          receipt.signature,
          JSON.stringify(receipt.models),
          receipt.hasMaterialDisagreement,
          receipt.confidence,
        ]
      );
      return null;
    }
    case "getValidationReceipt": {
      const result = await getPool().query(
        "SELECT * FROM validation_receipts WHERE validation_id = $1",
        [args[0]]
      );
      return result.rows[0] ?? null;
    }
    case "close":
      if (pool) await pool.end();
      pool = null;
      return null;
    default:
      throw new Error(`Unknown PostgresJobStore worker method: ${method}`);
  }
}

parentPort?.on(
  "message",
  async (message: {
    method: string;
    args: any[];
    shared: SharedArrayBuffer;
    responsePort: MessagePort;
  }) => {
    const { method, args, shared, responsePort } = message;
    let payload;
    try {
      payload = ok(await op(method, args));
    } catch (error: unknown) {
      payload = fail(error);
    }
    try {
      // Queue the complete response before waking the synchronous parent. The
      // parent reads this MessagePort with receiveMessageOnPort immediately
      // after Atomics.wait returns, so no temporary-file inode or cleanup path
      // participates in durable job-store availability.
      responsePort.postMessage(payload);
      signal(shared, 1);
    } catch (error: unknown) {
      reportDiagnostic("response_transport_error", error);
      signal(shared, 2);
    } finally {
      responsePort.close();
    }
  }
);
