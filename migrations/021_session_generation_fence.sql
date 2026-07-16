-- Add an opaque random generation fence for session compare-and-set writes.
-- IDs, timestamps, providers, and owners can all be reproduced after a
-- delete/recreate race; this token cannot be selected by a competing creator.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS session_generation UUID;

UPDATE sessions
SET session_generation = gen_random_uuid()
WHERE session_generation IS NULL;

ALTER TABLE sessions
  ALTER COLUMN session_generation SET DEFAULT gen_random_uuid(),
  ALTER COLUMN session_generation SET NOT NULL;

INSERT INTO schema_migrations (version, name)
VALUES (21, '021_session_generation_fence')
ON CONFLICT (version) DO NOTHING;
