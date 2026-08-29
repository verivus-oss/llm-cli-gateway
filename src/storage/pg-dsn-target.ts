/**
 * Where will `pg` actually connect for this DSN?
 *
 * Answered by ASKING `pg`, never by re-deriving its rules. A security gate that
 * computes the target itself is a second answer to a question the driver has
 * already decided, and when the two disagree the gate reports on a host the
 * connection does not use.
 *
 * That disagreement was measured, not hypothesised. `transcript-admission.ts`
 * read the host with `URLSearchParams.get("host")`, which returns the FIRST
 * value. `pg-connection-string` iterates the query and assigns every value, so
 * the LAST one wins:
 *
 *   postgresql://u:p@127.0.0.1:5433/db?host=127.0.0.1&host=db.remote.invalid
 *     gate said        host 127.0.0.1        (loopback, admitted)
 *     pg.Client said   host db.remote.invalid
 *
 * The gate decides whether transcript BODIES may enter a deployment, so that
 * combination admits prompt and response text into a database the gate has
 * proven nothing about.
 *
 * Two more divergences the same rewrite removes, both measured:
 *   - `PGHOST` / `PGPORT` moved pg's target while the gate ignored them.
 *   - Keyword/value strings (`host=/tmp dbname=gw`) were parsed as a socket
 *     target here, while `pg.Client` reads that whole string as a DATABASE name
 *     on host `base`. The gate proved a shape the driver never uses.
 */
import { createRequire } from "module";

export interface PgDsnTarget {
  /** Set when pg resolved a unix socket directory, which it spells as a path. */
  socketDirectory: string | null;
  /** Set when pg resolved a TCP host. Exactly one of these two is non-null. */
  host: string | null;
  port: number;
}

interface PgTargetConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
}

/**
 * `parse` reads `sslcert`, `sslkey` and `sslrootcert` off the disk. This
 * function runs during startup admission, so a FIFO named in one of them would
 * hang the process before anything connected. The READ is suppressed rather
 * than the DSN rewritten: editing the string is how the reporting side of this
 * codebase produced five consecutive defects.
 *
 * The substitute is NON-EMPTY. `parse` assigns `config.ssl.ca` from the bytes
 * and then tests `if (!config.ssl.ca)` under `uselibpqcompat=true` plus
 * `sslmode=verify-ca`, where an empty CA throws and would make a resolvable
 * target look unparseable.
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
 * The target `pg` will use, or null when it cannot be established.
 *
 * Null is the FAIL-CLOSED answer and callers must treat it as "unproven". It is
 * returned when the optional `pg` peer is absent, when `parse` throws, and when
 * pg resolves no host at all.
 */
export function resolvePgDsnTarget(dsn: string): PgDsnTarget | null {
  let parse: (s: string) => Record<string, string | null | undefined>;
  let Client: new (config: PgTargetConfig) => { host?: string; port?: number };
  try {
    const require = createRequire(import.meta.url);
    ({ parse } = require("pg-connection-string") as { parse: typeof parse });
    ({ Client } = require("pg") as { Client: typeof Client });
  } catch {
    return null;
  }

  let resolved: { host?: string; port?: number };
  try {
    const stated = parseWithoutReadingFiles(parse, dsn);
    // FIELDS, not the connection string. Handing `Client` the string makes it
    // re-parse and read the SSL files again; handing it the resolved fields
    // applies the same `config[key] || process.env.PG* || default` resolution
    // and touches no disk. This object is what the driver hands to the socket.
    resolved = new Client({
      host: stated.host || undefined,
      port: stated.port ? Number(stated.port) : undefined,
    });
  } catch {
    return null;
  }

  const host = String(resolved.host ?? "");
  if (host.length === 0) return null;
  const port = Number(resolved.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;

  // pg spells a unix socket as a path in the same `host` field.
  return host.startsWith("/")
    ? { socketDirectory: host, host: null, port }
    : { socketDirectory: null, host, port };
}
