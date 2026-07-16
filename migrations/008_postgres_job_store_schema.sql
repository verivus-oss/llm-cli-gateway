-- Canonical Postgres job-store schema. Runtime workers verify this schema
-- before accepting jobs, allowing the normal gateway role to be DML-only
-- after this migration has run.

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
  lease_deadline BIGINT,
  kit_execution_json TEXT,
  kit_session_id TEXT,
  kit_terminal_metadata_json TEXT,
  kit_terminal_finalized BOOLEAN NOT NULL DEFAULT FALSE,
  kit_terminal_finalized_at TEXT
);

-- Existing job stores predate several additive columns. Keep the migration
-- idempotent so an operator can promote any supported prior release.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_principal TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS compress_response BOOLEAN;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS transport TEXT NOT NULL DEFAULT 'process';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS http_status INTEGER;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS payload_json TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_instance TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_deadline BIGINT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_execution_json TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_session_id TEXT;
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS kit_terminal_finalized BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS kit_terminal_finalized_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_request_key ON jobs(request_key);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs(expires_at);
CREATE INDEX IF NOT EXISTS idx_jobs_request_key_finished ON jobs(request_key, finished_at);
CREATE INDEX IF NOT EXISTS idx_jobs_owner_status ON jobs(owner_instance, status);
CREATE INDEX IF NOT EXISTS idx_jobs_kit_finalization ON jobs(kit_terminal_finalized, status);

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

INSERT INTO schema_migrations (version, name)
VALUES (8, '008_postgres_job_store_schema')
ON CONFLICT (version) DO NOTHING;
