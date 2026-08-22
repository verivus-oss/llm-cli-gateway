/**
 * The wedged-validation-run predicate, in ONE statement text for both engines.
 *
 * A leaf module with no imports, so `job-store.ts` and
 * `postgres-job-store-ops.ts` can both read it without a cycle: job-store
 * already imports the Postgres ops, and putting the predicate in either of them
 * would either invert that direction or close it into a loop.
 *
 * The engines can share the literal because the Postgres driver rewrites `?`
 * placeholders to `$n` and this predicate uses nothing dialect-specific: no
 * upsert, no boolean literal, no jsonb operator (the one shape s8 found the
 * rewrite cannot tell from a placeholder).
 *
 * Sharing it is not tidiness. `storage/retention.ts` defines wedged in prose
 * and this is what actually decides it; two copies would be two definitions,
 * and the whole reason `validation_runs` had no reaper is that its lifecycle
 * was decided in more places than one.
 */

/**
 * `status <> 'finalized'` rather than an enumerated reapable set. A finalized
 * run owns an immutable receipt, so deleting it would orphan that receipt; that
 * is the only status this sweep must never touch, and naming the complement
 * would need editing again the next time a status is added.
 *
 * NOT EXISTS over the join to `jobs` is the clause that separates wedged from
 * slow: while any linked job survives, `validation_receipt` mint-on-read can
 * still finalize the run.
 */
const WHERE_WEDGED = `
      WHERE r.status <> 'finalized'
        AND r.created_at < ?
        AND NOT EXISTS (
          SELECT 1 FROM validation_run_jobs vrj
            JOIN jobs j ON j.id = vrj.job_id
           WHERE vrj.validation_id = r.validation_id
        )`;

/** Dry-run count. Reported whether or not the bound is set. */
export const SQL_COUNT_WEDGED_VALIDATION_RUNS = `
      SELECT COUNT(*) AS c FROM validation_runs r${WHERE_WEDGED}`;

/**
 * The ids to delete, oldest first. Selected and then deleted BY ID: repeating
 * the predicate in the second DELETE would re-evaluate it after the link rows
 * had gone, and the third clause READS those link rows, so the run delete would
 * match a strictly larger set than the one this returned.
 */
export const SQL_SELECT_WEDGED_VALIDATION_RUNS = `
      SELECT r.validation_id AS validation_id FROM validation_runs r${WHERE_WEDGED}
      ORDER BY r.created_at
      LIMIT ?`;
