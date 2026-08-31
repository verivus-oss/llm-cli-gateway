import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FlightRecorder, compactFlightRecorderFile } from "../flight-recorder.js";
import { SqliteJobStore, type ValidationRunStore } from "../job-store.js";
import { openDatabase } from "../sqlite-driver.js";
import { SqliteStorageDriver } from "../storage/drivers/sqlite.js";
import {
  MILLIS_PER_DAY,
  RETENTION_SUBSYSTEMS,
  persistenceRetentionPolicy,
  resolveRetentionPolicy,
  retentionCutoffIso,
  retentionSweepEnabled,
  unboundedRetentionSubsystems,
} from "../storage/retention.js";
import { RetentionSweeper } from "../storage/retention-sweeper.js";
import { FLIGHT_RECORDER_OPERATION_CLASSES } from "../storage/operations.js";

const noopLogger = { info: (): void => {}, error: (): void => {}, debug: (): void => {} };

describe("the policy is one declaration, and its destructive bounds are OFF", () => {
  it("bounds jobs exactly as today and bounds nothing else by default", () => {
    const policy = resolveRetentionPolicy({ jobRetentionDays: 30 });
    expect(policy.days.jobs).toBe(30);
    // The load-bearing assertion of this whole node. A number here would delete
    // a year of transcripts from every installed host on upgrade.
    expect(policy.days.requests).toBeNull();
    expect(policy.days.wedgedValidationRuns).toBeNull();
    expect(unboundedRetentionSubsystems(policy).sort()).toEqual([
      "requests",
      "wedgedValidationRuns",
    ]);
    expect(retentionSweepEnabled(policy)).toBe(false);
  });

  it("carries [persistence].retentionDays through rather than restating 30", () => {
    expect(resolveRetentionPolicy({ jobRetentionDays: 7 }).days.jobs).toBe(7);
    expect(RETENTION_SUBSYSTEMS.jobs.defaultDays).toBe(30);
    expect(RETENTION_SUBSYSTEMS.requests.defaultDays).toBeNull();
  });

  it("turns a bound on only when the operator writes a number", () => {
    const policy = resolveRetentionPolicy({
      jobRetentionDays: 30,
      overrides: { requests: 90, wedgedValidationRuns: 14 },
    });
    expect(policy.days.requests).toBe(90);
    expect(retentionSweepEnabled(policy)).toBe(true);
    const now = Date.UTC(2026, 0, 100);
    expect(retentionCutoffIso(policy, "requests", now)).toBe(
      new Date(now - 90 * MILLIS_PER_DAY).toISOString()
    );
    expect(
      retentionCutoffIso(resolveRetentionPolicy({ jobRetentionDays: 30 }), "requests", now)
    ).toBeNull();
  });

  it("answers a hand-built config with the same resolver, not a second opinion", () => {
    // 58 test files construct PersistenceConfig by hand. This is the ONE place
    // that absence is answered; if it ever diverged from resolveRetentionPolicy
    // the defaults would depend on who built the object.
    expect(persistenceRetentionPolicy({ retentionDays: 5 })).toEqual(
      resolveRetentionPolicy({ jobRetentionDays: 5 })
    );
    const explicit = resolveRetentionPolicy({ jobRetentionDays: 5, overrides: { requests: 3 } });
    expect(persistenceRetentionPolicy({ retentionDays: 5, retention: explicit })).toBe(explicit);
  });
});

describe("the transcript termination", () => {
  let dir: string;
  let dbPath: string;
  let recorder: FlightRecorder;

  const OLD = "2020-01-01T00:00:00.000Z";
  const NEW = "2099-01-01T00:00:00.000Z";

  async function seed(id: string, datetimeUtc: string, padBytes = 0): Promise<void> {
    // The padding is what makes `reclaimableBytes` and the compaction
    // measurable: two short rows fit inside one page, so deleting them frees
    // nothing and a zero would be a true measurement of the wrong fixture.
    const pad = "x".repeat(padBytes);
    await recorder.logStart({
      correlationId: id,
      cli: "claude",
      model: "m",
      prompt: `p-${id}${pad}`,
    });
    await recorder.logComplete(id, {
      response: `r-${id}${pad}`,
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "CLOSED",
      exitCode: 0,
      optimizationApplied: false,
      status: "completed",
    });
    // The recorder stamps `datetime_utc` at logStart, so ageing a row means
    // writing the column directly. Done on a separate handle, after the write.
    const db = openDatabase(dbPath);
    try {
      db.prepare("UPDATE requests SET datetime_utc = ? WHERE id = ?").run(datetimeUtc, id);
    } finally {
      db.close();
    }
  }

  function ids(table: string, column: string): string[] {
    const db = openDatabase(dbPath);
    try {
      return (
        db.prepare(`SELECT ${column} AS k FROM ${table} ORDER BY ${column}`).all() as Array<{
          k: string;
        }>
      ).map(row => row.k);
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "s11-fr-"));
    dbPath = join(dir, "logs.db");
    recorder = new FlightRecorder(dbPath, { redactSecrets: false });
    await seed("old-1", OLD, 40_000);
    await seed("old-2", OLD, 40_000);
    await seed("keep-1", NEW);
    await seed("keep-2", NEW);
  });

  afterEach(async () => {
    await recorder.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("deletes what is past the bound and LEAVES the rest whole", async () => {
    const deleted = await recorder.evictExpiredRequests("2030-01-01T00:00:00.000Z", 500);
    expect(deleted).toBe(2);
    // What SURVIVES, not only what went. A sweep that emptied the table would
    // pass "the old rows are gone".
    expect(ids("requests", "id")).toEqual(["keep-1", "keep-2"]);
    expect(ids("gateway_metadata", "request_id")).toEqual(["keep-1", "keep-2"]);
    const survivor = await recorder.readRequestById("keep-1");
    expect(survivor?.prompt).toBe("p-keep-1");
    expect(survivor?.response).toBe("r-keep-1");
  });

  it("takes the metadata row with the request, which the foreign key requires", async () => {
    // The CONTROL for the delete ordering. `gateway_metadata.request_id
    // REFERENCES requests(id)` and the recorder runs with foreign_keys = ON, so
    // the obvious single-statement delete fails on every row that has metadata.
    const db = openDatabase(dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      expect(() =>
        db.prepare("DELETE FROM requests WHERE datetime_utc < ?").run("2030-01-01T00:00:00.000Z")
      ).toThrow(/FOREIGN KEY/i);
    } finally {
      db.close();
    }
    await recorder.evictExpiredRequests("2030-01-01T00:00:00.000Z", 500);
    expect(ids("gateway_metadata", "request_id")).toEqual(["keep-1", "keep-2"]);
  });

  it("honours the row bound the caller passes", async () => {
    expect(await recorder.evictExpiredRequests("2030-01-01T00:00:00.000Z", 1)).toBe(1);
    expect(ids("requests", "id").length).toBe(3);
  });

  it("runs as `retention`, not as `write`", async () => {
    // DYNAMIC, not the static class table: the declaration proves what was
    // written down, and this proves what the driver was actually asked for.
    const classes: string[] = [];
    const real = SqliteStorageDriver.prototype.transaction;
    const spy = vi.spyOn(SqliteStorageDriver.prototype, "transaction").mockImplementation(function (
      this: SqliteStorageDriver,
      operation,
      fn
    ) {
      classes.push(operation);
      return real.call(this, operation, fn);
    });
    try {
      await recorder.evictExpiredRequests("2030-01-01T00:00:00.000Z", 500);
    } finally {
      spy.mockRestore();
    }
    expect(classes).toEqual(["retention"]);
    expect(FLIGHT_RECORDER_OPERATION_CLASSES.evictExpiredRequests).toBe("retention");
  });

  it("reports reclaimable bytes, because DELETE does not shrink the file", async () => {
    await recorder.evictExpiredRequests("2030-01-01T00:00:00.000Z", 500);
    const stats = await recorder.readStorageStats();
    expect(stats.requestRows).toBe(2);
    // The point of the number: pages went on the freelist, the file did not
    // shrink, and compaction is a separate explicit step.
    expect(stats.reclaimableBytes).not.toBeNull();
    expect(stats.reclaimableBytes).toBeGreaterThan(0);
  });

  it("counts what a bound WOULD delete without deleting it", async () => {
    const stats = await recorder.readStorageStats("2030-01-01T00:00:00.000Z");
    expect(stats.requestsBeyondRetention).toBe(2);
    expect(stats.requestRows).toBe(4);
  });

  it("compacts only when an operator asks, and returns the bytes it freed", async () => {
    await recorder.evictExpiredRequests("2030-01-01T00:00:00.000Z", 500);
    await recorder.close();
    const before = statSync(dbPath).size;
    const result = await compactFlightRecorderFile(dbPath);
    expect(result.beforeBytes).toBe(before);
    expect(result.afterBytes).toBeLessThan(before);
    const db = openDatabase(dbPath);
    try {
      // Compaction must move no rows.
      expect((db.prepare("SELECT COUNT(*) AS n FROM requests").get() as { n: number }).n).toBe(2);
      expect(
        (db.prepare("PRAGMA freelist_count").get() as { freelist_count: number }).freelist_count
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("the wedged-validation-run termination", () => {
  let dir: string;
  let dbPath: string;
  let store: SqliteJobStore & ValidationRunStore;

  const OLD = "2020-01-01T00:00:00.000Z";
  const RECENT = "2099-01-01T00:00:00.000Z";
  const CUTOFF = "2030-01-01T00:00:00.000Z";

  async function addJob(id: string): Promise<void> {
    await store.recordStart({
      id,
      correlationId: `c-${id}`,
      requestKey: `k-${id}`,
      cli: "claude",
      args: [],
      startedAt: OLD,
      pid: null,
      ownerPrincipal: "alice",
    });
  }

  async function addRun(
    validationId: string,
    status: "running" | "finalized" | "admitting" | "judge_skipped" | "admission_failed",
    createdAt: string,
    jobIds: string[]
  ): Promise<void> {
    await store.recordValidationRun({
      validationId,
      ownerPrincipal: "alice",
      intent: "validate",
      createdAt,
      requestJson: JSON.stringify({ question: "q", modelList: ["claude"] }),
      providerLinks: jobIds.map(jobId => ({
        provider: "claude",
        jobId,
        correlationId: `c-${jobId}`,
      })),
      judgeLink: null,
      status,
    });
  }

  function runIds(): string[] {
    const db = openDatabase(dbPath);
    try {
      return (
        db
          .prepare("SELECT validation_id AS k FROM validation_runs ORDER BY validation_id")
          .all() as Array<{ k: string }>
      ).map(row => row.k);
    } finally {
      db.close();
    }
  }

  function linkRuns(): string[] {
    const db = openDatabase(dbPath);
    try {
      return (
        db
          .prepare("SELECT validation_id AS k FROM validation_run_jobs ORDER BY validation_id")
          .all() as Array<{ k: string }>
      ).map(row => row.k);
    } finally {
      db.close();
    }
  }

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "s11-vr-"));
    dbPath = join(dir, "jobs.db");
    store = new SqliteJobStore(dbPath) as SqliteJobStore & ValidationRunStore;
    await addJob("job-live");
    // wedged: old, non-terminal, zero seats (the 14-row leak).
    await addRun("wedged-zero-seat", "running", OLD, []);
    // wedged: old, non-terminal, seats whose jobs retention already took.
    await addRun("wedged-jobs-gone", "running", OLD, ["job-evicted"]);
    // NOT wedged: its linked job survives, so mint-on-read can still finalize.
    await addRun("unfinished-job-alive", "running", OLD, ["job-live"]);
    // NOT wedged: too recent.
    await addRun("recent", "running", RECENT, []);
    // NOT wedged, and never: a finalized run owns an immutable receipt.
    await addRun("finalized-old", "finalized", OLD, []);
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("counts only what the three clauses admit", async () => {
    expect(await store.countWedgedValidationRuns(CUTOFF)).toBe(2);
  });

  it("deletes the wedged runs and LEAVES every other row", async () => {
    expect(await store.evictWedgedValidationRuns(CUTOFF, 500)).toBe(2);
    expect(runIds()).toEqual(["finalized-old", "recent", "unfinished-job-alive"]);
  });

  it("cascades to validation_run_jobs, which nothing else ever did", async () => {
    expect(linkRuns()).toEqual(["unfinished-job-alive", "wedged-jobs-gone"]);
    await store.evictWedgedValidationRuns(CUTOFF, 500);
    expect(linkRuns()).toEqual(["unfinished-job-alive"]);
  });

  it("stops protecting a run once job retention has taken its last job", async () => {
    // The clause is about the JOB, not about the link row. Evict the job and
    // the same run becomes wedged without anything else changing.
    expect(await store.countWedgedValidationRuns(CUTOFF)).toBe(2);
    const db = openDatabase(dbPath);
    try {
      db.prepare("DELETE FROM jobs WHERE id = ?").run("job-live");
    } finally {
      db.close();
    }
    expect(await store.countWedgedValidationRuns(CUTOFF)).toBe(3);
  });

  it("honours the row bound", async () => {
    expect(await store.evictWedgedValidationRuns(CUTOFF, 1)).toBe(1);
    expect(runIds().length).toBe(4);
  });

  it("runs as `retention`, not as `write`", async () => {
    const classes: string[] = [];
    const real = SqliteStorageDriver.prototype.transaction;
    const spy = vi.spyOn(SqliteStorageDriver.prototype, "transaction").mockImplementation(function (
      this: SqliteStorageDriver,
      operation,
      fn
    ) {
      classes.push(operation);
      return real.call(this, operation, fn);
    });
    try {
      await store.evictWedgedValidationRuns(CUTOFF, 500);
    } finally {
      spy.mockRestore();
    }
    expect(classes).toEqual(["retention"]);
  });
});

describe("the sweeper reads the count it produces", () => {
  const policy = resolveRetentionPolicy({
    jobRetentionDays: 30,
    overrides: { requests: 1, wedgedValidationRuns: 1 },
  });

  function fakeRecorder(rows: number): {
    recorder: {
      readStorageStats: (cutoff?: string) => Promise<Record<string, unknown>>;
      evictExpiredRequests: (cutoff: string, limit: number) => Promise<number>;
    };
    calls: number[];
    remaining: () => number;
  } {
    let remaining = rows;
    const calls: number[] = [];
    return {
      calls,
      remaining: () => remaining,
      recorder: {
        readStorageStats: async () => ({
          schemaVersion: 1,
          requestRows: remaining,
          oldestRequest: null,
          newestRequest: null,
          requestsBeyondRetention: remaining,
          reclaimableBytes: 0,
          coResident: [],
        }),
        evictExpiredRequests: async (_cutoff: string, limit: number) => {
          calls.push(limit);
          const took = Math.min(limit, remaining);
          remaining -= took;
          return took;
        },
      },
    };
  }

  const noRuns = {
    countWedgedValidationRuns: async () => 0,
    evictWedgedValidationRuns: async () => 0,
  };

  it("carries the deleted count out to a surface, instead of dropping it", async () => {
    const fake = fakeRecorder(7);
    const sweeper = new RetentionSweeper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recorder: fake.recorder as any,
      validationRuns: noRuns,
      policy,
      logger: noopLogger,
      batchRows: 5,
    });
    expect(sweeper.lastSweep()).toBeNull();
    const report = await sweeper.sweep();
    expect(report.subsystems.requests.eligible).toBe(7);
    expect(report.subsystems.requests.deleted).toBe(7);
    // The hazard-9 assertion: the count survives past the call that produced it.
    expect(sweeper.lastSweep()).toBe(report);
    expect(fake.remaining()).toBe(0);
  });

  it("stops at the per-tick budget and SAYS so", async () => {
    const fake = fakeRecorder(1000);
    const sweeper = new RetentionSweeper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recorder: fake.recorder as any,
      validationRuns: noRuns,
      policy,
      logger: noopLogger,
      batchRows: 10,
      maxBatches: 3,
    });
    const report = await sweeper.sweep();
    expect(report.subsystems.requests.deleted).toBe(30);
    expect(report.subsystems.requests.budgetExhausted).toBe(true);
    expect(fake.remaining()).toBe(970);
  });

  it("previews without deleting", async () => {
    const fake = fakeRecorder(7);
    const sweeper = new RetentionSweeper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recorder: fake.recorder as any,
      validationRuns: noRuns,
      policy,
      logger: noopLogger,
    });
    const report = await sweeper.preview();
    expect(report.subsystems.requests.eligible).toBe(7);
    expect(report.subsystems.requests.deleted).toBe(0);
    expect(fake.calls).toEqual([]);
    expect(fake.remaining()).toBe(7);
  });

  it("reports a failed subsystem rather than a clean sweep", async () => {
    const sweeper = new RetentionSweeper({
      recorder: {
        readStorageStats: async () => {
          throw new Error("disk I/O error");
        },
        evictExpiredRequests: async () => 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      validationRuns: noRuns,
      policy,
      logger: noopLogger,
    });
    const report = await sweeper.sweep();
    expect(report.subsystems.requests.error).toMatch(/disk I\/O error/);
    expect(report.subsystems.requests.deleted).toBe(0);
    // NOT null-eligible-and-clean: an unset bound and a failed read must not
    // present the same way.
    expect(report.subsystems.requests.eligible).toBeNull();
  });

  it("uses the configured health-safe failure formatter", async () => {
    const sweeper = new RetentionSweeper({
      recorder: {
        readStorageStats: async () => {
          throw new Error("connect ENOENT /tmp/dsn-health-secret/.s.PGSQL.5432");
        },
        evictExpiredRequests: async () => 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      validationRuns: noRuns,
      policy,
      logger: noopLogger,
      failureMessage: () => "PostgreSQL operation failed",
    });
    const report = await sweeper.sweep();
    expect(report.subsystems.requests.error).toBe("PostgreSQL operation failed");
    expect(report.subsystems.requests.error).not.toContain("dsn-health-secret");
  });

  it("does nothing at all while every destructive bound is unset", async () => {
    const fake = fakeRecorder(7);
    const sweeper = new RetentionSweeper({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      recorder: fake.recorder as any,
      validationRuns: noRuns,
      policy: resolveRetentionPolicy({ jobRetentionDays: 30 }),
      logger: noopLogger,
    });
    expect(sweeper.start(1000)).toBe(false);
    expect(sweeper.armed).toBe(false);
    const report = await sweeper.sweep();
    expect(report.subsystems.requests.eligible).toBeNull();
    expect(fake.remaining()).toBe(7);
    sweeper.stop();
  });

  it("does not let a second tick re-enter the first", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let evictions = 0;
    const sweeper = new RetentionSweeper({
      recorder: {
        readStorageStats: async () => {
          await gate;
          return { requestsBeyondRetention: 3, requestRows: 3, coResident: [] };
        },
        evictExpiredRequests: async () => {
          evictions += 1;
          return 0;
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      validationRuns: noRuns,
      policy,
      logger: noopLogger,
    });
    const first = sweeper.sweep();
    // Submitted while the first is parked inside its own read. The guard is set
    // in the synchronous prologue, so this must not start a second pass.
    const second = sweeper.sweep();
    release?.();
    await Promise.all([first, second]);
    expect(evictions).toBe(1);
  });
});
