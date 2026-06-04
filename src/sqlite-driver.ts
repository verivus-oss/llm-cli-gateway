/**
 * sqlite-driver: thin adapter over Node's built-in `node:sqlite`
 * (`DatabaseSync` / `StatementSync`).
 *
 * Phase B of docs/plans/node-sqlite-migration-2.0.0.md (2.0.0). This is the
 * single shared module both persistence consumers (flight-recorder.ts,
 * job-store.ts) import in unit B2, replacing the two
 * `createRequire(...)("better-sqlite3")` blocks.
 *
 * Scope (plan B2/B3): the adapter is a thin connection/statement/transaction
 * wrapper ONLY. WAL and other pragmas (journal_mode, foreign_keys,
 * synchronous=NORMAL) are NOT set here — B3 keeps every pragma in the
 * consumers, issued via `db.exec("PRAGMA ...")`. The driver merely must not
 * break those flows (validated by the WAL pragma round-trip test in B8).
 *
 * Contract notes:
 * - `GatewayStatement.run()` returns `{ changes, lastInsertRowid }` and is
 *   NEVER void: job-store.ts:412,421 reads `.changes` (orphan-mark and
 *   eviction counts). node:sqlite's StatementSync.run() already returns that
 *   shape; we pass it through and pin the TYPE to the contract above.
 *   `get`/`all` are required-and-always-implemented (the plan shows them
 *   optional; round-2 review endorsed narrowing to required — see §10 Q3).
 * - Both binding styles are supported via variadic `run(...args)`: bare
 *   `@name` objects (`run({ id, x })`) AND positional `?` args (`run(a, b)`).
 *   On Node >= 24.4 `allowBareNamedParameters` defaults to true, so bare
 *   `@name` objects bind without `setAllowBareNamedParameters` (plan B7;
 *   engines floor >=24.4.0). We deliberately do NOT call
 *   setAllowBareNamedParameters.
 * - Integers: default number mode (no `readBigInts`); node:sqlite types
 *   `lastInsertRowid` as `number | bigint`, so the contract does too.
 *
 * Graceful degradation: `node:sqlite` is loaded lazily inside the open
 * functions via the same `createRequire` idiom flight-recorder.ts:195 used
 * for better-sqlite3. A load/open failure throws a catchable Error rather
 * than crashing module load, preserving the consumers' try/catch
 * recorder-disabled path (createFlightRecorder → NoopFlightRecorder).
 */
import { existsSync, mkdirSync } from "fs";
import path from "path";
import { createRequire } from "module";

export interface GatewayStatement {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface GatewayDatabase {
  exec(sql: string): void;
  prepare(sql: string): GatewayStatement;
  withTransaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}

/**
 * Minimal structural shapes for the slice of `node:sqlite` we use. Declared
 * locally so the module type-checks without `@types/node` exposing the
 * `node:sqlite` surface, and so the lazy `require` result can be cast.
 */
interface NodeStatementSync {
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface NodeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NodeStatementSync;
  close(): void;
}

interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => NodeDatabaseSync;
}

function loadNodeSqlite(): NodeSqliteModule {
  // Lazy load mirroring flight-recorder.ts:194-195 — keeps any load failure
  // catchable by the consumer's constructor try/catch instead of failing at
  // module-import time.
  const require = createRequire(import.meta.url);
  return require("node:sqlite") as NodeSqliteModule;
}

/**
 * Wraps a raw `node:sqlite` StatementSync as a `GatewayStatement`. The shapes
 * are already structurally compatible; the wrapper exists only to pin the
 * exact contract type and keep a single coercion point.
 */
function wrapStatement(stmt: NodeStatementSync): GatewayStatement {
  return {
    run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint } {
      return stmt.run(...args);
    },
    get(...args: unknown[]): unknown {
      return stmt.get(...args);
    },
    all(...args: unknown[]): unknown[] {
      return stmt.all(...args);
    },
  };
}

class GatewayDatabaseImpl implements GatewayDatabase {
  private inTransaction = false;

  constructor(private readonly db: NodeDatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): GatewayStatement {
    return wrapStatement(this.db.prepare(sql));
  }

  /**
   * Replaces better-sqlite3's `db.transaction(fn)`. Returns a wrapped
   * function that, on each call, runs `BEGIN` (deferred — matches
   * better-sqlite3's default) / `fn(...args)` / `COMMIT`, rolling back on
   * throw and re-throwing the original error.
   *
   * Nesting is not emulated (no savepoints): the codebase never nests its
   * two transaction call sites, so re-entry throws `Error('nested
   * transaction')` rather than silently corrupting the BEGIN/COMMIT pairing.
   *
   * A ROLLBACK failure during error handling must not mask the original
   * error: any ROLLBACK throw is swallowed so the caller sees the real cause.
   */
  withTransaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
    return (...args: A): void => {
      if (this.inTransaction) {
        throw new Error("nested transaction");
      }
      this.inTransaction = true;
      this.db.exec("BEGIN");
      try {
        fn(...args);
        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // Swallow: a ROLLBACK failure must not mask the original error.
        }
        throw error;
      } finally {
        this.inTransaction = false;
      }
    };
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open a read/write SQLite database at `dbPath`, creating the parent
 * directory if missing.
 *
 * Dir-creation ownership: this adapter owns parent-directory creation. Today
 * both consumers do their own `mkdirSync(dirname, { recursive: true })`
 * (flight-recorder.ts:197-200, job-store.ts:188-191); when B2 rewires them
 * onto `openDatabase`, that consumer-side mkdir becomes redundant and may be
 * dropped — `recursive: true` makes the duplication harmless either way, so
 * B2 is not forced to remove it in lockstep.
 *
 * No pragmas are issued here (plan B2/B3): WAL/foreign_keys/synchronous stay
 * in the consumers.
 *
 * Throws a catchable Error if the module load or the open fails (e.g.
 * unwritable path), preserving consumer graceful degradation.
 */
export function openDatabase(dbPath: string): GatewayDatabase {
  const { DatabaseSync } = loadNodeSqlite();

  const directory = path.dirname(dbPath);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  return new GatewayDatabaseImpl(new DatabaseSync(dbPath));
}

/**
 * Open a dedicated read-only connection at `dbPath` via
 * `new DatabaseSync(path, { readOnly: true })`. Write attempts fail at the
 * SQLite engine level (SQLITE_READONLY), replacing better-sqlite3's
 * JS-level `stmt.readonly` property check (plan B4) with a strictly stronger
 * engine-level guard.
 *
 * Does NOT create the directory or file: opening a nonexistent path throws
 * (a read-only connection has nothing to create).
 */
export function openReadOnly(dbPath: string): GatewayDatabase {
  const { DatabaseSync } = loadNodeSqlite();
  return new GatewayDatabaseImpl(new DatabaseSync(dbPath, { readOnly: true }));
}
