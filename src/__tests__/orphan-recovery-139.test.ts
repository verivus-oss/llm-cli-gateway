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
import os, { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("creates owner_instance + lease_deadline columns and gateway_instances table on a fresh DB", async () => {
    // Act
    const store = new SqliteJobStore(dbPath);
    await store.close();

    // Assert
    const db = openDatabase(dbPath);
    try {
      const jobCols = tableColumns(db, "jobs");
      expect(jobCols.has("owner_instance")).toBe(true);
      expect(jobCols.has("owner_hostname")).toBe(true);
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

  it("migrates a legacy jobs table (no lease columns) idempotently, and re-open is a no-op", async () => {
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
    await first.close();
    const second = new SqliteJobStore(dbPath);
    await second.close();

    // Assert
    const db = openDatabase(dbPath);
    try {
      const jobCols = tableColumns(db, "jobs");
      expect(jobCols.has("owner_instance")).toBe(true);
      expect(jobCols.has("owner_hostname")).toBe(true);
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

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function start(id: string, extra: Record<string, unknown> = {}): Promise<void> {
    await store.recordStart({
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

  it("U7: recordStart persists queued + owner_instance + a non-null lease_deadline", async () => {
    start("j", { ownerHostname: "host-A" });
    const row = await store.getById("j");
    expect(row?.status).toBe("queued");
    expect(row?.ownerInstance).toBe("inst-A");
    expect(row?.ownerHostname).toBe("host-A");
    expect(row?.leaseDeadline).not.toBeNull();
    expect(typeof row?.leaseDeadline).toBe("number");
  });

  it("U4: a live row never has a NULL lease immediately after recordStart", async () => {
    start("j");
    expect((await store.getById("j"))?.leaseDeadline).toBeGreaterThan(Date.now() - 1000);
  });

  it("U8: markRunning transitions queued -> running and stamps the pid", async () => {
    start("j", { transport: "process" });
    await store.markRunning("j", { pid: 4242 });
    const row = await store.getById("j");
    expect(row?.status).toBe("running");
    expect(row?.pid).toBe(4242);
    // idempotent: a second markRunning on a now-running row is a no-op.
    await store.markRunning("j", { pid: 9999 });
    expect((await store.getById("j"))?.pid).toBe(4242);
  });

  it("U1: recoverStaleJobs orphans a running row whose lease has expired", async () => {
    start("j", { transport: "process" });
    await store.markRunning("j", { pid: 100 });
    setLease("j", 1);
    const orphaned = await store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned.map(o => o.id)).toContain("j");
    expect((await store.getById("j"))?.status).toBe("orphaned");
  });

  it("U2: recoverStaleJobs does NOT orphan a row whose lease is still valid", async () => {
    start("j", { transport: "process" });
    await store.markRunning("j", { pid: 100 });
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(await orphaned).toHaveLength(0);
    expect((await store.getById("j"))?.status).toBe("running");
  });

  it("U3: a legacy row with a NULL lease is orphaned (the NULL arm)", async () => {
    start("j", { transport: "process" });
    await store.markRunning("j", { pid: 100 });
    setLease("j", null);
    const orphaned = await store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned.map(o => o.id)).toContain("j");
    expect((await store.getById("j"))?.status).toBe("orphaned");
  });

  it("U9: recoverStaleJobs targets queued too (crash between enqueue and launch)", async () => {
    start("j"); // never markRunning -> stays queued
    setLease("j", 1);
    const orphaned = await store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(orphaned.map(o => o.id)).toContain("j");
    expect((await store.getById("j"))?.status).toBe("orphaned");
  });

  it("U5: guarded recordComplete lands a terminal status onto an orphaned row, and is a no-op on a terminal row", async () => {
    start("j", { transport: "process" });
    await store.markRunning("j", { pid: 100 });
    setLease("j", 1);
    await store.recoverStaleJobs(LEASE_TTL, 300000);
    expect((await store.getById("j"))?.status).toBe("orphaned");
    // completion wins over the mistaken orphan
    await store.recordComplete({
      id: "j",
      status: "completed",
      exitCode: 0,
      stdout: "done",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    expect((await store.getById("j"))?.status).toBe("completed");
    // a second completion attempt on the now-terminal row is a no-op
    await store.recordComplete({
      id: "j",
      status: "failed",
      exitCode: 1,
      stdout: "x",
      stderr: "y",
      outputTruncated: false,
      error: "nope",
      finishedAt: new Date().toISOString(),
    });
    expect((await store.getById("j"))?.status).toBe("completed");
  });

  it("U11: dedup treats a live queued job as eligible, but never an orphaned row", async () => {
    start("live");
    expect((await store.findByRequestKey("key-live"))?.id).toBe("live");
    start("dead");
    setLease("dead", 1);
    await store.recoverStaleJobs(LEASE_TTL, 300000);
    expect((await store.getById("dead"))?.status).toBe("orphaned");
    expect(await store.findByRequestKey("key-dead")).toBeNull();
  });

  it("heartbeat advances the lease so a would-be-stale job is not swept", async () => {
    start("j", { transport: "process" });
    await store.markRunning("j", { pid: 100 });
    setLease("j", 1); // simulate lease about to lapse
    await store.heartbeat("inst-A"); // owner heartbeats: re-extends the lease
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(await orphaned).toHaveLength(0);
    expect((await store.getById("j"))?.status).toBe("running");
  });

  it("http job past leaseTtl but within httpJobGrace is NOT orphaned (grace in predicate)", async () => {
    start("h", { transport: "http" });
    setLease("h", 1); // lease expired, but started_at is recent (within grace)
    const orphaned = store.recoverStaleJobs(LEASE_TTL, 300000);
    expect(await orphaned).toHaveLength(0);
    expect((await store.getById("h"))?.status).toBe("queued");
  });

  it("registerInstance + gcInstances manage observability rows", async () => {
    await store.registerInstance({ instanceId: "inst-A", role: "stdio", hostname: "h1", pid: 1 });
    // GC with a 0ms horizon removes rows older than now (heartbeat is ~now, so
    // nothing removed immediately); a negative horizon removes everything.
    expect(await store.gcInstances(-1)).toBe(1);
  });
});

describe("#139 legacy owner-hostname provenance repair", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orphan139-hostname-backfill-"));
    dbPath = join(tmpDir, "jobs.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("retains a backfilled legacy hostname after its instance row is garbage-collected", async () => {
    const ownerInstance = "legacy-backfill-instance";
    const ownerHostname = "legacy-backfill-host";
    const store = new SqliteJobStore(dbPath);
    try {
      await store.registerInstance({
        instanceId: ownerInstance,
        role: "gateway",
        hostname: ownerHostname,
        pid: 1234,
      });
      await store.recordStart({
        id: "legacy-backfill-known",
        correlationId: "legacy-backfill-known-corr",
        requestKey: "legacy-backfill-known-key",
        cli: "claude",
        args: ["-p", "review"],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerInstance,
      });
      await store.recordStart({
        id: "legacy-backfill-unknown",
        correlationId: "legacy-backfill-unknown-corr",
        requestKey: "legacy-backfill-unknown-key",
        cli: "claude",
        args: ["-p", "review"],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerInstance: "already-gone-instance",
      });
    } finally {
      await store.close();
    }

    const reopened = new SqliteJobStore(dbPath);
    try {
      expect((await reopened.getById("legacy-backfill-known"))?.ownerHostname).toBe(ownerHostname);
      // An unobservable historical owner remains unknown rather than guessed.
      expect((await reopened.getById("legacy-backfill-unknown"))?.ownerHostname).toBeNull();

      const db = openDatabase(dbPath);
      try {
        db.prepare("UPDATE jobs SET status = 'orphaned', lease_deadline = NULL WHERE id = ?").run(
          "legacy-backfill-known"
        );
        db.prepare("UPDATE gateway_instances SET last_heartbeat = 1 WHERE instance_id = ?").run(
          ownerInstance
        );
      } finally {
        db.close();
      }
      expect(await reopened.gcInstances(-1)).toBe(1);
      expect(await reopened.selectOrphanedProcessCandidates(ownerHostname)).toEqual([
        {
          id: "legacy-backfill-known",
          pid: null,
          transport: "process",
          ownerInstance,
          hostname: ownerHostname,
        },
      ]);
    } finally {
      await reopened.close();
    }
  });
});

describe("#139 MemoryJobStore parity (U12)", () => {
  let store: MemoryJobStore;
  const LEASE_TTL = 90000;

  beforeEach(() => {
    store = new MemoryJobStore({ leaseTtlMs: LEASE_TTL });
  });
  afterEach(() => store.close());

  async function start(id: string, extra: Record<string, unknown> = {}): Promise<void> {
    await store.recordStart({
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

  it("recordStart persists queued with a non-null lease; markRunning flips to running", async () => {
    start("j", { transport: "process" });
    expect((await store.getById("j"))?.status).toBe("queued");
    expect((await store.getById("j"))?.leaseDeadline).not.toBeNull();
    await store.markRunning("j", { pid: 7 });
    expect((await store.getById("j"))?.status).toBe("running");
    expect((await store.getById("j"))?.pid).toBe(7);
  });

  it("recoverStaleJobs is a per-process no-op; register/heartbeat/deregister no-op", async () => {
    start("j");
    expect(await store.recoverStaleJobs(LEASE_TTL, 300000)).toHaveLength(0);
    expect(await store.selectStaleProcessCandidates(LEASE_TTL, 300000)).toHaveLength(0);
    await store.registerInstance({ instanceId: "inst-A", role: null, hostname: null, pid: null });
    await store.heartbeat("inst-A");
    await store.deregisterInstance("inst-A");
    expect(await store.gcInstances(0)).toBe(0);
  });

  it("guarded recordComplete is a no-op on an already-terminal row", async () => {
    start("j");
    await store.recordComplete({
      id: "j",
      status: "completed",
      exitCode: 0,
      stdout: "a",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: new Date().toISOString(),
    });
    await store.recordComplete({
      id: "j",
      status: "failed",
      exitCode: 1,
      stdout: "b",
      stderr: "",
      outputTruncated: false,
      error: "no",
      finishedAt: new Date().toISOString(),
    });
    expect((await store.getById("j"))?.status).toBe("completed");
    expect((await store.getById("j"))?.stdout).toBe("a");
  });

  it("dedup treats a live queued job as eligible", async () => {
    start("j");
    expect((await store.findByRequestKey("key-j"))?.id).toBe("j");
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

  // Awaited: the tick is async now, and its single-flight guard SKIPS a tick
  // that overlaps one still running. Firing three without awaiting would run
  // one and drop two, which is not what "three consecutive successes" means.
  async function runHeartbeatTick(manager: AsyncJobManager): Promise<void> {
    await (
      manager as unknown as { onHeartbeatTick: (intervalMs: number) => Promise<void> }
    ).onHeartbeatTick(15_000);
  }

  function runEviction(manager: AsyncJobManager): void {
    (manager as unknown as { evictCompletedJobs: () => void }).evictCompletedJobs();
  }

  it("M6: registers before admit; a job recorded after construction is stamped with the manager's instance id", async () => {
    const store = new SqliteJobStore(dbPath);
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    expect(instanceRows()).toBe(1);
    // recordStart via the store using the manager's instance id (the manager
    // stamps this on every job it admits).
    await store.recordStart({
      id: "post-ctor",
      correlationId: "c",
      requestKey: "k",
      cli: "claude",
      args: [],
      startedAt: new Date().toISOString(),
      pid: null,
      ownerInstance: mgr.getInstanceId(),
    });
    expect((await store.getById("post-ctor"))?.ownerInstance).toBe(mgr.getInstanceId());
    await store.close();
  });

  it("M7: a null-store (isolate-mode) manager registers nothing and disposes as a no-op", async () => {
    const mgr = new AsyncJobManager(noopLogger, undefined, null);
    await mgr.whenReady();
    expect(mgr.canAdmitDurableJobs()).toBe(false);
    await expect(mgr.dispose()).resolves.toBeUndefined();
  });

  it("M8: a durable queued row hydrates with exited=false", async () => {
    const store = new SqliteJobStore(dbPath);
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    await store.recordStart({
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
    const snap = await mgr.getJobSnapshot("q");
    expect(snap?.status).toBe("queued");
    expect(snap?.exited).toBe(false);
    await store.close();
  });

  it("N1: a forced durable recordStart failure fails the request and leaves no running job", async () => {
    const store = mockStore({
      recordStart: () => {
        throw new Error("db down");
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    await expect(mgr.startJobWithDedup("claude", ["-p", "x"], "corr")).rejects.toThrow(
      /Durable job admission failed/
    );
    // fail-closed: the acquired running slot was released.
    expect(mgr.getLimiterSnapshot().running).toBe(0);
    expect(await mgr.getJobSnapshot("corr")).toBeNull();
  });

  it("N2: when registration fails, durable admission is disabled and new async work is rejected", async () => {
    const store = mockStore({
      registerInstance: () => {
        throw new Error("register failed");
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    expect(mgr.canAdmitDurableJobs()).toBe(false);
    await expect(mgr.startJobWithDedup("claude", ["-p", "x"], "corr")).rejects.toThrow(
      /Durable async admission is disabled/
    );
  });

  it("N2a: a failed candidate read skips the sweep rather than losing PID grace", async () => {
    let recoverCalls = 0;
    const store = mockStore({
      selectStaleProcessCandidates: () => {
        throw new Error("candidate read unavailable");
      },
      recoverStaleJobs: () => {
        recoverCalls++;
        return [];
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    try {
      // Construction runs one guarded sweep, and the explicit call exercises a
      // later periodic/startup-style cycle. Neither may sweep without having
      // first read candidates and preserved any live PID grace.
      expect(recoverCalls).toBe(0);
      await mgr.runOrphanSweepNow();
      expect(recoverCalls).toBe(0);
    } finally {
      await mgr.dispose();
    }
  });

  it("N3: sustained heartbeat failure self-quiesces, then re-registers before recovering admission", async () => {
    let failHeartbeat = false;
    let registerCalls = 0;
    const store = mockStore({
      registerInstance: () => {
        registerCalls++;
      },
      heartbeat: () => {
        if (failHeartbeat) throw new Error("transient store outage");
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    expect(mgr.canAdmitDurableJobs()).toBe(true);

    failHeartbeat = true;
    await runHeartbeatTick(mgr);
    await runHeartbeatTick(mgr);
    await runHeartbeatTick(mgr);
    expect(mgr.canAdmitDurableJobs()).toBe(false);
    expect(mgr.getDurableAdmissionHealth()).toMatchObject({
      storeAttached: true,
      admitting: false,
      consecutiveHeartbeatFailures: 3,
      consecutiveHeartbeatSuccesses: 0,
      lastHeartbeatErrorName: "Error",
    });

    failHeartbeat = false;
    await runHeartbeatTick(mgr);
    await runHeartbeatTick(mgr);
    expect(mgr.canAdmitDurableJobs()).toBe(false);
    await runHeartbeatTick(mgr);

    expect(mgr.canAdmitDurableJobs()).toBe(true);
    expect(registerCalls).toBe(2); // initial admission + recovery re-registration
    expect(mgr.getDurableAdmissionHealth()).toMatchObject({
      admitting: true,
      consecutiveHeartbeatFailures: 0,
      consecutiveHeartbeatSuccesses: 0,
    });
    await mgr.dispose();
  });

  it("N4: a failed startup registration recovers without a process restart", async () => {
    let registrationAvailable = false;
    const store = mockStore({
      registerInstance: () => {
        if (!registrationAvailable) throw new Error("store unavailable at startup");
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    expect(mgr.canAdmitDurableJobs()).toBe(false);

    registrationAvailable = true;
    await runHeartbeatTick(mgr);
    await runHeartbeatTick(mgr);
    await runHeartbeatTick(mgr);

    expect(mgr.canAdmitDurableJobs()).toBe(true);
    expect(mgr.getDurableAdmissionHealth().lastHeartbeatRecoveryAt).toMatch(/T/);
    await mgr.dispose();
  });

  it("N5: a quiesced instance skips reaper GC writes until durable admission recovers", async () => {
    vi.useFakeTimers();
    let failHeartbeat = false;
    let gcCalls = 0;
    const store = mockStore({
      heartbeat: () => {
        if (failHeartbeat) throw new Error("transient store outage");
      },
      gcInstances: () => {
        gcCalls++;
        return 0;
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store, undefined, undefined, undefined, {
      instanceHeartbeatMs: 10_000,
      instanceLeaseTtlMs: 20_000,
      httpJobGraceMs: 20_000,
      orphanSweepIntervalMs: 1,
      instanceGcMs: 20_000,
    });

    try {
      failHeartbeat = true;
      await runHeartbeatTick(mgr);
      await runHeartbeatTick(mgr);
      await runHeartbeatTick(mgr);
      expect(mgr.canAdmitDurableJobs()).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(gcCalls).toBe(0);
    } finally {
      await mgr.dispose();
      vi.useRealTimers();
    }
  });

  it("N6: a quiesced instance skips periodic durable eviction writes until recovery", async () => {
    let failHeartbeat = false;
    let evictionCalls = 0;
    const store = mockStore({
      heartbeat: () => {
        if (failHeartbeat) throw new Error("transient store outage");
      },
      evictExpired: () => {
        evictionCalls++;
        return 0;
      },
    });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();

    try {
      failHeartbeat = true;
      await runHeartbeatTick(mgr);
      await runHeartbeatTick(mgr);
      await runHeartbeatTick(mgr);
      expect(mgr.canAdmitDurableJobs()).toBe(false);

      runEviction(mgr);
      expect(evictionCalls).toBe(0);
    } finally {
      await mgr.dispose();
    }
  });

  it("M9/M10: dispose deregisters the instance when no owned work remains, and is idempotent", async () => {
    const store = new SqliteJobStore(dbPath);
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    expect(instanceRows()).toBe(1);
    await mgr.dispose();
    expect(instanceRows()).toBe(0);
    // idempotent
    await expect(mgr.dispose()).resolves.toBeUndefined();
    await store.close();
  });
});

describe("#139 cross-LLM review round-1 regressions", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "orphan139-rvw-"));
    dbPath = join(tmpDir, "jobs.db");
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function setLease(dbp: string, id: string, value: number | null): void {
    const db = openDatabase(dbp);
    try {
      db.prepare("UPDATE jobs SET lease_deadline = ? WHERE id = ?").run(value, id);
    } finally {
      db.close();
    }
  }

  // Codex/Grok finding: markRunning must report whether it actually
  // transitioned, so a process launch fail-closes against a recovered row.
  it("markRunning returns true for a queued row and false once it is orphaned", async () => {
    const store = new SqliteJobStore(dbPath, undefined, { leaseTtlMs: 90000 });
    try {
      await store.recordStart({
        id: "j",
        correlationId: "c",
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: null,
        ownerInstance: "inst-A",
        transport: "process",
      });
      expect(await store.markRunning("j", { pid: 10 })).toBe(true);
      // Simulate the row being swept while it was queued: force it orphaned.
      const db = openDatabase(dbPath);
      db.prepare("UPDATE jobs SET status='orphaned' WHERE id='j'").run();
      db.close();
      expect(await store.markRunning("j", { pid: 20 })).toBe(false);
    } finally {
      await store.close();
    }
  });

  // Grok finding: the sqlite sweep must be a single guarded UPDATE...RETURNING;
  // a fresh-lease row in the same batch is never orphaned, and the returned list
  // is exactly the rows actually flipped.
  it("recoverStaleJobs orphans only the expired rows and returns exactly them", async () => {
    const store = new SqliteJobStore(dbPath, undefined, { leaseTtlMs: 90000 });
    try {
      for (const id of ["dead", "live"]) {
        await store.recordStart({
          id,
          correlationId: `c-${id}`,
          requestKey: `k-${id}`,
          cli: "claude",
          args: [],
          startedAt: new Date().toISOString(),
          pid: null,
          ownerInstance: "inst-A",
        });
      }
      setLease(dbPath, "dead", 1); // expired; "live" keeps its fresh lease
      const orphaned = await store.recoverStaleJobs(90000, 300000);
      expect(orphaned.map(o => o.id)).toEqual(["dead"]);
      expect((await store.getById("dead"))?.status).toBe("orphaned");
      expect((await store.getById("live"))?.status).toBe("queued");
    } finally {
      await store.close();
    }
  });

  // Codex/Grok finding: the advisory pid grace must be strictly one-shot. A
  // live same-host pid buys exactly one extra leaseTtl (advance + clear pid);
  // the next sweep no longer probes it and orphans it.
  it("the advisory pid grace is one-shot: advance+clear pid, then orphaned next sweep", async () => {
    const store = new SqliteJobStore(dbPath, undefined, { leaseTtlMs: 90000 });
    const mgr = new AsyncJobManager(noopLogger, undefined, store);
    await mgr.whenReady();
    try {
      // A dead owner's process job whose recorded pid is alive on THIS host.
      await store.registerInstance({
        instanceId: "dead-owner",
        role: "stdio",
        hostname: os.hostname(),
        pid: process.pid,
      });
      await store.recordStart({
        id: "reused",
        correlationId: "c",
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: process.pid, // a live same-host pid (kill(pid,0) succeeds)
        ownerInstance: "dead-owner",
        transport: "process",
      });
      await store.markRunning("reused", { pid: process.pid });
      setLease(dbPath, "reused", 1); // lease expired

      // Sweep 1: pid is alive + same host -> grace (advance lease, clear pid),
      // NOT orphaned.
      await mgr.runOrphanSweepNow();
      expect((await store.getById("reused"))?.status).toBe("running");
      expect((await store.getById("reused"))?.pid).toBeNull(); // pid cleared -> one-shot
      expect((await store.getById("reused"))?.leaseDeadline).toBeGreaterThan(Date.now());

      // The extra leaseTtl lapses.
      setLease(dbPath, "reused", 1);
      // Sweep 2: pid is NULL now, so it is not re-probed and IS orphaned.
      await mgr.runOrphanSweepNow();
      expect((await store.getById("reused"))?.status).toBe("orphaned");
    } finally {
      await mgr.dispose();
      await store.close();
    }
  });
});
