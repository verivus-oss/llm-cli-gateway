/**
 * s4 of docs/plans/storage-unification.dag.toml: the two SQL drivers.
 *
 * Two implementations from the start, because a port with one driver only ever
 * fits that driver. The Postgres pool is injected, so routing and translation
 * are tested without a server.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStorageDriver } from "../storage/drivers/sqlite.js";
import {
  PostgresStorageDriver,
  toDollarPlaceholders,
  type PgPoolLike,
} from "../storage/drivers/postgres.js";
import { roleSeparationInForce, type StorageRole } from "../storage/roles.js";

describe("toDollarPlaceholders", () => {
  it("numbers placeholders in order", () => {
    expect(toDollarPlaceholders("SELECT * FROM r WHERE a = ? AND b = ? AND c = ?")).toBe(
      "SELECT * FROM r WHERE a = $1 AND b = $2 AND c = $3"
    );
  });

  it("leaves a question mark inside a string literal alone", () => {
    // A global replace would corrupt this, and the corruption is silent: the
    // statement still parses, it just binds the wrong number of parameters.
    expect(toDollarPlaceholders("SELECT 'why?' AS q WHERE a = ?")).toBe(
      "SELECT 'why?' AS q WHERE a = $1"
    );
    expect(toDollarPlaceholders(`SELECT "od?d" FROM t WHERE a = ?`)).toBe(
      `SELECT "od?d" FROM t WHERE a = $1`
    );
  });

  it("handles a doubled quote inside a literal without losing the string", () => {
    expect(toDollarPlaceholders("SELECT 'it''s ok?' WHERE a = ?")).toBe(
      "SELECT 'it''s ok?' WHERE a = $1"
    );
  });

  it("leaves question marks in comments alone", () => {
    expect(toDollarPlaceholders("SELECT 1 -- really?\nWHERE a = ?")).toBe(
      "SELECT 1 -- really?\nWHERE a = $1"
    );
    expect(toDollarPlaceholders("SELECT /* huh? */ 1 WHERE a = ?")).toBe(
      "SELECT /* huh? */ 1 WHERE a = $1"
    );
  });

  it("is a no-op on a statement with no placeholders", () => {
    expect(toDollarPlaceholders("SELECT 1")).toBe("SELECT 1");
  });

  it("cannot tell jsonb's key-exists OPERATOR from a placeholder", () => {
    // Not a defect in this function: `?` is both, and nothing in the statement
    // says which. It is a trap for every caller, and the session store walked
    // into it: eight `metadata ? 'kit'` predicates became `metadata $1 'kit'`
    // and failed with `syntax error at or near "$1"` the moment they went
    // through the driver. Recorded here so the next author writing a jsonb
    // predicate finds the reason to spell it `jsonb_exists(metadata, 'kit')`,
    // which is the same operator by its function name.
    expect(toDollarPlaceholders("SELECT 1 WHERE metadata ? 'kit'")).toBe(
      "SELECT 1 WHERE metadata $1 'kit'"
    );
    expect(toDollarPlaceholders("SELECT 1 WHERE jsonb_exists(metadata, 'kit')")).toBe(
      "SELECT 1 WHERE jsonb_exists(metadata, 'kit')"
    );
  });
});

describe("SqliteStorageDriver", () => {
  let dir: string;
  let driver: SqliteStorageDriver;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "storage-sqlite-"));
    driver = new SqliteStorageDriver(join(dir, "t.db"));
    await driver.withConnection("write", c =>
      c.execute("CREATE TABLE t (id TEXT PRIMARY KEY, v TEXT)")
    );
  });

  afterEach(async () => {
    await driver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("prepares each distinct statement ONCE per handle, and reuses it", async () => {
    // The subsystems moving onto this port prepared their statements once in a
    // constructor and reused them: SqliteJobStore alone holds 27 such fields.
    // Without a cache the port would re-prepare on every call and be a straight
    // throughput regression against the code it replaces.
    //
    // Counting real prepare() calls rather than asserting the cache exists: a
    // test that reads the Map would still pass if connectionOver stopped
    // consulting it.
    const prepared: string[] = [];
    const handle = (driver as unknown as { writable: { prepare: (sql: string) => unknown } })
      .writable;
    const realPrepare = handle.prepare.bind(handle);
    handle.prepare = (sql: string) => {
      prepared.push(sql);
      return realPrepare(sql);
    };

    const insert = "INSERT INTO t VALUES (?, ?)";
    for (const id of ["p1", "p2", "p3"]) {
      await driver.withConnection("write", c => c.execute(insert, [id, id]));
    }
    await driver.withConnection("write", c => c.execute("DELETE FROM t WHERE id = ?", ["p3"]));

    // Three executions of one statement, one preparation of it.
    expect(prepared.filter(sql => sql === insert)).toHaveLength(1);
    // A DIFFERENT statement is still prepared, so the cache is keyed, not stuck.
    expect(prepared).toContain("DELETE FROM t WHERE id = ?");
    // And the writes actually landed, so the cached statement is still bound.
    const rows = await driver.withConnection("analytics_read", c =>
      c.query<{ id: string }>("SELECT id FROM t ORDER BY id")
    );
    expect(rows.map(r => r.id)).toEqual(["p1", "p2"]);
  });

  it("round-trips a write and a read", async () => {
    await driver.withConnection("write", c => c.execute("INSERT INTO t VALUES (?, ?)", ["a", "1"]));

    const rows = await driver.withConnection("analytics_read", c =>
      c.query<{ id: string; v: string }>("SELECT id, v FROM t")
    );
    expect(rows).toEqual([{ id: "a", v: "1" }]);
  });

  it("holds exactly one credential, and says separation is not in force", () => {
    // SQLite has no database identities. Reporting that plainly is the point:
    // a deployment must not read "postgres-grade separation" into a file.
    expect([...driver.roles]).toEqual(["app"]);
    expect(roleSeparationInForce(driver.roles)).toBe(false);
  });

  it("sends reads to a read-only connection, so a disguised write fails at the engine", async () => {
    await expect(
      driver.withConnection("transcript_read", c => c.execute("INSERT INTO t VALUES ('x', 'y')"))
    ).rejects.toThrow(/readonly/i);

    const rows = await driver.withConnection("write", c => c.query("SELECT id FROM t"));
    expect(rows).toEqual([]);
  });

  it("commits a transaction that resolves", async () => {
    await driver.transaction("write", async c => {
      await c.execute("INSERT INTO t VALUES (?, ?)", ["tx", "kept"]);
    });

    const rows = await driver.withConnection("write", c => c.query("SELECT id FROM t"));
    expect(rows).toEqual([{ id: "tx" }]);
  });

  it("ROLLS BACK a transaction whose body rejects", async () => {
    // The first implementation used the adapter's synchronous withTransaction,
    // which committed before the awaited body settled: a rejection landed after
    // the commit and the write survived. This is that regression.
    await expect(
      driver.transaction("write", async c => {
        await c.execute("INSERT INTO t VALUES (?, ?)", ["doomed", "x"]);
        throw new Error("body failed");
      })
    ).rejects.toThrow("body failed");

    const rows = await driver.withConnection("write", c => c.query("SELECT id FROM t"));
    expect(rows).toEqual([]);
  });

  it("serialises transactions, and one failure does not poison the next", async () => {
    // BOTH submitted before either is awaited. That concurrency IS the test:
    // awaiting each at its declaration makes them sequential and the queue is
    // never exercised, which is how this assertion silently stopped testing
    // serialisation while still passing.
    const failing = driver
      .transaction("write", async () => {
        throw new Error("first fails");
      })
      .catch(() => "failed");
    const succeeding = driver.transaction("write", async c => {
      await c.execute("INSERT INTO t VALUES (?, ?)", ["second", "ok"]);
      return "ok";
    });

    expect(await failing).toBe("failed");
    expect(await succeeding).toBe("ok");
  });

  it("serialises overlapping transactions instead of interleaving them", async () => {
    // One connection cannot nest BEGIN. Without the queue two callers awaiting
    // concurrently interleave, and the second BEGIN either errors or silently
    // joins the first transaction. This asserts the ordering, which the
    // outcome-only test above cannot see.
    const order: string[] = [];
    const body = (tag: string) => async () => {
      order.push(`${tag}:start`);
      await Promise.resolve();
      await Promise.resolve();
      order.push(`${tag}:end`);
    };

    await Promise.all([
      driver.transaction("write", body("A")),
      driver.transaction("write", body("B")),
    ]);

    expect(order).toEqual(["A:start", "A:end", "B:start", "B:end"]);
  });

  it("refuses to open a transaction on a read class", async () => {
    // Rejects rather than throws: an async surface that sometimes throws
    // synchronously cannot be handled with .catch() by any caller.
    await expect(driver.transaction("analytics_read", async () => undefined)).rejects.toThrow(
      /read class/
    );
  });

  it("refuses transaction control on a connection from withConnection", async () => {
    // Different engine reason, same rule: a caller-issued BEGIN would bypass
    // the queue that transaction() serialises on, on a connection that cannot
    // nest one.
    for (const statement of ["BEGIN", "begin immediate", "COMMIT", "ROLLBACK"]) {
      await expect(driver.withConnection("write", c => c.execute(statement))).rejects.toThrow(
        /transaction control/
      );
    }

    // The driver's own transaction still works, so the guard is scoped to the
    // pooled/unpinned path and has not simply disabled transactions.
    await driver.transaction("write", c => c.execute("INSERT INTO t VALUES (?, ?)", ["ok", "1"]));
    const rows = await driver.withConnection("write", c => c.query("SELECT id FROM t"));
    expect(rows).toEqual([{ id: "ok" }]);
  });

  it("DRAINS queued transactions on close instead of losing them", async () => {
    // TRACK B's reproduction: 8 queued transactions, close() returned in
    // 0.24ms, all 8 rejected with "driver is closed", 0 rows landed. close()
    // shut both handles and resolved without ever awaiting `queue`.
    const submitted = Array.from({ length: 8 }, (_unused, i) =>
      driver.transaction("write", async c => {
        // Yield, so every one of these is genuinely still queued when close()
        // is called rather than having already run to completion.
        await Promise.resolve();
        await c.execute("INSERT INTO t VALUES (?, ?)", [`drain-${i}`, "kept"]);
      })
    );

    await driver.close();

    const settled = await Promise.allSettled(submitted);
    expect(settled.filter(r => r.status === "rejected")).toEqual([]);

    // Reopen and count: the assertion that matters is rows on disk, not that
    // the promises resolved.
    const reopened = new SqliteStorageDriver(join(dir, "t.db"));
    const rows = await reopened.withConnection("write", c =>
      c.query<{ id: string }>("SELECT id FROM t ORDER BY id")
    );
    await reopened.close();
    expect(rows.map(r => r.id)).toEqual([
      "drain-0",
      "drain-1",
      "drain-2",
      "drain-3",
      "drain-4",
      "drain-5",
      "drain-6",
      "drain-7",
    ]);
  });

  it("refuses NEW work while draining, so the queue cannot outrun close", async () => {
    const queued = driver.transaction("write", async c => {
      await Promise.resolve();
      await c.execute("INSERT INTO t VALUES (?, ?)", ["first", "1"]);
    });
    // NOT awaited: the refusal below must happen WHILE the drain is in flight.
    // Awaiting here turns this into "refuses after closed", which is a
    // different and much weaker claim that also passes.
    const closing = driver.close();

    await expect(
      driver.transaction("write", c => c.execute("INSERT INTO t VALUES (?, ?)", ["late", "2"]))
    ).rejects.toThrow(/not accepting new work/);

    await closing;
    await expect(queued).resolves.toBeUndefined();
  });

  it("bounds the drain, and tells the caller its write did not land", async () => {
    // An unbounded wait is not an option: executor.ts SIGKILLs 3s after
    // SIGTERM, so a drain that outlives that is a process killed mid-write.
    const slow = new SqliteStorageDriver(join(dir, "slow.db"), { drainTimeoutMs: 25 });
    await slow.withConnection("write", c => c.execute("CREATE TABLE t (id TEXT PRIMARY KEY)"));

    let release = (): void => undefined;
    const blocked = new Promise<void>(resolve => {
      release = resolve;
    });

    const held = slow.transaction("write", async () => {
      await blocked;
    });
    const stranded = slow.transaction("write", c =>
      c.execute("INSERT INTO t VALUES (?)", ["stranded"])
    );

    const startedAt = Date.now();
    await slow.close();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);

    release();
    await held.catch(() => undefined);

    // Rejected, not silently dropped, and the message says the write is lost
    // rather than leaving the caller to infer it.
    await expect(stranded).rejects.toThrow(/did NOT land/);
  });

  it("refuses a nested connection request instead of hanging on its own queue", async () => {
    // SQLite deadlocks for a different reason with the same shape: transaction()
    // serialises on `queue`, so a nested transaction waits behind the very
    // transaction that is calling it. Same guard, keyed by driver instance.
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

    // The queue is not poisoned by the refusals.
    await driver.transaction("write", c => c.execute("INSERT INTO t VALUES (?, ?)", ["ok", "1"]));
    const rows = await driver.withConnection("write", c => c.query("SELECT id FROM t"));
    expect(rows).toEqual([{ id: "ok" }]);
  });

  it("does not refuse a nested call on a DIFFERENT driver", async () => {
    // The guard is keyed by driver instance, so a body that legitimately
    // touches another store is unaffected. Keying it on a module-level flag
    // would have broken this.
    const other = new SqliteStorageDriver(join(dir, "other.db"));
    await other.withConnection("write", c => c.execute("CREATE TABLE o (id TEXT)"));

    await driver.transaction("write", async c => {
      await c.execute("INSERT INTO t VALUES (?, ?)", ["outer", "1"]);
      await other.withConnection("write", inner =>
        inner.execute("INSERT INTO o VALUES (?)", ["x"])
      );
    });

    const rows = await other.withConnection("write", c => c.query("SELECT id FROM o"));
    expect(rows).toEqual([{ id: "x" }]);
    await other.close();
  });

  it("ENFORCES the drain bound against a microtask-only queue", async () => {
    // The bound was `Promise.race([queue, setTimeout(...)])`. node:sqlite is
    // synchronous, so the queue is an unbroken microtask chain and Node never
    // reaches the timers phase while it drains: the timeout was starved by the
    // work it bounded. Measured at depth 500, the drain overran a 2000 ms bound
    // by 2598 ms and abandoned nothing.
    //
    // This asserts the BOUND, not the drain. The pre-existing drain test passes
    // whether or not the bound fires, which is exactly why the defect survived.
    const bounded = new SqliteStorageDriver(join(dir, "bounded.db"), { drainTimeoutMs: 150 });
    await bounded.withConnection("write", c =>
      c.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    );

    const submitted = Array.from({ length: 500 }, (_unused, i) =>
      bounded
        .transaction("write", async c => {
          await c.execute("INSERT INTO t VALUES (?, ?)", [i, "x".repeat(200)]);
        })
        .then(
          () => "landed",
          (err: Error) => (/did NOT land/.test(err.message) ? "abandoned" : "other")
        )
    );

    const startedAt = Date.now();
    await bounded.close();
    const elapsed = Date.now() - startedAt;

    const outcomes = await Promise.all(submitted);
    const abandoned = outcomes.filter(o => o === "abandoned").length;

    // The bound fired: work was abandoned rather than all 500 draining.
    expect(abandoned).toBeGreaterThan(0);
    expect(outcomes.filter(o => o === "other")).toEqual([]);
    // And it fired NEAR the bound. Generous ceiling, because the point is that
    // it is bounded at all, not that it is precise: unbounded was 2598 ms over.
    expect(elapsed).toBeLessThan(150 * 6);
  });

  it("does NOT abandon a queue that fits inside the bound", async () => {
    // Control. A close() that abandoned everything would satisfy the test above
    // while being just as broken in the other direction.
    const roomy = new SqliteStorageDriver(join(dir, "roomy.db"), { drainTimeoutMs: 5000 });
    await roomy.withConnection("write", c => c.execute("CREATE TABLE t (id INTEGER PRIMARY KEY)"));

    const submitted = Array.from({ length: 20 }, (_unused, i) =>
      roomy.transaction("write", async c => {
        await c.execute("INSERT INTO t VALUES (?)", [i]);
      })
    );
    await roomy.close();

    const settled = await Promise.allSettled(submitted);
    expect(settled.filter(r => r.status === "rejected")).toEqual([]);
  });

  it("refuses work after close", async () => {
    await driver.close();
    await expect(driver.withConnection("write", c => c.query("SELECT 1"))).rejects.toThrow(
      /closed/
    );
  });
});

describe("PostgresStorageDriver", () => {
  interface Seen {
    role: StorageRole;
    text: string;
    values: unknown[];
    /** Which backend ran it. "pool" means an unpinned per-query checkout. */
    backend: string;
  }

  /**
   * A fake that models the property that matters: a `pg.Pool` checks out a
   * connection PER QUERY, so two `pool.query` calls need not share a backend,
   * while `connect()` pins one until it is released.
   *
   * The previous fake was a single object serving both, which is exactly why
   * the split-transaction defect passed s4: no assertion over it could tell a
   * pool from a client.
   */
  function fakePool(seen: Seen[], released: string[] = []) {
    return (role: StorageRole): PgPoolLike => {
      let nextBackend = 0;
      return {
        query(text: string, values: readonly unknown[] = []) {
          nextBackend += 1;
          seen.push({ role, text, values: [...values], backend: `pool-${nextBackend}` });
          return Promise.resolve({ rows: [], rowCount: 0 });
        },
        connect() {
          nextBackend += 1;
          const backend = `client-${nextBackend}`;
          return Promise.resolve({
            query(text: string, values: readonly unknown[] = []) {
              seen.push({ role, text, values: [...values], backend });
              return Promise.resolve({ rows: [], rowCount: 0 });
            },
            release: () => released.push(backend),
          });
        },
        end: () => Promise.resolve(),
      };
    };
  }

  it("routes each operation class to its own pool", async () => {
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver(
      { app: "a", reader: "r", analytics: "n", retention: "t" },
      fakePool(seen)
    );

    await driver.withConnection("write", c => c.execute("UPDATE t SET v = ?", [1]));
    await driver.withConnection("transcript_read", c => c.query("SELECT prompt FROM requests"));
    await driver.withConnection("analytics_read", c => c.query("SELECT count(*) FROM requests"));
    await driver.withConnection("retention", c => c.execute("DELETE FROM t WHERE id = ?", ["x"]));

    expect(seen.map(s => s.role)).toEqual(["app", "reader", "analytics", "retention"]);
    expect(roleSeparationInForce(driver.roles)).toBe(true);
    await driver.close();
  });

  it("degrades to app when only app is configured, and says so", async () => {
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.withConnection("transcript_read", c => c.query("SELECT prompt FROM requests"));

    expect(seen[0].role).toBe("app");
    expect(roleSeparationInForce(driver.roles)).toBe(false);
    await driver.close();
  });

  it("translates placeholders on the way to the pool", async () => {
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.withConnection("write", c =>
      c.execute("INSERT INTO t (a, b) VALUES (?, ?)", [1, 2])
    );

    expect(seen[0].text).toBe("INSERT INTO t (a, b) VALUES ($1, $2)");
    expect(seen[0].values).toEqual([1, 2]);
    await driver.close();
  });

  it("wraps a transaction in BEGIN and COMMIT, and ROLLBACK on failure", async () => {
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.transaction("write", c => c.execute("INSERT INTO t VALUES (?)", [1]));
    expect(seen.map(s => s.text)).toEqual(["BEGIN", "INSERT INTO t VALUES ($1)", "COMMIT"]);

    seen.length = 0;
    await expect(
      driver.transaction("write", async () => {
        throw new Error("nope");
      })
    ).rejects.toThrow("nope");
    expect(seen.map(s => s.text)).toEqual(["BEGIN", "ROLLBACK"]);
    await driver.close();
  });

  it("runs BEGIN, the body and COMMIT on ONE checked-out backend", async () => {
    // The defect this replaces: BEGIN, the writes and COMMIT each went through
    // pool.query, and a pg.Pool checks out a connection per query. The
    // transaction then spans however many backends the pool handed out, which
    // also silently voids SET LOCAL, pg_advisory_xact_lock and FOR UPDATE.
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.transaction("write", async c => {
      await c.execute("INSERT INTO t VALUES (?)", [1]);
      await c.execute("UPDATE t SET v = ?", [2]);
    });

    expect(seen.map(s => s.text)).toEqual([
      "BEGIN",
      "INSERT INTO t VALUES ($1)",
      "UPDATE t SET v = $1",
      "COMMIT",
    ]);
    expect(new Set(seen.map(s => s.backend)).size).toBe(1);
    expect(seen.every(s => s.backend.startsWith("client-"))).toBe(true);
    await driver.close();
  });

  it("releases the client even when the body throws", async () => {
    const seen: Seen[] = [];
    const released: string[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen, released));

    await expect(
      driver.transaction("write", async () => {
        throw new Error("body failed");
      })
    ).rejects.toThrow("body failed");

    // Without the finally, a pool with a bounded size is exhausted by N
    // failures and every later transaction blocks forever on connect().
    expect(released).toHaveLength(1);
    expect(seen.map(s => s.text)).toEqual(["BEGIN", "ROLLBACK"]);
    expect(new Set(seen.map(s => s.backend)).size).toBe(1);
    await driver.close();
  });

  it("refuses transaction control on a connection from withConnection", async () => {
    // Structural, not advisory: a pooled connection cannot carry a transaction,
    // so opening one there is made unrepresentable rather than merely absent.
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    for (const statement of ["BEGIN", "commit", " ROLLBACK", "SAVEPOINT s1", "END"]) {
      await expect(driver.withConnection("write", c => c.execute(statement))).rejects.toThrow(
        /transaction control/
      );
    }
    expect(seen).toEqual([]);
    await driver.close();
  });

  it("does not mistake a leading comment for the statement keyword", async () => {
    const seen: Seen[] = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.withConnection("write", c => c.execute("/* BEGIN */ INSERT INTO t VALUES (1)"));
    await driver.withConnection("write", c => c.execute("-- COMMIT\nSELECT 1"));

    expect(seen).toHaveLength(2);
    await driver.close();
  });

  it("refuses to construct with no app credential", () => {
    expect(() => new PostgresStorageDriver({}, fakePool([]))).toThrow(/at least an .app. DSN/);
  });

  it("ends every pool on close", async () => {
    const ended: StorageRole[] = [];
    const driver = new PostgresStorageDriver({ app: "a", reader: "r" }, (role): PgPoolLike => ({
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      connect: () =>
        Promise.resolve({
          query: () => Promise.resolve({ rows: [], rowCount: 0 }),
          release: () => undefined,
        }),
      end: () => {
        ended.push(role);
        return Promise.resolve();
      },
    }));

    await driver.close();
    expect(ended.sort()).toEqual(["app", "reader"]);
  });
});
