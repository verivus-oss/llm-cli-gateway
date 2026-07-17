-- A Kit attempt UUID is a permanently single-use capability. Normal admission
-- records an `admitted` row in the same transaction as its durable job. Manual
-- recovery records `recovered` before it releases the session lease, fencing a
-- paused pre-admission gateway from ever launching the old provider turn.
-- This table intentionally has no retention path.

CREATE TABLE IF NOT EXISTS kit_attempt_fences (
  attempt_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('admitted', 'recovered')),
  cli TEXT NOT NULL,
  kit_execution_json TEXT NOT NULL,
  kit_session_id TEXT NOT NULL,
  owner_principal TEXT,
  fenced_at TEXT NOT NULL
);

INSERT INTO schema_migrations (version, name)
VALUES (10, '010_personal_config_kit_attempt_fences')
ON CONFLICT (version) DO NOTHING;
