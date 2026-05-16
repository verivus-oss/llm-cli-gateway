import { chmodSync, existsSync, mkdirSync } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { createRequire } from "module";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";

export type JobStoreStatus = "running" | "completed" | "failed" | "canceled" | "orphaned";

export interface JobRecord {
  id: string;
  correlationId: string;
  requestKey: string;
  cli: string;
  argsJson: string;
  outputFormat?: string | null;
  status: JobStoreStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  pid: number | null;
  expiresAt: string;
}

interface StatementLike {
  run: (...args: any[]) => any;
  get: (...args: any[]) => any;
  all: (...args: any[]) => any[];
}

interface DatabaseLike {
  pragma: (query: string) => any;
  exec: (sql: string) => void;
  prepare: (sql: string) => StatementLike;
  close: () => void;
}

export function resolveJobStoreDbPath(): string | null {
  const configured = process.env.LLM_GATEWAY_JOBS_DB ?? process.env.LLM_GATEWAY_LOGS_DB;
  if (configured !== undefined) {
    const normalized = configured.trim().toLowerCase();
    if (!normalized || normalized === "none") {
      return null;
    }
    return configured.trim();
  }
  return path.join(os.homedir(), ".llm-cli-gateway", "logs.db");
}

const DEFAULT_RETENTION_DAYS = 30;
const FAR_FUTURE_ISO = "9999-12-31T23:59:59.999Z";

export function resolveJobRetentionMs(): number {
  const raw = process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
  const days = raw ? Number(raw) : DEFAULT_RETENTION_DAYS;
  if (!Number.isFinite(days) || days <= 0) {
    return DEFAULT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  }
  return days * 24 * 60 * 60 * 1000;
}

const DEFAULT_DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

export function resolveDedupWindowMs(): number {
  const raw = process.env.LLM_GATEWAY_DEDUP_WINDOW_MS;
  if (raw === undefined) return DEFAULT_DEDUP_WINDOW_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_DEDUP_WINDOW_MS;
  return n;
}

export function computeRequestKey(cli: string, args: string[], extra?: string): string {
  const payload = JSON.stringify({ cli, args, extra: extra ?? "" });
  return createHash("sha256").update(payload).digest("hex");
}

function rowToRecord(row: any): JobRecord {
  return {
    id: row.id,
    correlationId: row.correlation_id,
    requestKey: row.request_key,
    cli: row.cli,
    argsJson: row.args_json,
    outputFormat: row.output_format ?? null,
    status: row.status as JobStoreStatus,
    exitCode: row.exit_code,
    stdout: row.stdout ?? "",
    stderr: row.stderr ?? "",
    outputTruncated: Boolean(row.output_truncated),
    error: row.error ?? null,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pid: row.pid,
    expiresAt: row.expires_at,
  };
}

export class JobStore {
  private db: DatabaseLike;
  private retentionMs: number;
  private dedupWindowMs: number;

  private insertStmt: StatementLike;
  private updateOutputStmt: StatementLike;
  private updateCompleteStmt: StatementLike;
  private getByIdStmt: StatementLike;
  private findByRequestKeyStmt: StatementLike;
  private markOrphanedStmt: StatementLike;
  private deleteExpiredStmt: StatementLike;

  constructor(
    dbPath: string,
    private logger: Logger = noopLogger
  ) {
    const require = createRequire(import.meta.url);
    const BetterSqlite3 = require("better-sqlite3");

    const directory = path.dirname(dbPath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    this.db = new BetterSqlite3(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");

    this.db.exec(`
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
        output_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        pid INTEGER,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_request_key ON jobs(request_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_request_key_finished ON jobs(request_key, finished_at);
    `);

    if (process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }

    this.retentionMs = resolveJobRetentionMs();
    this.dedupWindowMs = resolveDedupWindowMs();

    this.insertStmt = this.db.prepare(`
      INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                        status, exit_code, stdout, stderr, output_truncated, error,
                        started_at, finished_at, pid, expires_at)
      VALUES (@id, @correlation_id, @request_key, @cli, @args_json, @output_format,
              @status, @exit_code, @stdout, @stderr, @output_truncated, @error,
              @started_at, @finished_at, @pid, @expires_at)
    `);

    this.updateOutputStmt = this.db.prepare(`
      UPDATE jobs SET stdout = @stdout, stderr = @stderr, output_truncated = @output_truncated
      WHERE id = @id
    `);

    this.updateCompleteStmt = this.db.prepare(`
      UPDATE jobs SET status = @status, exit_code = @exit_code, stdout = @stdout, stderr = @stderr,
                      output_truncated = @output_truncated, error = @error,
                      finished_at = @finished_at, expires_at = @expires_at
      WHERE id = @id
    `);

    this.getByIdStmt = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`);

    // Dedup query: most recent non-orphaned job with matching request_key, started within window.
    // Exclude orphaned/canceled/failed-with-error from dedup so a broken run isn't reused.
    this.findByRequestKeyStmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE request_key = ?
        AND started_at >= ?
        AND status IN ('running', 'completed')
      ORDER BY started_at DESC
      LIMIT 1
    `);

    this.markOrphanedStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'orphaned',
          error = COALESCE(error, 'Gateway restarted while job was running'),
          finished_at = COALESCE(finished_at, ?),
          expires_at = ?
      WHERE status = 'running'
    `);

    this.deleteExpiredStmt = this.db.prepare(`DELETE FROM jobs WHERE expires_at < ?`);
  }

  /**
   * Insert a new running job row. Caller has already computed requestKey.
   */
  recordStart(input: {
    id: string;
    correlationId: string;
    requestKey: string;
    cli: string;
    args: string[];
    outputFormat?: string;
    startedAt: string;
    pid: number | null;
  }): void {
    this.insertStmt.run({
      id: input.id,
      correlation_id: input.correlationId,
      request_key: input.requestKey,
      cli: input.cli,
      args_json: JSON.stringify(input.args),
      output_format: input.outputFormat ?? null,
      status: "running",
      exit_code: null,
      stdout: "",
      stderr: "",
      output_truncated: 0,
      error: null,
      started_at: input.startedAt,
      finished_at: null,
      pid: input.pid,
      // Running jobs never expire — only completed/failed/canceled do.
      expires_at: FAR_FUTURE_ISO,
    });
  }

  /**
   * Batched output flush. Cheap to call repeatedly; better-sqlite3 is sync.
   */
  recordOutput(id: string, stdout: string, stderr: string, outputTruncated: boolean): void {
    this.updateOutputStmt.run({
      id,
      stdout,
      stderr,
      output_truncated: outputTruncated ? 1 : 0,
    });
  }

  /**
   * Mark a job as completed/failed/canceled. Sets expires_at = now + retention.
   */
  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    finishedAt: string;
  }): void {
    const expiresAt = new Date(Date.parse(input.finishedAt) + this.retentionMs).toISOString();
    this.updateCompleteStmt.run({
      id: input.id,
      status: input.status,
      exit_code: input.exitCode,
      stdout: input.stdout,
      stderr: input.stderr,
      output_truncated: input.outputTruncated ? 1 : 0,
      error: input.error,
      finished_at: input.finishedAt,
      expires_at: expiresAt,
    });
  }

  getById(id: string): JobRecord | null {
    const row = this.getByIdStmt.get(id);
    return row ? rowToRecord(row) : null;
  }

  /**
   * Returns the most recent matching job within the dedup window, if any.
   * Caller pre-filters out forceRefresh requests.
   */
  findByRequestKey(requestKey: string): JobRecord | null {
    const cutoff = new Date(Date.now() - this.dedupWindowMs).toISOString();
    const row = this.findByRequestKeyStmt.get(requestKey, cutoff);
    return row ? rowToRecord(row) : null;
  }

  /**
   * On gateway boot, flip any jobs that were 'running' to 'orphaned'.
   * The child processes were detached but can't be reattached to in this process.
   */
  markOrphanedOnStartup(): number {
    const now = new Date().toISOString();
    // Orphaned jobs retain a short window so callers can fetch the partial output,
    // then evict. Reuse the standard retention.
    const expiresAt = new Date(Date.now() + this.retentionMs).toISOString();
    const result: any = this.markOrphanedStmt.run(now, expiresAt);
    return result?.changes ?? 0;
  }

  /**
   * Delete rows whose expires_at has passed. Returns number of rows deleted.
   */
  evictExpired(): number {
    const now = new Date().toISOString();
    const result: any = this.deleteExpiredStmt.run(now);
    return result?.changes ?? 0;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      this.logger.error("JobStore close failed", err);
    }
  }
}
