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

/**
 * One place that turns a DSN into a printable identity: host, port and
 * database, never the password, and never a place the connection does not go.
 *
 * THE DEFECT CLASS THIS EXISTS TO CLOSE is reporting a target in a
 * representation other than the one `pg` resolves. Four rounds produced four
 * variants of it, each fixed at the site and each reappearing a layer out:
 *
 *   r3  the URL authority was reported while `?host=` moved the connection.
 *   r4  `?host=/var/run/postgresql` became `postgresql:///var/run/postgresql:5433/db`,
 *       which re-parses as an empty host and a database named `var/run/...`.
 *   r4  `?host=::1` became `postgresql://::1:5433/db`, unbracketed and ambiguous.
 *   r5  an absent port was reported as `5432 (default)` while PGPORT won.
 *   r6  the r5 fix annotated provenance INSIDE a URI, so PGPORT=6543 produced
 *       `postgresql://127.0.0.1:6543 (from PGPORT)/db` (not a URI at all) and
 *       PGDATABASE produced `postgresql://127.0.0.1:5433/ambient_db (from PGDATABASE)`,
 *       which IS a valid URI naming a database that does not exist.
 *
 * Every one of those came from the same two mistakes, so both are removed here
 * rather than patched again.
 *
 * ONE PARSER. `pg` resolves a DSN through `pg-connection-string` and then
 * layers `config[key] || process.env.PG* || default` on top. Re-implementing
 * either half is what produced r3 and r5, so neither is re-implemented: the
 * resolved target is read off a `pg.Client` constructed and never connected,
 * which IS the code that decides where the connection goes. `parse` is
 * consulted only to learn which fields the DSN stated explicitly, so that a
 * substituted value can be marked as substituted.
 *
 * ONE SHAPE. Never a URI. A URI-shaped report has to be abandoned for sockets,
 * for IPv6 and for any annotated field, and every abandonment was a chance to
 * emit something that still looked like a DSN and was not. A reader cannot
 * paste this form into a client by accident, which is the point.
 */
/** The four target fields, the only ones this module hands to `pg`. */
interface PgTargetConfig {
  host?: string;
  port?: string;
  database?: string;
  user?: string;
}

type FieldSource = "explicit" | "PGHOST" | "PGPORT" | "PGDATABASE" | "default";

interface ResolvedTarget {
  host: string;
  hostSource: FieldSource;
  isSocket: boolean;
  port: string;
  portSource: FieldSource;
  database: string;
  /** Prebuilt because an unstated database is the USER, whose own origin varies. */
  databaseNote: string;
}

/** `pg` is an optional peer, but redactDsn is only reached where it must exist. */
function loadPgTargetResolvers(): {
  parse: (s: string) => Record<string, string | null | undefined>;
  Client: new (config: PgTargetConfig) => {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
  };
} {
  const require = createRequire(import.meta.url);
  const { parse } = require("pg-connection-string") as {
    parse: (s: string) => Record<string, string | null | undefined>;
  };
  const { Client } = require("pg") as {
    Client: new (config: PgTargetConfig) => {
      host?: string;
      port?: number;
      database?: string;
      user?: string;
    };
  };
  return { parse, Client };
}
/**
 * Query parameters `pg-connection-string` reads FROM DISK, stripped before it
 * ever sees the string.
 *
 * Round 7, measured: `parse("...?sslcert=/etc/hosts")` calls
 * `fs.readFileSync("/etc/hosts")`, and so does `new Client({connectionString})`.
 * A function whose entire job is to PRINT a host and port must not read a file
 * named in its input: a FIFO or /dev/zero there would hang or exhaust the
 * process at startup, before anything connects. None of the three can move the
 * host, port or database, so removing them cannot change the answer.
 */
const SSL_FILE_PARAMS = new Set(["sslcert", "sslkey", "sslrootcert"]);

/**
 * pg's OWN preprocessing, copied because the alternative is a second one.
 *
 * `pg-connection-string` does not hand the caller's string to `new URL`. It
 * first rewrites the WHOLE string when it contains a space or a malformed
 * escape, and `encodeURI` encodes `[` and `]` while doing so:
 *
 *   if (/ |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(str))
 *     str = encodeURI(str).replace(/%25(\d\d)/g, '%$1')
 *
 * Round 9 BLOCKER, measured. Editing the query as TEXT changed which branch
 * that test takes, so removing a space along with `?sslcert=/tmp/foo bar` made
 * `postgresql://u:p@[::1]:5433/db?...` parse here and throw `Invalid URL` in
 * pg, and the report named a host pg never reached. The reverse also held.
 * The old comment "removing them cannot change the answer" was false.
 *
 * That is the FOURTH time a different representation was compared from the one
 * that acts (r3 authority vs `?host=`, r6 `new URL` vs pg's parser, r8 raw vs
 * decoded query keys). So this no longer edits the DSN as text at all: it runs
 * pg's pipeline, deletes the parameters through `searchParams` (which sees the
 * same DECODED keys pg iterates), and serialises back. One parser, one string.
 */
/**
 * Does this string carry a PostgreSQL scheme, as the parser pg uses sees it?
 *
 * Round 9 BLOCKER, both reviewers: this tested the RAW string, so a leading
 * tab, LF, CR, NUL or ESC made it answer no while pg answered yes. WHATWG
 * strips leading and trailing C0 controls and spaces before looking at the
 * scheme, so `\tpostgresql://h/db` IS `postgresql://h/db` to pg, and calling
 * it unparseable was the same mistake in its last corner: testing a
 * representation the parser does not use.
 *
 * The test stays NARROWER than pg on purpose. pg treats any scheme but
 * `socket:` as TCP, so `pg://h/db` and a bare `/path` resolve there; the DSNs
 * that reach this function come from gateway config, which admits these two
 * spellings, and anything else is likelier a mistake than a target. What it
 * must not do is disagree with pg about the SAME DSN.
 */
function carriesPostgresScheme(dsn: string): boolean {
  // The exact trim WHATWG performs before it looks at the scheme: leading and
  // trailing C0 control or space. The control characters ARE the subject here,
  // which is why the rule is disabled rather than the range narrowed.
  // eslint-disable-next-line no-control-regex
  const trimmed = dsn.replace(/^[\u0000-\u0020]+/, "").replace(/[\u0000-\u0020]+$/, "");
  return /^postgres(ql)?:\/\//i.test(trimmed);
}

function pgPreprocess(dsn: string): string {
  return / |%[^a-f0-9]|%[a-f0-9][^a-f0-9]/i.test(dsn)
    ? encodeURI(dsn).replace(/%25(\d\d)/g, "%$1")
    : dsn;
}

/** `new URL` exactly as pg calls it, dummy base, dummy host and all. */
function pgUrl(dsn: string): URL | null {
  const str = pgPreprocess(dsn);
  try {
    return new URL(str, "postgres://base");
  } catch {
    try {
      return new URL(str.replace("@/", "@___DUMMY___/"), "postgres://base");
    } catch {
      return null;
    }
  }
}

/**
 * The DSN pg would parse, with only the three disk-reading parameters removed.
 *
 * Exported for its own tests: the deletion happens on a URL object, so nothing
 * about it is observable from `redactDsn` beyond the absence of a file read.
 */
export function withoutSslFileParams(dsn: string): string {
  const url = pgUrl(dsn);
  if (url === null) return dsn;
  // `searchParams` yields DECODED keys, which is what pg iterates, so an
  // encoded `ssl%63ert` and a tab-bearing `ssl<TAB>cert` (WHATWG strips tabs)
  // both arrive here as `sslcert`. Round 8 and round 9 each found one of those
  // getting past a comparison done on the raw text.
  let removed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (SSL_FILE_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
      removed = true;
    }
  }
  // Unchanged input, unchanged output: serialising even when nothing matched
  // would hand pg a re-encoded string for no reason.
  return removed ? url.href : dsn;
}

/**
 * The host is reported EXACTLY as pg resolved it. There is no normalisation.
 *
 * There used to be. `normaliseTcpHost` stripped a leading `[` and trailing `]`
 * and re-added them when the remainder held a colon, because the old URI-shaped
 * report made `postgresql://::1:5433/db` ambiguous about where the port began.
 *
 * The report has not been URI-shaped since round 7. Host and port are separate
 * LABELLED fields, so nothing is ambiguous, and the normalisation had become a
 * pure source of disagreement. Round 8 measured four:
 *
 *   ?host=[foo]        pg "[foo]"       reported "foo"
 *   ?host=[]           pg "[]"          reported ""
 *   ?host=[127.0.0.1]  pg "[127.0.0.1]" reported "127.0.0.1"
 *   ?host=:            pg ":"           reported "[:]"
 *
 * pg keeps brackets it was given and adds none. So does this now. Deleting the
 * function was the fix; rewriting its bracket rule would have been the fourth
 * attempt at a rule that exists only to serve a format that is gone.
 */

const MAX_FIELD_CHARS = 120;

/**
 * Characters that BREAK, REORDER or COMMAND when a log line is rendered.
 *
 * Defined by PROPERTY, not by enumeration. Round 9 found the enumerated set
 * missing four, and an enumerated set will always be missing the next one:
 *   U+009B  CSI. This string goes to stderr, and `CSI 2J` ERASES the screen.
 *   U+061C  Arabic Letter Mark, the one Bidi_Control the range missed.
 *   U+007F  DEL.
 *   U+2060  word joiner.
 * So: the whole C1 block (U+0080..U+009F, which contains NEL and CSI), DEL,
 * the line and paragraph separators, the zero-width and invisible-operator
 * ranges, the byte-order mark, and `\p{Bidi_Control}` for every character
 * Unicode itself says reorders text.
 *
 * JSON quoting escapes NONE of them. A bidi override survived it and still
 * reverses everything after it on the line, and round 8 measured U+2028
 * splitting the report into two lines while a /[\ur\un]/ assertion passed.
 * `%0A` was the round 7 case; these are the same class in other code points,
 * which is why the set is defined by WHAT THEY DO rather than extended one
 * character at a time.
 */
const UNSAFE_IN_A_LOG_LINE =
  /[\u0080-\u009F\u007F\u2028\u2029\u200B-\u200F\u2060-\u2064\u2066-\u206F\uFEFF]|\p{Bidi_Control}/gu;

/**
 * Words this format uses as STRUCTURE. A value equal to one of them reads as a
 * delimiter: round 8 measured `?host=port` printing
 * `postgresql host port port 5433 database db`, which agrees with pg and is
 * unreadable. Quoting the collision is enough; the value is still named.
 */
const FORMAT_KEYWORDS = new Set([
  "host",
  "socket",
  "port",
  "database",
  "postgresql",
  // The words an ANNOTATION is written in: `(from PGHOST)`, `(default)`.
  // Round 9: `?host=from` printed `postgresql host from port 5433`.
  "from",
  "default",
]);

/** A field value, quoted unless it is plainly a host, path, port or name. */
function show(value: string): string {
  // A long value is truncated BEFORE quoting: pg imposes no length limit worth
  // relying on here, and a health line is read by a human, not parsed.
  const bounded =
    value.length > MAX_FIELD_CHARS
      ? `${value.slice(0, MAX_FIELD_CHARS)}... (${value.length} chars)`
      : value;
  if (/^[A-Za-z0-9._:/[\]-]+$/.test(bounded) && !FORMAT_KEYWORDS.has(bounded.toLowerCase())) {
    return bounded;
  }
  return JSON.stringify(bounded).replace(
    UNSAFE_IN_A_LOG_LINE,
    c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );
}

function resolveTarget(dsn: string): ResolvedTarget | null {
  // pg's parser does NOT throw on garbage: `parse("not a dsn")` returns
  // `{ host: "base", database: "not a dsn" }`, so it cannot decide whether the
  // input was a DSN.
  //
  // Requiring the scheme is that decision. It is NOT "pg's own test", which an
  // earlier version of this comment claimed and round 7 falsified: pg-connection-string
  // treats ANY scheme but `socket:` as TCP, so `pg://h/db` and a bare `/path`
  // also resolve there. This is deliberately narrower than pg, because the only
  // DSNs that reach here come from gateway config, which admits exactly these
  // two spellings. Anything else is likelier a mistake than a target.
  if (!carriesPostgresScheme(dsn)) return null;

  let parse: ReturnType<typeof loadPgTargetResolvers>["parse"];
  let Client: ReturnType<typeof loadPgTargetResolvers>["Client"];
  try {
    ({ parse, Client } = loadPgTargetResolvers());
  } catch {
    return null;
  }

  let stated: Record<string, string | null | undefined>;
  let resolved: { host?: string; port?: number; database?: string; user?: string };
  try {
    stated = parse(withoutSslFileParams(dsn));
    // FIELDS, not the connection string. Handing Client the string makes it
    // re-parse and read the SSL files again; handing it the four target fields
    // applies the SAME `config[key] || process.env.PG* || default` resolution
    // (measured identical) and touches no disk. This object is what the driver
    // hands to the socket, so reading it cannot disagree with the connection.
    resolved = new Client({
      host: stated.host || undefined,
      port: stated.port || undefined,
      database: stated.database || undefined,
      user: stated.user || undefined,
    });
  } catch {
    return null;
  }

  const wasStated = (value: string | null | undefined): boolean =>
    value !== null && value !== undefined && value !== "";
  const ambient = (name: string): boolean => {
    const value = process.env[name];
    return value !== undefined && value !== "";
  };
  const sourceOf = (
    statedValue: string | null | undefined,
    envName: "PGHOST" | "PGPORT" | "PGDATABASE"
  ): FieldSource => (wasStated(statedValue) ? "explicit" : ambient(envName) ? envName : "default");

  // An unstated database is not a default NAME: pg substitutes the connecting
  // USER, whose own origin is the DSN, PGUSER, or the OS account.
  //
  // Round 7 BLOCKER: this used to report `(from PGUSER)` whenever PGUSER was
  // merely SET, so `postgresql://bob@host` with PGUSER=alice printed
  // `database bob (from PGUSER)`. pg had taken `bob` from the DSN and ignored
  // PGUSER entirely, and the annotation sent the reader to the wrong variable.
  // The user's provenance decides the note, not the presence of the variable.
  const databaseNote = wasStated(stated.database)
    ? ""
    : ambient("PGDATABASE")
      ? " (from PGDATABASE)"
      : wasStated(stated.user)
        ? " (default: the connecting user, from the DSN)"
        : ambient("PGUSER")
          ? " (default: the connecting user, from PGUSER)"
          : " (default: the connecting user)";

  const host = String(resolved.host ?? "");
  const isSocket = host.startsWith("/");
  return {
    host,
    hostSource: sourceOf(stated.host, "PGHOST"),
    isSocket,
    port: String(resolved.port ?? ""),
    portSource: sourceOf(stated.port, "PGPORT"),
    database: String(resolved.database ?? ""),
    databaseNote,
  };
}

function annotate(source: FieldSource): string {
  if (source === "explicit") return "";
  if (source === "default") return " (default)";
  return ` (from ${source})`;
}

/**
 * Host, port and database only. A DSN carries a password and health output is
 * read aloud.
 *
 * The guarantee is that the result is never URI-SHAPED, NOT that it contains no
 * `://` anywhere. Round 7 falsified the stronger claim: pg accepts
 * `?host=evil://host`, and naming the host pg resolved is the whole point, so
 * the substring can appear INSIDE a value. What must never happen is a result a
 * reader could paste back as a DSN.
 */
export function redactDsn(dsn: string): string {
  const target = resolveTarget(dsn);
  if (target === null) return "postgresql (dsn not parseable)";
  const where = target.isSocket ? "socket" : "host";
  const host = `${show(target.host)}${annotate(target.hostSource)}`;
  const port = `${show(target.port)}${annotate(target.portSource)}`;
  const database = `${show(target.database)}${target.databaseNote}`;
  return `postgresql ${where} ${host} port ${port} database ${database}`;
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
