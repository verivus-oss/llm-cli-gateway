#!/usr/bin/env node

import { Pool } from "pg";
import { readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Load all migration files from migrations directory
 */
function loadMigrations(): Migration[] {
  const migrationsDir = join(__dirname, "..", "migrations");
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith(".sql"))
    .sort(); // Ensures migrations run in order

  return files.map(file => {
    const match = file.match(/^(\d+)_(.+)\.sql$/);
    if (!match) {
      throw new Error(`Invalid migration filename: ${file}`);
    }

    const version = parseInt(match[1], 10);
    const name = match[2];
    const sql = readFileSync(join(migrationsDir, file), "utf-8");

    return { version, name, sql };
  });
}

/**
 * Get list of applied migrations
 */
async function getAppliedMigrations(pool: Pool): Promise<number[]> {
  // First, ensure schema_migrations table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const result = await pool.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
  return result.rows.map(row => row.version);
}

/**
 * Run a single migration
 */
async function runMigration(pool: Pool, migration: Migration): Promise<void> {
  console.error(`Running migration ${migration.version}: ${migration.name}...`);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(migration.sql);
    await client.query("COMMIT");
    console.error(`✓ Migration ${migration.version} completed`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
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

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    // Load migrations
    const migrations = loadMigrations();
    console.error(`Found ${migrations.length} migration(s)`);

    // Get applied migrations
    const applied = await getAppliedMigrations(pool);
    console.error(`${applied.length} migration(s) already applied`);

    // Filter pending migrations
    const pending = migrations.filter(m => !applied.includes(m.version));

    if (pending.length === 0) {
      console.error("✓ All migrations up to date");
      return;
    }

    console.error(`Running ${pending.length} pending migration(s)...`);

    // Run pending migrations
    for (const migration of pending) {
      await runMigration(pool, migration);
    }

    console.error("✓ All migrations completed successfully");
  } catch (error) {
    console.error("ERROR:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
