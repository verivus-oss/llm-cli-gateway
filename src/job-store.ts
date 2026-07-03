import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { openDatabase } from "./sqlite-driver.js";
import type { GatewayDatabase, GatewayStatement } from "./sqlite-driver.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type { PersistenceConfig } from "./config.js";
import { DEFAULT_INSTANCE_LEASE_TTL_MS, DEFAULT_HTTP_JOB_GRACE_MS } from "./config.js";

// #139: `queued` is now a durable status. A job is persisted `queued` at
// recordStart (owner stamped, no pid yet) and transitions to `running` at
// launch via markRunning. Terminal statuses stay as before. Because `queued`
// is now representable, `recordComplete` must exclude BOTH `running` and
// `queued` (neither is terminal), and the durable sweep targets
// `('queued','running')`.
export type JobStoreStatus =
  "queued" | "running" | "completed" | "failed" | "canceled" | "orphaned";

/** #139: the two non-terminal durable statuses the lease sweep considers. */
export type JobStoreActiveStatus = Extract<JobStoreStatus, "queued" | "running">;

/** Slice 1: how a job executes — a spawned CLI subprocess, or an HTTP request. */
export type JobTransport = "process" | "http";

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
  /** Slice 1: 'process' (default, legacy rows) or 'http' for API-provider jobs. */
  transport: JobTransport;
  /** Slice 1: real HTTP status for http jobs; null for process jobs. Never overloads exitCode. */
  httpStatus: number | null;
  /**
   * Slice 1: canonical API request JSON for http jobs (argv is meaningless for
   * them). Null for process jobs, whose argv lives in `argsJson`.
   */
  payloadJson: string | null;
  /**
   * #139: the gateway instance that owns this job (null for legacy pre-migration
   * rows). Stamped at recordStart. The sweep does NOT read it for the liveness
   * decision (that is `leaseDeadline`); it is retained for observability and so
   * the owner's heartbeat can scope its lease-advancing UPDATE.
   */
  ownerInstance: string | null;
  /**
   * #139: the per-job fencing lease deadline as epoch milliseconds (DB-clock).
   * The owner's heartbeat advances it to `db_now + leaseTtl`; the sweep orphans
   * a `queued`/`running` row whose `leaseDeadline < db_now` (or IS NULL for a
   * legacy row). Null only for terminal rows and legacy pre-migration rows; a
   * live row always has it set in the same write as recordStart/markRunning.
   */
  leaseDeadline: number | null;
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

/**
 * #139: the sqlite DB-clock expressed as epoch milliseconds. Used inline in the
 * lease/sweep SQL so the fencing comparison NEVER depends on the client's
 * `new Date()` (a skewed client clock must not mislabel a live job as expired).
 * `julianday('now')` is available on every SQLite version; the constant offset
 * 2440587.5 is the Julian Day Number of the Unix epoch.
 */
const SQLITE_NOW_MS = "CAST(ROUND((julianday('now') - 2440587.5) * 86400000.0) AS INTEGER)";

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
    transport: (row.transport as JobTransport) ?? "process",
    httpStatus: row.http_status ?? null,
    payloadJson: row.payload_json ?? null,
    ownerInstance: row.owner_instance ?? null,
    // sqlite returns lease_deadline as a number; node-pg returns BIGINT as a
    // string. Coerce to number|null so JobRecord.leaseDeadline is uniform.
    leaseDeadline: row.lease_deadline == null ? null : Number(row.lease_deadline),
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
 * Slice 1: idempotent migration adding the http-transport columns to a
 * pre-existing jobs table. Legacy rows backfill `transport='process'` (the
 * column DEFAULT); `http_status`/`payload_json` stay NULL. MUST run before any
 * prepared statement is compiled — the INSERT/UPDATE column lists bind at
 * prepare time.
 */
function ensureJobsTransportColumns(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("transport")) {
    db.exec("ALTER TABLE jobs ADD COLUMN transport TEXT NOT NULL DEFAULT 'process'");
  }
  if (!names.has("http_status")) {
    db.exec("ALTER TABLE jobs ADD COLUMN http_status INTEGER");
  }
  if (!names.has("payload_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN payload_json TEXT");
  }
}

/**
 * #139: idempotent migration adding the durable-lease columns to a pre-existing
 * jobs table. `owner_instance` records the owning gateway instance; the
 * `lease_deadline` fencing column (epoch ms, DB-clock) is what the sweep checks.
 * Legacy rows backfill both to NULL: a NULL `lease_deadline` on a `running` row
 * predates the lease and is treated as an expired lease by the sweep (orphaned),
 * which is correct because those rows are genuinely stale (they survived a
 * restart). MUST run before the prepared statements below compile.
 */
function ensureJobsLeaseColumns(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("owner_instance")) {
    db.exec("ALTER TABLE jobs ADD COLUMN owner_instance TEXT");
  }
  if (!names.has("lease_deadline")) {
    db.exec("ALTER TABLE jobs ADD COLUMN lease_deadline INTEGER");
  }
}

/**
 * #139: registration metadata for a live gateway instance. Written to
 * `gateway_instances` at construction (before the manager can admit any job).
 * Retained for observability / GC / role only; the sweep does NOT read it for
 * the liveness decision (that is the per-job `lease_deadline`).
 */
export interface GatewayInstanceMeta {
  instanceId: string;
  role: string | null;
  hostname: string | null;
  pid: number | null;
}

/**
 * #139: an expired process-transport sweep candidate the manager may probe with
 * an advisory `kill(pid,0)` before the terminal orphan write. `hostname` is the
 * OWNING instance's hostname (LEFT JOINed from `gateway_instances`) so the
 * manager only pid-checks same-host candidates; a foreign-host or unknown-host
 * candidate falls straight through to orphaning. This candidate read is NOT the
 * fencing decision (that stays purely `lease_deadline < db_now` on the job row);
 * it only scopes an advisory, never-vetoing grace.
 */
export interface SweepCandidate {
  id: string;
  pid: number | null;
  transport: JobTransport;
  ownerInstance: string | null;
  hostname: string | null;
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
    /** #139: the gateway instance that owns this job (stamped at enqueue). */
    ownerInstance?: string | null;
    /** Slice 1: defaults to 'process'. */
    transport?: JobTransport;
    /** Slice 1: canonical API request JSON for http jobs (null/undefined for process). */
    payloadJson?: string | null;
  }): void;
  /**
   * #139: transition a durable `queued` row to `running`, stamp the real child
   * pid (process transport; null for http), and re-set the lease. Returns true
   * iff a queued row actually transitioned; false means the row was no longer
   * `queued` (e.g. already swept to `orphaned` while it waited in the limiter
   * queue), which the caller uses to fail-close a process launch.
   */
  markRunning(id: string, opts: { pid: number | null }): boolean;
  /** #139: register this live instance (writes last_heartbeat = DB now). */
  registerInstance(meta: GatewayInstanceMeta): void;
  /**
   * #139: advance this instance's own lease. Updates `last_heartbeat` on the
   * instance row AND `lease_deadline = db_now + leaseTtl` for every
   * `queued`/`running` job it owns, so heartbeat and sweep contend on the same
   * job rows.
   */
  heartbeat(instanceId: string): void;
  /** #139: remove this instance's `gateway_instances` row (graceful shutdown). */
  deregisterInstance(instanceId: string): void;
  /**
   * #139: expired process-transport candidates (non-null pid) for the advisory
   * `kill(pid,0)` check. Read-only; does not mutate any row.
   */
  selectStaleProcessCandidates(leaseTtlMs: number, httpJobGraceMs: number): SweepCandidate[];
  /**
   * #139: the fencing sweep. In one atomic unit: (a) advance the lease by one
   * `leaseTtlMs` for every id in `liveConfirmedIds` (the manager's advisory
   * pid-alive grace), then (b) orphan every remaining `queued`/`running` row
   * whose `lease_deadline` has expired (or is NULL, for legacy rows), with the
   * http grace applied IN the candidate predicate. Returns a snapshot of every
   * orphaned row so the manager can emit flight-recorder completions. The sweep
   * never reads `gateway_instances`.
   */
  recoverStaleJobs(
    leaseTtlMs: number,
    httpJobGraceMs: number,
    liveConfirmedIds?: string[]
  ): OrphanedJobSnapshot[];
  /** #139: delete `gateway_instances` rows whose last_heartbeat is older than instanceGcMs. */
  gcInstances(instanceGcMs: number): number;
  recordOutput(id: string, stdout: string, stderr: string, outputTruncated: boolean): void;
  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    finishedAt: string;
    /** Slice 1: real HTTP status for http jobs; null for process jobs. */
    httpStatus?: number | null;
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
  /** Slice 1: so a force-orphaned http row produces a faithful flight-recorder complete. */
  transport: JobTransport;
  httpStatus: number | null;
}

/**
 * Cross-LLM validation receipts (Phase 0): a link from a validation run to one
 * provider (or judge) job that carries its actual output.
 */
export interface ValidationRunLink {
  provider: string;
  jobId: string;
  correlationId: string;
}

/**
 * Durable record of a cross-LLM validation run, keyed by `validationId`. This is
 * the mapping the receipt feature needs: `validationId` did not previously
 * survive the transient kickoff response. Written once at kickoff; `status` and
 * `judgeLink` mutate as the run reaches its terminal state.
 */
export interface ValidationRunRecord {
  validationId: string;
  ownerPrincipal: string;
  intent: string;
  createdAt: string;
  /** Owner-scoped serialized request (question/content/focus/riskLevel/modelList/judge plan). */
  requestJson: string;
  providerLinks: ValidationRunLink[];
  judgeLink: ValidationRunLink | null;
  status: "running" | "finalized";
}

/**
 * Cross-LLM validation receipts (Phase 1): the immutable, owner-scoped receipt of
 * a terminal validation run, enveloping the captured `validation-report.v1`
 * structuredContent. One row per terminal run; written once, never updated.
 */
export interface ValidationReceiptRecord {
  validationId: string;
  ownerPrincipal: string;
  mintedAt: string;
  schemaVersion: string;
  /** The captured `validation-report.v1` structuredContent, serialized. Immutable. */
  reportJson: string;
  /** SHA-256 over the canonical serialization of reportJson. */
  canonicalSha256: string;
  /** Reserved for hash chaining; NULL in v1. */
  prevSha256: string | null;
  /** Reserved for hash chaining; NULL in v1. */
  seq: number | null;
  /** Reserved for signing; NULL in v1. */
  signature: string | null;
  /** Denormalized for querying. */
  models: string[];
  hasMaterialDisagreement: boolean;
  confidence: string;
}

/**
 * The validation-run + receipt persistence surface. Only actually-durable
 * backends provide it (`SqliteJobStore` and `PostgresJobStore`). `MemoryJobStore`
 * deliberately does NOT implement it, so under the ephemeral backend no
 * run/receipt row is ever written: the durability gate is enforced by the
 * absence of this capability, not a flag.
 */
export interface ValidationRunStore {
  /** Insert the run row once at kickoff. Idempotent on validation_id (INSERT OR IGNORE). */
  recordValidationRun(run: ValidationRunRecord): void;
  getValidationRun(validationId: string): ValidationRunRecord | null;
  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): void;
  setValidationRunStatus(validationId: string, status: ValidationRunRecord["status"]): void;
  /** Reverse lookup for eager mint: which run owns this provider/judge job, if any. */
  getValidationRunIdByJobId(jobId: string): string | null;
  /** Insert the immutable receipt once. Idempotent on validation_id (INSERT OR IGNORE). */
  recordValidationReceipt(receipt: ValidationReceiptRecord): void;
  getValidationReceipt(validationId: string): ValidationReceiptRecord | null;
}

/** True when a job store also persists validation runs (only SqliteJobStore today). */
export function isValidationRunStore(store: unknown): store is ValidationRunStore {
  return (
    typeof store === "object" &&
    store !== null &&
    typeof (store as ValidationRunStore).recordValidationRun === "function" &&
    typeof (store as ValidationRunStore).getValidationRun === "function" &&
    typeof (store as ValidationRunStore).recordValidationReceipt === "function"
  );
}

/**
 * SQLite-backed job store. Default backend for production. Durable across
 * gateway restarts; safe for single-instance deployments.
 */
export class SqliteJobStore implements JobStore, ValidationRunStore {
  private db: GatewayDatabase;
  private retentionMs: number;
  private dedupWindowMs: number;
  /** #139: initial lease TTL used by recordStart/markRunning/heartbeat (ms). */
  private leaseTtlMs: number;

  private insertStmt: GatewayStatement;
  private updateOutputStmt: GatewayStatement;
  private updateCompleteStmt: GatewayStatement;
  private getByIdStmt: GatewayStatement;
  private findByRequestKeyStmt: GatewayStatement;
  private selectRunningOrphansStmt: GatewayStatement;
  private markOrphanedStmt: GatewayStatement;
  private deleteExpiredStmt: GatewayStatement;
  // #139 lease surface.
  private markRunningStmt: GatewayStatement;
  private registerInstanceStmt: GatewayStatement;
  private heartbeatInstanceStmt: GatewayStatement;
  private heartbeatJobsStmt: GatewayStatement;
  private deregisterInstanceStmt: GatewayStatement;
  private selectStaleCandidatesStmt: GatewayStatement;
  private orphanExpiredStmt: GatewayStatement;
  private advanceLeaseStmt: GatewayStatement;
  private gcInstancesStmt: GatewayStatement;

  constructor(
    dbPath: string,
    private logger: Logger = noopLogger,
    options: { retentionMs?: number; dedupWindowMs?: number; leaseTtlMs?: number } = {}
  ) {
    // openDatabase owns parent-directory creation (mkdirSync recursive), so the
    // job store no longer does its own mkdir. Any open/DDL failure throws to
    // the caller (createJobStore), matching the prior require/open behaviour.
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    // #139: a shared-file sqlite DB (multiple gateway processes on one host) can
    // now have a heartbeat UPDATE and a sweep UPDATE contend for the write lock.
    // busy_timeout makes a blocked writer wait rather than fail immediately with
    // SQLITE_BUSY; the store also wraps heartbeat/sweep in a SQLITE_BUSY retry.
    this.db.exec("PRAGMA busy_timeout = 5000");

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
        owner_principal TEXT,
        transport TEXT NOT NULL DEFAULT 'process',
        http_status INTEGER,
        payload_json TEXT,
        owner_instance TEXT,
        lease_deadline INTEGER
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
        started_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_instances_heartbeat
        ON gateway_instances(last_heartbeat);
    `);

    // Cross-LLM validation receipts (Phase 0): durable validation-run identity.
    // Same idempotent CREATE TABLE IF NOT EXISTS idiom as the jobs table (NOT the
    // flight recorder's versioned _migrations system). App-side ISO timestamps;
    // owner_principal indexed for owner-scoped lookups.
    this.db.exec(`
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
    `);

    // Cross-LLM validation receipts (Phase 1): reverse index (job_id -> run) for
    // eager mint when a provider/judge job result is collected, and the immutable
    // receipts table (one row per terminal run). Same idempotent idiom; receipts
    // indexed on owner_principal for owner-scoped queries.
    this.db.exec(`
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
        has_material_disagreement INTEGER NOT NULL,
        confidence TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_validation_receipts_owner ON validation_receipts(owner_principal);
    `);

    // F3: idempotent migration — add owner_principal to a pre-existing jobs
    // table. Legacy rows keep NULL (treated as legacy-unowned by enforcement).
    ensureJobsOwnerColumn(this.db);
    // Slice 1: idempotent migration for the http-transport columns. MUST run
    // before the prepared statements below bind to the column list.
    ensureJobsTransportColumns(this.db);
    // #139: idempotent migration for the durable-lease columns (owner_instance,
    // lease_deadline). Same must-run-before-prepare ordering.
    ensureJobsLeaseColumns(this.db);
    // #139: the owner/status index references owner_instance, so it can only be
    // created AFTER ensureJobsLeaseColumns adds that column to a legacy table.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status)"
    );

    if (process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }

    this.retentionMs = options.retentionMs ?? resolveJobRetentionMs();
    this.dedupWindowMs = options.dedupWindowMs ?? resolveDedupWindowMs();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_INSTANCE_LEASE_TTL_MS;

    // #139: recordStart persists status='queued' (markRunning flips it to
    // 'running' at launch) with the owner instance stamped and an initial
    // lease_deadline = db_now + leaseTtl, computed from the DB clock in the SAME
    // insert so a live row NEVER has a NULL deadline.
    this.insertStmt = this.db.prepare(`
      INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, output_format,
                        status, exit_code, stdout, stderr, output_truncated, error,
                        started_at, finished_at, pid, expires_at, owner_principal,
                        transport, http_status, payload_json, owner_instance, lease_deadline)
      VALUES (@id, @correlation_id, @request_key, @cli, @args_json, @output_format,
              'queued', @exit_code, @stdout, @stderr, @output_truncated, @error,
              @started_at, @finished_at, @pid, @expires_at, @owner_principal,
              @transport, @http_status, @payload_json, @owner_instance,
              ${SQLITE_NOW_MS} + @lease_ttl_ms)
    `);

    this.updateOutputStmt = this.db.prepare(`
      UPDATE jobs SET stdout = @stdout, stderr = @stderr, output_truncated = @output_truncated
      WHERE id = @id
    `);

    // #139: guarded completion. A terminal result may only land on a still-open
    // row (queued/running) or one a mistaken sweep marked orphaned; it is a
    // no-op on an already-terminal row (last committed terminal state wins).
    this.updateCompleteStmt = this.db.prepare(`
      UPDATE jobs SET status = @status, exit_code = @exit_code, stdout = @stdout, stderr = @stderr,
                      output_truncated = @output_truncated, error = @error,
                      finished_at = @finished_at, expires_at = @expires_at,
                      http_status = @http_status, lease_deadline = NULL
      WHERE id = @id AND status IN ('queued', 'running', 'orphaned')
    `);

    this.getByIdStmt = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`);

    // Dedup query: most recent reusable job with matching request_key, started
    // within window. Reuse a completed job, a running job, or a still-live
    // (lease-valid) queued job; NEVER an orphaned/canceled/failed row, and never
    // a queued job whose lease has expired (it is a dead pre-launch row awaiting
    // the sweep). The lease check uses the DB clock.
    this.findByRequestKeyStmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE request_key = ?
        AND started_at >= ?
        AND (
          status IN ('running', 'completed')
          OR (status = 'queued' AND lease_deadline IS NOT NULL AND lease_deadline >= ${SQLITE_NOW_MS})
        )
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
      SELECT id, correlation_id, started_at, stdout, stderr, exit_code, transport, http_status
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

    // #139 lease surface.
    // markRunning: queued -> running, stamp the real pid, re-set the lease.
    this.markRunningStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'running', pid = @pid, lease_deadline = ${SQLITE_NOW_MS} + @lease_ttl_ms
      WHERE id = @id AND status = 'queued'
    `);
    // registerInstance: upsert (a restart with a fresh instance_id inserts; the
    // same id refreshes its heartbeat). started_at/last_heartbeat = db_now.
    this.registerInstanceStmt = this.db.prepare(`
      INSERT INTO gateway_instances (instance_id, role, hostname, pid, started_at, last_heartbeat)
      VALUES (@instance_id, @role, @hostname, @pid, ${SQLITE_NOW_MS}, ${SQLITE_NOW_MS})
      ON CONFLICT(instance_id) DO UPDATE SET
        role = excluded.role, hostname = excluded.hostname, pid = excluded.pid,
        last_heartbeat = excluded.last_heartbeat
    `);
    this.heartbeatInstanceStmt = this.db.prepare(`
      UPDATE gateway_instances SET last_heartbeat = ${SQLITE_NOW_MS} WHERE instance_id = @instance_id
    `);
    // The authoritative heartbeat: advance the fencing lease for every open job
    // this instance owns, so heartbeat and sweep are same-row UPDATEs.
    this.heartbeatJobsStmt = this.db.prepare(`
      UPDATE jobs SET lease_deadline = ${SQLITE_NOW_MS} + @lease_ttl_ms
      WHERE owner_instance = @instance_id AND status IN ('queued', 'running')
    `);
    this.deregisterInstanceStmt = this.db.prepare(
      `DELETE FROM gateway_instances WHERE instance_id = @instance_id`
    );
    // Candidate read for the advisory pid check: expired process-transport rows
    // with a real pid, LEFT JOINed to the owner's hostname (for same-host
    // scoping only; the fencing decision stays on lease_deadline).
    this.selectStaleCandidatesStmt = this.db.prepare(`
      SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
             j.owner_instance AS owner_instance, gi.hostname AS hostname
      FROM jobs j
      LEFT JOIN gateway_instances gi ON gi.instance_id = j.owner_instance
      WHERE j.status IN ('queued', 'running')
        AND j.transport = 'process'
        AND j.pid IS NOT NULL
        AND (j.lease_deadline IS NULL OR j.lease_deadline < ${SQLITE_NOW_MS})
    `);
    // The fencing sweep is a SINGLE guarded UPDATE ... RETURNING (not a
    // SELECT-then-blind-flip): the orphan predicate is re-evaluated in the same
    // atomic statement that flips the row, so a heartbeat or completion that
    // lands between candidate selection and the flip can never be stomped (the
    // WHERE misses it). This mirrors the Postgres path. The http grace is IN the
    // predicate (a row is never flipped then un-flipped); db_now is the DB clock;
    // the @exclude_json guard removes advisory-live (pid-confirmed) ids. The
    // http-grace cutoff is also DB-clock: strftime with the '%f' (SS.SSS,
    // millisecond) fractional-seconds format yields exactly the toISOString shape
    // stored in started_at, so the lexical TEXT comparison is chronologically
    // correct without trusting the client clock.
    this.orphanExpiredStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'orphaned',
          error = COALESCE(error, 'owning gateway instance is no longer alive'),
          finished_at = COALESCE(finished_at, @now_iso),
          expires_at = @expires_iso,
          lease_deadline = NULL
      WHERE status IN ('queued', 'running')
        AND (lease_deadline IS NULL OR lease_deadline < ${SQLITE_NOW_MS})
        AND (transport <> 'http'
             OR started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @http_grace_modifier))
        AND id NOT IN (SELECT value FROM json_each(@exclude_json))
      RETURNING id, correlation_id, started_at, stdout, stderr, exit_code, transport, http_status
    `);
    // Advisory grace: advance the lease by ONE leaseTtl for pid-confirmed-live
    // rows AND clear the pid. Clearing the pid makes the grace strictly one-shot:
    // on the next sweep the row is no longer a process candidate (pid IS NULL),
    // so it is not re-probed and is orphaned once the extended lease lapses. This
    // bounds pid reuse to a single extra leaseTtl (it cannot strand a row).
    this.advanceLeaseStmt = this.db.prepare(`
      UPDATE jobs SET lease_deadline = ${SQLITE_NOW_MS} + @lease_ttl_ms, pid = NULL
      WHERE status IN ('queued', 'running')
        AND id IN (SELECT value FROM json_each(@ids_json))
    `);
    this.gcInstancesStmt = this.db.prepare(
      `DELETE FROM gateway_instances WHERE last_heartbeat < ${SQLITE_NOW_MS} - @gc_ms`
    );
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
    ownerInstance?: string | null;
    transport?: JobTransport;
    payloadJson?: string | null;
  }): void {
    this.insertStmt.run({
      id: input.id,
      correlation_id: input.correlationId,
      request_key: input.requestKey,
      cli: input.cli,
      args_json: JSON.stringify(input.args),
      output_format: input.outputFormat ?? null,
      // status is hard-coded 'queued' in the INSERT (see insertStmt).
      exit_code: null,
      stdout: "",
      stderr: "",
      error: null,
      output_truncated: 0,
      started_at: input.startedAt,
      finished_at: null,
      pid: input.pid,
      // queued/running jobs never expire; only completed/failed/canceled do.
      expires_at: FAR_FUTURE_ISO,
      owner_principal: input.ownerPrincipal ?? null,
      transport: input.transport ?? "process",
      http_status: null,
      payload_json: input.payloadJson ?? null,
      owner_instance: input.ownerInstance ?? null,
      lease_ttl_ms: this.leaseTtlMs,
    });
  }

  markRunning(id: string, opts: { pid: number | null }): boolean {
    // Returns true iff a queued row actually transitioned to running. A zero-row
    // result means the durable row is no longer queued (e.g. another instance
    // already swept it to 'orphaned' while it waited in the limiter queue); the
    // caller uses this to fail-close a process launch rather than run a child
    // against a recovered row.
    const result = this.markRunningStmt.run({
      id,
      pid: opts.pid,
      lease_ttl_ms: this.leaseTtlMs,
    });
    return Number(result.changes) > 0;
  }

  registerInstance(meta: GatewayInstanceMeta): void {
    this.registerInstanceStmt.run({
      instance_id: meta.instanceId,
      role: meta.role ?? null,
      hostname: meta.hostname ?? null,
      pid: meta.pid ?? null,
    });
  }

  heartbeat(instanceId: string): void {
    // Advance the observability row AND the authoritative per-job lease. The
    // job-lease UPDATE is what serializes against the sweep on the row lock.
    this.heartbeatInstanceStmt.run({ instance_id: instanceId });
    this.heartbeatJobsStmt.run({ instance_id: instanceId, lease_ttl_ms: this.leaseTtlMs });
  }

  deregisterInstance(instanceId: string): void {
    this.deregisterInstanceStmt.run({ instance_id: instanceId });
  }

  selectStaleProcessCandidates(_leaseTtlMs: number, _httpJobGraceMs: number): SweepCandidate[] {
    const rows = this.selectStaleCandidatesStmt.all() as Array<{
      id: string;
      pid: number | null;
      transport: string | null;
      owner_instance: string | null;
      hostname: string | null;
    }>;
    return rows.map(r => ({
      id: r.id,
      pid: r.pid,
      transport: (r.transport as JobTransport) ?? "process",
      ownerInstance: r.owner_instance ?? null,
      hostname: r.hostname ?? null,
    }));
  }

  recoverStaleJobs(
    leaseTtlMs: number,
    httpJobGraceMs: number,
    liveConfirmedIds: string[] = []
  ): OrphanedJobSnapshot[] {
    const excludeJson = JSON.stringify(liveConfirmedIds);
    const httpGraceModifier = `-${httpJobGraceMs / 1000} seconds`;
    // One atomic unit: advance (+clear pid on) the advisory-live rows, then flip
    // the remaining expired rows to orphaned with a SINGLE guarded UPDATE ...
    // RETURNING whose WHERE re-evaluates the lease/http-grace predicate. No
    // SELECT-then-blind-flip window: a heartbeat or completion that lands before
    // the flip is not stomped (the predicate simply misses that row).
    // withTransaction forwards the callback's return value (the orphaned list).
    const run = this.db.withTransaction((): OrphanedJobSnapshot[] => {
      if (liveConfirmedIds.length > 0) {
        this.advanceLeaseStmt.run({ ids_json: excludeJson, lease_ttl_ms: leaseTtlMs });
      }
      const nowIso = new Date().toISOString();
      const expiresAt = new Date(Date.now() + this.retentionMs).toISOString();
      const rows = this.orphanExpiredStmt.all({
        now_iso: nowIso,
        expires_iso: expiresAt,
        http_grace_modifier: httpGraceModifier,
        exclude_json: excludeJson,
      }) as Array<{
        id: string;
        correlation_id: string;
        started_at: string;
        stdout: string | null;
        stderr: string | null;
        exit_code: number | null;
        transport: string | null;
        http_status: number | null;
      }>;
      return rows.map(r => ({
        id: r.id,
        correlationId: r.correlation_id,
        startedAt: r.started_at,
        stdout: r.stdout ?? "",
        stderr: r.stderr ?? "",
        exitCode: r.exit_code,
        transport: (r.transport as JobTransport) ?? "process",
        httpStatus: r.http_status ?? null,
      }));
    });
    return run();
  }

  gcInstances(instanceGcMs: number): number {
    const result = this.gcInstancesStmt.run({ gc_ms: instanceGcMs });
    return Number(result.changes);
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
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    finishedAt: string;
    httpStatus?: number | null;
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
      http_status: input.httpStatus ?? null,
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
   * @deprecated #139: superseded by the durable per-job lease. This is now a
   * thin shim delegating to `recoverStaleJobs` for the single-owner
   * sqlite/memory path; it NO LONGER blanket-orphans every `running` row. A
   * genuinely stale prior-process job (its lease expired when the owner died)
   * and a legacy NULL-lease row are recovered; a job kept alive by a live
   * instance's heartbeat is not. Retained only for the boot path and existing
   * callers/tests. `selectRunningOrphansStmt`/`markOrphanedStmt` are kept for
   * back-compat but are no longer used by this method.
   */
  markOrphanedOnStartup(): {
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  } {
    const orphaned = this.recoverStaleJobs(this.leaseTtlMs, DEFAULT_HTTP_JOB_GRACE_MS);
    return { count: orphaned.length, orphaned };
  }

  /**
   * Delete rows whose expires_at has passed. Returns number of rows deleted.
   */
  evictExpired(): number {
    const now = new Date().toISOString();
    const result = this.deleteExpiredStmt.run(now);
    return Number(result.changes);
  }

  // --- ValidationRunStore (cross-LLM validation receipts, Phase 0) ---

  recordValidationRun(run: ValidationRunRecord): void {
    // INSERT OR IGNORE: kickoff writes once; a re-run with the same validation_id
    // (a randomUUID collision is effectively impossible, but the guard keeps the
    // write idempotent and race-safe) is a no-op rather than an overwrite.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO validation_runs
           (validation_id, owner_principal, intent, created_at, request_json,
            provider_links, judge_link, status)
         VALUES (@validation_id, @owner_principal, @intent, @created_at, @request_json,
                 @provider_links, @judge_link, @status)`
      )
      .run({
        validation_id: run.validationId,
        owner_principal: run.ownerPrincipal,
        intent: run.intent,
        created_at: run.createdAt,
        request_json: run.requestJson,
        provider_links: JSON.stringify(run.providerLinks),
        judge_link: run.judgeLink ? JSON.stringify(run.judgeLink) : null,
        status: run.status,
      });
    // Populate the reverse index so eager mint can resolve the run from a
    // collected provider job id. INSERT OR IGNORE keeps it idempotent.
    for (const link of run.providerLinks) {
      this.linkRunJob(run.validationId, link.jobId, "provider");
    }
  }

  private linkRunJob(validationId: string, jobId: string, role: "provider" | "judge"): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO validation_run_jobs (job_id, validation_id, role)
         VALUES (?, ?, ?)`
      )
      .run(jobId, validationId, role);
  }

  getValidationRunIdByJobId(jobId: string): string | null {
    const row = this.db
      .prepare(`SELECT validation_id FROM validation_run_jobs WHERE job_id = ?`)
      .get(jobId) as { validation_id?: string } | undefined;
    return row?.validation_id ?? null;
  }

  getValidationRun(validationId: string): ValidationRunRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM validation_runs WHERE validation_id = ?`)
      .get(validationId);
    return row ? rowToValidationRunRecord(row) : null;
  }

  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): void {
    this.db
      .prepare(`UPDATE validation_runs SET judge_link = ? WHERE validation_id = ?`)
      .run(JSON.stringify(judgeLink), validationId);
    this.linkRunJob(validationId, judgeLink.jobId, "judge");
  }

  setValidationRunStatus(validationId: string, status: ValidationRunRecord["status"]): void {
    this.db
      .prepare(`UPDATE validation_runs SET status = ? WHERE validation_id = ?`)
      .run(status, validationId);
  }

  recordValidationReceipt(receipt: ValidationReceiptRecord): void {
    // INSERT OR IGNORE: the receipt is immutable and minted exactly once. A
    // concurrent or repeat mint for the same validation_id is a no-op; callers
    // re-read to get the authoritative stored row.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO validation_receipts
           (validation_id, owner_principal, minted_at, schema_version, report_json,
            canonical_sha256, prev_sha256, seq, signature, models,
            has_material_disagreement, confidence)
         VALUES (@validation_id, @owner_principal, @minted_at, @schema_version, @report_json,
                 @canonical_sha256, @prev_sha256, @seq, @signature, @models,
                 @has_material_disagreement, @confidence)`
      )
      .run({
        validation_id: receipt.validationId,
        owner_principal: receipt.ownerPrincipal,
        minted_at: receipt.mintedAt,
        schema_version: receipt.schemaVersion,
        report_json: receipt.reportJson,
        canonical_sha256: receipt.canonicalSha256,
        prev_sha256: receipt.prevSha256,
        seq: receipt.seq,
        signature: receipt.signature,
        models: JSON.stringify(receipt.models),
        has_material_disagreement: receipt.hasMaterialDisagreement ? 1 : 0,
        confidence: receipt.confidence,
      });
  }

  getValidationReceipt(validationId: string): ValidationReceiptRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM validation_receipts WHERE validation_id = ?`)
      .get(validationId);
    return row ? rowToValidationReceiptRecord(row) : null;
  }

  close(): void {
    try {
      this.db.close();
    } catch (err) {
      this.logger.error("SqliteJobStore close failed", err);
    }
  }
}

function rowToValidationRunRecord(row: any): ValidationRunRecord {
  return {
    validationId: row.validation_id,
    ownerPrincipal: row.owner_principal,
    intent: row.intent,
    createdAt: row.created_at,
    requestJson: row.request_json,
    providerLinks: parseLinks(row.provider_links) ?? [],
    judgeLink: parseLink(row.judge_link),
    status: row.status as ValidationRunRecord["status"],
  };
}

function rowToValidationReceiptRecord(row: any): ValidationReceiptRecord {
  return {
    validationId: row.validation_id,
    ownerPrincipal: row.owner_principal,
    mintedAt: row.minted_at,
    schemaVersion: row.schema_version,
    reportJson: row.report_json,
    canonicalSha256: row.canonical_sha256,
    prevSha256: row.prev_sha256 ?? null,
    seq: row.seq ?? null,
    signature: row.signature ?? null,
    models: parseStringArray(row.models),
    hasMaterialDisagreement: Boolean(row.has_material_disagreement),
    confidence: row.confidence,
  };
}

function parseLinks(value: unknown): ValidationRunLink[] | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as ValidationRunLink[]) : null;
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function parseLink(value: unknown): ValidationRunLink | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as ValidationRunLink) : null;
  } catch {
    return null;
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
  private leaseTtlMs: number;

  constructor(options: { retentionMs?: number; dedupWindowMs?: number; leaseTtlMs?: number } = {}) {
    this.retentionMs = options.retentionMs ?? resolveJobRetentionMs();
    this.dedupWindowMs = options.dedupWindowMs ?? resolveDedupWindowMs();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_INSTANCE_LEASE_TTL_MS;
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
    ownerInstance?: string | null;
    transport?: JobTransport;
    payloadJson?: string | null;
  }): void {
    this.rows.set(input.id, {
      id: input.id,
      correlationId: input.correlationId,
      requestKey: input.requestKey,
      cli: input.cli,
      argsJson: JSON.stringify(input.args),
      outputFormat: input.outputFormat ?? null,
      // #139: persist queued (markRunning flips to running at launch).
      status: "queued",
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
      transport: input.transport ?? "process",
      httpStatus: null,
      payloadJson: input.payloadJson ?? null,
      ownerInstance: input.ownerInstance ?? null,
      // In-process store: DB clock == client clock, so the lease is client-time.
      leaseDeadline: Date.now() + this.leaseTtlMs,
    });
  }

  markRunning(id: string, opts: { pid: number | null }): boolean {
    const row = this.rows.get(id);
    if (!row || row.status !== "queued") return false;
    row.status = "running";
    row.pid = opts.pid;
    row.leaseDeadline = Date.now() + this.leaseTtlMs;
    return true;
  }

  // #139: instance registration is a no-op for the in-process store (there is
  // only ever one owner and no cross-process visibility).
  registerInstance(_meta: GatewayInstanceMeta): void {}

  heartbeat(instanceId: string): void {
    // Still advance in-memory leases for parity (harmless; recover is a no-op).
    const deadline = Date.now() + this.leaseTtlMs;
    for (const row of this.rows.values()) {
      if (
        row.ownerInstance === instanceId &&
        (row.status === "queued" || row.status === "running")
      ) {
        row.leaseDeadline = deadline;
      }
    }
  }

  deregisterInstance(_instanceId: string): void {}

  selectStaleProcessCandidates(_leaseTtlMs: number, _httpJobGraceMs: number): SweepCandidate[] {
    return [];
  }

  /**
   * In-memory stores have no cross-process state, so any open rows here belong
   * to this very process and are not actually orphaned. Per-process no-op.
   */
  recoverStaleJobs(
    _leaseTtlMs: number,
    _httpJobGraceMs: number,
    _liveConfirmedIds?: string[]
  ): OrphanedJobSnapshot[] {
    return [];
  }

  gcInstances(_instanceGcMs: number): number {
    return 0;
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
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    finishedAt: string;
    httpStatus?: number | null;
  }): void {
    const row = this.rows.get(input.id);
    if (!row) return;
    // #139: guarded completion, mirroring the sqlite WHERE guard. A terminal
    // result may land on an open (queued/running) row or a mistakenly-orphaned
    // row, but is a no-op on an already-terminal row (last terminal state wins).
    if (row.status !== "queued" && row.status !== "running" && row.status !== "orphaned") return;
    row.status = input.status;
    row.exitCode = input.exitCode;
    row.stdout = input.stdout;
    row.stderr = input.stderr;
    row.outputTruncated = input.outputTruncated;
    row.error = input.error;
    row.finishedAt = input.finishedAt;
    row.expiresAt = new Date(Date.parse(input.finishedAt) + this.retentionMs).toISOString();
    row.leaseDeadline = null;
    if (input.httpStatus !== undefined) row.httpStatus = input.httpStatus;
  }

  getById(id: string): JobRecord | null {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  findByRequestKey(requestKey: string): JobRecord | null {
    const cutoffMs = Date.now() - this.dedupWindowMs;
    const nowMs = Date.now();
    let best: JobRecord | null = null;
    for (const row of this.rows.values()) {
      if (row.requestKey !== requestKey) continue;
      // #139: reuse running/completed, or a still-live (lease-valid) queued job;
      // never an orphaned/canceled/failed row or an expired-lease queued row.
      const reusable =
        row.status === "running" ||
        row.status === "completed" ||
        (row.status === "queued" && row.leaseDeadline !== null && row.leaseDeadline >= nowMs);
      if (!reusable) continue;
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
 * PostgreSQL-backed job store. The gateway's job-store interface is synchronous
 * because SQLite is synchronous; Postgres work therefore runs in an internal
 * worker thread and each call waits for that worker's result. The blocking
 * section is scoped to the store operation only; provider execution remains
 * managed by AsyncJobManager's limiter.
 */
export class PostgresJobStore implements JobStore, ValidationRunStore {
  private worker: Worker;
  private tmpDir: string;
  private nextRequestId = 0;
  private closed = false;

  constructor(
    dsn: string,
    private logger: Logger = noopLogger,
    options: { retentionMs?: number; dedupWindowMs?: number; leaseTtlMs?: number } = {}
  ) {
    if (!dsn) {
      throw new Error("PostgresJobStore requires a non-empty DSN");
    }
    this.tmpDir = mkdtempSync(path.join(os.tmpdir(), "llm-gateway-pg-job-store-"));
    this.worker = new Worker(resolvePostgresWorkerUrl(), {
      execArgv: [],
      workerData: {
        dsn,
        retentionMs: options.retentionMs ?? resolveJobRetentionMs(),
        dedupWindowMs: options.dedupWindowMs ?? resolveDedupWindowMs(),
        leaseTtlMs: options.leaseTtlMs ?? DEFAULT_INSTANCE_LEASE_TTL_MS,
        farFutureIso: FAR_FUTURE_ISO,
        connectionTimeoutMillis: 5000,
      },
    });
    try {
      this.syncCall("init");
    } catch (err) {
      this.closed = true;
      void this.worker.terminate();
      rmSync(this.tmpDir, { recursive: true, force: true });
      throw err;
    }
  }

  private syncCall<T>(method: string, ...args: unknown[]): T {
    if (this.closed && method !== "close") {
      throw new Error("PostgresJobStore is closed");
    }
    const shared = new SharedArrayBuffer(4);
    const state = new Int32Array(shared);
    const resultPath = path.join(this.tmpDir, `result-${process.pid}-${++this.nextRequestId}.json`);
    this.worker.postMessage({ method, args, resultPath, shared });
    const wait = Atomics.wait(state, 0, 0, method === "init" ? 10_000 : 30_000);
    if (wait !== "ok" && wait !== "not-equal") {
      throw new Error(`PostgresJobStore ${method} wait failed: ${wait}`);
    }
    if (Atomics.load(state, 0) === 2) {
      throw new Error(`PostgresJobStore ${method} worker could not write its result`);
    }
    let payload: { ok: true; value: T } | { ok: false; error: { message: string; stack?: string } };
    try {
      payload = JSON.parse(readFileSync(resultPath, "utf8"));
    } finally {
      rmSync(resultPath, { force: true });
    }
    if (!payload.ok) {
      const err = new Error(payload.error.message);
      if (payload.error.stack) err.stack = payload.error.stack;
      throw err;
    }
    return payload.value;
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
    ownerInstance?: string | null;
    transport?: JobTransport;
    payloadJson?: string | null;
  }): void {
    this.syncCall("recordStart", input);
  }

  markRunning(id: string, opts: { pid: number | null }): boolean {
    return this.syncCall("markRunning", id, opts);
  }

  registerInstance(meta: GatewayInstanceMeta): void {
    this.syncCall("registerInstance", meta);
  }

  heartbeat(instanceId: string): void {
    this.syncCall("heartbeat", instanceId);
  }

  deregisterInstance(instanceId: string): void {
    this.syncCall("deregisterInstance", instanceId);
  }

  selectStaleProcessCandidates(leaseTtlMs: number, httpJobGraceMs: number): SweepCandidate[] {
    return this.syncCall("selectStaleProcessCandidates", leaseTtlMs, httpJobGraceMs);
  }

  recoverStaleJobs(
    leaseTtlMs: number,
    httpJobGraceMs: number,
    liveConfirmedIds: string[] = []
  ): OrphanedJobSnapshot[] {
    const result = this.syncCall<{
      orphaned: Array<{
        id: string;
        correlation_id: string;
        started_at: string;
        stdout: string | null;
        stderr: string | null;
        exit_code: number | null;
        transport: string | null;
        http_status: number | null;
      }>;
    }>("recoverStaleJobs", leaseTtlMs, httpJobGraceMs, liveConfirmedIds);
    return result.orphaned.map(row => ({
      id: row.id,
      correlationId: row.correlation_id,
      startedAt: row.started_at,
      stdout: row.stdout ?? "",
      stderr: row.stderr ?? "",
      exitCode: row.exit_code,
      transport: (row.transport as JobTransport) ?? "process",
      httpStatus: row.http_status ?? null,
    }));
  }

  gcInstances(instanceGcMs: number): number {
    return this.syncCall("gcInstances", instanceGcMs);
  }

  recordOutput(id: string, stdout: string, stderr: string, outputTruncated: boolean): void {
    this.syncCall("recordOutput", id, stdout, stderr, outputTruncated);
  }

  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    finishedAt: string;
    httpStatus?: number | null;
  }): void {
    this.syncCall("recordComplete", input);
  }

  getById(id: string): JobRecord | null {
    const row = this.syncCall("getById", id);
    return row ? rowToRecord(row) : null;
  }

  findByRequestKey(requestKey: string): JobRecord | null {
    const row = this.syncCall("findByRequestKey", requestKey);
    return row ? rowToRecord(row) : null;
  }

  /**
   * @deprecated #139: delegates to the durable lease sweep (like the sqlite
   * shim). No longer blanket-orphans every running row.
   */
  markOrphanedOnStartup(): {
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  } {
    const orphaned = this.recoverStaleJobs(
      DEFAULT_INSTANCE_LEASE_TTL_MS,
      DEFAULT_HTTP_JOB_GRACE_MS
    );
    return { count: orphaned.length, orphaned };
  }

  evictExpired(): number {
    return this.syncCall("evictExpired");
  }

  recordValidationRun(run: ValidationRunRecord): void {
    this.syncCall("recordValidationRun", run);
  }

  getValidationRun(validationId: string): ValidationRunRecord | null {
    const row = this.syncCall("getValidationRun", validationId);
    return row ? rowToValidationRunRecord(row) : null;
  }

  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): void {
    this.syncCall("setValidationJudgeLink", validationId, judgeLink);
  }

  setValidationRunStatus(validationId: string, status: ValidationRunRecord["status"]): void {
    this.syncCall("setValidationRunStatus", validationId, status);
  }

  getValidationRunIdByJobId(jobId: string): string | null {
    return this.syncCall("getValidationRunIdByJobId", jobId);
  }

  recordValidationReceipt(receipt: ValidationReceiptRecord): void {
    this.syncCall("recordValidationReceipt", receipt);
  }

  getValidationReceipt(validationId: string): ValidationReceiptRecord | null {
    const row = this.syncCall("getValidationReceipt", validationId);
    return row ? rowToValidationReceiptRecord(row) : null;
  }

  close(): void {
    if (this.closed) return;
    try {
      this.syncCall("close");
    } catch (err) {
      this.logger.error("PostgresJobStore close failed", err);
    } finally {
      this.closed = true;
      void this.worker.terminate();
      rmSync(this.tmpDir, { recursive: true, force: true });
    }
  }
}

function resolvePostgresWorkerUrl(): URL {
  const sibling = new URL("./postgres-job-store-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return sibling;

  // Vitest executes TypeScript source directly, while Node workers need a real
  // JavaScript module. `scripts/test-pg.sh` builds first, so source-mode tests
  // load the emitted worker from dist/.
  if (import.meta.url.endsWith("/src/job-store.ts")) {
    const built = new URL("../dist/postgres-job-store-worker.js", import.meta.url);
    if (existsSync(fileURLToPath(built))) return built;
  }

  throw new Error(
    "PostgresJobStore worker module is missing. Run `npm run build` before using backend = 'postgres'."
  );
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
    // #139: initial lease TTL used by recordStart/markRunning/heartbeat.
    leaseTtlMs: config.instanceLeaseTtlMs,
  };
  switch (config.backend) {
    case "none":
      return null;
    case "memory":
      return new MemoryJobStore(opts);
    case "postgres":
      return new PostgresJobStore(config.dsn ?? "", logger, opts);
    case "sqlite":
    default:
      if (!config.path) {
        throw new Error("SqliteJobStore requires a non-empty path");
      }
      return new SqliteJobStore(config.path, logger, opts);
  }
}
