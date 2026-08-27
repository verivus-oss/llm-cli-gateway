/**
 * The flight recorder on PostgreSQL: the capability s7 stopped short of.
 *
 * s7 put the recorder on the storage port under the SQLite driver and refused
 * `backend = "postgres"` out loud, because the transcript schema did not exist
 * and postgres-security-hardening.md section 6 was read as gating it on step 8.
 * Section 6.1 (amendment 2026-08-22) replaced that with a DEPLOYMENT SHAPE gate,
 * and migrations/022 is the schema. This is the implementation behind both.
 *
 * A SEPARATE implementation rather than a translated one, as the port requires
 * (src/storage/store.ts): drivers own their own SQL, because 50 of 77 audited
 * statements bind placeholders PostgreSQL rejects and the dialects diverge on
 * upserts, booleans and introspection. The statements here are the SQLite
 * recorder's, re-authored: `?` throughout (the driver rewrites to `$n`),
 * booleans where SQLite wrote 1/0, `information_schema` where it read
 * `sqlite_master`, and `schema_migrations` where it kept its own `_migrations`.
 *
 * NO DATA MIGRATION. A host that switches backend starts writing here and its
 * existing logs.db rows stay where they are; s10 is the human-supervised
 * cutover that moves them. `llm_process_health` reports the split so an
 * operator is never guessing where their history is.
 */
import { createRequire } from "module";
import { derivePromptSignals } from "./token-estimator.js";
import { getRequestContext, principalScopeSql, resolveOwnerPrincipal } from "./request-context.js";
import { isRedactionEnabled, redactSecrets } from "./secret-redaction.js";
import {
  FLIGHT_RECORDER_OPERATION_CLASSES,
  type FlightRecorderOperations,
} from "./storage/operations.js";
import {
  nodePostgresPoolFactory,
  PostgresStorageDriver,
  type PgPoolFactory,
  type PostgresRoleDsns,
} from "./storage/drivers/postgres.js";
import type { StorageConnection } from "./storage/store.js";
import { FlightRecorderRuntime, truncateThinkingBlocks } from "./flight-recorder-runtime.js";
import type {
  CacheAggregateRow,
  CompressionTelemetry,
  CoResidentTableStats,
  FlightLogResult,
  FlightLogStart,
  FlightRecorderHealth,
  FlightRecorderStorageStats,
  LcrPriorSourceRow,
  LoggerLike,
  PersistedRequestRow,
  PersistedRequestSummaryRow,
  RequestSummaryFilter,
  RoutingDecisionRow,
  RoutingRecord,
} from "./flight-recorder.js";

/**
 * Reserved for this subsystem's compatibility DDL. Distinct from the job
 * store's key: two subsystems creating unrelated tables must not serialise on
 * each other, and sharing a key would make a slow transcript index build block
 * a gateway that only wanted its jobs table.
 */
const TRANSCRIPT_BOOTSTRAP_LOCK_KEY = 1_280_066_888;

const SQL_INSERT_REQUEST = `
      INSERT INTO requests (id, cli, model, prompt, system, session_id, datetime_utc,
                            stable_prefix_hash, stable_prefix_tokens,
                            cache_control_blocks, cache_control_ttl_seconds, owner_principal,
                            derived_prompt_chars, derived_content_class, derivation_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

const SQL_INSERT_METADATA = `
      INSERT INTO gateway_metadata (request_id, async_job_id, status)
      VALUES (?, ?, 'started')
    `;

const SQL_UPDATE_REQUEST_COMPLETE = `
      UPDATE requests
      SET response = ?, duration_ms = ?, input_tokens = ?, output_tokens = ?,
          cache_read_tokens = ?, cache_creation_tokens = ?, cost_basis = ?
      WHERE id = ?
        AND EXISTS (
              SELECT 1 FROM gateway_metadata m
               WHERE m.request_id = requests.id AND m.completion_rank <= ?
            )
    `;

const SQL_UPDATE_METADATA_COMPLETE = `
      UPDATE gateway_metadata
      SET retry_count = ?, circuit_breaker_state = ?, cost_usd = ?, approval_decision = ?,
          optimization_applied = ?, thinking_blocks = ?, exit_code = ?, http_status = ?,
          error_message = ?, provider_session_id = ?, stop_reason = ?, status = ?,
          completion_rank = ?
      WHERE request_id = ? AND completion_rank <= ?
    `;

const SQL_UPDATE_COMPRESSION = `
      UPDATE gateway_metadata
      SET compression_route = ?, compression_transforms = ?, compression_original_chars = ?,
          compression_compressed_chars = ?, compression_tokens_saved_est = ?
      WHERE request_id = ? AND compression_route IS NULL
    `;

/** `routed` is BOOLEAN here; SQLite wrote the integer 1 into the same column. */
const SQL_UPDATE_ROUTING = `
      UPDATE gateway_metadata
      SET routed = TRUE, route_est_cost_usd = ?, route_est_confidence = ?,
          route_reason = ?, route_considered = ?, route_reroutes = ?
      WHERE request_id = ?
    `;

/**
 * Byte-for-byte the table and index definitions of migrations/022, as a
 * compatibility bootstrap for a database whose operator has not run
 * `npm run migrate` yet. That is the job store's established arrangement
 * (postgres-job-store-ops.ts `init`), and the drift risk it creates is closed
 * by a control that applies BOTH and compares `information_schema.columns`.
 */
const SQL_BOOTSTRAP = `
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
      derivation_version INTEGER,
      stable_prefix_hash TEXT,
      stable_prefix_tokens INTEGER,
      cache_control_blocks INTEGER,
      cache_control_ttl_seconds INTEGER
    );
    CREATE TABLE IF NOT EXISTS gateway_metadata (
      request_id TEXT PRIMARY KEY REFERENCES requests(id),
      retry_count INTEGER DEFAULT 0,
      circuit_breaker_state TEXT,
      cost_usd DOUBLE PRECISION,
      approval_decision TEXT,
      optimization_applied BOOLEAN DEFAULT FALSE,
      thinking_blocks TEXT,
      exit_code INTEGER,
      http_status INTEGER,
      error_message TEXT,
      async_job_id TEXT,
      provider_session_id TEXT,
      stop_reason TEXT,
      routed BOOLEAN,
      route_est_cost_usd DOUBLE PRECISION,
      route_est_confidence TEXT,
      route_reason TEXT,
      route_considered INTEGER,
      route_reroutes INTEGER,
      status TEXT NOT NULL DEFAULT 'started',
      completion_rank SMALLINT NOT NULL DEFAULT 0,
      compression_route TEXT,
      compression_transforms TEXT,
      compression_original_chars INTEGER,
      compression_compressed_chars INTEGER,
      compression_tokens_saved_est INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_requests_datetime ON requests(datetime_utc);
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model);
    CREATE INDEX IF NOT EXISTS idx_requests_cli ON requests(cli);
    CREATE INDEX IF NOT EXISTS idx_requests_session ON requests(session_id);
    CREATE INDEX IF NOT EXISTS idx_requests_stable_hash ON requests(stable_prefix_hash);
    CREATE INDEX IF NOT EXISTS idx_metadata_status ON gateway_metadata(status);
  `;

/** Host, port and database only. A DSN carries a password and health output is read aloud. */
/**
 * One place that turns a resolved target into a printable identity.
 *
 * Round 4 found the previous inline formatting emitted things that were not
 * URIs and read as a different location entirely:
 *   `?host=/var/run/postgresql` became `postgresql:///var/run/postgresql:5433/db`,
 *   which parses as an empty host and a database named `var/run/...`.
 *   `?host=::1` became `postgresql://::1:5433/db`, unbracketed and ambiguous.
 * Both are the same failure the function exists to prevent: naming a place the
 * connection does not go. A unix socket is not a TCP URI, so it is not dressed
 * as one, and an absent port or database is reported as the value pg will
 * actually use rather than left blank.
 */
function describeTarget(host: string, port: string | number, database: string): string {
  // pg resolves each field as `config[key] || process.env.PG* || default`, so
  // an absent field does NOT mean the libpq default: with PGPORT set, a DSN
  // with no port connects to PGPORT. Round 5 measured PGPORT=6543 winning while
  // this function reported "5432 (default)". Reporting a default pg may not use
  // is the same lie the function exists to prevent, so the same precedence is
  // applied here and the substituted value is marked as such.
  const resolved = (
    explicit: string,
    envName: "PGHOST" | "PGPORT" | "PGDATABASE",
    fallback: string
  ): string => {
    if (explicit !== "") return explicit;
    const ambient = process.env[envName];
    if (ambient !== undefined && ambient !== "") return `${ambient} (from ${envName})`;
    return `${fallback} (default)`;
  };

  const p = resolved(String(port), "PGPORT", "5432");
  const db =
    database === ""
      ? (() => {
          const ambient = process.env.PGDATABASE;
          return ambient !== undefined && ambient !== ""
            ? `${ambient} (from PGDATABASE)`
            : "(default: the connecting user)";
        })()
      : database;

  // A unix socket is not a TCP URI, so it is not dressed as one.
  if (host.startsWith("/")) {
    return `postgresql socket ${host} port ${p} database ${db}`;
  }
  if (host === "") {
    return `postgresql host ${resolved("", "PGHOST", "localhost")} port ${p} database ${db}`;
  }
  // Bracket IPv6 unless the caller already did: `url.hostname` brackets, the
  // connection-string parser returns the bare form.
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `postgresql://${h}:${p}/${db}`;
}

export function redactDsn(dsn: string): string {
  // Report the server `pg` will ACTUALLY reach, not the URL authority.
  //
  // These are two different parsers. `pg` resolves through
  // `pg-connection-string`, which reads `?host=` and `?port=` in PREFERENCE to
  // the authority, so a DSN can read `127.0.0.1:5432` to `new URL` while the
  // connection goes somewhere else. This string is what `doctor` and the
  // startup log present as where transcripts live, so a wrong answer tells an
  // operator their data is on a host it is not on.
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    // Well-formedness only. pg's parser does NOT throw on garbage: it returns
    // `{ host: "base", database: "not a dsn" }` for the string "not a dsn", so
    // it cannot be used to decide whether the input was a DSN at all.
    return "postgresql (dsn not parseable)";
  }

  // With no query string nothing can override the authority's HOST, so
  // `url.host` is the resolved host. Verified against pg-connection-string.
  // `url.host` keeps IPv6 bracketed, which the parser path below has to
  // reconstruct. Note this path still defers to `describeTarget` for the port
  // and database, because an ABSENT port means 5432 to pg and an absent
  // database means the user: the authority alone does not say where it goes.
  if (url.search === "") {
    return describeTarget(url.hostname, url.port, url.pathname.replace(/^\//, ""));
  }

  // Query parameters present: only pg's own parser knows the precedence, and a
  // second implementation of those rules would go stale the moment pg adds an
  // override key.
  try {
    const require = createRequire(import.meta.url);
    const { parse } = require("pg-connection-string") as {
      parse: (s: string) => {
        host?: string | null;
        port?: string | null;
        database?: string | null;
      };
    };
    const c = parse(dsn);
    return describeTarget(c.host ?? "", c.port ?? "", c.database ?? "");
  } catch {
    // pg is an OPTIONAL peer. Without its parser the target cannot be resolved,
    // so say so rather than presenting an authority that may be wrong.
    return `postgresql://${url.host}${url.pathname} (unverified: DSN carries query parameters)`;
  }
}

type RoutedFlightOperation = Exclude<keyof FlightRecorderOperations, "close">;

export interface PostgresFlightRecorderOptions {
  logger?: LoggerLike;
  redactSecrets?: boolean;
  /** Injected in tests so routing and SQL can be exercised without a server. */
  poolFactory?: PgPoolFactory;
}

/**
 * Metadata first: `gateway_metadata.request_id REFERENCES requests(id)` with no
 * ON DELETE CASCADE, in migrations/022 exactly as in the SQLite schema, so the
 * request delete alone raises a foreign-key violation on every row.
 */
const SQL_EXPIRED_REQUEST_IDS =
  "SELECT id FROM requests WHERE datetime_utc < ? ORDER BY datetime_utc LIMIT ?";
const SQL_DELETE_EXPIRED_METADATA = `DELETE FROM gateway_metadata WHERE request_id IN (${SQL_EXPIRED_REQUEST_IDS})`;
const SQL_DELETE_EXPIRED_REQUESTS = `DELETE FROM requests WHERE id IN (${SQL_EXPIRED_REQUEST_IDS})`;

export class PostgresFlightRecorder implements FlightRecorderOperations {
  private readonly roleDsns: PostgresRoleDsns;
  private readonly options: PostgresFlightRecorderOptions;
  private readonly redactEnabled: boolean;
  private readonly logger: LoggerLike | null;
  private readonly runtime: FlightRecorderRuntime;
  private readonly target: string;
  private driver: PostgresStorageDriver | null = null;
  private startupPromise: Promise<PostgresStorageDriver> | null = null;

  constructor(roleDsns: PostgresRoleDsns, options: PostgresFlightRecorderOptions = {}) {
    if (!roleDsns.app) throw new Error("flight recorder: postgres needs an `app` DSN");
    this.roleDsns = roleDsns;
    this.options = options;
    this.redactEnabled = options.redactSecrets ?? isRedactionEnabled();
    this.logger = options.logger ?? null;
    this.target = redactDsn(roleDsns.app);
    this.runtime = new FlightRecorderRuntime(this.target);

    // STARTED here, not awaited here, exactly as the SQLite twin does. Without
    // it an idle gateway reports `initialising` for as long as nothing logs a
    // request, and `readsAreAuthoritative` stays false on a recorder that is
    // perfectly healthy. Swallowed HERE so a constructor's async tail cannot
    // raise an unhandled rejection with nobody to receive it; the memo is
    // cleared by ensureReady's own handler, so the next operation retries and
    // rejects where a caller can be told.
    void this.ensureReady().catch((error: unknown) => {
      this.logger?.error("Flight recorder PostgreSQL bootstrap failed", error);
    });
  }

  health(): FlightRecorderHealth {
    return this.runtime.health();
  }

  /**
   * Build the driver and reach a usable schema, ONCE.
   *
   * The memo is installed BEFORE the first await, which is the defect the job
   * store recorded against its own first version: two callers racing the first
   * operation both built a driver, and the loser's pool was orphaned where
   * close() could not reach it. A rejection clears the memo so the next
   * operation retries rather than poisoning the recorder for the process.
   */
  private ensureReady(): Promise<PostgresStorageDriver> {
    this.startupPromise ??= this.buildAndBootstrap().then(
      driver => {
        this.runtime.markReady();
        return driver;
      },
      (error: unknown) => {
        this.startupPromise = null;
        this.runtime.markFailed(error);
        throw error;
      }
    );
    return this.startupPromise;
  }

  private async buildAndBootstrap(): Promise<PostgresStorageDriver> {
    if (!this.driver) {
      const factory =
        this.options.poolFactory ??
        (await nodePostgresPoolFactory(
          (role, error) => this.logger?.error(`flight recorder pool error on role ${role}`, error),
          { applicationName: "llm-cli-gateway-transcripts" }
        ));
      this.driver = new PostgresStorageDriver(this.roleDsns, factory);
    }
    const driver = this.driver;
    if (await transcriptSchemaReady(driver)) return driver;
    await driver.bootstrap(async conn => {
      await conn.execute("SELECT pg_advisory_xact_lock(?::bigint)", [
        TRANSCRIPT_BOOTSTRAP_LOCK_KEY,
      ]);
      await conn.executeScript(SQL_BOOTSTRAP);
    });
    if (!(await transcriptSchemaReady(driver))) {
      throw new Error(
        "PostgreSQL transcript schema is missing and the compatibility bootstrap did not produce it. " +
          "Run `npm run migrate` with the migration role (migrations/022_flight_recorder_transcripts.sql)."
      );
    }
    return driver;
  }

  /** One routed read. The class is s3sig's declaration, never a literal here. */
  private read<T>(
    operation: RoutedFlightOperation,
    sql: string,
    params: readonly unknown[] = []
  ): Promise<T[]> {
    return this.runtime.run(async () => {
      const driver = await this.ensureReady();
      return driver.withConnection(FLIGHT_RECORDER_OPERATION_CLASSES[operation], conn =>
        conn.query<T>(sql, params)
      );
    });
  }

  /** One routed write, as a transaction, for the reasons the SQLite twin gives. */
  private write(
    operation: RoutedFlightOperation,
    fn: (connection: StorageConnection) => Promise<void>
  ): Promise<void> {
    return this.runtime.run(async () => {
      const driver = await this.ensureReady();
      await driver.transaction(FLIGHT_RECORDER_OPERATION_CLASSES[operation], fn);
    });
  }

  async logStart(entry: FlightLogStart): Promise<void> {
    // Synchronous prologue, for the SQLite twin's reasons: the owner principal
    // comes from an AsyncLocalStorage context and the derived signals must
    // describe the text as STORED, so neither may be resolved inside a
    // transaction body the driver schedules later.
    const stored = this.redactEnabled ? redactStart(entry) : entry;
    const ownerPrincipal = stored.ownerPrincipal ?? resolveOwnerPrincipal(getRequestContext());
    const datetimeUtc = new Date().toISOString();
    const derived = derivePromptSignals(stored.prompt ?? "");

    await this.write("logStart", async conn => {
      await conn.execute(SQL_INSERT_REQUEST, [
        stored.correlationId,
        stored.cli,
        stored.model,
        stored.prompt,
        stored.system || null,
        stored.sessionId || null,
        datetimeUtc,
        stored.stablePrefixHash ?? null,
        stored.stablePrefixTokens ?? null,
        stored.cacheControlBlocks ?? null,
        stored.cacheControlTtlSeconds ?? null,
        ownerPrincipal,
        derived.promptChars,
        derived.contentClass,
        derived.derivationVersion,
      ]);
      await conn.execute(SQL_INSERT_METADATA, [stored.correlationId, stored.asyncJobId || null]);
    });
  }

  async logComplete(correlationId: string, result: FlightLogResult): Promise<void> {
    const stored = this.redactEnabled
      ? { ...result, response: redactSecrets(result.response) }
      : result;
    const thinkingBlocks =
      stored.thinkingBlocks && stored.thinkingBlocks.length > 0
        ? JSON.stringify(truncateThinkingBlocks(stored.thinkingBlocks))
        : null;

    const completionRank = stored.completionKind === "presumed" ? 1 : 2;
    await this.write("logComplete", async conn => {
      await conn.execute(SQL_UPDATE_REQUEST_COMPLETE, [
        stored.response,
        stored.durationMs,
        stored.inputTokens ?? null,
        stored.outputTokens ?? null,
        stored.cacheReadTokens ?? null,
        stored.cacheCreationTokens ?? null,
        stored.costBasis ?? null,
        correlationId,
        completionRank,
      ]);
      await conn.execute(SQL_UPDATE_METADATA_COMPLETE, [
        stored.retryCount,
        stored.circuitBreakerState,
        stored.costUsd ?? null,
        stored.approvalDecision ?? null,
        // BOOLEAN, not the 1/0 SQLite stored. The value never leaves the
        // database, so no reader sees the type change.
        stored.optimizationApplied,
        thinkingBlocks,
        stored.exitCode,
        stored.httpStatus ?? null,
        stored.errorMessage ?? null,
        stored.providerSessionId ?? null,
        stored.stopReason ?? null,
        stored.status,
        completionRank,
        correlationId,
        completionRank,
      ]);
    });
  }

  async recordCompressionTelemetry(
    correlationId: string,
    telemetry: CompressionTelemetry
  ): Promise<void> {
    await this.write("recordCompressionTelemetry", async conn => {
      await conn.execute(SQL_UPDATE_COMPRESSION, [
        telemetry.route,
        telemetry.transforms.join(","),
        telemetry.originalChars,
        telemetry.compressedChars,
        telemetry.estimatedTokensSaved,
        correlationId,
      ]);
    });
  }

  async recordRouting(correlationId: string, routing: RoutingRecord): Promise<void> {
    await this.write("recordRouting", async conn => {
      await conn.execute(SQL_UPDATE_ROUTING, [
        routing.estCostUsd ?? null,
        routing.estConfidence ?? null,
        routing.reason ?? null,
        routing.considered ?? null,
        routing.reroutes ?? null,
        correlationId,
      ]);
    });
  }

  async readCacheRowsBySession(sessionId: string): Promise<CacheAggregateRow[]> {
    return this.read<CacheAggregateRow>(
      "readCacheRowsBySession",
      `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash, datetime_utc, cache_control_blocks, cache_control_ttl_seconds
       FROM requests WHERE session_id = ? ORDER BY datetime_utc DESC`,
      [sessionId]
    );
  }

  async readCacheRowsByPrefix(stablePrefixHash: string): Promise<CacheAggregateRow[]> {
    return this.read<CacheAggregateRow>(
      "readCacheRowsByPrefix",
      `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash, datetime_utc
       FROM requests WHERE stable_prefix_hash = ? ORDER BY datetime_utc ASC`,
      [stablePrefixHash]
    );
  }

  async readCacheRowsGlobal(sinceIso?: string): Promise<CacheAggregateRow[]> {
    const select = `SELECT cli, model,
              COALESCE(cache_read_tokens, 0) AS cache_read_tokens,
              COALESCE(cache_creation_tokens, 0) AS cache_creation_tokens,
              stable_prefix_hash, datetime_utc, cache_control_blocks, cache_control_ttl_seconds
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
       WHERE r.id = ? LIMIT 1`,
      [correlationId]
    );
    return row ?? null;
  }

  async listRequestSummaries(filter: RequestSummaryFilter): Promise<PersistedRequestSummaryRow[]> {
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
       WHERE m.routed IS TRUE
       ORDER BY r.datetime_utc DESC
       LIMIT ?`,
      [limit]
    );
  }

  /**
   * `COUNT(*)::int`, not `COUNT(*)`. `pg` returns int8 as a STRING, so an
   * uncast count reaches `FlightRecorderStorageStats.requestRows: number` as
   * "31895" and every arithmetic comparison downstream is then a string
   * comparison that happens to look right.
   */
  async readStorageStats(retentionCutoffIso?: string): Promise<FlightRecorderStorageStats> {
    // TWO statements, not a CASE over `to_regclass`. PostgreSQL resolves every
    // relation name at PARSE time, including one inside an untaken CASE branch,
    // so the guarded single statement raised `relation "schema_migrations" does
    // not exist` on exactly the database the guard was written for. Found by
    // running it, not by reading it.
    const ledger = await this.read<{ present: boolean }>(
      "readStorageStats",
      "SELECT to_regclass('schema_migrations') IS NOT NULL AS present"
    );
    const version = ledger[0]?.present
      ? await this.read<{ v: number | null }>(
          "readStorageStats",
          "SELECT MAX(version) AS v FROM schema_migrations"
        )
      : [];
    const totals = await this.read<{ c: number; oldest: string | null; newest: string | null }>(
      "readStorageStats",
      "SELECT COUNT(*)::int AS c, MIN(datetime_utc) AS oldest, MAX(datetime_utc) AS newest FROM requests"
    );
    let beyondRetention: number | null = null;
    if (retentionCutoffIso) {
      const rows = await this.read<{ c: number }>(
        "readStorageStats",
        "SELECT COUNT(*)::int AS c FROM requests WHERE datetime_utc < ?",
        [retentionCutoffIso]
      );
      beyondRetention = rows[0]?.c ?? 0;
    }
    const present = await this.read<{ name: string }>(
      "readStorageStats",
      `SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name IN ('jobs', 'validation_runs')`
    );
    const names = new Set(present.map(row => row.name));
    const coResident: CoResidentTableStats[] = [];
    if (names.has("jobs")) {
      const rows = await this.read<{ c: number; unfinished: number }>(
        "readStorageStats",
        "SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE status IN ('queued', 'running'))::int AS unfinished FROM jobs"
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
        "SELECT COUNT(*)::int AS c, COUNT(*) FILTER (WHERE status = 'running')::int AS unfinished FROM validation_runs"
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
      // NULL, not 0. Reclaiming space is not an operator action on this engine:
      // autovacuum returns dead tuples to the table for reuse, and the operator
      // has nothing to run and no lock to schedule. Zero would claim a
      // measurement was taken and came back empty.
      reclaimableBytes: null,
      coResident,
    };
  }

  /**
   * The Postgres termination of the same policy.
   *
   * s11's constraint expected this half to drop partitions. It does not, and
   * cannot: migrations/022 authors `requests` and `gateway_metadata` as plain
   * unpartitioned tables, so the two terminations differ in their AFTERMATH
   * rather than in the statement. Here autovacuum reclaims the dead tuples with
   * no exclusive lock and no operator step; on SQLite the pages go on a
   * freelist and the file stays the size it was.
   *
   * The batch bound still matters even without that lock: `[persistence.roles]`
   * may point this at a `llmgw_retention` credential on a SHARED store, and an
   * unbounded DELETE there holds row locks against every other instance.
   */
  async evictExpiredRequests(cutoffIso: string, limit: number): Promise<number> {
    let deleted = 0;
    await this.write("evictExpiredRequests", async conn => {
      await conn.execute(SQL_DELETE_EXPIRED_METADATA, [cutoffIso, limit]);
      const result = await conn.execute(SQL_DELETE_EXPIRED_REQUESTS, [cutoffIso, limit]);
      deleted = Number(result.rowsAffected ?? 0);
    });
    return deleted;
  }

  /** Drain what has started, then end the pools. MUST be awaited; see the SQLite twin. */
  async close(): Promise<void> {
    await this.runtime.close();
    await this.driver?.close();
    this.driver = null;
    this.startupPromise = null;
  }
}

/** Redact secrets from the persisted prompt/system copy (audit log only). */
function redactStart(entry: FlightLogStart): FlightLogStart {
  return {
    ...entry,
    prompt: redactSecrets(entry.prompt),
    system: entry.system ? redactSecrets(entry.system) : entry.system,
  };
}

/**
 * Both tables and every column the DML above binds.
 *
 * Column-level, not table-level: a database carrying a partially applied
 * transcript schema would pass a `to_regclass('requests')` check and then fail
 * on the first INSERT, which is the failure the job store's own readiness check
 * is column-level to avoid.
 */
/**
 * Columns whose TYPE the queries below depend on, not merely their presence.
 *
 * A name-only readiness check fails OPEN: with `routed` as INTEGER rather than
 * BOOLEAN the check passed, the recorder reported `active` and
 * `readsAreAuthoritative`, and then `WHERE m.routed IS TRUE` (:522) was rejected
 * by the server with "argument of IS TRUE must be type boolean, not type
 * integer". Health said fine and the read died.
 *
 * Only the columns a query treats as a specific type are listed. Everything
 * else is still checked by name, because a wrong-typed TEXT column produces a
 * wrong value rather than a rejected statement, and that belongs to the schema
 * parity gate rather than to a runtime readiness probe.
 */
const TRANSCRIPT_REQUIRED_TYPES: Readonly<Record<string, string>> = {
  "gateway_metadata.routed": "boolean",
  "gateway_metadata.optimization_applied": "boolean",
  "gateway_metadata.cost_usd": "double precision",
  "gateway_metadata.route_est_cost_usd": "double precision",
};

async function transcriptSchemaReady(driver: PostgresStorageDriver): Promise<boolean> {
  const rows = await driver.withConnection("analytics_read", conn =>
    conn.query<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name IN ('requests', 'gateway_metadata')`
    )
  );
  const have = new Map(rows.map(row => [`${row.table_name}.${row.column_name}`, row.data_type]));
  if (!TRANSCRIPT_REQUIRED_COLUMNS.every(column => have.has(column))) return false;
  // Type, for the columns a query depends on. Readiness that ignores type is
  // readiness that reports healthy and then fails the read.
  for (const [column, expected] of Object.entries(TRANSCRIPT_REQUIRED_TYPES)) {
    if (have.get(column) !== expected) return false;
  }
  return true;
}

export const TRANSCRIPT_REQUIRED_COLUMNS: readonly string[] = [
  ...[
    "id",
    "cli",
    "model",
    "prompt",
    "system",
    "response",
    "session_id",
    "duration_ms",
    "datetime_utc",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_creation_tokens",
    "owner_principal",
    "cost_basis",
    "derived_prompt_chars",
    "derived_content_class",
    "derivation_version",
    "stable_prefix_hash",
    "stable_prefix_tokens",
    "cache_control_blocks",
    "cache_control_ttl_seconds",
  ].map(column => `requests.${column}`),
  ...[
    "request_id",
    "retry_count",
    "circuit_breaker_state",
    "cost_usd",
    "approval_decision",
    "optimization_applied",
    "thinking_blocks",
    "exit_code",
    "http_status",
    "error_message",
    "async_job_id",
    "provider_session_id",
    "stop_reason",
    "routed",
    "route_est_cost_usd",
    "route_est_confidence",
    "route_reason",
    "route_considered",
    "route_reroutes",
    "status",
    "compression_route",
    "compression_transforms",
    "compression_original_chars",
    "compression_compressed_chars",
    "compression_tokens_saved_est",
  ].map(column => `gateway_metadata.${column}`),
];
