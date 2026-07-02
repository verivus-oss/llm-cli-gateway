import { writeFileSync } from "node:fs";
import { parentPort, workerData } from "node:worker_threads";

import type { Pool, PoolClient } from "pg";

let pool: Pool | null = null;

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
  });
  await getPool().query("SELECT 1");
  await getPool().query(`
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
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_request_key ON jobs(request_key);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_request_key_finished ON jobs(request_key, finished_at);

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
  await getPool().query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_principal TEXT");
  await getPool().query(
    "ALTER TABLE jobs ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'process'"
  );
  await getPool().query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS http_status INTEGER");
  await getPool().query("ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload_json TEXT");
}

async function op(method: string, args: any[]): Promise<unknown> {
  switch (method) {
    case "init":
      await init();
      return null;
    case "recordStart": {
      const input = args[0];
      await getPool().query(
        `INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                           status, exit_code, stdout, stderr, output_truncated, error,
                           started_at, finished_at, pid, expires_at, owner_principal,
                           transport, http_status, payload_json)
         VALUES ($1, $2, $3, $4, $5, $6, 'running', NULL, '', '', FALSE, NULL,
                 $7, NULL, $8, $9, $10, $11, NULL, $12)`,
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
        ]
      );
      return null;
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
      await getPool().query(
        `UPDATE jobs
         SET status = $2, exit_code = $3, stdout = $4, stderr = $5,
             output_truncated = $6, error = $7, finished_at = $8,
             expires_at = $9, http_status = $10
         WHERE id = $1`,
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
      const result = await getPool().query(
        `SELECT * FROM jobs
         WHERE request_key = $1
           AND started_at >= $2
           AND status IN ('running', 'completed')
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
    resultPath: string;
    shared: SharedArrayBuffer;
  }) => {
    const { method, args, resultPath, shared } = message;
    let payload;
    try {
      payload = ok(await op(method, args));
    } catch (error: unknown) {
      payload = fail(error);
    }
    try {
      writeFileSync(resultPath, JSON.stringify(payload));
      signal(shared, 1);
    } catch {
      signal(shared, 2);
    }
  }
);
