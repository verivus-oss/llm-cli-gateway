/**
 * A whole-operation bound for a transaction, expressed once on the port.
 *
 * Every timeout the two engines already carry bounds ONE statement:
 * `PG_STATEMENT_TIMEOUT_MS` is 25s per statement and SQLite's
 * `PRAGMA busy_timeout` is 5s per lock wait. A transaction is many statements,
 * and a body that loops over its input has no aggregate bound at all.
 *
 * The bound is deliberately NOT a `Promise.race`. Rejecting a wrapper does not
 * roll anything back: the engine keeps going and may still commit, so the
 * caller is told its mutation failed while the mutation is still on its way in.
 * That is the exact ambiguity `drivers/postgres.ts` says these timeouts exist
 * to remove, so each driver ends the operation for real rather than stopping
 * waiting for it. The mechanisms differ because the engines do; see each one.
 */
export type StorageDeadlineEngine = "sqlite" | "postgres";

export const STORAGE_TRANSACTION_DEADLINE_MS = 60_000;

/**
 * The same bound for a PINNED READ SNAPSHOT, which is a different shape of work.
 *
 * 60s is right for a gateway write: a request is waiting on it, and a write that
 * cannot finish in a minute is a write to abandon. An analytical read holds no
 * request open and exists to scan the whole table: verifying a 12,031-row,
 * 1.2 GB transcript copy cannot be done inside the write bound, and forcing it
 * to try is what pushed one draft of the cutover design into opening a private
 * connection to escape the port entirely.
 *
 * Fifteen minutes is a judgement, not a measurement. It is long enough that a
 * full-table verify is not racing the clock, and short enough that a snapshot
 * held open by a stuck reader does not pin PostgreSQL's cleanup horizon for an
 * afternoon. A caller that needs longer should say so explicitly rather than
 * have this number raised for everyone.
 */
export const STORAGE_READ_SNAPSHOT_DEADLINE_MS = 900_000;

/**
 * Thrown when, and ONLY when, the driver has already made the transaction
 * unable to commit. It is a durable statement about the database, not a report
 * that the caller gave up waiting.
 */
export class StorageTransactionDeadlineError extends Error {
  readonly code = "STORAGE_TRANSACTION_DEADLINE";

  constructor(
    readonly engine: StorageDeadlineEngine,
    readonly operation: string,
    readonly deadlineMs: number
  ) {
    super(
      `storage: the ${engine} transaction for operation class "${operation}" exceeded its ` +
        `whole-operation bound of ${deadlineMs}ms. The transaction was ended, not abandoned, ` +
        `so the write did NOT land.`
    );
    this.name = "StorageTransactionDeadlineError";
  }
}

export function isStorageTransactionDeadline(
  error: unknown
): error is StorageTransactionDeadlineError {
  return error instanceof StorageTransactionDeadlineError;
}
