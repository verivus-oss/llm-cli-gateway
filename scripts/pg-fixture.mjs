#!/usr/bin/env node
//
// Guards and prepares the PostgreSQL test fixture.
//
// This exists because the reset is DESTRUCTIVE. `cleanTestDatabase` issues
// `DELETE FROM` across nine tables and this script issues `DROP DATABASE`, and
// the operator's live gateway database listens on the neighbouring port on the
// same loopback address. A transposed digit is the whole distance between a
// test fixture and data loss, so the destination is proved to be a fixture
// before anything destructive runs, and refusal is the default.
//
// THE PARSER TRAP, and why this file no longer forwards the caller's string.
// A first version validated the WHATWG `URL` authority and then handed the
// ORIGINAL string to `pg`. Those are two different parsers.
// `pg-connection-string` copies query parameters FIRST and only falls back to
// the authority when `host`/`port` are absent, so
//     postgresql://test:x@127.0.0.1:5433/llm_gateway_test?port=5432
// passed a guard reading 5433 and connected to 5432. Validating one
// representation and using another is not a fence.
//
// So: query strings and fragments are refused outright, and every consumer
// downstream is handed a DSN this file REBUILDS from the validated fields. The
// string that was checked is the string that gets used.
//
// stdout is exactly one line, the canonical DSN, so callers can capture it.
// All progress goes to stderr.
//
// `psql` and `pg_isready` are not installed for the CI user, so readiness and
// reset both go through `pg` rather than shell tools.
import process from "node:process";

const FIXTURE_DATABASE = "llm_gateway_test";
// 127.0.0.1 only. `localhost` is a name whose resolution is not pinned, and
// `[::1]` parsed cleanly but neither `pg` nor `dns.lookup` accepts the
// bracketed form, so allowing it advertised a route that does not exist.
const FIXTURE_HOST = "127.0.0.1";
// The operator's live database. Never a valid fixture, on any host, ever.
const FORBIDDEN_PORT = "5432";
const ALLOWED_PROTOCOLS = new Set(["postgres:", "postgresql:"]);

function die(message) {
  process.stderr.write(`pg-fixture: ${message}\n`);
  process.exit(1);
}

/**
 * Proves a DSN addresses a disposable test fixture, and returns the pieces to
 * rebuild it from. Every check is a refusal, not a warning: anything
 * unexpected fails closed.
 */
export function assertFixtureDsn(raw, fail = die) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return fail("TEST_DATABASE_URL is not a parseable URL. Refusing to touch it.");
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return fail(`refusing protocol ${url.protocol}. Expected postgres: or postgresql:.`);
  }

  // The bypass that round 2 found. `?host=` and `?port=` override the authority
  // inside pg's parser, so a DSN carrying ANY of them is refused rather than
  // sanitised: there is no legitimate reason for a fixture DSN to have one.
  if (url.search !== "") {
    return fail(
      `refusing a DSN with query parameters (${url.search}). ` +
        "pg reads host and port from those in preference to the URL authority, " +
        "so they can redirect a DROP DATABASE past every check here."
    );
  }
  if (url.hash !== "") {
    return fail("refusing a DSN with a fragment.");
  }

  if (url.hostname !== FIXTURE_HOST) {
    return fail(
      `refusing host ${url.hostname}. The fixture is at ${FIXTURE_HOST} and ` +
        "nothing else is disposable."
    );
  }

  // Explicit, because an absent port means 5432 to every PostgreSQL client.
  if (url.port === "") {
    return fail(
      "refusing a DSN with no port. An absent port means 5432, which is the " +
        "operator's live database. State the fixture port."
    );
  }
  if (url.port === FORBIDDEN_PORT) {
    return fail(
      `refusing port ${FORBIDDEN_PORT}. That is the operator's live gateway ` +
        "database, not a test fixture."
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== FIXTURE_DATABASE) {
    return fail(
      `refusing database ${JSON.stringify(database)}. The fixture is ` +
        `${JSON.stringify(FIXTURE_DATABASE)} and nothing else is disposable.`
    );
  }

  return {
    host: FIXTURE_HOST,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

/** Rebuilds a DSN from validated fields. Never echoes the caller's string. */
export function canonicalDsn(f, database = f.database) {
  const user = encodeURIComponent(f.user);
  const password = encodeURIComponent(f.password);
  const auth = password === "" ? user : `${user}:${password}`;
  return `postgresql://${auth}@${f.host}:${f.port}/${encodeURIComponent(database)}`;
}

/** Safe to print: identity only, never credentials. */
export function describeFixture(f) {
  return `${f.host}:${f.port}/${f.database}`;
}

/**
 * Three consecutive successes, not one. The postgres entrypoint runs a local
 * server for initdb and restarts it before listening for real, so a single
 * probe can pass against a server that is about to go away.
 */
async function waitReady(Client, config, timeoutSeconds) {
  let consecutive = 0;
  let lastError;
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    const client = new Client({ ...config, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      consecutive += 1;
      if (consecutive >= 3) return { ready: true };
    } catch (error) {
      consecutive = 0;
      lastError = error;
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return { ready: false, lastError };
}

async function main() {
  const raw = process.argv[2];
  if (!raw) die("usage: pg-fixture.mjs <dsn>");

  const fixture = assertFixtureDsn(raw);

  let Client;
  try {
    ({ Client } = await import("pg"));
  } catch {
    die("the optional `pg` dependency is not installed.");
  }

  // Field-wise config, never a connection string: this is what makes the
  // validated target and the connected target the same thing. Reset runs
  // against the maintenance database, because a session connected to the
  // fixture would block its own DROP.
  const admin = { ...fixture, database: "postgres" };

  const timeoutSeconds = Number(process.env.PG_TEST_READY_TIMEOUT || "120");
  process.stderr.write(`pg-fixture: waiting for ${describeFixture(fixture)}\n`);
  const { ready, lastError } = await waitReady(Client, admin, timeoutSeconds);
  if (!ready) {
    // Distinguish "nothing is listening" from "it answered and refused us".
    // Reporting an auth or configuration fault as a missing server sends the
    // reader to the wrong place entirely.
    const code = lastError && lastError.code;
    const reason =
      code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "EHOSTUNREACH"
        ? "The fixture server is not running. This is a missing fixture, not a test failure."
        : `The server answered but the connection failed: ${lastError ? lastError.message : "unknown"}`;
    die(`${describeFixture(fixture)} unreachable after ${timeoutSeconds}s. ${reason}`);
  }

  const client = new Client(admin);
  await client.connect();
  try {
    // WITH (FORCE) terminates other backends. Without it an abandoned
    // connection from a killed run makes the drop hang rather than fail.
    await client.query(`DROP DATABASE IF EXISTS ${fixture.database} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${fixture.database}`);

    // `DROP DATABASE` does not remove cluster-wide ROLES, and both
    // migration-pg.test.ts and job-store-pg.test.ts create login roles whose
    // `finally` a cancelled run can skip. Schemas need no such sweep: they live
    // INSIDE the fixture database and die with it.
    //
    // ESCAPE the underscores. In LIKE, `_` is a single-character wildcard, so
    // an unescaped `migration_runtime_%` also matches `migrationXruntimeY`.
    // The action here is a cluster-wide DROP ROLE, so the pattern is written to
    // match exactly the two prefixes these suites build and nothing else.
    const stale = await client.query(
      `SELECT rolname FROM pg_roles
        WHERE rolname LIKE 'migration\\_runtime\\_%' ESCAPE '\\'
           OR rolname LIKE 'job\\_store\\_runtime\\_%' ESCAPE '\\'`
    );
    for (const row of stale.rows) {
      await client.query(`DROP ROLE IF EXISTS "${row.rolname.replace(/"/g, '""')}"`);
    }
    if (stale.rowCount > 0) {
      process.stderr.write(`pg-fixture: dropped ${stale.rowCount} stale test role(s)\n`);
    }
  } finally {
    await client.end().catch(() => {});
  }

  process.stderr.write(`pg-fixture: ${describeFixture(fixture)} reset\n`);
  // The ONLY thing on stdout: the DSN rebuilt from validated fields.
  process.stdout.write(`${canonicalDsn(fixture)}\n`);
}

// Only run when invoked directly, so the validator can be unit tested.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => die(error instanceof Error ? error.message : String(error)));
}
