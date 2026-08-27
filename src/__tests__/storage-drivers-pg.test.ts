/**
 * Real-Postgres controls for PostgresStorageDriver.transaction.
 *
 * s4 tested the driver against an injected fake, which is why the
 * split-transaction defect survived: a fake pool that is one object cannot
 * express the property that a pg.Pool checks out a connection PER QUERY.
 * These run against the server `scripts/test-pg.sh` starts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  PostgresStorageDriver,
  type PgPoolLike,
  type PostgresRoleDsns,
} from "../storage/drivers/postgres.js";
import { StorageTransactionDeadlineError } from "../storage/deadline.js";
import type { StorageRole } from "../storage/roles.js";
import { TEST_DATABASE_URL } from "./setup.js";

/** Several backends, so "which connection ran this" is a real question. */
const POOL_MAX = 6;

describe("PostgresStorageDriver against a real server", () => {
  const pools: Pool[] = [];
  let driver: PostgresStorageDriver;
  let table: string;

  function factory(_role: StorageRole, dsn: string): PgPoolLike {
    const pool = new Pool({ connectionString: dsn, max: POOL_MAX });
    pools.push(pool);
    return pool as unknown as PgPoolLike;
  }

  beforeEach(async () => {
    const dsns: PostgresRoleDsns = { app: TEST_DATABASE_URL };
    driver = new PostgresStorageDriver(dsns, factory);
    table = `s5_tx_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await driver.withConnection("write", c =>
      c.execute(`CREATE TABLE ${table} (id int primary key, v text)`)
    );
  });

  afterEach(async () => {
    try {
      await driver.withConnection("write", c => c.execute(`DROP TABLE IF EXISTS ${table}`));
    } catch {
      // the driver may already be closed by a test
    }
    await driver.close();
    pools.length = 0;
  });

  it("runs every statement of a transaction on ONE backend, under concurrency", async () => {
    // The defect: BEGIN, the body and COMMIT each went through pool.query, so
    // with other work in flight they land on whichever backend is free. Eight
    // concurrent transactions against six backends make that certain.
    const pidsPerTransaction = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        driver.transaction("write", async c => {
          const seen: number[] = [];
          for (let step = 0; step < 4; step += 1) {
            const rows = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            seen.push(Number(rows[0].pid));
            await c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [i * 10 + step, "x"]);
          }
          return seen;
        })
      )
    );

    for (const seen of pidsPerTransaction) {
      expect(seen).toHaveLength(4);
      expect(new Set(seen).size).toBe(1);
    }

    const rows = await driver.withConnection("write", c =>
      c.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`)
    );
    expect(Number(rows[0].n)).toBe(32);
  });

  it("makes SET LOCAL and a transaction-scoped advisory lock visible to the body", async () => {
    // Both are scoped to the connection and transaction that issued them. On a
    // split transaction SET LOCAL applies to a backend that is not in the
    // transaction, so the bootstrap mutex at
    // postgres-job-store-worker.ts:341-343 would protect nothing while
    // appearing to work.
    //
    // The churn runs OUTSIDE the transaction body and is only awaited inside
    // it. Requesting a connection from inside the body is refused now, and
    // before it was refused it deadlocked: a body holds its connection for the
    // whole body, so asking the same pool for another one waits on itself.
    const churn = Promise.all(
      Array.from({ length: POOL_MAX - 1 }, () =>
        driver.withConnection("write", other => other.query("SELECT pg_backend_pid()"))
      )
    );

    await driver.transaction("write", async c => {
      await c.execute("SET LOCAL application_name = 's5_tx_probe'");

      // Let the churn cycle the pool's idle stack, so a statement served by
      // the POOL would now come back on a different backend. Without this the
      // pool returns the most recently released connection and a split
      // transaction reads its own backend by luck, which made this assertion
      // pass in both states and prove nothing.
      await churn;

      const name = await c.query<{ v: string }>("SELECT current_setting('application_name') AS v");
      expect(name[0].v).toBe("s5_tx_probe");

      await c.query("SELECT pg_advisory_xact_lock(?::bigint)", [987654321]);
      const held = await c.query<{ n: string }>(
        "SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()"
      );
      expect(Number(held[0].n)).toBe(1);
    });
  });

  it("refuses a nested connection request instead of deadlocking on itself", async () => {
    // Measured before the guard: eight transactions each requesting six more
    // connections from a six-connection pool hung for 150s and ended in a test
    // timeout, not an error. With the job store's max: 1 a single nested call
    // deadlocks at once. A rule would not have stopped it; this does.
    await expect(
      driver.transaction("write", async () => {
        await driver.withConnection("write", c => c.query("SELECT 1"));
      })
    ).rejects.toThrow(/transaction is already open/);

    await expect(
      driver.transaction("write", async () => {
        await driver.transaction("write", c => c.execute("SELECT 1"));
      })
    ).rejects.toThrow(/transaction is already open/);

    // The driver is still usable: the guard refuses the nested call, it does
    // not poison the driver or leak the outer transaction's client.
    await driver.transaction("write", c =>
      c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [7, "after-nested"])
    );
    const rows = await driver.withConnection("write", c =>
      c.query<{ v: string }>(`SELECT v FROM ${table} WHERE id = ?`, [7])
    );
    expect(rows[0].v).toBe("after-nested");
  });

  it("refuses the nested call on a max:1 pool, which is the job store's own shape", async () => {
    // POOL_MAX above leaves spare connections, so a single nested request there
    // merely succeeds when the guard is off. The job store runs max: 1
    // (postgres-job-store-worker.ts:24), where the nested request waits on the
    // connection the body is holding and never returns. This is that shape.
    const single = new PostgresStorageDriver({ app: TEST_DATABASE_URL }, (_role, dsn) => {
      const pool = new Pool({ connectionString: dsn, max: 1 });
      pools.push(pool);
      return pool as unknown as PgPoolLike;
    });

    await expect(
      single.transaction("write", async () => {
        await single.withConnection("write", c => c.query("SELECT 1"));
      })
    ).rejects.toThrow(/transaction is already open/);

    await single.close();
  });

  it("releases the client on failure, so the pool is not exhausted", async () => {
    // Without the finally, POOL_MAX failed transactions leak every backend and
    // the next connect() blocks forever.
    for (let i = 0; i < POOL_MAX + 2; i += 1) {
      await expect(
        driver.transaction("write", async c => {
          await c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [i, "doomed"]);
          throw new Error("body failed");
        })
      ).rejects.toThrow("body failed");
    }

    const ok = await driver.transaction("write", async c => {
      await c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [999, "kept"]);
      return "committed";
    });
    expect(ok).toBe("committed");

    const rows = await driver.withConnection("write", c =>
      c.query<{ id: number }>(`SELECT id FROM ${table} ORDER BY id`)
    );
    expect(rows.map(r => Number(r.id))).toEqual([999]);
  });

  it("refuses transaction control on a pooled connection", async () => {
    await expect(driver.withConnection("write", c => c.execute("BEGIN"))).rejects.toThrow(
      /transaction control/
    );

    // And the refusal left no transaction open on the backend it touched: a
    // later write commits normally rather than joining a stranded transaction.
    await driver.withConnection("write", c =>
      c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [1, "after"])
    );
    const rows = await driver.withConnection("write", c =>
      c.query<{ v: string }>(`SELECT v FROM ${table} WHERE id = ?`, [1])
    );
    expect(rows[0].v).toBe("after");
  });

  /**
   * s13: the whole-operation bound, against a real server.
   *
   * The blocking is real: a second connection holds a row lock and these pools
   * set no `lock_timeout`, so the contended statement blocks for as long as the
   * lock is held and the deadline is the only thing that can end it. Nothing
   * sleeps waiting for a timeout to maybe fire.
   *
   * The assertions are about the DATABASE, not the caller. A caller-side
   * rejection is what a `Promise.race` produces too, which is the shape the DAG
   * forbids; only the row state can tell them apart.
   */
  async function backendAlive(pid: number): Promise<boolean> {
    const rows = await driver.withConnection("write", c =>
      c.query<{ n: string }>("SELECT count(*) AS n FROM pg_stat_activity WHERE pid = ?", [pid])
    );
    return Number(rows[0].n) > 0;
  }

  async function waitUntil(done: () => Promise<boolean>, what: string): Promise<void> {
    const giveUpAt = Date.now() + 20_000;
    while (Date.now() < giveUpAt) {
      if (await done()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  /** BEGIN plus a row lock on id 1, held until the returned release is called. */
  async function holdRowLock(): Promise<() => Promise<void>> {
    const blocker = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const held = await blocker.connect();
    await held.query("BEGIN");
    await held.query(`UPDATE ${table} SET v = 'held' WHERE id = 1`);
    return async () => {
      await held.query("COMMIT");
      held.release();
      await blocker.end();
    };
  }

  it("destroys the connection on the bound, and the transaction cannot commit", async () => {
    const bounded = new PostgresStorageDriver({ app: TEST_DATABASE_URL }, factory, {
      transactionDeadlineMs: 500,
    });
    await driver.withConnection("write", c =>
      c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [1, "start"])
    );
    const releaseLock = await holdRowLock();

    let pid = 0;
    const attempt = bounded
      .transaction("write", async c => {
        const backend = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        pid = Number(backend[0].pid);
        await c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [2, "inside"]);
        await c.execute(`UPDATE ${table} SET v = 'racer' WHERE id = 1`);
      })
      .then<unknown, unknown>(
        () => "landed",
        (error: unknown) => error
      );

    expect(await attempt).toBeInstanceOf(StorageTransactionDeadlineError);
    expect(pid).toBeGreaterThan(0);

    // MEASURED rather than assumed, and it is the residual worth knowing:
    // PostgreSQL does not notice a departed client while a statement is running
    // unless client_connection_check_interval is set, which is 0 by default. So
    // the backend is still there immediately after the destroy, and what bounds
    // it from here is statement_timeout.
    expect(await backendAlive(pid)).toBe(true);

    await releaseLock();
    // Freed, the backend completes its statement, cannot answer a dead socket
    // and exits. THAT is what aborts the transaction.
    await waitUntil(async () => !(await backendAlive(pid)), "the destroyed backend to exit");

    const rows = await driver.withConnection("write", c =>
      c.query<{ id: number; v: string }>(`SELECT id, v FROM ${table} ORDER BY id`)
    );
    expect(rows.map(r => Number(r.id))).toEqual([1]);
    expect(rows[0].v).toBe("held");

    await bounded.close();
  });

  it("shows why a race-shaped bound is worse than none: the write lands anyway", async () => {
    // Not a test of the driver. It is the executable reason the driver destroys
    // instead of racing: same scenario, same caller-visible rejection, and the
    // mutation commits after the caller has been told it failed.
    const unbounded = new PostgresStorageDriver({ app: TEST_DATABASE_URL }, factory, {
      transactionDeadlineMs: 0,
    });
    await driver.withConnection("write", c =>
      c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [1, "start"])
    );
    const releaseLock = await holdRowLock();

    const work = unbounded.transaction("write", async c => {
      await c.execute(`INSERT INTO ${table} (id, v) VALUES (?, ?)`, [3, "raced"]);
      await c.execute(`UPDATE ${table} SET v = 'racer' WHERE id = 1`);
    });
    const raced = Promise.race([
      work,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("deadline")), 500)),
    ]).then<unknown, unknown>(
      () => "landed",
      (error: unknown) => error
    );
    expect(await raced).toMatchObject({ message: "deadline" });

    await releaseLock();
    await work;

    const rows = await driver.withConnection("write", c =>
      c.query<{ id: number; v: string }>(`SELECT id, v FROM ${table} ORDER BY id`)
    );
    expect(rows.map(r => Number(r.id))).toEqual([1, 3]);
    expect(rows[0].v).toBe("racer");

    await unbounded.close();
  });

  it("leaves an unbounded transaction's client in the pool, under a max:1 shape", async () => {
    // Control for the destroy: a transaction that stays inside the bound must
    // hand its backend back rather than have it thrown away. max: 1 makes that
    // observable, because a reused client is the same backend pid.
    const single = new PostgresStorageDriver(
      { app: TEST_DATABASE_URL },
      (_role, dsn) => {
        const pool = new Pool({ connectionString: dsn, max: 1 });
        pools.push(pool);
        return pool as unknown as PgPoolLike;
      },
      { transactionDeadlineMs: 60_000 }
    );

    const pidOf = (): Promise<number> =>
      single.transaction("write", async c => {
        const rows = await c.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        return Number(rows[0].pid);
      });

    const first = await pidOf();
    expect(await pidOf()).toBe(first);

    await single.close();
  });
});
