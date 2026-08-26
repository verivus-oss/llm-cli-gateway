import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pool } from "pg";
import { beforeAll, afterAll, beforeEach } from "vitest";
import type { Logger } from "../logger.js";
import { PostgresStorageDriver, type PgPoolLike } from "../storage/drivers/postgres.js";

/**
 * The fixture DSN, PROVED to be a fixture before anything destructive runs.
 *
 * `cleanTestDatabase` below issues `DELETE FROM` across nine tables, and the
 * operator's live gateway database listens one port away on the same loopback
 * address. `scripts/test-pg.sh` validates the DSN and hands over a rebuilt one,
 * but that guard only exists on that path: `npx vitest run <file>-pg.test.ts`
 * with a hand-set TEST_DATABASE_URL is a documented invocation in CLAUDE.md and
 * reached the deletes with no host or port check at all. A fence with a
 * documented way around it is not a fence, so the same guard runs here.
 *
 * It THROWS rather than exiting: a refusal should fail the suite loudly with a
 * reason, not kill the runner. The exported value is the REBUILT DSN, never the
 * caller's string, because pg honours `?host=`/`?port=` over the URL authority.
 *
 * The default comes from FIXTURE in pg-fixture.mjs rather than a literal, so
 * the fixture's host, port and database are declared in exactly one place.
 */
// @ts-expect-error -- plain ESM script, no type declarations by design.
import { assertFixtureDsn, canonicalDsn, defaultFixtureDsn } from "../../scripts/pg-fixture.mjs";

const RAW_TEST_DATABASE_URL: string = process.env.TEST_DATABASE_URL || defaultFixtureDsn();

export const TEST_DATABASE_URL: string = canonicalDsn(
  assertFixtureDsn(RAW_TEST_DATABASE_URL, (message: string) => {
    throw new Error(
      `TEST_DATABASE_URL is not a disposable fixture: ${message}\n` +
        "The PostgreSQL suites DELETE from nine tables and drop schemas. " +
        "Point TEST_DATABASE_URL at the test fixture, or run via `npm run test:pg`."
    );
  })
);
const PG_TESTS_ENABLED = process.env.PG_TESTS === "1";
const MIGRATION_LOCK_KEY = 88421173;
const CLEANUP_LOCK_KEY = 88421174;

// Test isolation: route the gateway's async job persistence to an in-process
// MemoryJobStore so tests don't touch ~/.llm-cli-gateway/logs.db. Async tools
// stay fully registered (unlike the old LLM_GATEWAY_LOGS_DB=none, which would
// now disable them entirely under the new structural-invariant model).
if (process.env.LLM_GATEWAY_CONFIG === undefined) {
  const testConfigPath = join(tmpdir(), `llm-cli-gateway-test-config-${process.pid}.toml`);
  writeFileSync(
    testConfigPath,
    ["[persistence]", 'backend = "memory"', "acknowledgeEphemeral = true", ""].join("\n")
  );
  process.env.LLM_GATEWAY_CONFIG = testConfigPath;
}

// The job-store config above does NOT isolate the SESSION store either. A
// FileSessionManager constructed without a path binds to
// ~/.llm-cli-gateway/sessions.json, and it evicts expired sessions on LOAD, so
// a test that merely constructs one deletes real rows. Measured: running
// codex-fork-unavailable.test.ts against a live host removed 28 sessions.
// Pinned per process, for the same reason and in the same way as the recorder.
process.env.LLM_GATEWAY_SESSIONS_FILE = join(
  tmpdir(),
  `llm-cli-gateway-test-sessions-${process.pid}.json`
);

// The job-store config above does NOT isolate the flight recorder: that is a
// separate subsystem with its own selector (`resolveFlightRecorderDbPath` reads
// LLM_GATEWAY_LOGS_DB and otherwise defaults to ~/.llm-cli-gateway/logs.db).
//
// This block previously DELETED that variable, with a comment claiming it kept
// tests off the user's database. Deleting it did the exact opposite: it sent
// every test that constructs a recorder through the default path and wrote into
// the real flight recorder. By the time it was found, ~21,700 fixture rows had
// accumulated there over three weeks, and least-cost routing had been
// calibrating its priors on prompts like "inspect".
//
// Pin it to a per-process temp file instead. Vitest runs each worker in its own
// process, so process.pid keeps workers from sharing one database.
process.env.LLM_GATEWAY_LOGS_DB = join(tmpdir(), `llm-cli-gateway-test-logs-${process.pid}.db`);
delete process.env.LLM_GATEWAY_JOBS_DB;

let testPool: Pool | null = null;

// Cumulative session schema for the test database: the end state of
// migrations/001..018 applied in order. This is inlined (rather than loaded
// from the migration files) so ordinary PG tests can materialise the final
// schema without rerunning migrations for every case. Keep this in lockstep
// with migrations/*.sql:
//   003/005 → the open-API-provider CHECK (cli format guard, not a fixed enum)
//   004     → the owner_principal column
//   006     → provider-plus-scope Kit active-session pointers
//   007     → restart-safe Kit job terminal finalization
//   008     → canonical Postgres job-store schema
//   009     → Kit-aware expired-session cleanup
//   010     → permanent Kit attempt admission/recovery fences
//   011     → Kit terminal-output privacy boundary
//   012     → async response-compression persistence
//   013     → Kit request-key privacy boundary
//   014     → Kit native continuation-handle privacy boundary
//   015     → durable async-job owner-hostname provenance
//   016     → durable Claude MCP artifact cleanup acknowledgement
//   017     → durable Claude MCP artifact scope provenance
//   018     → legacy session/view dependency repair
//   021     → opaque session generation fences for compare-and-set writes
export const SESSION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cli VARCHAR(32) NOT NULL CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),
    description TEXT,
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    owner_principal TEXT,
    session_generation UUID NOT NULL DEFAULT gen_random_uuid()
  );

  CREATE TABLE IF NOT EXISTS active_sessions (
    cli VARCHAR(32) PRIMARY KEY CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS kit_active_sessions (
    cli VARCHAR(32) NOT NULL CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),
    scope_key TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (cli, scope_key)
  );
  CREATE INDEX IF NOT EXISTS idx_kit_active_sessions_session_id
    ON kit_active_sessions(session_id);

  CREATE INDEX IF NOT EXISTS idx_sessions_cli ON sessions(cli);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_used_at ON sessions(last_used_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_metadata ON sessions USING GIN(metadata);
  CREATE INDEX IF NOT EXISTS idx_sessions_cli_last_used ON sessions(cli, last_used_at DESC);

  -- Reconcile a pre-existing test database created before the open-name CHECK
  -- (migration 005). DROP + ADD is idempotent and admits arbitrary API names.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_principal TEXT;
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS session_generation UUID;
  UPDATE sessions SET session_generation = gen_random_uuid() WHERE session_generation IS NULL;
  ALTER TABLE sessions
    ALTER COLUMN session_generation SET DEFAULT gen_random_uuid(),
    ALTER COLUMN session_generation SET NOT NULL;
  ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_cli_check;
  ALTER TABLE sessions
    ADD CONSTRAINT sessions_cli_check CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$');
  ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_cli_check;
  ALTER TABLE active_sessions
    ADD CONSTRAINT active_sessions_cli_check CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$');
`;

export const JOB_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    correlation_id TEXT NOT NULL,
    request_key TEXT NOT NULL,
    cli TEXT NOT NULL,
    args_json TEXT NOT NULL,
    output_format TEXT,
    compress_response BOOLEAN,
    status TEXT NOT NULL,
    exit_code INTEGER,
    stdout TEXT,
    stderr TEXT,
    output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
    error TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    pid INTEGER,
    expires_at TEXT NOT NULL,
    owner_principal TEXT,
    transport TEXT NOT NULL DEFAULT 'process',
    http_status INTEGER,
    payload_json TEXT,
    owner_instance TEXT,
    owner_hostname TEXT,
    mcp_artifact_path TEXT,
    mcp_artifact_scope TEXT,
    mcp_artifact_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE,
    lease_deadline BIGINT,
    kit_execution_json TEXT,
    kit_session_id TEXT,
    kit_terminal_metadata_json TEXT,
    kit_terminal_finalized BOOLEAN NOT NULL DEFAULT FALSE,
    kit_terminal_finalized_at TEXT
  );
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mcp_artifact_path TEXT;
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS mcp_artifact_scope TEXT;
  ALTER TABLE jobs
    ADD COLUMN IF NOT EXISTS mcp_artifact_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE;
  CREATE INDEX IF NOT EXISTS idx_jobs_request_key ON jobs(request_key);
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_request_key_finished ON jobs(request_key, finished_at);
  CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_owner_hostname_status ON jobs(owner_hostname, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_cleanup
    ON jobs(owner_hostname, mcp_artifact_cleanup_pending, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_scope_cleanup
    ON jobs(owner_hostname, mcp_artifact_scope, mcp_artifact_cleanup_pending, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_kit_finalization ON jobs(kit_terminal_finalized, status);
  ALTER TABLE jobs ADD COLUMN IF NOT EXISTS compress_response BOOLEAN;

  CREATE TABLE IF NOT EXISTS gateway_instances (
    instance_id TEXT PRIMARY KEY,
    role TEXT,
    hostname TEXT,
    pid INTEGER,
    started_at BIGINT NOT NULL,
    last_heartbeat BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gateway_instances_heartbeat
    ON gateway_instances(last_heartbeat);

  CREATE TABLE IF NOT EXISTS kit_attempt_fences (
    attempt_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('admitted', 'recovered')),
    cli TEXT NOT NULL,
    kit_execution_json TEXT NOT NULL,
    kit_session_id TEXT NOT NULL,
    owner_principal TEXT,
    fenced_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS validation_runs (
    validation_id TEXT PRIMARY KEY,
    owner_principal TEXT NOT NULL,
    intent TEXT NOT NULL,
    created_at TEXT NOT NULL,
    request_json TEXT NOT NULL,
    provider_links TEXT NOT NULL,
    judge_link TEXT,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_validation_runs_owner ON validation_runs(owner_principal);

  CREATE TABLE IF NOT EXISTS validation_run_jobs (
    job_id TEXT PRIMARY KEY,
    validation_id TEXT NOT NULL,
    role TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_validation_run_jobs_run ON validation_run_jobs(validation_id);

  CREATE TABLE IF NOT EXISTS validation_receipts (
    validation_id TEXT PRIMARY KEY,
    owner_principal TEXT NOT NULL,
    minted_at TEXT NOT NULL,
    schema_version TEXT NOT NULL,
    report_json TEXT NOT NULL,
    canonical_sha256 TEXT NOT NULL,
    prev_sha256 TEXT,
    seq INTEGER,
    signature TEXT,
    models TEXT NOT NULL,
    has_material_disagreement BOOLEAN NOT NULL,
    confidence TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_validation_receipts_owner ON validation_receipts(owner_principal);
`;

/**
 * Mock logger for tests
 */
export const mockLogger: Logger = {
  info: () => {},
  error: () => {},
  debug: () => {},
};

/**
 * Setup test database connections
 */
export async function setupTestDatabase(): Promise<{ pool: Pool }> {
  if (!testPool) {
    testPool = new Pool({ connectionString: TEST_DATABASE_URL });

    const client = await testPool.connect();
    try {
      // Serialize schema bootstrap across parallel Vitest workers/processes.
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      try {
        await client.query(SESSION_SCHEMA_SQL);
        await client.query(JOB_SCHEMA_SQL);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  return { pool: testPool };
}

/**
 * The shared test pool, presented as a storage driver.
 *
 * The session store takes a `StorageDriver` rather than a `pg.Pool` since it
 * moved onto the port. Tests keep the single shared pool (its schema bootstrap
 * and cleanup locks are what let workers run in parallel) and wrap it, rather
 * than opening a second pool per suite: the driver's `close()` is never called
 * here, so ownership of the pool stays with the setup file.
 */
export async function setupTestStorageDriver(): Promise<PostgresStorageDriver> {
  const { pool } = await setupTestDatabase();
  return new PostgresStorageDriver({ app: TEST_DATABASE_URL }, () => pool as unknown as PgPoolLike);
}

/**
 * Clean test database
 */
export async function cleanTestDatabase(): Promise<void> {
  if (testPool) {
    const client = await testPool.connect();
    try {
      await client.query("BEGIN");
      // xact lock is released automatically on COMMIT/ROLLBACK.
      await client.query("SELECT pg_advisory_xact_lock($1)", [CLEANUP_LOCK_KEY]);
      // Row deletes avoid TRUNCATE lock amplification across parallel workers.
      await client.query("DELETE FROM validation_receipts");
      await client.query("DELETE FROM validation_run_jobs");
      await client.query("DELETE FROM validation_runs");
      await client.query("DELETE FROM gateway_instances");
      await client.query("DELETE FROM kit_attempt_fences");
      await client.query("DELETE FROM jobs");
      await client.query("DELETE FROM kit_active_sessions");
      await client.query("DELETE FROM active_sessions");
      await client.query("DELETE FROM sessions");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

/**
 * Teardown test database connections
 */
export async function teardownTestDatabase(): Promise<void> {
  if (testPool) {
    await testPool.end();
    testPool = null;
  }
}

if (PG_TESTS_ENABLED) {
  // Global setup/teardown for PostgreSQL-backed test suites.
  beforeAll(async () => {
    await setupTestDatabase();
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  // Clean database before each test.
  beforeEach(async () => {
    await cleanTestDatabase();
  });
}
