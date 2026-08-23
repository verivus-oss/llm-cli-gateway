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
