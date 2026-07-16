-- Fence request-artifact cleanup by a durable local installation scope, not
-- hostname alone. The scope combines a private marker with filesystem identity
-- at runtime, so two isolated installations with the same hostname cannot
-- acknowledge each other's absent artifact path.
--
-- Also repair pre-015 job rows while their gateway_instances record still
-- survives. If that record has already been garbage-collected, owner_hostname
-- intentionally remains NULL: guessing a host would make filesystem cleanup
-- unsafe. Rows with an unknown origin remain retention-pinned; do not repair
-- hostname or scope provenance with SQL.

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS mcp_artifact_scope TEXT;

UPDATE jobs AS j
SET owner_hostname = gi.hostname
FROM gateway_instances AS gi
WHERE j.owner_hostname IS NULL
  AND j.owner_instance IS NOT NULL
  AND j.owner_instance = gi.instance_id
  AND gi.hostname IS NOT NULL
  AND gi.hostname <> '';

CREATE INDEX IF NOT EXISTS idx_jobs_mcp_artifact_scope_cleanup
  ON jobs(owner_hostname, mcp_artifact_scope, mcp_artifact_cleanup_pending, status);

INSERT INTO schema_migrations (version, name)
VALUES (17, '017_async_job_mcp_artifact_scope')
ON CONFLICT (version) DO NOTHING;
