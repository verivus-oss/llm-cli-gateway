-- Personal Agent Config Kit: retain the gateway session binding next to each
-- durable provider job. A terminal output remains pinned until the session
-- binding has been finalized, allowing a fresh gateway instance to reconcile
-- a crash between durable result persistence and provider-handle extraction.

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS kit_execution_json TEXT;

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS kit_session_id TEXT;

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS kit_terminal_finalized BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS kit_terminal_finalized_at TEXT;

DO $$
BEGIN
  IF to_regclass('jobs') IS NOT NULL THEN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_jobs_kit_finalization ON jobs(kit_terminal_finalized, status)';
  END IF;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES (7, '007_personal_config_kit_job_finalization')
ON CONFLICT (version) DO NOTHING;
