-- Preserve exact gateway-generated Claude MCP request artifacts until their
-- originating host has safely acknowledged cleanup. This is intentionally
-- durable state, not a directory reaper: retention can only evict a row once
-- mcp_artifact_cleanup_pending is false.

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS mcp_artifact_path TEXT;

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS mcp_artifact_cleanup_pending BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_cleanup
  ON jobs(owner_hostname, mcp_artifact_cleanup_pending, status);

INSERT INTO schema_migrations (version, name)
VALUES (16, '016_async_job_mcp_artifact_cleanup')
ON CONFLICT (version) DO NOTHING;
