/**
 * PostgreSQL driver for the storage port.
 *
 * Holds one pool per configured role and routes each operation to the matching
 * credential (docs/plans/storage-unification.md 3.1). It does NOT reuse the
 * pool in `db.ts`: that one is built from `DATABASE_URL` and is not wired to
 * `[persistence]` at all.
 *
 * `pg` is an optional peer dependency, so the pool factory is injected and the
 * real one is imported dynamically. That also lets routing and translation be
 * tested without a server.
 */
import { assertAdmissiblePgDsn } from "../pg-dsn-gate.js";
import {
  READ_ONLY_OPERATION_CLASSES,
  resolveStorageRole,
  type StorageOperationClass,
  type StorageRole,
  type StorageRoleDsns,
} from "../roles.js";
import {
  STORAGE_READ_SNAPSHOT_DEADLINE_MS,
  STORAGE_TRANSACTION_DEADLINE_MS,
  StorageTransactionDeadlineError,
} from "../deadline.js";
import { inTransactionOn, nestedConnectionRefusal, runInTransaction } from "../reentrancy.js";
import { isTransactionControl, transactionControlRefusal } from "../statements.js";
import type { StorageConnection, StorageDriver, StorageEngine } from "../store.js";

/** The slice of `pg.PoolClient` this driver uses: one pinned backend. */
export interface PgClientLike {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  release(err?: Error): void;
}

/** The slice of `pg.Pool` this driver uses. */
export interface PgPoolLike {
  query(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: unknown[]; rowCount: number | null }>;
  /**
   * Check out one backend. Required, not optional: a transaction that cannot
   * pin a connection is the defect this interface exists to prevent, and an
   * optional method would let a fake pool omit it and pass anyway.
   */
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export type PgPoolFactory = (role: StorageRole, dsn: string) => PgPoolLike;

/** Per-role connection strings, as `[persistence.roles]` resolves them. */
export type PostgresRoleDsns = StorageRoleDsns;

/**
 * Rewrite `?` placeholders to `$1`-style, skipping any `?` inside a string
 * literal, a quoted identifier or a comment.
 *
 * Translation lives here, in the driver, and not in any caller: the s1 audit
 * counted 50 statements binding `?`, and a per-caller conditional would have
 * been 50 places to get it wrong. A naive global replace would corrupt a
 * literal such as `'why?'`, which is why this walks the string.
 */
export function toDollarPlaceholders(statement: string): string {
  let out = "";
  let index = 0;
  for (let i = 0; i < statement.length; i += 1) {
    const ch = statement[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      while (j < statement.length) {
        if (statement[j] === quote) {
          // Doubled quote is an escaped quote, not the end of the literal.
          if (statement[j + 1] === quote) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      out += statement.slice(i, j + 1);
      i = j;
      continue;
    }
    if (ch === "-" && statement[i + 1] === "-") {
      const end = statement.indexOf("\n", i);
      const stop = end === -1 ? statement.length : end;
      out += statement.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "/" && statement[i + 1] === "*") {
      const end = statement.indexOf("*/", i + 2);
      const stop = end === -1 ? statement.length : end + 2;
      out += statement.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (ch === "?") {
      index += 1;
      out += `$${index}`;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Wrap something that can run a statement.
 *
 * `transactionControl` is granted ONLY to the client `transaction()` checks
 * out. A pool-backed connection refuses it, so a transaction can never be
 * spread across whatever backends the pool happens to hand out.
 */
function connectionOver(
  handle: Pick<PgPoolLike, "query">,
  transactionControl: boolean
): StorageConnection {
  const run = async (
    statement: string,
    params: readonly unknown[]
  ): Promise<{ rows: unknown[]; rowCount: number | null }> => {
    if (!transactionControl && isTransactionControl(statement)) {
      throw transactionControlRefusal(statement);
    }
    return handle.query(toDollarPlaceholders(statement), params);
  };
  return {
    async query<T>(statement: string, params: readonly unknown[] = []): Promise<T[]> {
      return (await run(statement, params)).rows as T[];
    },
    async execute(
      statement: string,
      params: readonly unknown[] = []
    ): Promise<{ rowsAffected: number }> {
      return { rowsAffected: (await run(statement, params)).rowCount ?? 0 };
    },
    async executeScript(script: string): Promise<void> {
      // A parameterless query uses the simple query protocol, which already
      // accepts several statements, so this needs no separate mechanism here.
      // It exists on the port because SQLite genuinely cannot do it through
      // `execute`.
      await run(script, []);
    },
  };
}

export class PostgresStorageDriver implements StorageDriver {
  readonly engine: StorageEngine = "postgres";
  readonly roles: ReadonlySet<StorageRole>;

  private readonly pools = new Map<StorageRole, PgPoolLike>();
  private closed = false;
  private readonly transactionDeadlineMs: number;
  private readonly readSnapshotDeadlineMs: number;

  constructor(
    dsns: PostgresRoleDsns,
    createPool: PgPoolFactory,
    options: { transactionDeadlineMs?: number; readSnapshotDeadlineMs?: number } = {}
  ) {
    this.transactionDeadlineMs = options.transactionDeadlineMs ?? STORAGE_TRANSACTION_DEADLINE_MS;
    this.readSnapshotDeadlineMs =
      options.readSnapshotDeadlineMs ?? STORAGE_READ_SNAPSHOT_DEADLINE_MS;
    const held = new Set<StorageRole>();
    for (const [role, dsn] of Object.entries(dsns) as [StorageRole, string | undefined][]) {
      if (!dsn) continue;
      this.pools.set(role, createPool(role, dsn));
      held.add(role);
    }
    if (held.size === 0) {
      throw new Error("storage: postgres driver needs at least an `app` DSN");
    }
    this.roles = held;
  }

  private poolFor(operation: StorageOperationClass): PgPoolLike {
    if (this.closed) throw new Error("storage: postgres driver is closed");
    const { role } = resolveStorageRole(operation, this.roles);
    const pool = this.pools.get(role);
    if (!pool) throw new Error(`storage: no pool for resolved role "${role}"`);
    return pool;
  }

  /**
   * NOT bounded by the whole-operation deadline, deliberately.
   *
   * There is no pinned backend here to end: every statement goes through
   * `pool.query`, which checks out, runs and releases per statement. So there
   * is nothing to destroy and nothing holding an open transaction, each
   * statement is already bounded by `statement_timeout`, and there is no
   * pending `COMMIT` whose outcome a caller could be misled about.
   */
  async withConnection<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (inTransactionOn(this)) throw nestedConnectionRefusal(this);
    return fn(connectionOver(this.poolFor(operation), false));
  }

  /**
   * Run the whole body on ONE checked-out backend.
   *
   * Every statement, including the terminator, goes through the client. Issuing
   * them through the pool instead would let `BEGIN`, the writes and `COMMIT`
   * land on different connections, which also silently voids `SET LOCAL`,
   * `pg_advisory_xact_lock` and `FOR UPDATE`: all three are scoped to the
   * connection and transaction that issued them.
   *
   * BOUNDED AS A WHOLE, not per statement. `statement_timeout` bounds one
   * statement, so a body looping over its input has no aggregate bound at all:
   * `postgres-job-store-ops.ts` `setValidationProviderLinks` issues four
   * statements plus one per provider link.
   *
   * The deadline DESTROYS the connection rather than stopping waiting on it.
   * `release(err)` removes the client from the pool and ends it, and `pg` ends
   * a client with a query in flight by destroying the socket. `COMMIT` is a
   * client-issued command, so once the socket is gone the transaction CANNOT
   * commit: the backend aborts it when it next reaches the dead client. A
   * `Promise.race` would leave the client running and possibly committing while
   * the caller was told its write failed, which is the ambiguity the pool
   * timeouts below exist to remove.
   *
   * What destroying does NOT do is stop the backend promptly. PostgreSQL does
   * not check for a departed client while a statement runs unless
   * `client_connection_check_interval` is set, which is 0 by default and
   * platform-conditional, so the backend finishes or times out first. The
   * server-side residual is therefore bounded by `statement_timeout`, and a
   * protocol cancel would only shorten it: it does not end the transaction, so
   * a destroy is still needed after it, and reaching it means holding pg's
   * active Query object and a second connection out of a `max: 1` pool at the
   * moment that pool is already pathological.
   */
  async transaction<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (READ_ONLY_OPERATION_CLASSES.has(operation)) {
      throw new Error(`storage: ${operation} is a read class and cannot open a transaction`);
    }
    if (inTransactionOn(this)) throw nestedConnectionRefusal(this);
    const client = await this.poolFor(operation).connect();
    // A client whose ROLLBACK itself failed may still be inside a transaction.
    // `release(err)` destroys it instead of returning it to the pool, so the
    // next checkout cannot inherit an open transaction.
    let discard: Error | undefined;
    // Released at most once: the deadline and the `finally` below both release,
    // and pg-pool throws on a second release.
    let released = false;
    const release = (err?: Error): void => {
      if (released) return;
      released = true;
      client.release(err);
    };
    let expiry: StorageTransactionDeadlineError | undefined;
    // Read through a call so narrowing cannot conclude it is still undefined:
    // the only assignment is inside the timer callback.
    const expired = (): StorageTransactionDeadlineError | undefined => expiry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    if (this.transactionDeadlineMs > 0) {
      timer = setTimeout(() => {
        expiry = new StorageTransactionDeadlineError(
          "postgres",
          operation,
          this.transactionDeadlineMs
        );
        release(expiry);
      }, this.transactionDeadlineMs);
      // Never hold the event loop open just to time a transaction.
      timer.unref?.();
    }
    try {
      const connection = connectionOver(client, true);
      await connection.execute("BEGIN");
      try {
        const result = await runInTransaction(this, () => fn(connection));
        // Disarmed and checked in ONE synchronous block, before COMMIT is
        // issued. Timers run in the timers phase and cannot interleave with
        // straight-line code, so the deadline can never fire with COMMIT in
        // flight, which is the one case where destroying WOULD manufacture the
        // ambiguity this bound exists to remove.
        disarm();
        const deadline = expired();
        if (deadline) throw deadline;
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        const deadline = expired();
        if (deadline) {
          // No ROLLBACK: there is no connection left to roll back on, and the
          // backend aborts the transaction itself when it reaches the dead
          // client. Attempting it would only replace the useful error.
          if (deadline.cause === undefined && deadline !== error) deadline.cause = error;
          throw deadline;
        }
        try {
          await connection.execute("ROLLBACK");
        } catch (rollbackError) {
          discard =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      }
    } finally {
      disarm();
      release(discard);
    }
  }

  /**
   * A pinned REPEATABLE READ READ ONLY snapshot on one backend.
   *
   * The isolation level is set in the BEGIN itself because PostgreSQL fixes a
   * transaction's snapshot at its first query: `SET TRANSACTION` afterwards is
   * too late to be sure, and a verify that silently ran at READ COMMITTED would
   * report agreement it never had.
   *
   * `SET LOCAL statement_timeout` raises the per-statement bound for this
   * transaction only, reverting on commit. The pool's 25s is right for a
   * gateway query and wrong for a full-table scan, and changing it on the pool
   * would change it for every reader.
   *
   * READ ONLY is declared rather than assumed, so the engine refuses a write
   * that slipped into a read path instead of letting it land.
   */
  async readSnapshot<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (!READ_ONLY_OPERATION_CLASSES.has(operation)) {
      throw new Error(`storage: ${operation} is a write class and cannot open a read snapshot`);
    }
    if (inTransactionOn(this)) throw nestedConnectionRefusal(this);
    const client = await this.poolFor(operation).connect();
    let discard: Error | undefined;
    let released = false;
    const release = (err?: Error): void => {
      if (released) return;
      released = true;
      client.release(err);
    };
    let expiry: StorageTransactionDeadlineError | undefined;
    const expired = (): StorageTransactionDeadlineError | undefined => expiry;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const disarm = (): void => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    };
    if (this.readSnapshotDeadlineMs > 0) {
      timer = setTimeout(() => {
        expiry = new StorageTransactionDeadlineError(
          "postgres",
          operation,
          this.readSnapshotDeadlineMs
        );
        release(expiry);
      }, this.readSnapshotDeadlineMs);
      timer.unref?.();
    }
    try {
      const connection = connectionOver(client, true);
      await connection.execute("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      try {
        await connection.execute(`SET LOCAL statement_timeout = ${this.readSnapshotDeadlineMs}`);
        const result = await runInTransaction(this, () => fn(connection));
        disarm();
        const deadline = expired();
        if (deadline) throw deadline;
        // COMMIT, not ROLLBACK: nothing was written, and committing is how the
        // snapshot is released without the log noise of an aborted transaction.
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        const deadline = expired();
        if (deadline) {
          if (deadline.cause === undefined && deadline !== error) deadline.cause = error;
          throw deadline;
        }
        try {
          await connection.execute("ROLLBACK");
        } catch (rollbackError) {
          discard =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      }
    } finally {
      disarm();
      release(discard);
    }
  }

  /**
   * Compatibility bootstrap DDL. NOT a routed runtime operation, deliberately.
   *
   * The DAG (`storage-unification.dag.toml`, s5 `bootstrap_ddl`) rules that
   * this stays under `app` for now, because moving it is a grant change on a
   * live host that operator decision 0a held. It also rules that it must NOT be
   * dressed as one of the four operation classes: DDL is none of `write`,
   * `transcript_read`, `analytics_read` or `retention`, and giving it a class
   * is how a temporary arrangement becomes permanent, because once it has one
   * it looks like it belongs.
   *
   * So it is a separate method with a name that says what it is, running on the
   * `app` pool outside `resolveStorageRole`. A reader who greps for the
   * operation classes will not find it, which is the point: its exceptional
   * status is visible at the call site rather than hidden behind a class that
   * makes it look routine.
   *
   * It is also NOT bounded by the whole-operation deadline, for a reason the
   * routed classes do not share: how long DDL legitimately takes is a function
   * of how much data is already there, an index build on a large table being
   * the obvious case, so a fixed bound would turn a slow first start into a
   * refusal to start at all. It runs once, at startup, where a long wait is
   * visible rather than silent, and it is not the residual s13 names.
   */
  async bootstrap<T>(fn: (connection: StorageConnection) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("storage: postgres driver is closed");
    const pool = this.pools.get("app");
    if (!pool) throw new Error("storage: bootstrap DDL needs the `app` credential");
    if (inTransactionOn(this)) throw nestedConnectionRefusal(this);
    const client = await pool.connect();
    let discard: Error | undefined;
    try {
      const connection = connectionOver(client, true);
      await connection.execute("BEGIN");
      try {
        const result = await runInTransaction(this, () => fn(connection));
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        try {
          await connection.execute("ROLLBACK");
        } catch (rollbackError) {
          discard =
            rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
        throw error;
      }
    } finally {
      client.release(discard);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.pools.values()].map(pool => pool.end()));
    this.pools.clear();
  }
}

/**
 * Pool settings carried over verbatim from the worker this driver replaces
 * (postgres-job-store-worker.ts:310-324 at f68aef2). They are parity, not
 * preference, and each one is load bearing:
 *
 * `max: 1` USED to be incidental. Under the worker the parent's JobStore
 * interface was synchronous, so only one operation could be in flight and a
 * larger pool bought nothing. After the port the parent is concurrent, so it
 * has become load bearing, and raising it is a concurrency change rather than
 * a tuning change.
 *
 * It serialises CONNECTIONS, not OPERATIONS, and the difference matters. A
 * `transaction()` body holds one checked-out client for its whole duration, so
 * that IS serialised. `withConnection` does not: it runs each statement through
 * `pool.query`, which checks out, runs and releases per statement. So two
 * `withConnection` statements belonging to one logical operation can interleave
 * with another operation between them, which the worker's single in-flight RPC
 * made impossible. An earlier version of this comment called it "the connection
 * mutex that serialises store writes"; that overstated it, and a multi-statement
 * operation that needs atomicity must use `transaction()` rather than rely on
 * the pool size.
 *
 * The waiting behaviour is also a try-lock, not a queue without end: a caller
 * that cannot get the single client fails after `connectionTimeoutMillis`
 * rather than waiting for the holder.
 *
 * The timeouts exist so PostgreSQL aborts a blocked or pathological operation
 * rather than leaving the caller unsure whether its mutation landed.
 */
export const PG_POOL_MAX = 1;
export const PG_IDLE_TIMEOUT_MS = 30_000;
export const PG_STATEMENT_TIMEOUT_MS = 25_000;
export const PG_LOCK_TIMEOUT_MS = 5_000;
export const PG_QUERY_TIMEOUT_MS = 27_000;
export const PG_CONNECTION_TIMEOUT_MS = 5_000;
export const PG_APPLICATION_NAME = "llm-cli-gateway-job-store";

interface PgPoolConfig {
  connectionString: string;
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  statement_timeout?: number;
  lock_timeout?: number;
  query_timeout?: number;
  application_name: string;
}

/**
 * Per-subsystem pool settings.
 *
 * The constants above are the JOB STORE's, carried over from its worker as
 * parity rather than preference, and `max: 1` in particular is a concurrency
 * property that must not move. The session store arrives on this driver with
 * its own established settings (`db.ts`: ten connections, a ten second
 * statement timeout, and no lock or query timeout at all), and imposing the job
 * store's on it would be a behaviour change dressed as a refactor: one
 * connection where there were ten, and a five second lock timeout turning
 * `FOR UPDATE` contention from a wait into an error.
 *
 * So the settings are a parameter. A key left `undefined` is not sent, which is
 * how "no lock timeout" is expressed: `pg` treats an absent option and an
 * explicit zero differently.
 */
export interface PgPoolSettings {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMs?: number | null;
  lockTimeoutMs?: number | null;
  queryTimeoutMs?: number | null;
  applicationName?: string;
}

/** A pool that can report asynchronous failures on an idle backend. */
type PgPoolWithEvents = PgPoolLike & {
  on?(event: "error", listener: (error: Error) => void): unknown;
};

/**
 * Real `pg` pools, imported lazily so the optional peer stays optional.
 *
 * `onPoolError` is REQUIRED rather than optional. `pg` emits "error" on the
 * pool when a backend fails while idle, and an EventEmitter with no "error"
 * listener throws to the top of the process. The worker registered one
 * (`:325`); losing it in the port would turn a recoverable idle-pool error into
 * a crash, so the listener is attached here where the pool is built and cannot
 * be forgotten at a call site.
 */
export async function nodePostgresPoolFactory(
  onPoolError: (role: StorageRole, error: Error) => void,
  settings: PgPoolSettings = {}
): Promise<PgPoolFactory> {
  const pg = (await import("pg")) as unknown as {
    default?: { Pool: new (config: PgPoolConfig) => PgPoolLike };
    Pool?: new (config: PgPoolConfig) => PgPoolLike;
  };
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) throw new Error("storage: the optional peer dependency `pg` is not installed");
  return (role, dsn) => {
    // THE CONVERGENCE POINT. Every connector reaches pg through this factory:
    // db.ts, the flight recorder and the job store all build a
    // PostgresStorageDriver over it. Round 24 gated only db.ts, so a DSN the
    // reporter refused to name was still dialled by the other two. Gating the
    // factory is the only placement where "refused for reporting is refused
    // for connecting" cannot be reintroduced by adding a caller.
    assertAdmissiblePgDsn(dsn, role);
    const config: PgPoolConfig = {
      connectionString: dsn,
      max: settings.max ?? PG_POOL_MAX,
      idleTimeoutMillis: settings.idleTimeoutMillis ?? PG_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: settings.connectionTimeoutMillis ?? PG_CONNECTION_TIMEOUT_MS,
      application_name: settings.applicationName ?? PG_APPLICATION_NAME,
    };
    // `null` means "do not send this option", which is not the same as sending
    // zero. `undefined` means "keep the default".
    const statementTimeout = settings.statementTimeoutMs ?? PG_STATEMENT_TIMEOUT_MS;
    const lockTimeout =
      settings.lockTimeoutMs === undefined ? PG_LOCK_TIMEOUT_MS : settings.lockTimeoutMs;
    const queryTimeout =
      settings.queryTimeoutMs === undefined ? PG_QUERY_TIMEOUT_MS : settings.queryTimeoutMs;
    if (statementTimeout !== null) config.statement_timeout = statementTimeout;
    if (lockTimeout !== null) config.lock_timeout = lockTimeout;
    if (queryTimeout !== null) config.query_timeout = queryTimeout;
    const pool = new Pool(config) as PgPoolWithEvents;
    pool.on?.("error", error => onPoolError(role, error));
    return pool;
  };
}

/**
 * The session store's pool settings, carried across from `db.ts` unchanged.
 *
 * Ten connections because the session manager is called concurrently by every
 * in-flight request, and a `max: 1` pool would turn two simultaneous session
 * reads into a five second wait and then a connection timeout. No lock or query
 * timeout, because it had none.
 */
export const SESSION_POOL_SETTINGS: PgPoolSettings = {
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  statementTimeoutMs: 10_000,
  lockTimeoutMs: null,
  queryTimeoutMs: null,
  applicationName: "llm-cli-gateway-sessions",
};
