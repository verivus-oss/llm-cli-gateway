-- Native response compression is selected at async enqueue time. Preserve the
-- effective boolean across PostgreSQL hydration and gateway restarts; NULL
-- remains the compatible legacy value for rows created before this feature.

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS compress_response BOOLEAN;

INSERT INTO schema_migrations (version, name)
VALUES (12, '012_async_job_response_compression')
ON CONFLICT (version) DO NOTHING;
