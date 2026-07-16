import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { migrateFromFile } from "../migrate-sessions.js";
import { PostgresJobStore } from "../job-store.js";
import {
  POSTGRES_JOB_STORE_ADDITIVE_MIGRATIONS,
  POSTGRES_JOB_STORE_REQUIRED_COLUMNS,
  POSTGRES_SCHEMA_MIGRATION_LEDGER,
} from "../postgres-job-store-schema.js";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import {
  FileSessionManager,
  kitActiveSessionKey,
  PROVIDER_TYPES,
  SessionStorage,
  type ProviderType,
} from "../session-manager.js";
import {
  kitScopeKey,
  type KitExecutionRef,
  type KitSessionBinding,
} from "../personal-config-types.js";
import { runWithRequestContext } from "../request-context.js";
import { setupTestDatabase, cleanTestDatabase } from "./setup.js";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || "postgresql://test:test@localhost:5433/llm_gateway_test";

const ALL_MIGRATION_VERSIONS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21,
] as const;
const KIT_MIGRATION_VERSIONS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17] as const;
const MIGRATION_FILENAMES: Readonly<Record<number, string>> = {
  1: "001_initial_schema.sql",
  2: "002_session_ids_as_text.sql",
  3: "003_provider_type_sessions.sql",
  4: "004_session_owner_principal.sql",
  5: "005_provider_type_open_api_names.sql",
  6: "006_personal_config_kit_sessions.sql",
  7: "007_personal_config_kit_job_finalization.sql",
  8: "008_postgres_job_store_schema.sql",
  9: "009_personal_config_kit_session_cleanup.sql",
  10: "010_personal_config_kit_attempt_fences.sql",
  11: "011_personal_config_kit_output_privacy.sql",
  12: "012_async_job_response_compression.sql",
  13: "013_personal_config_kit_request_key_privacy.sql",
  14: "014_personal_config_kit_native_handle_privacy.sql",
  15: "015_async_job_owner_hostname.sql",
  16: "016_async_job_mcp_artifact_cleanup.sql",
  17: "017_async_job_mcp_artifact_scope.sql",
  18: "018_repair_legacy_session_summary_dependencies.sql",
  19: "019_async_job_progress.sql",
  20: "020_async_job_error_classification.sql",
  21: "021_session_generation_fence.sql",
};

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

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function migrationSql(version: number): string {
  const filename = MIGRATION_FILENAMES[version];
  if (!filename) throw new Error(`Unknown PostgreSQL migration version ${version}`);
  return readFileSync(join(process.cwd(), "migrations", filename), "utf-8");
}

function migrationRecordName(version: number): string {
  const filename = MIGRATION_FILENAMES[version];
  if (!filename) throw new Error(`Unknown PostgreSQL migration version ${version}`);
  return filename.slice(0, -".sql".length);
}

function migrationChecksum(version: number): string {
  const filename = MIGRATION_FILENAMES[version];
  if (!filename) throw new Error(`Unknown PostgreSQL migration version ${version}`);
  return createHash(POSTGRES_SCHEMA_MIGRATION_LEDGER.checksumAlgorithm)
    .update(readFileSync(join(process.cwd(), "migrations", filename)))
    .digest("hex");
}

async function applyMigrations(client: PoolClient, versions: readonly number[]): Promise<void> {
  for (const version of versions) {
    await client.query("BEGIN");
    try {
      const restoreSessionSummary = SESSION_SUMMARY_COMPATIBILITY_MIGRATION_VERSIONS.has(version);
      if (restoreSessionSummary) {
        await client.query("DROP VIEW IF EXISTS session_summary");
      }
      await client.query(migrationSql(version));
      if (restoreSessionSummary) {
        await client.query(SESSION_SUMMARY_VIEW_SQL);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function activeSessionForeignKeys(client: PoolClient): Promise<
  Array<{
    conname: string;
    definition: string;
    convalidated: boolean;
  }>
> {
  return (
    await client.query<{
      conname: string;
      definition: string;
      convalidated: boolean;
    }>(`
    SELECT conname, pg_get_constraintdef(oid) AS definition, convalidated
    FROM pg_constraint
    WHERE conrelid = 'active_sessions'::regclass
      AND contype = 'f'
    ORDER BY conname
  `)
  ).rows;
}

async function expectCanonicalActiveSessionForeignKey(client: PoolClient): Promise<void> {
  expect(await activeSessionForeignKeys(client)).toEqual([
    {
      conname: "active_sessions_session_id_fkey",
      definition: "FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE",
      convalidated: true,
    },
  ]);
}

interface SessionRepairSchemaOptions {
  sessionsIdType?: "TEXT" | "UUID";
  activeSessionIdType?: "TEXT" | "UUID";
  sessionsExtraColumnSql?: string;
  activeSessionForeignKeySql?: string;
}

async function createSessionRepairSchema(
  client: PoolClient,
  options: SessionRepairSchemaOptions = {}
): Promise<void> {
  const sessionsIdType = options.sessionsIdType ?? "TEXT";
  const activeSessionIdType = options.activeSessionIdType ?? "TEXT";
  const sessionsExtraColumn = options.sessionsExtraColumnSql
    ? `,${options.sessionsExtraColumnSql}`
    : "";
  const activeSessionForeignKey = options.activeSessionForeignKeySql
    ? `,${options.activeSessionForeignKeySql}`
    : "";
  await client.query(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE sessions (
      id ${sessionsIdType} PRIMARY KEY,
      cli VARCHAR(32) NOT NULL,
      description TEXT,
      metadata JSONB DEFAULT '{}'::JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      owner_principal TEXT${sessionsExtraColumn}
    );
    CREATE TABLE active_sessions (
      cli VARCHAR(32) PRIMARY KEY,
      session_id ${activeSessionIdType},
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()${activeSessionForeignKey}
    );
    CREATE VIEW session_summary AS
    SELECT s.id, s.cli, s.description, s.created_at, s.last_used_at,
           (a.session_id IS NOT NULL) AS is_active
    FROM sessions s
    LEFT JOIN active_sessions a ON s.id = a.session_id;
  `);
}

async function recordMigrationReceipts(
  client: PoolClient,
  versions: readonly number[]
): Promise<void> {
  for (const version of versions) {
    await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
      version,
      migrationRecordName(version),
    ]);
  }
}

function schemaScopedDsn(schema: string, role?: { name: string; password: string }): string {
  const dsn = new URL(TEST_DATABASE_URL);
  if (role) {
    dsn.username = role.name;
    dsn.password = role.password;
  }
  dsn.searchParams.set("options", `-c search_path=${schema}`);
  return dsn.toString();
}

function kitExecution(overrides: Partial<KitExecutionRef> = {}): KitExecutionRef {
  return {
    version: 1,
    releaseId: "migration-kit-release",
    configStamp: "migration-kit-stamp",
    scopeRoot: "/workspace/migration-kit",
    scopeHead: "migration-kit-head",
    contextIdentity: "migration-kit-context",
    ...overrides,
  };
}

function kitBinding(overrides: Partial<KitSessionBinding> = {}): KitSessionBinding {
  return {
    execution: kitExecution(),
    nativeSessionId: "77777777-7777-4777-8777-777777777777",
    resumeEligible: true,
    ...overrides,
  };
}

function requestContext(principal: string) {
  return {
    transport: "http" as const,
    authKind: "oauth" as const,
    authScopes: [],
    authPrincipal: principal,
  };
}

describe("Session Migration", () => {
  let pgManager: PostgreSQLSessionManager;
  let testDir: string;
  let testFilePath: string;

  beforeEach(async () => {
    await cleanTestDatabase();
    const { pool } = await setupTestDatabase();
    pgManager = new PostgreSQLSessionManager(pool);

    // Create test directory
    testDir = join(
      tmpdir(),
      `migration-test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    );
    mkdirSync(testDir, { recursive: true });
    testFilePath = join(testDir, "sessions.json");
  });

  afterEach(() => {
    if (testDir) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("migrates a clean isolated schema through 006-020 and initializes with a DML-only role", async () => {
    const { pool } = await setupTestDatabase();
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `migration_clean_${suffix}`;
    const role = `migration_runtime_${suffix}`;
    const password = `pw_${suffix}`;
    let client: PoolClient | null = null;
    let runtimeStore: PostgresJobStore | null = null;
    let schemaCreated = false;
    let roleCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;

      const { stderr } = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      });
      expect(stderr).toContain("All migrations completed successfully");

      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      const migrations = await client.query<{ version: number; checksumSha256: string | null }>(
        `SELECT version,
                checksum_sha256 AS "checksumSha256"
           FROM schema_migrations
          ORDER BY version`
      );
      expect(migrations.rows).toEqual(
        ALL_MIGRATION_VERSIONS.map(version => ({
          version,
          checksumSha256: migrationChecksum(version),
        }))
      );
      const ledgerColumns = await client.query<{ column_name: string }>(
        `SELECT column_name
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'schema_migrations'
            AND column_name = ANY($1::text[])
          ORDER BY column_name`,
        [[...POSTGRES_SCHEMA_MIGRATION_LEDGER.columns].sort()]
      );
      expect(ledgerColumns.rows.map(row => row.column_name)).toEqual(
        [...POSTGRES_SCHEMA_MIGRATION_LEDGER.columns].sort()
      );

      const relations = await client.query<{
        sessions: boolean;
        active_sessions: boolean;
        jobs: boolean;
        gateway_instances: boolean;
        validation_runs: boolean;
        validation_run_jobs: boolean;
        validation_receipts: boolean;
        kit_active_sessions: boolean;
        kit_attempt_fences: boolean;
        session_summary: boolean;
        cleanup_expired_sessions: boolean;
      }>(
        `SELECT
           to_regclass('sessions') IS NOT NULL AS sessions,
           to_regclass('active_sessions') IS NOT NULL AS active_sessions,
           to_regclass('jobs') IS NOT NULL AS jobs,
           to_regclass('gateway_instances') IS NOT NULL AS gateway_instances,
           to_regclass('validation_runs') IS NOT NULL AS validation_runs,
           to_regclass('validation_run_jobs') IS NOT NULL AS validation_run_jobs,
           to_regclass('validation_receipts') IS NOT NULL AS validation_receipts,
           to_regclass('kit_active_sessions') IS NOT NULL AS kit_active_sessions,
           to_regclass('kit_attempt_fences') IS NOT NULL AS kit_attempt_fences,
           to_regclass('session_summary') IS NOT NULL AS session_summary,
           to_regprocedure('cleanup_expired_sessions(integer)') IS NOT NULL AS cleanup_expired_sessions`
      );
      expect(relations.rows[0]).toEqual({
        sessions: true,
        active_sessions: true,
        jobs: true,
        gateway_instances: true,
        validation_runs: true,
        validation_run_jobs: true,
        validation_receipts: true,
        kit_active_sessions: true,
        kit_attempt_fences: true,
        session_summary: true,
        cleanup_expired_sessions: true,
      });
      const requiredJobColumns = [...POSTGRES_JOB_STORE_REQUIRED_COLUMNS.jobs].sort();
      const jobColumns = await client.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'jobs'
         AND column_name = ANY($1::text[])
         ORDER BY column_name`,
        [requiredJobColumns]
      );
      expect(jobColumns.rows.map(row => row.column_name)).toEqual(requiredJobColumns);

      const requiredAdditiveIndexes = POSTGRES_JOB_STORE_ADDITIVE_MIGRATIONS.flatMap(migration =>
        migration.indexes.map(name => ({ name, table: "jobs" }))
      );
      const additiveIndexes = await client.query<{ indexname: string }>(
        `SELECT indexname
         FROM pg_indexes
         WHERE schemaname = current_schema()
           AND tablename = ANY($1::text[])
           AND indexname = ANY($2::text[])
         ORDER BY indexname`,
        [
          [...new Set(requiredAdditiveIndexes.map(index => index.table))],
          requiredAdditiveIndexes.map(index => index.name).sort(),
        ]
      );
      expect(additiveIndexes.rows.map(row => row.indexname)).toEqual(
        requiredAdditiveIndexes.map(index => index.name).sort()
      );

      await pool.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD '${password}'`);
      roleCreated = true;
      await pool.query(
        `GRANT USAGE ON SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`
      );
      await pool.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${quoteIdentifier(schema)} TO ${quoteIdentifier(role)}`
      );
      const privilege = await pool.query<{ can_create: boolean }>(
        "SELECT has_schema_privilege($1, $2, 'CREATE') AS can_create",
        [role, schema]
      );
      expect(privilege.rows[0]?.can_create).toBe(false);

      // The runtime's catalog preflight must accept the migration-created schema
      // without attempting CREATE or ALTER under this DML-only role.
      runtimeStore = new PostgresJobStore(
        schemaScopedDsn(schema, { name: role, password }),
        undefined,
        {
          retentionMs: 60_000,
          dedupWindowMs: 60_000,
        }
      );
      runtimeStore.recordStart({
        id: "migration-dml-only-job",
        correlationId: "migration-dml-only-corr",
        requestKey: "migration-dml-only-key",
        cli: "claude",
        args: ["-p", "DML only"],
        compressResponse: true,
        startedAt: new Date().toISOString(),
        pid: null,
        ownerInstance: "migration-dml-only-instance",
        ownerHostname: "migration-dml-only-host",
        mcpArtifactPath: "/tmp/migration-dml-only-mcp.json",
        mcpArtifactScope: "migration-dml-only-scope",
      });
      expect(runtimeStore.getById("migration-dml-only-job")).toMatchObject({
        id: "migration-dml-only-job",
        status: "queued",
        compressResponse: true,
        ownerInstance: "migration-dml-only-instance",
        ownerHostname: "migration-dml-only-host",
        mcpArtifactPath: "/tmp/migration-dml-only-mcp.json",
        mcpArtifactScope: "migration-dml-only-scope",
        mcpArtifactCleanupPending: true,
      });
    } finally {
      runtimeStore?.close();
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
      if (roleCreated) await pool.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
    }
  });

  it("serializes concurrent schema migration runners and rechecks under the lock", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `migration_concurrent_${randomUUID().replaceAll("-", "")}`;
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      const env = { ...process.env, DATABASE_URL: schemaScopedDsn(schema) };
      const [first, second] = await Promise.all([
        execFileAsync(process.execPath, ["dist/migrate.js"], { cwd: process.cwd(), env }),
        execFileAsync(process.execPath, ["dist/migrate.js"], { cwd: process.cwd(), env }),
      ]);

      expect(`${first.stderr}\n${second.stderr}`).toContain(
        "All migrations completed successfully"
      );
      expect(
        [first.stderr, second.stderr].filter(stderr =>
          stderr.includes("Running 21 pending migration(s)")
        )
      ).toHaveLength(1);

      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      const migrations = await client.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      expect(migrations.rows.map(row => row.version)).toEqual(ALL_MIGRATION_VERSIONS);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("refuses a database migration history whose name does not match this release", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `migration_name_mismatch_${randomUUID().replaceAll("-", "")}`;
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO schema_migrations (version, name)
        VALUES (12, 'wrong_async_job_response_compression');
      `);

      const failure = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      }).catch(error => error as { stderr?: string });

      expect(failure).toMatchObject({
        stderr: expect.stringContaining(
          "Database migration 12 is named wrong_async_job_response_compression"
        ),
      });
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("preserves unverifiable legacy rows while recording checksums for later migrations", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `migration_legacy_checksums_${randomUUID().replaceAll("-", "")}`;
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);

      // These rows simulate migrations applied by a release before checksum
      // recording existed. The runner must not claim current source proves
      // their historical SQL, but it must checksum every later migration.
      await applyMigrations(client, ALL_MIGRATION_VERSIONS.slice(0, 5));

      const { stderr } = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      });
      expect(stderr).toContain("5 applied migration(s) have no SHA-256 checksum");
      expect(stderr).toContain("cannot be verified retrospectively");

      const migrations = await client.query<{ version: number; checksumSha256: string | null }>(
        `SELECT version,
                checksum_sha256 AS "checksumSha256"
           FROM schema_migrations
          ORDER BY version`
      );
      expect(migrations.rows).toEqual(
        ALL_MIGRATION_VERSIONS.map(version => ({
          version,
          checksumSha256: version <= 5 ? null : migrationChecksum(version),
        }))
      );
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("fails closed on a recorded checksum mismatch before pending migrations run", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `migration_checksum_mismatch_${randomUUID().replaceAll("-", "")}`;
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      const env = { ...process.env, DATABASE_URL: schemaScopedDsn(schema) };
      await execFileAsync(process.execPath, ["dist/migrate.js"], { cwd: process.cwd(), env });

      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query(
        "UPDATE schema_migrations SET checksum_sha256 = 'not-a-sha256' WHERE version = 1"
      );
      const malformed = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env,
      }).catch(error => error as { stderr?: string });
      expect(malformed).toMatchObject({
        stderr: expect.stringContaining(
          "Database migration 1 (001_initial_schema) has an invalid SHA-256 checksum"
        ),
      });

      await client.query(
        "UPDATE schema_migrations SET checksum_sha256 = repeat('0', 64) WHERE version = 1"
      );
      // A pending migration makes this prove the checksum guard runs before
      // pending work is calculated or any migration SQL is replayed.
      await client.query("DELETE FROM schema_migrations WHERE version = 18");

      const failure = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env,
      }).catch(error => error as { stderr?: string });

      expect(failure).toMatchObject({
        stderr: expect.stringContaining(
          "Database migration 1 (001_initial_schema) checksum mismatch"
        ),
      });
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version = 18")).rows
      ).toEqual([]);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("upgrades an isolated legacy schema through 006-021, retires Kit handles, and scrubs Kit jobs", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `migration_legacy_${randomUUID().replaceAll("-", "")}`;
    let client: PoolClient | null = null;
    let schemaCreated = false;
    const privateContext = "PRIVATE_MIGRATION_KIT_CONTEXT_SENTINEL";

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);

      await applyMigrations(client, ALL_MIGRATION_VERSIONS.slice(0, 5));
      await client.query(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY,
          correlation_id TEXT NOT NULL,
          request_key TEXT NOT NULL,
          cli TEXT NOT NULL,
          args_json TEXT NOT NULL,
          output_format TEXT,
          status TEXT NOT NULL,
          exit_code INTEGER,
          stdout TEXT,
          stderr TEXT,
          output_truncated BOOLEAN NOT NULL DEFAULT FALSE,
          error TEXT,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          pid INTEGER,
          expires_at TEXT NOT NULL
        )
      `);

      await applyMigrations(client, KIT_MIGRATION_VERSIONS.slice(0, 5));
      // Simulate a database where the historical 008 migration is already
      // recorded, but predates the response-compression column. Migration 012
      // must upgrade this shape without rerunning an applied migration. Migration
      // 013 must then scrub pre-existing Kit request-key fingerprints.
      await client.query("ALTER TABLE jobs DROP COLUMN IF EXISTS compress_response");
      const expiredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const insertExpired = async (
        id: string,
        cli: string,
        metadata: Record<string, unknown> = {}
      ): Promise<void> => {
        await client!.query(
          "INSERT INTO sessions (id, cli, metadata, last_used_at) VALUES ($1, $2, $3::jsonb, $4)",
          [id, cli, JSON.stringify(metadata), expiredAt]
        );
      };

      await insertExpired("legacy-active", "claude");
      await insertExpired("legacy-kit-pointer", "codex", { kit: { resumeEligible: false } });
      await insertExpired("legacy-resumable", "gemini", {
        kit: {
          nativeSessionId: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1",
          resumeEligible: true,
        },
      });
      await insertExpired("legacy-attempt", "grok", { kit: { attempt: { id: "held-attempt" } } });
      await insertExpired("legacy-retired", "mistral", { kit: { resumeEligible: false } });
      await insertExpired("legacy-ordinary", "claude");
      await client.query("INSERT INTO sessions (id, cli) VALUES ('legacy-fresh', 'codex')");
      await client.query(
        "INSERT INTO active_sessions (cli, session_id) VALUES ('claude', 'legacy-active')"
      );
      await client.query(
        "INSERT INTO kit_active_sessions (cli, scope_key, session_id) VALUES ('codex', 'legacy-scope', 'legacy-kit-pointer')"
      );
      await client.query(
        `INSERT INTO kit_attempt_fences (
          attempt_id, state, cli, kit_execution_json, kit_session_id, owner_principal, fenced_at
        ) VALUES ($1, 'admitted', 'claude', $2, 'legacy-fence-session', 'local', $3)`,
        ["legacy-fence", JSON.stringify(kitExecution()), new Date().toISOString()]
      );

      const cleanup = await client.query<{ deleted: number }>(
        "SELECT cleanup_expired_sessions(30) AS deleted"
      );
      expect(cleanup.rows[0]?.deleted).toBe(2);
      const remaining = await client.query<{ id: string }>(
        "SELECT id FROM sessions WHERE id LIKE 'legacy-%' ORDER BY id"
      );
      expect(remaining.rows.map(row => row.id)).toEqual([
        "legacy-active",
        "legacy-attempt",
        "legacy-fresh",
        "legacy-kit-pointer",
        "legacy-resumable",
      ]);

      // Migration 014 must match the runtime scrub's object guard. Older
      // interrupted writes can leave an `attempt` key with a non-object value;
      // its legacy native-handle fields must still be retired without making
      // jsonb_set fail on a scalar or array.
      const malformedKitAttempts = [
        { id: "legacy-malformed-attempt-null", attempt: null },
        { id: "legacy-malformed-attempt-string", attempt: "legacy-attempt" },
        { id: "legacy-malformed-attempt-array", attempt: [] },
      ] as const;
      for (const { id, attempt } of malformedKitAttempts) {
        await client.query(
          "INSERT INTO sessions (id, cli, metadata) VALUES ($1, 'claude', $2::jsonb)",
          [
            id,
            JSON.stringify({
              kit: {
                nativeSessionId: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3",
                resumeEligible: true,
                attempt,
              },
            }),
          ]
        );
      }

      await client.query(
        `INSERT INTO jobs (
          id, correlation_id, request_key, cli, args_json, status, stdout, stderr,
          error, started_at, expires_at, kit_execution_json, kit_session_id, payload_json
        ) VALUES ($1, $2, $3, 'claude', $4, 'failed', $5, $5, $5, $6, $7, $8, $9, $5)`,
        [
          "legacy-kit-privacy-job",
          "legacy-kit-privacy-corr",
          "legacy-kit-privacy-key",
          JSON.stringify(["-p", privateContext]),
          privateContext,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          JSON.stringify(kitExecution()),
          "legacy-kit-session",
        ]
      );
      await client.query(
        `INSERT INTO jobs (
          id, correlation_id, request_key, cli, args_json, status, stdout, stderr,
          error, started_at, expires_at, kit_execution_json, kit_session_id, payload_json
        ) VALUES ($1, $2, $3, 'codex', $4, 'completed', $5, $5, $5, $6, $7, $8, $9, $5)`,
        [
          "legacy-kit-completed-privacy-job",
          "legacy-kit-completed-privacy-corr",
          "legacy-kit-completed-privacy-key",
          JSON.stringify(["exec", privateContext]),
          privateContext,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          JSON.stringify(kitExecution({ contextIdentity: "legacy-completed-kit-job" })),
          "legacy-completed-kit-session",
        ]
      );
      await client.query(
        `INSERT INTO jobs (
          id, correlation_id, request_key, cli, args_json, status, stdout, stderr,
          error, started_at, expires_at, kit_execution_json, kit_session_id, payload_json
        ) VALUES ($1, $2, $3, 'claude', $4, 'queued', $5, $5, $5, $6, $7, $8, $9, $5)`,
        [
          "legacy-kit-queued-privacy-job",
          "legacy-kit-queued-privacy-corr",
          "legacy-kit-queued-privacy-key",
          JSON.stringify(["-p", privateContext]),
          privateContext,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          JSON.stringify(kitExecution({ contextIdentity: "legacy-queued-kit-job" })),
          "legacy-kit-queued-privacy-session",
        ]
      );
      await client.query(
        `INSERT INTO jobs (
          id, correlation_id, request_key, cli, args_json, status, stdout, stderr,
          error, started_at, expires_at, kit_execution_json, kit_session_id, payload_json
        ) VALUES ($1, $2, $3, 'codex', $4, 'running', $5, $5, $5, $6, $7, $8, $9, $5)`,
        [
          "legacy-kit-running-privacy-job",
          "legacy-kit-running-privacy-corr",
          "legacy-kit-running-privacy-key",
          JSON.stringify(["exec", privateContext]),
          privateContext,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
          JSON.stringify(kitExecution({ contextIdentity: "legacy-running-kit-job" })),
          "legacy-kit-running-privacy-session",
        ]
      );
      await client.query(
        `INSERT INTO jobs (
          id, correlation_id, request_key, cli, args_json, status, stdout, stderr,
          error, started_at, expires_at, payload_json
        ) VALUES ($1, $2, $3, 'claude', $4, 'failed', $5, $5, $5, $6, $7, $5)`,
        [
          "legacy-ordinary-privacy-job",
          "legacy-ordinary-privacy-corr",
          "legacy-ordinary-privacy-key",
          JSON.stringify(["-p", privateContext]),
          privateContext,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
        ]
      );

      await applyMigrations(client, [11]);
      const migration011Errors = await client.query<{
        id: string;
        status: string;
        error: string | null;
      }>(
        `SELECT id, status, error
         FROM jobs
         WHERE id = ANY($1::text[])
         ORDER BY id`,
        [
          [
            "legacy-kit-privacy-job",
            "legacy-kit-completed-privacy-job",
            "legacy-kit-queued-privacy-job",
            "legacy-kit-running-privacy-job",
          ],
        ]
      );
      expect(migration011Errors.rows).toEqual([
        {
          id: "legacy-kit-completed-privacy-job",
          status: "completed",
          error: null,
        },
        {
          id: "legacy-kit-privacy-job",
          status: "failed",
          error: "Personal Agent Config Kit provider execution failed; detailed output is withheld",
        },
        {
          id: "legacy-kit-queued-privacy-job",
          status: "queued",
          error: null,
        },
        {
          id: "legacy-kit-running-privacy-job",
          status: "running",
          error: null,
        },
      ]);
      expect(JSON.stringify(migration011Errors.rows)).not.toContain(privateContext);

      await applyMigrations(client, [12, 13]);
      await client.query(
        `UPDATE jobs
         SET kit_terminal_metadata_json = $2
         WHERE id = $1`,
        [
          "legacy-kit-privacy-job",
          JSON.stringify({
            version: 1,
            nativeSessionId: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2",
          }),
        ]
      );
      await applyMigrations(client, [14, 15]);
      await client.query(
        `INSERT INTO gateway_instances
           (instance_id, role, hostname, pid, started_at, last_heartbeat)
         VALUES ('legacy-owner-instance', 'stdio', 'legacy-owner-host', 1, 1, 1)`
      );
      await client.query(
        `UPDATE jobs
         SET owner_instance = 'legacy-owner-instance',
             owner_hostname = CASE
               WHEN id = 'legacy-kit-running-privacy-job' THEN 'preserved-owner-host'
               ELSE NULL
             END
         WHERE id IN ('legacy-kit-privacy-job', 'legacy-kit-running-privacy-job')`
      );
      await applyMigrations(client, [16, 17, 18, 19, 20, 21]);
      const sessionGenerations = await client.query<{
        session_count: string;
        generation_count: string;
      }>(
        `SELECT COUNT(*)::text AS session_count,
                COUNT(DISTINCT session_generation)::text AS generation_count
         FROM sessions`
      );
      expect(Number(sessionGenerations.rows[0]?.session_count)).toBeGreaterThan(0);
      expect(sessionGenerations.rows[0]?.generation_count).toBe(
        sessionGenerations.rows[0]?.session_count
      );
      const insertedAfterGenerationMigration = await client.query<{ generation: string }>(
        `INSERT INTO sessions (id, cli)
         VALUES ('post-generation-migration', 'claude')
         RETURNING session_generation AS generation`
      );
      expect(insertedAfterGenerationMigration.rows[0]?.generation).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      const artifactProvenance = await client.query<{
        id: string;
        owner_hostname: string | null;
        mcp_artifact_scope: string | null;
      }>(
        `SELECT id, owner_hostname, mcp_artifact_scope
         FROM jobs
         WHERE id IN ('legacy-kit-privacy-job', 'legacy-kit-running-privacy-job')
         ORDER BY id`
      );
      expect(artifactProvenance.rows).toEqual([
        {
          id: "legacy-kit-privacy-job",
          owner_hostname: "legacy-owner-host",
          mcp_artifact_scope: null,
        },
        {
          id: "legacy-kit-running-privacy-job",
          owner_hostname: "preserved-owner-host",
          mcp_artifact_scope: null,
        },
      ]);
      const compressionColumn = await client.query<{
        data_type: string;
        is_nullable: string;
      }>(
        `SELECT data_type, is_nullable
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'jobs'
           AND column_name = 'compress_response'`
      );
      expect(compressionColumn.rows).toEqual([{ data_type: "boolean", is_nullable: "YES" }]);
      const rows = await client.query<{
        id: string;
        request_key: string;
        args_json: string;
        stdout: string | null;
        stderr: string | null;
        error: string | null;
        payload_json: string | null;
        kit_terminal_metadata_json: string | null;
      }>(
        `SELECT id, request_key, args_json, stdout, stderr, error, payload_json, kit_terminal_metadata_json
         FROM jobs
         WHERE id IN (
           'legacy-kit-privacy-job',
           'legacy-kit-completed-privacy-job',
           'legacy-kit-queued-privacy-job',
           'legacy-kit-running-privacy-job',
           'legacy-ordinary-privacy-job'
         )`
      );
      const rowById = new Map(rows.rows.map(row => [row.id, row]));
      expect(rowById.get("legacy-kit-privacy-job")).toEqual({
        id: "legacy-kit-privacy-job",
        request_key: "kit:legacy-kit-privacy-job",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: "Personal Agent Config Kit provider execution failed; detailed output is withheld",
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(rowById.get("legacy-kit-completed-privacy-job")).toEqual({
        id: "legacy-kit-completed-privacy-job",
        request_key: "kit:legacy-kit-completed-privacy-job",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: null,
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(rowById.get("legacy-kit-queued-privacy-job")).toEqual({
        id: "legacy-kit-queued-privacy-job",
        request_key: "kit:legacy-kit-queued-privacy-job",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: null,
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(rowById.get("legacy-kit-running-privacy-job")).toEqual({
        id: "legacy-kit-running-privacy-job",
        request_key: "kit:legacy-kit-running-privacy-job",
        args_json: JSON.stringify(["[personal-config-kit arguments redacted]"]),
        stdout: "",
        stderr: "",
        error: null,
        payload_json: null,
        kit_terminal_metadata_json: null,
      });
      expect(rowById.get("legacy-ordinary-privacy-job")).toEqual({
        id: "legacy-ordinary-privacy-job",
        request_key: "legacy-ordinary-privacy-key",
        args_json: JSON.stringify(["-p", privateContext]),
        stdout: privateContext,
        stderr: privateContext,
        error: privateContext,
        payload_json: privateContext,
        kit_terminal_metadata_json: null,
      });
      const kitRows = [
        rowById.get("legacy-kit-privacy-job"),
        rowById.get("legacy-kit-completed-privacy-job"),
        rowById.get("legacy-kit-queued-privacy-job"),
        rowById.get("legacy-kit-running-privacy-job"),
      ];
      expect(JSON.stringify(kitRows)).not.toContain(privateContext);
      expect(JSON.stringify(kitRows)).not.toContain("b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2");
      const migratedKitSession = await client.query<{ metadata: { kit?: KitSessionBinding } }>(
        "SELECT metadata FROM sessions WHERE id = 'legacy-resumable'"
      );
      expect(migratedKitSession.rows[0]?.metadata.kit?.nativeSessionId).toBeNull();
      expect(migratedKitSession.rows[0]?.metadata.kit?.resumeEligible).toBe(false);
      const malformedSessions = await client.query<{
        id: string;
        metadata: {
          kit?: { nativeSessionId?: unknown; resumeEligible?: unknown; attempt?: unknown };
        };
      }>("SELECT id, metadata FROM sessions WHERE id = ANY($1::text[]) ORDER BY id", [
        malformedKitAttempts.map(({ id }) => id),
      ]);
      expect(malformedSessions.rows).toEqual([
        {
          id: "legacy-malformed-attempt-array",
          metadata: { kit: { nativeSessionId: null, resumeEligible: false, attempt: [] } },
        },
        {
          id: "legacy-malformed-attempt-null",
          metadata: { kit: { nativeSessionId: null, resumeEligible: false, attempt: null } },
        },
        {
          id: "legacy-malformed-attempt-string",
          metadata: {
            kit: { nativeSessionId: null, resumeEligible: false, attempt: "legacy-attempt" },
          },
        },
      ]);

      // The normal runner never replays a recorded migration, but the SQL is
      // intentionally safe for an operator's manual replay. A clean Kit row
      // must not be rewritten just because migration 013 is evaluated again.
      const beforeReplay = await client.query<{ id: string; row_version: string }>(
        `SELECT id, ctid::text AS row_version
         FROM jobs
         WHERE kit_execution_json IS NOT NULL
         ORDER BY id`
      );
      await applyMigrations(client, [13]);
      const afterReplay = await client.query<{ id: string; row_version: string }>(
        `SELECT id, ctid::text AS row_version
         FROM jobs
         WHERE kit_execution_json IS NOT NULL
         ORDER BY id`
      );
      expect(afterReplay.rows).toEqual(beforeReplay.rows);

      const migrations = await client.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version"
      );
      expect(migrations.rows.map(row => row.version)).toEqual(ALL_MIGRATION_VERSIONS);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("keeps 002/003 immutable while forward-repairing a legacy UUID schema", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `legacy_uuid_${randomUUID().replaceAll("-", "")}`;
    const id = randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        INSERT INTO schema_migrations (version, name)
        VALUES (1, '001_initial_schema');
        CREATE TABLE sessions (
          id UUID PRIMARY KEY,
          cli VARCHAR(32) NOT NULL,
          description TEXT,
          metadata JSONB DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE active_sessions (
          cli VARCHAR(32) PRIMARY KEY,
          session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE VIEW session_summary AS
        SELECT s.id, s.cli, s.description, s.created_at, s.last_used_at,
               (a.session_id IS NOT NULL) AS is_active
        FROM sessions s
        LEFT JOIN active_sessions a ON s.id = a.session_id;
        CREATE FUNCTION cleanup_expired_sessions(max_age_days INTEGER DEFAULT 30)
        RETURNS INTEGER AS $$
        DECLARE
          deleted_count INTEGER;
        BEGIN
          DELETE FROM sessions
          WHERE last_used_at < NOW() - INTERVAL '1 day' * max_age_days
            AND id NOT IN (SELECT session_id FROM active_sessions WHERE session_id IS NOT NULL);
          GET DIAGNOSTICS deleted_count = ROW_COUNT;
          RETURN deleted_count;
        END;
        $$ LANGUAGE plpgsql;
      `);
      await client.query(
        "INSERT INTO sessions (id, cli, description) VALUES ($1, 'claude', 'legacy UUID')",
        [id]
      );
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        id,
      ]);

      // Historical files remain byte-stable. Version 003's original type
      // alteration is handled by the runner's transaction-local view wrapper;
      // version 018 repairs this non-public legacy UUID schema.
      expect(migrationSql(2)).toContain("table_schema = 'public'");
      expect(migrationSql(3)).toContain("ALTER TABLE sessions ALTER COLUMN cli TYPE VARCHAR(32)");

      const { stderr } = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      });
      expect(stderr).toContain("Running 20 pending migration(s)");

      const columns = await client.query<{ table_name: string; udt_name: string }>(`
        SELECT table_name, udt_name
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'sessions' AND column_name = 'id')
               OR (table_name = 'active_sessions' AND column_name = 'session_id'))
        ORDER BY table_name
      `);
      expect(columns.rows).toEqual([
        { table_name: "active_sessions", udt_name: "text" },
        { table_name: "sessions", udt_name: "text" },
      ]);
      expect((await client.query("SELECT id, is_active FROM session_summary")).rows).toEqual([
        { id, is_active: true },
      ]);
      expect((await client.query("SELECT cleanup_expired_sessions()")).rows).toEqual([
        { cleanup_expired_sessions: 0 },
      ]);
      const migrations = await client.query<{ version: number; checksumSha256: string | null }>(
        `SELECT version,
                checksum_sha256 AS "checksumSha256"
           FROM schema_migrations
          ORDER BY version`
      );
      expect(migrations.rows).toEqual(
        ALL_MIGRATION_VERSIONS.map(version => ({
          version,
          checksumSha256: version === 1 ? null : migrationChecksum(version),
        }))
      );
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("repairs a UUID-residual recorded 002/003 schema before migration 006", async () => {
    const { pool } = await setupTestDatabase();
    const schema = "recorded_intermediate_uuid_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query("CREATE SCHEMA " + quoteIdentifier(schema));
      schemaCreated = true;
      client = await pool.connect();
      await client.query("SET search_path TO " + quoteIdentifier(schema));
      await client.query(
        [
          "CREATE TABLE schema_migrations (",
          "  version INTEGER PRIMARY KEY,",
          "  name VARCHAR(255) NOT NULL,",
          "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
          ");",
          "CREATE TABLE sessions (",
          "  id UUID PRIMARY KEY,",
          "  cli VARCHAR(32) NOT NULL,",
          "  description TEXT,",
          "  metadata JSONB DEFAULT '{}'::JSONB,",
          "  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
          "  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
          "  owner_principal TEXT",
          ");",
          "CREATE TABLE active_sessions (",
          "  cli VARCHAR(32) PRIMARY KEY,",
          "  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,",
          "  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
          ");",
          "CREATE VIEW session_summary AS",
          "SELECT s.id, s.cli, s.description, s.created_at, s.last_used_at,",
          "       (a.session_id IS NOT NULL) AS is_active",
          "FROM sessions s LEFT JOIN active_sessions a ON s.id = a.session_id;",
        ].join("\n")
      );
      for (const version of [1, 2, 3, 4, 5]) {
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          version,
          migrationRecordName(version),
        ]);
      }
      await client.query("INSERT INTO sessions (id, cli) VALUES ($1, 'claude')", [id]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        id,
      ]);

      const { stderr } = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      });
      expect(stderr).toContain(
        "Repaired recorded legacy session schema before applying pending migrations"
      );
      expect(stderr).toContain("Running 16 pending migration(s)");

      const columns = await client.query<{ table_name: string; udt_name: string }>(
        [
          "SELECT table_name, udt_name",
          "FROM information_schema.columns",
          "WHERE table_schema = current_schema()",
          "  AND ((table_name = 'sessions' AND column_name = 'id')",
          "       OR (table_name = 'active_sessions' AND column_name = 'session_id'))",
          "ORDER BY table_name",
        ].join("\n")
      );
      expect(columns.rows).toEqual([
        { table_name: "active_sessions", udt_name: "text" },
        { table_name: "sessions", udt_name: "text" },
      ]);
      expect((await client.query("SELECT id, is_active FROM session_summary")).rows).toEqual([
        { id, is_active: true },
      ]);
      expect(
        (await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows.map(
          row => row.version
        )
      ).toEqual(ALL_MIGRATION_VERSIONS);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    }
  });

  it("repairs a mixed TEXT and UUID recorded 002/003 schema before migration 006", async () => {
    const { pool } = await setupTestDatabase();
    const schema = "recorded_intermediate_mixed_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query("CREATE SCHEMA " + quoteIdentifier(schema));
      schemaCreated = true;
      client = await pool.connect();
      await client.query("SET search_path TO " + quoteIdentifier(schema));
      await client.query(
        [
          "CREATE TABLE schema_migrations (",
          "  version INTEGER PRIMARY KEY,",
          "  name VARCHAR(255) NOT NULL,",
          "  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
          ");",
          "CREATE TABLE sessions (",
          "  id TEXT PRIMARY KEY,",
          "  cli VARCHAR(32) NOT NULL,",
          "  description TEXT,",
          "  metadata JSONB DEFAULT '{}'::JSONB,",
          "  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
          "  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),",
          "  owner_principal TEXT",
          ");",
          "CREATE TABLE active_sessions (",
          "  cli VARCHAR(32) PRIMARY KEY,",
          "  session_id UUID,",
          "  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()",
          ");",
        ].join("\n")
      );
      for (const version of [1, 2, 3, 4, 5]) {
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          version,
          migrationRecordName(version),
        ]);
      }
      await client.query("INSERT INTO sessions (id, cli) VALUES ($1, 'claude')", [id]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        id,
      ]);

      const { stderr } = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      });
      expect(stderr).toContain(
        "Repaired recorded legacy session schema before applying pending migrations"
      );

      const columns = await client.query<{ table_name: string; udt_name: string }>(
        [
          "SELECT table_name, udt_name",
          "FROM information_schema.columns",
          "WHERE table_schema = current_schema()",
          "  AND ((table_name = 'sessions' AND column_name = 'id')",
          "       OR (table_name = 'active_sessions' AND column_name = 'session_id'))",
          "ORDER BY table_name",
        ].join("\n")
      );
      expect(columns.rows).toEqual([
        { table_name: "active_sessions", udt_name: "text" },
        { table_name: "sessions", udt_name: "text" },
      ]);
      expect((await client.query("SELECT id, is_active FROM session_summary")).rows).toEqual([
        { id, is_active: true },
      ]);
      await expectCanonicalActiveSessionForeignKey(client);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    }
  });

  it("repairs a mixed TEXT and UUID legacy session shape with forward migration 018", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `recorded_legacy_mixed_${randomUUID().replaceAll("-", "")}`;
    const id = randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await client.query(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cli TEXT NOT NULL,
          description TEXT,
          metadata JSONB DEFAULT '{}'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE TABLE active_sessions (
          cli TEXT PRIMARY KEY,
          session_id UUID,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      for (const version of ALL_MIGRATION_VERSIONS.filter(version => version < 18)) {
        await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [
          version,
          migrationRecordName(version),
        ]);
      }
      await client.query("INSERT INTO sessions (id, cli) VALUES ($1, 'claude')", [id]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        id,
      ]);

      await applyMigrations(client, [18]);

      const columns = await client.query<{
        table_name: string;
        column_name: string;
        data_type: string;
        character_maximum_length: number | null;
      }>(`
        SELECT table_name, column_name, data_type, character_maximum_length
        FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND ((table_name = 'sessions' AND column_name IN ('id', 'cli'))
               OR (table_name = 'active_sessions' AND column_name IN ('session_id', 'cli')))
        ORDER BY table_name, column_name
      `);
      expect(columns.rows).toEqual([
        {
          table_name: "active_sessions",
          column_name: "cli",
          data_type: "character varying",
          character_maximum_length: 32,
        },
        {
          table_name: "active_sessions",
          column_name: "session_id",
          data_type: "text",
          character_maximum_length: null,
        },
        {
          table_name: "sessions",
          column_name: "cli",
          data_type: "character varying",
          character_maximum_length: 32,
        },
        {
          table_name: "sessions",
          column_name: "id",
          data_type: "text",
          character_maximum_length: null,
        },
      ]);
      expect((await client.query("SELECT id, is_active FROM session_summary")).rows).toEqual([
        { id, is_active: true },
      ]);
      await expectCanonicalActiveSessionForeignKey(client);
      expect(
        (await client.query("SELECT version FROM schema_migrations ORDER BY version")).rows
      ).toEqual(
        ALL_MIGRATION_VERSIONS.filter(version => version <= 18).map(version => ({ version }))
      );
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  it("repairs a canonical recorded 002/003 schema when its active-session foreign key is missing", async () => {
    const { pool } = await setupTestDatabase();
    const schema = "recorded_intermediate_missing_fk_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query("CREATE SCHEMA " + quoteIdentifier(schema));
      schemaCreated = true;
      client = await pool.connect();
      await client.query("SET search_path TO " + quoteIdentifier(schema));
      await createSessionRepairSchema(client);
      await recordMigrationReceipts(client, [1, 2, 3, 4, 5]);
      await client.query("INSERT INTO sessions (id, cli) VALUES ($1, 'claude')", [id]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        id,
      ]);

      const { stderr } = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      });
      expect(stderr).toContain(
        "Repaired recorded legacy session schema before applying pending migrations"
      );
      await expectCanonicalActiveSessionForeignKey(client);
      await client.query("DELETE FROM sessions WHERE id = $1", [id]);
      expect((await client.query("SELECT session_id FROM active_sessions")).rows).toEqual([]);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    }
  });

  it("repairs a canonical missing active-session foreign key with forward migration 018", async () => {
    const { pool } = await setupTestDatabase();
    const schema = "recorded_legacy_missing_fk_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query("CREATE SCHEMA " + quoteIdentifier(schema));
      schemaCreated = true;
      client = await pool.connect();
      await client.query("SET search_path TO " + quoteIdentifier(schema));
      await createSessionRepairSchema(client);
      await recordMigrationReceipts(
        client,
        ALL_MIGRATION_VERSIONS.filter(version => version < 18)
      );
      await client.query("INSERT INTO sessions (id, cli) VALUES ($1, 'claude')", [id]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        id,
      ]);

      await applyMigrations(client, [18]);

      await expectCanonicalActiveSessionForeignKey(client);
      await client.query("DELETE FROM sessions WHERE id = $1", [id]);
      expect((await client.query("SELECT session_id FROM active_sessions")).rows).toEqual([]);
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version = 18")).rows
      ).toEqual([{ version: 18 }]);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    }
  });

  it("fails closed for a recorded 002/003 schema whose session_id foreign key targets another sessions column", async () => {
    const { pool } = await setupTestDatabase();
    const schema = "recorded_intermediate_alternate_fk_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    const alternateId = "alternate-" + randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query("CREATE SCHEMA " + quoteIdentifier(schema));
      schemaCreated = true;
      client = await pool.connect();
      await client.query("SET search_path TO " + quoteIdentifier(schema));
      await createSessionRepairSchema(client, {
        sessionsExtraColumnSql: "alternate_id TEXT UNIQUE NOT NULL",
        activeSessionForeignKeySql:
          "CONSTRAINT active_sessions_alternate_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(alternate_id) ON DELETE CASCADE",
      });
      await recordMigrationReceipts(client, [1, 2, 3, 4, 5]);
      await client.query("INSERT INTO sessions (id, cli, alternate_id) VALUES ($1, 'claude', $2)", [
        id,
        alternateId,
      ]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        alternateId,
      ]);

      const failure = await execFileAsync(process.execPath, ["dist/migrate.js"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: schemaScopedDsn(schema) },
      }).catch(error => error as { stderr?: string });

      expect(failure).toMatchObject({
        stderr: expect.stringContaining(
          'active_sessions.session_id foreign key "active_sessions_alternate_id_fkey" does not reference sessions.id'
        ),
      });
      expect(await activeSessionForeignKeys(client)).toEqual([
        {
          conname: "active_sessions_alternate_id_fkey",
          definition:
            "FOREIGN KEY (session_id) REFERENCES sessions(alternate_id) ON DELETE CASCADE",
          convalidated: true,
        },
      ]);
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version = 6")).rows
      ).toEqual([]);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    }
  });

  it("fails closed for a forward migration 018 schema whose session_id foreign key targets another sessions column", async () => {
    const { pool } = await setupTestDatabase();
    const schema = "recorded_legacy_alternate_fk_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    const alternateId = "alternate-" + randomUUID();
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query("CREATE SCHEMA " + quoteIdentifier(schema));
      schemaCreated = true;
      client = await pool.connect();
      await client.query("SET search_path TO " + quoteIdentifier(schema));
      await createSessionRepairSchema(client, {
        sessionsExtraColumnSql: "alternate_id TEXT UNIQUE NOT NULL",
        activeSessionForeignKeySql:
          "CONSTRAINT active_sessions_alternate_id_fkey FOREIGN KEY (session_id) REFERENCES sessions(alternate_id) ON DELETE CASCADE",
      });
      await recordMigrationReceipts(
        client,
        ALL_MIGRATION_VERSIONS.filter(version => version < 18)
      );
      await client.query("INSERT INTO sessions (id, cli, alternate_id) VALUES ($1, 'claude', $2)", [
        id,
        alternateId,
      ]);
      await client.query("INSERT INTO active_sessions (cli, session_id) VALUES ('claude', $1)", [
        alternateId,
      ]);

      await expect(applyMigrations(client, [18])).rejects.toThrow(
        'active_sessions.session_id foreign key "active_sessions_alternate_id_fkey" does not reference sessions.id'
      );
      expect(await activeSessionForeignKeys(client)).toEqual([
        {
          conname: "active_sessions_alternate_id_fkey",
          definition:
            "FOREIGN KEY (session_id) REFERENCES sessions(alternate_id) ON DELETE CASCADE",
          convalidated: true,
        },
      ]);
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version = 18")).rows
      ).toEqual([]);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query("DROP SCHEMA IF EXISTS " + quoteIdentifier(schema) + " CASCADE");
    }
  });

  it("leaves a healthy summary view intact when migration 018 has nothing to repair", async () => {
    const { pool } = await setupTestDatabase();
    const schema = `healthy_summary_${randomUUID().replaceAll("-", "")}`;
    let client: PoolClient | null = null;
    let schemaCreated = false;

    try {
      await pool.query(`CREATE SCHEMA ${quoteIdentifier(schema)}`);
      schemaCreated = true;
      client = await pool.connect();
      await client.query(`SET search_path TO ${quoteIdentifier(schema)}`);
      await applyMigrations(
        client,
        ALL_MIGRATION_VERSIONS.filter(version => version < 18)
      );
      await client.query(
        "CREATE VIEW session_summary_consumer AS SELECT id, is_active FROM session_summary"
      );

      // A DROP/CREATE repair would fail because this consumer depends on the
      // canonical view. Healthy current schemas must only record version 018.
      await applyMigrations(client, [18]);

      expect(
        (await client.query("SELECT to_regclass('session_summary_consumer') AS relation")).rows
      ).toEqual([{ relation: "session_summary_consumer" }]);
      expect(
        (await client.query("SELECT version FROM schema_migrations WHERE version = 18")).rows
      ).toEqual([{ version: 18 }]);
    } finally {
      if (client) {
        await client.query("RESET search_path");
        client.release();
      }
      if (schemaCreated)
        await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdentifier(schema)} CASCADE`);
    }
  });

  //──────────────────────────────────────────────────────────────────────────
  // Migration Tests
  //──────────────────────────────────────────────────────────────────────────

  it("should migrate sessions from file to PostgreSQL", async () => {
    // Create file-based sessions
    const fileManager = new FileSessionManager(testFilePath);
    const session1 = fileManager.createSession("claude", "Claude Session");
    const session2 = fileManager.createSession("codex", "Codex Session");
    const session3 = fileManager.createSession("gemini", "Gemini Session");

    // Run migration
    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toEqual([]);

    // Verify sessions in PostgreSQL
    const sessions = await pgManager.listSessions();
    expect(sessions.length).toBe(3);

    const sessionIds = sessions.map(s => s.id);
    expect(sessionIds).toContain(session1.id);
    expect(sessionIds).toContain(session2.id);
    expect(sessionIds).toContain(session3.id);
  });

  it("should preserve session descriptions", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Custom Description");

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.description).toBe("Custom Description");
  });

  it("should migrate session metadata", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Session with Metadata");
    fileManager.updateSessionMetadata(session.id, {
      key1: "value1",
      key2: 42,
      nested: { foo: "bar" },
    });

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.metadata).toEqual({
      key1: "value1",
      key2: 42,
      nested: { foo: "bar" },
    });
  });

  it("should restore active sessions", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const claudeSession = fileManager.createSession("claude", "Active Claude");
    const codexSession = fileManager.createSession("codex", "Active Codex");
    const grokApiSession = fileManager.createSession("grok-api", "Active Grok API");

    fileManager.setActiveSession("claude", claudeSession.id);
    fileManager.setActiveSession("codex", codexSession.id);
    fileManager.setActiveSession("grok-api", grokApiSession.id);

    await migrateFromFile(testFilePath, pgManager);

    const activeClaudeSession = await pgManager.getActiveSession("claude");
    const activeCodexSession = await pgManager.getActiveSession("codex");
    const activeGrokApiSession = await pgManager.getActiveSession("grok-api");

    expect(activeClaudeSession?.id).toBe(claudeSession.id);
    expect(activeCodexSession?.id).toBe(codexSession.id);
    expect(activeGrokApiSession?.id).toBe(grokApiSession.id);
  });

  it("fails closed rather than replacing an active pointer selected by live traffic", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const source = fileManager.createSession("claude", "Source active session");
    fileManager.setActiveSession("claude", source.id);

    const live = await pgManager.createSession("claude", "Live target session");
    expect((await pgManager.getActiveSession("claude"))?.id).toBe(live.id);

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      "Session migration failed before completion; transaction rolled back",
    ]);
    expect((await pgManager.getActiveSession("claude"))?.id).toBe(live.id);
    expect(await pgManager.getSession(source.id)).toBeNull();
  });

  it("migrates Kit bindings, owner-scoped active pointers, and release pins", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const binding = kitBinding();
    const { active, forcedNew } = await runWithRequestContext(requestContext("alice"), () => {
      const active = fileManager.createKitSession("claude", binding, "Alice active Kit");
      const forcedNew = fileManager.createKitSession("claude", binding, "Alice forced Kit");
      return { active, forcedNew };
    });

    await migrateFromFile(testFilePath, pgManager);

    const migratedActive = await runWithRequestContext(requestContext("alice"), () =>
      pgManager.getActiveKitSession("claude", binding.execution.scopeRoot, binding.execution)
    );
    expect(migratedActive?.id).toBe(active.id);
    expect(migratedActive?.ownerPrincipal).toBe("alice");
    expect((await pgManager.getSession(forcedNew.id))?.metadata?.kit).toEqual({
      ...binding,
      nativeSessionId: null,
      resumeEligible: false,
    });
    expect(
      await runWithRequestContext(requestContext("bob"), () =>
        pgManager.getActiveKitSession("claude", binding.execution.scopeRoot, binding.execution)
      )
    ).toBeNull();
    expect(await pgManager.getPinnedKitReleaseIds()).toEqual([]);
  });

  it("fails closed rather than replacing a live Kit active pointer", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const binding = kitBinding({
      execution: kitExecution({ contextIdentity: "live-kit-pointer-conflict" }),
    });
    const source = await runWithRequestContext(requestContext("alice"), () =>
      fileManager.createKitSession("codex", binding, "Source Kit session")
    );
    const live = await runWithRequestContext(requestContext("alice"), () =>
      pgManager.createKitSession("codex", binding, "Live Kit session")
    );

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual([
      "Session migration failed before completion; transaction rolled back",
    ]);
    await runWithRequestContext(requestContext("alice"), async () => {
      const active = await pgManager.getActiveKitSession(
        "codex",
        binding.execution.scopeRoot,
        binding.execution
      );
      expect(active?.id).toBe(live.id);
    });
    expect(await pgManager.getSession(source.id)).toBeNull();
  });

  it("does not invent a Kit active pointer when the source file has none", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const binding = kitBinding({
      execution: kitExecution({ contextIdentity: "no-source-pointer" }),
    });
    const source = fileManager.createKitSession("codex", binding);
    const fileData = JSON.parse(readFileSync(testFilePath, "utf-8"));
    delete fileData.activeKitSession;
    writeFileSync(testFilePath, JSON.stringify(fileData, null, 2));

    await migrateFromFile(testFilePath, pgManager);

    expect(await pgManager.getSession(source.id)).not.toBeNull();
    expect(
      await pgManager.getActiveKitSession("codex", binding.execution.scopeRoot, binding.execution)
    ).toBeNull();
  });

  it("migrates exact stamped legacy Kit pointer keys into the canonical pointer slot", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const binding = kitBinding({
      execution: kitExecution({ contextIdentity: "legacy-stamped-pointer-import" }),
    });
    const source = await runWithRequestContext(requestContext("alice"), () =>
      fileManager.createKitSession("claude", binding)
    );
    const fileData = JSON.parse(readFileSync(testFilePath, "utf-8")) as {
      activeKitSession: Record<string, Record<string, string>>;
    };
    delete fileData.activeKitSession.claude[
      kitActiveSessionKey(binding.execution.scopeRoot, binding.execution, "alice")
    ];
    fileData.activeKitSession.claude[
      kitScopeKey(binding.execution.scopeRoot, binding.execution.configStamp, "alice")
    ] = source.id;
    writeFileSync(testFilePath, JSON.stringify(fileData, null, 2));

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result).toMatchObject({ migrated: 1, failed: 0 });
    const active = await runWithRequestContext(requestContext("alice"), () =>
      pgManager.getActiveKitSession("claude", binding.execution.scopeRoot, binding.execution)
    );
    expect(active?.id).toBe(source.id);
  });

  it("redacts malformed Kit pointer keys from migration diagnostics", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const binding = kitBinding({
      execution: kitExecution({ contextIdentity: "migration-pointer-redaction" }),
    });
    const session = fileManager.createKitSession("claude", binding);
    const privatePointerKey = "PRIVATE_MIGRATION_KIT_POINTER_/home/operator/token";
    const fileData = JSON.parse(readFileSync(testFilePath, "utf-8")) as {
      activeKitSession: Record<string, Record<string, string>>;
    };
    fileData.activeKitSession.claude = { [privatePointerKey]: session.id };
    writeFileSync(testFilePath, JSON.stringify(fileData, null, 2));

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(["Skipped invalid Personal Agent Config Kit pointer"]);
    expect(JSON.stringify(result.errors)).not.toContain(privatePointerKey);
  });

  it("should handle empty sessions file", async () => {
    const emptyStorage: SessionStorage = {
      sessions: {},
      activeSession: Object.fromEntries(PROVIDER_TYPES.map(provider => [provider, null])) as Record<
        ProviderType,
        string | null
      >,
    };
    writeFileSync(testFilePath, JSON.stringify(emptyStorage, null, 2));

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("should handle large number of sessions", async () => {
    const fileManager = new FileSessionManager(testFilePath);

    // Create 100 sessions
    const sessionIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      const cli = PROVIDER_TYPES[i % PROVIDER_TYPES.length];
      const session = fileManager.createSession(cli, `Session ${i}`);
      sessionIds.push(session.id);
    }

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(100);
    expect(result.failed).toBe(0);

    const sessions = await pgManager.listSessions();
    expect(sessions.length).toBe(100);
  });

  it("should report failed migrations", async () => {
    // A malformed source must be rejected before the target transaction starts.
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Valid Session");

    // Manually corrupt the file by adding a duplicate ID
    const fileData = JSON.parse(require("fs").readFileSync(testFilePath, "utf-8"));
    const firstId = Object.keys(fileData.sessions)[0];
    fileData.sessions[firstId + "-duplicate"] = {
      ...fileData.sessions[firstId],
      id: firstId, // Same ID, will cause conflict
    };
    writeFileSync(testFilePath, JSON.stringify(fileData, null, 2));

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors).toEqual(["Skipped invalid session record"]);
    expect(await pgManager.getSession(session.id)).toBeNull();
  });

  it("rolls back every source write when an existing target session conflicts", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const first = fileManager.createSession("claude", "First source session");
    const conflicting = fileManager.createSession("codex", "Source conflict session");

    await pgManager.createSession("codex", "Different target session", conflicting.id);

    const result = await migrateFromFile(testFilePath, pgManager);

    expect(result.migrated).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.errors).toEqual([
      "Session migration failed before completion; transaction rolled back",
    ]);
    expect(await pgManager.getSession(first.id)).toBeNull();
    expect((await pgManager.getSession(conflicting.id))?.description).toBe(
      "Different target session"
    );
  });

  it("should preserve timestamps", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "Timestamped Session");

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    expect(migrated?.createdAt).toBeDefined();
    expect(migrated?.lastUsedAt).toBeDefined();
  });

  it("should handle sessions for all provider types", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const claudeSession = fileManager.createSession("claude", "Claude");
    const codexSession = fileManager.createSession("codex", "Codex");
    const geminiSession = fileManager.createSession("gemini", "Gemini");
    const grokSession = fileManager.createSession("grok", "Grok");
    const mistralSession = fileManager.createSession("mistral", "Mistral");
    const grokApiSession = fileManager.createSession("grok-api", "Grok API");

    await migrateFromFile(testFilePath, pgManager);

    expect(await pgManager.getSession(claudeSession.id)).not.toBeNull();
    expect(await pgManager.getSession(codexSession.id)).not.toBeNull();
    expect(await pgManager.getSession(geminiSession.id)).not.toBeNull();
    expect(await pgManager.getSession(grokSession.id)).not.toBeNull();
    expect(await pgManager.getSession(mistralSession.id)).not.toBeNull();
    expect(await pgManager.getSession(grokApiSession.id)).not.toBeNull();

    const claudeSessions = await pgManager.listSessions("claude");
    const codexSessions = await pgManager.listSessions("codex");
    const geminiSessions = await pgManager.listSessions("gemini");
    const grokSessions = await pgManager.listSessions("grok");
    const mistralSessions = await pgManager.listSessions("mistral");
    const grokApiSessions = await pgManager.listSessions("grok-api");

    expect(claudeSessions.length).toBe(1);
    expect(codexSessions.length).toBe(1);
    expect(geminiSessions.length).toBe(1);
    expect(grokSessions.length).toBe(1);
    expect(mistralSessions.length).toBe(1);
    expect(grokApiSessions.length).toBe(1);
  });

  it("should be idempotent when run twice", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const claude = fileManager.createSession("claude", "Session 1");
    const codex = fileManager.createSession("codex", "Session 2");
    fileManager.setActiveSession("claude", claude.id);
    fileManager.setActiveSession("codex", codex.id);

    // First migration
    const result1 = await migrateFromFile(testFilePath, pgManager);
    expect(result1.migrated).toBe(2);

    // An exact replay is a successful no-op, including its active pointers.
    const result2 = await migrateFromFile(testFilePath, pgManager);
    expect(result2.migrated).toBe(0);
    expect(result2.failed).toBe(0);
    expect(result2.errors).toEqual([]);
    expect((await pgManager.getActiveSession("claude"))?.id).toBe(claude.id);
    expect((await pgManager.getActiveSession("codex"))?.id).toBe(codex.id);
  });

  //──────────────────────────────────────────────────────────────────────────
  // Error Handling
  //──────────────────────────────────────────────────────────────────────────

  it("should throw error for non-existent file", async () => {
    const nonExistentPath = join(testDir, "non-existent.json");

    await expect(migrateFromFile(nonExistentPath, pgManager)).rejects.toThrow();
  });

  it("should throw error for malformed JSON", async () => {
    writeFileSync(testFilePath, "{ invalid json ");

    await expect(migrateFromFile(testFilePath, pgManager)).rejects.toThrow();
  });

  it("should handle sessions without metadata", async () => {
    const fileManager = new FileSessionManager(testFilePath);
    const session = fileManager.createSession("claude", "No Metadata Session");

    await migrateFromFile(testFilePath, pgManager);

    const migrated = await pgManager.getSession(session.id);
    // The PostgreSQL backend represents "no metadata" as the column default
    // (`metadata JSONB DEFAULT '{}'`), so a migrated session with no file-side
    // metadata round-trips as an empty object rather than `undefined` (the file
    // backend's representation). Either way it carries no caller metadata.
    expect(migrated?.metadata).toEqual({});
  });
});
