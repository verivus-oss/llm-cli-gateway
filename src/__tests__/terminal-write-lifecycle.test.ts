import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { SqliteJobStore } from "../job-store.js";
import type { JobCompletionInput } from "../job-store.js";
import { noopLogger } from "../logger.js";

// persistComplete became async, and two REAL terminal paths can enter it for
// the same job: the dead-process sweep terminalises a job whose pid has
// vanished, and the child's own close event terminalises it again when the
// process actually exits. While the body was synchronous the second call could
// not begin until the first had set `terminalPersisted`, so it always took the
// late-output rescue branch. Once it could yield, both calls passed that check
// before either set it:
//
//   call 1  recordComplete -> applied = true   -> terminalRowOwned = true
//   call 2  recordComplete -> applied = false  -> terminalRowOwned = FALSE
//
// The second write is guard-rejected because the row is already terminal, and
// `terminalRowOwned = applied` then reads that rejection as "another writer
// owns this row". The other writer is this same instance. mayWriteOutputFor()
// goes false, the late-output rescue is disabled, and every byte the child
// flushed between the sweep and its close is dropped.
//
// The interleaving is forced, not raced: both calls park on the same gate
// inside recordComplete, so they resume in the order they entered it.

function flushOnSigtermArgs(early: string, late: string): string[] {
  return [
    "-e",
    `process.on("SIGTERM", () => { process.stdout.write(${JSON.stringify(late)}, () => process.exit(0)); });` +
      `process.stdout.write(${JSON.stringify(early)});` +
      `setInterval(() => {}, 1000);`,
  ];
}

const FLUSH_ON_SIGTERM = flushOnSigtermArgs("EARLY_BYTES", "LATE_FLUSH_MARKER");

function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async (): Promise<void> => {
      if (await fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(() => void check(), 25);
    };
    void check();
  });
}

/** Holds every recordComplete at one barrier so the two callers interleave. */
class GatedCompletionStore extends SqliteJobStore {
  private gate: Promise<void> | null = null;
  private release: (() => void) | null = null;
  entered = 0;
  deregistered = false;

  override async deregisterInstance(instanceId: string): Promise<void> {
    this.deregistered = true;
    return await super.deregisterInstance(instanceId);
  }

  arm(): void {
    this.gate = new Promise<void>(resolve => {
      this.release = resolve;
    });
  }

  open(): void {
    this.release?.();
    this.gate = null;
    this.release = null;
  }

  override async recordComplete(input: JobCompletionInput): Promise<boolean> {
    this.entered += 1;
    if (this.gate) await this.gate;
    return await super.recordComplete(input);
  }
}

describe("terminal persistence is not re-entrant for the same job", () => {
  let tempDir: string;
  let store: GatedCompletionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "terminal-reentrancy-"));
    store = new GatedCompletionStore(join(tempDir, "jobs.db"), noopLogger);
  });

  afterEach(async () => {
    store.open();
    await store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps this instance's row ownership, and the late output, across two terminal writes", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    await manager.whenStartupSettled();
    const internals = manager as unknown as {
      jobs: Map<
        string,
        { process: { pid: number } | null; terminalRowOwned: boolean; closeObserved: boolean }
      >;
      evictCompletedJobs: () => Promise<void>;
    };
    try {
      const started = await manager.startJobWithDedup(
        "node" as LlmCli,
        FLUSH_ON_SIGTERM,
        "corr-reentrant",
        { forceRefresh: true }
      );
      const jobId = started.snapshot.id;
      await waitFor(
        async () => ((await manager.getJobSnapshot(jobId))?.stdoutBytes ?? 0) >= 11,
        25_000
      );

      const record = internals.jobs.get(jobId)!;
      const realPid = record.process!.pid;
      // Point the manager's handle at a pid that cannot exist so the sweep
      // takes the ESRCH branch, while the real child keeps running with its
      // close handler still wired up. This is the first terminal writer.
      record.process = { pid: 0x7ffffff0 };

      store.arm();
      const sweep = internals.evictCompletedJobs();
      await waitFor(() => store.entered >= 1, 5_000);

      // The real child now flushes LATE_FLUSH_MARKER and closes. Its close
      // handler is the SECOND terminal writer, and it enters while the first
      // is still parked at the gate.
      process.kill(realPid, "SIGTERM");
      // Synchronise on the close handler HAVING STARTED, which is true in both
      // states: `closeObserved` is its first statement, before any await.
      // Waiting on `entered >= 2` would only work in the broken state, where
      // the second writer reaches recordComplete; once the writes are chained
      // it never gets there, so that condition would hang the fixed build and
      // the control would be measuring its own synchronisation.
      await waitFor(() => internals.jobs.get(jobId)?.closeObserved === true, 25_000);

      store.open();
      await sweep;
      await waitFor(
        async () => (await manager.getJobSnapshot(jobId))?.status !== "running",
        10_000
      );

      // THE PROPERTY. A second write BY THIS INSTANCE must not be mistaken for
      // another writer: ownership survives, so the late-output rescue still
      // runs and the bytes the child flushed on its way out are durable.
      await waitFor(
        async () => ((await store.getById(jobId))?.stdout ?? "").includes("LATE_FLUSH_MARKER"),
        10_000
      );
      expect((await store.getById(jobId))?.stdout).toContain("EARLY_BYTES");
      expect(internals.jobs.get(jobId)?.terminalRowOwned).toBe(true);
    } finally {
      store.open();
      await manager.dispose();
    }
  }, 60_000);
});

// dispose() lost its bound on NON-Kit terminal persistence.
//
// The close listener is an async EventEmitter callback that marks a job
// terminal BEFORE awaiting persistence, and both limiter timeout callbacks are
// `void`-ed calls to failQueuedJob which does the same. dispose() treats a job
// as inactive as soon as it is not queued or running, and breaks out of its
// drain as soon as pendingWrites is empty. Terminal persistence was never
// registered through trackPendingWrite(), and hasPendingTerminalPersistence()
// covers ONLY Kit jobs. So shutdown could conclude finalisation was drained,
// deregister the instance, and move toward closing the store while a non-Kit
// terminal write was still in flight, leaving the durable row open for another
// instance to orphan later.
//
// Both tests below hold the terminal write at the gate and then dispose. The
// property is that dispose does NOT deregister: it would rather time out and
// let the lease expire, which is what #139 chose deliberately over a mid-write
// orphan.
describe("dispose() drains NON-Kit terminal persistence before deregistering", () => {
  let tempDir: string;
  let store: GatedCompletionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "terminal-drain-"));
    store = new GatedCompletionStore(join(tempDir, "jobs.db"), noopLogger);
  });

  afterEach(async () => {
    store.open();
    await store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("does not deregister while a closed child's terminal write is still in flight", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    await manager.whenStartupSettled();
    const internals = manager as unknown as {
      jobs: Map<string, { process: { pid: number } | null; closeObserved: boolean }>;
    };
    try {
      const started = await manager.startJobWithDedup(
        "node" as LlmCli,
        FLUSH_ON_SIGTERM,
        "corr-drain-close",
        { forceRefresh: true }
      );
      const jobId = started.snapshot.id;
      await waitFor(
        async () => ((await manager.getJobSnapshot(jobId))?.stdoutBytes ?? 0) >= 11,
        25_000
      );

      store.arm();
      process.kill(internals.jobs.get(jobId)!.process!.pid, "SIGTERM");
      await waitFor(() => internals.jobs.get(jobId)?.closeObserved === true, 25_000);
      await waitFor(() => store.entered >= 1, 25_000);

      // The job is now terminal in memory, so `stillActive` is false, and its
      // durable write is parked. A short timeout: the point is that dispose
      // refuses to deregister, not how long it is willing to wait.
      await manager.dispose({ timeoutMs: 300 });
      expect(store.deregistered).toBe(false);
    } finally {
      store.open();
    }
  }, 60_000);

  it("does not deregister while a queue-timeout terminal write is still in flight", async () => {
    // The sister site: both limiter timeout callbacks are `() => void
    // this.failQueuedJob(...)`, which marks the job failed and then awaits the
    // same persistence. Nothing joined that promise either.
    const manager = new AsyncJobManager(noopLogger, undefined, store, undefined, {
      maxRunningJobs: 1,
      maxRunningJobsPerProvider: 1,
      maxQueuedJobs: 5,
      queueTimeoutMs: 150,
      completedJobMemoryTtlMs: 60 * 60 * 1000,
      maxJobOutputBytes: 50 * 1024 * 1024,
    });
    await manager.whenStartupSettled();
    const slot = await manager.acquireProcessSlot("node");
    try {
      const queued = await manager.startJobWithDedup(
        "node" as LlmCli,
        ["-e", "setInterval(() => {}, 1000);"],
        "corr-drain-queue",
        { forceRefresh: true }
      );
      expect((await manager.getJobSnapshot(queued.snapshot.id))?.status).toBe("queued");

      store.arm();
      // The queue wait expires, failQueuedJob marks the job failed and parks in
      // recordComplete.
      await waitFor(() => store.entered >= 1, 25_000);

      await manager.dispose({ timeoutMs: 300 });
      expect(store.deregistered).toBe(false);
    } finally {
      store.open();
      slot.release();
    }
  }, 60_000);
});
