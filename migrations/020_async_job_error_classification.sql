ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS error_category TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS retryable BOOLEAN;

INSERT INTO schema_migrations (version, name)
VALUES (20, '020_async_job_error_classification')
ON CONFLICT (version) DO NOTHING;
