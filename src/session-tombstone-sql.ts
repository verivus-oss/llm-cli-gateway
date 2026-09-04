/**
 * The one spelling of "this row is not a worktree-cleanup tombstone".
 *
 * It lives in its own module so a caller that is not the session store can
 * splice it without importing the store: `src/migrate.ts` needs it for the
 * `session_summary` view, and pulling the whole session manager into the
 * migration CLI to reach a string constant would be the wrong trade.
 */

/**
 * Metadata key marking a session as a worktree-cleanup tombstone: the caller's
 * delete has already happened, and the row survives only so the host that owns
 * the worktree can retry the filesystem removal.
 */
export const WORKTREE_CLEANUP_TOMBSTONE_KEY = "worktreeCleanupPendingDeletion";

/**
 * The tombstone rule as a SQL fragment.
 *
 * `alias` qualifies the column for statements that alias or join `sessions`; it
 * is caller-supplied SQL, never user input. A NULL `metadata` is not a
 * tombstone, which `COALESCE` states rather than leaving it to three-valued
 * logic inside a `WHERE`.
 */
export function sessionNotTombstonedSql(alias = "sessions"): string {
  return `COALESCE(${alias}.metadata->>'${WORKTREE_CLEANUP_TOMBSTONE_KEY}', 'false') <> 'true'`;
}
