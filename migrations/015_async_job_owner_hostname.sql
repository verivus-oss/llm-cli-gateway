-- Keep the owning host with each async job, independent of the short-lived
-- gateway_instances observability row. A local gateway may then reclaim only
-- its own validated request-scoped artifact after another host orphaned the
-- durable job and the original instance row was garbage-collected.

ALTER TABLE IF EXISTS jobs
  ADD COLUMN IF NOT EXISTS owner_hostname TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_owner_hostname_status
  ON jobs(owner_hostname, status);

INSERT INTO schema_migrations (version, name)
VALUES (15, '015_async_job_owner_hostname')
ON CONFLICT (version) DO NOTHING;
