-- Initial schema for llm-cli-gateway PostgreSQL backend
-- Sessions and active session management

-- Create sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  cli VARCHAR(10) NOT NULL CHECK (cli IN ('claude', 'codex', 'gemini')),
  description TEXT,
  metadata JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create active_sessions table (enforces one active per CLI)
CREATE TABLE IF NOT EXISTS active_sessions (
  cli VARCHAR(10) PRIMARY KEY CHECK (cli IN ('claude', 'codex', 'gemini')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_cli ON sessions(cli);
CREATE INDEX IF NOT EXISTS idx_sessions_last_used_at ON sessions(last_used_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_metadata ON sessions USING GIN(metadata);
CREATE INDEX IF NOT EXISTS idx_sessions_cli_last_used ON sessions(cli, last_used_at DESC);

-- View for session summary (joins sessions + active_sessions)
CREATE OR REPLACE VIEW session_summary AS
SELECT
  s.id,
  s.cli,
  s.description,
  s.created_at,
  s.last_used_at,
  (a.session_id IS NOT NULL) AS is_active
FROM sessions s
LEFT JOIN active_sessions a ON s.id = a.session_id;

-- Cleanup function for expired sessions
CREATE OR REPLACE FUNCTION cleanup_expired_sessions(max_age_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete sessions older than max_age_days that are not active
  DELETE FROM sessions
  WHERE last_used_at < NOW() - INTERVAL '1 day' * max_age_days
    AND id NOT IN (SELECT session_id FROM active_sessions WHERE session_id IS NOT NULL);

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

-- Schema migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Record this migration
INSERT INTO schema_migrations (version, name)
VALUES (1, '001_initial_schema')
ON CONFLICT (version) DO NOTHING;
