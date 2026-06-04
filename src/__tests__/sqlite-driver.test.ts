/**
 * Adapter unit tests for src/sqlite-driver.ts (plan B8 + B4).
 *
 * AAA pattern, temp-dir DB files, full cleanup. Validates the node:sqlite
 * adapter's connection / statement / transaction / read-only surface and the
 * binding styles and pragma flows the consumers (B2) depend on.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "fs";
import os from "os";
import path from "path";

import { openDatabase, openReadOnly, type GatewayDatabase } from "../sqlite-driver.js";

describe("sqlite-driver adapter", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "sqlite-driver-test-"));
    dbPath = path.join(tmpDir, "test.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("open / exec / prepare / run / get / all / close roundtrip", () => {
    it("creates a table, inserts, reads back, and closes", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

      // Act
      db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(1, "alice");
      db.prepare("INSERT INTO t (id, name) VALUES (?, ?)").run(2, "bob");
      const one = db.prepare("SELECT name FROM t WHERE id = ?").get(1) as { name: string };
      const allRows = db.prepare("SELECT id, name FROM t ORDER BY id").all() as Array<{
        id: number;
        name: string;
      }>;

      // Assert
      expect(one.name).toBe("alice");
      expect(allRows).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);

      db.close();
    });
  });

  describe("run() return shape", () => {
    it("returns { changes: 1, lastInsertRowid } for a single INSERT", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");

      // Act
      const result = db.prepare("INSERT INTO t (name) VALUES (?)").run("x");

      // Assert
      expect(result.changes).toBe(1);
      expect(Number(result.lastInsertRowid)).toBe(1);

      db.close();
    });

    it("returns changes = N for a multi-row UPDATE", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, flag INTEGER)");
      db.prepare("INSERT INTO t (id, flag) VALUES (?, ?)").run(1, 0);
      db.prepare("INSERT INTO t (id, flag) VALUES (?, ?)").run(2, 0);
      db.prepare("INSERT INTO t (id, flag) VALUES (?, ?)").run(3, 0);

      // Act
      const result = db.prepare("UPDATE t SET flag = 1 WHERE flag = 0").run();

      // Assert
      expect(result.changes).toBe(3);

      db.close();
    });
  });

  describe("binding styles", () => {
    it("binds bare @name objects without setAllowBareNamedParameters (Node >= 24.4 default)", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");

      // Act — bare @name keys (no leading @ in the bind object). This is the
      // exact style flight-recorder.ts / job-store.ts use; it only works
      // when allowBareNamedParameters defaults true (Node >= 24.4).
      const result = db
        .prepare("INSERT INTO t (id, x) VALUES (@id, @x)")
        .run({ id: 7, x: "named" });
      const row = db.prepare("SELECT x FROM t WHERE id = @id").get({ id: 7 }) as { x: string };

      // Assert
      expect(result.changes).toBe(1);
      expect(row.x).toBe("named");

      db.close();
    });

    it("binds positional ? params via variadic run(a, b)", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");

      // Act
      const result = db.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(9, "pos");
      const row = db.prepare("SELECT x FROM t WHERE id = ?").get(9) as { x: string };

      // Assert
      expect(result.changes).toBe(1);
      expect(row.x).toBe("pos");

      db.close();
    });
  });

  describe("withTransaction", () => {
    it("commits on success: rows are visible afterwards", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      const insert = db.prepare("INSERT INTO t (id, x) VALUES (?, ?)");
      const txn = db.withTransaction((id: number, x: string) => {
        insert.run(id, x);
      });

      // Act
      txn(1, "a");
      txn(2, "b");

      // Assert
      const count = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
      expect(count.c).toBe(2);

      db.close();
    });

    it("rolls back on throw: no rows persist and the original error propagates", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      const insert = db.prepare("INSERT INTO t (id, x) VALUES (?, ?)");
      const sentinel = new Error("boom-original");
      const txn = db.withTransaction((id: number, x: string) => {
        insert.run(id, x);
        throw sentinel;
      });

      // Act / Assert — original error propagates
      expect(() => txn(1, "a")).toThrow(sentinel);

      // Assert — rollback left no rows
      const count = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
      expect(count.c).toBe(0);

      db.close();
    });

    it("throws on nested (re-entrant) withTransaction use", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      const inner = db.withTransaction(() => {
        db.prepare("INSERT INTO t (id) VALUES (1)").run();
      });
      const outer = db.withTransaction(() => {
        inner();
      });

      // Act / Assert
      expect(() => outer()).toThrow("nested transaction");

      db.close();
    });

    it("recovers after a rolled-back transaction (no dangling BEGIN state)", () => {
      // Arrange
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      const failing = db.withTransaction(() => {
        throw new Error("fail");
      });
      const ok = db.withTransaction(() => {
        db.prepare("INSERT INTO t (id) VALUES (1)").run();
      });

      // Act
      expect(() => failing()).toThrow("fail");
      ok();

      // Assert — second transaction was allowed and committed
      const count = db.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
      expect(count.c).toBe(1);

      db.close();
    });

    it("does not poison inTransaction state when BEGIN itself throws (closed connection)", () => {
      // Arrange — a transaction wrapper over a connection that is then closed,
      // so BEGIN fails at startup (B-review blocker: the flag used to be set
      // before BEGIN, turning every later call into a bogus "nested
      // transaction").
      const db = openDatabase(dbPath);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
      const txn = db.withTransaction(() => {
        db.prepare("INSERT INTO t (id) VALUES (1)").run();
      });
      db.close();

      // Act + Assert — both calls fail with the REAL cause (closed database),
      // never with "nested transaction".
      expect(() => txn()).toThrow(/is not open/i);
      expect(() => txn()).toThrow(/is not open/i);
      expect(() => txn()).not.toThrow(/nested transaction/);
    });
  });

  describe("openReadOnly", () => {
    function seed(p: string): void {
      const db = openDatabase(p);
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      db.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(1, "seeded");
      db.close();
    }

    it("reads fine but rejects writes at the engine level (SQLITE_READONLY-class error)", () => {
      // Arrange
      seed(dbPath);
      const ro = openReadOnly(dbPath);

      // Act — read works
      const row = ro.prepare("SELECT x FROM t WHERE id = ?").get(1) as { x: string };

      // Assert — read OK
      expect(row.x).toBe("seeded");

      // Assert — write rejected at engine level
      expect(() => ro.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(2, "nope")).toThrow();
      let writeError: unknown;
      try {
        ro.prepare("UPDATE t SET x = ? WHERE id = ?").run("mutated", 1);
      } catch (err) {
        writeError = err;
      }
      expect(writeError).toBeInstanceOf(Error);
      expect(String((writeError as Error).message).toLowerCase()).toContain("readonly");

      ro.close();
    });

    it("throws when opening a nonexistent file (no file/dir creation)", () => {
      // Arrange
      const missing = path.join(tmpDir, "does-not-exist.db");

      // Act / Assert
      expect(() => openReadOnly(missing)).toThrow();
      expect(existsSync(missing)).toBe(false);
    });
  });

  describe("WAL pragma flow through the adapter", () => {
    it("consumer-style PRAGMA journal_mode = WAL round-trips to 'wal'", () => {
      // Arrange
      const db = openDatabase(dbPath);

      // Act — pragmas live in consumers (B3); the adapter must not break them.
      db.exec("PRAGMA journal_mode = WAL");
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };

      // Assert
      expect(row.journal_mode.toLowerCase()).toBe("wal");

      db.close();
    });
  });

  describe("open-failure degradation", () => {
    it("openDatabase throws a catchable Error on an invalid/unwritable path", () => {
      // Arrange — a path whose parent is a regular FILE, so mkdir/open fails.
      const filePath = path.join(tmpDir, "afile");
      const blocker = openDatabase(path.join(tmpDir, "real.db"));
      blocker.close();
      // Make `afile` a file, then try to open a db "under" it.
      const fileDb = openDatabase(filePath);
      fileDb.close();
      const nestedUnderFile = path.join(filePath, "child.db");

      // Act / Assert — catchable Error, not a module crash.
      let caught: unknown;
      try {
        openDatabase(nestedUnderFile);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
    });

    it("openReadOnly throws on a missing file", () => {
      // Act / Assert
      expect(() => openReadOnly(path.join(tmpDir, "ghost.db"))).toThrow();
    });
  });

  describe("connection lifecycle (plan B4 / B8)", () => {
    it("open + close + reopen the same file preserves data", () => {
      // Arrange
      const first = openDatabase(dbPath);
      first.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      first.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(1, "persist");
      first.close();

      // Act
      const second = openDatabase(dbPath);
      const row = second.prepare("SELECT x FROM t WHERE id = ?").get(1) as { x: string };

      // Assert
      expect(row.x).toBe("persist");
      second.close();
    });

    it("closing a read-only connection does not affect a separate RW connection on the same path", () => {
      // Arrange
      const rw = openDatabase(dbPath);
      rw.exec("PRAGMA journal_mode = WAL");
      rw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      rw.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(1, "a");
      const ro = openReadOnly(dbPath);

      // Act — close the RO connection
      ro.close();

      // Assert — RW connection still fully usable
      rw.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(2, "b");
      const count = rw.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
      expect(count.c).toBe(2);

      rw.close();
    });

    it("separate-connection visibility: RO reader sees committed rows, not uncommitted ones", () => {
      // Arrange — WAL so a separate RO connection can read concurrently.
      const rw = openDatabase(dbPath);
      rw.exec("PRAGMA journal_mode = WAL");
      rw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      rw.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(1, "committed");
      const ro = openReadOnly(dbPath);

      const txn = rw.withTransaction((id: number, x: string) => {
        rw.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(id, x);
        // While still inside the open RW transaction, the separate RO reader
        // must NOT see the uncommitted row (snapshot isolation under WAL).
        const midCount = ro.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
        expect(midCount.c).toBe(1);
      });

      // Act — run the transaction (which asserts mid-flight invisibility)
      txn(2, "uncommitted-until-commit");

      // Assert — after commit, the RO reader now sees both rows.
      const afterCount = ro.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
      expect(afterCount.c).toBe(2);

      ro.close();
      rw.close();
    });

    it("WAL concurrent-reader: RO reads succeed while RW holds an open transaction", () => {
      // Arrange — documents B8 busy behaviour: under WAL, a separate RO
      // reader is NOT blocked by an in-progress RW writer transaction; it
      // reads the last committed snapshot rather than erroring SQLITE_BUSY.
      const rw = openDatabase(dbPath);
      rw.exec("PRAGMA journal_mode = WAL");
      rw.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, x TEXT)");
      rw.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(1, "base");
      const ro = openReadOnly(dbPath);

      let readSucceeded = false;
      const txn = rw.withTransaction(() => {
        rw.prepare("INSERT INTO t (id, x) VALUES (?, ?)").run(2, "pending");
        // RO read must succeed (no SQLITE_BUSY) and see only the committed snapshot.
        const row = ro.prepare("SELECT COUNT(*) AS c FROM t").get() as { c: number };
        expect(row.c).toBe(1);
        readSucceeded = true;
      });

      // Act
      txn();

      // Assert
      expect(readSucceeded).toBe(true);

      ro.close();
      rw.close();
    });
  });
});
