/**
 * Canonical PostgreSQL job-store schema contract.
 *
 * The worker uses these columns for ordinary DML after a migration role has
 * prepared the database. Keep the fresh-migration test and release contract
 * checker tied to this definition so a new runtime field cannot silently ship
 * without its migration.
 */

/**
 * Runner-owned migration-ledger metadata. This is deliberately separate from
 * the job-store runtime catalog: a normal DML-only gateway role does not need
 * to read or alter the migration ledger after an operator has run migrations.
 */
export const POSTGRES_SCHEMA_MIGRATION_LEDGER = {
  columns: ["version", "name", "applied_at", "checksum_sha256"],
  checksumAlgorithm: "sha256",
  checksumColumn: "checksum_sha256",
} as const;

/**
 * SHA-256 digests for migrations that were already published before this
 * release. Release checks reject a source edit instead of silently changing
 * the meaning of an applied migration. New migrations join this list only
 * after their first published release.
 */
export const POSTGRES_IMMUTABLE_MIGRATION_SHA256 = {
  "001_initial_schema.sql": "e17d4b5cf2c9b576224d23294e4aad1ef596aab10c37761932d1d634fd0b8329",
  "002_session_ids_as_text.sql": "febcf51aa2b0465b80be8823f3b80b12f557b4c8139892858730fd58bbc312c0",
  "003_provider_type_sessions.sql":
    "10f85fc80870159a8fb4e75e9daab9bf38af76fcc7a44177998e558b8f483f11",
  "004_session_owner_principal.sql":
    "00df4b73c4a4c00839cd7e22d9e2fb7336ed24b4f2ff8dd3f1e0066f173e3d6d",
  "005_provider_type_open_api_names.sql":
    "7b31c0d4759335ab06177245acc8ac854e360aafd8b77b98df54d217e6b7618a",
} as const;

/**
 * Forward repair for the dependency that historical session migrations 002 and
 * 003 had on the view created by migration 001. The migration runner protects
 * still-pending historical versions, while this migration repairs a database
 * that had already recorded them before the compatibility behavior existed.
 */
export const POSTGRES_SESSION_SUMMARY_REPAIR_MIGRATION = {
  version: 18,
  filename: "018_repair_legacy_session_summary_dependencies.sql",
  requiredSql: [
    "DROP VIEW IF EXISTS session_summary",
    "ALTER TABLE sessions ALTER COLUMN id TYPE TEXT USING id::text",
    "ALTER TABLE sessions ALTER COLUMN cli TYPE VARCHAR(32)",
    "CREATE OR REPLACE VIEW session_summary AS",
  ],
} as const;

export const POSTGRES_JOB_STORE_REQUIRED_COLUMNS = {
  jobs: [
    "id",
    "correlation_id",
    "request_key",
    "cli",
    "args_json",
    "output_format",
    "compress_response",
    "status",
    "exit_code",
    "stdout",
    "stderr",
    "output_truncated",
    "error",
    "error_category",
    "retryable",
    "started_at",
    "finished_at",
    "pid",
    "expires_at",
    "owner_principal",
    "transport",
    "http_status",
    "payload_json",
    "owner_instance",
    "owner_hostname",
    "mcp_artifact_path",
    "mcp_artifact_scope",
    "mcp_artifact_cleanup_pending",
    "lease_deadline",
    "kit_execution_json",
    "kit_session_id",
    "kit_terminal_metadata_json",
    "kit_terminal_finalized",
    "kit_terminal_finalized_at",
    "progress_json",
  ],
  gateway_instances: ["instance_id", "role", "hostname", "pid", "started_at", "last_heartbeat"],
  validation_runs: [
    "validation_id",
    "owner_principal",
    "intent",
    "created_at",
    "request_json",
    "provider_links",
    "judge_link",
    "status",
  ],
  validation_run_jobs: ["job_id", "validation_id", "role"],
  validation_receipts: [
    "validation_id",
    "owner_principal",
    "minted_at",
    "schema_version",
    "report_json",
    "canonical_sha256",
    "prev_sha256",
    "seq",
    "signature",
    "models",
    "has_material_disagreement",
    "confidence",
  ],
  kit_attempt_fences: [
    "attempt_id",
    "state",
    "cli",
    "kit_execution_json",
    "kit_session_id",
    "owner_principal",
    "fenced_at",
  ],
} as const;

/**
 * Additive migrations introduced after the original job-store migration. The
 * release checker requires every file, migration receipt, column, and index
 * to be present in the packed package.
 */
export const POSTGRES_JOB_STORE_ADDITIVE_MIGRATIONS = [
  {
    version: 12,
    filename: "012_async_job_response_compression.sql",
    columns: ["compress_response"],
    indexes: [],
    requiredSql: ["ADD COLUMN IF NOT EXISTS compress_response BOOLEAN"],
  },
  {
    version: 13,
    filename: "013_personal_config_kit_request_key_privacy.sql",
    columns: [],
    indexes: [],
    requiredSql: ["SET request_key = 'kit:' || id"],
  },
  {
    version: 14,
    filename: "014_personal_config_kit_native_handle_privacy.sql",
    columns: [],
    indexes: [],
    requiredSql: ["SET kit_terminal_metadata_json = NULL", "'{nativeSessionId}'"],
  },
  {
    version: 15,
    filename: "015_async_job_owner_hostname.sql",
    columns: ["owner_hostname"],
    indexes: ["idx_jobs_owner_hostname_status"],
    requiredSql: ["ADD COLUMN IF NOT EXISTS owner_hostname TEXT"],
  },
  {
    version: 16,
    filename: "016_async_job_mcp_artifact_cleanup.sql",
    columns: ["mcp_artifact_path", "mcp_artifact_cleanup_pending"],
    indexes: ["idx_jobs_mcp_artifact_cleanup"],
    requiredSql: [
      "ADD COLUMN IF NOT EXISTS mcp_artifact_path TEXT",
      "ADD COLUMN IF NOT EXISTS mcp_artifact_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE",
    ],
  },
  {
    version: 17,
    filename: "017_async_job_mcp_artifact_scope.sql",
    columns: ["mcp_artifact_scope"],
    indexes: ["idx_jobs_mcp_artifact_scope_cleanup"],
    requiredSql: [
      "ADD COLUMN IF NOT EXISTS mcp_artifact_scope TEXT",
      "SET owner_hostname = gi.hostname",
      "FROM gateway_instances AS gi",
    ],
  },
  {
    version: 19,
    filename: "019_async_job_progress.sql",
    columns: ["progress_json"],
    indexes: [],
    requiredSql: ["ADD COLUMN IF NOT EXISTS progress_json TEXT"],
  },
  {
    version: 20,
    filename: "020_async_job_error_classification.sql",
    columns: ["error_category", "retryable"],
    indexes: [],
    requiredSql: [
      "ADD COLUMN IF NOT EXISTS error_category TEXT",
      "ADD COLUMN IF NOT EXISTS retryable BOOLEAN",
    ],
  },
] as const;

/**
 * Migration 011 is intentionally kept separate from native-handle retirement
 * in migration 014. Its error rule must match the startup scrub so a
 * migrate-only operation cannot retain raw output on queued or running jobs.
 */
export const POSTGRES_JOB_STORE_OUTPUT_PRIVACY_MIGRATION = {
  version: 11,
  filename: "011_personal_config_kit_output_privacy.sql",
  requiredSql: [
    "args_json = '[\"[personal-config-kit arguments redacted]\"]'",
    "stdout = ''",
    "stderr = ''",
    "payload_json = NULL",
    "status IN ('queued', 'running', 'completed')",
  ],
} as const;
