ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS progress_json TEXT;

INSERT INTO schema_migrations (version, name)
VALUES (19, '019_async_job_progress')
ON CONFLICT (version) DO NOTHING;
