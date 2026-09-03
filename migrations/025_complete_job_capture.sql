ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS replay_context_json TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS capture_format TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS capture_status TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS output_dropped_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS native_transcript TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS native_transcript_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS native_transcript_truncated BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS native_transcript_dropped_bytes BIGINT NOT NULL DEFAULT 0;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS capture_error TEXT;

INSERT INTO schema_migrations (version, name)
VALUES (25, '025_complete_job_capture')
ON CONFLICT (version) DO NOTHING;
