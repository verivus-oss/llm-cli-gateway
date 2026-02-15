-- Convert session identifiers from UUID to opaque string IDs (TEXT)
-- Keeps compatibility with file-based manager and legacy custom IDs.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sessions'
      AND column_name = 'id'
      AND udt_name = 'uuid'
  ) THEN
    ALTER TABLE active_sessions DROP CONSTRAINT IF EXISTS active_sessions_session_id_fkey;
    ALTER TABLE sessions ALTER COLUMN id TYPE TEXT USING id::text;
    ALTER TABLE active_sessions ALTER COLUMN session_id TYPE TEXT USING session_id::text;
    ALTER TABLE active_sessions
      ADD CONSTRAINT active_sessions_session_id_fkey
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE;
  END IF;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version, name)
VALUES (2, '002_session_ids_as_text')
ON CONFLICT (version) DO NOTHING;
