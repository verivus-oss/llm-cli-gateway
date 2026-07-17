import { chmodSync, existsSync } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
import { MessageChannel, receiveMessageOnPort, Worker } from "worker_threads";
import { fileURLToPath } from "url";
import { openDatabase } from "./sqlite-driver.js";
import type { GatewayDatabase, GatewayStatement } from "./sqlite-driver.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import type { PersistenceConfig } from "./config.js";
import { DEFAULT_INSTANCE_LEASE_TTL_MS, DEFAULT_HTTP_JOB_GRACE_MS } from "./config.js";
import {
  cloneKitExecutionRef,
  isKitExecutionRef,
  personalKitJobRequestKey,
  sameKitExecutionRef,
  type KitExecutionRef,
} from "./personal-config-types.js";
import { assertMcpArtifactAdmissionInvariant } from "./mcp-artifact-admission.js";
import type { PersonalKitTerminalMetadata } from "./provider-output-metadata.js";
import { principalCanAccess } from "./request-context.js";

// #139: `queued` is now a durable status. A job is persisted `queued` at
// recordStart (owner stamped, no pid yet) and transitions to `running` at
// launch via markRunning. Terminal statuses stay as before. Because `queued`
// is now representable, `recordComplete` must exclude BOTH `running` and
// `queued` (neither is terminal), and the durable sweep targets
// `('queued','running')`.
export type JobStoreStatus =
  "queued" | "running" | "completed" | "failed" | "canceled" | "orphaned";

export type TerminalJobStoreStatus = Exclude<JobStoreStatus, "queued" | "running">;

/** #139: the two non-terminal durable statuses the lease sweep considers. */
export type JobStoreActiveStatus = Extract<JobStoreStatus, "queued" | "running">;

/** Result of atomically reserving a permanently single-use Kit attempt id. */
export type KitAttemptFenceResult = "reserved" | "already_recovered" | "conflict";

/** Immutable identity recorded when a Kit job id is claimed or recovered. */
export interface KitAttemptFenceInput {
  attemptId: string;
  cli: string;
  kitExecution: KitExecutionRef;
  kitSessionId: string;
  ownerPrincipal?: string | null;
  fencedAt: string;
}

/** Slice 1: how a job executes — a spawned CLI subprocess, or an HTTP request. */
export type JobTransport = "process" | "http";

/** Internal durable binding established atomically with a queued review job. */
export interface ValidationJobAdmission {
  validationId: string;
  provider: string;
  /** Provider roster seats are the default; a judge is a one-shot claim. */
  role?: "provider" | "judge";
}

const PERSONAL_KIT_REDACTED_ARGS_JSON = '["[personal-config-kit arguments redacted]"]';
const PERSONAL_KIT_FAILURE_WITHHELD =
  "Personal Agent Config Kit provider execution failed; detailed output is withheld";

/**
 * Match a recovered fence to the caller that is replaying it. Legacy fences
 * predate owner stamping, so their NULL owner remains local-only just like a
 * legacy Kit session. The caller is always stamped by AsyncJobManager; fail
 * closed if a direct store caller supplies no principal.
 */
function recoveredFenceOwnerMatches(
  storedOwner: unknown,
  callerOwner: string | null | undefined
): boolean {
  if (typeof callerOwner !== "string") return false;
  if (storedOwner !== null && storedOwner !== undefined && typeof storedOwner !== "string") {
    return false;
  }
  return principalCanAccess(storedOwner, callerOwner);
}

export interface JobRecord {
  id: string;
  correlationId: string;
  requestKey: string;
  cli: string;
  argsJson: string;
  outputFormat?: string | null;
  /**
   * Native compressor PR-1 (spec 5.2): effective enqueue-time compression
   * decision. NULL on legacy/pre-compressor rows means "not requested".
   */
  compressResponse?: boolean | null;
  status: JobStoreStatus;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  error: string | null;
  /** Stable gateway error category, null for legacy and unclassified rows. */
  errorCategory?: string | null;
  /** Stable retry guidance paired with errorCategory. */
  retryable?: boolean | null;
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
   * Durable snapshot of the owning gateway hostname at recordStart. Unlike
   * `gateway_instances.hostname`, this survives observability-row GC and is
   * used only to scope same-host request-artifact reconciliation.
   */
  ownerHostname: string | null;
  /**
   * Exact gateway-generated Claude MCP config path, when this process job owns
   * one. This is separate from argv so restart reconciliation never has to
   * infer an artifact from a generic caller-supplied flag.
   */
  mcpArtifactPath: string | null;
  /**
   * Durable installation-and-filesystem scope for `mcpArtifactPath`. New
   * artifacts bind this to the private request directory as well as the
   * installation root, so matching hostnames alone can never authorize a
   * different installation to acknowledge a missing file.
   */
  mcpArtifactScope: string | null;
  /**
   * A same-host cleanup acknowledgement is still required for
   * `mcpArtifactPath`. Retention eviction must leave the durable row intact
   * until the origin host has safely handled that exact request artifact.
   */
  mcpArtifactCleanupPending: boolean;
  /**
   * #139: the per-job fencing lease deadline as epoch milliseconds (DB-clock).
   * The owner's heartbeat advances it to `db_now + leaseTtl`; the sweep orphans
   * a `queued`/`running` row whose `leaseDeadline < db_now` (or IS NULL for a
   * legacy row). Null only for terminal rows and legacy pre-migration rows; a
   * live row always has it set in the same write as recordStart/markRunning.
   */
  leaseDeadline: number | null;
  /**
   * Immutable Personal Agent Config Kit execution identity. Null for legacy
   * jobs and for every request while the Kit is disabled.
   */
  kitExecution: KitExecutionRef | null;
  /** Gateway-owned Kit session whose terminal attempt must be finalized. */
  kitSessionId: string | null;
  /** Compatibility projection, always null for Kit rows. */
  kitTerminalMetadata: PersonalKitTerminalMetadata | null;
  /** True only after the terminal output has been applied to the Kit session. */
  kitTerminalFinalized: boolean;
  /** Durable audit timestamp for the successful Kit terminal finalization. */
  kitTerminalFinalizedAt: string | null;
  /** Bounded, privacy-projected async progress state. Never contains raw provider output. */
  progressJson: string | null;
}

/**
 * Durable terminal Kit result waiting to be finalized against its gateway
 * session. It carries immutable identity only; native continuation state is
 * deliberately not durable.
 */
export interface PendingKitFinalization {
  jobId: string;
  cli: string;
  status: TerminalJobStoreStatus;
  kitSessionId: string;
  kitExecution: KitExecutionRef;
  terminalMetadata: PersonalKitTerminalMetadata | null;
  finishedAt: string;
  exitCode: number | null;
  ownerPrincipal: string | null;
}

/**
 * A terminal Kit row whose durable finalization marker is already committed,
 * but whose exact session attempt may still need releasing after a crash in the
 * acknowledgement sequence. Reconciliation needs only the immutable binding.
 */
export interface AcknowledgedKitAttemptRelease {
  jobId: string;
  cli: string;
  kitSessionId: string;
  kitExecution: KitExecutionRef;
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

// The Postgres worker uses a 5s connection timeout and a 27s driver query
// timeout. Keep the synchronous watchdog beyond that complete budget. Schema
// bootstrap can also wait briefly on the transaction-scoped advisory lock.
const POSTGRES_WORKER_OPERATION_TIMEOUT_MS = 35_000;
const POSTGRES_WORKER_INITIALIZATION_TIMEOUT_MS = 45_000;

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
    compressResponse:
      row.compress_response === null || row.compress_response === undefined
        ? null
        : Boolean(row.compress_response),
    status: row.status as JobStoreStatus,
    exitCode: row.exit_code,
    stdout: row.stdout ?? "",
    stderr: row.stderr ?? "",
    outputTruncated: Boolean(row.output_truncated),
    error: row.error ?? null,
    errorCategory: row.error_category ?? null,
    retryable:
      row.retryable === null || row.retryable === undefined ? null : Boolean(row.retryable),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    pid: row.pid,
    expiresAt: row.expires_at,
    ownerPrincipal: row.owner_principal ?? null,
    transport: (row.transport as JobTransport) ?? "process",
    httpStatus: row.http_status ?? null,
    payloadJson: row.payload_json ?? null,
    ownerInstance: row.owner_instance ?? null,
    ownerHostname: row.owner_hostname ?? null,
    mcpArtifactPath: row.mcp_artifact_path ?? null,
    mcpArtifactScope: row.mcp_artifact_scope ?? null,
    mcpArtifactCleanupPending: parseDurableBoolean(row.mcp_artifact_cleanup_pending),
    // sqlite returns lease_deadline as a number; node-pg returns BIGINT as a
    // string. Coerce to number|null so JobRecord.leaseDeadline is uniform.
    leaseDeadline: row.lease_deadline == null ? null : Number(row.lease_deadline),
    kitExecution: parseKitExecution(row.kit_execution_json),
    kitSessionId: parseKitSessionId(row.kit_session_id),
    // A legacy database can still have this additive column, but its contents
    // are never trusted or surfaced. Startup scrub clears it for Kit rows.
    kitTerminalMetadata: null,
    kitTerminalFinalized: parseDurableBoolean(row.kit_terminal_finalized),
    kitTerminalFinalizedAt: row.kit_terminal_finalized_at ?? null,
    progressJson: typeof row.progress_json === "string" ? row.progress_json : null,
  };
}

function parseKitSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseDurableBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true";
}

function parseKitExecution(value: unknown): KitExecutionRef | null {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isKitExecutionRef(parsed) ? cloneKitExecutionRef(parsed) : null;
  } catch {
    // Durable job rows are audit data. A malformed legacy or manually-edited
    // value must not make result retrieval fail, and cannot become a release pin.
    return null;
  }
}

function serializeKitTerminalMetadata(value: unknown): string | null {
  // Native continuation handles are process-local. Keep this compatibility
  // helper at the persistence boundary so legacy callers cannot accidentally
  // reintroduce them into the durable job row.
  void value;
  return null;
}

function cloneJobRecord(record: JobRecord): JobRecord {
  return {
    ...record,
    kitExecution: record.kitExecution ? cloneKitExecutionRef(record.kitExecution) : null,
    kitTerminalMetadata: record.kitTerminalMetadata ? { ...record.kitTerminalMetadata } : null,
  };
}

function toPendingKitFinalization(record: JobRecord): PendingKitFinalization | null {
  if (
    record.status === "queued" ||
    record.status === "running" ||
    record.status === "orphaned" ||
    record.kitTerminalFinalized ||
    !record.kitExecution ||
    !record.kitSessionId ||
    !record.finishedAt
  ) {
    return null;
  }
  return {
    jobId: record.id,
    cli: record.cli,
    status: record.status,
    kitSessionId: record.kitSessionId,
    kitExecution: cloneKitExecutionRef(record.kitExecution),
    terminalMetadata: record.kitTerminalMetadata ? { ...record.kitTerminalMetadata } : null,
    finishedAt: record.finishedAt,
    exitCode: record.exitCode,
    ownerPrincipal: record.ownerPrincipal,
  };
}

function toAcknowledgedKitAttemptRelease(record: JobRecord): AcknowledgedKitAttemptRelease | null {
  if (
    record.status === "queued" ||
    record.status === "running" ||
    record.status === "orphaned" ||
    !record.kitTerminalFinalized ||
    !record.kitExecution ||
    !record.kitSessionId
  ) {
    return null;
  }
  return {
    jobId: record.id,
    cli: record.cli,
    kitSessionId: record.kitSessionId,
    kitExecution: cloneKitExecutionRef(record.kitExecution),
    ownerPrincipal: record.ownerPrincipal,
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

/** #192: add bounded normalized progress storage to legacy SQLite job tables. */
function ensureJobsProgressColumn(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  if (!cols.some(col => col?.name === "progress_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN progress_json TEXT");
  }
}

/** #189: preserve typed async failure classification across gateway restarts. */
function ensureJobsErrorClassificationColumns(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("error_category")) {
    db.exec("ALTER TABLE jobs ADD COLUMN error_category TEXT");
  }
  if (!names.has("retryable")) {
    db.exec("ALTER TABLE jobs ADD COLUMN retryable INTEGER");
  }
}

/**
 * #139: idempotent migration adding durable ownership and lease columns to a
 * pre-existing jobs table. `owner_instance` records the owning gateway
 * instance, while `owner_hostname` is an immutable same-host reconciliation
 * snapshot that outlives gateway-instance observability GC. The
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
  if (!names.has("owner_hostname")) {
    db.exec("ALTER TABLE jobs ADD COLUMN owner_hostname TEXT");
  }
  if (!names.has("lease_deadline")) {
    db.exec("ALTER TABLE jobs ADD COLUMN lease_deadline INTEGER");
  }
}

/**
 * Durable provenance for gateway-generated Claude MCP request artifacts. A
 * terminal row with `mcp_artifact_cleanup_pending=1` is intentionally retained
 * past its ordinary expiry until its own host confirms safe cleanup. Legacy
 * rows remain unpinned because they were created before exact-path provenance
 * existed.
 */
function ensureJobsMcpArtifactCleanupColumns(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("mcp_artifact_path")) {
    db.exec("ALTER TABLE jobs ADD COLUMN mcp_artifact_path TEXT");
  }
  if (!names.has("mcp_artifact_scope")) {
    db.exec("ALTER TABLE jobs ADD COLUMN mcp_artifact_scope TEXT");
  }
  if (!names.has("mcp_artifact_cleanup_pending")) {
    db.exec("ALTER TABLE jobs ADD COLUMN mcp_artifact_cleanup_pending INTEGER NOT NULL DEFAULT 0");
  }
}

/**
 * Recover hostname provenance for rows written before migration 015 only while
 * their observability row is still available. Once that row has been GCed,
 * there is no safe way to infer which host owned the filesystem path, so the
 * NULL is intentionally retained and local artifact reconciliation fails
 * closed.
 */
function backfillLegacyOwnerHostnames(db: GatewayDatabase): void {
  db.exec(`
    UPDATE jobs
    SET owner_hostname = (
      SELECT gi.hostname
      FROM gateway_instances AS gi
      WHERE gi.instance_id = jobs.owner_instance
    )
    WHERE owner_hostname IS NULL
      AND owner_instance IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM gateway_instances AS gi
        WHERE gi.instance_id = jobs.owner_instance
          AND gi.hostname IS NOT NULL
          AND gi.hostname <> ''
      )
  `);
}

/**
 * Native compressor PR-1 (spec 5.2): idempotent migration adding the
 * nullable `compress_response` column, mirroring the `output_format`
 * handling. Legacy rows keep NULL ("not requested"). MUST run before any
 * prepared statement is compiled.
 */
function ensureJobsCompressResponseColumn(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("compress_response")) {
    db.exec("ALTER TABLE jobs ADD COLUMN compress_response INTEGER");
  }
}

/**
 * Additive Kit migration. A JSON string preserves the immutable execution ref
 * without exposing individual fields as ad-hoc mutable columns. Legacy rows
 * remain NULL and therefore retain their exact disabled-mode behavior.
 */
function ensureJobsKitExecutionColumn(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("kit_execution_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kit_execution_json TEXT");
  }
}

/**
 * Additive Kit terminal-finalization migration. The session id lets a fresh
 * gateway instance map a completed provider run back to its gateway session;
 * the finalized marker is deliberately independent from job status so an
 * output can be durable before its session update succeeds.
 */
function ensureJobsKitFinalizationColumns(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("kit_session_id")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kit_session_id TEXT");
  }
  if (!names.has("kit_terminal_finalized")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kit_terminal_finalized INTEGER NOT NULL DEFAULT 0");
  }
  if (!names.has("kit_terminal_finalized_at")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kit_terminal_finalized_at TEXT");
  }
}

/**
 * Privacy boundary for Kit terminal recovery. The additive migration also
 * removes legacy raw Kit output and arguments. Existing pre-upgrade provider
 * handles are intentionally retired rather than retaining instruction-derived
 * material in a durable database.
 */
function ensureJobsKitTerminalMetadataColumn(db: GatewayDatabase): void {
  const cols = db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("kit_terminal_metadata_json")) {
    db.exec("ALTER TABLE jobs ADD COLUMN kit_terminal_metadata_json TEXT");
  }
  // SQLite DDL can commit before a following data update. Run the scrub on
  // every open so a crash between the additive ALTER and this update heals on
  // the next startup instead of preserving legacy Kit context indefinitely.
  // The guarded predicate leaves already-clean rows untouched.
  db.prepare(
    `UPDATE jobs
     SET args_json = '${PERSONAL_KIT_REDACTED_ARGS_JSON.replace(/'/g, "''")}',
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
         args_json IS NOT '${PERSONAL_KIT_REDACTED_ARGS_JSON.replace(/'/g, "''")}'
         OR request_key IS NOT ('kit:' || id)
         OR stdout IS NOT ''
         OR stderr IS NOT ''
         OR payload_json IS NOT NULL
         OR kit_terminal_metadata_json IS NOT NULL
         OR error IS NOT (
           CASE
             WHEN status IN ('queued', 'running', 'completed') THEN NULL
             ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
           END
         )
       )`
  ).run();
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
 * #139: an expired process-transport sweep candidate. `pid` is null for a
 * queued/pre-spawn job, so the manager skips the advisory `kill(pid,0)` probe
 * but can still use the owning hostname to safely reclaim request artifacts
 * after the atomic orphan transition. `hostname` is the durable owner-hostname
 * snapshot for new rows, with a live `gateway_instances` fallback only for
 * legacy rows. The manager only pid-checks and artifact-cleans same-host
 * candidates; a foreign-host or unknown-host candidate falls straight through
 * to orphaning without local cleanup. This candidate read is NOT the fencing decision (that stays purely
 * `lease_deadline < db_now` on the job row); it only scopes advisory recovery.
 */
export interface SweepCandidate {
  id: string;
  pid: number | null;
  transport: JobTransport;
  ownerInstance: string | null;
  hostname: string | null;
}

/**
 * A terminal, origin-host-owned Claude MCP artifact whose durable cleanup
 * acknowledgement is still outstanding. The path was recorded explicitly at
 * admission, not reconstructed from an arbitrary durable argv.
 */
export interface PendingMcpArtifactCleanup {
  id: string;
  ownerInstance: string | null;
  hostname: string;
  artifactScope: string;
  artifactPath: string;
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
    /** Native compressor PR-1: effective enqueue-time compression decision. */
    compressResponse?: boolean;
    startedAt: string;
    pid: number | null;
    ownerPrincipal?: string | null;
    /** #139: the gateway instance that owns this job (stamped at enqueue). */
    ownerInstance?: string | null;
    /** Durable owner-hostname snapshot for same-host orphan reconciliation. */
    ownerHostname?: string | null;
    /**
     * Exact gateway-generated Claude MCP config path. Supplying this records a
     * durable cleanup obligation that retention cannot evict until the origin
     * host acknowledges safe handling of this artifact.
     */
    mcpArtifactPath?: string | null;
    /**
     * Durable installation-and-filesystem cleanup scope. Required whenever an
     * exact Claude MCP artifact path is supplied.
     */
    mcpArtifactScope?: string | null;
    /** Slice 1: defaults to 'process'. */
    transport?: JobTransport;
    /** Slice 1: canonical API request JSON for http jobs (null/undefined for process). */
    payloadJson?: string | null;
    /** Immutable Kit execution identity, null/undefined outside Kit mode. */
    kitExecution?: KitExecutionRef | null;
    /** Gateway-owned Kit session that must receive the terminal provider output. */
    kitSessionId?: string | null;
    /** Repository-review provider link committed in the same transaction as the job row. */
    validationAdmission?: ValidationJobAdmission;
  }): void;
  /**
   * Permanently reserve an unadmitted Kit attempt id. This is an atomic
   * insert-if-absent fence, not a job row: it is intentionally excluded from
   * terminal-finalization and retention paths. A false result means another
   * admission or recovery already owns the id, so callers must retain the
   * matching session attempt.
   */
  fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): KitAttemptFenceResult;
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
   * #139: expired process-transport candidates for the advisory `kill(pid,0)`
   * check and same-host request-artifact cleanup. Queued/pre-spawn rows carry a
   * null pid and are not pid-probed. Read-only; does not mutate any row.
   */
  selectStaleProcessCandidates(leaseTtlMs: number, httpJobGraceMs: number): SweepCandidate[];
  /**
   * #139: already-orphaned process rows whose durable owner-hostname snapshot
   * matches `hostname`. Used only by that host's startup reconciliation to
   * reclaim its own request-scoped artifacts. Read-only; never returns
   * remote/unknown hosts.
   */
  selectOrphanedProcessCandidates(hostname: string): SweepCandidate[];
  /**
   * Terminal Claude MCP artifacts awaiting local cleanup acknowledgement. This
   * capability is optional so older third-party JobStore implementations keep
   * their safe fail-closed behavior (the row remains retained instead).
   */
  selectPendingMcpArtifactCleanups?(hostname: string): PendingMcpArtifactCleanup[];
  /**
   * Compare-and-set acknowledgement for one exact origin-host artifact. An
   * acknowledgement only succeeds for a terminal row still marked pending.
   */
  acknowledgeMcpArtifactCleanup?(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): boolean;
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
  /** Replace one job's complete bounded progress projection atomically. */
  recordProgress(id: string, progressJson: string): void;
  /** Replace progress only while the durable row still has the expected status. */
  recordProgressIfStatus?(id: string, status: JobStoreStatus, progressJson: string): boolean;
  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    errorCategory?: string | null;
    retryable?: boolean | null;
    finishedAt: string;
    /** Slice 1: real HTTP status for http jobs; null for process jobs. */
    httpStatus?: number | null;
    progressJson?: string | null;
    /** Compatibility input ignored at the durable persistence boundary. */
    kitTerminalMetadata?: PersonalKitTerminalMetadata | null;
  }): void;
  getById(id: string): JobRecord | null;
  findByRequestKey(requestKey: string): JobRecord | null;
  /**
   * Terminal Kit jobs whose durable output has not yet been applied to their
   * gateway session. Used by the startup/retry reconciliation path only.
   */
  getPendingKitFinalizations(): PendingKitFinalization[];
  /**
   * Terminal Kit jobs acknowledged before a crash may retain their exact
   * session attempt. The periodic reconciler uses this to release only that
   * generation, never a newer attempt.
   */
  getAcknowledgedKitAttemptReleases(): AcknowledgedKitAttemptRelease[];
  /**
   * Compare-and-set the terminal-finalized marker after the session update
   * succeeds. The session id prevents a stale caller from finalizing a job for
   * a different gateway session.
   */
  markKitTerminalFinalized(id: string, kitSessionId: string): boolean;
  /**
   * Active jobs and terminal Kit jobs awaiting finalization pin their immutable
   * releases. A release cannot be garbage-collected between a durable provider
   * result and its session-binding write.
   */
  getPinnedKitReleaseIds?(): string[];
  /** Alias with explicit release-GC language for callers outside the store. */
  getReferencedKitReleaseIds?(): string[];
  /**
   * @deprecated #139: a documented alias for `recoverStaleJobs`, kept for the
   * single-owner sqlite/memory path and existing callers/tests.
   *
   * It does NOT blanket-orphan every `status='running'` row: doing so orphaned
   * OTHER live instances' jobs on a shared store (issue #139). Recovery is
   * lease-fenced, so only a row whose lease has expired against the DB clock
   * (its owner died) or a legacy NULL-lease row is swept; a row kept alive by
   * a live instance's heartbeat is left running. Do not reintroduce an
   * unscoped `WHERE status = 'running'` UPDATE here or in any implementor.
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
  /** True for a Kit row even if its legacy execution JSON is malformed. */
  isPersonalConfigKit: boolean;
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
  status: "admitting" | "running" | "judge_skipped" | "admission_failed" | "finalized";
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
  /** Replace provider links after a pre-dispatch authorization row is established. */
  setValidationProviderLinks(validationId: string, providerLinks: ValidationRunLink[]): void;
  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): void;
  /** Owner-scoped compare-and-set used to open or fence a review roster. */
  transitionValidationRunStatus(
    validationId: string,
    ownerPrincipal: string,
    expectedStatus: ValidationRunRecord["status"],
    status: ValidationRunRecord["status"]
  ): boolean;
  /** Atomically terminalize a planned review judge that cannot be dispatched. */
  skipValidationJudge(validationId: string, provider: string, ownerPrincipal: string): void;
  setValidationRunStatus(validationId: string, status: ValidationRunRecord["status"]): void;
  /** Reverse lookup for eager mint: which run owns this provider/judge job, if any. */
  getValidationRunIdByJobId(jobId: string): string | null;
  /** Insert the immutable receipt once. Idempotent on validation_id (INSERT OR IGNORE). */
  recordValidationReceipt(receipt: ValidationReceiptRecord): void;
  getValidationReceipt(validationId: string): ValidationReceiptRecord | null;
}

/** True when a job store also persists validation runs and their job links. */
export function isValidationRunStore(store: unknown): store is ValidationRunStore {
  return (
    typeof store === "object" &&
    store !== null &&
    typeof (store as ValidationRunStore).recordValidationRun === "function" &&
    typeof (store as ValidationRunStore).getValidationRun === "function" &&
    typeof (store as ValidationRunStore).setValidationProviderLinks === "function" &&
    typeof (store as ValidationRunStore).transitionValidationRunStatus === "function" &&
    typeof (store as ValidationRunStore).skipValidationJudge === "function" &&
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
  private insertKitAttemptFenceStmt: GatewayStatement;
  private getKitAttemptFenceStmt: GatewayStatement;
  private updateOutputStmt: GatewayStatement;
  private updateProgressStmt: GatewayStatement;
  private updateProgressIfStatusStmt: GatewayStatement;
  private updateCompleteStmt: GatewayStatement;
  private getByIdStmt: GatewayStatement;
  private findByRequestKeyStmt: GatewayStatement;
  private selectPendingKitFinalizationsStmt: GatewayStatement;
  private selectAcknowledgedKitAttemptReleasesStmt: GatewayStatement;
  private markKitTerminalFinalizedStmt: GatewayStatement;
  private deleteExpiredStmt: GatewayStatement;
  // #139 lease surface.
  private markRunningStmt: GatewayStatement;
  private registerInstanceStmt: GatewayStatement;
  private heartbeatInstanceStmt: GatewayStatement;
  private heartbeatJobsStmt: GatewayStatement;
  private deregisterInstanceStmt: GatewayStatement;
  private selectStaleCandidatesStmt: GatewayStatement;
  private selectOrphanedCandidatesStmt: GatewayStatement;
  private selectPendingMcpArtifactCleanupsStmt: GatewayStatement;
  private acknowledgeMcpArtifactCleanupStmt: GatewayStatement;
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
        compress_response INTEGER,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        error_category TEXT,
        retryable INTEGER,
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
        mcp_artifact_cleanup_pending INTEGER NOT NULL DEFAULT 0,
        lease_deadline INTEGER,
        kit_execution_json TEXT,
        kit_session_id TEXT,
        kit_terminal_metadata_json TEXT,
        kit_terminal_finalized INTEGER NOT NULL DEFAULT 0,
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
        started_at INTEGER NOT NULL,
        last_heartbeat INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_instances_heartbeat
        ON gateway_instances(last_heartbeat);

      -- Kit attempt ids are single-use durable capabilities. A recovery fence
      -- is deliberately separate from jobs so retention and terminal-output
      -- reconciliation can never make a paused pre-admission process runnable
      -- again after an operator releases its session attempt.
      CREATE TABLE IF NOT EXISTS kit_attempt_fences (
        attempt_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('admitted', 'recovered')),
        cli TEXT NOT NULL,
        kit_execution_json TEXT NOT NULL,
        kit_session_id TEXT NOT NULL,
        owner_principal TEXT,
        fenced_at TEXT NOT NULL
      );
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
    ensureJobsProgressColumn(this.db);
    ensureJobsErrorClassificationColumns(this.db);
    // #139: idempotent migration for durable ownership and lease columns.
    // Same must-run-before-prepare ordering.
    ensureJobsLeaseColumns(this.db);
    // Exact-path request-artifact provenance must exist before the INSERT and
    // retention statements below are prepared.
    ensureJobsMcpArtifactCleanupColumns(this.db);
    // Migration 017 equivalent for SQLite stores: repair only the rows whose
    // retained instance metadata can prove their old hostname.
    backfillLegacyOwnerHostnames(this.db);
    // #139: the owner/status index references owner_instance, so it can only be
    // created AFTER ensureJobsLeaseColumns adds that column to a legacy table.
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_jobs_owner_hostname_status ON jobs(owner_hostname, status)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_cleanup ON jobs(owner_hostname, mcp_artifact_cleanup_pending, status)"
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_scope_cleanup ON jobs(owner_hostname, mcp_artifact_scope, mcp_artifact_cleanup_pending, status)"
    );
    // Native compressor PR-1: nullable compress_response column.
    ensureJobsCompressResponseColumn(this.db);
    // Personal Agent Config Kit: nullable immutable execution identity.
    ensureJobsKitExecutionColumn(this.db);
    // Personal Agent Config Kit: restart-safe terminal session finalization.
    ensureJobsKitFinalizationColumns(this.db);
    // Personal Agent Config Kit: compatibility column, scrubbed to NULL.
    ensureJobsKitTerminalMetadataColumn(this.db);
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_jobs_kit_finalization ON jobs(kit_terminal_finalized, status)"
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
                        compress_response,
                        status, exit_code, stdout, stderr, output_truncated, error,
                        started_at, finished_at, pid, expires_at, owner_principal,
                        transport, http_status, payload_json, owner_instance, owner_hostname,
                        mcp_artifact_path, mcp_artifact_scope, mcp_artifact_cleanup_pending, lease_deadline,
                        kit_execution_json, kit_session_id, kit_terminal_finalized,
                        kit_terminal_finalized_at, kit_terminal_metadata_json)
      VALUES (@id, @correlation_id, @request_key, @cli, @args_json, @output_format,
              @compress_response,
              'queued', @exit_code, @stdout, @stderr, @output_truncated, @error,
              @started_at, @finished_at, @pid, @expires_at, @owner_principal,
              @transport, @http_status, @payload_json, @owner_instance, @owner_hostname,
              @mcp_artifact_path, @mcp_artifact_scope, @mcp_artifact_cleanup_pending,
              ${SQLITE_NOW_MS} + @lease_ttl_ms, @kit_execution_json, @kit_session_id,
              0, NULL, NULL)
    `);
    this.insertKitAttemptFenceStmt = this.db.prepare(`
      INSERT OR IGNORE INTO kit_attempt_fences
        (attempt_id, state, cli, kit_execution_json, kit_session_id, owner_principal, fenced_at)
      VALUES
        (@attempt_id, @state, @cli, @kit_execution_json, @kit_session_id, @owner_principal, @fenced_at)
    `);
    this.getKitAttemptFenceStmt = this.db.prepare(`
      SELECT state, cli, kit_execution_json, kit_session_id, owner_principal
      FROM kit_attempt_fences
      WHERE attempt_id = ?
    `);

    this.updateOutputStmt = this.db.prepare(`
      UPDATE jobs
      SET stdout = CASE WHEN kit_execution_json IS NULL THEN @stdout ELSE '' END,
          stderr = CASE WHEN kit_execution_json IS NULL THEN @stderr ELSE '' END,
          output_truncated = @output_truncated
      WHERE id = @id
    `);
    this.updateProgressStmt = this.db.prepare(`
      UPDATE jobs SET progress_json = @progress_json WHERE id = @id
    `);
    this.updateProgressIfStatusStmt = this.db.prepare(`
      UPDATE jobs SET progress_json = @progress_json
      WHERE id = @id AND status = @status
    `);

    // #139: guarded completion. A terminal result may only land on a still-open
    // row (queued/running) or one a mistaken sweep marked orphaned; it is a
    // no-op on an already-terminal row (last committed terminal state wins).
    this.updateCompleteStmt = this.db.prepare(`
      UPDATE jobs SET status = @status, exit_code = @exit_code,
                      stdout = CASE WHEN kit_execution_json IS NULL THEN @stdout ELSE '' END,
                      stderr = CASE WHEN kit_execution_json IS NULL THEN @stderr ELSE '' END,
                      output_truncated = @output_truncated,
                      error = CASE
                        WHEN kit_execution_json IS NULL THEN @error
                        WHEN @status = 'completed' THEN NULL
                        ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
                      END,
                      error_category = @error_category,
                      retryable = @retryable,
                      finished_at = @finished_at, expires_at = @expires_at,
                      http_status = @http_status, lease_deadline = NULL,
                      kit_terminal_metadata_json = @kit_terminal_metadata_json,
                      progress_json = COALESCE(@progress_json, progress_json)
      WHERE id = @id AND status IN ('queued', 'running', 'orphaned')
    `);

    this.getByIdStmt = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`);

    this.selectPendingKitFinalizationsStmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE kit_execution_json IS NOT NULL
        AND kit_session_id IS NOT NULL
        AND COALESCE(kit_terminal_finalized, 0) = 0
        AND status IN ('completed', 'failed', 'canceled')
      ORDER BY finished_at ASC, id ASC
    `);
    this.selectAcknowledgedKitAttemptReleasesStmt = this.db.prepare(`
      SELECT * FROM jobs
      WHERE kit_execution_json IS NOT NULL
        AND kit_session_id IS NOT NULL
        AND COALESCE(kit_terminal_finalized, 0) = 1
        AND status IN ('completed', 'failed', 'canceled')
      ORDER BY finished_at ASC, id ASC
    `);
    this.markKitTerminalFinalizedStmt = this.db.prepare(`
      UPDATE jobs
      SET kit_terminal_finalized = 1,
          kit_terminal_finalized_at = COALESCE(kit_terminal_finalized_at, @finalized_at)
      WHERE id = @id
        AND kit_session_id = @kit_session_id
        AND kit_execution_json IS NOT NULL
        AND status IN ('completed', 'failed', 'canceled')
    `);

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

    // A terminal Kit result is retained until its session binding is marked
    // finalized, and an origin-host Claude MCP artifact is retained until its
    // exact cleanup acknowledgement lands. Otherwise a long-lived outage could
    // delete the only durable reconciliation handle before the owner returns.
    this.deleteExpiredStmt = this.db.prepare(`
      DELETE FROM jobs
      WHERE expires_at < ?
        AND (
          kit_execution_json IS NULL
          OR COALESCE(kit_terminal_finalized, 0) = 1
        )
        AND COALESCE(mcp_artifact_cleanup_pending, 0) = 0
    `);

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
    // Candidate read for the advisory pid check and same-host artifact cleanup:
    // expired process-transport rows, including queued/pre-spawn rows with a
    // null pid, using the durable owner-hostname snapshot and a live-instance
    // fallback only for legacy rows. The fencing decision stays on lease_deadline.
    this.selectStaleCandidatesStmt = this.db.prepare(`
      SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
             j.owner_instance AS owner_instance,
             COALESCE(j.owner_hostname, gi.hostname) AS hostname
      FROM jobs j
      LEFT JOIN gateway_instances gi ON gi.instance_id = j.owner_instance
      WHERE j.status IN ('queued', 'running')
        AND j.transport = 'process'
        AND (j.lease_deadline IS NULL OR j.lease_deadline < ${SQLITE_NOW_MS})
    `);
    this.selectOrphanedCandidatesStmt = this.db.prepare(`
      SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
             j.owner_instance AS owner_instance, j.owner_hostname AS hostname
      FROM jobs j
      WHERE j.status = 'orphaned'
        AND j.transport = 'process'
        AND j.owner_hostname = @hostname
    `);
    this.selectPendingMcpArtifactCleanupsStmt = this.db.prepare(`
      SELECT j.id AS id, j.owner_instance AS owner_instance,
             j.owner_hostname AS hostname, j.mcp_artifact_scope AS artifact_scope,
             j.mcp_artifact_path AS artifact_path
      FROM jobs j
      WHERE j.owner_hostname = @hostname
        AND j.cli = 'claude'
        AND j.transport = 'process'
        AND COALESCE(j.mcp_artifact_cleanup_pending, 0) = 1
        AND j.mcp_artifact_path IS NOT NULL
        AND j.mcp_artifact_scope IS NOT NULL
        AND j.status IN ('completed', 'failed', 'canceled', 'orphaned')
    `);
    this.acknowledgeMcpArtifactCleanupStmt = this.db.prepare(`
      UPDATE jobs
      SET mcp_artifact_cleanup_pending = 0
      WHERE id = @id
        AND owner_hostname = @hostname
        AND mcp_artifact_scope = @artifact_scope
        AND mcp_artifact_path = @artifact_path
        AND COALESCE(mcp_artifact_cleanup_pending, 0) = 1
        AND status IN ('completed', 'failed', 'canceled', 'orphaned')
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
          stdout = CASE WHEN kit_execution_json IS NULL THEN stdout ELSE '' END,
          stderr = CASE WHEN kit_execution_json IS NULL THEN stderr ELSE '' END,
          payload_json = CASE WHEN kit_execution_json IS NULL THEN payload_json ELSE NULL END,
          error = CASE
            WHEN kit_execution_json IS NULL THEN COALESCE(error, 'owning gateway instance is no longer alive')
            ELSE '${PERSONAL_KIT_FAILURE_WITHHELD}'
          END,
          finished_at = COALESCE(finished_at, @now_iso),
          expires_at = @expires_iso,
          lease_deadline = NULL
      WHERE status IN ('queued', 'running')
        AND (lease_deadline IS NULL OR lease_deadline < ${SQLITE_NOW_MS})
        AND (transport <> 'http'
             OR started_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', @http_grace_modifier))
        AND id NOT IN (SELECT value FROM json_each(@exclude_json))
      RETURNING id, correlation_id, started_at, stdout, stderr, exit_code, transport, http_status,
                kit_execution_json IS NOT NULL AS is_personal_config_kit
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
    compressResponse?: boolean;
    startedAt: string;
    pid: number | null;
    ownerPrincipal?: string | null;
    ownerInstance?: string | null;
    ownerHostname?: string | null;
    mcpArtifactPath?: string | null;
    mcpArtifactScope?: string | null;
    transport?: JobTransport;
    payloadJson?: string | null;
    kitExecution?: KitExecutionRef | null;
    kitSessionId?: string | null;
    validationAdmission?: ValidationJobAdmission;
  }): void {
    assertMcpArtifactAdmissionInvariant(input);
    const insertJob = (): void => {
      this.insertStmt.run({
        id: input.id,
        correlation_id: input.correlationId,
        request_key: input.kitExecution ? personalKitJobRequestKey(input.id) : input.requestKey,
        cli: input.cli,
        args_json: input.kitExecution
          ? PERSONAL_KIT_REDACTED_ARGS_JSON
          : JSON.stringify(input.args),
        output_format: input.outputFormat ?? null,
        compress_response:
          input.compressResponse === undefined ? null : input.compressResponse ? 1 : 0,
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
        payload_json: input.kitExecution ? null : (input.payloadJson ?? null),
        owner_instance: input.ownerInstance ?? null,
        owner_hostname: input.ownerHostname ?? null,
        mcp_artifact_path: input.kitExecution ? null : (input.mcpArtifactPath ?? null),
        mcp_artifact_scope: input.kitExecution ? null : (input.mcpArtifactScope ?? null),
        mcp_artifact_cleanup_pending:
          !input.kitExecution && input.mcpArtifactPath && input.mcpArtifactScope ? 1 : 0,
        lease_ttl_ms: this.leaseTtlMs,
        kit_execution_json: input.kitExecution
          ? JSON.stringify(cloneKitExecutionRef(input.kitExecution))
          : null,
        kit_session_id: input.kitSessionId ?? null,
      });
    };
    if (!input.kitExecution && !input.validationAdmission) {
      insertJob();
      return;
    }
    if (input.validationAdmission) {
      if (input.kitExecution) {
        throw new Error("Validation job admission cannot be combined with a Kit execution");
      }
      const run = this.db.withTransaction(() => {
        insertJob();
        this.appendValidationJobLink(
          input.validationAdmission!,
          {
            provider: input.validationAdmission!.provider,
            jobId: input.id,
            correlationId: input.correlationId,
          },
          input.ownerPrincipal ?? null
        );
      });
      run();
      return;
    }
    const kitSessionId = input.kitSessionId?.trim();
    if (!kitSessionId) {
      throw new Error("Kit job admission requires a gateway kitSessionId");
    }
    const run = this.db.withTransaction(() => {
      if (
        !this.insertKitAttemptFence({
          attemptId: input.id,
          state: "admitted",
          cli: input.cli,
          kitExecution: input.kitExecution!,
          kitSessionId,
          ownerPrincipal: input.ownerPrincipal,
          fencedAt: input.startedAt,
        })
      ) {
        throw new Error(`Kit job id ${input.id} is already admitted or permanently recovered`);
      }
      insertJob();
    });
    run();
  }

  private appendValidationJobLink(
    admission: ValidationJobAdmission,
    link: ValidationRunLink,
    ownerPrincipal: string | null
  ): void {
    const row = this.db
      .prepare(
        `SELECT owner_principal, intent, request_json, provider_links, judge_link, status
         FROM validation_runs WHERE validation_id = ?`
      )
      .get(admission.validationId) as
      | {
          owner_principal?: unknown;
          intent?: unknown;
          request_json?: unknown;
          provider_links?: unknown;
          judge_link?: unknown;
          status?: unknown;
        }
      | undefined;
    if (!row || row.owner_principal !== ownerPrincipal) {
      throw new Error("Validation run is missing or owned by another principal");
    }
    const role = admission.role ?? "provider";
    if (role === "judge") {
      assertReviewJudgeClaim(row, admission.provider);
      this.db
        .prepare(`UPDATE validation_runs SET judge_link = ? WHERE validation_id = ?`)
        .run(JSON.stringify(link), admission.validationId);
      this.db
        .prepare(
          `INSERT INTO validation_run_jobs (job_id, validation_id, role)
           VALUES (?, ?, 'judge')`
        )
        .run(link.jobId, admission.validationId);
      return;
    }
    if (row.intent !== "review" || row.status !== "admitting") {
      throw new Error("Validation review run is not admitting provider jobs");
    }
    let providerLinks: ValidationRunLink[];
    try {
      providerLinks = JSON.parse(String(row.provider_links)) as ValidationRunLink[];
      if (!Array.isArray(providerLinks)) throw new Error("invalid provider links");
    } catch {
      throw new Error("Validation run provider links are invalid");
    }
    if (providerLinks.some(existing => existing.provider === admission.provider)) {
      throw new Error(`Validation provider ${admission.provider} is already admitted`);
    }
    providerLinks.push(link);
    this.db
      .prepare(`UPDATE validation_runs SET provider_links = ? WHERE validation_id = ?`)
      .run(JSON.stringify(providerLinks), admission.validationId);
    this.db
      .prepare(
        `INSERT INTO validation_run_jobs (job_id, validation_id, role)
         VALUES (?, ?, 'provider')`
      )
      .run(link.jobId, admission.validationId);
  }

  /** Atomically reserve a never-reusable pre-admission attempt id for recovery. */
  fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): KitAttemptFenceResult {
    const inserted = this.insertKitAttemptFence({ ...input, state: "recovered" });
    if (inserted) return "reserved";
    const existing = this.getKitAttemptFenceStmt.get(input.attemptId) as
      | {
          state?: unknown;
          cli?: unknown;
          kit_execution_json?: unknown;
          kit_session_id?: unknown;
          owner_principal?: unknown;
        }
      | undefined;
    const existingExecution = existing ? parseKitExecution(existing.kit_execution_json) : null;
    if (
      existing?.state === "recovered" &&
      existing.cli === input.cli &&
      typeof existing.kit_session_id === "string" &&
      existing.kit_session_id === input.kitSessionId &&
      recoveredFenceOwnerMatches(existing.owner_principal, input.ownerPrincipal) &&
      existingExecution !== null &&
      sameKitExecutionRef(existingExecution, input.kitExecution)
    ) {
      return "already_recovered";
    }
    return "conflict";
  }

  private insertKitAttemptFence(
    input: KitAttemptFenceInput & { state: "admitted" | "recovered" }
  ): boolean {
    const result = this.insertKitAttemptFenceStmt.run({
      attempt_id: input.attemptId,
      state: input.state,
      cli: input.cli,
      kit_execution_json: JSON.stringify(cloneKitExecutionRef(input.kitExecution)),
      kit_session_id: input.kitSessionId,
      owner_principal: input.ownerPrincipal ?? null,
      fenced_at: input.fencedAt,
    });
    return Number(result.changes) === 1;
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

  selectOrphanedProcessCandidates(hostname: string): SweepCandidate[] {
    const rows = this.selectOrphanedCandidatesStmt.all({ hostname }) as Array<{
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

  selectPendingMcpArtifactCleanups(hostname: string): PendingMcpArtifactCleanup[] {
    const rows = this.selectPendingMcpArtifactCleanupsStmt.all({ hostname }) as Array<{
      id: string;
      owner_instance: string | null;
      hostname: string;
      artifact_scope: string;
      artifact_path: string;
    }>;
    return rows.map(row => ({
      id: row.id,
      ownerInstance: row.owner_instance ?? null,
      hostname: row.hostname,
      artifactScope: row.artifact_scope,
      artifactPath: row.artifact_path,
    }));
  }

  acknowledgeMcpArtifactCleanup(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): boolean {
    const result = this.acknowledgeMcpArtifactCleanupStmt.run({
      id,
      hostname,
      artifact_scope: artifactScope,
      artifact_path: artifactPath,
    });
    return Number(result.changes) === 1;
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
        is_personal_config_kit: number | boolean | null;
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
        isPersonalConfigKit: Boolean(r.is_personal_config_kit),
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

  recordProgress(id: string, progressJson: string): void {
    this.updateProgressStmt.run({ id, progress_json: progressJson });
  }

  recordProgressIfStatus(id: string, status: JobStoreStatus, progressJson: string): boolean {
    const result = this.updateProgressIfStatusStmt.run({
      id,
      status,
      progress_json: progressJson,
    });
    return Number(result.changes) === 1;
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
    errorCategory?: string | null;
    retryable?: boolean | null;
    finishedAt: string;
    httpStatus?: number | null;
    progressJson?: string | null;
    kitTerminalMetadata?: PersonalKitTerminalMetadata | null;
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
      error_category: input.errorCategory ?? null,
      retryable: input.retryable == null ? null : input.retryable ? 1 : 0,
      finished_at: input.finishedAt,
      expires_at: expiresAt,
      http_status: input.httpStatus ?? null,
      progress_json: input.progressJson ?? null,
      kit_terminal_metadata_json: serializeKitTerminalMetadata(input.kitTerminalMetadata),
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

  getPendingKitFinalizations(): PendingKitFinalization[] {
    const rows = this.selectPendingKitFinalizationsStmt.all();
    return rows
      .map(row => toPendingKitFinalization(rowToRecord(row)))
      .filter((entry): entry is PendingKitFinalization => entry !== null);
  }

  getAcknowledgedKitAttemptReleases(): AcknowledgedKitAttemptRelease[] {
    const rows = this.selectAcknowledgedKitAttemptReleasesStmt.all();
    return rows
      .map(row => toAcknowledgedKitAttemptRelease(rowToRecord(row)))
      .filter((entry): entry is AcknowledgedKitAttemptRelease => entry !== null);
  }

  markKitTerminalFinalized(id: string, kitSessionId: string): boolean {
    const result = this.markKitTerminalFinalizedStmt.run({
      id,
      kit_session_id: kitSessionId,
      finalized_at: new Date().toISOString(),
    });
    return Number(result.changes) > 0;
  }

  getPinnedKitReleaseIds(): string[] {
    const rows = this.db
      .prepare(
        `SELECT kit_execution_json FROM jobs
         WHERE kit_execution_json IS NOT NULL
           AND (
             status IN ('queued', 'running')
             OR (
               status NOT IN ('queued', 'running')
               AND COALESCE(kit_terminal_finalized, 0) = 0
             )
           )`
      )
      .all() as Array<{ kit_execution_json?: string | null }>;
    const releases = new Set<string>();
    for (const row of rows) {
      const execution = parseKitExecution(row.kit_execution_json);
      if (execution) releases.add(execution.releaseId);
    }
    return [...releases].sort();
  }

  getReferencedKitReleaseIds(): string[] {
    return this.getPinnedKitReleaseIds();
  }

  /**
   * @deprecated #139: superseded by the durable per-job lease. This is now a
   * thin shim delegating to `recoverStaleJobs` for the single-owner
   * sqlite/memory path; it NO LONGER blanket-orphans every `running` row. A
   * genuinely stale prior-process job (its lease expired when the owner died)
   * and a legacy NULL-lease row are recovered; a job kept alive by a live
   * instance's heartbeat is not. Retained only for existing callers/tests.
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

  setValidationProviderLinks(validationId: string, providerLinks: ValidationRunLink[]): void {
    const update = this.db.prepare(
      `UPDATE validation_runs SET provider_links = ? WHERE validation_id = ?`
    );
    const removeOldLinks = this.db.prepare(
      `DELETE FROM validation_run_jobs WHERE validation_id = ? AND role = 'provider'`
    );
    const insertLink = this.db.prepare(
      `INSERT INTO validation_run_jobs (job_id, validation_id, role)
       VALUES (?, ?, 'provider')`
    );
    this.db.withTransaction(() => {
      const result = update.run(JSON.stringify(providerLinks), validationId);
      if (Number(result.changes) !== 1) {
        throw new Error(`Unknown validation run: ${validationId}`);
      }
      removeOldLinks.run(validationId);
      for (const link of providerLinks) insertLink.run(link.jobId, validationId);
    })();
  }

  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): void {
    this.db.withTransaction(() => {
      const result = this.db
        .prepare(
          `UPDATE validation_runs SET judge_link = ?
           WHERE validation_id = ?
             AND status = 'running'
             AND judge_link IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM validation_receipts WHERE validation_id = ?
             )`
        )
        .run(JSON.stringify(judgeLink), validationId, validationId);
      if (Number(result.changes) !== 1) {
        throw new Error("Validation judge link is not open for a one-shot claim");
      }
      this.linkRunJob(validationId, judgeLink.jobId, "judge");
    })();
  }

  transitionValidationRunStatus(
    validationId: string,
    ownerPrincipal: string,
    expectedStatus: ValidationRunRecord["status"],
    status: ValidationRunRecord["status"]
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE validation_runs SET status = ?
         WHERE validation_id = ? AND owner_principal = ? AND status = ?`
      )
      .run(status, validationId, ownerPrincipal, expectedStatus);
    return Number(result.changes) === 1;
  }

  skipValidationJudge(validationId: string, provider: string, ownerPrincipal: string): void {
    this.db.withTransaction(() => {
      const row = this.db
        .prepare(
          `SELECT owner_principal, intent, request_json, judge_link, status
           FROM validation_runs WHERE validation_id = ?`
        )
        .get(validationId) as
        | {
            owner_principal?: unknown;
            intent?: unknown;
            request_json?: unknown;
            judge_link?: unknown;
            status?: unknown;
          }
        | undefined;
      if (!row || row.owner_principal !== ownerPrincipal) {
        throw new Error("Validation run is missing or owned by another principal");
      }
      assertReviewJudgeClaim(row, provider);
      this.db
        .prepare(`UPDATE validation_runs SET status = 'judge_skipped' WHERE validation_id = ?`)
        .run(validationId);
    })();
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
    providerLinks: parseDurableValidationRunLinks(row.provider_links),
    judgeLink: parseDurableValidationRunJudgeLink(row.judge_link),
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

function isValidationRunLink(value: unknown): value is ValidationRunLink {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const link = value as Record<string, unknown>;
  const keys = Object.keys(link);
  return (
    keys.length === 3 &&
    keys.every(key => key === "provider" || key === "jobId" || key === "correlationId") &&
    typeof link.provider === "string" &&
    link.provider.trim().length > 0 &&
    typeof link.jobId === "string" &&
    link.jobId.trim().length > 0 &&
    typeof link.correlationId === "string" &&
    link.correlationId.trim().length > 0
  );
}

function parseDurableValidationRunLinks(value: unknown): ValidationRunLink[] {
  try {
    if (typeof value !== "string" || value.length === 0) throw new Error("missing links");
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every(isValidationRunLink)) {
      throw new Error("invalid links");
    }
    return parsed;
  } catch {
    throw new Error("Durable validation run provider links are malformed");
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

function parseDurableValidationRunJudgeLink(value: unknown): ValidationRunLink | null {
  if (value === null) return null;
  try {
    if (typeof value !== "string" || value.length === 0) throw new Error("missing link");
    const parsed: unknown = JSON.parse(value);
    if (!isValidationRunLink(parsed)) throw new Error("invalid link");
    return parsed;
  } catch {
    throw new Error("Durable validation run judge link is malformed");
  }
}

function assertReviewJudgeClaim(
  row: {
    intent?: unknown;
    request_json?: unknown;
    judge_link?: unknown;
    status?: unknown;
  },
  provider: string
): void {
  if (row.intent !== "review" || row.status !== "running") {
    throw new Error("Validation run is not an open admitted review");
  }
  if (row.judge_link !== null && row.judge_link !== undefined) {
    throw new Error("Validation review judge is already claimed");
  }
  let request: unknown;
  try {
    request = JSON.parse(String(row.request_json));
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
  private kitAttemptFences = new Map<
    string,
    KitAttemptFenceInput & { state: "admitted" | "recovered" }
  >();
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
    compressResponse?: boolean;
    startedAt: string;
    pid: number | null;
    ownerPrincipal?: string | null;
    ownerInstance?: string | null;
    ownerHostname?: string | null;
    mcpArtifactPath?: string | null;
    mcpArtifactScope?: string | null;
    transport?: JobTransport;
    payloadJson?: string | null;
    kitExecution?: KitExecutionRef | null;
    kitSessionId?: string | null;
    validationAdmission?: ValidationJobAdmission;
  }): void {
    assertMcpArtifactAdmissionInvariant(input);
    if (input.kitExecution) {
      const kitSessionId = input.kitSessionId?.trim();
      if (!kitSessionId) {
        throw new Error("Kit job admission requires a gateway kitSessionId");
      }
      if (
        !this.insertKitAttemptFence({
          attemptId: input.id,
          state: "admitted",
          cli: input.cli,
          kitExecution: input.kitExecution,
          kitSessionId,
          ownerPrincipal: input.ownerPrincipal,
          fencedAt: input.startedAt,
        })
      ) {
        throw new Error(`Kit job id ${input.id} is already admitted or permanently recovered`);
      }
    }
    if (input.validationAdmission) {
      throw new Error("Validation job admission requires a durable validation-run store");
    }
    this.rows.set(input.id, {
      id: input.id,
      correlationId: input.correlationId,
      requestKey: input.kitExecution ? personalKitJobRequestKey(input.id) : input.requestKey,
      cli: input.cli,
      argsJson: input.kitExecution ? PERSONAL_KIT_REDACTED_ARGS_JSON : JSON.stringify(input.args),
      outputFormat: input.outputFormat ?? null,
      compressResponse: input.compressResponse ?? null,
      // #139: persist queued (markRunning flips to running at launch).
      status: "queued",
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      error: null,
      errorCategory: null,
      retryable: null,
      startedAt: input.startedAt,
      finishedAt: null,
      pid: input.pid,
      expiresAt: FAR_FUTURE_ISO,
      ownerPrincipal: input.ownerPrincipal ?? null,
      transport: input.transport ?? "process",
      httpStatus: null,
      payloadJson: input.kitExecution ? null : (input.payloadJson ?? null),
      ownerInstance: input.ownerInstance ?? null,
      ownerHostname: input.ownerHostname ?? null,
      mcpArtifactPath: input.kitExecution ? null : (input.mcpArtifactPath ?? null),
      mcpArtifactScope: input.kitExecution ? null : (input.mcpArtifactScope ?? null),
      mcpArtifactCleanupPending:
        !input.kitExecution && Boolean(input.mcpArtifactPath && input.mcpArtifactScope),
      // In-process store: DB clock == client clock, so the lease is client-time.
      leaseDeadline: Date.now() + this.leaseTtlMs,
      kitExecution: input.kitExecution ? cloneKitExecutionRef(input.kitExecution) : null,
      kitSessionId: input.kitSessionId ?? null,
      kitTerminalMetadata: null,
      kitTerminalFinalized: false,
      kitTerminalFinalizedAt: null,
      progressJson: null,
    });
  }

  fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): KitAttemptFenceResult {
    if (this.insertKitAttemptFence({ ...input, state: "recovered" })) return "reserved";
    const existing = this.kitAttemptFences.get(input.attemptId);
    if (
      existing?.state === "recovered" &&
      existing.cli === input.cli &&
      existing.kitSessionId === input.kitSessionId &&
      recoveredFenceOwnerMatches(existing.ownerPrincipal, input.ownerPrincipal) &&
      sameKitExecutionRef(existing.kitExecution, input.kitExecution)
    ) {
      return "already_recovered";
    }
    return "conflict";
  }

  private insertKitAttemptFence(
    input: KitAttemptFenceInput & { state: "admitted" | "recovered" }
  ): boolean {
    if (this.kitAttemptFences.has(input.attemptId)) return false;
    this.kitAttemptFences.set(input.attemptId, {
      ...input,
      kitExecution: cloneKitExecutionRef(input.kitExecution),
      ownerPrincipal: input.ownerPrincipal ?? null,
    });
    return true;
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

  selectOrphanedProcessCandidates(_hostname: string): SweepCandidate[] {
    return [];
  }

  selectPendingMcpArtifactCleanups(hostname: string): PendingMcpArtifactCleanup[] {
    return [...this.rows.values()]
      .filter(
        row =>
          row.ownerHostname === hostname &&
          row.cli === "claude" &&
          row.transport === "process" &&
          row.mcpArtifactCleanupPending &&
          row.mcpArtifactPath !== null &&
          row.mcpArtifactScope !== null &&
          (row.status === "completed" ||
            row.status === "failed" ||
            row.status === "canceled" ||
            row.status === "orphaned")
      )
      .map(row => ({
        id: row.id,
        ownerInstance: row.ownerInstance,
        hostname,
        artifactScope: row.mcpArtifactScope!,
        artifactPath: row.mcpArtifactPath!,
      }));
  }

  acknowledgeMcpArtifactCleanup(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): boolean {
    const row = this.rows.get(id);
    if (
      !row ||
      row.ownerHostname !== hostname ||
      row.mcpArtifactScope !== artifactScope ||
      row.mcpArtifactPath !== artifactPath ||
      !row.mcpArtifactCleanupPending ||
      (row.status !== "completed" &&
        row.status !== "failed" &&
        row.status !== "canceled" &&
        row.status !== "orphaned")
    ) {
      return false;
    }
    row.mcpArtifactCleanupPending = false;
    return true;
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
    row.stdout = row.kitExecution ? "" : stdout;
    row.stderr = row.kitExecution ? "" : stderr;
    row.outputTruncated = outputTruncated;
  }

  recordProgress(id: string, progressJson: string): void {
    const row = this.rows.get(id);
    if (row) row.progressJson = progressJson;
  }

  recordProgressIfStatus(id: string, status: JobStoreStatus, progressJson: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.status !== status) return false;
    row.progressJson = progressJson;
    return true;
  }

  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    errorCategory?: string | null;
    retryable?: boolean | null;
    finishedAt: string;
    httpStatus?: number | null;
    progressJson?: string | null;
    kitTerminalMetadata?: PersonalKitTerminalMetadata | null;
  }): void {
    const row = this.rows.get(input.id);
    if (!row) return;
    // #139: guarded completion, mirroring the sqlite WHERE guard. A terminal
    // result may land on an open (queued/running) row or a mistakenly-orphaned
    // row, but is a no-op on an already-terminal row (last terminal state wins).
    if (row.status !== "queued" && row.status !== "running" && row.status !== "orphaned") return;
    row.status = input.status;
    row.exitCode = input.exitCode;
    row.stdout = row.kitExecution ? "" : input.stdout;
    row.stderr = row.kitExecution ? "" : input.stderr;
    row.outputTruncated = input.outputTruncated;
    row.error = row.kitExecution
      ? input.status === "completed"
        ? null
        : PERSONAL_KIT_FAILURE_WITHHELD
      : input.error;
    row.errorCategory = input.errorCategory ?? null;
    row.retryable = input.retryable ?? null;
    row.finishedAt = input.finishedAt;
    row.expiresAt = new Date(Date.parse(input.finishedAt) + this.retentionMs).toISOString();
    row.leaseDeadline = null;
    if (input.httpStatus !== undefined) row.httpStatus = input.httpStatus;
    // Keep the compatibility input out of the in-memory representation too:
    // a MemoryJobStore must not mask a privacy regression in a durable backend.
    row.kitTerminalMetadata = null;
    if (input.progressJson !== undefined && input.progressJson !== null) {
      row.progressJson = input.progressJson;
    }
  }

  getById(id: string): JobRecord | null {
    const row = this.rows.get(id);
    return row ? cloneJobRecord(row) : null;
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
    return best ? cloneJobRecord(best) : null;
  }

  getPendingKitFinalizations(): PendingKitFinalization[] {
    return [...this.rows.values()]
      .map(toPendingKitFinalization)
      .filter((entry): entry is PendingKitFinalization => entry !== null)
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.jobId.localeCompare(b.jobId));
  }

  getAcknowledgedKitAttemptReleases(): AcknowledgedKitAttemptRelease[] {
    return [...this.rows.values()]
      .map(toAcknowledgedKitAttemptRelease)
      .filter((entry): entry is AcknowledgedKitAttemptRelease => entry !== null)
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  markKitTerminalFinalized(id: string, kitSessionId: string): boolean {
    const row = this.rows.get(id);
    if (
      !row ||
      row.status === "queued" ||
      row.status === "running" ||
      row.status === "orphaned" ||
      !row.kitExecution ||
      row.kitSessionId !== kitSessionId
    ) {
      return false;
    }
    if (!row.kitTerminalFinalized) {
      row.kitTerminalFinalized = true;
      row.kitTerminalFinalizedAt = new Date().toISOString();
    }
    return true;
  }

  getPinnedKitReleaseIds(): string[] {
    const releases = new Set<string>();
    for (const row of this.rows.values()) {
      if (
        row.kitExecution &&
        (row.status === "queued" || row.status === "running" || !row.kitTerminalFinalized)
      ) {
        releases.add(row.kitExecution.releaseId);
      }
    }
    return [...releases].sort();
  }

  getReferencedKitReleaseIds(): string[] {
    return this.getPinnedKitReleaseIds();
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
      if (
        row.expiresAt < nowIso &&
        (!row.kitExecution || row.kitTerminalFinalized) &&
        !row.mcpArtifactCleanupPending
      ) {
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
  private worker: Worker | null = null;
  private retiringWorker: Worker | null = null;
  private readonly intentionallyRetiredWorkers = new WeakSet<Worker>();
  private workerTerminationPending = false;
  private closed = false;
  private readonly workerData: {
    dsn: string;
    retentionMs: number;
    dedupWindowMs: number;
    leaseTtlMs: number;
    farFutureIso: string;
    connectionTimeoutMillis: number;
  };

  constructor(
    dsn: string,
    private logger: Logger = noopLogger,
    options: { retentionMs?: number; dedupWindowMs?: number; leaseTtlMs?: number } = {}
  ) {
    if (!dsn) {
      throw new Error("PostgresJobStore requires a non-empty DSN");
    }
    this.workerData = {
      dsn,
      retentionMs: options.retentionMs ?? resolveJobRetentionMs(),
      dedupWindowMs: options.dedupWindowMs ?? resolveDedupWindowMs(),
      leaseTtlMs: options.leaseTtlMs ?? DEFAULT_INSTANCE_LEASE_TTL_MS,
      farFutureIso: FAR_FUTURE_ISO,
      connectionTimeoutMillis: 5000,
    };
    try {
      this.ensureWorker();
    } catch (err) {
      this.closed = true;
      this.retireWorker(this.worker);
      throw err;
    }
  }

  private createWorker(): Worker {
    const worker = new Worker(resolvePostgresWorkerUrl(), {
      execArgv: [],
      workerData: this.workerData,
    });
    worker.on("message", message => {
      if (!isPostgresWorkerDiagnostic(message)) return;
      const error = new Error(message.message);
      if (message.stack) error.stack = message.stack;
      this.logger.error(`PostgresJobStore worker ${message.kind}`, error);
    });
    worker.on("error", error => {
      this.logger.error("PostgresJobStore worker crashed", error);
      if (!this.closed && this.worker === worker) this.retireWorker(worker);
    });
    worker.on("exit", code => {
      const wasRetiring =
        this.retiringWorker === worker || this.intentionallyRetiredWorkers.has(worker);
      if (this.worker === worker) this.worker = null;
      if (wasRetiring) this.markWorkerRetired(worker);
      if (this.closed || wasRetiring || code === 0) return;
      this.logger.error(
        "PostgresJobStore worker exited unexpectedly",
        new Error(`PostgresJobStore worker exited with code ${code}`)
      );
    });
    return worker;
  }

  /**
   * The JobStore API is synchronous, but Postgres runs in a worker.  Do not use
   * files as the response bridge here: an exhausted or externally cleaned
   * runtime directory must not turn a healthy durable store into a failed one.
   * A per-call MessagePort carries arbitrary-sized payloads, including the
   * gateway's 50 MB captured-output limit; the SharedArrayBuffer only wakes the
   * synchronous caller after the payload has been queued.
   */
  private syncCall<T>(method: string, ...args: unknown[]): T {
    if (this.closed) {
      throw new Error("PostgresJobStore is closed");
    }
    const worker = this.ensureWorker();
    return this.callWorker<T>(worker, method, args);
  }

  /**
   * Recreate a worker only after its predecessor has fully exited. A bridge
   * timeout has an unknown mutation outcome, so starting another worker before
   * termination completes would allow overlapping store calls and is unsafe.
   */
  private ensureWorker(): Worker {
    if (this.closed) throw new Error("PostgresJobStore is closed");
    if (this.worker) return this.worker;
    if (this.workerTerminationPending) {
      throw new Error(
        "PostgresJobStore is waiting for a failed worker to terminate before it can recover"
      );
    }
    const worker = this.createWorker();
    this.worker = worker;
    try {
      this.callWorker<void>(worker, "init", []);
      return worker;
    } catch (err) {
      // A fresh worker whose bootstrap failed cannot safely service regular
      // operations. Retire it, then let a later heartbeat retry the full init.
      this.retireWorker(worker);
      throw err;
    }
  }

  private callWorker<T>(worker: Worker, method: string, args: unknown[]): T {
    const shared = new SharedArrayBuffer(4);
    const state = new Int32Array(shared);
    const { port1: workerPort, port2: responsePort } = new MessageChannel();
    try {
      try {
        worker.postMessage({ method, args, shared, responsePort: workerPort }, [workerPort]);
      } catch (err) {
        throw this.retireAfterBridgeFailure(
          worker,
          `PostgresJobStore ${method} could not dispatch work to its worker`,
          err
        );
      }

      // The worker has a 5s connection timeout and a 27s driver query timeout.
      // Keep this watchdog comfortably beyond both, otherwise a healthy query
      // can be terminated by the parent before the driver's own cancellation
      // has completed. Bootstrap additionally performs serialized DDL.
      const timeoutMs =
        method === "init"
          ? POSTGRES_WORKER_INITIALIZATION_TIMEOUT_MS
          : POSTGRES_WORKER_OPERATION_TIMEOUT_MS;
      const wait = Atomics.wait(state, 0, 0, timeoutMs);
      if (wait === "timed-out") {
        // The worker may have committed a mutation after the caller stopped
        // waiting.  Terminate it and fail closed rather than allowing a second
        // call to overlap an operation whose outcome is unknown.
        throw this.retireAfterBridgeFailure(
          worker,
          `PostgresJobStore ${method} timed out after ${timeoutMs}ms; the operation outcome is unknown`
        );
      }
      if (wait !== "ok" && wait !== "not-equal") {
        throw this.retireAfterBridgeFailure(
          worker,
          `PostgresJobStore ${method} wait failed: ${wait}`
        );
      }
      if (Atomics.load(state, 0) !== 1) {
        throw this.retireAfterBridgeFailure(
          worker,
          `PostgresJobStore ${method} worker response transport failed`
        );
      }

      const received = receiveMessageOnPort(responsePort);
      if (!received || !isPostgresWorkerPayload(received.message)) {
        throw this.retireAfterBridgeFailure(
          worker,
          `PostgresJobStore ${method} worker signalled without a valid response`
        );
      }
      const payload = received.message as PostgresWorkerPayload<T>;
      if (!payload.ok) {
        const err = new Error(payload.error.message);
        if (payload.error.stack) err.stack = payload.error.stack;
        throw err;
      }
      return payload.value;
    } finally {
      responsePort.close();
    }
  }

  private retireAfterBridgeFailure(worker: Worker, message: string, cause?: unknown): Error {
    this.retireWorker(worker);
    return cause === undefined ? new Error(message) : new Error(message, { cause });
  }

  private retireWorker(worker: Worker | null): void {
    if (!worker || this.retiringWorker === worker) return;
    if (this.worker === worker) this.worker = null;
    this.retiringWorker = worker;
    this.intentionallyRetiredWorkers.add(worker);
    this.workerTerminationPending = true;
    void worker.terminate().then(
      () => this.markWorkerRetired(worker),
      error => {
        this.logger.error("PostgresJobStore worker termination failed", error);
        this.markWorkerRetired(worker);
      }
    );
  }

  private markWorkerRetired(worker: Worker): void {
    if (this.retiringWorker !== worker) return;
    this.retiringWorker = null;
    this.workerTerminationPending = false;
  }

  recordStart(input: {
    id: string;
    correlationId: string;
    requestKey: string;
    cli: string;
    args: string[];
    outputFormat?: string;
    compressResponse?: boolean;
    startedAt: string;
    pid: number | null;
    ownerPrincipal?: string | null;
    ownerInstance?: string | null;
    ownerHostname?: string | null;
    mcpArtifactPath?: string | null;
    mcpArtifactScope?: string | null;
    transport?: JobTransport;
    payloadJson?: string | null;
    kitExecution?: KitExecutionRef | null;
    kitSessionId?: string | null;
    validationAdmission?: ValidationJobAdmission;
  }): void {
    assertMcpArtifactAdmissionInvariant(input);
    this.syncCall("recordStart", input);
  }

  fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): KitAttemptFenceResult {
    return this.syncCall("fenceUnadmittedKitAttempt", input);
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

  selectOrphanedProcessCandidates(hostname: string): SweepCandidate[] {
    return this.syncCall("selectOrphanedProcessCandidates", hostname);
  }

  selectPendingMcpArtifactCleanups(hostname: string): PendingMcpArtifactCleanup[] {
    return this.syncCall("selectPendingMcpArtifactCleanups", hostname);
  }

  acknowledgeMcpArtifactCleanup(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): boolean {
    return this.syncCall(
      "acknowledgeMcpArtifactCleanup",
      id,
      hostname,
      artifactScope,
      artifactPath
    );
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
        is_personal_config_kit: boolean | null;
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
      isPersonalConfigKit: Boolean(row.is_personal_config_kit),
    }));
  }

  gcInstances(instanceGcMs: number): number {
    return this.syncCall("gcInstances", instanceGcMs);
  }

  recordOutput(id: string, stdout: string, stderr: string, outputTruncated: boolean): void {
    this.syncCall("recordOutput", id, stdout, stderr, outputTruncated);
  }

  recordProgress(id: string, progressJson: string): void {
    this.syncCall("recordProgress", id, progressJson);
  }

  recordProgressIfStatus(id: string, status: JobStoreStatus, progressJson: string): boolean {
    return this.syncCall("recordProgressIfStatus", id, status, progressJson);
  }

  recordComplete(input: {
    id: string;
    status: Exclude<JobStoreStatus, "running" | "queued">;
    exitCode: number | null;
    stdout: string;
    stderr: string;
    outputTruncated: boolean;
    error: string | null;
    errorCategory?: string | null;
    retryable?: boolean | null;
    finishedAt: string;
    httpStatus?: number | null;
    progressJson?: string | null;
    kitTerminalMetadata?: PersonalKitTerminalMetadata | null;
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

  getPendingKitFinalizations(): PendingKitFinalization[] {
    const rows = this.syncCall<unknown[]>("getPendingKitFinalizations");
    return rows
      .map(row => toPendingKitFinalization(rowToRecord(row)))
      .filter((entry): entry is PendingKitFinalization => entry !== null);
  }

  getAcknowledgedKitAttemptReleases(): AcknowledgedKitAttemptRelease[] {
    const rows = this.syncCall<unknown[]>("getAcknowledgedKitAttemptReleases");
    return rows
      .map(row => toAcknowledgedKitAttemptRelease(rowToRecord(row)))
      .filter((entry): entry is AcknowledgedKitAttemptRelease => entry !== null);
  }

  markKitTerminalFinalized(id: string, kitSessionId: string): boolean {
    return this.syncCall("markKitTerminalFinalized", id, kitSessionId);
  }

  getPinnedKitReleaseIds(): string[] {
    const rows =
      this.syncCall<Array<{ kit_execution_json?: string | null }>>("getPinnedKitReleaseIds");
    const releases = new Set<string>();
    for (const row of rows) {
      const execution = parseKitExecution(row.kit_execution_json);
      if (execution) releases.add(execution.releaseId);
    }
    return [...releases].sort();
  }

  getReferencedKitReleaseIds(): string[] {
    return this.getPinnedKitReleaseIds();
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

  setValidationProviderLinks(validationId: string, providerLinks: ValidationRunLink[]): void {
    this.syncCall("setValidationProviderLinks", validationId, providerLinks);
  }

  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): void {
    this.syncCall("setValidationJudgeLink", validationId, judgeLink);
  }

  transitionValidationRunStatus(
    validationId: string,
    ownerPrincipal: string,
    expectedStatus: ValidationRunRecord["status"],
    status: ValidationRunRecord["status"]
  ): boolean {
    return this.syncCall(
      "transitionValidationRunStatus",
      validationId,
      ownerPrincipal,
      expectedStatus,
      status
    );
  }

  skipValidationJudge(validationId: string, provider: string, ownerPrincipal: string): void {
    this.syncCall("skipValidationJudge", validationId, provider, ownerPrincipal);
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
    const worker = this.worker;
    try {
      if (worker) this.callWorker<void>(worker, "close", []);
    } catch (err) {
      this.logger.error("PostgresJobStore close failed", err);
    } finally {
      this.closed = true;
      this.retireWorker(worker);
    }
  }
}

type PostgresWorkerPayload<T> =
  { ok: true; value: T } | { ok: false; error: { message: string; stack?: string } };

function isPostgresWorkerPayload(value: unknown): value is PostgresWorkerPayload<unknown> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.ok === true) return "value" in candidate;
  if (!candidate.error || typeof candidate.error !== "object" || candidate.ok !== false)
    return false;
  const error = candidate.error as Record<string, unknown>;
  return (
    typeof error.message === "string" &&
    (error.stack === undefined || typeof error.stack === "string")
  );
}

function isPostgresWorkerDiagnostic(value: unknown): value is {
  type: "postgres-job-store-diagnostic";
  kind: string;
  message: string;
  stack?: string;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.type === "postgres-job-store-diagnostic" &&
    typeof candidate.kind === "string" &&
    typeof candidate.message === "string" &&
    (candidate.stack === undefined || typeof candidate.stack === "string")
  );
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
