import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { POSTGRES_JOB_STORE_REQUIRED_COLUMNS } from "../postgres-job-store-schema.js";
import { PostgresJobStore } from "../job-store.js";
import { JOB_SCHEMA_SQL, SESSION_SCHEMA_SQL, TEST_DATABASE_URL } from "./setup.js";

/**
 * Bootstrap SQL versus migrations/, compared rather than assumed.
 *
 * `scripts/test-pg.sh` applies `migrations/` before the suites so they run
 * against the canonical schema. That is the right fix for a persistent server,
 * and it has a cost this file pays back: once migrations have created every
 * table, `setupTestDatabase`'s `CREATE TABLE IF NOT EXISTS` and
 * `ADD COLUMN IF NOT EXISTS` can no longer fail. A column added to setup.ts but
 * MISSING from migrations/ would be quietly reconciled and CI would go green
 * against a shape production never builds.
 *
 * A note on what the earlier measurement got wrong, because it is the reason
 * this file exists as a gate rather than a comment. Comparing two databases
 * that had both RUN the suites showed the shared tables as identical. They are
 * not. `PostgresJobStore.init()` issues its own `ALTER TABLE ... ADD COLUMN IF
 * NOT EXISTS` on startup, so running the suites first repaired the bootstrap
 * schema before anything looked at it. Measuring after the repair measured the
 * repair. This file builds each schema in isolation and never runs the store.
 *
 * The real relationship is therefore: bootstrap SQL is a strict SUBSET of
 * migrations, and the gap is exactly the columns the job store adds itself.
 * That gap is asserted against the store's own declared requirement rather than
 * a list typed out here, so a new column cannot widen it unnoticed.
 */

const suffix = randomUUID().replaceAll("-", "");
const BOOTSTRAP_SCHEMA = `parity_bootstrap_${suffix}`;
const MIGRATED_SCHEMA = `parity_migrated_${suffix}`;
const REPAIRED_SCHEMA = `parity_repaired_${suffix}`;

interface Column {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
}

let pool: Pool;
let bootstrapColumns: Column[];
let migratedColumns: Column[];

const key = (c: Column): string => `${c.table_name}.${c.column_name}`;

async function columnsOf(schema: string): Promise<Column[]> {
  const result = await pool.query<Column>(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, column_name`,
    [schema]
  );
  return result.rows;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL });

  await pool.query(`CREATE SCHEMA ${BOOTSTRAP_SCHEMA}`);
  await pool.query(`CREATE SCHEMA ${MIGRATED_SCHEMA}`);

  // Bootstrap: exactly what setupTestDatabase runs, into an isolated schema,
  // and deliberately WITHOUT constructing a PostgresJobStore.
  const bootstrap = await pool.connect();
  try {
    await bootstrap.query(`SET search_path TO ${BOOTSTRAP_SCHEMA}`);
    await bootstrap.query(SESSION_SCHEMA_SQL);
    await bootstrap.query(JOB_SCHEMA_SQL);
  } finally {
    bootstrap.release();
  }

  // Migrations: the real migrate entrypoint, scoped to the other schema.
  const scoped = new URL(TEST_DATABASE_URL);
  scoped.searchParams.set("options", `-c search_path=${MIGRATED_SCHEMA}`);
  execFileSync(process.execPath, ["dist/migrate.js"], {
    env: { ...process.env, DATABASE_URL: scoped.toString() },
    stdio: "pipe",
  });

  bootstrapColumns = await columnsOf(BOOTSTRAP_SCHEMA);
  migratedColumns = await columnsOf(MIGRATED_SCHEMA);
}, 120_000);

afterAll(async () => {
  if (!pool) return;
  await pool.query(`DROP SCHEMA IF EXISTS ${BOOTSTRAP_SCHEMA} CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS ${MIGRATED_SCHEMA} CASCADE`);
  await pool.query(`DROP SCHEMA IF EXISTS ${REPAIRED_SCHEMA} CASCADE`);
  await pool.end();
});

describe("bootstrap SQL and migrations/ agree", () => {
  it("builds both schemas, so a comparison of nothing cannot pass silently", () => {
    // Guards the guard: were either side empty, every assertion below would
    // pass by comparing two empty lists.
    expect(bootstrapColumns.length).toBeGreaterThan(0);
    expect(migratedColumns.length).toBeGreaterThan(0);
  });

  it("has no column bootstrap creates that migrations does not", () => {
    const migrated = new Set(migratedColumns.map(key));
    const orphaned = bootstrapColumns.filter(c => !migrated.has(key(c))).map(key);

    // This is the direction that matters most. A column here means production
    // migrations would never create something the tests rely on.
    expect(orphaned).toEqual([]);
  });

  it("agrees on the type and nullability of every shared column", () => {
    const migrated = new Map(migratedColumns.map(c => [key(c), c]));
    const mismatched = bootstrapColumns
      .filter(c => migrated.has(key(c)))
      .filter(c => {
        const other = migrated.get(key(c)) as Column;
        return other.data_type !== c.data_type || other.is_nullable !== c.is_nullable;
      })
      .map(c => `${key(c)}: ${c.data_type}/${c.is_nullable}`);

    expect(mismatched).toEqual([]);
  });

  it("closes the remaining gap with exactly the columns the job store repairs", () => {
    const bootstrapTables = new Set(bootstrapColumns.map(c => c.table_name));
    const bootstrapKeys = new Set(bootstrapColumns.map(key));

    const gap = migratedColumns
      .filter(c => bootstrapTables.has(c.table_name))
      .filter(c => !bootstrapKeys.has(key(c)))
      .map(key)
      .sort();

    // PINNED, not merely bounded. An earlier version asserted only that each
    // gap column appeared in POSTGRES_JOB_STORE_REQUIRED_COLUMNS, which is the
    // full runtime schema rather than a list of what init() repairs. That is a
    // one-way tie: a new required column missing from BOTH bootstrap and init
    // would widen the gap and still pass. These three are what
    // PostgresJobStore.init() actually adds via ALTER TABLE, so changing this
    // list has to be a deliberate edit here.
    expect(gap).toEqual([
      "jobs.cwd_path",
      "jobs.cwd_scope",
      "jobs.error_category",
      "jobs.progress_json",
      "jobs.retryable",
      "jobs.workspace_alias",
    ]);

    // Cross-check the pin against the store's own declaration, so the two
    // cannot drift apart silently either.
    const required: Record<string, readonly string[]> = POSTGRES_JOB_STORE_REQUIRED_COLUMNS;
    for (const column of gap) {
      const [table, name] = column.split(".");
      expect(required[table] ?? []).toContain(name);
    }
  });

  it("repairs that whole gap when the store starts on a bootstrap-only schema", async () => {
    // The pin above named init() as the thing that closes the gap and asserted
    // nothing about it, so a column could join the gap without joining the
    // repair. This runs the repair: bootstrap SQL only, no migrations, then a
    // real store against that schema.
    await pool.query(`CREATE SCHEMA ${REPAIRED_SCHEMA}`);
    const seed = await pool.connect();
    try {
      await seed.query(`SET search_path TO ${REPAIRED_SCHEMA}`);
      await seed.query(SESSION_SCHEMA_SQL);
      await seed.query(JOB_SCHEMA_SQL);
    } finally {
      seed.release();
    }

    const before = new Set((await columnsOf(REPAIRED_SCHEMA)).map(key));
    const bootstrapKeys = new Set(bootstrapColumns.map(key));
    const bootstrapTables = new Set(bootstrapColumns.map(c => c.table_name));
    const gap = migratedColumns
      .filter(c => bootstrapTables.has(c.table_name))
      .filter(c => !bootstrapKeys.has(key(c)))
      .map(key)
      .sort();
    expect(gap.filter(column => before.has(column))).toEqual([]);

    const scoped = new URL(TEST_DATABASE_URL);
    scoped.searchParams.set("options", `-c search_path=${REPAIRED_SCHEMA}`);
    const store = new PostgresJobStore(scoped.toString(), undefined, {
      retentionMs: 60_000,
      dedupWindowMs: 60_000,
    });
    try {
      await store.selectOrphanedProcessCandidates("parity-host");
    } finally {
      await store.close();
    }

    const after = new Set((await columnsOf(REPAIRED_SCHEMA)).map(key));
    expect(gap.filter(column => !after.has(column))).toEqual([]);
  }, 60_000);

  it("leaves the migration-owned tables out of bootstrap, which is by design", () => {
    const bootstrapTables = new Set(bootstrapColumns.map(c => c.table_name));
    const migratedTables = new Set(migratedColumns.map(c => c.table_name));
    const migrationOnly = [...migratedTables].filter(t => !bootstrapTables.has(t)).sort();

    // Pinned, so a new migration-owned relation is a deliberate edit here
    // rather than something that silently widens the gap. session_summary is a
    // VIEW, which information_schema.columns reports alongside tables.
    expect(migrationOnly).toEqual([
      "gateway_metadata",
      "requests",
      "schema_migrations",
      "session_summary",
    ]);
  });
});
