import { Pool } from "pg";
import { Redis } from "ioredis";
import { beforeAll, afterAll, beforeEach } from "vitest";
import type { Logger } from "../logger.js";

// Test database configuration
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test";
const TEST_REDIS_URL = process.env.TEST_REDIS_URL || "redis://localhost:6380/1";
const PG_TESTS_ENABLED = process.env.PG_TESTS === "1";
const MIGRATION_LOCK_KEY = 88421173;
const CLEANUP_LOCK_KEY = 88421174;

let testPool: Pool | null = null;
let testRedis: Redis | null = null;

/**
 * Mock logger for tests
 */
export const mockLogger: Logger = {
  info: () => {},
  error: () => {},
  debug: () => {}
};

/**
 * Setup test database connections
 */
export async function setupTestDatabase(): Promise<{ pool: Pool; redis: Redis }> {
  if (!testPool) {
    testPool = new Pool({ connectionString: TEST_DATABASE_URL });

    const client = await testPool.connect();
    try {
      // Serialize schema bootstrap across parallel Vitest workers/processes.
      await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      try {
        const migrationSql = `
          -- Create sessions table
          CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            cli VARCHAR(10) NOT NULL CHECK (cli IN ('claude', 'codex', 'gemini')),
            description TEXT,
            metadata JSONB DEFAULT '{}'::JSONB,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          -- Create active_sessions table
          CREATE TABLE IF NOT EXISTS active_sessions (
            cli VARCHAR(10) PRIMARY KEY CHECK (cli IN ('claude', 'codex', 'gemini')),
            session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );

          -- Indexes
          CREATE INDEX IF NOT EXISTS idx_sessions_cli ON sessions(cli);
          CREATE INDEX IF NOT EXISTS idx_sessions_last_used_at ON sessions(last_used_at DESC);
          CREATE INDEX IF NOT EXISTS idx_sessions_metadata ON sessions USING GIN(metadata);
          CREATE INDEX IF NOT EXISTS idx_sessions_cli_last_used ON sessions(cli, last_used_at DESC);

          -- Normalize legacy UUID schemas to opaque string IDs for compatibility.
          DO $$
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = 'public'
                AND table_name = 'sessions'
                AND column_name = 'id'
                AND udt_name = 'uuid'
            ) THEN
              ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_session_id_fkey;
              ALTER TABLE sessions ALTER COLUMN id TYPE TEXT USING id::text;
              ALTER TABLE active_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::text;
              ALTER TABLE active_sessions
                ADD CONSTRAINT active_sessions_session_id_fkey
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
            END IF;
          END;
          $$ LANGUAGE plpgsql;
        `;

        await client.query(migrationSql);
      } finally {
        await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  if (!testRedis) {
    testRedis = new Redis(TEST_REDIS_URL, {
      lazyConnect: false
    });
    await testRedis.ping();
  }

  return { pool: testPool, redis: testRedis };
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

  if (testRedis) {
    await testRedis.flushdb();
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

  if (testRedis) {
    testRedis.disconnect();
    testRedis = null;
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
