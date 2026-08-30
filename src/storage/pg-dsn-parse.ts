/**
 * ONE parse of a PostgreSQL DSN, and it is not ours.
 *
 * This module used to be a second grammar: an RFC 3986 reimplementation that
 * decided what to REPORT while pg decided what to CONNECT to. Every
 * disagreement between the two was simultaneously a wrong log line and a
 * disclosure, and rounds 14 to 23 were that disagreement being rediscovered in
 * five spellings. libpq never had the problem because it parses once and marks
 * each option's `dispchar`; `*` means do not display.
 *
 * So: the gate admits the string, pg parses it once, and the public projection
 * is picked field-by-field off the very object handed to `Pool`. No byte of the
 * report is taken from the raw DSN by offset, and the reported target cannot
 * disagree with the connected one because it IS the connected one.
 */

import { createRequire } from "node:module";
import { admitPgDsn, namesSslFileParameter } from "./pg-dsn-gate.js";

export type TargetFieldSource =
  | "dsn"
  | "PGHOST"
  | "PGPORT"
  | "PGDATABASE"
  | "default"
  | "user-from-dsn"
  | "user-from-PGUSER"
  | "user-default";

export interface PgPublicTarget {
  transport: "tcp" | "unix";
  hostOrDirectory: string;
  port: string;
  database: string;
  sources: { host: TargetFieldSource; port: TargetFieldSource; database: TargetFieldSource };
}

/** The object pg builds from a connection string. `ConnectionParameters` does
 *  `Object.assign({}, config, parse(connectionString))`, so handing this to
 *  `Pool` is exactly what passing the string does, minus the second parse. */
export type PgConnectConfig = Record<string, unknown>;

/**
 * Distinguished because it is the ONE refusal that does not mean the DSN is
 * malformed. The connection is fine and pg will make it; only this reporter
 * declines to open the file, so a line saying "not parseable" would be a lie.
 */
export const SSL_FILE_REFUSAL = "the dsn names an ssl file this reporter will not open";

export type PgDsnParse =
  { ok: true; target: PgPublicTarget; connect: PgConnectConfig } | { ok: false; reason: string };

type PgParse = (dsn: string) => PgConnectConfig;
type PgClient = new (config: unknown) => Record<string, unknown>;

let loaded: { parse: PgParse; Client: PgClient } | null | undefined;

/**
 * `pg` is an optional peer loaded elsewhere with `await import`, but this runs
 * inside a synchronous constructor, so it is resolved synchronously here.
 * `pg-connection-string` is resolved THROUGH pg rather than from this package,
 * because it is pg's dependency and not ours.
 */
function loadPg(): { parse: PgParse; Client: PgClient } | null {
  if (loaded !== undefined) return loaded;
  try {
    const here = createRequire(import.meta.url);
    const fromPg = createRequire(here.resolve("pg"));
    loaded = {
      parse: (fromPg("pg-connection-string") as { parse: PgParse }).parse,
      Client: (here("pg") as { Client: PgClient }).Client,
    };
  } catch {
    loaded = null;
  }
  return loaded;
}

/** A field pg will fall back on is empty or absent, never merely falsy-looking:
 *  `parse` returns `""` for an unstated host and `null` for an unstated name. */
function stated(value: unknown): boolean {
  if (typeof value === "string") return value.length > 0;
  return value !== null && value !== undefined;
}

export function parsePgDsn(dsn: string, env: NodeJS.ProcessEnv = process.env): PgDsnParse {
  const admission = admitPgDsn(dsn);
  if (!admission.admitted) return { ok: false, reason: admission.reason };

  // The reporter refuses STRICTLY MORE than the connect gate, and this is the
  // only place the two differ. `parse()` opens `sslcert`/`sslkey`/`sslrootcert`
  // when they are named, and this runs synchronously inside a constructor: a
  // fifo or a slow mount would wedge the recorder before it logged a line. The
  // connector may read that file, because it is about to anyway.
  if (namesSslFileParameter(dsn)) return { ok: false, reason: SSL_FILE_REFUSAL };

  const pg = loadPg();
  if (pg === null) return { ok: false, reason: "the pg package is not installed" };

  let connect: PgConnectConfig;
  let resolved: Record<string, unknown>;
  try {
    connect = pg.parse(dsn);
    // Constructed, never connected. This applies pg's own env and default
    // resolution, so the report names what pg WILL use rather than what the
    // string alone says. Reimplementing those defaults here would be a second
    // source of truth, which is the mistake this module exists to undo.
    resolved = new pg.Client(connect);
  } catch {
    return { ok: false, reason: "pg refused the connection string" };
  }

  const host = String(resolved.host ?? "");
  const port = String(resolved.port ?? "");
  const database = String(resolved.database ?? "");

  return {
    ok: true,
    connect,
    target: {
      // pg opens a unix socket when the resolved host is a path, and its own
      // test is `indexOf("/") === 0`. Derived from pg, never chosen here.
      transport: host.startsWith("/") ? "unix" : "tcp",
      hostOrDirectory: host,
      port,
      database,
      sources: {
        host: stated(connect.host) ? "dsn" : env.PGHOST ? "PGHOST" : "default",
        port: stated(connect.port) ? "dsn" : env.PGPORT ? "PGPORT" : "default",
        // pg falls back to the USER for an unstated database, so an annotation
        // reading a bare "(default)" here would hide the fact that PGUSER
        // moves it. Naming which user is the point: a field credited to no
        // source must not be one an environment variable steers.
        database: stated(connect.database)
          ? "dsn"
          : env.PGDATABASE
            ? "PGDATABASE"
            : stated(connect.user)
              ? "user-from-dsn"
              : env.PGUSER
                ? "user-from-PGUSER"
                : "user-default",
      },
    },
  };
}
