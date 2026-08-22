import { chmodSync } from "fs";
import os from "os";
import path from "path";
import { createHash } from "crypto";
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
import {
  nodePostgresPoolFactory,
  PostgresStorageDriver,
  type PostgresRoleDsns,
} from "./storage/drivers/postgres.js";
import { SqliteStorageDriver } from "./storage/drivers/sqlite.js";
import type { StorageConnection } from "./storage/store.js";
import {
  createPostgresJobStoreOps,
  type PostgresJobStoreOps,
  type PostgresJobStoreOpsConfig,
} from "./postgres-job-store-ops.js";

// #139: `queued` is now a durable status. A job is persisted `queued` at
// recordStart (owner stamped, no pid yet) and transitions to `running` at
// launch via markRunning. Terminal statuses stay as before. Because `queued`
// is now representable, `recordComplete` must exclude BOTH `running` and
// `queued` (neither is terminal), and the durable sweep targets
// `('queued','running')`.
export type JobStoreStatus =
  "queued" | "running" | "completed" | "failed" | "canceled" | "orphaned";

export type TerminalJobStoreStatus = Exclude<JobStoreStatus, "queued" | "running">;

/**
 * What one heartbeat actually did, because `void` could not say.
 *
 * `instanceRowRefreshed = false` means this instance has no `gateway_instances`
 * row: it was GC'd, so every other instance already treats it as dead and its
 * jobs are being swept. `jobLeasesAdvanced` is how many open rows it still
 * holds, which a caller that knows how many it launched can compare against.
 */
export interface HeartbeatOutcome {
  instanceRowRefreshed: boolean;
  jobLeasesAdvanced: number;
}

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
async function ensureJobsOwnerColumn(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const hasOwner = cols.some(col => col?.name === "owner_principal");
  if (!hasOwner) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN owner_principal TEXT");
  }
}

/**
 * Slice 1: idempotent migration adding the http-transport columns to a
 * pre-existing jobs table. Legacy rows backfill `transport='process'` (the
 * column DEFAULT); `http_status`/`payload_json` stay NULL. MUST run before any
 * prepared statement is compiled — the INSERT/UPDATE column lists bind at
 * prepare time.
 */
async function ensureJobsTransportColumns(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("transport")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN transport TEXT NOT NULL DEFAULT 'process'");
  }
  if (!names.has("http_status")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN http_status INTEGER");
  }
  if (!names.has("payload_json")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN payload_json TEXT");
  }
}

/** #192: add bounded normalized progress storage to legacy SQLite job tables. */
async function ensureJobsProgressColumn(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  if (!cols.some(col => col?.name === "progress_json")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN progress_json TEXT");
  }
}

/** #189: preserve typed async failure classification across gateway restarts. */
async function ensureJobsErrorClassificationColumns(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("error_category")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN error_category TEXT");
  }
  if (!names.has("retryable")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN retryable INTEGER");
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
async function ensureJobsLeaseColumns(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("owner_instance")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN owner_instance TEXT");
  }
  if (!names.has("owner_hostname")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN owner_hostname TEXT");
  }
  if (!names.has("lease_deadline")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN lease_deadline INTEGER");
  }
}

/**
 * Durable provenance for gateway-generated Claude MCP request artifacts. A
 * terminal row with `mcp_artifact_cleanup_pending=1` is intentionally retained
 * past its ordinary expiry until its own host confirms safe cleanup. Legacy
 * rows remain unpinned because they were created before exact-path provenance
 * existed.
 */
async function ensureJobsMcpArtifactCleanupColumns(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("mcp_artifact_path")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN mcp_artifact_path TEXT");
  }
  if (!names.has("mcp_artifact_scope")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN mcp_artifact_scope TEXT");
  }
  if (!names.has("mcp_artifact_cleanup_pending")) {
    await conn.execute(
      "ALTER TABLE jobs ADD COLUMN mcp_artifact_cleanup_pending INTEGER NOT NULL DEFAULT 0"
    );
  }
}

/**
 * Recover hostname provenance for rows written before migration 015 only while
 * their observability row is still available. Once that row has been GCed,
 * there is no safe way to infer which host owned the filesystem path, so the
 * NULL is intentionally retained and local artifact reconciliation fails
 * closed.
 */
async function backfillLegacyOwnerHostnames(conn: StorageConnection): Promise<void> {
  await conn.execute(`
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
async function ensureJobsCompressResponseColumn(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("compress_response")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN compress_response INTEGER");
  }
}

/**
 * Additive Kit migration. A JSON string preserves the immutable execution ref
 * without exposing individual fields as ad-hoc mutable columns. Legacy rows
 * remain NULL and therefore retain their exact disabled-mode behavior.
 */
async function ensureJobsKitExecutionColumn(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("kit_execution_json")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN kit_execution_json TEXT");
  }
}

/**
 * Additive Kit terminal-finalization migration. The session id lets a fresh
 * gateway instance map a completed provider run back to its gateway session;
 * the finalized marker is deliberately independent from job status so an
 * output can be durable before its session update succeeds.
 */
async function ensureJobsKitFinalizationColumns(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("kit_session_id")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN kit_session_id TEXT");
  }
  if (!names.has("kit_terminal_finalized")) {
    await conn.execute(
      "ALTER TABLE jobs ADD COLUMN kit_terminal_finalized INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (!names.has("kit_terminal_finalized_at")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN kit_terminal_finalized_at TEXT");
  }
}

/**
 * Privacy boundary for Kit terminal recovery. The additive migration also
 * removes legacy raw Kit output and arguments. Existing pre-upgrade provider
 * handles are intentionally retired rather than retaining instruction-derived
 * material in a durable database.
 */
async function ensureJobsKitTerminalMetadataColumn(conn: StorageConnection): Promise<void> {
  const cols = (await conn.query("PRAGMA table_info(jobs)")) as Array<{ name?: string }>;
  const names = new Set(cols.map(col => col?.name));
  if (!names.has("kit_terminal_metadata_json")) {
    await conn.execute("ALTER TABLE jobs ADD COLUMN kit_terminal_metadata_json TEXT");
  }
  // SQLite DDL can commit before a following data update. Run the scrub on
  // every open so a crash between the additive ALTER and this update heals on
  // the next startup instead of preserving legacy Kit context indefinitely.
  // The guarded predicate leaves already-clean rows untouched.
  await conn.execute(
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
  );
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
  }): Promise<void>;
  /**
   * Permanently reserve an unadmitted Kit attempt id. This is an atomic
   * insert-if-absent fence, not a job row: it is intentionally excluded from
   * terminal-finalization and retention paths. A false result means another
   * admission or recovery already owns the id, so callers must retain the
   * matching session attempt.
   */
  fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): Promise<KitAttemptFenceResult>;
  /**
   * #139: transition a durable `queued` row to `running`, stamp the real child
   * pid (process transport; null for http), and re-set the lease. Returns true
   * iff a queued row actually transitioned; false means the row was no longer
   * `queued` (e.g. already swept to `orphaned` while it waited in the limiter
   * queue), which the caller uses to fail-close a process launch.
   */
  markRunning(id: string, opts: { pid: number | null }): Promise<boolean>;
  /** #139: register this live instance (writes last_heartbeat = DB now). */
  registerInstance(meta: GatewayInstanceMeta): Promise<void>;
  /**
   * #139: advance this instance's own lease. Updates `last_heartbeat` on the
   * instance row AND `lease_deadline = db_now + leaseTtl` for every
   * `queued`/`running` job it owns, so heartbeat and sweep contend on the same
   * job rows.
   */
  heartbeat(instanceId: string): Promise<HeartbeatOutcome>;
  /** #139: remove this instance's `gateway_instances` row (graceful shutdown). */
  deregisterInstance(instanceId: string): Promise<void>;
  /**
   * #139: expired process-transport candidates for the advisory `kill(pid,0)`
   * check and same-host request-artifact cleanup. Queued/pre-spawn rows carry a
   * null pid and are not pid-probed. Read-only; does not mutate any row.
   */
  selectStaleProcessCandidates(
    leaseTtlMs: number,
    httpJobGraceMs: number
  ): Promise<SweepCandidate[]>;
  /**
   * #139: already-orphaned process rows whose durable owner-hostname snapshot
   * matches `hostname`. Used only by that host's startup reconciliation to
   * reclaim its own request-scoped artifacts. Read-only; never returns
   * remote/unknown hosts.
   */
  selectOrphanedProcessCandidates(hostname: string): Promise<SweepCandidate[]>;
  /**
   * Terminal Claude MCP artifacts awaiting local cleanup acknowledgement. This
   * capability is optional so older third-party JobStore implementations keep
   * their safe fail-closed behavior (the row remains retained instead).
   */
  selectPendingMcpArtifactCleanups?(hostname: string): Promise<PendingMcpArtifactCleanup[]>;
  /**
   * Compare-and-set acknowledgement for one exact origin-host artifact. An
   * acknowledgement only succeeds for a terminal row still marked pending.
   */
  acknowledgeMcpArtifactCleanup?(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): Promise<boolean>;
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
  ): Promise<OrphanedJobSnapshot[]>;
  /** #139: delete `gateway_instances` rows whose last_heartbeat is older than instanceGcMs. */
  gcInstances(instanceGcMs: number): Promise<number>;
  /**
   * Write output onto a row whose status is still one of `expectedStatuses`.
   *
   * The predicate is REQUIRED and there is no unfenced overload, because the
   * unfenced version was a monotonic-companion loss: the orphan sweep fences
   * status and snapshots stdout in one statement, `recordOutput` fenced
   * neither, and a flush arriving afterwards moved the body while the status
   * stayed `orphaned`. `llm_job_result` and `llm_request_result` could then
   * disagree, and the `Promise<void>` return meant 0-row versus 1-row was never
   * seen. Returns whether a row was written.
   *
   * This was unreachable in-process while the store was synchronous: a sweep
   * and a flush could not overlap on one event loop.
   */
  recordOutput(
    id: string,
    stdout: string,
    stderr: string,
    outputTruncated: boolean,
    expectedStatuses: readonly JobStoreStatus[]
  ): Promise<boolean>;
  /** Replace one job's complete bounded progress projection atomically. */
  recordProgress(id: string, progressJson: string): Promise<void>;
  /** Replace progress only while the durable row still has the expected status. */
  recordProgressIfStatus?(
    id: string,
    status: JobStoreStatus,
    progressJson: string
  ): Promise<boolean>;
  /**
   * Write the terminal row. Returns true when the row was actually written,
   * false when the completion guard rejected it because the row was already
   * terminal.
   *
   * A `false` is NOT a failure to retry: the terminal state is settled and the
   * caller must not replay `recordComplete`. It is also NOT an invitation to
   * force the same data in through `recordOutput`. A rejected guard means some
   * OTHER writer owns this row, and `recordOutput`'s status fence would reject
   * the write anyway, because the row is no longer in a state this instance
   * owns.
   * Only a caller whose own `recordComplete` returned true may follow up with
   * `recordOutput` to land output captured after the terminal write.
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
    /** Slice 1: real HTTP status for http jobs; null for process jobs. */
    httpStatus?: number | null;
    progressJson?: string | null;
    /** Compatibility input ignored at the durable persistence boundary. */
    kitTerminalMetadata?: PersonalKitTerminalMetadata | null;
  }): Promise<boolean>;
  getById(id: string): Promise<JobRecord | null>;
  findByRequestKey(requestKey: string): Promise<JobRecord | null>;
  /**
   * Terminal Kit jobs whose durable output has not yet been applied to their
   * gateway session. Used by the startup/retry reconciliation path only.
   */
  getPendingKitFinalizations(): Promise<PendingKitFinalization[]>;
  /**
   * Terminal Kit jobs acknowledged before a crash may retain their exact
   * session attempt. The periodic reconciler uses this to release only that
   * generation, never a newer attempt.
   */
  getAcknowledgedKitAttemptReleases(): Promise<AcknowledgedKitAttemptRelease[]>;
  /**
   * Compare-and-set the terminal-finalized marker after the session update
   * succeeds. The session id prevents a stale caller from finalizing a job for
   * a different gateway session.
   */
  markKitTerminalFinalized(id: string, kitSessionId: string): Promise<boolean>;
  /**
   * Active jobs and terminal Kit jobs awaiting finalization pin their immutable
   * releases. A release cannot be garbage-collected between a durable provider
   * result and its session-binding write.
   */
  getPinnedKitReleaseIds?(): Promise<string[]>;
  /** Alias with explicit release-GC language for callers outside the store. */
  getReferencedKitReleaseIds?(): Promise<string[]>;
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
  markOrphanedOnStartup(): Promise<{
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  }>;
  evictExpired(): Promise<number>;
  close(): Promise<void>;
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
  recordValidationRun(run: ValidationRunRecord): Promise<void>;
  getValidationRun(validationId: string): Promise<ValidationRunRecord | null>;
  /** Replace provider links after a pre-dispatch authorization row is established. */
  setValidationProviderLinks(
    validationId: string,
    providerLinks: ValidationRunLink[]
  ): Promise<void>;
  setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): Promise<void>;
  /** Owner-scoped compare-and-set used to open or fence a review roster. */
  transitionValidationRunStatus(
    validationId: string,
    ownerPrincipal: string,
    expectedStatus: ValidationRunRecord["status"],
    status: ValidationRunRecord["status"]
  ): Promise<boolean>;
  /** Atomically terminalize a planned review judge that cannot be dispatched. */
  skipValidationJudge(
    validationId: string,
    provider: string,
    ownerPrincipal: string
  ): Promise<void>;
  setValidationRunStatus(
    validationId: string,
    status: ValidationRunRecord["status"]
  ): Promise<void>;
  /** Reverse lookup for eager mint: which run owns this provider/judge job, if any. */
  getValidationRunIdByJobId(jobId: string): Promise<string | null>;
  /** Insert the immutable receipt once. Idempotent on validation_id (INSERT OR IGNORE). */
  recordValidationReceipt(receipt: ValidationReceiptRecord): Promise<void>;
  /**
   * Mint: insert the receipt, finalize the run, and read back the authoritative
   * row, in ONE transaction.
   *
   * The mint used to be three awaits. The insert is INSERT OR IGNORE and
   * returned void, the status write was an unfenced UPDATE with no expected
   * state and no row count, and the re-read fell back to the in-memory record.
   * So a receipt could exist with the run still `running`, or the run could
   * read `finalized` with no receipt row, and `stored ?? record` reported
   * `minted` for something that was never stored. Nothing could interleave
   * there while the store was synchronous.
   *
   * Throws if the run row is missing or owned by another principal, which rolls
   * the receipt back with it: there is no state where one landed and the other
   * did not. The returned record is always the stored row.
   */
  finalizeValidationReceipt(receipt: ValidationReceiptRecord): Promise<ValidationReceiptRecord>;
  getValidationReceipt(validationId: string): Promise<ValidationReceiptRecord | null>;
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
    typeof (store as ValidationRunStore).recordValidationReceipt === "function" &&
    typeof (store as ValidationRunStore).finalizeValidationReceipt === "function"
  );
}

/**
 * SQLite-backed job store. Default backend for production. Durable across
 * gateway restarts; safe for single-instance deployments.
 */
const SQL_INSERT = `
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
    `;

const SQL_INSERT_KIT_ATTEMPT_FENCE = `
      INSERT OR IGNORE INTO kit_attempt_fences
        (attempt_id, state, cli, kit_execution_json, kit_session_id, owner_principal, fenced_at)
      VALUES
        (@attempt_id, @state, @cli, @kit_execution_json, @kit_session_id, @owner_principal, @fenced_at)
    `;

const SQL_GET_KIT_ATTEMPT_FENCE = `
      SELECT state, cli, kit_execution_json, kit_session_id, owner_principal
      FROM kit_attempt_fences
      WHERE attempt_id = ?
    `;

const SQL_UPDATE_OUTPUT = `
      UPDATE jobs
      SET stdout = CASE WHEN kit_execution_json IS NULL THEN @stdout ELSE '' END,
          stderr = CASE WHEN kit_execution_json IS NULL THEN @stderr ELSE '' END,
          output_truncated = @output_truncated
      WHERE id = @id
        AND status IN (SELECT value FROM json_each(@expected_json))
    `;

const SQL_UPDATE_PROGRESS = `
      UPDATE jobs SET progress_json = @progress_json WHERE id = @id
    `;

const SQL_UPDATE_PROGRESS_IF_STATUS = `
      UPDATE jobs SET progress_json = @progress_json
      WHERE id = @id AND status = @status
    `;

const SQL_UPDATE_COMPLETE = `
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
    `;

const SQL_GET_BY_ID = `SELECT * FROM jobs WHERE id = ?`;

const SQL_SELECT_PENDING_KIT_FINALIZATIONS = `
      SELECT * FROM jobs
      WHERE kit_execution_json IS NOT NULL
        AND kit_session_id IS NOT NULL
        AND COALESCE(kit_terminal_finalized, 0) = 0
        AND status IN ('completed', 'failed', 'canceled')
      ORDER BY finished_at ASC, id ASC
    `;

const SQL_SELECT_ACKNOWLEDGED_KIT_ATTEMPT_RELEASES = `
      SELECT * FROM jobs
      WHERE kit_execution_json IS NOT NULL
        AND kit_session_id IS NOT NULL
        AND COALESCE(kit_terminal_finalized, 0) = 1
        AND status IN ('completed', 'failed', 'canceled')
      ORDER BY finished_at ASC, id ASC
    `;

const SQL_MARK_KIT_TERMINAL_FINALIZED = `
      UPDATE jobs
      SET kit_terminal_finalized = 1,
          kit_terminal_finalized_at = COALESCE(kit_terminal_finalized_at, @finalized_at)
      WHERE id = @id
        AND kit_session_id = @kit_session_id
        AND kit_execution_json IS NOT NULL
        AND status IN ('completed', 'failed', 'canceled')
    `;

const SQL_FIND_BY_REQUEST_KEY = `
      SELECT * FROM jobs
      WHERE request_key = ?
        AND started_at >= ?
        AND (
          status IN ('running', 'completed')
          OR (status = 'queued' AND lease_deadline IS NOT NULL AND lease_deadline >= ${SQLITE_NOW_MS})
        )
      ORDER BY started_at DESC
      LIMIT 1
    `;

const SQL_DELETE_EXPIRED = `
      DELETE FROM jobs
      WHERE expires_at < ?
        AND (
          kit_execution_json IS NULL
          OR COALESCE(kit_terminal_finalized, 0) = 1
        )
        AND COALESCE(mcp_artifact_cleanup_pending, 0) = 0
    `;

const SQL_MARK_RUNNING = `
      UPDATE jobs
      SET status = 'running', pid = @pid, lease_deadline = ${SQLITE_NOW_MS} + @lease_ttl_ms
      WHERE id = @id AND status = 'queued'
    `;

const SQL_REGISTER_INSTANCE = `
      INSERT INTO gateway_instances (instance_id, role, hostname, pid, started_at, last_heartbeat)
      VALUES (@instance_id, @role, @hostname, @pid, ${SQLITE_NOW_MS}, ${SQLITE_NOW_MS})
      ON CONFLICT(instance_id) DO UPDATE SET
        role = excluded.role, hostname = excluded.hostname, pid = excluded.pid,
        last_heartbeat = excluded.last_heartbeat
    `;

const SQL_HEARTBEAT_INSTANCE = `
      UPDATE gateway_instances SET last_heartbeat = ${SQLITE_NOW_MS} WHERE instance_id = @instance_id
    `;

const SQL_HEARTBEAT_JOBS = `
      UPDATE jobs SET lease_deadline = ${SQLITE_NOW_MS} + @lease_ttl_ms
      WHERE owner_instance = @instance_id AND status IN ('queued', 'running')
    `;

const SQL_DEREGISTER_INSTANCE = `DELETE FROM gateway_instances WHERE instance_id = @instance_id`;

const SQL_SELECT_STALE_CANDIDATES = `
      SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
             j.owner_instance AS owner_instance,
             COALESCE(j.owner_hostname, gi.hostname) AS hostname
      FROM jobs j
      LEFT JOIN gateway_instances gi ON gi.instance_id = j.owner_instance
      WHERE j.status IN ('queued', 'running')
        AND j.transport = 'process'
        AND (j.lease_deadline IS NULL OR j.lease_deadline < ${SQLITE_NOW_MS})
    `;

const SQL_SELECT_ORPHANED_CANDIDATES = `
      SELECT j.id AS id, j.pid AS pid, j.transport AS transport,
             j.owner_instance AS owner_instance, j.owner_hostname AS hostname
      FROM jobs j
      WHERE j.status = 'orphaned'
        AND j.transport = 'process'
        AND j.owner_hostname = @hostname
    `;

const SQL_SELECT_PENDING_MCP_ARTIFACT_CLEANUPS = `
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
    `;

const SQL_ACKNOWLEDGE_MCP_ARTIFACT_CLEANUP = `
      UPDATE jobs
      SET mcp_artifact_cleanup_pending = 0
      WHERE id = @id
        AND owner_hostname = @hostname
        AND mcp_artifact_scope = @artifact_scope
        AND mcp_artifact_path = @artifact_path
        AND COALESCE(mcp_artifact_cleanup_pending, 0) = 1
        AND status IN ('completed', 'failed', 'canceled', 'orphaned')
    `;

const SQL_ORPHAN_EXPIRED = `
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
    `;

const SQL_ADVANCE_LEASE = `
      UPDATE jobs SET lease_deadline = ${SQLITE_NOW_MS} + @lease_ttl_ms, pid = NULL
      WHERE status IN ('queued', 'running')
        AND id IN (SELECT value FROM json_each(@ids_json))
    `;

const SQL_GC_INSTANCES = `DELETE FROM gateway_instances WHERE last_heartbeat < ${SQLITE_NOW_MS} - @gc_ms`;

export class SqliteJobStore implements JobStore, ValidationRunStore {
  private readonly driver: SqliteStorageDriver;
  private readonly dbPath: string;
  private bootstrapPromise: Promise<void> | null = null;
  private closed = false;
  private retentionMs: number;
  private dedupWindowMs: number;
  /** #139: initial lease TTL used by recordStart/markRunning/heartbeat (ms). */
  private leaseTtlMs: number;

  constructor(
    dbPath: string,
    private logger: Logger = noopLogger,
    options: { retentionMs?: number; dedupWindowMs?: number; leaseTtlMs?: number } = {}
  ) {
    // openDatabase owns parent-directory creation (mkdirSync recursive), so the
    // job store no longer does its own mkdir. Any open/DDL failure throws to
    // the caller (createJobStore), matching the prior require/open behaviour.
    // The DRIVER owns the handle now. The store keeps no second write path:
    // that is the point of the port, and holding a GatewayDatabase alongside a
    // driver would put two independent writers on one file.
    this.driver = new SqliteStorageDriver(dbPath);
    this.dbPath = dbPath;
    this.retentionMs = options.retentionMs ?? resolveJobRetentionMs();
    this.dedupWindowMs = options.dedupWindowMs ?? resolveDedupWindowMs();
    this.leaseTtlMs = options.leaseTtlMs ?? DEFAULT_INSTANCE_LEASE_TTL_MS;

    // STARTED here, not awaited here. A constructor cannot await, but it can
    // begin the work, and the difference matters for one reason above all: the
    // legacy Kit privacy scrub runs inside this bootstrap. Deferring it to the
    // first store call would leave private Kit material readable by anything
    // looking directly at the file for as long as no operation happened. That
    // is an unbounded window and a contract change, not an implementation
    // detail, and "whenever SQLite reopens" is what the control asserts.
    //
    // Every operation still awaits ensureSchema(), so nothing can observe a
    // half-built schema. Starting early shortens the window; it does not remove
    // the barrier.
    void this.ensureSchema().catch(() => {
      // Swallowed HERE deliberately: the rejection is retained by the memo and
      // rethrown at the first operation that awaits it, which is where a caller
      // can be told. Letting it escape a constructor's async tail would be an
      // unhandled rejection with nobody to receive it.
    });
  }

  /**
   * Schema, PRAGMAs and the idempotent column migrations, run ONCE.
   *
   * Lazy for the same reason as the Postgres store: the port is asynchronous
   * and a constructor cannot await. The memo is installed BEFORE any await, so
   * two callers racing the first store call share one bootstrap instead of both
   * running the DDL. That race is not hypothetical: it is exactly the defect
   * review found in PostgresJobStore.
   *
   * Cleared on failure so a later call retries, rather than memoising a
   * rejection and refusing every later operation for the process lifetime.
   */
  private ensureSchema(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("SqliteJobStore is closed"));
    this.bootstrapPromise ??= this.bootstrapSchema().catch((error: unknown) => {
      this.bootstrapPromise = null;
      throw error;
    });
    return this.bootstrapPromise;
  }

  private async bootstrapSchema(): Promise<void> {
    // driver.bootstrap runs on the driver's own connection with transaction
    // control, OUTSIDE operation-class routing, because DDL is none of the four
    // classes. Same boundary as the Postgres driver, for the same reason.
    await this.driver.bootstrap(async conn => {
      await conn.execute("PRAGMA journal_mode = WAL");
      await conn.execute("PRAGMA synchronous = NORMAL");
      // #139: a shared-file sqlite DB (multiple gateway processes on one host) can
      // now have a heartbeat UPDATE and a sweep UPDATE contend for the write lock.
      // busy_timeout makes a blocked writer wait rather than fail immediately with
      // SQLITE_BUSY; the store also wraps heartbeat/sweep in a SQLITE_BUSY retry.
      await conn.execute("PRAGMA busy_timeout = 5000");

      await conn.executeScript(`
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
      await conn.executeScript(`
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
      await conn.executeScript(`
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
      await ensureJobsOwnerColumn(conn);
      // Slice 1: idempotent migration for the http-transport columns. MUST run
      // before the prepared statements below bind to the column list.
      await ensureJobsTransportColumns(conn);
      await ensureJobsProgressColumn(conn);
      await ensureJobsErrorClassificationColumns(conn);
      // #139: idempotent migration for durable ownership and lease columns.
      // Same must-run-before-prepare ordering.
      await ensureJobsLeaseColumns(conn);
      // Exact-path request-artifact provenance must exist before the INSERT and
      // retention statements below are prepared.
      await ensureJobsMcpArtifactCleanupColumns(conn);
      // Migration 017 equivalent for SQLite stores: repair only the rows whose
      // retained instance metadata can prove their old hostname.
      await backfillLegacyOwnerHostnames(conn);
      // #139: the owner/status index references owner_instance, so it can only be
      // created AFTER ensureJobsLeaseColumns adds that column to a legacy table.
      await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status)"
      );
      await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_jobs_owner_hostname_status ON jobs(owner_hostname, status)"
      );
      await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_cleanup ON jobs(owner_hostname, mcp_artifact_cleanup_pending, status)"
      );
      await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_scope_cleanup ON jobs(owner_hostname, mcp_artifact_scope, mcp_artifact_cleanup_pending, status)"
      );
      // Native compressor PR-1: nullable compress_response column.
      await ensureJobsCompressResponseColumn(conn);
      // Personal Agent Config Kit: nullable immutable execution identity.
      await ensureJobsKitExecutionColumn(conn);
      // Personal Agent Config Kit: restart-safe terminal session finalization.
      await ensureJobsKitFinalizationColumns(conn);
      // Personal Agent Config Kit: compatibility column, scrubbed to NULL.
      await ensureJobsKitTerminalMetadataColumn(conn);
      await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_jobs_kit_finalization ON jobs(kit_terminal_finalized, status)"
      );
    });

    if (process.platform !== "win32") {
      try {
        chmodSync(this.dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }
  }

  /**
   * Every statement now goes through the port. The `changes` shape is preserved
   * because every caller reads `result.changes`, so no call site changed.
   *
   * `conn` is passed when the caller is already inside a transaction; otherwise
   * the write gets its own. Writes go through `transaction()` rather than
   * `withConnection`, because withConnection is deliberately NOT on the
   * driver's queue and two concurrent writers would otherwise interleave.
   */
  private async execSql(
    sql: string,
    params: readonly unknown[] = [],
    conn?: StorageConnection
  ): Promise<{ changes: number }> {
    const run = async (c: StorageConnection): Promise<{ changes: number }> => ({
      changes: (await c.execute(sql, params)).rowsAffected,
    });
    if (conn) return run(conn);
    await this.ensureSchema();
    return this.driver.transaction("write", run);
  }

  /**
   * The one job-store statement that is NOT `write`.
   *
   * postgres-security-hardening.md 4.3 rules that job expiry is a retention
   * operation and routes to `llmgw_retention`, which is what lets `llmgw_app`
   * hold no `DELETE` on `jobs` at all. Kept as its own method rather than a
   * defaulted operation-class parameter on `execSql`, so the exception is
   * visible at the call site instead of being a parameter 40 other callers
   * silently leave at `write`.
   *
   * On SQLite this changes nothing observable: `READ_ONLY_OPERATIONS` in
   * drivers/sqlite.ts is {transcript_read, analytics_read}, so `retention`
   * resolves to the same writable handle and nothing here newly touches
   * `openReadOnly`. Moving a READ class would be the different question.
   */
  private async execRetentionSql(
    sql: string,
    params: readonly unknown[] = []
  ): Promise<{ changes: number }> {
    await this.ensureSchema();
    return this.driver.transaction("retention", async c => ({
      changes: (await c.execute(sql, params)).rowsAffected,
    }));
  }

  private async allSql<T>(
    sql: string,
    params: readonly unknown[] = [],
    conn?: StorageConnection
  ): Promise<T[]> {
    if (conn) return conn.query<T>(sql, params);
    await this.ensureSchema();
    return this.driver.withConnection("write", c => c.query<T>(sql, params));
  }

  private async getSql<T>(
    sql: string,
    params: readonly unknown[] = [],
    conn?: StorageConnection
  ): Promise<T | undefined> {
    return (await this.allSql<T>(sql, params, conn))[0];
  }

  /**
   * Insert a new running job row. Caller has already computed requestKey.
   */
  async recordStart(input: {
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
  }): Promise<void> {
    assertMcpArtifactAdmissionInvariant(input);
    const insertJob = async (conn?: StorageConnection): Promise<void> => {
      await this.execSql(
        SQL_INSERT,
        [
          {
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
          },
        ],
        conn
      );
    };
    if (!input.kitExecution && !input.validationAdmission) {
      // No connection: a lone insert takes its own transaction.
      await insertJob();
      return;
    }
    if (input.validationAdmission) {
      if (input.kitExecution) {
        throw new Error("Validation job admission cannot be combined with a Kit execution");
      }
      const run = () =>
        this.driver.transaction("write", async conn => {
          await insertJob(conn);
          await this.appendValidationJobLink(
            input.validationAdmission!,
            {
              provider: input.validationAdmission!.provider,
              jobId: input.id,
              correlationId: input.correlationId,
            },
            input.ownerPrincipal ?? null,
            conn
          );
        });
      await run();
      return;
    }
    const kitSessionId = input.kitSessionId?.trim();
    if (!kitSessionId) {
      throw new Error("Kit job admission requires a gateway kitSessionId");
    }
    const run = () =>
      this.driver.transaction("write", async conn => {
        if (
          !(await this.insertKitAttemptFence(
            {
              attemptId: input.id,
              state: "admitted",
              cli: input.cli,
              kitExecution: input.kitExecution!,
              kitSessionId,
              ownerPrincipal: input.ownerPrincipal,
              fencedAt: input.startedAt,
            },
            conn
          ))
        ) {
          throw new Error(`Kit job id ${input.id} is already admitted or permanently recovered`);
        }
        await insertJob(conn);
      });
    await run();
  }

  private async appendValidationJobLink(
    admission: ValidationJobAdmission,
    link: ValidationRunLink,
    ownerPrincipal: string | null,
    conn?: StorageConnection
  ): Promise<void> {
    const row = (await this.getSql(
      `SELECT owner_principal, intent, request_json, provider_links, judge_link, status
         FROM validation_runs WHERE validation_id = ?`,
      [admission.validationId],
      conn
    )) as
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
      await this.execSql(
        `UPDATE validation_runs SET judge_link = ? WHERE validation_id = ?`,
        [JSON.stringify(link), admission.validationId],
        conn
      );
      await this.execSql(
        `INSERT INTO validation_run_jobs (job_id, validation_id, role)
           VALUES (?, ?, 'judge')`,
        [link.jobId, admission.validationId],
        conn
      );
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
    await this.execSql(
      `UPDATE validation_runs SET provider_links = ? WHERE validation_id = ?`,
      [JSON.stringify(providerLinks), admission.validationId],
      conn
    );
    await this.execSql(
      `INSERT INTO validation_run_jobs (job_id, validation_id, role)
         VALUES (?, ?, 'provider')`,
      [link.jobId, admission.validationId],
      conn
    );
  }

  /** Atomically reserve a never-reusable pre-admission attempt id for recovery. */
  async fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): Promise<KitAttemptFenceResult> {
    const inserted = await this.insertKitAttemptFence({ ...input, state: "recovered" });
    if (inserted) return "reserved";
    const existing = (await this.getSql(SQL_GET_KIT_ATTEMPT_FENCE, [input.attemptId])) as
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

  private async insertKitAttemptFence(
    input: KitAttemptFenceInput & { state: "admitted" | "recovered" },
    conn?: StorageConnection
  ): Promise<boolean> {
    const result = await this.execSql(
      SQL_INSERT_KIT_ATTEMPT_FENCE,
      [
        {
          attempt_id: input.attemptId,
          state: input.state,
          cli: input.cli,
          kit_execution_json: JSON.stringify(cloneKitExecutionRef(input.kitExecution)),
          kit_session_id: input.kitSessionId,
          owner_principal: input.ownerPrincipal ?? null,
          fenced_at: input.fencedAt,
        },
      ],
      conn
    );
    return Number(result.changes) === 1;
  }

  async markRunning(id: string, opts: { pid: number | null }): Promise<boolean> {
    // Returns true iff a queued row actually transitioned to running. A zero-row
    // result means the durable row is no longer queued (e.g. another instance
    // already swept it to 'orphaned' while it waited in the limiter queue); the
    // caller uses this to fail-close a process launch rather than run a child
    // against a recovered row.
    const result = await this.execSql(SQL_MARK_RUNNING, [
      {
        id,
        pid: opts.pid,
        lease_ttl_ms: this.leaseTtlMs,
      },
    ]);
    return Number(result.changes) > 0;
  }

  async registerInstance(meta: GatewayInstanceMeta): Promise<void> {
    await this.execSql(SQL_REGISTER_INSTANCE, [
      {
        instance_id: meta.instanceId,
        role: meta.role ?? null,
        hostname: meta.hostname ?? null,
        pid: meta.pid ?? null,
      },
    ]);
  }

  async heartbeat(instanceId: string): Promise<HeartbeatOutcome> {
    // Advance the observability row AND the authoritative per-job lease. The
    // job-lease UPDATE is what serializes against the sweep on the row lock.
    //
    // ONE transaction, matching Postgres. As two, each `execSql` opened its own
    // `driver.transaction("write")` and the sweep could commit between them:
    // tx1 said the instance was alive, the sweep orphaned its jobs, and tx2's
    // `WHERE status IN ('queued','running')` then matched nothing. The instance
    // was alive and its jobs were orphaned, and the `void` return meant nobody
    // learned. Two `.run()` calls with no yield between them could not do this.
    await this.ensureSchema();
    return this.driver.transaction("write", async conn => {
      const instance = await this.execSql(
        SQL_HEARTBEAT_INSTANCE,
        [{ instance_id: instanceId }],
        conn
      );
      const leases = await this.execSql(
        SQL_HEARTBEAT_JOBS,
        [{ instance_id: instanceId, lease_ttl_ms: this.leaseTtlMs }],
        conn
      );
      return {
        instanceRowRefreshed: Number(instance.changes) > 0,
        jobLeasesAdvanced: Number(leases.changes),
      };
    });
  }

  async deregisterInstance(instanceId: string): Promise<void> {
    await this.execSql(SQL_DEREGISTER_INSTANCE, [{ instance_id: instanceId }]);
  }

  async selectStaleProcessCandidates(
    _leaseTtlMs: number,
    _httpJobGraceMs: number
  ): Promise<SweepCandidate[]> {
    const rows = (await this.allSql(SQL_SELECT_STALE_CANDIDATES, [])) as Array<{
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

  async selectOrphanedProcessCandidates(hostname: string): Promise<SweepCandidate[]> {
    const rows = (await this.allSql(SQL_SELECT_ORPHANED_CANDIDATES, [{ hostname }])) as Array<{
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

  async selectPendingMcpArtifactCleanups(hostname: string): Promise<PendingMcpArtifactCleanup[]> {
    const rows = (await this.allSql(SQL_SELECT_PENDING_MCP_ARTIFACT_CLEANUPS, [
      { hostname },
    ])) as Array<{
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

  async acknowledgeMcpArtifactCleanup(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): Promise<boolean> {
    const result = await this.execSql(SQL_ACKNOWLEDGE_MCP_ARTIFACT_CLEANUP, [
      {
        id,
        hostname,
        artifact_scope: artifactScope,
        artifact_path: artifactPath,
      },
    ]);
    return Number(result.changes) === 1;
  }

  async recoverStaleJobs(
    leaseTtlMs: number,
    httpJobGraceMs: number,
    liveConfirmedIds: string[] = []
  ): Promise<OrphanedJobSnapshot[]> {
    const excludeJson = JSON.stringify(liveConfirmedIds);
    const httpGraceModifier = `-${httpJobGraceMs / 1000} seconds`;
    // One atomic unit: advance (+clear pid on) the advisory-live rows, then flip
    // the remaining expired rows to orphaned with a SINGLE guarded UPDATE ...
    // RETURNING whose WHERE re-evaluates the lease/http-grace predicate. No
    // SELECT-then-blind-flip window: a heartbeat or completion that lands before
    // the flip is not stomped (the predicate simply misses that row).
    // withTransaction forwards the callback's return value (the orphaned list).
    const run = () =>
      this.driver.transaction("write", async conn => {
        if (liveConfirmedIds.length > 0) {
          await this.execSql(
            SQL_ADVANCE_LEASE,
            [{ ids_json: excludeJson, lease_ttl_ms: leaseTtlMs }],
            conn
          );
        }
        const nowIso = new Date().toISOString();
        const expiresAt = new Date(Date.now() + this.retentionMs).toISOString();
        const rows = (await this.allSql(
          SQL_ORPHAN_EXPIRED,
          [
            {
              now_iso: nowIso,
              expires_iso: expiresAt,
              http_grace_modifier: httpGraceModifier,
              exclude_json: excludeJson,
            },
          ],
          conn
        )) as Array<{
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

  async gcInstances(instanceGcMs: number): Promise<number> {
    const result = await this.execSql(SQL_GC_INSTANCES, [{ gc_ms: instanceGcMs }]);
    return Number(result.changes);
  }

  /**
   * Batched output flush. Cheap to call repeatedly; node:sqlite is sync.
   */
  async recordOutput(
    id: string,
    stdout: string,
    stderr: string,
    outputTruncated: boolean,
    expectedStatuses: readonly JobStoreStatus[]
  ): Promise<boolean> {
    const result = await this.execSql(SQL_UPDATE_OUTPUT, [
      {
        id,
        stdout,
        stderr,
        output_truncated: outputTruncated ? 1 : 0,
        expected_json: JSON.stringify([...expectedStatuses]),
      },
    ]);
    return Number(result.changes) > 0;
  }

  async recordProgress(id: string, progressJson: string): Promise<void> {
    await this.execSql(SQL_UPDATE_PROGRESS, [{ id, progress_json: progressJson }]);
  }

  async recordProgressIfStatus(
    id: string,
    status: JobStoreStatus,
    progressJson: string
  ): Promise<boolean> {
    const result = await this.execSql(SQL_UPDATE_PROGRESS_IF_STATUS, [
      {
        id,
        status,
        progress_json: progressJson,
      },
    ]);
    return Number(result.changes) === 1;
  }

  /**
   * Mark a job as completed/failed/canceled. Sets expires_at = now + retention.
   */
  async recordComplete(input: {
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
  }): Promise<boolean> {
    const expiresAt = new Date(Date.parse(input.finishedAt) + this.retentionMs).toISOString();
    const result = await this.execSql(SQL_UPDATE_COMPLETE, [
      {
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
      },
    ]);
    return Number(result.changes) === 1;
  }

  async getById(id: string): Promise<JobRecord | null> {
    const row = await this.getSql(SQL_GET_BY_ID, [id]);
    return row ? rowToRecord(row) : null;
  }

  /**
   * Returns the most recent matching job within the dedup window, if any.
   * Caller pre-filters out forceRefresh requests.
   */
  async findByRequestKey(requestKey: string): Promise<JobRecord | null> {
    const cutoff = new Date(Date.now() - this.dedupWindowMs).toISOString();
    const row = await this.getSql(SQL_FIND_BY_REQUEST_KEY, [requestKey, cutoff]);
    return row ? rowToRecord(row) : null;
  }

  async getPendingKitFinalizations(): Promise<PendingKitFinalization[]> {
    const rows = await this.allSql(SQL_SELECT_PENDING_KIT_FINALIZATIONS, []);
    return rows
      .map(row => toPendingKitFinalization(rowToRecord(row)))
      .filter((entry): entry is PendingKitFinalization => entry !== null);
  }

  async getAcknowledgedKitAttemptReleases(): Promise<AcknowledgedKitAttemptRelease[]> {
    const rows = await this.allSql(SQL_SELECT_ACKNOWLEDGED_KIT_ATTEMPT_RELEASES, []);
    return rows
      .map(row => toAcknowledgedKitAttemptRelease(rowToRecord(row)))
      .filter((entry): entry is AcknowledgedKitAttemptRelease => entry !== null);
  }

  async markKitTerminalFinalized(id: string, kitSessionId: string): Promise<boolean> {
    const result = await this.execSql(SQL_MARK_KIT_TERMINAL_FINALIZED, [
      {
        id,
        kit_session_id: kitSessionId,
        finalized_at: new Date().toISOString(),
      },
    ]);
    return Number(result.changes) > 0;
  }

  async getPinnedKitReleaseIds(conn?: StorageConnection): Promise<string[]> {
    const rows = (await this.allSql(
      `SELECT kit_execution_json FROM jobs
         WHERE kit_execution_json IS NOT NULL
           AND (
             status IN ('queued', 'running')
             OR (
               status NOT IN ('queued', 'running')
               AND COALESCE(kit_terminal_finalized, 0) = 0
             )
           )`,
      [],
      conn
    )) as Array<{ kit_execution_json?: string | null }>;
    const releases = new Set<string>();
    for (const row of rows) {
      const execution = parseKitExecution(row.kit_execution_json);
      if (execution) releases.add(execution.releaseId);
    }
    return [...releases].sort();
  }

  async getReferencedKitReleaseIds(): Promise<string[]> {
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
  async markOrphanedOnStartup(): Promise<{
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  }> {
    const orphaned = await this.recoverStaleJobs(this.leaseTtlMs, DEFAULT_HTTP_JOB_GRACE_MS);
    return { count: orphaned.length, orphaned };
  }

  /**
   * Delete rows whose expires_at has passed. Returns number of rows deleted.
   */
  async evictExpired(): Promise<number> {
    const now = new Date().toISOString();
    const result = await this.execRetentionSql(SQL_DELETE_EXPIRED, [now]);
    return Number(result.changes);
  }

  // --- ValidationRunStore (cross-LLM validation receipts, Phase 0) ---

  async recordValidationRun(run: ValidationRunRecord, conn?: StorageConnection): Promise<void> {
    // INSERT OR IGNORE: kickoff writes once; a re-run with the same validation_id
    // (a randomUUID collision is effectively impossible, but the guard keeps the
    // write idempotent and race-safe) is a no-op rather than an overwrite.
    await this.execSql(
      `INSERT OR IGNORE INTO validation_runs
           (validation_id, owner_principal, intent, created_at, request_json,
            provider_links, judge_link, status)
         VALUES (@validation_id, @owner_principal, @intent, @created_at, @request_json,
                 @provider_links, @judge_link, @status)`,
      [
        {
          validation_id: run.validationId,
          owner_principal: run.ownerPrincipal,
          intent: run.intent,
          created_at: run.createdAt,
          request_json: run.requestJson,
          provider_links: JSON.stringify(run.providerLinks),
          judge_link: run.judgeLink ? JSON.stringify(run.judgeLink) : null,
          status: run.status,
        },
      ],
      conn
    );
    // Populate the reverse index so eager mint can resolve the run from a
    // collected provider job id. INSERT OR IGNORE keeps it idempotent.
    for (const link of run.providerLinks) {
      await this.linkRunJob(run.validationId, link.jobId, "provider", conn);
    }
  }

  private async linkRunJob(
    validationId: string,
    jobId: string,
    role: "provider" | "judge",
    conn?: StorageConnection
  ): Promise<void> {
    await this.execSql(
      `INSERT OR IGNORE INTO validation_run_jobs (job_id, validation_id, role)
         VALUES (?, ?, ?)`,
      [jobId, validationId, role],
      conn
    );
  }

  async getValidationRunIdByJobId(jobId: string, conn?: StorageConnection): Promise<string | null> {
    const row = (await this.getSql(
      `SELECT validation_id FROM validation_run_jobs WHERE job_id = ?`,
      [jobId],
      conn
    )) as { validation_id?: string } | undefined;
    return row?.validation_id ?? null;
  }

  async getValidationRun(
    validationId: string,
    conn?: StorageConnection
  ): Promise<ValidationRunRecord | null> {
    const row = await this.getSql(
      `SELECT * FROM validation_runs WHERE validation_id = ?`,
      [validationId],
      conn
    );
    return row ? rowToValidationRunRecord(row) : null;
  }

  async setValidationProviderLinks(
    validationId: string,
    providerLinks: ValidationRunLink[]
  ): Promise<void> {
    await this.ensureSchema();
    await this.driver.transaction("write", async tx => {
      const result = await this.execSql(
        `UPDATE validation_runs SET provider_links = ? WHERE validation_id = ?`,
        [JSON.stringify(providerLinks), validationId],
        tx
      );
      if (Number(result.changes) !== 1) {
        throw new Error(`Unknown validation run: ${validationId}`);
      }
      await this.execSql(
        `DELETE FROM validation_run_jobs WHERE validation_id = ? AND role = 'provider'`,
        [validationId],
        tx
      );
      for (const link of providerLinks) {
        await this.execSql(
          `INSERT INTO validation_run_jobs (job_id, validation_id, role)
       VALUES (?, ?, 'provider')`,
          [link.jobId, validationId],
          tx
        );
      }
    });
  }

  async setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): Promise<void> {
    await this.driver.transaction("write", async conn => {
      const result = await this.execSql(
        `UPDATE validation_runs SET judge_link = ?
           WHERE validation_id = ?
             AND status = 'running'
             AND judge_link IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM validation_receipts WHERE validation_id = ?
             )`,
        [JSON.stringify(judgeLink), validationId, validationId],
        conn
      );
      if (Number(result.changes) !== 1) {
        throw new Error("Validation judge link is not open for a one-shot claim");
      }
      await this.linkRunJob(validationId, judgeLink.jobId, "judge", conn);
    });
  }

  async transitionValidationRunStatus(
    validationId: string,
    ownerPrincipal: string,
    expectedStatus: ValidationRunRecord["status"],
    status: ValidationRunRecord["status"],
    conn?: StorageConnection
  ): Promise<boolean> {
    const result = await this.execSql(
      `UPDATE validation_runs SET status = ?
         WHERE validation_id = ? AND owner_principal = ? AND status = ?`,
      [status, validationId, ownerPrincipal, expectedStatus],
      conn
    );
    return Number(result.changes) === 1;
  }

  async skipValidationJudge(
    validationId: string,
    provider: string,
    ownerPrincipal: string
  ): Promise<void> {
    await this.driver.transaction("write", async conn => {
      const row = (await this.getSql(
        `SELECT owner_principal, intent, request_json, judge_link, status
           FROM validation_runs WHERE validation_id = ?`,
        [validationId],
        conn
      )) as
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
      await this.execSql(
        `UPDATE validation_runs SET status = 'judge_skipped' WHERE validation_id = ?`,
        [validationId],
        conn
      );
    });
  }

  async setValidationRunStatus(
    validationId: string,
    status: ValidationRunRecord["status"],
    conn?: StorageConnection
  ): Promise<void> {
    await this.execSql(
      `UPDATE validation_runs SET status = ? WHERE validation_id = ?`,
      [status, validationId],
      conn
    );
  }

  async recordValidationReceipt(
    receipt: ValidationReceiptRecord,
    conn?: StorageConnection
  ): Promise<void> {
    // INSERT OR IGNORE: the receipt is immutable and minted exactly once. A
    // concurrent or repeat mint for the same validation_id is a no-op; callers
    // re-read to get the authoritative stored row.
    await this.execSql(
      `INSERT OR IGNORE INTO validation_receipts
           (validation_id, owner_principal, minted_at, schema_version, report_json,
            canonical_sha256, prev_sha256, seq, signature, models,
            has_material_disagreement, confidence)
         VALUES (@validation_id, @owner_principal, @minted_at, @schema_version, @report_json,
                 @canonical_sha256, @prev_sha256, @seq, @signature, @models,
                 @has_material_disagreement, @confidence)`,
      [
        {
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
        },
      ],
      conn
    );
  }

  async finalizeValidationReceipt(
    receipt: ValidationReceiptRecord
  ): Promise<ValidationReceiptRecord> {
    await this.ensureSchema();
    return this.driver.transaction("write", async conn => {
      await this.recordValidationReceipt(receipt, conn);
      const finalized = await this.execSql(
        `UPDATE validation_runs SET status = 'finalized'
           WHERE validation_id = ? AND owner_principal = ?`,
        [receipt.validationId, receipt.ownerPrincipal],
        conn
      );
      if (Number(finalized.changes) !== 1) {
        throw new Error(
          `Validation run ${receipt.validationId} is missing or owned by another principal; ` +
            `the receipt was not minted`
        );
      }
      const stored = await this.getValidationReceipt(receipt.validationId, conn);
      if (!stored) {
        throw new Error(
          `Validation receipt for ${receipt.validationId} was not readable after its own insert`
        );
      }
      return stored;
    });
  }

  async getValidationReceipt(
    validationId: string,
    conn?: StorageConnection
  ): Promise<ValidationReceiptRecord | null> {
    const row = await this.getSql(
      `SELECT * FROM validation_receipts WHERE validation_id = ?`,
      [validationId],
      conn
    );
    return row ? rowToValidationReceiptRecord(row) : null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // Set BEFORE the await so a racing call is refused rather than reaching a
    // driver that is shutting down, and JOIN an in-flight bootstrap first: the
    // Postgres store had exactly this hole, where close() could return while
    // initialisation was still going and leave a live handle behind.
    this.closed = true;
    if (this.bootstrapPromise) await this.bootstrapPromise.catch(() => undefined);
    try {
      // The driver's close() drains its queue within a bound and REJECTS any
      // transaction it could not land, rather than dropping it silently.
      await this.driver.close();
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

  async recordStart(input: {
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
  }): Promise<void> {
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

  async fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): Promise<KitAttemptFenceResult> {
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

  async markRunning(id: string, opts: { pid: number | null }): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== "queued") return false;
    row.status = "running";
    row.pid = opts.pid;
    row.leaseDeadline = Date.now() + this.leaseTtlMs;
    return true;
  }

  // #139: instance registration is a no-op for the in-process store (there is
  // only ever one owner and no cross-process visibility).
  async registerInstance(_meta: GatewayInstanceMeta): Promise<void> {}

  async heartbeat(instanceId: string): Promise<HeartbeatOutcome> {
    // Still advance in-memory leases for parity (harmless; recover is a no-op).
    const deadline = Date.now() + this.leaseTtlMs;
    let jobLeasesAdvanced = 0;
    for (const row of this.rows.values()) {
      if (
        row.ownerInstance === instanceId &&
        (row.status === "queued" || row.status === "running")
      ) {
        row.leaseDeadline = deadline;
        jobLeasesAdvanced++;
      }
    }
    // There is no instance table in-process, and one owner by construction.
    return { instanceRowRefreshed: true, jobLeasesAdvanced };
  }

  async deregisterInstance(_instanceId: string): Promise<void> {}

  async selectStaleProcessCandidates(
    _leaseTtlMs: number,
    _httpJobGraceMs: number
  ): Promise<SweepCandidate[]> {
    return [];
  }

  async selectOrphanedProcessCandidates(_hostname: string): Promise<SweepCandidate[]> {
    return [];
  }

  async selectPendingMcpArtifactCleanups(hostname: string): Promise<PendingMcpArtifactCleanup[]> {
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

  async acknowledgeMcpArtifactCleanup(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): Promise<boolean> {
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
  async recoverStaleJobs(
    _leaseTtlMs: number,
    _httpJobGraceMs: number,
    _liveConfirmedIds?: string[]
  ): Promise<OrphanedJobSnapshot[]> {
    return [];
  }

  async gcInstances(_instanceGcMs: number): Promise<number> {
    return 0;
  }

  async recordOutput(
    id: string,
    stdout: string,
    stderr: string,
    outputTruncated: boolean,
    expectedStatuses: readonly JobStoreStatus[]
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row) return false;
    if (!expectedStatuses.includes(row.status)) return false;
    row.stdout = row.kitExecution ? "" : stdout;
    row.stderr = row.kitExecution ? "" : stderr;
    row.outputTruncated = outputTruncated;
    return true;
  }

  async recordProgress(id: string, progressJson: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.progressJson = progressJson;
  }

  async recordProgressIfStatus(
    id: string,
    status: JobStoreStatus,
    progressJson: string
  ): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.status !== status) return false;
    row.progressJson = progressJson;
    return true;
  }

  async recordComplete(input: {
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
  }): Promise<boolean> {
    const row = this.rows.get(input.id);
    if (!row) return false;
    // #139: guarded completion, mirroring the sqlite WHERE guard. A terminal
    // result may land on an open (queued/running) row or a mistakenly-orphaned
    // row, but is a no-op on an already-terminal row (last terminal state wins).
    if (row.status !== "queued" && row.status !== "running" && row.status !== "orphaned") {
      return false;
    }
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
    return true;
  }

  async getById(id: string): Promise<JobRecord | null> {
    const row = this.rows.get(id);
    return row ? cloneJobRecord(row) : null;
  }

  async findByRequestKey(requestKey: string): Promise<JobRecord | null> {
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

  async getPendingKitFinalizations(): Promise<PendingKitFinalization[]> {
    return [...this.rows.values()]
      .map(toPendingKitFinalization)
      .filter((entry): entry is PendingKitFinalization => entry !== null)
      .sort((a, b) => a.finishedAt.localeCompare(b.finishedAt) || a.jobId.localeCompare(b.jobId));
  }

  async getAcknowledgedKitAttemptReleases(): Promise<AcknowledgedKitAttemptRelease[]> {
    return [...this.rows.values()]
      .map(toAcknowledgedKitAttemptRelease)
      .filter((entry): entry is AcknowledgedKitAttemptRelease => entry !== null)
      .sort((a, b) => a.jobId.localeCompare(b.jobId));
  }

  async markKitTerminalFinalized(id: string, kitSessionId: string): Promise<boolean> {
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

  async getPinnedKitReleaseIds(): Promise<string[]> {
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

  async getReferencedKitReleaseIds(): Promise<string[]> {
    return this.getPinnedKitReleaseIds();
  }

  /**
   * In-memory stores have no cross-process state, so any "running" rows here
   * came from this very process and aren't actually orphaned. No-op.
   */
  async markOrphanedOnStartup(): Promise<{
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  }> {
    return { count: 0, orphaned: [] };
  }

  async evictExpired(): Promise<number> {
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

  async close(): Promise<void> {
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
  private readonly dsn: string;
  private readonly roleDsns: PostgresRoleDsns;
  private readonly config: PostgresJobStoreOpsConfig;
  private driver: PostgresStorageDriver | null = null;
  private ops: PostgresJobStoreOps | null = null;
  private startupPromise: Promise<PostgresJobStoreOps> | null = null;
  private closed = false;

  constructor(
    dsn: string,
    private logger: Logger = noopLogger,
    options: {
      retentionMs?: number;
      dedupWindowMs?: number;
      leaseTtlMs?: number;
      roleDsns?: PostgresRoleDsns;
    } = {}
  ) {
    if (!dsn) {
      throw new Error("PostgresJobStore requires a non-empty DSN");
    }
    this.dsn = dsn;
    // `app` last, so `[persistence].dsn` is the single source for it however the
    // map arrived. The other three are only ever present when an operator wrote
    // `[persistence.roles]`.
    this.roleDsns = { ...options.roleDsns, app: dsn };
    this.config = {
      retentionMs: options.retentionMs ?? resolveJobRetentionMs(),
      dedupWindowMs: options.dedupWindowMs ?? resolveDedupWindowMs(),
      leaseTtlMs: options.leaseTtlMs ?? DEFAULT_INSTANCE_LEASE_TTL_MS,
      farFutureIso: FAR_FUTURE_ISO,
    };

    // STARTED here, not awaited here, matching SqliteJobStore.
    //
    // Review's objection to first-use initialisation was not about style: the
    // legacy Kit privacy scrub runs inside init(), so deferring it until the
    // first store call leaves private Kit material readable by any direct
    // database reader for as long as no operation happens. That window is
    // unbounded, and it is a contract change rather than an implementation
    // detail. Starting at construction bounds it to the bootstrap itself.
    //
    // Every operation still awaits ensureInit(), so nothing observes a
    // half-initialised store; starting early shortens the window without
    // weakening the barrier. The retry-on-failure behaviour is unchanged.
    void this.ensureInit().catch(() => {
      // Swallowed HERE only. The rejection is retained by the memo and rethrown
      // at the first operation that awaits it, which is where a caller can be
      // told; letting it escape the constructor would be an unhandled rejection
      // with no recipient.
    });
  }

  /**
   * Build the driver and run the schema bootstrap once, and RETRY after failure.
   *
   * Lazy because the pool factory imports the optional `pg` peer dynamically
   * and a constructor cannot await. This is NOT the sync-over-async being
   * removed: nothing blocks, and every JobStore method is asynchronous now, so
   * the first call simply awaits the setup it needs.
   *
   * Retry-on-failure is carried over deliberately. A worker whose bootstrap
   * failed was retired and `ensureWorker` built a fresh one, so a later
   * heartbeat retried the full init. Memoising a rejected promise instead would
   * poison every later call for the life of the process.
   *
   * BEHAVIOUR CHANGE, stated rather than buried. The worker ran init from the
   * constructor, so a misconfigured Postgres threw at construction and
   * getJobStore nulled the store. It no longer does; the first store call
   * rejects instead. That is not a weakening: `asyncJobsEnabled` is derived
   * from config and not from store-open success, so the old path registered the
   * async tools anyway and handed AsyncJobManager a null store, which is
   * exactly the silent in-memory fallback this programme exists to remove.
   * Failing the call is fail-closed; nulling the store was not.
   */
  private async ensureInit(): Promise<PostgresJobStoreOps> {
    if (this.closed) throw new Error("PostgresJobStore is closed");
    // The memo is installed BEFORE any await, which is the whole point.
    //
    // A first version awaited the pool factory INSIDE an `if (!this.ops)` guard
    // and only then assigned the memo. Two callers racing the very first call
    // both passed that guard, both built a driver, and the second overwrote
    // `this.driver` and `this.ops` before awaiting the FIRST caller's init. It
    // then returned its OWN ops, on which init had never run, and the first
    // driver's pool was orphaned where close() could not reach it.
    //
    // Found by review, not by P-RETRY, which exercises sequential retry only
    // and is no substitute for a race.
    this.startupPromise ??= this.buildAndInit();
    try {
      return await this.startupPromise;
    } catch (error) {
      // Clear so the NEXT call retries, matching the worker being retired and
      // rebuilt so a later heartbeat retried the full init. Memoising the
      // rejection would poison the store for the life of the process.
      this.startupPromise = null;
      throw error;
    }
  }

  /**
   * Build the driver once and run the schema bootstrap.
   *
   * Reached only through the memo above, so it never runs concurrently with
   * itself. The driver is retained across a retry rather than rebuilt, so a
   * failed init cannot leak a pool per attempt.
   */
  private async buildAndInit(): Promise<PostgresJobStoreOps> {
    if (!this.ops) {
      const driver = new PostgresStorageDriver(
        // Every credential `[persistence.roles]` configured. A deployment that
        // configured none holds `app` alone and every class degrades onto it,
        // which the driver reports rather than implying separation is in force.
        this.roleDsns,
        await nodePostgresPoolFactory((role, error) =>
          this.logger.error(`PostgresJobStore pool error on role ${role}`, error)
        )
      );
      // Assigned together, so close() can always reach a driver that exists.
      this.driver = driver;
      this.ops = createPostgresJobStoreOps(driver, this.config);
    }
    const ops = this.ops;
    await ops.init();
    return ops;
  }

  /**
   * What `syncCall` used to be, with the sync-over-async removed.
   *
   * The worker existed only because this could not be awaited. There is no
   * SharedArrayBuffer, no Atomics.wait, no MessagePort and no bridge watchdog
   * here, because there is no thread boundary left to bridge: the operation
   * timeouts that watchdog guarded are enforced by PostgreSQL itself through
   * the pool's statement_timeout and query_timeout.
   */
  private async call<T>(method: string, ...args: unknown[]): Promise<T> {
    if (this.closed) throw new Error("PostgresJobStore is closed");
    const ops = await this.ensureInit();
    return (await ops.op(method, args)) as T;
  }

  async recordStart(input: {
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
  }): Promise<void> {
    assertMcpArtifactAdmissionInvariant(input);
    await this.call("recordStart", input);
  }

  async fenceUnadmittedKitAttempt(input: KitAttemptFenceInput): Promise<KitAttemptFenceResult> {
    return this.call("fenceUnadmittedKitAttempt", input);
  }

  async markRunning(id: string, opts: { pid: number | null }): Promise<boolean> {
    return this.call("markRunning", id, opts);
  }

  async registerInstance(meta: GatewayInstanceMeta): Promise<void> {
    await this.call("registerInstance", meta);
  }

  async heartbeat(instanceId: string): Promise<HeartbeatOutcome> {
    return this.call("heartbeat", instanceId);
  }

  async deregisterInstance(instanceId: string): Promise<void> {
    await this.call("deregisterInstance", instanceId);
  }

  async selectStaleProcessCandidates(
    leaseTtlMs: number,
    httpJobGraceMs: number
  ): Promise<SweepCandidate[]> {
    return this.call("selectStaleProcessCandidates", leaseTtlMs, httpJobGraceMs);
  }

  async selectOrphanedProcessCandidates(hostname: string): Promise<SweepCandidate[]> {
    return this.call("selectOrphanedProcessCandidates", hostname);
  }

  async selectPendingMcpArtifactCleanups(hostname: string): Promise<PendingMcpArtifactCleanup[]> {
    return this.call("selectPendingMcpArtifactCleanups", hostname);
  }

  async acknowledgeMcpArtifactCleanup(
    id: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): Promise<boolean> {
    return this.call("acknowledgeMcpArtifactCleanup", id, hostname, artifactScope, artifactPath);
  }

  async recoverStaleJobs(
    leaseTtlMs: number,
    httpJobGraceMs: number,
    liveConfirmedIds: string[] = []
  ): Promise<OrphanedJobSnapshot[]> {
    const result = await this.call<{
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

  async gcInstances(instanceGcMs: number): Promise<number> {
    return this.call("gcInstances", instanceGcMs);
  }

  async recordOutput(
    id: string,
    stdout: string,
    stderr: string,
    outputTruncated: boolean,
    expectedStatuses: readonly JobStoreStatus[]
  ): Promise<boolean> {
    return this.call("recordOutput", id, stdout, stderr, outputTruncated, [...expectedStatuses]);
  }

  async recordProgress(id: string, progressJson: string): Promise<void> {
    await this.call("recordProgress", id, progressJson);
  }

  async recordProgressIfStatus(
    id: string,
    status: JobStoreStatus,
    progressJson: string
  ): Promise<boolean> {
    return this.call("recordProgressIfStatus", id, status, progressJson);
  }

  async recordComplete(input: {
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
  }): Promise<boolean> {
    return this.call<boolean>("recordComplete", input);
  }

  async getById(id: string): Promise<JobRecord | null> {
    const row = await this.call("getById", id);
    return row ? rowToRecord(row) : null;
  }

  async findByRequestKey(requestKey: string): Promise<JobRecord | null> {
    const row = await this.call("findByRequestKey", requestKey);
    return row ? rowToRecord(row) : null;
  }

  async getPendingKitFinalizations(): Promise<PendingKitFinalization[]> {
    const rows = await this.call<unknown[]>("getPendingKitFinalizations");
    return rows
      .map(row => toPendingKitFinalization(rowToRecord(row)))
      .filter((entry): entry is PendingKitFinalization => entry !== null);
  }

  async getAcknowledgedKitAttemptReleases(): Promise<AcknowledgedKitAttemptRelease[]> {
    const rows = await this.call<unknown[]>("getAcknowledgedKitAttemptReleases");
    return rows
      .map(row => toAcknowledgedKitAttemptRelease(rowToRecord(row)))
      .filter((entry): entry is AcknowledgedKitAttemptRelease => entry !== null);
  }

  async markKitTerminalFinalized(id: string, kitSessionId: string): Promise<boolean> {
    return this.call("markKitTerminalFinalized", id, kitSessionId);
  }

  async getPinnedKitReleaseIds(): Promise<string[]> {
    const rows =
      await this.call<Array<{ kit_execution_json?: string | null }>>("getPinnedKitReleaseIds");
    const releases = new Set<string>();
    for (const row of rows) {
      const execution = parseKitExecution(row.kit_execution_json);
      if (execution) releases.add(execution.releaseId);
    }
    return [...releases].sort();
  }

  async getReferencedKitReleaseIds(): Promise<string[]> {
    return this.getPinnedKitReleaseIds();
  }

  /**
   * @deprecated #139: delegates to the durable lease sweep (like the sqlite
   * shim). No longer blanket-orphans every running row.
   */
  async markOrphanedOnStartup(): Promise<{
    count: number;
    orphaned: Array<OrphanedJobSnapshot>;
  }> {
    const orphaned = await this.recoverStaleJobs(
      DEFAULT_INSTANCE_LEASE_TTL_MS,
      DEFAULT_HTTP_JOB_GRACE_MS
    );
    return { count: orphaned.length, orphaned };
  }

  async evictExpired(): Promise<number> {
    return this.call("evictExpired");
  }

  async recordValidationRun(run: ValidationRunRecord): Promise<void> {
    await this.call("recordValidationRun", run);
  }

  async getValidationRun(validationId: string): Promise<ValidationRunRecord | null> {
    const row = await this.call("getValidationRun", validationId);
    return row ? rowToValidationRunRecord(row) : null;
  }

  async setValidationProviderLinks(
    validationId: string,
    providerLinks: ValidationRunLink[]
  ): Promise<void> {
    await this.call("setValidationProviderLinks", validationId, providerLinks);
  }

  async setValidationJudgeLink(validationId: string, judgeLink: ValidationRunLink): Promise<void> {
    await this.call("setValidationJudgeLink", validationId, judgeLink);
  }

  async transitionValidationRunStatus(
    validationId: string,
    ownerPrincipal: string,
    expectedStatus: ValidationRunRecord["status"],
    status: ValidationRunRecord["status"]
  ): Promise<boolean> {
    return this.call(
      "transitionValidationRunStatus",
      validationId,
      ownerPrincipal,
      expectedStatus,
      status
    );
  }

  async skipValidationJudge(
    validationId: string,
    provider: string,
    ownerPrincipal: string
  ): Promise<void> {
    await this.call("skipValidationJudge", validationId, provider, ownerPrincipal);
  }

  async setValidationRunStatus(
    validationId: string,
    status: ValidationRunRecord["status"]
  ): Promise<void> {
    await this.call("setValidationRunStatus", validationId, status);
  }

  async getValidationRunIdByJobId(jobId: string): Promise<string | null> {
    return this.call("getValidationRunIdByJobId", jobId);
  }

  async recordValidationReceipt(receipt: ValidationReceiptRecord): Promise<void> {
    await this.call("recordValidationReceipt", receipt);
  }

  async finalizeValidationReceipt(
    receipt: ValidationReceiptRecord
  ): Promise<ValidationReceiptRecord> {
    return rowToValidationReceiptRecord(await this.call("finalizeValidationReceipt", receipt));
  }

  async getValidationReceipt(validationId: string): Promise<ValidationReceiptRecord | null> {
    const row = await this.call("getValidationReceipt", validationId);
    return row ? rowToValidationReceiptRecord(row) : null;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    // `closed` is set BEFORE the await, so a call racing this one is refused
    // rather than reaching a driver whose pools are going away.
    this.closed = true;

    // JOIN an initialisation that is already in flight before closing.
    //
    // Without this, close() could return while the pool factory's dynamic
    // import was still pending: buildAndInit would then resume, construct a
    // pool for a store that is already closed, and leave it open with nothing
    // holding a reference to it. Its own failure is not interesting here, only
    // that it has finished deciding whether a driver exists.
    if (this.startupPromise) {
      await this.startupPromise.catch(() => undefined);
    }

    const driver = this.driver;
    if (!driver) return;
    try {
      await driver.close();
    } catch (err) {
      this.logger.error("PostgresJobStore close failed", err);
    }
  }
}

/**
 * Construct the JobStore appropriate to the resolved PersistenceConfig.
 * Returns `null` when `backend = "none"` — callers must not register
 * `*_request_async` tools in that case (use `config.asyncJobsEnabled`).
 *
 * Deliberately still SYNCHRONOUS. The Postgres driver needs a dynamic import of
 * the optional `pg` peer, which cannot be awaited from here, but making this
 * async would force getJobStore, newAsyncJobManager, getAsyncJobManager and
 * createGatewayServer async with it, and createGatewayServer has 52 test
 * callers plus a per-session HTTP path. PostgresJobStore builds its driver on
 * first use instead; see the note on its `ensureInit`.
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
      return new PostgresJobStore(config.dsn ?? "", logger, {
        ...opts,
        roleDsns: config.roleDsns,
      });
    case "sqlite":
    default:
      if (!config.path) {
        throw new Error("SqliteJobStore requires a non-empty path");
      }
      return new SqliteJobStore(config.path, logger, opts);
  }
}
