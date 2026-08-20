/**
 * Transaction-control detection, shared by both SQL drivers.
 *
 * A `StorageConnection` obtained from `withConnection` is not bound to one
 * backend: the Postgres driver serves it from a pool, which checks out a
 * connection per query. Running `BEGIN` there opens a transaction on a backend
 * that the next statement may not get, so the transaction silently splits.
 * Refusing the statement makes that unrepresentable rather than merely absent,
 * which is the point: being careful at the one call site that exists today
 * does not stop the next one.
 *
 * The SQLite driver refuses it for a different reason with the same shape: its
 * `transaction()` serialises through a queue that a caller-issued `BEGIN`
 * would bypass, on a connection that cannot nest one.
 */

/** Statements that start, end or checkpoint a transaction. */
const TRANSACTION_CONTROL = new Set([
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "ABORT",
  "SAVEPOINT",
  "RELEASE",
]);

/**
 * The leading keyword, with leading whitespace, line comments and block
 * comments skipped. `/ * BEGIN * / SELECT 1` leads with SELECT, not BEGIN.
 */
export function leadingKeyword(statement: string): string {
  let i = 0;
  for (;;) {
    while (i < statement.length && /\s/.test(statement[i])) i += 1;
    if (statement[i] === "-" && statement[i + 1] === "-") {
      const end = statement.indexOf("\n", i);
      if (end === -1) return "";
      i = end + 1;
      continue;
    }
    if (statement[i] === "/" && statement[i + 1] === "*") {
      const end = statement.indexOf("*/", i + 2);
      if (end === -1) return "";
      i = end + 2;
      continue;
    }
    break;
  }
  let word = "";
  while (i < statement.length && /[A-Za-z]/.test(statement[i])) {
    word += statement[i];
    i += 1;
  }
  return word.toUpperCase();
}

export function isTransactionControl(statement: string): boolean {
  return TRANSACTION_CONTROL.has(leadingKeyword(statement));
}

export function transactionControlRefusal(statement: string): Error {
  return new Error(
    `storage: "${leadingKeyword(statement)}" is transaction control and cannot be issued on a ` +
      `connection from withConnection(). Use driver.transaction(), which pins one backend for ` +
      `the whole body.`
  );
}
