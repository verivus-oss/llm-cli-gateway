/**
 * Durable instance-lease orphan recovery (#139).
 *
 * Store/driver-level cases from docs/plans/issue-139-orphan-recovery.test-plan.md.
 * AAA pattern, temp-dir DB files, full cleanup, injected/explicit lease values
 * instead of real sleeps. Postgres parity is covered by
 * job-store-pg.test.ts (npm run test:pg); this file is the memory+sqlite matrix
 * plus the sqlite-driver widening.
 */
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDatabase, type GatewayDatabase } from "../sqlite-driver.js";
import { SqliteJobStore, MemoryJobStore, type JobStore } from "../job-store.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { noopLogger } from "../logger.js";

function tableColumns(db: GatewayDatabase, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map(r => r?.name).filter((n): n is string => typeof n === "string"));
}

function tableExists(db: GatewayDatabase, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name === table;
}

describe("#139 sqlite-driver withTransaction return value (U14)", () => {
  let tmpDir: string;
  let dbPath: string;
  let db: GatewayDatabase;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orphan139-driver-"));
    dbPath = join(tmpDir, "t.db");
    db = openDatabase(dbPath);
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER)");
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("forwards the callback return value to the caller", () => {
    // Arrange
    const tx = db.withTransaction((a: number, b: number): number => {
      db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run(a, a + b);
      return a + b;
    });

    // Act
    const result = tx(1, 41);

    // Assert
    expect(result).toBe(42);
    const row = db.prepare("SELECT n FROM t WHERE id = ?").get(1) as { n: number };
    expect(row.n).toBe(42);
  });

  it("existing void callbacks are unaffected (returns undefined, still commits)", () => {
    // Arrange
    const tx = db.withTransaction((id: number): void => {
      db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run(id, 7);
    });

    // Act
    const result = tx(2) as unknown;

    // Assert
    expect(result).toBeUndefined();
    expect((db.prepare("SELECT n FROM t WHERE id = ?").get(2) as { n: number }).n).toBe(7);
  });

  it("rolls back and rethrows when the callback throws (no partial write, no return)", () => {
    // Arrange
    const tx = db.withTransaction((id: number): number => {
      db.prepare("INSERT INTO t (id, n) VALUES (?, ?)").run(id, 99);
      throw new Error("boom");
    });

    // Act + Assert
    expect(() => tx(3)).toThrow("boom");
    expect(db.prepare("SELECT n FROM t WHERE id = ?").get(3)).toBeUndefined();
  });
});

describe("#139 durable-lease DDL idempotency (U13, sqlite)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orphan139-ddl-"));
    dbPath = join(tmpDir, "jobs.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates owner_instance + lease_deadline columns and gateway_instances table on a fresh DB", () => {
    // Act
    const store = new SqliteJobStore(dbPath);
    store.close();

    // Assert
    const db = openDatabase(dbPath);
    try {
      const jobCols = tableColumns(db, "jobs");
      expect(jobCols.has("owner_instance")).toBe(true);
      expect(jobCols.has("lease_deadline")).toBe(true);
      expect(tableExists(db, "gateway_instances")).toBe(true);
      const instCols = tableColumns(db, "gateway_instances");
      for (const c of ["instance_id", "role", "hostname", "pid", "started_at", "last_heartbeat"]) {
        expect(instCols.has(c)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("migrates a legacy jobs table (no lease columns) idempotently, and re-open is a no-op", () => {
    // Arrange: a legacy jobs table lacking owner_instance / lease_deadline.
    const legacy = openDatabase(dbPath);
    legacy.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        correlation_id TEXT NOT NULL,
        request_key TEXT NOT NULL,
        cli TEXT NOT NULL,
        args_json TEXT NOT NULL,
        output_format TEXT,
        status TEXT NOT NULL,
        exit_code INTEGER,
        stdout TEXT,
        stderr TEXT,
        output_truncated INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        pid INTEGER,
        expires_at TEXT NOT NULL
      );
    `);
    legacy.close();

    // Act: opening the store migrates the legacy table; a second open is a no-op.
    const first = new SqliteJobStore(dbPath);
    first.close();
    const second = new SqliteJobStore(dbPath);
    second.close();

    // Assert
    const db = openDatabase(dbPath);
    try {
      const jobCols = tableColumns(db, "jobs");
      expect(jobCols.has("owner_instance")).toBe(true);
      expect(jobCols.has("lease_deadline")).toBe(true);
      expect(jobCols.has("owner_principal")).toBe(true);
      expect(jobCols.has("transport")).toBe(true);
      expect(tableExists(db, "gateway_instances")).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("#139 SqliteJobStore lease surface (U1-U11)", () => {
  let tmpDir: string;
  let dbPath: string;
  let store: SqliteJobStore;

  const LEASE_TTL = 90000;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orphan139-store-"));
    dbPath = join(tmpDir, "jobs.db");
    store = new SqliteJobStore(dbPath, undefined, { leaseTtlMs: LEASE_TTL });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function start(id: string, extra: Record<string, unknown> = {}): void {
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "claude",
      args: ["-p", id],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: "inst-A",
      ...extra,
    });
  }

  // Force a job's lease into the past on a second connection.
  function setLease(id: string, value: number | null): void {
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE jobs SET lease_deadline = ? WHERE id = ?").run(value, id);
    } finally {
      db.close();
    }
  }

  it("U7: recordStart persists queued + owner_instance + a non-null lease_deadline", () => {
    start("j");
    const row = store.getById("j");
    expect(row?.status).toBe("queued");
    expect(row?.ownerInstance).toBe("inst-A");
    expect(row?.leaseDeadline).not.toBeNull();
    expect(typeof row?.leaseDeadline).toBe("number");
  });

  it("U4: a live row never has a NULL lease immediately after recordStart", () => {
    start("j");
    expect(store.getById("j")?.leaseDeadline).toBeGreaterThan(Date.now() - 1000);
  });

  it("U8: markRunning transitions queued -> running and stamps the pid", () => {
    start("j", { transport: "process" });
    store.markRunning("j", { pid: 4242 });
    const row = store.getById("j");
    expect(row?.status).toBe("running");
    expect(row?.pid).toBe(4242);
    // idempotent: a second markRunning on a now-running row is a no-op.
    store.markRunning("j", { pid: 9999 });
    expect(store.getById("j")?.pid).toBe(4242);
  });

  it("U1: recoverStaleJobs orphans a running row whose lease has expired", () => {
    start("j", { transport: "process" });
    store.markRunning("j", { pid: 100 });
    setLease("j", 1);
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned.map(o => o.id)).toContain("j");
    expect(store.getById("j")?.status).toBe("orphaned");
  });

  it("U2: recoverStaleJobs does NOT orphan a row whose lease is still valid", () => {
    start("j", { transport: "process" });
    store.markRunning("j", { pid: 100 });
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned).toHaveLength(0);
    expect(store.getById("j")?.status).toBe("running");
  });

  it("U3: a legacy row with a NULL lease is orphaned (the NULL arm)", () => {
    start("j", { transport: "process" });
    store.markRunning("j", { pid: 100 });
    setLease("j", null);
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned.map(o => o.id)).toContain("j");
    expect(store.getById("j")?.status).toBe("orphaned");
  });

  it("U9: recoverStaleJobs targets queued too (crash between enqueue and launch)", () => {
    start("j"); // never markRunning -> stays queued
    setLease("j", 1);
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned.map(o => o.id)).toContain("j");
    expect(store.getById("j")?.status).toBe("orphaned");
  });

  it("U5: guarded recordComplete lands a terminal status onto an orphaned row, and is a no-op on a terminal row", () => {
    start("j", { transport: "process" });
    store.markRunning("j", { pid: 100 });
    setLease("j", 1);
    store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(store.getById("j")?.status).toBe("orphaned");
    // completion wins over the mistaken orphan
    store.recordComplete({
      id: "j",
      status: "completed",
      exitCode: 0,
      stdout: "done",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    expect(store.getById("j")?.status).toBe("completed");
    // a second completion attempt on the now-terminal row is a no-op
    store.recordComplete({
      id: "j",
      status: "failed",
      exitCode: 1,
      stdout: "x",
      stderr: "y",
      outputTruncated: false,
      error: "nope",
      finishedAt: new Date().toISOString(),
    });
    expect(store.getById("j")?.status).toBe("completed");
  });

  it("U11: dedup treats a live queued job as eligible, but never an orphaned row", () => {
    start("live");
    expect(store.findByRequestKey("key-live")?.id).toBe("live");
    start("dead");
    setLease("dead", 1);
    store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(store.getById("dead")?.status).toBe("orphaned");
    expect(store.findByRequestKey("key-dead")).toBeNull();
  });

  it("heartbeat advances the lease so a would-be-stale job is not swept", () => {
    start("j", { transport: "process" });
    store.markRunning("j", { pid: 100 });
    setLease("j", 1); // simulate lease about to lapse
    store.heartbeat("inst-A"); // owner heartbeats: re-extends the lease
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned).toHaveLength(0);
    expect(store.getById("j")?.status).toBe("running");
  });

  it("http job past leaseTtl but within httpJobGrace is NOT orphaned (grace in predicate)", () => {
    start("h", { transport: "http" });
    setLease("h", 1); // lease expired, but started_at is recent (within grace)
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned).toHaveLength(0);
    expect(store.getById("h")?.status).toBe("queued");
  });

  it("registerInstance + gcInstances manage observability rows", () => {
    store.registerInstance({ instanceId: "inst-A", role: "stdio", hostname: "h1", pid: 1 });
    // GC with a 0ms horizon removes rows older than now (heartbeat is ~now, so
    // nothing removed immediately); a negative horizon removes everything.
    expect(store.gcInstances(-1)).toBe(1);
  });
});

describe("#139 MemoryJobStore parity (U12)", () => {
  let store: MemoryJobStore;
  const LEASE_TTL = 90000;

  beforeEach(() => {
    store = new MemoryJobStore({ leaseTtlMs: LEASE_TTL });
  });
  afterEach(() => store.close());

  function start(id: string, extra: Record<string, unknown> = {}): void {
    store.recordStart({
      id,
      correlationId: `corr-${id}`,
      requestKey: `key-${id}`,
      cli: "claude",
      args: ["-p", id],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: "inst-A",
      ...extra,
    });
  }

  it("recordStart persists queued with a non-null lease; markRunning flips to running", () => {
    start("j", { transport: "process" });
    expect(store.getById("j")?.status).toBe("queued");
    expect(store.getById("j")?.leaseDeadline).not.toBeNull();
    store.markRunning("j", { pid: 7 });
    expect(store.getById("j")?.status).toBe("running");
    expect(store.getById("j")?.pid).toBe(7);
  });

  it("recoverStaleJobs is a per-process no-op; register/heartbeat/deregister no-op", () => {
    start("j");
    expect(store.recoverStaleJobs(LEASE_TTL, 300000)).toHaveLength(0);
    expect(store.selectStaleProcessCandidates(LEASE_TTL, 300000)).toHaveLength(0);
    store.registerInstance({ instanceId: "inst-A", role: null, hostname: null, pid: null });
    store.heartbeat("inst-A");
    store.deregisterInstance("inst-A");
    expect(store.gcInstances(0)).toBe(0);
  });

  it("guarded recordComplete is a no-op on an already-terminal row", () => {
    start("j");
    store.recordComplete({
      id: "j",
      status: "completed",
      exitCode: 0,
      stdout: "a",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    store.recordComplete({
      id: "j",
      status: "failed",
      exitCode: 1,
      stdout: "b",
      stderr: "",
      outputTruncated: false,
      error: "no",
      finishedAt: new Date().toISOString(),
    });
    expect(store.getById("j")?.status).toBe("completed");
    expect(store.getById("j")?.stdout).toBe("a");
  });

  it("dedup treats a live queued job as eligible", () => {
    start("j");
    expect(store.findByRequestKey("key-j")?.id).toBe("j");
  });
});

describe("#139 AsyncJobManager lease lifecycle (M/N series)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orphan139-mgr-"));
    dbPath = join(tmpDir, "jobs.db");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // A complete JobStore mock with no-op defaults; override individual methods.
  function mockStore(overrides: Partial<JobStore> = {}): JobStore {
    return {
      recordStart: () => {},
      markRunning: () => {},
      registerInstance: () => {},
      heartbeat: () => {},
      deregisterInstance: () => {},
      selectStaleProcessCandidates: () => [],
      recoverStaleJobs: () => [],
      gcInstances: () => 0,
      recordOutput: () => {},
      recordComplete: () => {},
      getById: () => null,
      findByRequestKey: () => null,
      markOrphanedOnStartup: () => ({ count: 0, orphaned: [] }),
      evictExpired: () => 0,
      close: () => {},
      ...overrides,
    } as unknown as JobStore;
  }

  function instanceRows(): number {
    const db = openDatabase(dbPath);
    try {
      const r = db.prepare("SELECT COUNT(*) AS n FROM gateway_instances").get() as { n: number };
      return r.n;
    } finally {
      db.close();
    }
  }

  it("M6: registers before admit; a job recorded after construction is stamped with the manager's instance id", () => {
    const store = new SqliteJobStore(dbPath);
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    expect(instanceRows()).toBe(1);
    // recordStart via the store using the manager's instance id (the manager
    // stamps this on every job it admits).
    store.recordStart({
      id: "post-ctor",
      correlationId: "c",
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: mgr.getInstanceId(),
    });
    expect(store.getById("post-ctor")?.ownerInstance).toBe(mgr.getInstanceId());
    store.close();
  });

  it("M7: a null-store (isolate-mode) manager registers nothing and disposes as a no-op", async () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, null);
    expect(mgr.canAdmitDurableJobs()).toBe(false);
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it("M8: a durable queued row hydrates with exited=false", () => {
    const store = new SqliteJobStore(dbPath);
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    store.recordStart({
      id: "q",
      correlationId: "c",
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: mgr.getInstanceId(),
    });
    // Not in the manager's in-memory map -> hydrated from the store.
    const snap = mgr.getJobSnapshot("q");
    expect(snap?.status).toBe("queued");
    expect(snap?.exited).toBe(false);
    store.close();
  });

  it("N1: a forced durable recordStart failure fails the request and leaves no running job", () => {
    const store = mockStore({
      recordStart: () => {
        throw new Error("db down");
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    expect(() => mgr.startJobWithDedup("claude", ["-p", "x"], "corr")).toThrow(
      /Durable job admission failed/
    );
    // fail-closed: the acquired running slot was released.
    expect(mgr.getLimiterSnapshot().running).toBe(0);
    expect(mgr.getJobSnapshot("corr")).toBeNull();
  });

  it("N2: when registration fails, durable admission is disabled and new async work is rejected", () => {
    const store = mockStore({
      registerInstance: () => {
        throw new Error("register failed");
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    expect(mgr.canAdmitDurableJobs()).toBe(false);
    expect(() => mgr.startJobWithDedup("claude", ["-p", "x"], "corr")).toThrow(
      /Durable async admission is disabled/
    );
  });

  it("M9/M10: dispose deregisters the instance when no owned work remains, and is idempotent", async () => {
    const store = new SqliteJobStore(dbPath);
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    expect(instanceRows()).toBe(1);
    await mgr.dispose();
    expect(instanceRows()).toBe(0);
    // idempotent
    await expect(mgr.dispose()).resolves.toBeUndefined();
    store.close();
  });
});
