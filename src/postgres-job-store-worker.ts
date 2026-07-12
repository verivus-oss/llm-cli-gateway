import { parentPort, workerData, type MessagePort } from "node:worker_threads";

import type { Pool, PoolClient } from "pg";

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

function getPool(): Pool {
  if (!pool) throw new Error("PostgresJobStore worker pool is not initialized");
  return pool;
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
  await withClient(async client => {
    await client.query("BEGIN");
    try {
      // Many short-lived stdio instances can initialize concurrently. Serialize
      // the idempotent bootstrap so CREATE/ALTER statements do not churn on
      // PostgreSQL DDL locks. The ordinary 5s lock timeout is right for normal
      // queries, but this deliberate bootstrap serialization may wait up to
      // the statement timeout for a first initializer to finish safely.
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
      status TEXT NOT NULL,
      exit_code INTEGER,
      stdout TEXT,
      stderr TEXT,
      output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      pid INTEGER,
      expires_at TEXT NOT NULL,
      owner_principal TEXT,
      transport TEXT NOT NULL DEFAULT 'process',
      http_status INTEGER,
      payload_json TEXT,
      owner_instance TEXT,
      lease_deadline BIGINT
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
      await client.query(
        "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'process'"
      );
      await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS http_status INTEGER");
      await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload_json TEXT");
      // #139: idempotent durable-lease columns for a pre-existing jobs table.
      await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_instance TEXT");
      await client.query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_deadline BIGINT");
      // The owner/status index references owner_instance, so it can only be created
      // AFTER the ALTER adds that column to a pre-existing (migration-created) table.
      await client.query(
        "CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status)"
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
      await getPool().query(
        `INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                           status, exit_code, stdout, stderr, output_truncated, error,
                           started_at, finished_at, pid, expires_at, owner_principal,
                           transport, http_status, payload_json, owner_instance, lease_deadline)
         VALUES ($1, $2, $3, $4, $5, $6, 'queued', NULL, '', '', FALSE, NULL,
                 $7, NULL, $8, $9, $10, $11, NULL, $12, $13, ${PG_NOW_MS} + $14)`,
        [
          input.id,
          input.correlationId,
          input.requestKey,
          input.cli,
          JSON.stringify(input.args),
          input.outputFormat ?? null,
          input.startedAt,
          input.pid,
          workerData.farFutureIso,
          input.ownerPrincipal ?? null,
          input.transport ?? "process",
          input.payloadJson ?? null,
          input.ownerInstance ?? null,
          workerData.leaseTtlMs,
        ]
      );
      return null;
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
      // Read-only candidate list for the manager's advisory kill(pid,0) check.
      const result = await getPool().query(
        `SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
                j.owner_instance AS owner_instance, gi.hostname AS hostname
         FROM jobs j
         LEFT JOIN gateway_instances gi ON gi.instance_id = j.owner_instance
         WHERE j.status IN ('queued', 'running')
           AND j.transport = 'process'
           AND j.pid IS NOT NULL
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
                 error = COALESCE(error, 'owning gateway instance is no longer alive'),
                 finished_at = COALESCE(finished_at, $2),
                 expires_at = $3,
                 lease_deadline = NULL
             WHERE status IN ('queued', 'running')
               AND (lease_deadline IS NULL OR lease_deadline < ${PG_NOW_MS})
               AND (transport <> 'http'
                    OR (EXTRACT(EPOCH FROM started_at::timestamptz) * 1000)::bigint < ${httpGraceCutoffMs})
               AND NOT (id = ANY($4::text[]))
             RETURNING id, correlation_id, started_at, stdout, stderr, exit_code, transport, http_status`,
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
        "UPDATE jobs SET stdout = $2, stderr = $3, output_truncated = $4 WHERE id = $1",
        args
      );
      return null;
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
         SET status = $2, exit_code = $3, stdout = $4, stderr = $5,
             output_truncated = $6, error = $7, finished_at = $8,
             expires_at = $9, http_status = $10, lease_deadline = NULL
         WHERE id = $1 AND status IN ('queued', 'running', 'orphaned')`,
        [
          input.id,
          input.status,
          input.exitCode,
          input.stdout,
          input.stderr,
          input.outputTruncated,
          input.error,
          input.finishedAt,
          expiresAt,
          input.httpStatus ?? null,
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
    case "markOrphanedOnStartup":
      return await withClient(async client => {
        const now = new Date().toISOString();
        const expiresAt = new Date(Date.now() + workerData.retentionMs).toISOString();
        await client.query("BEGIN");
        try {
          const rows = await client.query(
            "SELECT id, correlation_id, started_at, stdout, stderr, exit_code, transport, http_status FROM jobs WHERE status = 'running'"
          );
          const update = await client.query(
            `UPDATE jobs
             SET status = 'orphaned',
                 error = COALESCE(error, 'Gateway restarted while job was running'),
                 finished_at = COALESCE(finished_at, $1),
                 expires_at = $2
             WHERE status = 'running'`,
            [now, expiresAt]
          );
          await client.query("COMMIT");
          return { count: update.rowCount ?? 0, orphaned: rows.rows };
        } catch (error: unknown) {
          await client.query("ROLLBACK");
          throw error;
        }
      });
    case "evictExpired": {
      const result = await getPool().query("DELETE FROM jobs WHERE expires_at < $1", [
        new Date().toISOString(),
      ]);
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
    case "setValidationJudgeLink": {
      const [validationId, judgeLink] = args;
      await withClient(async client => {
        await client.query("BEGIN");
        try {
          await client.query(
            "UPDATE validation_runs SET judge_link = $2 WHERE validation_id = $1",
            [validationId, JSON.stringify(judgeLink)]
          );
          await client.query(
            `INSERT INTO validation_run_jobs (job_id, validation_id, role)
             VALUES ($1, $2, 'judge')
             ON CONFLICT (job_id) DO NOTHING`,
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
