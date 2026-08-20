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
import { resolveStorageRole, type StorageOperationClass, type StorageRole } from "../roles.js";
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

/** Per-role connection strings. A role with no DSN is simply not held. */
export type PostgresRoleDsns = Partial<Record<StorageRole, string>>;

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
  };
}

export class PostgresStorageDriver implements StorageDriver {
  readonly engine: StorageEngine = "postgres";
  readonly roles: ReadonlySet<StorageRole>;

  private readonly pools = new Map<StorageRole, PgPoolLike>();
  private closed = false;

  constructor(dsns: PostgresRoleDsns, createPool: PgPoolFactory) {
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

  async withConnection<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
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
   */
  async transaction<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T> {
    if (operation === "transcript_read" || operation === "analytics_read") {
      throw new Error(`storage: ${operation} is a read class and cannot open a transaction`);
    }
    const client = await this.poolFor(operation).connect();
    // A client whose ROLLBACK itself failed may still be inside a transaction.
    // `release(err)` destroys it instead of returning it to the pool, so the
    // next checkout cannot inherit an open transaction.
    let discard: Error | undefined;
    try {
      const connection = connectionOver(client, true);
      await connection.execute("BEGIN");
      try {
        const result = await fn(connection);
        await connection.execute("COMMIT");
        return result;
      } catch (error) {
        try {
          await connection.execute("ROLLBACK");
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
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

/** Real `pg` pools, imported lazily so the optional peer stays optional. */
export async function nodePostgresPoolFactory(): Promise<PgPoolFactory> {
  const pg = (await import("pg")) as unknown as {
    default?: { Pool: new (config: { connectionString: string }) => PgPoolLike };
    Pool?: new (config: { connectionString: string }) => PgPoolLike;
  };
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) throw new Error("storage: the optional peer dependency `pg` is not installed");
  return (_role, dsn) => new Pool({ connectionString: dsn });
}
