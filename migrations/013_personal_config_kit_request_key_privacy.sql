-- Personal Agent Config Kit request keys used to include deterministic
-- fingerprints of private execution inputs. Keep only the durable job id,
-- which is gateway-reserved and opaque to the provider request material.
-- The migration runner records this migration in the same transaction; the
-- guard also makes a manual replay a no-op for rows already repaired.

UPDATE jobs
SET request_key = 'kit:' || id
WHERE kit_execution_json IS NOT NULL
  AND request_key IS DISTINCT FROM 'kit:' || id;

INSERT INTO schema_migrations (version, name)
VALUES (13, '013_personal_config_kit_request_key_privacy')
ON CONFLICT (version) DO NOTHING;
