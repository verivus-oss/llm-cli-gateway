#!/usr/bin/env node

import type { PoolClient } from "pg";
import { createHash } from "crypto";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { POSTGRES_SCHEMA_MIGRATION_LEDGER } from "./postgres-job-store-schema.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Migration {
  version: number;
  name: string;
  recordName: string;
  sql: string;
  checksumSha256: string;
}

interface AppliedMigration {
  version: number;
  name: string;
  checksumSha256: string | null;
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

// A stable two-part advisory-lock key reserved for schema migration runners.
// The session lock spans the discovery check and every individual migration
// transaction, so a second workstation always rechecks the committed schema
// rather than replaying a stale pending list.
const MIGRATION_LOCK_NAMESPACE = 1_280_066_887;
const MIGRATION_LOCK_KEY = 1;

// Migrations 002 and 003 were published before `session_summary` was known to
// block the column alterations they contain. Keep their source files immutable:
// this transaction-local wrapper temporarily removes the migration-owned view
// and normalizes legacy UUID identifiers while one of those migrations remains
// pending.
// Migration 018 repairs a schema where those historical receipts already exist,
// including a canonical TEXT shape whose active-session foreign key was lost.
const SESSION_SUMMARY_COMPATIBILITY_MIGRATION_VERSIONS = new Set([2, 3]);

const SESSION_SUMMARY_VIEW_SQL = `
  CREATE OR REPLACE VIEW session_summary AS
  SELECT
    s.id,
    s.cli,
    s.description,
    s.created_at,
    s.last_used_at,
    (a.session_id IS NOT NULL) AS is_active
  FROM sessions s
  LEFT JOIN active_sessions a ON s.id = a.session_id
`;

const SESSION_ID_COMPATIBILITY_SQL = `
  DO $$
  DECLARE
    sessions_id_is_uuid BOOLEAN;
    active_session_id_is_uuid BOOLEAN;
    canonical_session_id_foreign_key_exists BOOLEAN;
    conflicting_session_id_foreign_key TEXT;
    required_foreign_key_name_conflict TEXT;
    session_id_foreign_key RECORD;
  BEGIN
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('sessions')
        AND attname = 'id'
        AND atttypid = 'uuid'::regtype
        AND attnum > 0
        AND NOT attisdropped
    ) INTO sessions_id_is_uuid;
    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_attribute
      WHERE attrelid = to_regclass('active_sessions')
        AND attname = 'session_id'
        AND atttypid = 'uuid'::regtype
        AND attnum > 0
        AND NOT attisdropped
    ) INTO active_session_id_is_uuid;

    SELECT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = to_regclass('active_sessions')
        AND constraint_row.confrelid = to_regclass('sessions')
        AND constraint_row.contype = 'f'
        AND constraint_row.convalidated
        AND constraint_row.confdeltype = 'c'
        AND array_length(constraint_row.conkey, 1) = 1
        AND constraint_row.conkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_catalog.pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = to_regclass('active_sessions')
            AND attribute_row.attname = 'session_id'
            AND attribute_row.attnum > 0
            AND NOT attribute_row.attisdropped
        )
        AND array_length(constraint_row.confkey, 1) = 1
        AND constraint_row.confkey[1] = (
          SELECT attribute_row.attnum
          FROM pg_catalog.pg_attribute AS attribute_row
          WHERE attribute_row.attrelid = to_regclass('sessions')
            AND attribute_row.attname = 'id'
            AND attribute_row.attnum > 0
            AND NOT attribute_row.attisdropped
        )
    ) INTO canonical_session_id_foreign_key_exists;

    IF sessions_id_is_uuid
       OR active_session_id_is_uuid
       OR NOT canonical_session_id_foreign_key_exists THEN
      -- A foreign key on session_id that targets anything other than
      -- sessions.id is application-owned schema. Never drop or reinterpret it
      -- as the canonical relationship during a compatibility repair.
      SELECT constraint_row.conname
        INTO conflicting_session_id_foreign_key
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = to_regclass('active_sessions')
        AND constraint_row.contype = 'f'
        AND array_position(
          constraint_row.conkey,
          (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
        ) IS NOT NULL
        AND NOT (
          constraint_row.confrelid = to_regclass('sessions')
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
        )
      LIMIT 1;
      IF conflicting_session_id_foreign_key IS NOT NULL THEN
        RAISE EXCEPTION
          'Cannot repair session schema: active_sessions.session_id foreign key "%" does not reference sessions.id',
          conflicting_session_id_foreign_key;
      END IF;

      -- A conflicting constraint name would make the canonical ADD below
      -- ambiguous. Preserve it and require an explicit manual migration.
      SELECT constraint_row.conname
        INTO required_foreign_key_name_conflict
      FROM pg_catalog.pg_constraint AS constraint_row
      WHERE constraint_row.conrelid = to_regclass('active_sessions')
        AND constraint_row.conname = 'active_sessions_session_id_fkey'
        AND NOT (
          constraint_row.contype = 'f'
          AND constraint_row.confrelid = to_regclass('sessions')
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
        )
      LIMIT 1;
      IF required_foreign_key_name_conflict IS NOT NULL THEN
        RAISE EXCEPTION
          'Cannot repair session schema: active_sessions constraint "%" conflicts with the required session foreign key',
          required_foreign_key_name_conflict;
      END IF;

      -- Historical schemas may use a nonstandard name for the exact
      -- session_id -> sessions.id relationship. Drop only that verified
      -- relationship before changing either endpoint or normalizing cascade.
      FOR session_id_foreign_key IN
        SELECT constraint_row.conname
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = to_regclass('active_sessions')
          AND constraint_row.confrelid = to_regclass('sessions')
          AND constraint_row.contype = 'f'
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
      LOOP
        EXECUTE format(
          'ALTER TABLE active_sessions DROP CONSTRAINT %I',
          session_id_foreign_key.conname
        );
      END LOOP;
      IF sessions_id_is_uuid THEN
        ALTER TABLE sessions ALTER COLUMN id TYPE TEXT USING id::text;
      END IF;
      IF active_session_id_is_uuid THEN
        ALTER TABLE active_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::text;
      END IF;
      ALTER TABLE active_sessions
        ADD CONSTRAINT active_sessions_session_id_fkey
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
    END IF;
  END;
  $$ LANGUAGE plpgsql
`;

/**
 * Load all migration files from migrations directory
 */
function loadMigrations(): Migration[] {
  const migrationsDir = join(__dirname, "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort(); // Ensures migrations run in order

  const migrations = files.map(file => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}`);
    }

    const version = parseInt(match[1], 10);
    const name = match[2];
    const recordName = file.slice(0, -".sql".length);
    const sql = readFileSync(join(migrationsDir, file), "utf-8");
    const checksumSha256 = createHash(POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumAlgorithm)
      .update(sql, "utf8")
      .digest("hex");

    return { version, name, recordName, sql, checksumSha256 };
  });

  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      throw new Error(
        `Migration files must be contiguous from version 1; expected ${expectedVersion}, found ${migration.version} (${migration.name})`
      );
    }
  }

  return migrations;
}

/**
 * Get list of applied migrations
 */
async function getAppliedMigrations(client: PoolClient): Promise<AppliedMigration[]> {
  // First, ensure schema_migrations table exists. The nullable checksum column
  // is an additive runner-owned ledger upgrade: NULL means a row predates
  // checksum recording, not that its historical SQL can be reconstructed.
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum_sha256 TEXT
    )
  `);
  await client.query(
    `ALTER TABLE schema_migrations
       ADD COLUMN IF NOT EXISTS ${POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumColumn} TEXT`
  );

  const result = await client.query<AppliedMigration>(
    `SELECT version, name,
            ${POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumColumn} AS "checksumSha256"
       FROM schema_migrations
      ORDER BY version`
  );
  return result.rows;
}

function assertRecordedMigrationChecksum(migration: Migration, checksumSha256: unknown): void {
  if (typeof checksumSha256 !== "string" || !SHA256_HEX.test(checksumSha256)) {
    throw new Error(
      `Database migration ${migration.version} (${migration.recordName}) has an invalid SHA-256 checksum; refusing to run migrations`
    );
  }
  if (checksumSha256 !== migration.checksumSha256) {
    throw new Error(
      `Database migration ${migration.version} (${migration.recordName}) checksum mismatch; refusing to run migrations`
    );
  }
}

/**
 * Store the hash only after the migration's own version/name receipt exists.
 * This runs inside the migration transaction, so a failure rolls back both
 * schema work and the ledger record. A NULL historical row is never backfilled:
 * current source bytes cannot prove what an older runner actually executed.
 */
async function recordMigrationChecksum(client: PoolClient, migration: Migration): Promise<void> {
  const receipt = await client.query<AppliedMigration>(
    `SELECT version, name,
            ${POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumColumn} AS "checksumSha256"
       FROM schema_migrations
      WHERE version = $1
      FOR UPDATE`,
    [migration.version]
  );
  const applied = receipt.rows[0];
  if (receipt.rows.length !== 1 || !applied) {
    throw new Error(
      `Migration ${migration.version} (${migration.recordName}) did not record its schema_migrations receipt`
    );
  }
  if (applied.name !== migration.recordName) {
    throw new Error(
      `Migration ${migration.version} recorded ${applied.name}, but this release requires ${migration.recordName}`
    );
  }
  if (applied.checksumSha256 !== null) {
    assertRecordedMigrationChecksum(migration, applied.checksumSha256);
    return;
  }

  const updated = await client.query(
    `UPDATE schema_migrations
        SET ${POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumColumn} = $1
      WHERE version = $2
        AND name = $3
        AND ${POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumColumn} IS NULL`,
    [migration.checksumSha256, migration.version, migration.recordName]
  );
  if (updated.rowCount !== 1) {
    throw new Error(
      `Migration ${migration.version} (${migration.recordName}) could not record its SHA-256 checksum`
    );
  }
}

async function prepareHistoricalSessionSummaryMigration(
  client: PoolClient,
  migration: Migration
): Promise<boolean> {
  if (!SESSION_SUMMARY_COMPATIBILITY_MIGRATION_VERSIONS.has(migration.version)) {
    return false;
  }

  if (migration.version === 2) {
    const currentSchemaResult = await client.query<{ currentSchema: string | null }>(
      'SELECT current_schema() AS "currentSchema"'
    );
    const currentSchema = currentSchemaResult.rows[0]?.currentSchema;
    if (!currentSchema) {
      throw new Error("Migration 002 could not determine the active PostgreSQL schema");
    }
    if (currentSchema !== "public") {
      const publicLegacyResult = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'sessions'
            AND column_name = 'id'
            AND udt_name = 'uuid'
        ) AS exists
      `);
      if (publicLegacyResult.rows[0]?.exists) {
        throw new Error(
          "Migration 002 cannot safely target a non-public schema while public.sessions still uses UUID. Run the legacy public-schema upgrade first or use a database with an isolated public schema."
        );
      }
    }
  }

  await client.query("DROP VIEW IF EXISTS session_summary");
  if (migration.version === 2) {
    await client.query(SESSION_ID_COMPATIBILITY_SQL);
  }
  return true;
}

/**
 * A historical runner could record migration 002 or 003 while operating on a
 * non-public schema, leaving the original UUID session columns in place. Once
 * those receipts exist, the pending-version wrapper above no longer runs, but
 * migration 006 needs TEXT foreign-key columns and the runtime needs the
 * canonical active_sessions.session_id -> sessions.id cascade. Repair either
 * recorded legacy shape before calculating and applying later pending migrations.
 *
 * The repair is intentionally runner-owned rather than a source edit to
 * published migrations 002/003. It is idempotent, transactionally atomic, and
 * leaves the original migration receipts and checksums intact.
 */
async function repairRecordedLegacySessionShape(
  client: PoolClient,
  appliedVersions: ReadonlySet<number>
): Promise<boolean> {
  if (!appliedVersions.has(2) && !appliedVersions.has(3)) return false;

  const legacy = await client.query<{ needsRepair: boolean }>(`
    SELECT
      to_regclass('session_summary') IS NULL
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid = to_regclass('sessions')
          AND attname = 'id'
          AND atttypid = 'uuid'::regtype
          AND attnum > 0
          AND NOT attisdropped
      )
      OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = to_regclass('active_sessions')
          AND constraint_row.confrelid = to_regclass('sessions')
          AND constraint_row.contype = 'f'
          AND constraint_row.convalidated
          AND constraint_row.confdeltype = 'c'
          AND array_length(constraint_row.conkey, 1) = 1
          AND constraint_row.conkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('active_sessions')
              AND attribute_row.attname = 'session_id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
          AND array_length(constraint_row.confkey, 1) = 1
          AND constraint_row.confkey[1] = (
            SELECT attribute_row.attnum
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = to_regclass('sessions')
              AND attribute_row.attname = 'id'
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
          )
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid = to_regclass('active_sessions')
          AND attname = 'session_id'
          AND atttypid = 'uuid'::regtype
          AND attnum > 0
          AND NOT attisdropped
      )
      OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid IN (to_regclass('sessions'), to_regclass('active_sessions'))
          AND attname = 'cli'
          AND (atttypid <> 'character varying'::regtype OR atttypmod <> 36)
          AND attnum > 0
          AND NOT attisdropped
      ) AS "needsRepair"
  `);
  if (!legacy.rows[0]?.needsRepair) return false;

  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    await client.query("DROP VIEW IF EXISTS session_summary");
    await client.query(SESSION_ID_COMPATIBILITY_SQL);
    await client.query("ALTER TABLE sessions ALTER COLUMN cli TYPE VARCHAR(32)");
    await client.query("ALTER TABLE active_sessions ALTER COLUMN cli TYPE VARCHAR(32)");
    await client.query(SESSION_SUMMARY_VIEW_SQL);
    await client.query("COMMIT");
    transactionOpen = false;
    console.error("Repaired recorded legacy session schema before applying pending migrations");
    return true;
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Run a single migration
 */
async function runMigration(client: PoolClient, migration: Migration): Promise<void> {
  console.error(`Running migration ${migration.version}: ${migration.name}...`);

  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;
    const restoreSessionSummary = await prepareHistoricalSessionSummaryMigration(client, migration);
    await client.query(migration.sql);
    if (restoreSessionSummary) {
      await client.query(SESSION_SUMMARY_VIEW_SQL);
    }
    await recordMigrationChecksum(client, migration);
    await client.query("COMMIT");
    transactionOpen = false;
    console.error(`✓ Migration ${migration.version} completed`);
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Main migration runner
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable not set");
    process.exit(1);
  }

  const { Pool } = await importOptionalPg();
  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Load migrations
    const migrations = loadMigrations();
    console.error(`Found ${migrations.length} migration(s)`);

    const client = await pool.connect();
    let lockHeld = false;
    try {
      // Do not calculate pending work until this session owns the lock. Every
      // waiting runner observes the schema only after the prior runner has
      // committed its full migration sequence.
      await client.query("SELECT pg_advisory_lock($1::integer, $2::integer)", [
        MIGRATION_LOCK_NAMESPACE,
        MIGRATION_LOCK_KEY,
      ]);
      lockHeld = true;

      const applied = await getAppliedMigrations(client);
      console.error(`${applied.length} migration(s) already applied`);

      const migrationsByVersion = new Map(
        migrations.map(migration => [migration.version, migration])
      );
      const appliedVersions = new Set<number>();
      let legacyChecksumCount = 0;
      for (const appliedMigration of applied) {
        const sourceMigration = migrationsByVersion.get(appliedMigration.version);
        if (!sourceMigration) {
          throw new Error(
            `Database records migration ${appliedMigration.version} (${appliedMigration.name}) that is absent from this release`
          );
        }
        if (sourceMigration.recordName !== appliedMigration.name) {
          throw new Error(
            `Database migration ${appliedMigration.version} is named ${appliedMigration.name}, but this release requires ${sourceMigration.recordName}`
          );
        }
        if (appliedMigration.checksumSha256 === null) {
          // Full historical verification is impossible without a digest
          // captured when the migration ran. Preserve the NULL as explicit
          // legacy evidence rather than inventing a checksum from current SQL.
          legacyChecksumCount += 1;
        } else {
          assertRecordedMigrationChecksum(sourceMigration, appliedMigration.checksumSha256);
        }
        appliedVersions.add(appliedMigration.version);
      }

      if (legacyChecksumCount > 0) {
        console.error(
          `WARNING: ${legacyChecksumCount} applied migration(s) have no SHA-256 checksum and cannot be verified retrospectively. Their NULL checksums will not be backfilled; newly applied migrations are verified on future runs.`
        );
      }

      await repairRecordedLegacySessionShape(client, appliedVersions);
      const pending = migrations.filter(m => !appliedVersions.has(m.version));

      if (pending.length === 0) {
        console.error("✓ All migrations up to date");
        return;
      }

      console.error(`Running ${pending.length} pending migration(s)...`);
      for (const migration of pending) {
        await runMigration(client, migration);
      }
    } finally {
      if (lockHeld) {
        await client.query("SELECT pg_advisory_unlock($1::integer, $2::integer)", [
          MIGRATION_LOCK_NAMESPACE,
          MIGRATION_LOCK_KEY,
        ]);
      }
      client.release();
    }

    console.error("✓ All migrations completed successfully");
  } catch (error) {
    console.error("ERROR:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

async function importOptionalPg(): Promise<typeof import("pg")> {
  try {
    return await import("pg");
  } catch (error: any) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") {
      throw new Error(
        "PostgreSQL migrations require optional peer dependency 'pg'. Install it alongside llm-cli-gateway before running migrate.",
        { cause: error }
      );
    }
    throw error;
  }
}

main();
