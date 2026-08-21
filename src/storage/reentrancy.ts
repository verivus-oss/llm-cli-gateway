/**
 * Makes a nested connection request impossible while a transaction is open on
 * the same driver.
 *
 * A transaction holds one connection for its whole body. Asking the same driver
 * for another one from inside that body waits for a connection the body itself
 * is preventing from being returned, so it does not fail, it HANGS. The job
 * store's pool is `max: 1`, which means one nested call deadlocks immediately;
 * measured at six nested requests against a six-connection pool, the wait was
 * 150s and ended in a test timeout rather than an error. SQLite has the same
 * shape for a different reason: `transaction()` serialises on a queue that a
 * nested transaction would wait behind forever.
 *
 * "A body must not ask for another connection" is a rule, and a rule is
 * something the next author breaks. This turns it into an immediate, explained
 * throw. `AsyncLocalStorage` is what makes that possible: the context follows
 * the body across every `await`, which a plain instance flag would not.
 *
 * Keyed by driver INSTANCE, so a body that legitimately touches a different
 * driver, SQLite inside a Postgres transaction or the reverse, is unaffected.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const activeTransactions = new AsyncLocalStorage<Set<object>>();

/** True when a transaction is already open on this driver in this async context. */
export function inTransactionOn(driver: object): boolean {
  return activeTransactions.getStore()?.has(driver) === true;
}

export function nestedConnectionRefusal(driver: { engine: string }): Error {
  return new Error(
    `storage: a transaction is already open on this ${driver.engine} driver in this async ` +
      `context. A transaction body holds its connection for the whole body, so asking the same ` +
      `driver for another one deadlocks rather than failing. Use the connection the body was ` +
      `given, or move the work outside the transaction.`
  );
}

/**
 * Run a transaction body with this driver marked active.
 *
 * The set is copied rather than mutated so an inner scope cannot leak its
 * marker outward, and so a sibling transaction started after this one returns
 * sees a clean context.
 */
export function runInTransaction<T>(driver: object, body: () => Promise<T>): Promise<T> {
  const next = new Set(activeTransactions.getStore() ?? []);
  next.add(driver);
  return activeTransactions.run(next, body);
}
