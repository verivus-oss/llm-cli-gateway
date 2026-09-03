/**
 * Job expiry is a RETENTION operation, on both engines.
 *
 * s3sig recorded that role separation is inert for the job store, because
 * `job-store.ts` passes `"write"` at every call site. Most of those are correct:
 * postgres-security-hardening.md 4.3 gives `llmgw_app` `SELECT`, `INSERT` and
 * `UPDATE`, and scopes `llmgw_reader` to transcripts, so routing job-store reads
 * to the reader would ask a credential for tables it deliberately has no grant
 * on. The same document rules ONE site differently by name: job expiry routes to
 * `llmgw_retention`, which is what lets `llmgw_app` hold no `DELETE` on `jobs`.
 *
 * On SQLite this is a class change with no handle change: `retention` is not a
 * read class, so it resolves to the same writable connection. Asserted here so
 * that stays true rather than being assumed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SqliteJobStore } from "../job-store.js";
import { createPostgresJobStoreOps } from "../postgres-job-store-ops.js";
import { SqliteStorageDriver } from "../storage/drivers/sqlite.js";
import type { PostgresStorageDriver } from "../storage/drivers/postgres.js";
import type { StorageConnection } from "../storage/store.js";

const dirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "s9-retention-"));
  dirs.push(dir);
  return join(dir, "jobs.db");
}

describe("SqliteJobStore.evictExpired", () => {
  it("opens its transaction as `retention`, not `write`", async () => {
    const classes: string[] = [];
    const original = SqliteStorageDriver.prototype.transaction;
    const spy = vi.spyOn(SqliteStorageDriver.prototype, "transaction").mockImplementation(function (
      this: SqliteStorageDriver,
      operation,
      fn
    ) {
      classes.push(operation);
      return original.call(this, operation, fn);
    });

    const store = new SqliteJobStore(tempDb(), undefined, { retentionMs: 1000 });
    await store.evictExpired();
    await store.close();
    spy.mockRestore();

    expect(classes).toContain("retention");
    // The class change must not have been made by moving every site: the
    // bootstrap and the ordinary writes still run as `write`.
    expect(classes.filter(c => c === "retention")).toHaveLength(1);
  });

  it("still routes an ordinary write as `write`", async () => {
    const classes: string[] = [];
    const original = SqliteStorageDriver.prototype.transaction;
    vi.spyOn(SqliteStorageDriver.prototype, "transaction").mockImplementation(function (
      this: SqliteStorageDriver,
      operation,
      fn
    ) {
      classes.push(operation);
      return original.call(this, operation, fn);
    });

    const store = new SqliteJobStore(tempDb(), undefined, { retentionMs: 1000 });
    await store.recordStart({
      id: "job-1",
      correlationId: "corr-1",
      requestKey: "key-1",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
    });
    await store.close();

    expect(classes).toContain("write");
    expect(classes).not.toContain("retention");
  });

  it("resolves `retention` to the writable handle, so nothing else changes", async () => {
    const store = new SqliteJobStore(tempDb(), undefined, { retentionMs: 1000 });
    await store.recordStart({
      id: "job-2",
      correlationId: "corr-2",
      requestKey: "key-2",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
    });
    // A read-only handle would fail with SQLITE_READONLY here rather than
    // returning a count, which is the property that makes this class change
    // safe on SQLite while a read-class change would not be.
    await expect(store.evictExpired()).resolves.toBeTypeOf("number");
    await store.close();
  });
});

describe("PostgresJobStoreOps evictExpired", () => {
  function fakeDriver(seen: string[]): PostgresStorageDriver {
    const connection: StorageConnection = {
      async query() {
        return [];
      },
      async execute() {
        return { rowsAffected: 3 };
      },
      async executeScript() {},
    };
    return {
      engine: "postgres",
      roles: new Set(["app"]),
      async withConnection(operation: string, fn: (c: StorageConnection) => Promise<unknown>) {
        seen.push(operation);
        return fn(connection);
      },
      async transaction(operation: string, fn: (c: StorageConnection) => Promise<unknown>) {
        seen.push(operation);
        return fn(connection);
      },
      async bootstrap(fn: (c: StorageConnection) => Promise<unknown>) {
        return fn(connection);
      },
      async close() {},
    } as unknown as PostgresStorageDriver;
  }

  it("runs on the `retention` credential", async () => {
    const seen: string[] = [];
    const ops = createPostgresJobStoreOps(fakeDriver(seen), {
      retentionMs: 1000,
      dedupWindowMs: 0,
      leaseTtlMs: 1000,
      farFutureIso: "9999-01-01T00:00:00.000Z",
    });
    await expect(ops.op("evictExpired", [])).resolves.toBe(3);
    expect(seen).toEqual(["retention"]);
  });
});
