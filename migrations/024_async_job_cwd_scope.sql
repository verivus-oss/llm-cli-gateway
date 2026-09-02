ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS cwd_scope TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS cwd_path TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS workspace_alias TEXT;

INSERT INTO schema_migrations (version, name)
VALUES (24, '024_async_job_cwd_scope')
ON CONFLICT (version) DO NOTHING;
