import { describe, it, expect } from "vitest";
import {
  AsyncJobManager,
  JobSaturationError,
  isAsyncJobInProgress,
  type LlmCli,
} from "../async-job-manager.js";
import type { JobLimitsConfig } from "../config.js";

// Issue #130: in-process job limiter/queue behaviour for process (CLI) jobs,
// plus the configurable completed-in-memory TTL and output cap. These exercise
// the AsyncJobManager directly with explicit small limits (no store, so dedup
// is off and identical argv never collide).

function limits(overrides: Partial<JobLimitsConfig> = {}): JobLimitsConfig {
  return {
    maxRunningJobs: 1,
    maxRunningJobsPerProvider: 1,
    maxQueuedJobs: 5,
    queueTimeoutMs: 10_000,
    completedJobMemoryTtlMs: 60 * 60 * 1000,
    maxJobOutputBytes: 50 * 1024 * 1024,
    ...overrides,
  };
}

function makeManager(overrides: Partial<JobLimitsConfig> = {}): AsyncJobManager {
  return new AsyncJobManager(undefined, undefined, null, undefined, limits(overrides));
}

function waitFor(fn: () => boolean, timeoutMs = 5000, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/** A job that stays "running" for `seconds` so we can observe queueing. */
function startSleeper(manager: AsyncJobManager, seconds: number, corr: string): string {
  return manager.startJob("sleep" as LlmCli, [String(seconds)], corr).id;
}

describe("AsyncJobManager limiter (issue #130)", () => {
  it("classifies queued and running jobs as in-progress", () => {
    expect(isAsyncJobInProgress("queued")).toBe(true);
    expect(isAsyncJobInProgress("running")).toBe(true);
    expect(isAsyncJobInProgress("completed")).toBe(false);
    expect(isAsyncJobInProgress("failed")).toBe(false);
    expect(isAsyncJobInProgress("canceled")).toBe(false);
    expect(isAsyncJobInProgress("orphaned")).toBe(false);
  });

  it("queues a process job when the global running limit is saturated", () => {
    const manager = makeManager({ maxRunningJobs: 1, maxRunningJobsPerProvider: 5 });
    const a = manager.startJob("sleep" as LlmCli, ["2"], "corr-a");
    const b = manager.startJob("sleep" as LlmCli, ["2"], "corr-b");

    expect(manager.getJobSnapshot(a.id)!.status).toBe("running");
    expect(manager.getJobSnapshot(b.id)!.status).toBe("queued");

    const snap = manager.getLimiterSnapshot();
    expect(snap.running).toBe(1);
    expect(snap.queued).toBe(1);
    expect(snap.saturated).toBe(true);

    manager.cancelJob(a.id);
    manager.cancelJob(b.id);
  });

  it("bounds a burst of async process jobs to configured running and queue caps", () => {
    const manager = makeManager({
      maxRunningJobs: 2,
      maxRunningJobsPerProvider: 2,
      maxQueuedJobs: 20,
    });
    const jobs: string[] = [];

    for (let i = 0; i < 12; i++) {
      jobs.push(manager.startJob("sleep" as LlmCli, ["2"], `corr-burst-${i}`).id);
      const snap = manager.getLimiterSnapshot();
      expect(snap.running).toBeLessThanOrEqual(2);
      expect(snap.runningByProvider.sleep ?? 0).toBeLessThanOrEqual(2);
      expect(snap.queued).toBeLessThanOrEqual(20);
    }

    const snap = manager.getLimiterSnapshot();
    expect(snap.running).toBe(2);
    expect(snap.queued).toBe(10);
    expect(snap.rejected).toBe(0);

    for (const job of jobs) manager.cancelJob(job);
  });

  it("starts queued process jobs in FIFO order as capacity frees", async () => {
    const manager = makeManager({ maxRunningJobs: 1, maxRunningJobsPerProvider: 5 });
    const a = startSleeper(manager, 0.4, "corr-a");
    const b = startSleeper(manager, 0.3, "corr-b");
    const c = startSleeper(manager, 0.3, "corr-c");

    expect(manager.getJobSnapshot(a)!.status).toBe("running");
    // both b and c queued behind a
    expect(manager.getJobSnapshot(b)!.status).toBe("queued");
    expect(manager.getJobSnapshot(c)!.status).toBe("queued");

    // b (enqueued first) must run before c.
    await waitFor(() => manager.getJobSnapshot(b)!.status === "running");
    expect(manager.getJobSnapshot(c)!.status).toBe("queued");

    await waitFor(() => manager.getJobSnapshot(c)!.status !== "queued", 8000);
    await waitFor(
      () =>
        manager.getJobSnapshot(b)!.status === "completed" &&
        manager.getJobSnapshot(c)!.status === "completed",
      8000
    );
  });

  it("per-provider limit blocks a saturated provider while another provider runs", () => {
    const manager = makeManager({ maxRunningJobs: 10, maxRunningJobsPerProvider: 1 });
    const sleep1 = manager.startJob("sleep" as LlmCli, ["2"], "corr-s1");
    const sleep2 = manager.startJob("sleep" as LlmCli, ["2"], "corr-s2");
    // Different provider (sh) still has capacity globally and per-provider.
    const sh1 = manager.startJob("sh" as LlmCli, ["-c", "sleep 2"], "corr-sh1");

    expect(manager.getJobSnapshot(sleep1.id)!.status).toBe("running");
    expect(manager.getJobSnapshot(sleep2.id)!.status).toBe("queued");
    expect(manager.getJobSnapshot(sh1.id)!.status).toBe("running");
    expect(manager.getLimiterSnapshot().saturated).toBe(true);

    manager.cancelJob(sleep1.id);
    manager.cancelJob(sleep2.id);
    manager.cancelJob(sh1.id);
  });

  it("does not report saturated when capacity is available and no provider is queued", () => {
    const manager = makeManager({ maxRunningJobs: 3, maxRunningJobsPerProvider: 2 });
    const job = manager.startJob("sleep" as LlmCli, ["2"], "corr-a");

    const snap = manager.getLimiterSnapshot();
    expect(snap.running).toBe(1);
    expect(snap.queued).toBe(0);
    expect(snap.saturated).toBe(false);

    manager.cancelJob(job.id);
  });

  it("rejects new work with a JobSaturationError when the queue is full", () => {
    const manager = makeManager({
      maxRunningJobs: 1,
      maxRunningJobsPerProvider: 5,
      maxQueuedJobs: 1,
    });
    const a = manager.startJob("sleep" as LlmCli, ["2"], "corr-a"); // running
    manager.startJob("sleep" as LlmCli, ["2"], "corr-b"); // queued (fills queue)

    let thrown: unknown;
    try {
      manager.startJob("sleep" as LlmCli, ["2"], "corr-c");
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JobSaturationError);
    expect((thrown as JobSaturationError).retryable).toBe(true);
    expect((thrown as Error).message).toMatch(/at capacity/i);

    const snap = manager.getLimiterSnapshot();
    expect(snap.rejected).toBe(1);

    manager.cancelJob(a.id);
  });

  it("marks a queued job failed with a deterministic saturation error on queue timeout", async () => {
    const manager = makeManager({
      maxRunningJobs: 1,
      maxRunningJobsPerProvider: 5,
      queueTimeoutMs: 120,
    });
    const a = manager.startJob("sleep" as LlmCli, ["3"], "corr-a"); // long-running
    const b = manager.startJob("sleep" as LlmCli, ["3"], "corr-b"); // queued

    await waitFor(() => manager.getJobSnapshot(b.id)!.status === "failed", 4000);
    const snap = manager.getJobSnapshot(b.id)!;
    expect(snap.exitCode).toBe(75);
    expect(snap.error).toMatch(/at capacity/i);
    expect(manager.getLimiterSnapshot().timedOut).toBe(1);

    manager.cancelJob(a.id);
  });

  it("cancels a queued job without ever spawning a process", () => {
    const manager = makeManager({ maxRunningJobs: 1, maxRunningJobsPerProvider: 5 });
    const a = manager.startJob("sleep" as LlmCli, ["2"], "corr-a"); // running
    const b = manager.startJob("sleep" as LlmCli, ["2"], "corr-b"); // queued

    expect(manager.getJobSnapshot(b.id)!.status).toBe("queued");
    const res = manager.cancelJob(b.id);
    expect(res.canceled).toBe(true);
    expect(manager.getJobSnapshot(b.id)!.status).toBe("canceled");
    // Queue slot freed, and the canceled job holds no run slot.
    const snap = manager.getLimiterSnapshot();
    expect(snap.queued).toBe(0);
    expect(snap.running).toBe(1); // only a

    manager.cancelJob(a.id);
  });

  it("releases the run slot when a running job completes so a queued one starts", async () => {
    const manager = makeManager({ maxRunningJobs: 1, maxRunningJobsPerProvider: 5 });
    const a = manager.startJob("echo" as LlmCli, ["a"], "corr-a"); // completes fast
    const b = manager.startJob("echo" as LlmCli, ["b"], "corr-b"); // queued briefly

    await waitFor(
      () =>
        manager.getJobSnapshot(a.id)!.status === "completed" &&
        manager.getJobSnapshot(b.id)!.status === "completed",
      6000
    );
    // Both slots released.
    expect(manager.getLimiterSnapshot().running).toBe(0);
    expect(manager.getLimiterSnapshot().queued).toBe(0);
  });

  it("acquireProcessSlot gates the direct-sync path under the same limiter", async () => {
    const manager = makeManager({
      maxRunningJobs: 1,
      maxRunningJobsPerProvider: 5,
      maxQueuedJobs: 0,
    });
    const a = manager.startJob("sleep" as LlmCli, ["2"], "corr-a"); // holds the only slot
    // Queue is size 0, so a direct-sync acquire must be rejected (saturation).
    await expect(manager.acquireProcessSlot("claude")).rejects.toBeInstanceOf(JobSaturationError);
    manager.cancelJob(a.id);
    // A signal is not proof that the process has stopped. The slot becomes
    // available only after the close path finalizes the cancellation.
    await waitFor(() => manager.getJobSnapshot(a.id)!.status === "canceled", 5000);
    // Slot now free: acquire resolves with a releasable permit.
    const slot = await manager.acquireProcessSlot("claude");
    expect(typeof slot.release).toBe("function");
    slot.release();
    expect(manager.getLimiterSnapshot().running).toBe(0);
  });
});

describe("AsyncJobManager configurable output cap + retention (issue #130)", () => {
  it("fails a running job when output exceeds the configured max_job_output_bytes", async () => {
    const manager = makeManager({
      maxRunningJobs: 5,
      maxRunningJobsPerProvider: 5,
      maxJobOutputBytes: 1024,
    });
    // Emit well over 1KB of stdout.
    const job = manager.startJob(
      "sh" as LlmCli,
      ["-c", "for i in $(seq 1 200); do echo 0123456789012345678901234567890123456789; done"],
      "corr-overflow"
    );
    await waitFor(() => manager.getJobSnapshot(job.id)!.status === "failed", 6000);
    const snap = manager.getJobSnapshot(job.id)!;
    expect(snap.exitCode).toBe(126);
    expect(snap.error).toContain("Output exceeded maximum size");
    expect(snap.error).toContain("1KB");
    expect(snap.outputTruncated).toBe(true);
    // Overflow released the run slot exactly once.
    expect(manager.getLimiterSnapshot().running).toBe(0);
  });

  it("reports the effective configured limits without exposing secrets", () => {
    const manager = makeManager({ maxJobOutputBytes: 50 * 1024 * 1024 });
    const eff = manager.getConfiguredLimits();
    expect(eff.maxJobOutputBytes).toBe(50 * 1024 * 1024);
    expect(eff.maxRunningJobs).toBe(1);
  });
});
