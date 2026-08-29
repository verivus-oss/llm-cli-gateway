/**
 * Strict RFC 3986 parse of a PostgreSQL DSN, producing TWO projections.
 *
 * Rounds 9 to 19 all tried to make one string safe to print. Each failed the
 * same way: `pg` resolves some DSNs so that credential text lands in `host`,
 * `database` or `port`, and no rule over the RESOLVED (field, value) pair can
 * separate that from an operator's real target, because these two hand the
 * reporter the identical pair:
 *
 *   postgres://u:p@real/db?host=X     the real target, MUST print
 *   postgres://u:?host=X&@real/db     credential text, MUST NOT print
 *
 * The guarantee this module provides is therefore NOT "the output never
 * contains the password bytes", which is unachievable: an operator may name a
 * host that happens to equal their password, and no parser can know. It is
 * NONINTERFERENCE. `PgPublicTarget` has no password field to read, so no byte
 * of a report built from it can be derived from one.
 *
 * That only holds if the parse itself is unambiguous, which is what the reject
 * rules below are for. Where an operator's reading and a URI parser's reading
 * of the same bytes can differ, this refuses the string rather than pick one.
 */

/** unreserved, RFC 3986 section 2.3. */
const UNRESERVED = "A-Za-z0-9" + "\\-" + "._~";
/** sub-delims, RFC 3986 section 2.2. */
const SUB_DELIMS = "!$&'()*+,;=";
const PCT = "%[0-9A-Fa-f]{2}";

/** userinfo, RFC 3986 section 3.2.1: unreserved / pct-encoded / sub-delims / ":" */
const USERINFO = new RegExp("^(?:[" + UNRESERVED + SUB_DELIMS + ":]|" + PCT + ")*$");

/**
 * reg-name, RFC 3986 section 3.2.2, DELIBERATELY NARROWED to unreserved and
 * percent escapes. Generic reg-name also admits sub-delims, and that is exactly
 * how a libpq keyword string smuggles itself in as one opaque host:
 *
 *   postgres://host=localhost,user=u,password=PW,dbname=db
 *
 * `=` and `,` are legal sub-delims, so RFC 3986 alone accepts that as a
 * hostname. No name the resolver can answer for, and no socket path, contains
 * them. Narrowing here is scheme-specific host grammar, not a guess about which
 * values look dangerous.
 */
const REG_NAME = new RegExp("^(?:[" + UNRESERVED + "]|" + PCT + ")*$");
const PORT = /^[0-9]{1,5}$/;

/**
 * Names the EXACT variable, not merely "the environment". An operator chasing a
 * wrong target needs to know which knob moved it, and round 7 blocked on a
 * version of this that said `(from PGUSER)` whenever PGUSER was merely SET,
 * sending the reader to a variable pg had ignored.
 */
export type TargetFieldSource =
  | "dsn"
  | "query"
  | "PGHOST"
  | "PGPORT"
  | "PGDATABASE"
  | "PGUSER"
  | "default"
  | "user-from-dsn"
  | "user-from-query"
  | "user-from-PGUSER"
  | "user-default";

export interface PgPublicTarget {
  transport: "tcp" | "unix";
  /** A hostname, an IP literal, or a unix socket DIRECTORY. Never a credential. */
  hostOrDirectory: string;
  port: string;
  database: string;
  sources: { host: TargetFieldSource; port: TargetFieldSource; database: TargetFieldSource };
}

/** Holds the secret. Never handed to anything that formats output. */
export interface PgClientConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export type PgDsnParse =
  { ok: true; target: PgPublicTarget; client: PgClientConfig } | { ok: false; reason: string };

/**
 * pg spells a unix socket as a DIRECTORY and appends the socket file itself,
 * in `Client._connect`: `con.connect(this.host + "/.s.PGSQL." + this.port)`.
 * So the kernel's sun_path budget applies to the joined path, not to the value
 * reported here. Round 19 found this budget applied to the directory alone,
 * which accepts a 100 byte directory whose socket path is 114 bytes.
 */
const SOCKET_SUFFIX = "/.s.PGSQL.";
/** sun_path is 108 bytes on Linux and 104 on Darwin, both including the NUL. */
function sunPathBudget(): number {
  return (process.platform === "darwin" ? 104 : 108) - 1;
}

function refuse(reason: string): PgDsnParse {
  return { ok: false, reason };
}

/** Counts occurrences that are NOT part of a percent escape. */
function countLiteral(text: string, character: string): number {
  let seen = 0;
  for (const c of text) if (c === character) seen += 1;
  return seen;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Percent-encoding exists so a component can carry a character that would
 * otherwise BE a delimiter. Decoding therefore has to be checked, not just
 * performed: RFC 3986 section 6.2.2.2 normalises only UNRESERVED escapes for
 * exactly this reason, because decoding a reserved one changes what the string
 * means.
 *
 * Round 21 measured what skipping this costs. Each of these parsed cleanly and
 * printed the credential only after decoding:
 *
 *   postgres://host/u%3APW%40gw   database "u:PW@gw"
 *   postgres://u%3APW             host     "u:PW"
 *   postgres://usr%3APW@host      user     "usr:PW", then the default database
 *
 * So a decoded value may carry DATA a delimiter would have broken, such as a
 * space in a database name, but never STRUCTURE. Which characters count as
 * structure depends on the component, which is why this takes them per call.
 */
function introducesStructure(decoded: string, forbidden: readonly string[]): boolean {
  return forbidden.some(character => decoded.includes(character));
}

/** A hostname has no userinfo, no port separator, and no keyword syntax. */
const STRUCTURE_IN_A_HOST = [":", "@", "?", "#", "=", ","] as const;
/**
 * A socket DIRECTORY is a path, so `/` is its content, and so is `:`: the port
 * was split off the authority before this runs, and a directory named
 * `/tmp/pg:5433` is one an operator really has. `@` and the keyword characters
 * stay forbidden, which is what keeps relocated userinfo out.
 */
const STRUCTURE_IN_A_SOCKET = ["@", "?", "#", "=", ","] as const;
/** A user is the part BEFORE any colon; a decoded one may not reintroduce it. */
const STRUCTURE_IN_A_USER = [":", "@", "/", "?", "#"] as const;
/**
 * `@` is relocated userinfo. `=`, `&` and `;` are how libpq keyword and JDBC
 * property syntax smuggle a password into what looks like a name. A space is
 * NOT here: `db name` is a database PostgreSQL can open, and reporting it is
 * this function's job.
 */
const STRUCTURE_IN_A_NAME = ["@", "?", "#", "=", "&", ";"] as const;

/**
 * Every character RFC 3986 allows in a URI: unreserved, reserved, and `%`.
 *
 * A raw SPACE is the one that matters. RFC 3986 has no place for it, and pg
 * agrees in its own way: `pg-connection-string` rewrites the WHOLE string with
 * encodeURI when it sees one, which encodes `[` and `]` and makes
 * `postgresql://u:p@[::1]:5433/db?sslcert=/tmp/foo bar` throw `Invalid URL`.
 * Round 9 blocked on a report that named `[::1]` for that string while pg
 * reached nothing at all. Refusing the character refuses the divergence.
 */
const URI_CHARACTERS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;

const PREFIXES = ["postgresql://", "postgres://"];

export function parsePgDsn(dsn: string, env: NodeJS.ProcessEnv = process.env): PgDsnParse {
  const lower = dsn.toLowerCase();
  const prefix = PREFIXES.find(candidate => lower.startsWith(candidate));
  // Raw bytes, no trimming. A leading space changes which branch pg's own
  // parser takes, so accepting one here would re-open round 9.
  if (prefix === undefined) return refuse("not a postgresql:// or postgres:// URI");

  // A fragment is discarded, exactly as pg discards it. Refusing one would
  // refuse a DSN that connects. The route a fragment offered for smuggling
  // credential text is closed by the no-unencoded-@-after-the-authority rule
  // below, which is the rule that actually addresses it.
  const hash = dsn.indexOf("#", prefix.length);
  const rest = hash < 0 ? dsn.slice(prefix.length) : dsn.slice(prefix.length, hash);
  if (!URI_CHARACTERS.test(rest)) {
    return refuse("holds a character RFC 3986 requires to be percent-encoded");
  }

  const authorityEnd = ((): number => {
    const slash = rest.indexOf("/");
    const query = rest.indexOf("?");
    const ends = [slash, query].filter(at => at >= 0);
    return ends.length === 0 ? rest.length : Math.min(...ends);
  })();
  const authority = rest.slice(0, authorityEnd);
  const remainder = rest.slice(authorityEnd);
  const queryAt = remainder.indexOf("?");
  const rawPath = queryAt < 0 ? remainder : remainder.slice(0, queryAt);
  const rawQuery = queryAt < 0 ? "" : remainder.slice(queryAt + 1);

  // THE AMBIGUITY RULE. RFC 3986 permits `@` in a path or query; a human, and
  // libpq's `user[:password]@` grammar, read the LAST `@` as the end of
  // userinfo. When those readings disagree the same bytes mean two things:
  //
  //   postgres://u:?host=X&@real/db   authority is `u:`, and `?` already
  //                                   ended it, so `X` becomes the host while
  //                                   a reader thinks it is the password
  //
  // Refusing is the only answer that is right under both readings.
  if (rawPath.includes("@") || rawQuery.includes("@")) {
    return refuse("unencoded @ after the authority is ambiguous; percent-encode it");
  }

  let userinfo = "";
  let hostport = authority;
  const ats = countLiteral(authority, "@");
  if (ats > 1) return refuse("more than one unencoded @ in the authority");
  if (ats === 1) {
    const at = authority.indexOf("@");
    userinfo = authority.slice(0, at);
    hostport = authority.slice(at + 1);
  }

  if (!USERINFO.test(userinfo)) {
    return refuse("userinfo holds a character RFC 3986 requires to be encoded");
  }
  const colon = userinfo.indexOf(":");
  const rawUser = colon < 0 ? userinfo : userinfo.slice(0, colon);
  const rawPassword = colon < 0 ? "" : userinfo.slice(colon + 1);

  let hostText = hostport;
  let portText = "";
  if (hostport.startsWith("[")) {
    const close = hostport.indexOf("]");
    if (close < 0) return refuse("unterminated IP literal");
    hostText = hostport.slice(0, close + 1);
    const tail = hostport.slice(close + 1);
    if (tail.length > 0) {
      if (!tail.startsWith(":")) return refuse("junk after the IP literal");
      portText = tail.slice(1);
    }
  } else {
    const portColon = hostport.indexOf(":");
    if (portColon >= 0) {
      if (hostport.indexOf(":", portColon + 1) >= 0) {
        return refuse("more than one colon in the authority");
      }
      hostText = hostport.slice(0, portColon);
      portText = hostport.slice(portColon + 1);
    }
  }

  const bracketed = hostText.startsWith("[") && hostText.endsWith("]");
  if (!bracketed && !REG_NAME.test(hostText)) {
    return refuse("host holds a character no hostname or socket path contains");
  }
  if (portText.length > 0 && !PORT.test(portText)) return refuse("port is not 1 to 5 digits");
  // An explicit port with no host is malformed, and pg THROWS on it. Filling
  // the gap from PGHOST or a default would invent a target pg never reaches,
  // which is the failure this whole module exists to stop. An empty authority
  // with no port is different and stays legal: `postgresql:///db?host=/path`
  // is libpq's own socket spelling.
  if (portText.length > 0 && hostText.length === 0) {
    return refuse("a port with no host is malformed");
  }

  const decodedHost = bracketed ? hostText : decode(hostText);
  const decodedUser = decode(rawUser);
  const decodedPassword = decode(rawPassword);
  const decodedPath = decode(rawPath.startsWith("/") ? rawPath.slice(1) : rawPath);
  if (
    decodedHost === null ||
    decodedUser === null ||
    decodedPassword === null ||
    decodedPath === null
  ) {
    return refuse("a percent escape is malformed");
  }
  // A socket directory is a path, so `/` is its content rather than a boundary.
  const hostStructure: readonly string[] = decodedHost.startsWith("/")
    ? STRUCTURE_IN_A_SOCKET
    : [...STRUCTURE_IN_A_HOST, "/"];
  if (!bracketed && introducesStructure(decodedHost, hostStructure)) {
    return refuse("decoding the host would introduce URI structure");
  }
  if (introducesStructure(decodedUser, STRUCTURE_IN_A_USER)) {
    return refuse("decoding the user would introduce URI structure");
  }
  if (introducesStructure(decodedPath, STRUCTURE_IN_A_NAME)) {
    return refuse("the database name holds URI or keyword structure");
  }

  // Query parameters. libpq documents host, port, dbname, user and password
  // here, and `postgresql:///db?host=/var/run/postgresql` is its own socket
  // spelling, so these are kept. A DUPLICATE is refused: URLSearchParams.get
  // takes the first and pg assigns every one, so the two disagree, which is the
  // divergence that let a transcript gate admit a remote database.
  const overrides = new Map<string, string>();
  if (rawQuery.length > 0) {
    for (const pair of rawQuery.split("&")) {
      if (pair.length === 0) continue;
      const eq = pair.indexOf("=");
      const key = decode(eq < 0 ? pair : pair.slice(0, eq));
      const value = decode(eq < 0 ? "" : pair.slice(eq + 1));
      if (key === null || value === null) return refuse("a percent escape is malformed");
      if (["host", "port", "dbname", "user", "password"].includes(key)) {
        if (overrides.has(key)) return refuse(`duplicate ${key} in the query`);
        // A query value is a target too, so it faces the same test. `?host=`
        // is the vector round 19 used, and libpq's own socket spelling
        // `?host=/var/run/postgresql` has to keep working, hence the same
        // leading-slash exemption as the authority host.
        if (key === "host") {
          // A QUERY host keeps its colons. The bracket requirement exists in
          // the authority because `host:port` is ambiguous there; a query
          // value has its own `port` key, so `?host=::1` is unambiguous and
          // naming it is faithful. `/` stays forbidden unless the value is a
          // socket path, which is what keeps `?host=evil://host` out.
          const structure: readonly string[] = value.startsWith("/")
            ? STRUCTURE_IN_A_SOCKET
            : [...STRUCTURE_IN_A_SOCKET, "/"];
          if (introducesStructure(value, structure)) {
            return refuse("query host holds URI structure");
          }
        }
        if (key === "dbname" && introducesStructure(value, STRUCTURE_IN_A_NAME)) {
          return refuse("query dbname holds URI or keyword structure");
        }
        overrides.set(key, value);
      }
    }
  }

  const ambient = (name: string): string => {
    const value = env[name];
    return value === undefined ? "" : value;
  };
  const pick = (
    stated: string,
    queried: string | undefined,
    variable: "PGHOST" | "PGPORT" | "PGUSER",
    fallback: string
  ): { value: string; source: TargetFieldSource } => {
    if (queried !== undefined && queried !== "") return { value: queried, source: "query" };
    if (stated !== "") return { value: stated, source: "dsn" };
    const fromEnv = ambient(variable);
    if (fromEnv !== "") return { value: fromEnv, source: variable };
    return { value: fallback, source: "default" };
  };

  const host = pick(decodedHost, overrides.get("host"), "PGHOST", "localhost");
  const port = pick(portText, overrides.get("port"), "PGPORT", "5432");
  if (!PORT.test(port.value) || Number(port.value) < 1 || Number(port.value) > 65535) {
    return refuse("port is outside 1 to 65535");
  }
  const user = pick(decodedUser, overrides.get("user"), "PGUSER", "");
  // pg's own rule: an unstated database is the connecting USER.
  // An unstated database is not a default NAME: pg substitutes the connecting
  // USER, whose own origin varies, so the report has to name that origin too.
  const userOrigin: TargetFieldSource =
    user.source === "dsn"
      ? "user-from-dsn"
      : user.source === "query"
        ? "user-from-query"
        : user.source === "PGUSER"
          ? "user-from-PGUSER"
          : "user-default";
  const queriedDb = overrides.get("dbname");
  const database =
    decodedPath !== ""
      ? { value: decodedPath, source: "dsn" as TargetFieldSource }
      : queriedDb !== undefined && queriedDb !== ""
        ? { value: queriedDb, source: "query" as TargetFieldSource }
        : ambient("PGDATABASE") !== ""
          ? { value: ambient("PGDATABASE"), source: "PGDATABASE" as TargetFieldSource }
          : { value: user.value, source: userOrigin };

  const transport = host.value.startsWith("/") ? "unix" : "tcp";
  if (transport === "unix") {
    const joined =
      Buffer.byteLength(host.value, "utf8") +
      Buffer.byteLength(SOCKET_SUFFIX, "utf8") +
      Buffer.byteLength(port.value, "utf8");
    if (joined > sunPathBudget()) {
      return refuse(
        "socket path exceeds the kernel sun_path budget once pg appends the socket file"
      );
    }
  }

  return {
    ok: true,
    target: {
      transport,
      hostOrDirectory: host.value,
      port: port.value,
      database: database.value,
      sources: { host: host.source, port: port.source, database: database.source },
    },
    client: {
      host: host.value,
      port: Number(port.value),
      database: database.value,
      user: user.value,
      password: overrides.get("password") ?? decodedPassword,
    },
  };
}
