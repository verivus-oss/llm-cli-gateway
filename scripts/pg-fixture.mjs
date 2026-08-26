#!/usr/bin/env node
//
// Guards and prepares the PostgreSQL test fixture.
//
// This exists because the reset is DESTRUCTIVE. `cleanTestDatabase` issues
// `DELETE FROM` across nine tables and this script issues `DROP DATABASE`, and
// the operator's live gateway database listens on the neighbouring port on the
// same loopback address. A transposed digit in a DSN is the whole distance
// between a test fixture and data loss, so the destination is proved to be a
// fixture before anything destructive runs, and the refusal is the default.
//
// `psql` and `pg_isready` are not installed for the CI user, so readiness and
// reset both go through `pg` rather than shell tools.
import process from "node:process";

const FIXTURE_DATABASE = "llm_gateway_test";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
// The operator's live database. Never a valid fixture, at any host, ever.
const FORBIDDEN_PORT = "5432";

function die(message) {
  process.stderr.write(`pg-fixture: ${message}\n`);
  process.exit(1);
}

/**
 * Proves a DSN addresses a disposable test fixture. Every check is a refusal,
 * not a warning: an unparseable or unexpected DSN fails closed.
 */
function assertFixtureDsn(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    die("TEST_DATABASE_URL is not a parseable URL. Refusing to touch it.");
  }

  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    die(
      `refusing a non-loopback host ${url.hostname}. The fixture must be local; ` +
        "a remote host is never a disposable test database."
    );
  }

  const port = url.port || FORBIDDEN_PORT;
  if (port === FORBIDDEN_PORT) {
    die(
      `refusing port ${FORBIDDEN_PORT}. That is the operator's live gateway ` +
        "database, not a test fixture. The fixture listens on its own port."
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (database !== FIXTURE_DATABASE) {
    die(
      `refusing database ${JSON.stringify(database)}. The fixture is ` +
        `${JSON.stringify(FIXTURE_DATABASE)} and nothing else is disposable.`
    );
  }

  return { url, port, database };
}

/**
 * Three consecutive successes, not one. The postgres entrypoint runs a local
 * server for initdb and restarts it before listening for real, so a single
 * probe can pass against a server that is about to go away.
 */
async function waitReady(Client, dsn, timeoutSeconds) {
  let consecutive = 0;
  for (let attempt = 0; attempt < timeoutSeconds; attempt += 1) {
    const client = new Client({ connectionString: dsn, connectionTimeoutMillis: 2000 });
    try {
      await client.connect();
      await client.query("SELECT 1");
      consecutive += 1;
      if (consecutive >= 3) return true;
    } catch {
      consecutive = 0;
    } finally {
      await client.end().catch(() => {});
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  return false;
}

async function main() {
  const raw = process.argv[2];
  if (!raw) die("usage: pg-fixture.mjs <dsn>");

  const { url, port, database } = assertFixtureDsn(raw);

  let Client;
  try {
    ({ Client } = await import("pg"));
  } catch {
    die("the optional `pg` dependency is not installed.");
  }

  // Reset and readiness both run against the maintenance database, because a
  // session connected to `database` would block its own DROP.
  const adminUrl = new URL(url.toString());
  adminUrl.pathname = "/postgres";
  const adminDsn = adminUrl.toString();

  const timeoutSeconds = Number(process.env.PG_TEST_READY_TIMEOUT || "120");
  process.stdout.write(`pg-fixture: waiting for ${url.hostname}:${port}\n`);
  if (!(await waitReady(Client, adminDsn, timeoutSeconds))) {
    die(
      `${url.hostname}:${port} did not accept connections within ` +
        `${timeoutSeconds}s. The fixture server is not running. This is a ` +
        "missing fixture, not a test failure."
    );
  }

  const client = new Client({ connectionString: adminDsn });
  await client.connect();
  try {
    // WITH (FORCE) terminates other backends. Without it an abandoned
    // connection from a killed run makes the drop hang rather than fail.
    await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${database}`);

    // `DROP DATABASE` does not remove cluster-wide ROLES, and both
    // migration-pg.test.ts and job-store-pg.test.ts create login roles whose
    // `finally` a cancelled run can skip. They would otherwise accumulate for
    // the life of the server. Schemas need no such sweep: `flight_pg_*`,
    // `migration_*` and the rest live INSIDE the fixture database and die with
    // it. These two prefixes are the role names those suites actually build
    // (`migration_runtime_${suffix}` and `job_store_runtime_${suffix}`); a
    // prefix that matches nothing is a sweep that silently does nothing.
    const stale = await client.query(
      "SELECT rolname FROM pg_roles WHERE rolname LIKE 'migration_runtime_%' OR rolname LIKE 'job_store_runtime_%'"
    );
    for (const row of stale.rows) {
      await client.query(`DROP ROLE IF EXISTS "${row.rolname.replace(/"/g, '""')}"`);
    }
    if (stale.rowCount > 0) {
      process.stdout.write(`pg-fixture: dropped ${stale.rowCount} stale test role(s)\n`);
    }
  } finally {
    await client.end().catch(() => {});
  }

  process.stdout.write(`pg-fixture: ${database} reset on ${url.hostname}:${port}\n`);
}

main().catch(error => die(error instanceof Error ? error.message : String(error)));
