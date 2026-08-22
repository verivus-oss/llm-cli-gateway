/**
 * Flight recorder: the request transcript, on the storage port (s7).
 *
 * WHAT CHANGED. The recorder used to hold its own `GatewayDatabase` and issue
 * synchronous `node:sqlite` calls. It now holds a `SqliteStorageDriver` and
 * implements `FlightRecorderOperations` (src/storage/operations.ts), so it
 * shares the port's serialised write queue, bounded shutdown drain and
 * whole-operation deadline with the job store and the session store. Every
 * operation is asynchronous, including the reads.
 *
 * WHAT DID NOT CHANGE, and this is the hard stop rather than an omission:
 * `[persistence].backend = "postgres"` does NOT move the transcript. See
 * `flightRecorderEngineDecision` for the reason and for what a postgres host
 * is told instead.
 *
 * Read access for cache-stats / MCP resources / doctor goes through the seven
 * named typed reads on `FlightRecorderQuery` (s2). `queryRequests`, which takes
 * caller-supplied SQL, survives as an internal of this module and of tests;
 * `scripts/check-storage-port.mjs` fails the build if any other production
 * module calls it.
 *
 * The read classes route to a dedicated read-only connection, so a write
 * disguised as a read fails at the SQLite engine level (SQLITE_READONLY) rather
 * than on trust.
 */
import { chmodSync } from "fs";
import os from "os";
import path from "path";
import { SqliteStorageDriver } from "./storage/drivers/sqlite.js";
import type { StorageConnection } from "./storage/store.js";
import { FLIGHT_RECORDER_OPERATION_CLASSES } from "./storage/operations.js";
import type { FlightRecorderOperations } from "./storage/operations.js";
import { redactSecrets, isRedactionEnabled } from "./secret-redaction.js";
import { getRequestContext, principalScopeSql, resolveOwnerPrincipal } from "./request-context.js";
import { derivePromptSignals } from "./token-estimator.js";
import type { ProviderType } from "./session-manager.js";

export interface FlightLogStart {
  correlationId: string;
  cli: ProviderType;
  model: string;
  prompt: string;
  system?: string;
  sessionId?: string;
  asyncJobId?: string;
  stablePrefixHash?: string;
  stablePrefixTokens?: number;
  /**
   * Slice κ: number of caller-supplied prompt-parts content blocks
   * that the gateway emitted with an explicit `cache_control`
   * breakpoint on this request. `null` (default) for non-κ requests,
   * including pre-κ rows after a v4 migration of a legacy DB.
   */
  cacheControlBlocks?: number;
  /**
   * Slice κ v5: TTL seconds actually emitted on gateway-authored
   * cache_control blocks. Claude CLI κ uses 3600 because 5m blocks are
   * rejected after Claude Code's own 1h session-wrap blocks. Undefined
   * for rows where the gateway emitted no cache_control marker.
   */
  cacheControlTtlSeconds?: number;
  /**
   * F3: ownership principal of the request. Defaults to the principal resolved
   * from the request context ambient at `logStart` when omitted; legacy rows
   * (and pre-migration DBs) keep NULL.
   */
  ownerPrincipal?: string | null;
}

export interface FlightLogResult {
  response: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  durationMs: number;
  retryCount: number;
  circuitBreakerState: string;
  costUsd?: number;
  /**
   * LCR phase_1: how `costUsd` was derived for this row (e.g.
   * 'provider-reported' when upstream reported it, 'derived-from-tokens' when
   * the gateway computed it from token counts). Persisted to the `cost_basis`
   * requests column; the derivation logic lives in index.ts. Undefined (NULL)
   * for rows with no known basis.
   */
  costBasis?: string;
  approvalDecision?: string;
  optimizationApplied: boolean;
  thinkingBlocks?: string[];
  exitCode: number;
  /**
   * Slice 1: real HTTP status for `transport='http'` jobs (429/503/…), so the
   * true outcome is observable separately from the 0/1 `exitCode`. Undefined
   * for process jobs; persisted to the `http_status` requests column.
   */
  httpStatus?: number;
  errorMessage?: string;
  status: "completed" | "failed";
  /**
   * Phase 7: the provider-minted session id parsed from the provider's own
   * output (e.g. a fresh Grok/Claude/Gemini session UUID that the gateway did
   * not supply). Persisted so a deferred/async job can be resumed with the
   * real provider session id intact, even when the gateway `session_id` column
   * holds only a `gw-*` placeholder. Undefined (NULL) when the provider does
   * not emit one on its transport (typed capability fact, e.g. Mistral `-p`).
   */
  providerSessionId?: string;
  /**
   * Phase 7: the provider's terminal stop reason WHERE upstream supplies it
   * (Claude `stop_reason`, Grok `stopReason`, ACP `session/prompt` stopReason,
   * Gemini result status). Undefined (NULL) when the transport does not emit
   * one (typed capability fact, e.g. Codex `exec --json` / Mistral `-p`).
   */
  stopReason?: string;
}

interface LoggerLike {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
}

const MAX_THINKING_BYTES = 1_000_000;

/**
 * Column names of one table, read through the port's connection.
 *
 * Eleven idempotent migrations below all begin the same way, and they are
 * SQLite-specific twice over: `PRAGMA table_info` is the engine's own
 * introspection, and `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS` form here.
 * That is exactly why this file is a sanctioned SQL owner and why none of it
 * reaches the port's surface: `scripts/check-storage-port.mjs` rule 3 keeps
 * PRAGMA inside the modules that own an engine.
 */
async function columnNames(conn: StorageConnection, table: string): Promise<Set<string>> {
  const rows = await conn.query<{ name?: unknown }>(`PRAGMA table_info(${table})`);
  return new Set<string>(rows.map(row => (row && typeof row.name === "string" ? row.name : "")));
}

/**
 * Idempotent migration: add `cache_read_tokens` / `cache_creation_tokens`
 * columns to the `requests` table if a pre-U23 logs.db is opened. Existing
 * rows keep NULL for the new columns; that is intentional.
 */
async function ensureRequestsCacheColumns(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("cache_read_tokens")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN cache_read_tokens INTEGER");
  }
  if (!names.has("cache_creation_tokens")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN cache_creation_tokens INTEGER");
  }
}

/**
 * F3: idempotent add of the `owner_principal` column to a pre-existing requests
 * table. Fresh tables already include it via CREATE TABLE. Legacy rows keep
 * NULL (treated as legacy-unowned by enforcement).
 */
async function ensureRequestsOwnerColumn(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("owner_principal")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN owner_principal TEXT");
  }
}

/**
 * Idempotent v11 migration: persist the two prompt signals the least-cost
 * routing path needs (`derived_prompt_chars`, `derived_content_class`) plus the
 * algorithm version that produced them.
 *
 * Purpose: `lcr-priors` currently bulk-reads `requests.prompt` to recompute
 * these on every load, which is the only production query that reads a prompt
 * body in bulk. Persisting the signals removes that reader, which is the
 * prerequisite for encrypting the body columns (docs/plans/
 * postgres-security-hardening.md section 4.2).
 *
 * Legacy rows keep NULL and are backfilled separately; a NULL derivation must
 * be skipped by readers rather than treated as zero.
 */
async function ensureRequestsDerivationColumns(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("derived_prompt_chars")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN derived_prompt_chars INTEGER");
  }
  if (!names.has("derived_content_class")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN derived_content_class TEXT");
  }
  if (!names.has("derivation_version")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN derivation_version INTEGER");
  }
}

/**
 * Idempotent v3 migration: add `stable_prefix_hash` / `stable_prefix_tokens`
 * columns plus their index. Populated only for new rows that carry a
 * promptParts structure (slice 1); legacy rows keep NULL forever.
 */
async function ensureStablePrefixColumns(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("stable_prefix_hash")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN stable_prefix_hash TEXT");
  }
  if (!names.has("stable_prefix_tokens")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN stable_prefix_tokens INTEGER");
  }
  await conn.execute(
    "CREATE INDEX IF NOT EXISTS idx_requests_stable_hash ON requests(stable_prefix_hash)"
  );
}

/**
 * Idempotent v4 migration (slice κ): add `cache_control_blocks` column
 * to the `requests` table. Counts the caller-supplied content blocks
 * the gateway emitted with an explicit Anthropic `cache_control`
 * marker. Pre-κ rows keep NULL; only κ-opt-in callers ever set the
 * column to a non-NULL integer.
 */
async function ensureCacheControlBlocksColumn(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("cache_control_blocks")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN cache_control_blocks INTEGER");
  }
}

/**
 * Slice 1: idempotent migration adding `http_status` to a pre-existing
 * `gateway_metadata` table. Holds the real HTTP status (429/503/…) for
 * `transport='http'` jobs, distinct from the 0/1 `exit_code`. Process-job rows
 * keep NULL.
 */
async function ensureMetadataHttpStatusColumn(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "gateway_metadata");
  if (!names.has("http_status")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN http_status INTEGER");
  }
}

/**
 * Idempotent v5 migration (slice κ follow-up): record the TTL seconds the
 * gateway actually emitted on cache_control markers. `cache_control_blocks`
 * alone is enough to identify κ rows, but not enough to report TTL state
 * without inferring policy from current config.
 */
async function ensureCacheControlTtlSecondsColumn(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("cache_control_ttl_seconds")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN cache_control_ttl_seconds INTEGER");
  }
}

/**
 * Phase 7: idempotent v7 migration adding `provider_session_id` and
 * `stop_reason` to a pre-existing `gateway_metadata` table. These hold the
 * provider-minted session id and terminal stop reason parsed from provider
 * output so a deferred/async job can be resumed with the real provider session
 * id intact. Legacy rows keep NULL; only providers that actually emit the
 * fields populate them (typed capability fact otherwise).
 */
async function ensureMetadataProviderSessionColumns(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "gateway_metadata");
  if (!names.has("provider_session_id")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN provider_session_id TEXT");
  }
  if (!names.has("stop_reason")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN stop_reason TEXT");
  }
}

/**
 * Idempotent v8 migration (native compressor PR-1): additive compression_*
 * telemetry columns on `gateway_metadata` (the table that already carries
 * `optimization_applied`, which keeps its regex-optimizer meaning and is
 * never repurposed). All NULL when compression did not run; written via
 * recordCompressionTelemetry, never via logComplete (compression can run
 * after completion is finalized: async read-time, and the Claude
 * stream-json sync path logs completion before buildCliResponse).
 */
async function ensureCompressionColumns(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "gateway_metadata");
  if (!names.has("compression_route")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN compression_route TEXT");
  }
  if (!names.has("compression_transforms")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN compression_transforms TEXT");
  }
  if (!names.has("compression_original_chars")) {
    await conn.execute(
      "ALTER TABLE gateway_metadata ADD COLUMN compression_original_chars INTEGER"
    );
  }
  if (!names.has("compression_compressed_chars")) {
    await conn.execute(
      "ALTER TABLE gateway_metadata ADD COLUMN compression_compressed_chars INTEGER"
    );
  }
  if (!names.has("compression_tokens_saved_est")) {
    await conn.execute(
      "ALTER TABLE gateway_metadata ADD COLUMN compression_tokens_saved_est INTEGER"
    );
  }
}

/**
 * Idempotent v9 migration (LCR phase_1): add `cost_basis` to a pre-existing
 * `requests` table. Records how the row's cost_usd was derived (e.g.
 * 'provider-reported' vs 'derived-from-tokens'); the derivation logic lives in
 * index.ts, not here. Legacy rows keep NULL.
 */
async function ensureRequestsCostBasisColumn(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "requests");
  if (!names.has("cost_basis")) {
    await conn.execute("ALTER TABLE requests ADD COLUMN cost_basis TEXT");
  }
}

/**
 * Idempotent v10 migration (LCR phase_1): additive least-cost-routing telemetry
 * columns on `gateway_metadata`. All NULL when the request was not routed by the
 * least-cost router; written post-hoc via recordRouting (never logComplete).
 */
async function ensureMetadataRoutingColumns(conn: StorageConnection): Promise<void> {
  const names = await columnNames(conn, "gateway_metadata");
  if (!names.has("routed")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN routed INTEGER");
  }
  if (!names.has("route_est_cost_usd")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN route_est_cost_usd REAL");
  }
  if (!names.has("route_est_confidence")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN route_est_confidence TEXT");
  }
  if (!names.has("route_reason")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN route_reason TEXT");
  }
  if (!names.has("route_considered")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN route_considered INTEGER");
  }
  if (!names.has("route_reroutes")) {
    await conn.execute("ALTER TABLE gateway_metadata ADD COLUMN route_reroutes INTEGER");
  }
}

/** Compressor facts persisted per request (spec Section 8). Chars are exact;
 * the token field is the only estimate and is named as one. */
export interface CompressionTelemetry {
  route: string;
  transforms: string[];
  originalChars: number;
  compressedChars: number;
  estimatedTokensSaved: number;
}

/**
 * LCR phase_1: least-cost-routing facts persisted per request via recordRouting.
 * All fields optional/nullable; the router populates what it knows. The
 * derivation logic lives in index.ts, not here.
 */
export interface RoutingRecord {
  estCostUsd?: number | null;
  estConfidence?: string | null;
  reason?: string | null;
  considered?: number | null;
  reroutes?: number | null;
}

/**
 * Why there is no request history, decided at CONSTRUCTION and carried on the
 * object rather than inferred from its class.
 *
 * `createFlightRecorder` returned `new NoopFlightRecorder()` from two entirely
 * different situations, and the Noop answers every read with a successful empty
 * result. So a corrupt or unreadable logs.db reached every downstream surface
 * as "flight recording is disabled (LLM_GATEWAY_LOGS_DB=none)", which is the
 * silent empty-success symptom recorded for the June 2026 corruption. A Noop
 * that cannot say why it is a Noop IS that defect, so this is not optional
 * metadata: it is the discriminant.
 */
export type FlightRecorderAbsence =
  { kind: "disabled-by-config" } | { kind: "open-failed"; path: string; error: string; at: string };

/**
 * FIVE states, because there were five all along and the surfaces carried two.
 *
 * - `disabled`      the operator asked for no recording.
 * - `unavailable`   construction FAILED. Nobody asked for this.
 * - `initialising`  the file opened, the async schema bootstrap has not settled.
 * - `degraded`      open, but the bootstrap or the last operation failed.
 * - `active`        open, schema built, last operation succeeded.
 *
 * `initialising` exists because this snapshot is SYNCHRONOUS and construction
 * stopped implying initialisation ran when s7 made the bootstrap async. Without
 * it a health surface would report `active` for a recorder whose schema DDL is
 * still in flight, and would keep doing so right up to the moment it fails.
 */
/** A table in the recorder's file that belongs to a DIFFERENT subsystem. */
export interface CoResidentTableStats {
  table: "jobs" | "validation_runs";
  rows: number;
  /** Rows in a non-terminal status. On an abandoned copy these never finish. */
  unfinished: number;
}

export interface FlightRecorderStorageStats {
  schemaVersion: number | null;
  /** Null means NOT MEASURED. Zero means measured and empty. */
  requestRows: number | null;
  oldestRequest: string | null;
  newestRequest: string | null;
  requestsBeyondRetention: number | null;
  coResident: CoResidentTableStats[];
}

export type FlightRecorderState =
  "disabled" | "unavailable" | "initialising" | "degraded" | "active";

export interface FlightRecorderHealth {
  state: FlightRecorderState;
  /** The file this recorder opened, or would have. Null when disabled. */
  path: string | null;
  /** Message of the failure that produced `unavailable` / `degraded`. */
  error: string | null;
  errorAt: string | null;
  /**
   * Failed ATTEMPTS, so a recorder that flaps is visible when its last call
   * happened to succeed. A bootstrap failure counts once for itself and once
   * for the operation that awaited it, because both genuinely failed.
   */
  failureCount: number;
  /** close() has run. Every operation rejects from that point; reads are not empty, they refuse. */
  closed: boolean;
}

/**
 * The ONE place an operator-facing sentence about recorder state is written.
 *
 * Every surface derives its warning from here, keyed on the discriminant, so
 * no surface can author its own claim about WHY history is missing. That is
 * what went wrong: `llm_process_health` and `doctor` each hard-coded
 * "LLM_GATEWAY_LOGS_DB=none" as the only reason a recorder could be a Noop.
 */
export function flightRecorderHealthMessage(health: FlightRecorderHealth): string | null {
  const empty =
    "llm_request_list returns an empty list and llm_request_result finds nothing; this is not evidence that no request ran.";
  switch (health.state) {
    case "disabled":
      return `Flight recording is disabled by configuration (LLM_GATEWAY_LOGS_DB=none). ${empty}`;
    case "unavailable":
      return `Flight recording is NOT disabled: the recorder FAILED TO OPEN ${health.path} (${health.error}). The gateway is degrading deliberately rather than crashing, so request logging is off by failure and not by choice. ${empty}`;
    case "degraded":
      return `The flight recorder opened ${health.path} but is DEGRADED: ${health.error}. Reads may be silently incomplete and writes may be failing. ${empty}`;
    case "initialising":
      return `The flight recorder opened ${health.path} and its schema bootstrap has not settled yet. A read taken now can return fewer rows than the file holds.`;
    case "active":
      return health.closed
        ? `The flight recorder at ${health.path} has been closed; every further operation refuses rather than returning empty.`
        : null;
  }
}

/** True only when an empty read from this recorder means "nothing was recorded". */
export function flightRecorderReadsAreAuthoritative(health: FlightRecorderHealth): boolean {
  return health.state === "active" && !health.closed;
}

export function resolveFlightRecorderDbPath(): string | null {
  const configured = process.env.LLM_GATEWAY_LOGS_DB;
  if (configured !== undefined) {
    const normalized = configured.trim().toLowerCase();
    if (!normalized || normalized === "none") {
      return null;
    }
    return configured.trim();
  }

  return path.join(os.homedir(), ".llm-cli-gateway", "logs.db");
}

const TRUNCATION_SUFFIX = "[TRUNCATED]";
const TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");

function truncateThinkingBlocks(blocks: string[]): string[] {
  const result: string[] = [];
  let used = 0;

  for (const block of blocks) {
    const bytes = Buffer.byteLength(block, "utf8");
    if (used + bytes <= MAX_THINKING_BYTES) {
      result.push(block);
      used += bytes;
      continue;
    }

    // Reserve space for the suffix so total stays within budget
    const budget = Math.max(0, MAX_THINKING_BYTES - used - TRUNCATION_SUFFIX_BYTES);
    if (budget > 0) {
      // Truncate on code point boundaries by using string iteration
      let charBytes = 0;
      let safeEnd = 0;
      for (const char of block) {
        const charSize = Buffer.byteLength(char, "utf8");
        if (charBytes + charSize > budget) break;
        charBytes += charSize;
        safeEnd += char.length; // char.length handles surrogate pairs
      }
      const sliced = block.slice(0, safeEnd);
      result.push(sliced ? `${sliced}${TRUNCATION_SUFFIX}` : TRUNCATION_SUFFIX);
    } else {
      result.push(TRUNCATION_SUFFIX);
    }
    break;
  }

  return result;
}

/**
 * Every statement the recorder issues, once, at module scope.
 *
 * The driver caches prepared statements keyed by statement TEXT, so a literal
 * rebuilt per call would miss that cache on every request. It also puts the
 * whole SQLite dialect of this subsystem in one place, which is what a second
 * driver would have to answer if the transcript schema ever moves.
 */
const SQL_INSERT_REQUEST = `
      INSERT INTO requests (id, cli, model, prompt, system, session_id, datetime_utc,
                            stable_prefix_hash, stable_prefix_tokens,
                            cache_control_blocks, cache_control_ttl_seconds, owner_principal,
                            derived_prompt_chars, derived_content_class, derivation_version)
      VALUES (@id, @cli, @model, @prompt, @system, @session_id, @datetime_utc,
              @stable_prefix_hash, @stable_prefix_tokens,
              @cache_control_blocks, @cache_control_ttl_seconds, @owner_principal,
              @derived_prompt_chars, @derived_content_class, @derivation_version)
    `;

const SQL_INSERT_METADATA = `
      INSERT INTO gateway_metadata (request_id, async_job_id, status)
      VALUES (@request_id, @async_job_id, 'started')
    `;

const SQL_UPDATE_REQUEST_COMPLETE = `
      UPDATE requests
      SET response = @response,
          duration_ms = @duration_ms,
          input_tokens = @input_tokens,
          output_tokens = @output_tokens,
          cache_read_tokens = @cache_read_tokens,
          cache_creation_tokens = @cache_creation_tokens,
          cost_basis = @cost_basis
      WHERE id = @id
    `;

const SQL_UPDATE_METADATA_COMPLETE = `
      UPDATE gateway_metadata
      SET retry_count = @retry_count,
          circuit_breaker_state = @circuit_breaker_state,
          cost_usd = @cost_usd,
          approval_decision = @approval_decision,
          optimization_applied = @optimization_applied,
          thinking_blocks = @thinking_blocks,
          exit_code = @exit_code,
          http_status = @http_status,
          error_message = @error_message,
          provider_session_id = @provider_session_id,
          stop_reason = @stop_reason,
          status = @status
      WHERE request_id = @id AND status = 'started'
    `;

const SQL_UPDATE_COMPRESSION = `UPDATE gateway_metadata
         SET compression_route = @route,
             compression_transforms = @transforms,
             compression_original_chars = @original_chars,
             compression_compressed_chars = @compressed_chars,
             compression_tokens_saved_est = @tokens_saved_est
         WHERE request_id = @id AND compression_route IS NULL`;

const SQL_UPDATE_ROUTING = `UPDATE gateway_metadata
         SET routed = 1,
             route_est_cost_usd = @est_cost_usd,
             route_est_confidence = @est_confidence,
             route_reason = @reason,
             route_considered = @considered,
             route_reroutes = @reroutes
         WHERE request_id = @id`;

const SQL_SCHEMA = `
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        cli TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system TEXT,
        response TEXT,
        session_id TEXT,
        duration_ms INTEGER,
        datetime_utc TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        owner_principal TEXT,
        cost_basis TEXT,
        derived_prompt_chars INTEGER,
        derived_content_class TEXT,
        derivation_version INTEGER
      );

      CREATE TABLE IF NOT EXISTS gateway_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        retry_count INTEGER DEFAULT 0,
        circuit_breaker_state TEXT,
        cost_usd REAL,
        approval_decision TEXT,
        optimization_applied INTEGER DEFAULT 0,
        thinking_blocks TEXT,
        exit_code INTEGER,
        http_status INTEGER,
        error_message TEXT,
        async_job_id TEXT,
        provider_session_id TEXT,
        stop_reason TEXT,
        routed INTEGER,
        route_est_cost_usd REAL,
        route_est_confidence TEXT,
        route_reason TEXT,
        route_considered INTEGER,
        route_reroutes INTEGER,
        status TEXT NOT NULL DEFAULT 'started'
      );

      CREATE INDEX IF NOT EXISTS idx_requests_datetime ON requests(datetime_utc);
      CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
      CREATE INDEX IF NOT EXISTS idx_requests_cli ON requests(cli);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_status ON gateway_metadata(status);
    `;

const SQL_RECORD_MIGRATION = "INSERT OR IGNORE INTO _migrations(version, applied_at) VALUES(?, ?)";

/**
 * Every recorder operation except `close`, which is `lifecycle` rather than one
 * of the four routed classes. Indexing `FLIGHT_RECORDER_OPERATION_CLASSES` with
 * this union yields only routable classes, so the class travels as DATA from
 * s3sig's declaration to the driver and never as a literal at a call site. That
 * is the defect s3sig recorded against the job store, which passes `"write"`
 * everywhere including its reads.
 */
type RoutedFlightOperation = Exclude<keyof FlightRecorderOperations, "close">;

/**
 * SQLite implementation of `FlightRecorderOperations`, over the storage port.
 *
 * s7 of docs/plans/storage-unification.dag.toml. The recorder no longer holds a
 * `GatewayDatabase`: it holds a `SqliteStorageDriver`, so its writes share one
 * serialised queue, one bounded drain and one whole-operation deadline with
 * every other subsystem on the port.
 *
 * ASYNC, and three consequences the port's header spells out. Construction no
 * longer implies the schema exists, so every operation awaits `ensureSchema()`.
 * Every write returns `Promise<void>`, so a dropped one is a floating promise a
 * lint rule can see. Every read returns a promise, so it is truthy before it
 * resolves and `npm run promise:conditions:check` is the control for that.
 *
 * What it does NOT do, by operator decision 0a: choose Postgres. See
 * `flightRecorderEngineDecision`.
 */
export class FlightRecorder implements FlightRecorderOperations {
  private readonly driver: SqliteStorageDriver;
  private readonly dbPath: string;
  /** F4: redact recognisable secrets from prompt/system/response before write. */
  private readonly redactEnabled: boolean;
  private readonly logger: LoggerLike | null;
  /** Memoised schema bootstrap. Cleared on failure so a later call retries. */
  private bootstrapPromise: Promise<void> | null = null;
  /** Set by close(); every operation refuses from that point on. */
  private closed = false;
  /**
   * Schema-bootstrap state, tracked because `health()` is a SYNCHRONOUS
   * snapshot and construction stopped implying initialisation ran.
   */
  private schemaState: "initialising" | "ready" | "failed" = "initialising";
  /** The most recent failure, cleared by the next operation that succeeds. */
  private lastFailure: { error: string; at: string } | null = null;
  private failureCount = 0;

  constructor(dbPath: string, options: { redactSecrets?: boolean; logger?: LoggerLike } = {}) {
    this.dbPath = dbPath;
    this.redactEnabled = options.redactSecrets ?? isRedactionEnabled();
    this.logger = options.logger ?? null;
    // The DRIVER owns the handle. Holding a GatewayDatabase alongside it would
    // put two independent writers on one file, which is the second write path
    // the port exists to remove. `openDatabase` runs inside this constructor
    // and throws synchronously on an unwritable path, so `createFlightRecorder`
    // still degrades to NoopFlightRecorder for that failure exactly as before.
    this.driver = new SqliteStorageDriver(dbPath);

    // Tightened HERE rather than after the schema, and that is a change: the
    // file exists the moment the driver opens it, so an async bootstrap would
    // otherwise leave a world-readable transcript database for the length of
    // the DDL.
    if (process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }

    // STARTED here, not awaited here: a constructor cannot await. Every
    // operation still awaits ensureSchema(), so nothing observes a half-built
    // schema; starting early only shortens the window before the first write.
    void this.ensureSchema().catch((error: unknown) => {
      // Swallowed HERE so a constructor's async tail cannot raise an unhandled
      // rejection with nobody to receive it. The memo is cleared by
      // ensureSchema's own catch, so the next operation retries and, if it
      // fails again, rejects where a caller can be told.
      this.logger?.error("Flight recorder schema bootstrap failed", error);
    });
  }

  /**
   * Schema, PRAGMAs and the eleven idempotent column migrations, run ONCE.
   *
   * The memo is installed BEFORE any await, so two callers racing the first
   * operation share one bootstrap instead of both running the DDL.
   */
  private ensureSchema(): Promise<void> {
    // No closed-check here. `close()` refuses NEW operations and then waits for
    // the ones already in flight, and those still have to reach a built schema.
    // Refusing here would abandon exactly the writes the drain exists to save.
    this.bootstrapPromise ??= this.bootstrapSchema().then(
      () => {
        this.schemaState = "ready";
      },
      (error: unknown) => {
        this.bootstrapPromise = null;
        // Recorded HERE and not only at the constructor's swallowing catch:
        // that catch fires once, and an operation that retries the bootstrap
        // and fails again must still leave the failure on the health snapshot.
        this.schemaState = "failed";
        this.noteFailure(error);
        throw error;
      }
    );
    return this.bootstrapPromise;
  }

  /**
   * Record a failed operation. The recorder reports `degraded` until an
   * operation SUCCEEDS, which is a live signal rather than a sticky one; the
   * cumulative `failureCount` is what keeps a recorder that flaps visible after
   * its last call happened to work.
   */
  private noteFailure(error: unknown): void {
    this.failureCount += 1;
    this.lastFailure = {
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
  }

  private noteSuccess(): void {
    this.lastFailure = null;
  }

  /**
   * The synchronous state snapshot every health surface reads.
   *
   * Synchronous DELIBERATELY: this is a report, nothing gates on it, and a
   * health surface that has to await the subsystem it is reporting on cannot
   * answer while that subsystem is wedged. The cost of the snapshot is that it
   * can be taken mid-bootstrap, which is exactly why `initialising` is a state
   * rather than an optimistic `active`.
   */
  health(): FlightRecorderHealth {
    const state: FlightRecorderState =
      this.schemaState === "failed" || this.lastFailure
        ? "degraded"
        : this.schemaState === "initialising"
          ? "initialising"
          : "active";
    return {
      state,
      path: this.dbPath,
      error: this.lastFailure?.error ?? null,
      errorAt: this.lastFailure?.at ?? null,
      failureCount: this.failureCount,
      closed: this.closed,
    };
  }

  private async bootstrapSchema(): Promise<void> {
    // driver.bootstrap runs on the driver's own connection with transaction
    // control and OUTSIDE operation-class routing, because DDL is none of the
    // four classes. It shares the driver's queue, so no write can interleave
    // with a half-applied migration.
    await this.driver.bootstrap(async conn => {
      await conn.execute("PRAGMA journal_mode = WAL");
      await conn.execute("PRAGMA foreign_keys = ON");
      await conn.executeScript(SQL_SCHEMA);
      const applied = async (version: number): Promise<void> => {
        await conn.execute(SQL_RECORD_MIGRATION, [version, new Date().toISOString()]);
      };
      await applied(1);

      // v2: cache_read_tokens / cache_creation_tokens on pre-U23 files.
      // ALTER TABLE ADD COLUMN is idempotent only via a prior table_info check;
      // SQLite has no native "IF NOT EXISTS" for ADD COLUMN.
      await ensureRequestsCacheColumns(conn);
      await applied(2);

      // v3: stable_prefix_hash / stable_prefix_tokens plus their index.
      await ensureStablePrefixColumns(conn);
      await applied(3);

      // v4: cache_control_blocks (slice κ). Pre-κ rows keep NULL.
      await ensureCacheControlBlocksColumn(conn);
      await applied(4);

      // v5: cache_control_ttl_seconds. Legacy rows use a compatibility fallback.
      await ensureCacheControlTtlSecondsColumn(conn);
      await applied(5);

      // v6 (F3): owner_principal on requests, plus http_status on metadata.
      await ensureRequestsOwnerColumn(conn);
      await ensureMetadataHttpStatusColumn(conn);
      await applied(6);

      // v7 (phase 7): provider_session_id + stop_reason on metadata.
      await ensureMetadataProviderSessionColumns(conn);
      await applied(7);

      // v8 (native compressor PR-1): compression_* telemetry on metadata.
      await ensureCompressionColumns(conn);
      await applied(8);

      // v9 (LCR phase_1): cost_basis on requests.
      await ensureRequestsCostBasisColumn(conn);
      await applied(9);

      // v10 (LCR phase_1): route_* telemetry on metadata.
      await ensureMetadataRoutingColumns(conn);
      await applied(10);

      // v11 (LCR body-read removal): persisted prompt signals.
      await ensureRequestsDerivationColumns(conn);
      await applied(11);
    });
  }

  /**
   * Operations that have STARTED but not settled.
   *
   * The driver's bounded drain covers work already submitted to its queue. It
   * cannot cover the gap between an operation being CALLED and reaching that
   * queue, which is at minimum the `await ensureSchema()` in front of every one
   * of them. Found by driving it: `logStart(x); close()` in one tick made the
   * driver refuse the write with "closed while this transaction was still
   * queued", so the row was lost by the very call that was supposed to save it.
   *
   * Registered SYNCHRONOUSLY: `read` and `write` are called before the first
   * await in every public method, so a promise is in this set by the time the
   * caller gets it, and `close()` in the next statement can see it.
   */
  private readonly inFlight = new Set<Promise<unknown>>();

  private track<T>(operation: Promise<T>): Promise<T> {
    this.inFlight.add(operation);
    const forget = (): void => {
      this.inFlight.delete(operation);
    };
    void operation.then(forget, forget);
    return operation;
  }

  /** One routed read. The class comes from s3sig's declaration, never a literal. */
  private read<T>(
    operation: RoutedFlightOperation,
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    if (this.closed) return Promise.reject(new Error("flight recorder is closed"));
    return this.track(
      this.observe(
        (async () => {
          await this.ensureSchema();
          return this.driver.withConnection(FLIGHT_RECORDER_OPERATION_CLASSES[operation], conn =>
            conn.query<T>(sql, params)
          );
        })()
      )
    );
  }

  /**
   * Watch one operation's outcome WITHOUT changing it.
   *
   * The rejection is re-thrown, not swallowed: a read failure that reached a
   * caller before must still reach it. All this adds is that the failure is
   * also on the health snapshot, so "read failed after a successful open" stops
   * being a state only the stderr log knows about.
   */
  private observe<T>(operation: Promise<T>): Promise<T> {
    return operation.then(
      value => {
        this.noteSuccess();
        return value;
      },
      (error: unknown) => {
        this.noteFailure(error);
        throw error;
      }
    );
  }

  /**
   * One routed write, as a transaction.
   *
   * `transaction`, not `withConnection`, even for the single-statement
   * telemetry updates: `withConnection` bypasses the driver's queue, so a
   * statement issued while a transaction is mid-body would join that
   * transaction on the same handle and be rolled back with it. Serialising all
   * four writers is also what makes their ORDER a property of submission
   * (src/storage/write-ordering.ts).
   */
  private write(
    operation: RoutedFlightOperation,
    fn: (connection: StorageConnection) => Promise<void>
  ): Promise<void> {
    if (this.closed) return Promise.reject(new Error("flight recorder is closed"));
    return this.track(
      this.observe(
        (async () => {
          await this.ensureSchema();
          await this.driver.transaction(FLIGHT_RECORDER_OPERATION_CLASSES[operation], fn);
        })()
      )
    );
  }

  async logStart(entry: FlightLogStart): Promise<void> {
    // SYNCHRONOUS PROLOGUE. `resolveOwnerPrincipal(getRequestContext())` reads
    // an AsyncLocalStorage context and `derivePromptSignals` must describe the
    // text as it will be STORED, so both are resolved before the first await
    // rather than inside a transaction body the driver schedules later. The
    // timestamp moves with them, so `datetime_utc` is now when the request
    // started rather than when its row reached the disk.
    const stored = this.redactEnabled ? this.redactStart(entry) : entry;
    const ownerPrincipal = stored.ownerPrincipal ?? resolveOwnerPrincipal(getRequestContext());
    const datetimeUtc = new Date().toISOString();
    const derived = derivePromptSignals(stored.prompt ?? "");

    await this.write("logStart", async conn => {
      await conn.execute(SQL_INSERT_REQUEST, [
        {
          id: stored.correlationId,
          cli: stored.cli,
          model: stored.model,
          prompt: stored.prompt,
          derived_prompt_chars: derived.promptChars,
          derived_content_class: derived.contentClass,
          derivation_version: derived.derivationVersion,
          system: stored.system || null,
          session_id: stored.sessionId || null,
          datetime_utc: datetimeUtc,
          stable_prefix_hash: stored.stablePrefixHash ?? null,
          stable_prefix_tokens: stored.stablePrefixTokens ?? null,
          cache_control_blocks: stored.cacheControlBlocks ?? null,
          cache_control_ttl_seconds: stored.cacheControlTtlSeconds ?? null,
          owner_principal: ownerPrincipal,
        },
      ]);
      await conn.execute(SQL_INSERT_METADATA, [
        {
          request_id: stored.correlationId,
          async_job_id: stored.asyncJobId || null,
        },
      ]);
    });
  }

  async logComplete(correlationId: string, result: FlightLogResult): Promise<void> {
    const stored = this.redactEnabled ? this.redactResult(result) : result;
    const thinkingBlocks =
      stored.thinkingBlocks && stored.thinkingBlocks.length > 0
        ? JSON.stringify(truncateThinkingBlocks(stored.thinkingBlocks))
        : null;

    await this.write("logComplete", async conn => {
      await conn.execute(SQL_UPDATE_REQUEST_COMPLETE, [
        {
          id: correlationId,
          response: stored.response,
          duration_ms: stored.durationMs,
          input_tokens: stored.inputTokens ?? null,
          output_tokens: stored.outputTokens ?? null,
          cache_read_tokens: stored.cacheReadTokens ?? null,
          cache_creation_tokens: stored.cacheCreationTokens ?? null,
          cost_basis: stored.costBasis ?? null,
        },
      ]);
      await conn.execute(SQL_UPDATE_METADATA_COMPLETE, [
        {
          id: correlationId,
          retry_count: stored.retryCount,
          circuit_breaker_state: stored.circuitBreakerState,
          cost_usd: stored.costUsd ?? null,
          approval_decision: stored.approvalDecision ?? null,
          optimization_applied: stored.optimizationApplied ? 1 : 0,
          thinking_blocks: thinkingBlocks,
          exit_code: stored.exitCode,
          http_status: stored.httpStatus ?? null,
          error_message: stored.errorMessage ?? null,
          provider_session_id: stored.providerSessionId ?? null,
          stop_reason: stored.stopReason ?? null,
          status: stored.status,
        },
      ]);
    });
  }

  /**
   * Record compressor telemetry for an existing row (spec Section 8).
   * Separate from the status-guarded logComplete UPDATE because compression
   * can run after completion is finalized (async read-time; Claude
   * stream-json sync). Write-once: only applies while compression_route is
   * still NULL, so repeated llm_job_result reads (which recompute
   * deterministically identical values) keep the first write.
   */
  async recordCompressionTelemetry(
    correlationId: string,
    telemetry: CompressionTelemetry
  ): Promise<void> {
    await this.write("recordCompressionTelemetry", async conn => {
      await conn.execute(SQL_UPDATE_COMPRESSION, [
        {
          id: correlationId,
          route: telemetry.route,
          transforms: telemetry.transforms.join(","),
          original_chars: telemetry.originalChars,
          compressed_chars: telemetry.compressedChars,
          tokens_saved_est: telemetry.estimatedTokensSaved,
        },
      ]);
    });
  }

  /**
   * Record least-cost-routing telemetry for an existing row (LCR phase_1).
   * Separate from logComplete because routing facts can be known at a different
   * point than completion; mirrors recordCompressionTelemetry's post-hoc UPSERT.
   * Sets `routed = 1` plus the five route_* columns from the RoutingRecord.
   */
  async recordRouting(correlationId: string, routing: RoutingRecord): Promise<void> {
    await this.write("recordRouting", async conn => {
      await conn.execute(SQL_UPDATE_ROUTING, [
        {
          id: correlationId,
          est_cost_usd: routing.estCostUsd ?? null,
          est_confidence: routing.estConfidence ?? null,
          reason: routing.reason ?? null,
          considered: routing.considered ?? null,
          reroutes: routing.reroutes ?? null,
        },
      ]);
    });
  }

  /** Redact secrets from the persisted prompt/system copy (audit log only). */
  private redactStart(entry: FlightLogStart): FlightLogStart {
    return {
      ...entry,
      prompt: redactSecrets(entry.prompt),
      system: entry.system ? redactSecrets(entry.system) : entry.system,
    };
  }

  /** Redact secrets from the persisted response copy (audit log only). */
  private redactResult(result: FlightLogResult): FlightLogResult {
    return { ...result, response: redactSecrets(result.response) };
  }

  /**
   * Read-only query over the requests + gateway_metadata tables.
   *
   * INTERNAL to this module and to tests inspecting a fixture database.
   * `scripts/check-storage-port.mjs` rule 2 fails the build if any other
   * production module calls it, because a method whose argument is one engine's
   * dialect is an anti-seam rather than a seam (s2).
   *
   * Safety is unchanged by the port: the `transcript_read` class routes to the
   * driver's dedicated read-only connection (`openReadOnly`), so a statement
   * that mutates rows fails at the SQLite engine level with SQLITE_READONLY,
   * and `VACUUM INTO` (which writes a new file despite readOnly) is refused by
   * the adapter. Callers MUST still pass parameterised SQL.
   */
  queryRequests<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
    // Closed-state guard: without it a post-close query would lazily REOPEN the
    // read-only connection (fd leak, no later close). ensureSchema refuses too;
    // this one gives the recorder's own message rather than the driver's.
    if (this.closed) return Promise.reject(new Error("flight recorder is closed"));
    // `transcript_read` as a literal, deliberately: queryRequests is not one of
    // the twelve declared operations (see FLIGHT_RECORDER_NON_OPERATIONS), and
    // arbitrary caller SQL may project body columns, so it takes the widest
    // read class rather than borrowing a named operation's.
    return this.track(
      (async () => {
        await this.ensureSchema();
        return this.driver.withConnection("transcript_read", conn => conn.query<T>(sql, params));
      })()
    );
  }

  // ---- Typed read surface (FlightRecorderQuery) -------------------------
  // s2 of storage-unification: each of these replaced a caller-supplied SQL
  // string. The SQL now lives beside the schema it reads, which is what makes
  // a second driver implementable.

  async readCacheRowsBySession(sessionId: string): Promise<CacheAggregateRow[]> {
    return this.read<CacheAggregateRow>(
      "readCacheRowsBySession",
      `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash,
              datetime_utc,
              cache_control_blocks,
              cache_control_ttl_seconds
       FROM requests
       WHERE session_id = ?
       ORDER BY datetime_utc DESC`,
      [sessionId]
    );
  }

  async readCacheRowsByPrefix(stablePrefixHash: string): Promise<CacheAggregateRow[]> {
    // No cache_control_* columns: the pre-s2 query did not select them, and
    // adding them here would silently change prefix aggregates.
    return this.read<CacheAggregateRow>(
      "readCacheRowsByPrefix",
      `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash,
              datetime_utc
       FROM requests
       WHERE stable_prefix_hash = ?
       ORDER BY datetime_utc ASC`,
      [stablePrefixHash]
    );
  }

  async readCacheRowsGlobal(sinceIso?: string): Promise<CacheAggregateRow[]> {
    const select = `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash,
              datetime_utc,
              cache_control_blocks,
              cache_control_ttl_seconds
       FROM requests`;
    return sinceIso
      ? this.read<CacheAggregateRow>("readCacheRowsGlobal", `${select} WHERE datetime_utc >= ?`, [
          sinceIso,
        ])
      : this.read<CacheAggregateRow>("readCacheRowsGlobal", select);
  }

  async readRequestById(correlationId: string): Promise<PersistedRequestRow | null> {
    const [row] = await this.read<PersistedRequestRow>(
      "readRequestById",
      `SELECT r.id, r.cli, r.model, r.prompt, r.response, r.session_id,
              r.datetime_utc, r.duration_ms, r.input_tokens, r.output_tokens,
              r.cache_read_tokens, r.cache_creation_tokens, r.owner_principal,
              m.retry_count, m.circuit_breaker_state, m.cost_usd,
              m.exit_code, m.error_message, m.async_job_id, m.provider_session_id, m.status,
              m.thinking_blocks
       FROM requests r
       LEFT JOIN gateway_metadata m ON m.request_id = r.id
       WHERE r.id = ?
       LIMIT 1`,
      [correlationId]
    );
    return row ?? null;
  }

  async listRequestSummaries(filter: RequestSummaryFilter): Promise<PersistedRequestSummaryRow[]> {
    // The ownership fragment bounds LIMIT to rows the caller may see; the
    // caller still re-checks every row with principalCanAccess, which is the
    // control. See src/request-context.ts.
    const scope = principalScopeSql("r.owner_principal", filter.ownerPrincipal);
    const where: string[] = [scope.sql];
    const params: unknown[] = [...scope.params];

    if (filter.sinceIso) {
      where.push("r.datetime_utc >= ?");
      params.push(filter.sinceIso);
    }
    if (filter.cli) {
      where.push("r.cli = ?");
      params.push(filter.cli);
    }
    if (filter.sessionId) {
      where.push("r.session_id = ?");
      params.push(filter.sessionId);
    }

    return this.read<PersistedRequestSummaryRow>(
      "listRequestSummaries",
      `SELECT r.id, r.cli, r.model, r.session_id, r.datetime_utc, r.duration_ms,
              r.owner_principal,
              LENGTH(r.prompt) AS prompt_chars,
              LENGTH(r.response) AS response_chars,
              m.async_job_id, m.status, m.exit_code, m.provider_session_id
       FROM requests r
       LEFT JOIN gateway_metadata m ON m.request_id = r.id
       WHERE ${where.join(" AND ")}
       ORDER BY r.datetime_utc DESC
       LIMIT ?`,
      [...params, filter.limit]
    );
  }

  async readLcrPriorRows(): Promise<LcrPriorSourceRow[]> {
    // Deliberately does not select r.prompt: the derived_* columns exist so
    // this reader need not bulk-read prompt bodies.
    return this.read<LcrPriorSourceRow>(
      "readLcrPriorRows",
      `SELECT r.cli, r.model, r.derived_prompt_chars, r.derived_content_class,
              r.input_tokens, r.output_tokens,
              r.cache_read_tokens, r.cache_creation_tokens,
              r.cost_basis, r.owner_principal, r.session_id, r.datetime_utc,
              m.cost_usd, m.route_est_cost_usd
       FROM requests r
       LEFT JOIN gateway_metadata m ON m.request_id = r.id
       ORDER BY r.datetime_utc ASC`
    );
  }

  async readRoutingDecisions(limit: number): Promise<RoutingDecisionRow[]> {
    return this.read<RoutingDecisionRow>(
      "readRoutingDecisions",
      `SELECT r.cli, r.model, r.datetime_utc, r.cost_basis,
              m.route_est_cost_usd, m.route_est_confidence, m.route_reason,
              m.route_considered, m.route_reroutes
       FROM requests r
       LEFT JOIN gateway_metadata m ON m.request_id = r.id
       WHERE m.routed = 1
       ORDER BY r.datetime_utc DESC
       LIMIT ?`,
      [limit]
    );
  }

  /**
   * How much is in this file, and what else is in it.
   *
   * `doctor --json` reported NO storage health at all: no size, no row counts,
   * no retention state, no wedged-run counts. The SQL lives here rather than in
   * doctor.ts because scripts/check-storage-port.mjs keeps SQL inside the
   * storage-owning modules, and it is one operation rather than six so a
   * degraded file fails the whole block instead of half of it.
   *
   * The co-resident scan is the point, not a bonus: on a host switched to
   * Postgres, this file still holds a `jobs` table frozen at the switchover
   * that answers queries as though it were live, and a direct reader cannot
   * see that it is stale.
   */
  async readStorageStats(retentionCutoffIso?: string): Promise<FlightRecorderStorageStats> {
    const version = await this.read<{ v: number | null }>(
      "readStorageStats",
      "SELECT MAX(version) AS v FROM _migrations"
    );
    const totals = await this.read<{ c: number; oldest: string | null; newest: string | null }>(
      "readStorageStats",
      "SELECT COUNT(*) AS c, MIN(datetime_utc) AS oldest, MAX(datetime_utc) AS newest FROM requests"
    );
    let beyondRetention: number | null = null;
    if (retentionCutoffIso) {
      const rows = await this.read<{ c: number }>(
        "readStorageStats",
        "SELECT COUNT(*) AS c FROM requests WHERE datetime_utc < ?",
        [retentionCutoffIso]
      );
      beyondRetention = rows[0]?.c ?? 0;
    }
    const present = await this.read<{ name: string }>(
      "readStorageStats",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('jobs', 'validation_runs')"
    );
    const names = new Set(present.map(row => row.name));
    const coResident: CoResidentTableStats[] = [];
    if (names.has("jobs")) {
      // Statements are literal per table. Interpolating a name from
      // sqlite_master would put a database-supplied string into SQL for no gain.
      const rows = await this.read<{ c: number; unfinished: number }>(
        "readStorageStats",
        "SELECT COUNT(*) AS c, SUM(CASE WHEN status IN ('queued', 'running') THEN 1 ELSE 0 END) AS unfinished FROM jobs"
      );
      coResident.push({
        table: "jobs",
        rows: rows[0]?.c ?? 0,
        unfinished: rows[0]?.unfinished ?? 0,
      });
    }
    if (names.has("validation_runs")) {
      const rows = await this.read<{ c: number; unfinished: number }>(
        "readStorageStats",
        "SELECT COUNT(*) AS c, SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS unfinished FROM validation_runs"
      );
      coResident.push({
        table: "validation_runs",
        rows: rows[0]?.c ?? 0,
        unfinished: rows[0]?.unfinished ?? 0,
      });
    }
    return {
      schemaVersion: version[0]?.v ?? null,
      requestRows: totals[0]?.c ?? 0,
      oldestRequest: totals[0]?.oldest ?? null,
      newestRequest: totals[0]?.newest ?? null,
      requestsBeyondRetention: beyondRetention,
      coResident,
    };
  }

  /**
   * Drain, then shut the handles.
   *
   * MUST BE AWAITED. `performShutdown` did not await it, which was harmless
   * only while this class was synchronous: the driver's bounded drain runs
   * inside `driver.close()`, and an unawaited call discards the drain entirely
   * and then logs a completed close that has not happened.
   */
  async close(): Promise<void> {
    // Refuse NEW work first, so the set below cannot be refilled while it drains.
    this.closed = true;
    // Then let what is already running reach the driver's queue. The loop is
    // for an operation that starts another; none do today, and each is bounded
    // by the driver's own whole-operation deadline, so this cannot wait forever
    // on anything the driver would not have waited on anyway.
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    // Only now: the driver's bounded drain, then the handles.
    await this.driver.close();
  }
}

/**
 * The recorder-disabled implementation. Async for the same reason the real one
 * is: a caller must not be able to tell the two apart by whether it has to
 * await, or the disabled path would take a different code path at every site.
 */
export class NoopFlightRecorder implements FlightRecorderOperations {
  /**
   * WHY this instance exists, not merely that it does.
   *
   * Defaulted to `disabled-by-config` because that is what a bare
   * `new NoopFlightRecorder()` has always meant at every test call site, and
   * because the failure path is what has to be explicit: `createFlightRecorder`
   * reaches this class from two places and its catch now MUST hand over the
   * error to construct one. See `flightRecorderOpenFailed`.
   */
  private readonly absence: FlightRecorderAbsence;

  constructor(absence: FlightRecorderAbsence = { kind: "disabled-by-config" }) {
    this.absence = absence;
  }

  health(): FlightRecorderHealth {
    if (this.absence.kind === "open-failed") {
      return {
        state: "unavailable",
        path: this.absence.path,
        error: this.absence.error,
        errorAt: this.absence.at,
        failureCount: 1,
        closed: false,
      };
    }
    return {
      state: "disabled",
      path: null,
      error: null,
      errorAt: null,
      failureCount: 0,
      closed: false,
    };
  }

  async logStart(_entry: FlightLogStart): Promise<void> {}
  async logComplete(_correlationId: string, _result: FlightLogResult): Promise<void> {}
  async recordCompressionTelemetry(
    _correlationId: string,
    _telemetry: CompressionTelemetry
  ): Promise<void> {}
  async recordRouting(_correlationId: string, _routing: RoutingRecord): Promise<void> {}
  async queryRequests<T = Record<string, unknown>>(
    _sql: string,
    ..._params: unknown[]
  ): Promise<T[]> {
    return [];
  }
  async readCacheRowsBySession(_sessionId: string): Promise<CacheAggregateRow[]> {
    return [];
  }
  async readCacheRowsByPrefix(_stablePrefixHash: string): Promise<CacheAggregateRow[]> {
    return [];
  }
  async readCacheRowsGlobal(_sinceIso?: string): Promise<CacheAggregateRow[]> {
    return [];
  }
  async readRequestById(_correlationId: string): Promise<PersistedRequestRow | null> {
    return null;
  }
  async listRequestSummaries(_filter: RequestSummaryFilter): Promise<PersistedRequestSummaryRow[]> {
    return [];
  }
  async readLcrPriorRows(): Promise<LcrPriorSourceRow[]> {
    return [];
  }
  async readRoutingDecisions(_limit: number): Promise<RoutingDecisionRow[]> {
    return [];
  }
  /**
   * NULLS, not zeroes. A zero row count is a measurement; this is the absence
   * of one, and reporting `requestRows: 0` from a recorder that never opened a
   * file is the same substitution the whole node is about.
   */
  async readStorageStats(_retentionCutoffIso?: string): Promise<FlightRecorderStorageStats> {
    return {
      schemaVersion: null,
      requestRows: null,
      oldestRequest: null,
      newestRequest: null,
      requestsBeyondRetention: null,
      coResident: [],
    };
  }
  async close(): Promise<void> {}
}

export type FlightRecorderLike = FlightRecorder | NoopFlightRecorder;

/** The recorder the operator asked NOT to have. */
export function flightRecorderDisabled(): NoopFlightRecorder {
  return new NoopFlightRecorder({ kind: "disabled-by-config" });
}

/** The recorder that could not be built. Nobody asked for this one. */
export function flightRecorderOpenFailed(path: string, error: unknown): NoopFlightRecorder {
  return new NoopFlightRecorder({
    kind: "open-failed",
    path,
    error: error instanceof Error ? error.message : String(error),
    at: new Date().toISOString(),
  });
}

/**
 * The health of any recorder, including one that was never built.
 *
 * `null` is its own answer rather than a silent `disabled`: a surface reading
 * the recorder before startup wired one has not learned that recording is off,
 * it has learned nothing, and reporting that as a configuration choice is the
 * same conflation one layer up.
 */
export function flightRecorderHealth(recorder: FlightRecorderLike | null): FlightRecorderHealth {
  if (!recorder) {
    return {
      state: "unavailable",
      path: resolveFlightRecorderDbPath(),
      error: "no flight recorder has been constructed in this process yet",
      errorAt: null,
      failureCount: 0,
      closed: false,
    };
  }
  return recorder.health();
}

/** Projection behind the three cache-aggregate reads. */
export interface CacheAggregateRow {
  cli: string;
  model: string;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  stable_prefix_hash: string | null;
  datetime_utc: string;
  /**
   * Slice κ: number of caller-supplied content blocks the gateway emitted with
   * an explicit `cache_control` marker. NULL on pre-v4 rows and on non-Claude /
   * non-κ Claude rows. Absent from the by-prefix projection, which never
   * selected it.
   */
  cache_control_blocks?: number | null;
  cache_control_ttl_seconds?: number | null;
}

/** Projection behind `readRequestById`: one request joined to its metadata. */
export interface PersistedRequestRow {
  id: string;
  cli: string;
  model: string;
  prompt: string | null;
  response: string | null;
  session_id: string | null;
  datetime_utc: string;
  duration_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  retry_count: number | null;
  circuit_breaker_state: string | null;
  cost_usd: number | null;
  exit_code: number | null;
  error_message: string | null;
  async_job_id: string | null;
  provider_session_id: string | null;
  status: string | null;
  thinking_blocks: string | null;
  owner_principal: string | null;
}

/** Projection behind `listRequestSummaries`. Carries no prompt or response text. */
export interface PersistedRequestSummaryRow {
  id: string;
  cli: string;
  model: string;
  session_id: string | null;
  datetime_utc: string;
  duration_ms: number | null;
  prompt_chars: number | null;
  response_chars: number | null;
  async_job_id: string | null;
  status: string | null;
  exit_code: number | null;
  provider_session_id: string | null;
  owner_principal: string | null;
}

/**
 * Projection behind `readLcrPriorRows`. Deliberately excludes `prompt`.
 * Named `...SourceRow` because lcr-priors.ts has its own DOMAIN type called
 * `LcrPriorRow`; two different shapes under one name, kept apart only by an
 * import alias, is a trap for whoever edits this next.
 */
export interface LcrPriorSourceRow {
  cli: string;
  model: string;
  derived_prompt_chars: number | null;
  derived_content_class: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_basis: string | null;
  owner_principal: string | null;
  session_id: string | null;
  datetime_utc: string;
  cost_usd: number | null;
  route_est_cost_usd: number | null;
}

/** Projection behind `readRoutingDecisions`: routing economics only. */
export interface RoutingDecisionRow {
  cli: string;
  model: string;
  datetime_utc: string;
  cost_basis: string | null;
  route_est_cost_usd: number | null;
  route_est_confidence: string | null;
  route_reason: string | null;
  route_considered: number | null;
  route_reroutes: number | null;
}

/**
 * Read-only surface of the flight recorder, used by cache-stats / lcr-priors /
 * MCP resources / doctor. Accepts either FlightRecorder or NoopFlightRecorder;
 * the noop returns `[]` (or `null`) from every read so downstream aggregation
 * is empty by design.
 *
 * s2 of docs/plans/storage-unification.dag.toml: this used to be a single
 * `queryRequests(sql, ...params)` method, i.e. the caller supplied the SQL.
 * That is not a seam, it is an anti-seam: a port cannot abstract an engine
 * behind a method whose argument IS that engine's dialect, and seven callers
 * were passing SQLite `?` placeholders that PostgreSQL does not accept. Each
 * of those queries is now a named operation whose SQL lives with the schema it
 * belongs to, so a second driver has a finite, typed surface to implement.
 *
 * `queryRequests` still exists on the concrete class for its own internals and
 * for tests inspecting the database directly. `scripts/check-storage-port.mjs`
 * fails the build if any other production module reaches for it.
 */
export interface FlightRecorderQuery {
  /** Cache aggregate rows for one gateway session, newest first. */
  readCacheRowsBySession(sessionId: string): Promise<CacheAggregateRow[]>;
  /** Cache aggregate rows sharing one stable prefix hash, oldest first. */
  readCacheRowsByPrefix(stablePrefixHash: string): Promise<CacheAggregateRow[]>;
  /** Cache aggregate rows across all CLIs, optionally bounded below by an ISO timestamp. */
  readCacheRowsGlobal(sinceIso?: string): Promise<CacheAggregateRow[]>;
  /** One persisted request joined to its gateway metadata, or null. */
  readRequestById(correlationId: string): Promise<PersistedRequestRow | null>;
  /** Persisted request summaries, newest first, scoped to one principal. */
  listRequestSummaries(filter: RequestSummaryFilter): Promise<PersistedRequestSummaryRow[]>;
  /** Least-cost-routing prior rows, oldest first. Never selects prompt text. */
  readLcrPriorRows(): Promise<LcrPriorSourceRow[]>;
  /** The most recent routed decisions, newest first. */
  readRoutingDecisions(limit: number): Promise<RoutingDecisionRow[]>;
}

/** Filter for `listRequestSummaries`. `ownerPrincipal` is required by design. */
export interface RequestSummaryFilter {
  /** Rows visible to this principal only. No default: absent must never mean "all". */
  ownerPrincipal: string;
  limit: number;
  sinceIso?: string;
  cli?: string;
  sessionId?: string;
}

/**
 * Which engine the recorder runs on, and why it is not the one `[persistence]`
 * asked for.
 *
 * This is the whole of what s7 can honestly deliver against "the recorder obeys
 * `[persistence].backend`", and the boundary is operator decision 0a plus
 * `[non_goals].no_transcript_move_yet` in docs/plans/storage-unification.dag.toml:
 * transcript BODIES do not enter Postgres until postgres-security-hardening.md
 * section 6 is complete through step 8, and it is at step 2 of 10. The Postgres
 * transcript schema does not exist and is NEW AUTHORSHIP rather than a
 * migration, so a `postgres` backend cannot be honoured by writing one here.
 *
 * What changes is that the split is now DECLARED instead of implicit. A
 * `postgres` host gets `deferredBecause` populated, which
 * `llm_process_health` reports, rather than a recorder that quietly ignores the
 * setting.
 *
 * `none` is deliberately NOT treated as "disable the recorder". That switch is
 * `LLM_GATEWAY_LOGS_DB=none` today, and reconciling the two inputs (which one
 * wins, which one deprecates) is s9's node, not this one. Silently dropping
 * request history on every `backend = "none"` host would be a data-visible
 * change smuggled in under a refactor.
 */
export interface FlightRecorderEngineDecision {
  /** The engine the recorder will actually use. Always "sqlite" today. */
  engine: "sqlite";
  /** What `[persistence].backend` asked for, when it asked for something else. */
  requested?: string;
  /** Populated only when `requested` could not be honoured. */
  deferredBecause?: string;
}

export function flightRecorderEngineDecision(
  backend: string | undefined
): FlightRecorderEngineDecision {
  if (backend !== "postgres") return { engine: "sqlite" };
  return {
    engine: "sqlite",
    requested: backend,
    deferredBecause:
      "transcript bodies stay on SQLite until postgres-security-hardening.md section 6 is " +
      "complete through step 8 (currently step 2 of 10). There is no Postgres transcript " +
      "schema: `requests` and `gateway_metadata` exist only in SQLite, and authoring them " +
      "would move 1.2 GB of plaintext prompts into a store one superuser role reads in " +
      "cleartext, which is a regression over a 0600 file.",
  };
}

export function createFlightRecorder(
  logger: LoggerLike,
  persistenceBackend?: string
): FlightRecorderLike {
  const dbPath = resolveFlightRecorderDbPath();
  if (!dbPath) {
    logger.info("Flight recorder disabled (LLM_GATEWAY_LOGS_DB=none)");
    return flightRecorderDisabled();
  }

  const decision = flightRecorderEngineDecision(persistenceBackend);
  try {
    const recorder = new FlightRecorder(dbPath, { logger });
    logger.info(`Flight recorder enabled at ${dbPath} (engine: ${decision.engine})`);
    if (decision.deferredBecause) {
      logger.info(
        `Flight recorder is NOT following [persistence].backend = "${decision.requested}": ` +
          decision.deferredBecause
      );
    }
    return recorder;
  } catch (error) {
    // DEGRADE, deliberately and unchanged: losing request logging must not take
    // the gateway down. What changed is that the object handed back can no
    // longer be mistaken for the one above it. Same class, different answer to
    // `health()`, so every downstream surface stops reading a failed open as a
    // configuration choice.
    logger.error("Flight recorder unavailable; continuing without SQLite logging", error);
    return flightRecorderOpenFailed(dbPath, error);
  }
}
