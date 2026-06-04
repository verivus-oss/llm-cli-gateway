/**
 * Flight recorder: SQLite-backed request log.
 *
 * Read access for cache-stats / MCP resources / doctor goes through the
 * `queryRequests<T>(sql, ...params)` method exposed on both `FlightRecorder`
 * and `NoopFlightRecorder` (the `FlightRecorderQuery` interface, see bottom
 * of file). This is Option A from
 * docs/plans/cache-awareness.dag.toml#expose-flight-recorder-read-access —
 * a single read-only query surface on the existing class, threaded through
 * GatewayServerRuntime as one field.
 *
 * Since the node:sqlite migration (plan B4) that surface runs on a dedicated
 * read-only connection (`openReadOnly`), opened lazily on first use. node:sqlite
 * in WAL mode handles concurrent readers alongside the read/write logging
 * connection inside a single process safely; write attempts on the read-only
 * connection fail at the engine level (SQLITE_READONLY).
 *
 * Callers MUST pass parameterised SQL — string-interpolation of untrusted
 * values is unsafe even on a "read-only" query.
 */
import { chmodSync } from "fs";
import os from "os";
import path from "path";
import { openDatabase, openReadOnly } from "./sqlite-driver.js";
import type { GatewayDatabase } from "./sqlite-driver.js";

export interface FlightLogStart {
  correlationId: string;
  cli: "claude" | "codex" | "gemini" | "grok" | "mistral";
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
  approvalDecision?: string;
  optimizationApplied: boolean;
  thinkingBlocks?: string[];
  exitCode: number;
  errorMessage?: string;
  status: "completed" | "failed";
}

interface LoggerLike {
  info: (message: string, ...args: any[]) => void;
  error: (message: string, ...args: any[]) => void;
}

const MAX_THINKING_BYTES = 1_000_000;

/**
 * Idempotent migration: add `cache_read_tokens` / `cache_creation_tokens`
 * columns to the `requests` table if a pre-U23 logs.db is opened. Existing
 * rows keep NULL for the new columns; that is intentional.
 */
function ensureRequestsCacheColumns(db: GatewayDatabase): void {
  const rows = db.prepare("PRAGMA table_info(requests)").all();
  const names = new Set<string>(
    rows.map((row: any) => (row && typeof row.name === "string" ? row.name : ""))
  );
  if (!names.has("cache_read_tokens")) {
    db.exec("ALTER TABLE requests ADD COLUMN cache_read_tokens INTEGER");
  }
  if (!names.has("cache_creation_tokens")) {
    db.exec("ALTER TABLE requests ADD COLUMN cache_creation_tokens INTEGER");
  }
}

/**
 * Idempotent v3 migration: add `stable_prefix_hash` / `stable_prefix_tokens`
 * columns plus their index. Populated only for new rows that carry a
 * promptParts structure (slice 1); legacy rows keep NULL forever.
 *
 * Read access for cache-stats / MCP resources / doctor goes through the
 * read-only `queryRequests()` method on FlightRecorder (a dedicated
 * read-only connection — node:sqlite in WAL mode handles concurrent readers).
 */
function ensureStablePrefixColumns(db: GatewayDatabase): void {
  const rows = db.prepare("PRAGMA table_info(requests)").all();
  const names = new Set<string>(
    rows.map((row: any) => (row && typeof row.name === "string" ? row.name : ""))
  );
  if (!names.has("stable_prefix_hash")) {
    db.exec("ALTER TABLE requests ADD COLUMN stable_prefix_hash TEXT");
  }
  if (!names.has("stable_prefix_tokens")) {
    db.exec("ALTER TABLE requests ADD COLUMN stable_prefix_tokens INTEGER");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_requests_stable_hash ON requests(stable_prefix_hash)");
}

/**
 * Idempotent v4 migration (slice κ): add `cache_control_blocks` column
 * to the `requests` table. Counts the caller-supplied content blocks
 * the gateway emitted with an explicit Anthropic `cache_control`
 * marker. Pre-κ rows keep NULL; only κ-opt-in callers ever set the
 * column to a non-NULL integer.
 */
function ensureCacheControlBlocksColumn(db: GatewayDatabase): void {
  const rows = db.prepare("PRAGMA table_info(requests)").all();
  const names = new Set<string>(
    rows.map((row: any) => (row && typeof row.name === "string" ? row.name : ""))
  );
  if (!names.has("cache_control_blocks")) {
    db.exec("ALTER TABLE requests ADD COLUMN cache_control_blocks INTEGER");
  }
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

export class FlightRecorder {
  private db: GatewayDatabase;
  /**
   * Dedicated read-only connection for `queryRequests`. Opened lazily on the
   * first read-back (a cache/MCP-resource/doctor path, not the hot logging
   * path) and cached for the recorder's lifetime; closed in `close()`. Write
   * attempts on this connection fail at the SQLite engine level
   * (SQLITE_READONLY) — the engine-level replacement for the old
   * `stmt.readonly` JS guard (plan B4).
   */
  private readOnlyDb: GatewayDatabase | null = null;

  /** Set by close(); guards queryRequests from lazily reopening the RO connection. */
  private closed = false;
  private readonly dbPath: string;
  private insertStartTxn: (entry: FlightLogStart) => void;
  private updateCompleteTxn: (correlationId: string, result: FlightLogResult) => void;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    // openDatabase owns parent-directory creation (mkdirSync recursive), so the
    // recorder no longer does its own mkdir. Any open/DDL failure throws and is
    // caught by createFlightRecorder → NoopFlightRecorder (graceful degradation).
    this.db = openDatabase(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec(`
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
        cache_creation_tokens INTEGER
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
        error_message TEXT,
        async_job_id TEXT,
        status TEXT NOT NULL DEFAULT 'started'
      );

      CREATE INDEX IF NOT EXISTS idx_requests_datetime ON requests(datetime_utc);
      CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
      CREATE INDEX IF NOT EXISTS idx_requests_cli ON requests(cli);
      CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
      CREATE INDEX IF NOT EXISTS idx_metadata_status ON gateway_metadata(status);
    `);

    this.db
      .prepare("INSERT OR IGNORE INTO _migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());

    // Migration v2: cache_read_tokens / cache_creation_tokens columns on
    // pre-U23 logs.db files. ALTER TABLE ADD COLUMN is idempotent only via
    // a prior PRAGMA table_info() check; SQLite has no native
    // "IF NOT EXISTS" for ADD COLUMN.
    ensureRequestsCacheColumns(this.db);
    this.db
      .prepare("INSERT OR IGNORE INTO _migrations(version, applied_at) VALUES(2, ?)")
      .run(new Date().toISOString());

    // Migration v3: stable_prefix_hash / stable_prefix_tokens columns plus
    // their index. Populated only for new rows whose request carried a
    // promptParts structure (slice 1 of cache-awareness); legacy rows keep
    // NULL intentionally.
    ensureStablePrefixColumns(this.db);
    this.db
      .prepare("INSERT OR IGNORE INTO _migrations(version, applied_at) VALUES(3, ?)")
      .run(new Date().toISOString());

    // Migration v4: cache_control_blocks (slice κ). Pre-κ rows keep NULL;
    // only κ-opt-in writes populate this. Aggregates in cache-stats /
    // MCP resources can use this to separate explicit κ hits from
    // implicit prefix-cache hits.
    ensureCacheControlBlocksColumn(this.db);
    this.db
      .prepare("INSERT OR IGNORE INTO _migrations(version, applied_at) VALUES(4, ?)")
      .run(new Date().toISOString());

    if (process.platform !== "win32") {
      try {
        chmodSync(dbPath, 0o600);
      } catch {
        // Best effort permissions hardening.
      }
    }

    const insertRequest = this.db.prepare(`
      INSERT INTO requests (id, cli, model, prompt, system, session_id, datetime_utc,
                            stable_prefix_hash, stable_prefix_tokens,
                            cache_control_blocks)
      VALUES (@id, @cli, @model, @prompt, @system, @session_id, @datetime_utc,
              @stable_prefix_hash, @stable_prefix_tokens,
              @cache_control_blocks)
    `);

    const insertMetadata = this.db.prepare(`
      INSERT INTO gateway_metadata (request_id, async_job_id, status)
      VALUES (@request_id, @async_job_id, 'started')
    `);

    this.insertStartTxn = this.db.withTransaction((entry: FlightLogStart) => {
      insertRequest.run({
        id: entry.correlationId,
        cli: entry.cli,
        model: entry.model,
        prompt: entry.prompt,
        system: entry.system || null,
        session_id: entry.sessionId || null,
        datetime_utc: new Date().toISOString(),
        stable_prefix_hash: entry.stablePrefixHash ?? null,
        stable_prefix_tokens: entry.stablePrefixTokens ?? null,
        cache_control_blocks: entry.cacheControlBlocks ?? null,
      });

      insertMetadata.run({
        request_id: entry.correlationId,
        async_job_id: entry.asyncJobId || null,
      });
    });

    const updateRequests = this.db.prepare(`
      UPDATE requests
      SET response = @response,
          duration_ms = @duration_ms,
          input_tokens = @input_tokens,
          output_tokens = @output_tokens,
          cache_read_tokens = @cache_read_tokens,
          cache_creation_tokens = @cache_creation_tokens
      WHERE id = @id
    `);

    const updateMetadata = this.db.prepare(`
      UPDATE gateway_metadata
      SET retry_count = @retry_count,
          circuit_breaker_state = @circuit_breaker_state,
          cost_usd = @cost_usd,
          approval_decision = @approval_decision,
          optimization_applied = @optimization_applied,
          thinking_blocks = @thinking_blocks,
          exit_code = @exit_code,
          error_message = @error_message,
          status = @status
      WHERE request_id = @id AND status = 'started'
    `);

    this.updateCompleteTxn = this.db.withTransaction(
      (correlationId: string, result: FlightLogResult) => {
        const thinkingBlocks =
          result.thinkingBlocks && result.thinkingBlocks.length > 0
            ? JSON.stringify(truncateThinkingBlocks(result.thinkingBlocks))
            : null;

        updateRequests.run({
          id: correlationId,
          response: result.response,
          duration_ms: result.durationMs,
          input_tokens: result.inputTokens ?? null,
          output_tokens: result.outputTokens ?? null,
          cache_read_tokens: result.cacheReadTokens ?? null,
          cache_creation_tokens: result.cacheCreationTokens ?? null,
        });

        updateMetadata.run({
          id: correlationId,
          retry_count: result.retryCount,
          circuit_breaker_state: result.circuitBreakerState,
          cost_usd: result.costUsd ?? null,
          approval_decision: result.approvalDecision ?? null,
          optimization_applied: result.optimizationApplied ? 1 : 0,
          thinking_blocks: thinkingBlocks,
          exit_code: result.exitCode,
          error_message: result.errorMessage ?? null,
          status: result.status,
        });
      }
    );
  }

  logStart(entry: FlightLogStart): void {
    this.insertStartTxn(entry);
  }

  logComplete(correlationId: string, result: FlightLogResult): void {
    this.updateCompleteTxn(correlationId, result);
  }

  /**
   * Read-only query over the requests + gateway_metadata tables. Used by
   * cache-stats / MCP resources / doctor.
   *
   * Safety:
   * - Caller MUST pass parameterised SQL — direct string interpolation of
   *   untrusted values is unsafe.
   * - The query runs on a dedicated read-only connection
   *   (`openReadOnly` → `new DatabaseSync(path, { readOnly: true })`), so any
   *   statement that mutates rows (INSERT/UPDATE/DELETE, including the
   *   `RETURNING` forms surfaced via `.all()`) fails at the SQLite engine
   *   level with SQLITE_READONLY ("attempt to write a readonly database").
   *   This is the engine-level replacement for the old `stmt.readonly` JS
   *   guard and blocks the writer-disguised-as-reader vector codex-r1/F3
   *   flagged, even for internal gateway callers. node:sqlite WAL mode permits
   *   this reader connection to run alongside the read/write logging
   *   connection in-process; reads see only committed rows (every
   *   queryRequests callsite is a post-commit readback/cache path).
   */
  queryRequests<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    // Closed-state guard: without it, a post-close() query would lazily
    // REOPEN the read-only connection (fd leak, no later close — found in
    // B-review). Matches the pre-migration semantics where any operation on
    // a closed better-sqlite3 handle threw.
    if (this.closed) {
      throw new Error("flight recorder is closed");
    }
    if (!this.readOnlyDb) {
      this.readOnlyDb = openReadOnly(this.dbPath);
    }
    return this.readOnlyDb.prepare(sql).all(...params) as T[];
  }

  flush(): void {
    // No-op: node:sqlite (DatabaseSync) writes synchronously.
  }

  close(): void {
    this.closed = true;
    if (this.readOnlyDb) {
      this.readOnlyDb.close();
      this.readOnlyDb = null;
    }
    this.db.close();
  }
}

export class NoopFlightRecorder {
  logStart(_entry: FlightLogStart): void {}
  logComplete(_correlationId: string, _result: FlightLogResult): void {}
  queryRequests<T = Record<string, unknown>>(_sql: string, ..._params: unknown[]): T[] {
    return [];
  }
  flush(): void {}
  close(): void {}
}

export type FlightRecorderLike = FlightRecorder | NoopFlightRecorder;

/**
 * Read-only subset of FlightRecorder used by cache-stats / MCP resources /
 * doctor. Accepts either FlightRecorder or NoopFlightRecorder; the noop
 * returns `[]` from every query so downstream aggregation is empty by design.
 */
export interface FlightRecorderQuery {
  queryRequests<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
}

export function createFlightRecorder(logger: LoggerLike): FlightRecorderLike {
  const dbPath = resolveFlightRecorderDbPath();
  if (!dbPath) {
    logger.info("Flight recorder disabled (LLM_GATEWAY_LOGS_DB=none)");
    return new NoopFlightRecorder();
  }

  try {
    const recorder = new FlightRecorder(dbPath);
    logger.info(`Flight recorder enabled at ${dbPath}`);
    return recorder;
  } catch (error) {
    logger.error("Flight recorder unavailable; continuing without SQLite logging", error);
    return new NoopFlightRecorder();
  }
}
