#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const rootDirectory = path.resolve(scriptDirectory, "..");
const migrationDirectory = path.join(rootDirectory, "migrations");
const schemaContractPath = path.join(rootDirectory, "dist", "postgres-job-store-schema.js");

function fail(message) {
  throw new Error(`PostgreSQL migration contract failed: ${message}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normaliseSql(sql) {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Require every contiguous migration in the repository to be included in the
 * npm package. A consumer can apply an older migration before reaching the
 * current runtime schema, so packaging only the latest additive migrations is
 * insufficient.
 */
export function assertPackagedMigrations(migrations, packedFiles) {
  for (const migration of migrations) {
    const packagedPath = path.posix.join("migrations", migration.filename);
    if (!packedFiles.has(packagedPath)) {
      fail(`${packagedPath} is absent from the npm package`);
    }
  }
}

export function assertImmutableMigrationChecksums(migrationSqlByFilename, immutableChecksums) {
  for (const [filename, expectedChecksum] of Object.entries(immutableChecksums)) {
    const sql = migrationSqlByFilename.get(filename);
    if (typeof sql !== "string") {
      fail(`published migration ${filename} is absent from migrations/`);
    }
    const actualChecksum = createHash("sha256").update(sql, "utf8").digest("hex");
    if (actualChecksum !== expectedChecksum) {
      fail(`${filename} differs from its published SHA-256 source`);
    }
  }
}

export function assertRequiredColumnsDeclared(migrationSqlByFilename, requiredColumnsByTable) {
  for (const [table, requiredColumns] of Object.entries(requiredColumnsByTable)) {
    const declaredColumns = new Set();
    const escapedTable = escapeRegex(table);
    for (const sql of migrationSqlByFilename.values()) {
      const createTable = new RegExp(
        `CREATE TABLE(?: IF NOT EXISTS)? ${escapedTable}\\s*\\(([\\s\\S]*?)\\);`,
        "gi"
      );
      for (const create of sql.matchAll(createTable)) {
        for (const column of requiredColumns) {
          const columnDefinition = new RegExp(`(?:^|,)\\s*${escapeRegex(column)}\\s+`, "i");
          if (columnDefinition.test(create[1])) declaredColumns.add(column);
        }
      }

      const addColumn = new RegExp(
        `ALTER TABLE(?: IF EXISTS)? ${escapedTable}\\s+ADD COLUMN(?: IF NOT EXISTS)? ([A-Za-z_][A-Za-z0-9_]*)`,
        "gi"
      );
      for (const alter of sql.matchAll(addColumn)) declaredColumns.add(alter[1].toLowerCase());
    }

    for (const column of requiredColumns) {
      if (!declaredColumns.has(column)) {
        fail(`runtime-required ${table}.${column} has no matching migration declaration`);
      }
    }
  }
}

async function main() {
  if (!existsSync(schemaContractPath)) {
    throw new Error(
      "dist/postgres-job-store-schema.js is missing. Run npm run build before this check."
    );
  }

  const {
    POSTGRES_JOB_STORE_ADDITIVE_MIGRATIONS,
    POSTGRES_IMMUTABLE_MIGRATION_SHA256,
    POSTGRES_JOB_STORE_OUTPUT_PRIVACY_MIGRATION,
    POSTGRES_JOB_STORE_REQUIRED_COLUMNS,
    POSTGRES_SESSION_SUMMARY_REPAIR_MIGRATION,
  } = await import(schemaContractPath);

  const migrations = readdirSync(migrationDirectory)
    .map(filename => {
      const match = filename.match(/^(\d+)_(.+)\.sql$/);
      if (!match) return null;
      return {
        filename,
        version: Number.parseInt(match[1], 10),
        name: match[2],
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.version - right.version);

  if (migrations.length === 0) fail("no SQL migrations were found");

  const migrationSqlByFilename = new Map();
  for (const [index, migration] of migrations.entries()) {
    const expectedVersion = index + 1;
    if (migration.version !== expectedVersion) {
      fail(`expected contiguous version ${expectedVersion}, found ${migration.filename}`);
    }

    const sql = readFileSync(path.join(migrationDirectory, migration.filename), "utf8");
    migrationSqlByFilename.set(migration.filename, sql);
    const receipt = new RegExp(
      `INSERT\\s+INTO\\s+schema_migrations\\s*\\(\\s*version\\s*,\\s*name\\s*\\)\\s*` +
        `VALUES\\s*\\(\\s*${migration.version}\\s*,\\s*'${escapeRegex(
          `${String(migration.version).padStart(3, "0")}_${migration.name}`
        )}'\\s*\\)`,
      "i"
    );
    if (!receipt.test(sql)) {
      fail(`${migration.filename} is missing its matching schema_migrations receipt`);
    }
  }
  assertImmutableMigrationChecksums(migrationSqlByFilename, POSTGRES_IMMUTABLE_MIGRATION_SHA256);

  assertRequiredColumnsDeclared(migrationSqlByFilename, POSTGRES_JOB_STORE_REQUIRED_COLUMNS);

  const requiredMigrations = [
    POSTGRES_JOB_STORE_OUTPUT_PRIVACY_MIGRATION,
    ...POSTGRES_JOB_STORE_ADDITIVE_MIGRATIONS,
    POSTGRES_SESSION_SUMMARY_REPAIR_MIGRATION,
  ];
  for (const migration of requiredMigrations) {
    const sourcePath = path.join(migrationDirectory, migration.filename);
    if (!existsSync(sourcePath)) fail(`required ${migration.filename} is absent from migrations/`);

    const normalised = normaliseSql(migrationSqlByFilename.get(migration.filename));
    for (const fragment of migration.requiredSql) {
      if (!normalised.includes(normaliseSql(fragment))) {
        fail(`${migration.filename} is missing required SQL: ${fragment}`);
      }
    }
    for (const column of migration.columns ?? []) {
      const columnDefinition = new RegExp(
        `ALTER TABLE(?: IF EXISTS)? jobs ADD COLUMN(?: IF NOT EXISTS)? ${escapeRegex(column)}\\b`,
        "i"
      );
      if (!columnDefinition.test(normalised)) {
        fail(`${migration.filename} does not add required jobs.${column}`);
      }
    }
    for (const index of migration.indexes ?? []) {
      const indexDefinition = new RegExp(
        `CREATE INDEX IF NOT EXISTS ${escapeRegex(index)} ON jobs\\b`,
        "i"
      );
      if (!indexDefinition.test(normalised)) {
        fail(`${migration.filename} does not create required ${index}`);
      }
    }
  }

  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: rootDirectory,
      encoding: "utf8",
    })
  );
  const packedFiles = new Set((packed[0]?.files ?? []).map(file => file.path));
  assertPackagedMigrations(migrations, packedFiles);

  console.log(
    `PostgreSQL migration contract passed (${migrations.length} contiguous migrations packed; ${requiredMigrations.length} required runtime migrations verified).`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
