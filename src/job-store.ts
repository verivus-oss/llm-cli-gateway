import { chmodSync } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { openDatabase } from "./sqlite-driver.js";
import type { GatewayDatabase, GatewayStatement } from "./sqlite-driver.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type { PersistenceConfig } from "./config.js";

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
  /** F3: ownership principal that created the job (null for legacy rows). */
  ownerPrincipal: string | null;
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
    ownerPrincipal: row.owner_principal ?? null,
  };
}

/**
 * F3: idempotent add of the `owner_principal` column to a pre-existing jobs
 * table (fresh tables already include it via CREATE TABLE). Safe to call on
 * every open; ALTER is skipped when the column already exists.
 */
function ensureJobsOwnerColumn(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const hasOwner = cols.some(col => col?.name === "owner_principal");
  if (!hasOwner) {
    db.exec("ALTER TABLE jobs ADD COLUMN owner_principal TEXT");
  }
}

/**
 * Public surface every backend (sqlite/postgres/memory) must implement. The
 * AsyncJobManager talks to this interface only.
 */
export interface JobStore {
  recordStart(input: {
    id: string;
    correlationId: string;
    requestKey: string;
    cli: string;
    args: string[];
    outputFormat?: string;
    startedAt: string;
    pid: number | null;
    ownerPrincipal?: string | null;
  }): void;
  recordOutput(id: string, stdout: string, stderr: string, outputTruncated: boolean): void;
  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    finishedAt: string;
  }): void;
  getById(id: string): JobRecord | null;
  findByRequestKey(requestKey: string): JobRecord | null;
  /**
   * Flip every `status='running'` row to `'orphaned'` at gateway boot.
   *
   * Returns the row count AND a snapshot of every row that was flipped, so
   * AsyncJobManager can write a flight-recorder logComplete with the full
   * sync-helper-equivalent payload (response from stderr||stdout,
   * durationMs from startedAt). Pre-slice-1.5 rows that never wrote a
   * logStart degrade silently to a no-op UPDATE inside the FR.
   */
  markOrphanedOnStartup(): {
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  };
  evictExpired(): number;
  close(): void;
}

/**
 * Per-orphan snapshot returned by `markOrphanedOnStartup` so the
 * AsyncJobManager constructor can build a faithful FlightLogResult for
 * each row it flipped.
 */
export interface OrphanedJobSnapshot {
  id: string;
  correlationId: string;
  startedAt: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * SQLite-backed job store. Default backend for production. Durable across
 * gateway restarts; safe for single-instance deployments.
 */
export class SqliteJobStore implements JobStore {
  private db: GatewayDatabase;
  private retentionMs: number;
  private dedupWindowMs: number;

  private insertStmt: GatewayStatement;
  private updateOutputStmt: GatewayStatement;
  private updateCompleteStmt: GatewayStatement;
  private getByIdStmt: GatewayStatement;
  private findByRequestKeyStmt: GatewayStatement;
  private selectRunningOrphansStmt: GatewayStatement;
  private markOrphanedStmt: GatewayStatement;
  private deleteExpiredStmt: GatewayStatement;

  constructor(
    dbPath: string,
    private logger: Logger = noopLogger,
    options: { retentionMs?: number; dedupWindowMs?: number } = {}
  ) {
    // openDatabase owns parent-directory creation (mkdirSync recursive), so the
    // job store no longer does its own mkdir. Any open/DDL failure throws to
    // the caller (createJobStore), matching the prior require/open behaviour.
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");

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
        expires_at TEXT NOT NULL,
        owner_principal TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_request_key ON jobs(request_key);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
      CREATE INDEX IF NOT EXISTS idx_jobs_request_key_finished ON jobs(request_key, finished_at);
    `);

    // F3: idempotent migration — add owner_principal to a pre-existing jobs
    // table. Legacy rows keep NULL (treated as legacy-unowned by enforcement).
    ensureJobsOwnerColumn(this.db);

    if (process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }

    this.retentionMs = options.retentionMs ?? resolveJobRetentionMs();
    this.dedupWindowMs = options.dedupWindowMs ?? resolveDedupWindowMs();

    this.insertStmt = this.db.prepare(`
      INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                        status, exit_code, stdout, stderr, output_truncated, error,
                        started_at, finished_at, pid, expires_at, owner_principal)
      VALUES (@id, @correlation_id, @request_key, @cli, @args_json, @output_format,
              @status, @exit_code, @stdout, @stderr, @output_truncated, @error,
              @started_at, @finished_at, @pid, @expires_at, @owner_principal)
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

    // Snapshot every in-flight row's audit data BEFORE the orphan-flip
    // UPDATE so AsyncJobManager can construct a full FlightLogResult per
    // orphan. No transaction wrapper required: gateway boot is
    // single-threaded before any new jobs can arrive, so no
    // status='running' row can be inserted between this SELECT and the
    // UPDATE below.
    this.selectRunningOrphansStmt = this.db.prepare(`
      SELECT id, correlation_id, started_at, stdout, stderr, exit_code
      FROM jobs WHERE status = 'running'
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
    ownerPrincipal?: string | null;
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
      error: null,
      output_truncated: 0,
      started_at: input.startedAt,
      finished_at: null,
      pid: input.pid,
      // Running jobs never expire — only completed/failed/canceled do.
      expires_at: FAR_FUTURE_ISO,
      owner_principal: input.ownerPrincipal ?? null,
    });
  }

  /**
   * Batched output flush. Cheap to call repeatedly; node:sqlite is sync.
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
   *
   * Returns the row count + a per-orphan snapshot so AsyncJobManager can
   * write a flight-recorder logComplete with proper audit data
   * (durationMs from startedAt, response from stderr||stdout).
   */
  markOrphanedOnStartup(): {
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  } {
    const now = new Date().toISOString();
    // Orphaned jobs retain a short window so callers can collect the partial output,
    // then evict. Reuse the standard retention.
    const expiresAt = new Date(Date.now() + this.retentionMs).toISOString();
    // SELECT before UPDATE — gateway boot is single-threaded so no row can
    // appear in 'running' between the two statements.
    const rows = this.selectRunningOrphansStmt.all() as Array<{
      id: string;
      correlation_id: string;
      started_at: string;
      stdout: string | null;
      stderr: string | null;
      exit_code: number | null;
    }>;
    const orphaned: OrphanedJobSnapshot[] = rows.map(row => ({
      id: row.id,
      correlationId: row.correlation_id,
      startedAt: row.started_at,
      stdout: row.stdout ?? "",
      stderr: row.stderr ?? "",
      exitCode: row.exit_code,
    }));
    const result = this.markOrphanedStmt.run(now, expiresAt);
    return { count: Number(result.changes), orphaned };
  }

  /**
   * Delete rows whose expires_at has passed. Returns number of rows deleted.
   */
  evictExpired(): number {
    const now = new Date().toISOString();
    const result = this.deleteExpiredStmt.run(now);
    return Number(result.changes);
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      this.logger.error("SqliteJobStore close failed", err);
    }
  }
}

/**
 * Backwards-compatibility alias. Older code and tests construct `new JobStore(path)`
 * directly; that surface now resolves to the SQLite implementation. Prefer
 * `createJobStore(config)` in new code.
 *
 * @deprecated Use `SqliteJobStore` directly, or `createJobStore(persistenceConfig)`.
 */
export const JobStoreClass = SqliteJobStore;

/**
 * In-process job store. Same semantics as SqliteJobStore but state lives in a
 * Map and is lost on process exit. Use for tests and ephemeral/CI gateways
 * that have explicitly acknowledged the trade-off via
 * `[persistence].acknowledgeEphemeral = true`.
 */
export class MemoryJobStore implements JobStore {
  private rows = new Map<string, JobRecord>();
  private retentionMs: number;
  private dedupWindowMs: number;

  constructor(options: { retentionMs?: number; dedupWindowMs?: number } = {}) {
    this.retentionMs = options.retentionMs ?? resolveJobRetentionMs();
    this.dedupWindowMs = options.dedupWindowMs ?? resolveDedupWindowMs();
  }

  recordStart(input: {
    id: string;
    correlationId: string;
    requestKey: string;
    cli: string;
    args: string[];
    outputFormat?: string;
    startedAt: string;
    pid: number | null;
    ownerPrincipal?: string | null;
  }): void {
    this.rows.set(input.id, {
      id: input.id,
      correlationId: input.correlationId,
      requestKey: input.requestKey,
      cli: input.cli,
      argsJson: JSON.stringify(input.args),
      outputFormat: input.outputFormat ?? null,
      status: "running",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      error: null,
      startedAt: input.startedAt,
      finishedAt: null,
      pid: input.pid,
      expiresAt: FAR_FUTURE_ISO,
      ownerPrincipal: input.ownerPrincipal ?? null,
    });
  }

  recordOutput(id: string, stdout: string, stderr: string, outputTruncated: boolean): void {
    const row = this.rows.get(id);
    if (!row) return;
    row.stdout = stdout;
    row.stderr = stderr;
    row.outputTruncated = outputTruncated;
  }

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
    const row = this.rows.get(input.id);
    if (!row) return;
    row.status = input.status;
    row.exitCode = input.exitCode;
    row.stdout = input.stdout;
    row.stderr = input.stderr;
    row.outputTruncated = input.outputTruncated;
    row.error = input.error;
    row.finishedAt = input.finishedAt;
    row.expiresAt = new Date(Date.parse(input.finishedAt) + this.retentionMs).toISOString();
  }

  getById(id: string): JobRecord | null {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  findByRequestKey(requestKey: string): JobRecord | null {
    const cutoffMs = Date.now() - this.dedupWindowMs;
    let best: JobRecord | null = null;
    for (const row of this.rows.values()) {
      if (row.requestKey !== requestKey) continue;
      if (row.status !== "running" && row.status !== "completed") continue;
      if (Date.parse(row.startedAt) < cutoffMs) continue;
      if (!best || Date.parse(row.startedAt) > Date.parse(best.startedAt)) {
        best = row;
      }
    }
    return best ? { ...best } : null;
  }

  /**
   * In-memory stores have no cross-process state, so any "running" rows here
   * came from this very process and aren't actually orphaned. No-op.
   */
  markOrphanedOnStartup(): {
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  } {
    return { count: 0, orphaned: [] };
  }

  evictExpired(): number {
    const nowIso = new Date().toISOString();
    let removed = 0;
    for (const [id, row] of this.rows) {
      if (row.expiresAt < nowIso) {
        this.rows.delete(id);
        removed++;
      }
    }
    return removed;
  }

  close(): void {
    this.rows.clear();
  }
}

/**
 * Stub for the planned Postgres backend. The interface and config surface ship
 * now so multi-instance deployments can plan around them, but the
 * implementation is intentionally not yet provided — calling code must select
 * `sqlite` or `memory` until a real impl lands.
 */
export class PostgresJobStore implements JobStore {
  constructor(_dsn: string, _logger: Logger = noopLogger) {
    throw new Error(
      "PostgresJobStore is not yet implemented. Use backend = 'sqlite' (single-instance) or " +
        "backend = 'memory' (ephemeral) until the Postgres backend ships."
    );
  }
  recordStart(): void {
    throw new Error("not implemented");
  }
  recordOutput(): void {
    throw new Error("not implemented");
  }
  recordComplete(): void {
    throw new Error("not implemented");
  }
  getById(): JobRecord | null {
    throw new Error("not implemented");
  }
  findByRequestKey(): JobRecord | null {
    throw new Error("not implemented");
  }
  markOrphanedOnStartup(): {
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  } {
    throw new Error("not implemented");
  }
  evictExpired(): number {
    throw new Error("not implemented");
  }
  close(): void {
    /* no-op */
  }
}

/**
 * Construct the JobStore appropriate to the resolved PersistenceConfig.
 * Returns `null` when `backend = "none"` — callers must not register
 * `*_request_async` tools in that case (use `config.asyncJobsEnabled`).
 */
export function createJobStore(
  config: PersistenceConfig,
  logger: Logger = noopLogger
): JobStore | null {
  const opts = {
    retentionMs: config.retentionDays * 24 * 60 * 60 * 1000,
    dedupWindowMs: config.dedupWindowMs,
  };
  switch (config.backend) {
    case "none":
      return null;
    case "memory":
      return new MemoryJobStore(opts);
    case "postgres":
      // Throws today; design surface is honest so callers can react.
      return new PostgresJobStore(config.dsn ?? "", logger);
    case "sqlite":
    default:
      if (!config.path) {
        throw new Error("SqliteJobStore requires a non-empty path");
      }
      return new SqliteJobStore(config.path, logger, opts);
  }
}
