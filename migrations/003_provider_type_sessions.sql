-- Widen session provider constraints for API-backed providers.
-- Existing PostgreSQL installations created before the Grok API provider split
-- only accepted the original CLI subset. Keep the column values opaque strings
-- but enforce the current provider set.

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_cli_check;
ALTER TABLE sessions ALTER COLUMN cli TYPE VARCHAR(32);
ALTER TABLE sessions
  ADD CONSTRAINT sessions_cli_check
  CHECK (cli IN ('claude', 'codex', 'gemini', 'grok', 'mistral', 'grok-api'));

ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_cli_check;
ALTER TABLE active_sessions ALTER COLUMN cli TYPE VARCHAR(32);
ALTER TABLE active_sessions
  ADD CONSTRAINT active_sessions_cli_check
  CHECK (cli IN ('claude', 'codex', 'gemini', 'grok', 'mistral', 'grok-api'));

INSERT INTO schema_migrations (version, name)
VALUES (3, '003_provider_type_sessions')
ON CONFLICT (version) DO NOTHING;
