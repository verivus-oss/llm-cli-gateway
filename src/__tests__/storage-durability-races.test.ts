/**
 * The DUR fix list: writes that were safe only because the store was
 * synchronous and the next line could not yield.
 *
 * Every case here asserts the DATABASE, not a caller's return value, and every
 * interleave is arranged rather than waited for. Two mechanisms do the
 * arranging, and neither is a sleep:
 *
 *   - a two-way gate around one store method, so the test knows the write has
 *     ARRIVED and decides when it is RELEASED;
 *   - a snapshot taken on a separate handle after EVERY transaction the store
 *     commits, so an atomicity claim is checked against every state an outside
 *     reader could see rather than only the last one.
 *
 * A third mechanism was tried and DISCARDED: submitting two operations in one
 * tick and relying on the driver's FIFO transaction queue. Submission order
 * turned out to be decided by how many microtask hops precede
 * `driver.transaction`, not by the thing under test, and two such controls
 * failed on the FIXED code, which is how that was caught.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import {
  SqliteJobStore,
  type JobStore,
  type JobStoreStatus,
  type ValidationRunStore,
  computeRequestKey,
} from "../job-store.js";
import { openDatabase } from "../sqlite-driver.js";

/** Force one job's fencing lease into the past: its owner looks dead. */
function expireLease(dbPath: string, jobId: string): void {
  const db = openDatabase(dbPath);
  try {
    db.prepare("UPDATE jobs SET lease_deadline = 1 WHERE id = ?").run(jobId);
  } finally {
    db.close();
  }
}

/**
 * Backdate an instance's heartbeat, so a later heartbeat is STRICTLY greater
 * without depending on a clock tick.
 *
 * `last_heartbeat` is written by SQLite (`SQL_HEARTBEAT_INSTANCE` uses
 * `julianday('now')`), NOT by `Date.now()`. An earlier attempt to separate the
 * two writes spied on `Date.now` and offset it by a second; that never touched
 * this column and the test still failed in CI with
 * `expected <n> to be greater than <n>` when both writes landed in the same
 * millisecond. Mirrors expireLease: pick a value nothing can collide with.
 */
function ageHeartbeat(dbPath: string, instanceId: string): void {
  const db = openDatabase(dbPath);
  try {
    db.prepare("UPDATE gateway_instances SET last_heartbeat = 1 WHERE instance_id = ?").run(
      instanceId
    );
  } finally {
    db.close();
  }
}

function readRow(dbPath: string, jobId: string): { status: string; stdout: string } {
  const db = openDatabase(dbPath);
  try {
    return db.prepare("SELECT status, stdout FROM jobs WHERE id = ?").get(jobId) as {
      status: string;
      stdout: string;
    };
  } finally {
    db.close();
  }
}

/**
 * Settle a promise without asserting on it, so the DATABASE assertion runs
 * first. `rejects.toThrow()` aborts the test on a resolve, and the row count is
 * the evidence, not the throw.
 */
async function settle(p: Promise<unknown>): Promise<{ rejectedWith: string }> {
  try {
    await p;
    return { rejectedWith: "" };
  } catch (err) {
    return { rejectedWith: err instanceof Error ? err.message : String(err) };
  }
}

/** Just enough of the storage driver to wrap `transaction` and count commits. */
interface StorageDriverLike {
  transaction: <T>(operation: string, body: (connection: never) => Promise<T>) => Promise<T>;
}

/** Arrival and release, both explicit. */
function twoWayGate(): {
  arrived: Promise<void>;
  arrive: () => void;
  release: () => void;
  released: Promise<void>;
} {
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>(resolve => (arrive = resolve));
  const released = new Promise<void>(resolve => (release = resolve));
  return { arrived, arrive, release, released };
}

describe("DEFECT 1: an orphaned row stops absorbing this instance's output", () => {
  let tempDir: string;
  let dbPath: string;
  let store: JobStore;
  let manager: AsyncJobManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "dur-output-fence-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath);
    manager = new AsyncJobManager(undefined, undefined, store);
    await manager.whenStartupSettled();
  });

  afterEach(async () => {
    await manager.dispose();
    await store.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("a flush decided before a sweep cannot move the body of the row the sweep orphaned", async () => {
    await store.recordStart({
      id: "swept-job",
      correlationId: "corr-swept-job",
      requestKey: computeRequestKey("claude", ["-p", "swept"]),
      cli: "claude",
      args: ["-p", "swept"],
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      pid: 4242,
    });
    expect(await store.recordOutput("swept-job", "EARLY", "", false, ["queued", "running"])).toBe(
      true
    );

    // The in-memory record the manager flushes from. It believes the row is
    // still open, which it is at the moment the flush is decided on.
    const internals = manager as unknown as {
      jobs: Map<string, Record<string, unknown>>;
      maybeFlushOutput(job: Record<string, unknown>, force?: boolean): Promise<void>;
    };
    const job: Record<string, unknown> = {
      id: "swept-job",
      cli: "claude",
      correlationId: "corr-swept-job",
      status: "running",
      stdout: "EARLY+LATE",
      stderr: "",
      outputTruncated: false,
      outputDirty: true,
      lastOutputFlushAt: 0,
      ownerPrincipal: null,
      terminalPersisted: false,
      terminalRowOwned: false,
      kitExecution: null,
    };
    internals.jobs.set("swept-job", job);

    // The gate sits at the store boundary, so the flush's expected-status set
    // has already been computed from the pre-sweep job state. That is the real
    // race: the manager decided, and the row moved before its write ran.
    const gate = twoWayGate();
    const realRecordOutput = store.recordOutput.bind(store);
    store.recordOutput = async (id, stdout, stderr, truncated, expected) => {
      gate.arrive();
      await gate.released;
      return realRecordOutput(id, stdout, stderr, truncated, expected);
    };

    const flush = internals.maybeFlushOutput(job, true);
    await gate.arrived;

    // The sweep wins the row while the flush is held.
    expireLease(dbPath, "swept-job");
    const orphaned = await store.recoverStaleJobs(30_000, 30_000, []);
    expect(orphaned.map(o => o.id)).toContain("swept-job");
    expect(readRow(dbPath, "swept-job")).toEqual({ status: "orphaned", stdout: "EARLY" });

    gate.release();
    await flush;

    // THE PROPERTY, read off the database. Unfenced, the status stayed
    // `orphaned` (monotonic, so it hides the loss) while the body moved to
    // EARLY+LATE and llm_job_result and llm_request_result then disagreed.
    expect(readRow(dbPath, "swept-job")).toEqual({ status: "orphaned", stdout: "EARLY" });
    // ...and the loss is REPORTED rather than swallowed by a void return.
    expect(job.durableOutputRowLost).toBe(true);
  });

  it("output captured after this instance's own terminal write still lands", async () => {
    // The fence must not be "never write after terminal": persistLateOutput is
    // a legitimate writer on the exact terminal row this instance committed.
    await store.recordStart({
      id: "late-output",
      correlationId: "corr-late-output",
      requestKey: computeRequestKey("claude", ["-p", "late"]),
      cli: "claude",
      args: ["-p", "late"],
      startedAt: new Date().toISOString(),
      pid: 99,
    });
    expect(
      await store.recordComplete({
        id: "late-output",
        status: "completed",
        exitCode: 0,
        stdout: "FIRST",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: new Date().toISOString(),
      })
    ).toBe(true);

    const internals = manager as unknown as {
      persistLateOutput(job: Record<string, unknown>): Promise<void>;
    };
    const job: Record<string, unknown> = {
      id: "late-output",
      cli: "claude",
      correlationId: "corr-late-output",
      status: "completed",
      stdout: "FIRST+LATE",
      stderr: "",
      outputTruncated: false,
      outputDirty: true,
      lastOutputFlushAt: 0,
      ownerPrincipal: null,
      terminalPersisted: true,
      terminalRowOwned: true,
      kitExecution: null,
    };
    await internals.persistLateOutput(job);

    expect(readRow(dbPath, "late-output")).toEqual({ status: "completed", stdout: "FIRST+LATE" });
    expect(job.durableOutputRowLost).toBeFalsy();
  });

  it("the store refuses an output write on a status the caller does not claim", async () => {
    await store.recordStart({
      id: "predicate-job",
      correlationId: "corr-predicate",
      requestKey: computeRequestKey("claude", ["-p", "predicate"]),
      cli: "claude",
      args: ["-p", "predicate"],
      startedAt: new Date().toISOString(),
      pid: 7,
    });
    const open: JobStoreStatus[] = ["queued", "running"];
    expect(await store.recordOutput("predicate-job", "A", "", false, open)).toBe(true);
    expect(await store.recordOutput("predicate-job", "B", "", false, ["canceled"])).toBe(false);
    expect(readRow(dbPath, "predicate-job").stdout).toBe("A");
    expect(await store.recordOutput("no-such-row", "C", "", false, open)).toBe(false);
  });
});

describe("DEFECT 2: the heartbeat is one transaction, so a sweep cannot split it", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteJobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dur-heartbeat-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath, undefined, { leaseTtlMs: 30_000 });
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("no committed state has the instance refreshed while its job lease is not", async () => {
    // The first draft of this raced a sweep against the heartbeat and asserted
    // the job stayed open. That control was WRONG in both directions: with the
    // fix a sweep that runs entirely BEFORE the heartbeat legitimately orphans
    // the row, and submission order turned out to be decided by how many
    // microtask hops precede `driver.transaction`, not by the defect. It failed
    // on the fixed code, which is how it was caught.
    //
    // The property has nothing to do with a sweep. It is that the two writes
    // are one unit, and the way to see that is to look at every state an
    // outside reader could commit-observe: a snapshot after EVERY transaction
    // the store lands, taken on a separate handle. Split in two, the state
    // after the first is exactly the window the sweep exploits.
    await store.registerInstance({ instanceId: "inst-A", hostname: "host-A", pid: 1234 });
    await store.recordStart({
      id: "live-job",
      correlationId: "corr-live-job",
      requestKey: computeRequestKey("claude", ["-p", "live"]),
      cli: "claude",
      args: ["-p", "live"],
      startedAt: new Date(Date.now() - 5_000).toISOString(),
      pid: 1234,
      ownerInstance: "inst-A",
      ownerHostname: "host-A",
    });
    expireLease(dbPath, "live-job");
    // Both halves of the property need a baseline the heartbeat is guaranteed
    // to move past, or the guard below never fires and the loop asserts
    // NOTHING while still reporting green.
    ageHeartbeat(dbPath, "inst-A");

    const snapshot = (): { lastHeartbeat: number; leaseDeadline: number } => {
      const db = openDatabase(dbPath);
      try {
        return {
          lastHeartbeat: (
            db
              .prepare("SELECT last_heartbeat AS h FROM gateway_instances WHERE instance_id = ?")
              .get("inst-A") as { h: number }
          ).h,
          leaseDeadline: (
            db
              .prepare("SELECT COALESCE(lease_deadline, 0) AS d FROM jobs WHERE id = ?")
              .get("live-job") as { d: number }
          ).d,
        };
      } finally {
        db.close();
      }
    };

    const before = snapshot();
    const driver = (store as unknown as { driver: StorageDriverLike }).driver;
    const realTransaction = driver.transaction.bind(driver);
    const committed: Array<{ lastHeartbeat: number; leaseDeadline: number }> = [];
    driver.transaction = async (operation, body) => {
      const result = await realTransaction(operation, body);
      committed.push(snapshot());
      return result;
    };
    // No clock is mocked here on purpose. Both columns are written by SQLite,
    // so a Date.now spy moves neither; `ageHeartbeat` above is what makes the
    // comparison deterministic.
    try {
      expect(await store.heartbeat("inst-A")).toEqual({
        instanceRowRefreshed: true,
        jobLeasesAdvanced: 1,
      });
    } finally {
      driver.transaction = realTransaction;
    }

    // THE PROPERTY, over every committed state rather than only the last one:
    // an instance that looks alive has already renewed its jobs' leases. As two
    // transactions the state after the first said "instance alive, lease still
    // expired", and a sweep landing there orphaned the jobs of a live instance
    // while its own second UPDATE then matched zero rows.
    expect(committed.length).toBeGreaterThan(0);
    for (const state of committed) {
      if (state.lastHeartbeat > before.lastHeartbeat) {
        expect(state.leaseDeadline).toBeGreaterThan(before.leaseDeadline);
      }
    }
    expect(committed.at(-1)!.lastHeartbeat).toBeGreaterThan(before.lastHeartbeat);
  });

  it("a heartbeat whose instance row was GC'd says so instead of returning void", async () => {
    await store.registerInstance({ instanceId: "inst-B", hostname: "host-B", pid: 22 });
    expect(await store.heartbeat("inst-B")).toEqual({
      instanceRowRefreshed: true,
      jobLeasesAdvanced: 0,
    });

    // gcInstances removes an instance every other instance already treats as
    // dead. The old `void` heartbeat kept reporting healthy forever after.
    expect(await store.gcInstances(-1)).toBe(1);
    expect(await store.heartbeat("inst-B")).toEqual({
      instanceRowRefreshed: false,
      jobLeasesAdvanced: 0,
    });
  });

  it("the manager re-registers an instance row the heartbeat found missing", async () => {
    const manager = new AsyncJobManager(undefined, undefined, store);
    await manager.whenStartupSettled();
    const instanceRows = (): number => {
      const db = openDatabase(dbPath);
      try {
        return (db.prepare("SELECT COUNT(*) AS n FROM gateway_instances").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    expect(instanceRows()).toBe(1);

    expect(await store.gcInstances(-1)).toBe(1);
    expect(instanceRows()).toBe(0);

    await (
      manager as unknown as { onHeartbeatTick: (intervalMs: number) => Promise<void> }
    ).onHeartbeatTick(15_000);

    // Read off the database, not off the return value.
    expect(instanceRows()).toBe(1);
    await manager.dispose();
  });
});

describe("DEFECT 3: a receipt and its run status land together or not at all", () => {
  let tempDir: string;
  let dbPath: string;
  let store: SqliteJobStore & ValidationRunStore;

  const receipt = (validationId: string, owner: string) => ({
    validationId,
    ownerPrincipal: owner,
    mintedAt: new Date().toISOString(),
    schemaVersion: "validation-receipt.v1",
    reportJson: JSON.stringify({ validationId }),
    canonicalSha256: "a".repeat(64),
    prevSha256: null,
    seq: null,
    signature: null,
    models: ["claude"],
    hasMaterialDisagreement: false,
    confidence: "high",
  });

  const run = (validationId: string, owner: string) => ({
    validationId,
    ownerPrincipal: owner,
    intent: "review" as const,
    status: "running" as const,
    requestJson: JSON.stringify({
      question: "q",
      content: "c",
      focus: null,
      modelList: ["claude"],
    }),
    createdAt: new Date().toISOString(),
    providerLinks: [],
    judgeLink: null,
  });

  function receiptRows(): number {
    const db = openDatabase(dbPath);
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM validation_receipts").get() as { n: number }).n;
    } finally {
      db.close();
    }
  }

  function runStatus(validationId: string): string | undefined {
    const db = openDatabase(dbPath);
    try {
      return (
        db
          .prepare("SELECT status FROM validation_runs WHERE validation_id = ?")
          .get(validationId) as { status: string } | undefined
      )?.status;
    } finally {
      db.close();
    }
  }

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "dur-receipt-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath) as SqliteJobStore & ValidationRunStore;
  });

  afterEach(async () => {
    await store.close().catch(() => undefined);
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("mints the receipt and finalizes the run in one step", async () => {
    await store.recordValidationRun(run("v-ok", "alice"));
    const stored = await store.finalizeValidationReceipt(receipt("v-ok", "alice"));
    expect(stored.validationId).toBe("v-ok");
    expect(receiptRows()).toBe(1);
    expect(runStatus("v-ok")).toBe("finalized");
  });

  it("leaves NO receipt behind when the run it belongs to cannot be finalized", async () => {
    // The run row is gone: a retention sweep removed it, or it never existed.
    // As three awaits the INSERT OR IGNORE still landed, the unfenced status
    // UPDATE matched zero rows, and `stored ?? record` returned kind "minted"
    // for a receipt attached to nothing.
    const outcome = await settle(store.finalizeValidationReceipt(receipt("v-gone", "alice")));
    // The DATABASE first: this is the assertion that fails on the three-await
    // mint, where the INSERT OR IGNORE had already committed on its own.
    expect(receiptRows()).toBe(0);
    expect(outcome.rejectedWith).toMatch(/missing or owned by another principal/);
  });

  it("refuses to finalize another principal's run, and rolls the receipt back with it", async () => {
    await store.recordValidationRun(run("v-bob", "bob"));
    const outcome = await settle(store.finalizeValidationReceipt(receipt("v-bob", "alice")));
    expect(receiptRows()).toBe(0);
    expect(runStatus("v-bob")).toBe("running");
    expect(outcome.rejectedWith).toMatch(/missing or owned by another principal/);
  });

  it("no committed state has the receipt present with the run still running", async () => {
    // Same mechanism as the heartbeat case, and for the same reason: a first
    // draft raced a reader against the mint and measured microtask hops rather
    // than atomicity. Snapshot after EVERY transaction the store commits, on a
    // separate handle, and forbid the half-state in all of them.
    await store.recordValidationRun(run("v-obs", "alice"));

    const snapshot = (): { receipts: number; status: string | undefined } => ({
      receipts: receiptRows(),
      status: runStatus("v-obs"),
    });

    const driver = (store as unknown as { driver: StorageDriverLike }).driver;
    const realTransaction = driver.transaction.bind(driver);
    const committed: Array<{ receipts: number; status: string | undefined }> = [];
    driver.transaction = async (operation, body) => {
      const result = await realTransaction(operation, body);
      committed.push(snapshot());
      return result;
    };
    try {
      await store.finalizeValidationReceipt(receipt("v-obs", "alice"));
    } finally {
      driver.transaction = realTransaction;
    }

    // A receipt that exists while its run still reads `running` is the state
    // the three-await mint left behind between its first and second write, and
    // the mirror state (finalized, no receipt) is the one `stored ?? record`
    // reported as minted.
    expect(committed.length).toBeGreaterThan(0);
    for (const state of committed) {
      if (state.receipts > 0) expect(state.status).toBe("finalized");
      if (state.status === "finalized") expect(state.receipts).toBe(1);
    }
    expect(committed.at(-1)).toEqual({ receipts: 1, status: "finalized" });
  });
});
