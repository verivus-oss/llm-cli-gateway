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
import { resolve } from "node:path";
import {
  openDatabase,
  openReadOnly,
  type GatewayDatabase,
  type GatewayStatement,
} from "../../sqlite-driver.js";
import {
  READ_ONLY_OPERATION_CLASSES,
  resolveStorageRole,
  type StorageOperationClass,
  type StorageRole,
} from "../roles.js";
import {
  STORAGE_READ_SNAPSHOT_DEADLINE_MS,
  STORAGE_TRANSACTION_DEADLINE_MS,
  StorageTransactionDeadlineError,
} from "../deadline.js";
import { inTransactionOn, nestedConnectionRefusal, runInTransaction } from "../reentrancy.js";
import { isTransactionControl, transactionControlRefusal } from "../statements.js";
import type { StorageConnection, StorageDriver, StorageEngine } from "../store.js";

/** Inside the 3s SIGTERM-to-SIGKILL window in `executor.ts:454`. */
const DEFAULT_DRAIN_TIMEOUT_MS = 2000;

const CLOSING_MESSAGE = "storage: sqlite driver is closing and is not accepting new work";

/** Schema writers sharing one SQLite file must not race across driver instances. */
const bootstrapQueues = new Map<string, Promise<void>>();

/**
 * Prepared statements, cached per database handle.
 *
 * The subsystems moving onto this port prepared their statements ONCE in a
 * constructor and reused them; SqliteJobStore alone holds 27 such fields.
 * Re-preparing on every call would make the port a throughput regression
 * against the code it replaces, which is not a trade this programme is asking
 * anyone to make: the port exists to remove a second write path, not to make
 * the first one slower.
 *
 * Keyed by statement text, which is safe here BECAUSE of the ratchet: SQL is
 * confined to the storage modules (`npm run storage:port:check`), so the key
 * space is the finite set of statements this repository contains, not anything
 * a caller can grow. The cap is belt and braces against that ceasing to be
 * true, and evicts rather than growing without bound.
 */
const STATEMENT_CACHE_LIMIT = 256;
const statementCaches = new WeakMap<GatewayDatabase, Map<string, GatewayStatement>>();

function preparedFor(db: GatewayDatabase, statement: string): GatewayStatement {
  let cache = statementCaches.get(db);
  if (!cache) {
    cache = new Map();
    statementCaches.set(db, cache);
  }
  const hit = cache.get(statement);
  if (hit) return hit;
  const prepared = db.prepare(statement);
  if (cache.size >= STATEMENT_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(statement, prepared);
  return prepared;
}

/**
 * The whole-operation deadline a transaction's statements are checked against,
 * or null outside a bounded transaction.
 */
interface SqliteDeadline {
  expiresAt: number;
  operation: StorageOperationClass;
  deadlineMs: number;
}

// `async` deliberately: node:sqlite throws synchronously, and an async surface
// that sometimes throws instead of rejecting cannot be handled with .catch().
//
// `transactionControl` is granted only to the connection `transaction()` builds.
// A caller-issued BEGIN would otherwise bypass the `queue` below, on a
// connection that cannot nest one. Same rule as the Postgres driver, for a
// different engine reason.
function connectionOver(
  db: GatewayDatabase,
  transactionControl: boolean,
  deadline: SqliteDeadline | null = null
): StorageConnection {
  const guard = (statement: string): void => {
    const control = isTransactionControl(statement);
    if (!transactionControl && control) throw transactionControlRefusal(statement);
    // Checked BEFORE the statement is issued, never during one, and never
    // against a terminator: `transaction()` decides for itself whether COMMIT
    // may still be issued, and ROLLBACK must stay reachable precisely when the
    // bound has expired.
    if (control || deadline === null || Date.now() < deadline.expiresAt) return;
    throw new StorageTransactionDeadlineError("sqlite", deadline.operation, deadline.deadlineMs);
  };
  return {
    async query<T>(statement: string, params: readonly unknown[] = []): Promise<T[]> {
      guard(statement);
      return preparedFor(db, statement).all(...params) as T[];
    },
    async execute(
      statement: string,
      params: readonly unknown[] = []
    ): Promise<{ rowsAffected: number }> {
      guard(statement);
      return { rowsAffected: preparedFor(db, statement).run(...params).changes };
    },
    async executeScript(script: string): Promise<void> {
      guard(script);
      // db.exec, NOT prepare().run(): prepare compiles one statement and would
      // silently drop the rest of a DDL batch. Not cached, because a script is
      // run once at bootstrap and caching it would pin a compiled statement for
      // a string nothing repeats.
      db.exec(script);
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
  private readonly transactionDeadlineMs: number;
  private readonly readSnapshotDeadlineMs: number;

  /**
   * `drainTimeoutMs` bounds how long `close()` waits for already-queued
   * transactions. It must stay inside the gateway's shutdown budget:
   * `executor.ts:454` SIGKILLs surviving process groups 3s after SIGTERM, so a
   * drain that outlives that is not a drain, it is a process that gets killed
   * mid-write. 2s leaves headroom. 0 disables draining.
   *
   * `transactionDeadlineMs` bounds one transaction as a whole. 0 disables it.
   */
  constructor(
    private readonly dbPath: string,
    options: {
      drainTimeoutMs?: number;
      transactionDeadlineMs?: number;
      readSnapshotDeadlineMs?: number;
    } = {}
  ) {
    this.writable = openDatabase(dbPath);
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.transactionDeadlineMs = options.transactionDeadlineMs ?? STORAGE_TRANSACTION_DEADLINE_MS;
    this.readSnapshotDeadlineMs =
      options.readSnapshotDeadlineMs ?? STORAGE_READ_SNAPSHOT_DEADLINE_MS;
  }

  /**
   * Reads go to a dedicated read-only connection, so a mutation dressed as a
   * read fails at the engine (SQLITE_READONLY) rather than on trust. Same
   * control the flight recorder already relies on.
   */
  private connectionFor(
    operation: StorageOperationClass,
    transactionControl = false,
    deadline: SqliteDeadline | null = null
  ): StorageConnection {
    if (this.closed) throw new Error("storage: sqlite driver is closed");
    resolveStorageRole(operation, this.roles);
    if (!READ_ONLY_OPERATION_CLASSES.has(operation)) {
      return connectionOver(this.writable, transactionControl, deadline);
    }
    this.readable ??= openReadOnly(this.dbPath);
    return connectionOver(this.readable, transactionControl, deadline);
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
  /**
   * Wall-clock instant after which a still-QUEUED transaction is abandoned.
   *
   * The bound cannot be enforced by a timer alone. `node:sqlite` is
   * synchronous, so every `await connection.execute(...)` settles as a
   * microtask and the queue is an unbroken microtask chain. Node drains the
   * microtask queue completely before it reaches the timers phase, so a
   * `setTimeout` cannot fire while the queue is draining: the timeout was being
   * starved by the very work it was supposed to bound. Measured at queue depth
   * 500, the drain ran 2598 ms past a 2000 ms bound and abandoned nothing.
   *
   * A deadline the queue runner reads itself needs no event-loop turn, so it
   * holds exactly where the timer failed.
   */
  private drainDeadline: number | null = null;
  /** Transactions abandoned by the drain bound, so close() can report honestly. */
  private abandonedOnClose = 0;

  /**
   * Schema bootstrap: DDL, PRAGMAs and idempotent column migrations.
   *
   * NOT a routed runtime operation, and deliberately not one of the four
   * operation classes, for the same reason as the Postgres driver's
   * `bootstrap`: DDL is none of `write`, `transcript_read`, `analytics_read` or
   * `retention`, and giving it a class is how an exceptional path starts
   * looking routine to the next reader.
   *
   * It runs through the same `queue` as `transaction`, so a bootstrap cannot
   * interleave with a write, and it is granted transaction control because a
   * PRAGMA is not a routed statement and the migrations need to be atomic.
   */
  bootstrap<T>(fn: (connection: StorageConnection) => Promise<T>): Promise<T> {
    if (this.closing && !this.closed) return Promise.reject(new Error(CLOSING_MESSAGE));
    if (inTransactionOn(this)) return Promise.reject(nestedConnectionRefusal(this));
    const run = async (): Promise<T> => {
      if (this.closed) throw new Error("storage: sqlite driver is closed");
      return runInTransaction(this, () => fn(this.connectionFor("write", true)));
    };
    const key = resolve(this.dbPath);
    const predecessor = bootstrapQueues.get(key) ?? Promise.resolve();
    // Reserve this driver's queue immediately. If the reservation waited until
    // the global predecessor settled, a transaction submitted in the meantime
    // could overtake the bootstrap and prepare statements against a schema that
    // does not exist yet.
    const started = Promise.all([this.queue, predecessor]).then(run);
    this.queue = started.catch(() => undefined);
    const tail = started.then(
      () => undefined,
      () => undefined
    );
    bootstrapQueues.set(key, tail);
    void tail.then(() => {
      if (bootstrapQueues.get(key) === tail) bootstrapQueues.delete(key);
    });
    return started;
  }

  /**
   * BOUNDED AS A WHOLE, by a deadline the connection reads rather than a timer.
   *
   * The residual is real here and not only on Postgres. `job-store.ts` sets
   * `PRAGMA busy_timeout = 5000` so that two gateway processes sharing one file
   * wait for the write lock instead of failing (#139), and that wait is per
   * statement: a body looping over its input has no aggregate bound. Measured
   * on this engine, one contended statement blocks for 5003ms and a 200ms timer
   * armed beforehand does not run until 5004ms, because `node:sqlite` is
   * synchronous and holds the thread for the whole wait.
   *
   * That is why the check is a clock read at each statement boundary and not a
   * `setTimeout`: the same starvation b1 measured on the drain bound applies
   * here, and `node:sqlite` exposes no interrupt to cancel a statement with.
   * Nothing is abandoned either, which is what makes it safe: the engine is
   * in-process and synchronous, so at the moment of the check no statement is
   * in flight, and refusing to issue the NEXT one leaves an ordinary ROLLBACK
   * to run. The residual is one statement's `busy_timeout`.
   */
  transaction<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (READ_ONLY_OPERATION_CLASSES.has(operation)) {
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
      const pastDeadline = this.drainDeadline !== null && Date.now() >= this.drainDeadline;
      if (this.closed || pastDeadline) {
        this.abandonedOnClose += 1;
        throw new Error(
          `storage: sqlite driver closed while this transaction was still queued; ` +
            `the drain bound of ${this.drainTimeoutMs}ms elapsed and the write did NOT land`
        );
      }
      // Armed when the transaction reaches the front of the queue, not when it
      // was submitted: a bound that counted queue time would turn a backlog
      // into a cascade of refusals rather than bounding anyone's own work.
      const deadline: SqliteDeadline | null =
        this.transactionDeadlineMs > 0
          ? {
              expiresAt: Date.now() + this.transactionDeadlineMs,
              operation,
              deadlineMs: this.transactionDeadlineMs,
            }
          : null;
      const connection = this.connectionFor(operation, true, deadline);
      await connection.execute("BEGIN IMMEDIATE");
      try {
        const result = await runInTransaction(this, () => fn(connection));
        if (deadline !== null && Date.now() >= deadline.expiresAt) {
          throw new StorageTransactionDeadlineError(
            "sqlite",
            deadline.operation,
            deadline.deadlineMs
          );
        }
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        // The ROLLBACK must never replace the error that caused it. SQLite
        // auto-rolls-back on SQLITE_FULL and on some I/O errors, so this
        // statement then fails with "cannot rollback - no transaction is
        // active" and, unguarded, that message is what the caller receives:
        // a full disk destroying the evidence of a full disk. This project has
        // had one corruption whose root cause was never determined.
        //
        // Swallowed is not lost. There is no logger in this class (see the
        // drain refusal above for the same constraint), so the rollback failure
        // rides out on `cause` where a caller that wants it can read it.
        try {
          await connection.execute("ROLLBACK");
        } catch (rollbackError) {
          if (error instanceof Error && error.cause === undefined) {
            error.cause = rollbackError;
          }
        }
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
   * A pinned read snapshot on the read-only handle.
   *
   * `BEGIN DEFERRED` and not `BEGIN IMMEDIATE`: this takes no write lock and
   * must not block a live recorder. Under WAL a read transaction sees the
   * snapshot current when its first read runs and keeps seeing it until it
   * ends, which is the whole point, and writers carry on into the WAL beside it.
   *
   * It does NOT go through the write queue. The queue serialises transactions
   * that contend for the one writable handle; a read snapshot holds a different
   * connection, and putting a fifteen-minute analytical read at the head of that
   * queue would stall every write behind it.
   *
   * The deadline is the same clock-read-per-statement mechanism as the write
   * path, for the same reason: `node:sqlite` is synchronous and exposes no
   * interrupt, so nothing can be cancelled mid-statement and the check has to
   * sit at statement boundaries.
   */
  readSnapshot<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (!READ_ONLY_OPERATION_CLASSES.has(operation)) {
      return Promise.reject(
        new Error(`storage: ${operation} is a write class and cannot open a read snapshot`)
      );
    }
    if (this.closing || this.closed) return Promise.reject(new Error(CLOSING_MESSAGE));
    if (inTransactionOn(this)) return Promise.reject(nestedConnectionRefusal(this));
    const deadline: SqliteDeadline | null =
      this.readSnapshotDeadlineMs > 0
        ? {
            expiresAt: Date.now() + this.readSnapshotDeadlineMs,
            operation,
            deadlineMs: this.readSnapshotDeadlineMs,
          }
        : null;
    const run = async (): Promise<T> => {
      const connection = this.connectionFor(operation, true, deadline);
      // WAL or nothing. Outside WAL a read transaction takes a SHARED lock that
      // blocks every writer until it ends, so a snapshot held for the analytical
      // bound would stall the whole gateway rather than merely read it. Measured
      // on a fresh file: the concurrent writer fails with "database is locked".
      //
      // `openDatabase` issues no pragmas by design (plan B2/B3); WAL is set by
      // the callers that own a file, so in production this refusal never fires.
      // It fires when someone points a snapshot at a file where the guarantee
      // does not hold, which is exactly when silence would be worst.
      const [mode] = await connection.query<{ journal_mode?: string }>("PRAGMA journal_mode");
      const journal = String(mode?.journal_mode ?? "").toLowerCase();
      if (journal !== "wal") {
        throw new Error(
          `storage: a read snapshot needs WAL, but this database is in "${journal}" mode, ` +
            `where a read transaction blocks writers for as long as it is held`
        );
      }
      await connection.execute("BEGIN DEFERRED");
      try {
        const result = await runInTransaction(this, () => fn(connection));
        if (deadline !== null && Date.now() >= deadline.expiresAt) {
          throw new StorageTransactionDeadlineError(
            "sqlite",
            deadline.operation,
            deadline.deadlineMs
          );
        }
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        // Same rule as the write path: the ROLLBACK must never replace the
        // error that caused it.
        try {
          await connection.execute("ROLLBACK");
        } catch (rollbackError) {
          if (error instanceof Error && error.cause === undefined) {
            error.cause = rollbackError;
          }
        }
        throw error;
      }
    };
    return run();
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
      // TWO mechanisms, covering DIFFERENT properties rather than the same one.
      // The deadline bounds work still QUEUED, which a timer cannot do because
      // a synchronous-engine queue starves the timers phase. The timer bounds a
      // transaction already IN FLIGHT and blocked on something real, where the
      // event loop IS reachable and a deadline nobody reads would never fire.
      // Neither covers the other's case, so both stay.
      this.drainDeadline = Date.now() + this.drainTimeoutMs;
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
