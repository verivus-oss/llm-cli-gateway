-- `session_summary` selected every session row, including worktree-cleanup
-- tombstones. A tombstone is a DELETED session whose row survives only so the
-- host owning its git worktree can retry the filesystem removal, and every
-- gateway read excludes them. The view did not, so an operator inspecting the
-- database directly saw deleted sessions listed as if they were live, and
-- `is_active` computed for them.
--
-- Nothing in the gateway reads this view, so this is a correction to what an
-- operator sees rather than a runtime fix.
--
-- The predicate is spelled out here rather than shared with the TypeScript that
-- also creates this view. A migration is a frozen historical artefact: it must
-- keep meaning what it meant when it was applied, so it cannot import a
-- constant that later changes underneath it. `src/migrate.ts` splices
-- `sessionNotTombstonedSql` for the same statement, and
-- `scripts/check-session-tombstone-scope.mjs` governs that copy.

CREATE OR REPLACE VIEW session_summary AS
SELECT
  s.id,
  s.cli,
  s.description,
  s.created_at,
  s.last_used_at,
  (a.session_id IS NOT NULL) AS is_active
FROM sessions s
LEFT JOIN active_sessions a ON s.id = a.session_id
WHERE COALESCE(s.metadata->>'worktreeCleanupPendingDeletion', 'false') <> 'true';

INSERT INTO schema_migrations (version, name)
VALUES (27, '027_session_summary_excludes_tombstones')
ON CONFLICT (version) DO NOTHING;
