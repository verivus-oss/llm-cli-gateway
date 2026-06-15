import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Pool } from "pg";
import { beforeAll, afterAll, beforeEach } from "vitest";
import type { Logger } from "../logger.js";

// Test database configuration
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test";
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
// Clear the legacy env vars so they don't override the test config.
delete process.env.LLM_GATEWAY_LOGS_DB;
delete process.env.LLM_GATEWAY_JOBS_DB;

let testPool: Pool | null = null;

// Cumulative session schema for the test database — the end state of
// migrations/001..005 applied in order. This is inlined (not loaded from the
// migration files) because migration 003's `ALTER COLUMN cli TYPE` cannot run
// against the `session_summary` view that 001 creates; the test DB therefore
// materialises the final column definitions directly and omits that view, which
// no test exercises. Keep this in lockstep with migrations/*.sql:
//   003/005 → the open-API-provider CHECK (cli format guard, not a fixed enum)
//   004     → the owner_principal column
const SESSION_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    cli VARCHAR(32) NOT NULL CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),
    description TEXT,
    metadata JSONB DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    owner_principal TEXT
  );

  CREATE TABLE IF NOT EXISTS active_sessions (
    cli VARCHAR(32) PRIMARY KEY CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_cli ON sessions(cli);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_used_at ON sessions(last_used_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_metadata ON sessions USING GIN(metadata);
  CREATE INDEX IF NOT EXISTS idx_sessions_cli_last_used ON sessions(cli, last_used_at DESC);

  -- Reconcile a pre-existing test database created before the open-name CHECK
  -- (migration 005). DROP + ADD is idempotent and admits arbitrary API names.
  ALTER TABLE sessions ADD COLUMN IF NOT EXISTS owner_principal TEXT;
  ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_cli_check;
  ALTER TABLE sessions
    ADD CONSTRAINT sessions_cli_check CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$');
  ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_cli_check;
  ALTER TABLE active_sessions
    ADD CONSTRAINT active_sessions_cli_check CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$');
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
