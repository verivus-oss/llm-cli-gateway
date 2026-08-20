/**
 * SQLite driver for the storage port.
 *
 * A thin adapter over the existing `node:sqlite` code, which stays as the
 * zero-config default (docs/plans/storage-unification.md 3.2). It is async
 * because the port is async, not because the work is: `node:sqlite` is
 * synchronous, so these promises resolve on the same tick and no I/O leaves the
 * event loop. That buys structural uniformity, not throughput.
 *
 * SQLite has no database identities, so this driver holds exactly one: `app`.
 * Every operation class therefore routes to it and `roleSeparationInForce()`
 * reports false. That is accurate rather than a limitation to hide, and it is
 * the honest answer to "is role separation in force here".
 */
import { openDatabase, openReadOnly, type GatewayDatabase } from "../../sqlite-driver.js";
import { resolveStorageRole, type StorageOperationClass, type StorageRole } from "../roles.js";
import { isTransactionControl, transactionControlRefusal } from "../statements.js";
import type { StorageConnection, StorageDriver, StorageEngine } from "../store.js";

/** Operation classes that may use the read-only connection. */
const READ_ONLY_OPERATIONS: ReadonlySet<StorageOperationClass> = new Set([
  "transcript_read",
  "analytics_read",
]);

// `async` deliberately: node:sqlite throws synchronously, and an async surface
// that sometimes throws instead of rejecting cannot be handled with .catch().
//
// `transactionControl` is granted only to the connection `transaction()` builds.
// A caller-issued BEGIN would otherwise bypass the `queue` below, on a
// connection that cannot nest one. Same rule as the Postgres driver, for a
// different engine reason.
function connectionOver(db: GatewayDatabase, transactionControl: boolean): StorageConnection {
  const guard = (statement: string): void => {
    if (!transactionControl && isTransactionControl(statement)) {
      throw transactionControlRefusal(statement);
    }
  };
  return {
    async query<T>(statement: string, params: readonly unknown[] = []): Promise<T[]> {
      guard(statement);
      return db.prepare(statement).all(...params) as T[];
    },
    async execute(
      statement: string,
      params: readonly unknown[] = []
    ): Promise<{ rowsAffected: number }> {
      guard(statement);
      return { rowsAffected: db.prepare(statement).run(...params).changes };
    },
  };
}

export class SqliteStorageDriver implements StorageDriver {
  readonly engine: StorageEngine = "sqlite";
  readonly roles: ReadonlySet<StorageRole> = new Set<StorageRole>(["app"]);

  private readonly writable: GatewayDatabase;
  private readable: GatewayDatabase | null = null;
  private closed = false;

  constructor(private readonly dbPath: string) {
    this.writable = openDatabase(dbPath);
  }

  /**
   * Reads go to a dedicated read-only connection, so a mutation dressed as a
   * read fails at the engine (SQLITE_READONLY) rather than on trust. Same
   * control the flight recorder already relies on.
   */
  private connectionFor(
    operation: StorageOperationClass,
    transactionControl = false
  ): StorageConnection {
    if (this.closed) throw new Error("storage: sqlite driver is closed");
    resolveStorageRole(operation, this.roles);
    if (!READ_ONLY_OPERATIONS.has(operation)) {
      return connectionOver(this.writable, transactionControl);
    }
    this.readable ??= openReadOnly(this.dbPath);
    return connectionOver(this.readable, transactionControl);
  }

  async withConnection<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    return fn(this.connectionFor(operation));
  }

  /**
   * Explicit BEGIN IMMEDIATE / COMMIT / ROLLBACK rather than the adapter's
   * `withTransaction`, which takes a SYNCHRONOUS function: awaiting inside it
   * schedules the body as a microtask that runs after the transaction has
   * already committed, so a rejection would commit instead of rolling back.
   *
   * Serialised through `queue` because one connection cannot nest BEGIN, and
   * two callers awaiting concurrently would otherwise interleave.
   */
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (READ_ONLY_OPERATIONS.has(operation)) {
      return Promise.reject(
        new Error(`storage: ${operation} is a read class and cannot open a transaction`)
      );
    }
    const run = async (): Promise<T> => {
      const connection = this.connectionFor(operation, true);
      await connection.execute("BEGIN IMMEDIATE");
      try {
        const result = await fn(connection);
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        await connection.execute("ROLLBACK");
        throw error;
      }
    };
    // The `catch` is the load-bearing part: it keeps the chain non-rejecting so
    // a failed transaction does not block every later one. An earlier version
    // also passed `run` as the rejection arm of `then`, and the two masked each
    // other, so neither could be shown to work. The caller still gets the real
    // rejection from `started`.
    const started = this.queue.then(run);
    this.queue = started.catch(() => undefined);
    return started;
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      if (this.readable) this.readable.close();
      this.writable.close();
    }
    return Promise.resolve();
  }
}
