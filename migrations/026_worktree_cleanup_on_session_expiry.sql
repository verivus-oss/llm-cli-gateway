-- Database-side session expiry runs with no gateway in the loop, so it can
-- invoke no cleanup observer and must not be given one. Deleting a session that
-- owns a git worktree therefore destroyed the only record that the worktree
-- existed, on a host that was not even involved in the decision.
--
-- Expiry now STAGES a worktree-bearing session as a caller-invisible cleanup
-- tombstone instead of deleting it, and the host named in
-- `worktreeOwnerHostname` picks it up through the gateway's own lazy retry.
-- Everything else is deleted exactly as before.
--
-- The RETURN VALUE keeps its meaning and its type: the number of sessions that
-- stopped being live. Staged rows are counted there because they are no longer
-- reachable through any session read. Changing the signature would break an
-- operator's scheduled call for no gain, and the split is visible in the data:
-- a staged row carries `worktreeCleanupPendingDeletion`.
--
-- The pointer tables need no clearing here, unlike the gateway's own deletion
-- paths: a session referenced by `active_sessions` or `kit_active_sessions` is
-- already excluded from expiry, so a staged row can hold no pointer.
--
-- An EXISTING tombstone is excluded rather than re-staged. It is already not a
-- live session, and re-staging it would reset nothing while making the count
-- lie. Bounding how long a tombstone may live is a retention question that
-- belongs to `[persistence.retention]`, not to this function.

CREATE OR REPLACE FUNCTION cleanup_expired_sessions(max_age_days INTEGER DEFAULT 30)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
  staged_count INTEGER;
BEGIN
  WITH expired AS (
    SELECT session.id,
           COALESCE(
                 jsonb_typeof(session.metadata -> 'worktreePath') = 'string'
             AND jsonb_typeof(session.metadata -> 'worktreeName') = 'string'
             AND jsonb_typeof(session.metadata -> 'worktreeOwnerHostname') = 'string'
             AND jsonb_typeof(session.metadata -> 'worktreeOwnerInstanceId') = 'string',
             false
           ) AS owns_worktree
    FROM sessions AS session
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
      AND NOT (COALESCE(session.metadata -> 'kit', '{}'::jsonb) ? 'attempt')
      -- Already a cleanup tombstone: not a live session, nothing to stage.
      AND COALESCE(session.metadata ->> 'worktreeCleanupPendingDeletion', 'false') <> 'true'
    FOR UPDATE
  ), staged AS (
    UPDATE sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                      || '{"worktreeCleanupPending": true, "worktreeCleanupPendingDeletion": true}'::jsonb
     WHERE id IN (SELECT id FROM expired WHERE owns_worktree)
    RETURNING id
  ), removed AS (
    DELETE FROM sessions
     WHERE id IN (SELECT id FROM expired WHERE NOT owns_worktree)
    RETURNING id
  )
  SELECT (SELECT COUNT(*) FROM removed), (SELECT COUNT(*) FROM staged)
    INTO deleted_count, staged_count;

  RETURN deleted_count + staged_count;
END;
$$ LANGUAGE plpgsql;

INSERT INTO schema_migrations (version, name)
VALUES (26, '026_worktree_cleanup_on_session_expiry')
ON CONFLICT (version) DO NOTHING;
