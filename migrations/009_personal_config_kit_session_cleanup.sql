-- Personal Agent Config Kit state can outlive the ordinary session retention
-- window. An active scope pointer, a resumable provider handle, or a retained
-- invocation attempt all pin state that must survive cleanup until the Kit
-- lifecycle explicitly releases it.

CREATE OR REPLACE FUNCTION cleanup_expired_sessions(max_age_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM sessions AS session
  WHERE session.last_used_at < NOW() - INTERVAL '1 day' * max_age_days
    AND NOT EXISTS (
      SELECT 1
      FROM active_sessions AS active
      WHERE active.session_id = session.id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM kit_active_sessions AS kit_active
      WHERE kit_active.session_id = session.id
    )
    AND COALESCE(session.metadata -> 'kit' ->> 'resumeEligible', 'false') <> 'true'
    -- An expired attempt is still a reservation until an explicit lifecycle
    -- reconciliation removes it, so presence intentionally fails closed.
    AND NOT (COALESCE(session.metadata -> 'kit', '{}'::jsonb) ? 'attempt');

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version, name)
VALUES (9, '009_personal_config_kit_session_cleanup')
ON CONFLICT (version) DO NOTHING;
