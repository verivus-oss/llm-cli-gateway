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
import { carriesPostgresDsnScheme } from "./storage/roles.js";
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
  /** The same three fields resolved from the DSN with its PASSWORD blanked. */
  withoutPassword: { host: string; port: string; database: string };
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
 * Run pg's parser on the CALLER'S EXACT STRING, with disk reads disabled.
 *
 * THE HISTORY THIS ENDS. Five rounds produced five versions of one defect:
 * something here compared, validated or rewrote one representation while pg
 * acted on another.
 *   r3  the URL authority reported while `?host=` moved the connection.
 *   r6  `new URL` decided well-formedness while pg used its own parser.
 *   r8  the stripper compared RAW query keys while pg compared DECODED ones.
 *   r9  editing the query as TEXT changed which `encodeURI` branch pg took.
 *   r10 rebuilding the URL leaked pg's INTERNAL `___DUMMY___` sentinel, so
 *       `postgresql://u:p@/db?sslcert=/etc/hosts` reported host `___DUMMY___`
 *       while pg used `localhost`. pg rewrites `@/` to `@___DUMMY___/` and
 *       sets a private flag that turns the hostname back into ""; copying the
 *       rewrite without the flag is half a parser.
 *
 * Every one of those was introduced by the fix for the one before it, because
 * each fix still handled the DSN itself somewhere. So this one does not. There
 * is no preprocessing copy, no query editing, no re-serialisation and no
 * second parse: pg's `parse` is handed the ORIGINAL string.
 *
 * The only reason this module ever touched the string was to avoid disk reads.
 * `parse` calls `fs.readFileSync` on `sslcert`, `sslkey` and `sslrootcert`
 * (measured), and a function whose job is to PRINT a host must not read a file
 * named in its input, where a FIFO would hang the process at startup. So the
 * READ is suppressed rather than the STRING rewritten.
 *
 * `parse` is synchronous and `finally` restores the real function even when it
 * throws, so the window is narrow. Two claims about it have now been wrong in
 * OPPOSITE directions, so this states only what was measured.
 *
 * Round 11 corrected "no other JavaScript can run" to "a synchronous `warning`
 * listener runs inside it". Round 13 measured that too: `parse` does call
 * `process.emitWarning` for the deprecated SSL modes, but an ordinary
 * `process.on("warning")` listener fires on a LATER tick, after `finally` has
 * restored the real function. Measured order: stubbed, parse returns, restored,
 * listener runs.
 *
 * What is true is narrower. Code that replaces `process.emitWarning` itself
 * runs synchronously inside the window and would observe the substitute, as
 * would anything else that reaches `require("fs").readFileSync` during it.
 * That is a real if small hole, and narrowing it further means editing the DSN
 * again, which is the defect class this module spent five rounds removing.
 */

/**
 * What `parse` does with the bytes, measured in the installed
 * `pg-connection-string`: it assigns `config.ssl.cert|key|ca` from
 * `<bytes>.toString()` and then INSPECTS exactly one of them, `if
 * (!config.ssl.ca)`, in the `uselibpqcompat=true` + `sslmode=verify-ca` branch,
 * where an empty CA throws. Nothing parses the content.
 *
 * So the substitute must be NON-EMPTY. Round 11 BLOCKER, both reviewers:
 * `Buffer.alloc(0)` made that branch throw for a DSN whose real, non-empty
 * `sslrootcert` satisfies it, so the report said "not parseable" for a target
 * pg resolves. Truthiness is the whole contract; any non-empty value is
 * neutral for every decision `parse` makes about the target.
 */
const UNREAD_FILE_SUBSTITUTE = Buffer.from("unread");

function parseWithoutReadingFiles(
  parse: (s: string) => Record<string, string | null | undefined>,
  dsn: string
): Record<string, string | null | undefined> {
  const require = createRequire(import.meta.url);
  const fs = require("fs") as { readFileSync: (...args: unknown[]) => unknown };
  const real = fs.readFileSync;
  fs.readFileSync = () => UNREAD_FILE_SUBSTITUTE;
  try {
    return parse(dsn);
  } finally {
    fs.readFileSync = real;
  }
}

/**
 * Does this string carry a PostgreSQL scheme?
 *
 * It defers to `carriesPostgresDsnScheme`, the SAME predicate `config.ts` uses
 * to decide what it will accept as a connection string. That is the whole
 * design: this function reports a target only for strings the gateway would
 * accept as a DSN, so the gate cannot be narrower or wider than the validator.
 *
 * ROUND 13 BLOCKER, both reviewers, and the most serious defect in this series.
 * Round 12 replaced a hand-rolled sanitiser with `new URL(dsn).protocol` on the
 * argument that WHATWG should do its own preprocessing. WHATWG trims a leading
 * space, so ` postgresql://u:secret@h/db` passed the gate. pg does NOT trim it:
 * the space triggers pg's `encodeURI` branch, pg resolves its own base host,
 * and the whole credential-bearing string becomes the DATABASE. Measured:
 *
 *   redactDsn(" postgresql://u:sup3rsecret@127.0.0.1:5433/db")
 *     -> database " postgresql://u:sup3rsecret@127.0.0.1:5433/db"
 *   redactDsn("postgres:/user:sup3rsecret@host/db")
 *     -> database "user:sup3rsecret@host/db"
 *
 * and that value goes to the startup log line in `createFlightRecorder`. The
 * gate had been kept in round 12 specifically to prevent credential echo, and
 * the clause added for correctness was the clause that opened it.
 *
 * The lesson is not "pick a better URL parser". Faithfully reporting what pg
 * resolves is INCOMPATIBLE with never printing a password, because when pg
 * misparses a DSN what it resolves CONTAINS the password. So the input is
 * required to be the authority form, where pg puts credentials in the userinfo
 * and they never reach a reported field.
 *
 * WHAT THIS REFUSES, stated rather than discovered later. Every one of these is
 * a string pg would resolve to something:
 *
 *   ` postgresql://h/db`     leading whitespace (round 9, and the leak above)
 *   `post<TAB>gresql://h/db` a control character inside the scheme (round 10)
 *   `postgres:/db`           single slash, no authority (round 12)
 *   `pg://h/db`, `socket:/p` schemes pg accepts and this gateway does not
 *   `/var/run/postgresql db` a bare socket path
 *
 * Round 10 treated the TAB case as a defect and round 12 the single-slash case,
 * both on the principle that this must agree with pg. That principle is now
 * subordinate to not printing secrets, and `config.ts` rejects all of these
 * before they can reach a live connection anyway.
 */
function carriesPostgresScheme(dsn: string): boolean {
  return carriesPostgresDsnScheme(dsn);
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
 * Defined by PROPERTY, and round 10 proved the first property was the wrong
 * one. An enumerated bidi range missed U+009B CSI (`CSI 2J` erases a terminal
 * screen, and this string goes to stderr) and U+061C. Naming
 * `\p{Bidi_Control}` fixed those and still passed U+00AD SOFT HYPHEN, U+034F,
 * U+070F, U+2060, U+FE0F and U+E0061.
 *
 * The class those all belong to is INVISIBLE OR CONTROLLING, which Unicode
 * already names: `\p{Cf}` (format characters, which is every bidi control,
 * the zero-width joiners, the Arabic and Syriac marks and the interlinear
 * annotations) and `\p{Default_Ignorable_Code_Point}` (soft hyphen, variation
 * selectors, tag characters). Plus the C1 block and DEL, which JSON leaves raw
 * because it escapes C0 only.
 *
 * COST, stated because it is real: a database name legitimately containing a
 * zero-width joiner (an emoji sequence) is now shown escaped. That is the
 * right trade for a diagnostic line whose whole purpose is to be believed.
 */
const UNSAFE_IN_A_LOG_LINE =
  /[\u0080-\u009F\u007F\u2028\u2029]|\p{Cf}|\p{Default_Ignorable_Code_Point}/gu;

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
  // BY CODE POINT, not by UTF-16 code unit. Round 10: a 120-character value
  // ending in an emoji is 121 units, so slicing at 120 SEVERED THE SURROGATE
  // PAIR and the suffix then called 121 units "chars". Array spread iterates
  // code points, so neither can happen.
  const points = [...value];
  const bounded =
    points.length > MAX_FIELD_CHARS
      ? `${points.slice(0, MAX_FIELD_CHARS).join("")}... (${points.length} chars)`
      : value;
  if (/^[A-Za-z0-9._:/[\]-]+$/.test(bounded) && !FORMAT_KEYWORDS.has(bounded.toLowerCase())) {
    return bounded;
  }
  return JSON.stringify(bounded).replace(UNSAFE_IN_A_LOG_LINE, c => {
    // codePointAt, not charCodeAt. Round 11 BLOCKER, codex: the pattern matches
    // a whole code point but this emitted only its HIGH SURROGATE, so U+E0061
    // and U+E0062 both rendered as `\udb40` and two different databases
    // produced identical reports. A line whose job is to name the target must
    // not collapse two targets into one string.
    const point = c.codePointAt(0) ?? 0;
    return point > 0xffff
      ? `\\u{${point.toString(16).padStart(5, "0")}}`
      : `\\u${point.toString(16).padStart(4, "0")}`;
  });
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

  const resolveFields = (
    candidate: string
  ): {
    stated: Record<string, string | null | undefined>;
    resolved: { host?: string; port?: number; database?: string; user?: string };
  } => {
    const parsed = parseWithoutReadingFiles(parse, candidate);
    return {
      stated: parsed,
      resolved: new Client({
        host: parsed.host || undefined,
        port: parsed.port || undefined,
        database: parsed.database || undefined,
        user: parsed.user || undefined,
      }),
    };
  };

  let stated: Record<string, string | null | undefined>;
  let resolved: { host?: string; port?: number; database?: string; user?: string };
  let withoutPassword: { host: string; port: string; database: string };
  try {
    stated = parseWithoutReadingFiles(parse, dsn);
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
    // The SAME resolution over a DSN whose password bytes are blanked. A field
    // that moves when only the password moved was built out of credential text,
    // however innocent the value it ended up holding looks.
    const blanked = resolveFields(scrubPassword(dsn)).resolved;
    withoutPassword = {
      host: String(blanked.host ?? ""),
      port: String(blanked.port ?? ""),
      database: String(blanked.database ?? ""),
    };
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
    withoutPassword,
  };
}

/**
 * Characters that DELIMIT DSN components, plus the escape that can spell one.
 *
 * `postgres:` is not a WHATWG special scheme (URL Standard, "special scheme"),
 * so an empty authority is legal and everything after it is PATH, which pg
 * reports as the database. That is the whole leak family: pg relocates text
 * ACROSS a component boundary, and the text it carries over may be the
 * password. Text cannot cross that boundary without bringing the delimiter
 * that misplaced it, so a value holding one did not come from one component.
 *
 * This tests the SHAPE of what pg resolved, not its equality with the parsed
 * password, because in every relocating shape the parsed password is the empty
 * string and the secret is somewhere else entirely:
 *
 *   postgres:///u:PW@host/db   password ""   database "u:PW@host/db"
 *   postgres://host/u:PW@gw    password ""   database "u:PW@gw"
 *   postgres://u:S@/CRET@/db   password "S"  database "CRET@/db"
 *
 * A containment rule catches NONE of those. The third splits the secret in
 * two, because the parser's dummy-host retry replaces only the FIRST "@/".
 */
/**
 * ROUND 18. Two independent mechanisms, because neither closes the other's
 * class and round 17 falsified the single-mechanism design with both.
 *
 * Round 16 classified the VALUE pg resolved: withhold it if it holds a URI
 * delimiter it could not have held had it come from one component. Two
 * reviewers broke that within minutes, from opposite directions:
 *
 *   postgres://host=localhost,user=u,password=PW,dbname=db
 *     No `@` and no `/`, so the WHOLE string is an opaque host. The delimiters
 *     organising it are `=` and `,`, from libpq's keyword grammar, which the
 *     URI parser never treated as boundaries. Nothing crossed anything, so a
 *     delimiter test cannot see it. The value simply is not a hostname.
 *
 *   postgres://u:?host=PW&user=reporter&@real/db
 *     `?` ENDS the authority, so what reads as the password span is parsed as
 *     query parameters and `?host=` assigns the host. Here the resolved value
 *     is `PW`, which is a perfectly well formed hostname. Shape cannot see it.
 *
 * The second case also proves no rule over (field, value) alone can work.
 * These two inputs hand the reporter the identical pair ("host", "PW"):
 *
 *   postgres://u:p@real/db?host=PW     the operator's real target, MUST print
 *   postgres://u:?host=PW&@real/db     credential text, MUST NOT print
 *
 * Parsing has destroyed what separates them. So one mechanism recovers it.
 */

/**
 * MECHANISM 1, PROVENANCE. The password span under the NAIVE reading.
 *
 * A human, and libpq's documented `user[:password]@` grammar, take userinfo up
 * to the LAST `@` before the first `/`, and do not let `?` or `#` end the
 * authority early. WHATWG does let them. That DISAGREEMENT is the whole second
 * class above, so this deliberately reads the string the way an OPERATOR does,
 * not the way the parser does. It is not a competing parse of the target: its
 * only output is a span to blank out.
 *
 * Returns null when there is no password component, which keeps
 * `postgres://alice@host` intact: a colon-less userinfo is a USERNAME.
 */
function passwordSpan(dsn: string): { start: number; end: number } | null {
  const marker = dsn.indexOf("//");
  if (marker < 0) return null;
  const start = marker + 2;
  const slash = dsn.indexOf("/", start);
  const authorityEnd = slash < 0 ? dsn.length : slash;
  const at = dsn.lastIndexOf("@", authorityEnd);
  if (at < start) return null;
  const colon = dsn.indexOf(":", start);
  if (colon < 0 || colon > at) return null;
  return { start: colon + 1, end: at };
}

/**
 * Substituted for the password so a second resolution can be compared.
 *
 * It must be INERT: no character that a URI parser reads as structure, so that
 * substituting it can only ever REMOVE the influence of the credential text and
 * never add influence of its own. Round 19 nearly replaced this with a pair of
 * substitutes, on the theory that a password equal to the filler would make the
 * scrub a no-op and blind the comparison. A mutation probe refuted that: the
 * filler replaces the whole SPAN, not the password value, and for the password
 * to reach a reported field the span must contain `?host=` or the like, which
 * is exactly what stops it equalling an inert filler. One filler suffices, and
 * the property that makes it suffice is inertness, which is asserted in the
 * tests rather than assumed here.
 */
const SCRUBBED_PASSWORD = "redacted";

function scrubPassword(dsn: string): string {
  const span = passwordSpan(dsn);
  if (span === null) return dsn;
  return dsn.slice(0, span.start) + SCRUBBED_PASSWORD + dsn.slice(span.end);
}

/**
 * MECHANISM 2, SHAPE. A reported value must LOOK like the thing it claims to
 * be. This is an allowlist on purpose: round 9 through 16 were all denylists,
 * and each one admitted the next spelling nobody had thought of. A hostname is
 * a closed grammar; "not a hostname" is not.
 */
const DNS_LABEL = "[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?";
const DNS_NAME = new RegExp(
  "^(?=.{1,253}$)" + DNS_LABEL + "(" + "\\." + DNS_LABEL + ")*" + "\\." + "?$"
);
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6_BODY = /^[0-9A-Fa-f:]+$/;
const IPV6_ZONE = /^[A-Za-z0-9_.-]+$/;
/** sun_path is 108 bytes, and `@` is an ordinary character in a path. */
const SOCKET_PATH_LIMIT = 107;
const UNPRINTABLE_IN_A_PATH = /\s|\p{Cc}/u;

function looksLikeHost(value: string): boolean {
  if (value.length === 0) return false;
  if (value.startsWith("/")) {
    // sun_path is a BYTE budget, not a count of UTF-16 units, and a database
    // name is 63 BYTES for the same reason. Measuring `.length` called a
    // 106 emoji path over-long and a 60 emoji name short enough, both wrong.
    return (
      Buffer.byteLength(value, "utf8") <= SOCKET_PATH_LIMIT && !UNPRINTABLE_IN_A_PATH.test(value)
    );
  }
  const bracketed = value.startsWith("[") && value.endsWith("]");
  const bare = bracketed ? value.slice(1, -1) : value;
  const parts = bare.split("%");
  if (parts.length <= 2 && parts[0].includes(":")) {
    const zoneOk = parts.length === 1 || IPV6_ZONE.test(parts[1]);
    return IPV6_BODY.test(parts[0]) && parts[0].split(":").length <= 9 && zoneOk;
  }
  // Brackets hold an ADDRESS, never a name. pg passes `[127.0.0.1]` through
  // unchanged, so the report must too, but only after validating the inside.
  if (bracketed) return IPV4.test(bare);
  return IPV4.test(value) || DNS_NAME.test(value);
}

/**
 * PostgreSQL truncates an identifier at 63 bytes, so a longer string is not a
 * database it could open. `%` is excluded because `parse` decodes the path with
 * decodeURI, which leaves RESERVED bytes encoded, so `u%3APW%40gw` reaches here
 * with its delimiters still spelled as escapes.
 *
 * `:` is excluded, and round 17 asked for it to be allowed so that a database
 * honestly named `v2:prod` would print. Allowing it reopened a leak the same
 * hour, caught by this file's own generated corpus:
 *
 *   postgres://usr%3APW@/   user "usr:PW", and an unstated database is the USER
 *
 * The `%3A` means passwordSpan sees no colon and cannot scrub, so provenance is
 * blind here and shape is the only mechanism left. `v2:prod` stays withheld.
 */
const DATABASE_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_\-.+~$!]*$/u;
const DATABASE_NAME_BYTES = 63;
function looksLikeDatabase(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= DATABASE_NAME_BYTES && DATABASE_NAME.test(value);
}

function looksLikePort(value: string): boolean {
  if (!/^[0-9]{1,5}$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

/**
 * The two refusals say DIFFERENT things and must never be merged, nor confused
 * with "(default)". A defaulted field was never stated; a withheld field was
 * stated and is being kept back; and WHICH of the two mechanisms refused it
 * tells the operator whether to fix their DSN or to stop worrying.
 */
const WITHHELD_BY_PROVENANCE = "(withheld: derived from the DSN's credential text)";
function withheldByShape(field: string): string {
  return `(withheld: not a well-formed ${field})`;
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
  // PROVENANCE first, then SHAPE. A value can be a flawless hostname and still
  // have been built from the password, so passing the shape test proves nothing
  // until the field is known not to have moved when the password was blanked.
  const reportField = (
    field: "host" | "port" | "database",
    value: string,
    wellFormed: (candidate: string) => boolean
  ): string => {
    if (value !== target.withoutPassword[field]) return WITHHELD_BY_PROVENANCE;
    return wellFormed(value) ? show(value) : withheldByShape(field);
  };

  const where = target.isSocket ? "socket" : "host";
  // The source annotation survives withholding on purpose: WHERE a field came
  // from is not a secret, and an operator chasing a wrong target needs it.
  const host = `${reportField("host", target.host, looksLikeHost)}${annotate(target.hostSource)}`;
  const port = `${reportField("port", target.port, looksLikePort)}${annotate(target.portSource)}`;
  const database = `${reportField("database", target.database, looksLikeDatabase)}${target.databaseNote}`;
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
