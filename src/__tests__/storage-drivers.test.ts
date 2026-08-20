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

  it("refuses work after close", async () => {
    await driver.close();
    await expect(driver.withConnection("write", c => c.query("SELECT 1"))).rejects.toThrow(
      /closed/
    );
  });
});

describe("PostgresStorageDriver", () => {
  function fakePool(seen: Array<{ role: StorageRole; text: string; values: unknown[] }>) {
    return (role: StorageRole): PgPoolLike => ({
      query(text: string, values: readonly unknown[] = []) {
        seen.push({ role, text, values: [...values] });
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
      end: () => Promise.resolve(),
    });
  }

  it("routes each operation class to its own pool", async () => {
    const seen: Array<{ role: StorageRole; text: string; values: unknown[] }> = [];
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
    const seen: Array<{ role: StorageRole; text: string; values: unknown[] }> = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.withConnection("transcript_read", c => c.query("SELECT prompt FROM requests"));

    expect(seen[0].role).toBe("app");
    expect(roleSeparationInForce(driver.roles)).toBe(false);
    await driver.close();
  });

  it("translates placeholders on the way to the pool", async () => {
    const seen: Array<{ role: StorageRole; text: string; values: unknown[] }> = [];
    const driver = new PostgresStorageDriver({ app: "a" }, fakePool(seen));

    await driver.withConnection("write", c =>
      c.execute("INSERT INTO t (a, b) VALUES (?, ?)", [1, 2])
    );

    expect(seen[0].text).toBe("INSERT INTO t (a, b) VALUES ($1, $2)");
    expect(seen[0].values).toEqual([1, 2]);
    await driver.close();
  });

  it("wraps a transaction in BEGIN and COMMIT, and ROLLBACK on failure", async () => {
    const seen: Array<{ role: StorageRole; text: string; values: unknown[] }> = [];
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

  it("refuses to construct with no app credential", () => {
    expect(() => new PostgresStorageDriver({}, fakePool([]))).toThrow(/at least an .app. DSN/);
  });

  it("ends every pool on close", async () => {
    const ended: StorageRole[] = [];
    const driver = new PostgresStorageDriver({ app: "a", reader: "r" }, (role): PgPoolLike => ({
      query: () => Promise.resolve({ rows: [], rowCount: 0 }),
      end: () => {
        ended.push(role);
        return Promise.resolve();
      },
    }));

    await driver.close();
    expect(ended.sort()).toEqual(["app", "reader"]);
  });
});
