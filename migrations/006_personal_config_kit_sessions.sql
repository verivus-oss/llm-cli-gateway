-- Personal Agent Config Kit: active sessions are scoped by both provider and
-- canonical workspace root. Session-local Kit bindings themselves live in the
-- existing `sessions.metadata` JSONB column so no provider-native state is
-- copied into the synced config repository.

CREATE TABLE IF NOT EXISTS kit_active_sessions (
  cli VARCHAR(32) NOT NULL CHECK (cli ~ '^[A-Za-z][A-Za-z0-9._-]*$'),
  scope_key TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (cli, scope_key)
);

CREATE INDEX IF NOT EXISTS idx_kit_active_sessions_session_id
  ON kit_active_sessions(session_id);

INSERT INTO schema_migrations (version, name)
VALUES (6, '006_personal_config_kit_sessions')
ON CONFLICT (version) DO NOTHING;
