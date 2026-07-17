import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  assertImmutableMigrationChecksums,
  assertPackagedMigrations,
  assertRequiredColumnsDeclared,
} from "../../scripts/verify-postgres-migration-contract.mjs";

const migrations = [
  { filename: "006_personal_config_kit_sessions.sql" },
  { filename: "007_personal_config_kit_job_finalization.sql" },
  { filename: "008_postgres_job_store_schema.sql" },
  { filename: "009_personal_config_kit_session_cleanup.sql" },
  { filename: "010_personal_config_kit_attempt_fences.sql" },
  { filename: "011_personal_config_kit_output_privacy.sql" },
  { filename: "012_async_job_response_compression.sql" },
  { filename: "013_personal_config_kit_request_key_privacy.sql" },
  { filename: "014_personal_config_kit_native_handle_privacy.sql" },
  { filename: "015_async_job_owner_hostname.sql" },
  { filename: "016_async_job_mcp_artifact_cleanup.sql" },
  { filename: "017_async_job_mcp_artifact_scope.sql" },
  { filename: "018_repair_legacy_session_summary_dependencies.sql" },
];

function packagedMigrationPaths(): Set<string> {
  return new Set(migrations.map(migration => `migrations/${migration.filename}`));
}

describe("PostgreSQL migration package contract", () => {
  it("accepts a manifest containing every contiguous migration", () => {
    expect(() => assertPackagedMigrations(migrations, packagedMigrationPaths())).not.toThrow();
  });

  it("rejects an omitted pre-011 migration from the package manifest", () => {
    const packedFiles = packagedMigrationPaths();
    packedFiles.delete("migrations/006_personal_config_kit_sessions.sql");

    expect(() => assertPackagedMigrations(migrations, packedFiles)).toThrow(
      "migrations/006_personal_config_kit_sessions.sql is absent from the npm package"
    );
  });

  it("rejects a source edit to a published migration", () => {
    const filename = "002_session_ids_as_text.sql";
    const publishedSql = "SELECT 1;\n";
    const expectedChecksum = createHash("sha256").update(publishedSql, "utf8").digest("hex");
    const immutableChecksums = { [filename]: expectedChecksum };

    expect(() =>
      assertImmutableMigrationChecksums(new Map([[filename, publishedSql]]), immutableChecksums)
    ).not.toThrow();
    expect(() =>
      assertImmutableMigrationChecksums(new Map([[filename, "SELECT 2;\n"]]), immutableChecksums)
    ).toThrow("002_session_ids_as_text.sql differs from its published SHA-256 source");
  });

  it("checks runtime-required columns for every table, not only jobs", () => {
    const sql = new Map([
      [
        "001.sql",
        `
          CREATE TABLE jobs (id TEXT, status TEXT);
          CREATE TABLE validation_runs (validation_id TEXT);
        `,
      ],
    ]);
    const required = {
      jobs: ["id", "status"],
      validation_runs: ["validation_id", "owner_principal"],
    };

    expect(() => assertRequiredColumnsDeclared(sql, required)).toThrow(
      "runtime-required validation_runs.owner_principal has no matching migration declaration"
    );
  });

  it("accepts required non-jobs columns declared by CREATE TABLE or ALTER TABLE", () => {
    const sql = new Map([
      [
        "001.sql",
        `
          CREATE TABLE jobs (id TEXT);
          CREATE TABLE validation_runs (validation_id TEXT);
          ALTER TABLE validation_runs ADD COLUMN IF NOT EXISTS owner_principal TEXT;
        `,
      ],
    ]);

    expect(() =>
      assertRequiredColumnsDeclared(sql, {
        jobs: ["id"],
        validation_runs: ["validation_id", "owner_principal"],
      })
    ).not.toThrow();
  });
});
