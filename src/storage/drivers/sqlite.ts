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
import { inTransactionOn, nestedConnectionRefusal, runInTransaction } from "../reentrancy.js";
import { isTransactionControl, transactionControlRefusal } from "../statements.js";
import type { StorageConnection, StorageDriver, StorageEngine } from "../store.js";

/** Inside the 3s SIGTERM-to-SIGKILL window in `executor.ts:454`. */
const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

const CLOSING_MESSAGE = "storage: sqlite driver is closing and is not accepting new work";

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
  /** Handles are shut. Anything still queued has lost. */
  private closed = false;
  /** Draining: no NEW work is accepted, queued work still runs. */
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private readonly drainTimeoutMs: number;

  /**
   * `drainTimeoutMs` bounds how long `close()` waits for already-queued
   * transactions. It must stay inside the gateway's shutdown budget:
   * `executor.ts:454` SIGKILLs surviving process groups 3s after SIGTERM, so a
   * drain that outlives that is not a drain, it is a process that gets killed
   * mid-write. 2s leaves headroom. 0 disables draining.
   */
  constructor(
    private readonly dbPath: string,
    options: { drainTimeoutMs?: number } = {}
  ) {
    this.writable = openDatabase(dbPath);
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
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
    // `closed` wins over `closing`: once the handles are shut the honest answer
    // is "closed", and connectionFor already says so.
    if (inTransactionOn(this)) throw nestedConnectionRefusal(this);
    if (this.closing && !this.closed) throw new Error(CLOSING_MESSAGE);
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
    // Refused at SUBMISSION once closing, so the queue cannot grow while the
    // drain is trying to empty it.
    // Checked BEFORE the queue: a nested transaction would otherwise wait behind
    // the very transaction that is calling it, forever.
    if (inTransactionOn(this)) return Promise.reject(nestedConnectionRefusal(this));
    if (this.closing && !this.closed) return Promise.reject(new Error(CLOSING_MESSAGE));
    const run = async (): Promise<T> => {
      // Reached only when the drain expired with this transaction still queued.
      // The caller learns its write did not land from THIS rejection: there is
      // no logger here and a silent drop is the failure being fixed.
      if (this.closed) {
        throw new Error(
          `storage: sqlite driver closed while this transaction was still queued; ` +
            `the drain timed out after ${this.drainTimeoutMs}ms and the write did NOT land`
        );
      }
      const connection = this.connectionFor(operation, true);
      await connection.execute("BEGIN IMMEDIATE");
      try {
        const result = await runInTransaction(this, () => fn(connection));
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

  /**
   * Drain, then close.
   *
   * The defect this replaces: `close()` shut both handles and resolved without
   * ever awaiting `queue`, so every already-queued transaction then hit
   * `connectionFor` and rejected with "driver is closed". Measured by TRACK B:
   * 8 queued transactions, close() returned in 0.24ms, all 8 rejected, 0 rows
   * landed. It also made the b1 "shutdown drain time" deliverable measure as
   * instant, because there was no drain to time.
   *
   * The wait is BOUNDED. Work still queued when the bound expires is rejected,
   * not silently dropped, and is not written after the handles shut.
   */
  close(): Promise<void> {
    this.closePromise ??= this.performClose();
    return this.closePromise;
  }

  private async performClose(): Promise<void> {
    this.closing = true;
    if (this.drainTimeoutMs > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<void>(resolve => {
        timer = setTimeout(resolve, this.drainTimeoutMs);
        // Never hold the event loop open just to time a shutdown.
        timer.unref?.();
      });
      try {
        // `queue` is kept non-rejecting by the `catch` in transaction(), so
        // settling it is enough; a failed transaction still counts as drained.
        await Promise.race([this.queue, expired]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.closed = true;
    if (this.readable) this.readable.close();
    this.writable.close();
  }
}
