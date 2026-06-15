-- Slice 0.5 (API-endpoint routing, locked decision B: arbitrary provider names).
--
-- Relax the closed provider enum on the session tables so that any
-- `[providers.<name>]` config key (a kind:"api" provider id) is a valid
-- `cli` value. Migration 003 widened the constraint only as far as the
-- hard-coded set ('claude','codex','gemini','grok','mistral','grok-api');
-- arbitrary API provider names had no DB-level home.
--
-- Provider-set validation now lives in the application layer (config loading
-- plus `SESSION_PROVIDER_ENUM` for the registered set). The database keeps a
-- single *format* guard so empty strings / whitespace / control characters are
-- still rejected — it no longer enumerates a fixed provider list. The pattern
-- accepts the existing five CLIs and `grok-api`, and any well-formed provider
-- identifier (e.g. `ollama`, `openai`, `vllm`, `llama3.3`).

ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_cli_check;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_cli_check
  CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$');

ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_cli_check;
ALTER TABLE active_sessions
  ADD CONSTRAINT active_sessions_cli_check
  CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$');

INSERT INTO schema_migrations (version, name)
VALUES (5, '005_provider_type_open_api_names')
ON CONFLICT (version) DO NOTHING;
