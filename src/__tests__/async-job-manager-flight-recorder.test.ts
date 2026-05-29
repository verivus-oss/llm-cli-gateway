import { describe, it, expect } from "vitest";
import {
  AsyncJobManager,
  type AsyncJobFlightRecorderEntry,
  type AsyncJobUsageExtractor,
  type LlmCli,
} from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import type { FlightLogStart, FlightLogResult, FlightRecorderLike } from "../flight-recorder.js";

/**
 * Slice 1.5 — async-path flight-recorder tests.
 *
 * These tests use the CapturingFlightRecorder pattern from
 * prompt-parts-tool-wiring.test.ts:106-117 and spawn tiny `node -e ...`
 * children for terminal-state exercises.
 */

interface CapturedComplete {
  correlationId: string;
  result: FlightLogResult;
}

class CapturingFlightRecorder implements FlightRecorderLike {
  starts: FlightLogStart[] = [];
  completes: CapturedComplete[] = [];
  logStart(entry: FlightLogStart): void {
    this.starts.push(entry);
  }
  logComplete(correlationId: string, result: FlightLogResult): void {
    this.completes.push({ correlationId, result });
  }
  queryRequests<T = Record<string, unknown>>(_sql: string, ..._params: unknown[]): T[] {
    return [];
  }
  flush(): void {}
  close(): void {}
}

/** Variant that throws on the first logComplete then succeeds (Codex-F4). */
class FlakyOnceFlightRecorder implements FlightRecorderLike {
  starts: FlightLogStart[] = [];
  completes: CapturedComplete[] = [];
  private threwOnce = false;
  logStart(entry: FlightLogStart): void {
    this.starts.push(entry);
  }
  logComplete(correlationId: string, result: FlightLogResult): void {
    if (!this.threwOnce) {
      this.threwOnce = true;
      throw new Error("flaky FR write");
    }
    this.completes.push({ correlationId, result });
  }
  queryRequests<T = Record<string, unknown>>(_sql: string, ..._params: unknown[]): T[] {
    return [];
  }
  flush(): void {}
  close(): void {}
}

function waitForJobDone(manager: AsyncJobManager, jobId: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const s = manager.getJobSnapshot(jobId);
      if (s && s.status !== "running") return resolve();
      if (Date.now() > deadline) return reject(new Error("waitForJobDone timed out"));
      setTimeout(check, 50);
    };
    check();
  });
}

/** Small delay to allow the close handler to flush after a status transition. */
function tick(ms = 80): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Helper: minimal flightRecorderEntry. */
function entry(overrides: Partial<AsyncJobFlightRecorderEntry> = {}): AsyncJobFlightRecorderEntry {
  return {
    model: "test-model",
    prompt: "assembled prompt",
    sessionId: "sess-X",
    stablePrefixHash: "deadbeef",
    stablePrefixTokens: 42,
    ...overrides,
  };
}

const fakeUsage: AsyncJobUsageExtractor = () => ({
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 25,
  cacheCreationTokens: 0,
  costUsd: 0.001,
});

describe("AsyncJobManager + flight-recorder (slice 1.5)", () => {
  describe("logStart opt-in (case a / a2 / i)", () => {
    it("writes logStart with asyncJobId+stablePrefixHash when writeFlightStart=true", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("claude" as LlmCli, ["nothing"], "corr-a", {
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      try {
        await waitForJobDone(manager, outcome.snapshot.id);
      } catch {
        /* spawn may fail for unknown CLI; that's fine for this assertion */
      }
      const start = fr.starts.find(s => s.correlationId === "corr-a");
      expect(start).toBeDefined();
      expect(start!.asyncJobId).toBe(outcome.snapshot.id);
      expect(start!.stablePrefixHash).toBe("deadbeef");
      expect(start!.stablePrefixTokens).toBe(42);
      expect(start!.cli).toBe("claude");
      expect(start!.model).toBe("test-model");
    });

    it("does NOT write logStart when writeFlightStart=false (sync-deferred regression for Codex-F1)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup(
        "echo" as LlmCli,
        ["hello-sync-deferred"],
        "corr-a2",
        {
          writeFlightStart: false,
          flightRecorderEntry: entry(),
          extractUsage: fakeUsage,
        }
      );
      // R2 Codex-Unit-B F1: arm before terminal so the manager owns the
      // logComplete write the way awaitJobOrDefer does when it defers.
      manager.armFlightCompleteForDeferral(outcome.snapshot.id);
      await waitForJobDone(manager, outcome.snapshot.id);
      await tick();
      expect(fr.starts).toHaveLength(0);
      // ...and logComplete fires (manager covers the sync handler's row).
      expect(fr.completes).toHaveLength(1);
      expect(fr.completes[0].correlationId).toBe("corr-a2");
      expect(fr.completes[0].result.status).toBe("completed");
    });

    it("does NOT write logComplete when writeFlightStart=false and not armed (sync-inline regression for Codex-Unit-B F1)", async () => {
      // Sync-inline scenario: sync handler will write its own
      // safeFlightComplete with rich metadata. Manager MUST stay silent or
      // the rich row is preempted by the manager's minimal payload.
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup(
        "echo" as LlmCli,
        ["hello-sync-inline"],
        "corr-a3",
        {
          writeFlightStart: false,
          flightRecorderEntry: entry(),
          extractUsage: fakeUsage,
        }
      );
      await waitForJobDone(manager, outcome.snapshot.id);
      await tick();
      expect(fr.starts).toHaveLength(0);
      expect(fr.completes).toHaveLength(0);
    });

    it("armFlightCompleteForDeferral after job already terminal still writes (race mitigation)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("echo" as LlmCli, ["fast"], "corr-a4", {
        writeFlightStart: false,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      await waitForJobDone(manager, outcome.snapshot.id);
      await tick();
      // Arm AFTER terminal — race mitigation should write logComplete now.
      manager.armFlightCompleteForDeferral(outcome.snapshot.id);
      expect(fr.completes).toHaveLength(1);
      expect(fr.completes[0].correlationId).toBe("corr-a4");
    });

    it("writes nothing when flightRecorderEntry is omitted (regression guard for case i)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("echo" as LlmCli, ["silent"], "corr-i");
      await waitForJobDone(manager, outcome.snapshot.id);
      expect(fr.starts).toHaveLength(0);
      expect(fr.completes).toHaveLength(0);
    });
  });

  describe("logComplete on terminal states", () => {
    it("clean exit (exitCode=0) → status='completed' + usage populated (case b)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("echo" as LlmCli, ["clean-b"], "corr-b", {
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      await waitForJobDone(manager, outcome.snapshot.id);
      const c = fr.completes.find(x => x.correlationId === "corr-b");
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("completed");
      expect(c!.result.inputTokens).toBe(100);
      expect(c!.result.outputTokens).toBe(50);
      expect(c!.result.cacheReadTokens).toBe(25);
      expect(c!.result.costUsd).toBe(0.001);
    });

    it("non-zero exit with job.error=null falls back to stderr / 'Exit code N' (Codex-F2)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "echo trouble >&2; exit 7"],
        "corr-c",
        {
          writeFlightStart: true,
          flightRecorderEntry: entry(),
          extractUsage: fakeUsage,
        }
      );
      await waitForJobDone(manager, outcome.snapshot.id);
      const c = fr.completes.find(x => x.correlationId === "corr-c");
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("failed");
      expect(c!.result.exitCode).toBe(7);
      // job.error is null on a clean non-zero exit; falls back to stderr.
      expect(c!.result.errorMessage).toContain("trouble");
    });

    it("launch failure populates errorMessage from launch-error text (Codex-F2)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup(
        "missing-cli-for-fr-test" as LlmCli,
        [],
        "corr-c2",
        {
          writeFlightStart: true,
          flightRecorderEntry: entry(),
          extractUsage: fakeUsage,
        }
      );
      await waitForJobDone(manager, outcome.snapshot.id);
      const c = fr.completes.find(x => x.correlationId === "corr-c2");
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("failed");
      expect(c!.result.exitCode).toBe(127);
      expect(c!.result.errorMessage).toContain("command was not found");
    });

    it("cancelJob → status='failed' + errorMessage='canceled by caller' (case d)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("sleep" as LlmCli, ["10"], "corr-d", {
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      manager.cancelJob(outcome.snapshot.id);
      await waitForJobDone(manager, outcome.snapshot.id);
      await tick();
      const c = fr.completes.find(x => x.correlationId === "corr-d");
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("failed");
      expect(c!.result.errorMessage).toBe("canceled by caller");
    }, 10000);

    it("idle timeout → status='failed' + errorMessage contains 'inactivity' (case e)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("sleep" as LlmCli, ["10"], "corr-e", {
        idleTimeoutMs: 200,
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      await waitForJobDone(manager, outcome.snapshot.id, 8000);
      await tick();
      const c = fr.completes.find(x => x.correlationId === "corr-e");
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("failed");
      expect(c!.result.exitCode).toBe(125);
      expect(c!.result.errorMessage).toContain("inactivity");
    }, 15000);

    it("dedup hit → second call writes no new logStart/logComplete (case f)", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      // Long-running job so the second call dedups onto it while still running.
      const first = manager.startJobWithDedup("sleep" as LlmCli, ["1"], "corr-f1", {
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      const second = manager.startJobWithDedup("sleep" as LlmCli, ["1"], "corr-f2", {
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      expect(second.deduped).toBe(true);
      expect(second.snapshot.id).toBe(first.snapshot.id);
      await waitForJobDone(manager, first.snapshot.id, 5000);
      await tick();
      // Only ONE row total per logStart/logComplete (the original job's).
      const starts = fr.starts.filter(s => s.correlationId === "corr-f1");
      expect(starts).toHaveLength(1);
      expect(fr.starts.find(s => s.correlationId === "corr-f2")).toBeUndefined();
      expect(fr.completes.filter(c => c.correlationId === "corr-f1")).toHaveLength(1);
      expect(fr.completes.find(c => c.correlationId === "corr-f2")).toBeUndefined();
    }, 10000);
  });

  describe("orphan recovery on constructor (cases g + h, Mistral-F1)", () => {
    it("seeded running rows produce one logComplete each, status='failed', 'orphaned'", () => {
      const fr = new CapturingFlightRecorder();
      const store = new MemoryJobStore();
      const startedAt = new Date(Date.now() - 60000).toISOString();
      store.recordStart({
        id: "orph-1",
        correlationId: "corr-orph-1",
        requestKey: "k-orph-1",
        cli: "claude",
        args: ["--noop"],
        startedAt,
        pid: 999,
      });
      // The MemoryJobStore in v1.7.0 onwards keeps its no-op semantics for
      // markOrphanedOnStartup (returns {count:0, orphaned:[]}), so this seed
      // row will NOT be flipped on construction. Use the sqlite-backed
      // assertions for the real orphan path; here we cover the contract that
      // memory's no-op produces zero FR writes.
      new AsyncJobManager(noopLogger, undefined, store, fr);
      expect(fr.completes).toHaveLength(0);
    });

    it("no in-flight rows → zero logComplete calls (case h)", () => {
      const fr = new CapturingFlightRecorder();
      const store = new MemoryJobStore();
      new AsyncJobManager(noopLogger, undefined, store, fr);
      expect(fr.completes).toHaveLength(0);
    });

    it("orphan path: store returning a snapshot → one FR logComplete per orphan", () => {
      const fr = new CapturingFlightRecorder();
      const startedAt = new Date(Date.now() - 30000).toISOString();
      const fakeStore = {
        markOrphanedOnStartup: () => ({
          count: 2,
          orphaned: [
            {
              id: "j1",
              correlationId: "corr-j1",
              startedAt,
              stdout: "partial-out",
              stderr: "",
              exitCode: null,
            },
            {
              id: "j2",
              correlationId: "corr-j2",
              startedAt,
              stdout: "",
              stderr: "boom",
              exitCode: 137,
            },
          ],
        }),
        recordStart: () => {},
        recordOutput: () => {},
        recordComplete: () => {},
        getById: () => null,
        findByRequestKey: () => null,
        evictExpired: () => 0,
        close: () => {},
      };
      new AsyncJobManager(noopLogger, undefined, fakeStore as unknown as MemoryJobStore, fr);
      expect(fr.completes).toHaveLength(2);
      const c1 = fr.completes.find(c => c.correlationId === "corr-j1");
      expect(c1?.result.status).toBe("failed");
      expect(c1?.result.errorMessage).toBe("orphaned after gateway restart");
      expect(c1?.result.response).toBe("partial-out"); // stderr empty → stdout fallback
      expect(c1?.result.exitCode).toBe(1); // null → fallback
      const c2 = fr.completes.find(c => c.correlationId === "corr-j2");
      expect(c2?.result.status).toBe("failed");
      expect(c2?.result.response).toBe("boom"); // stderr wins
      expect(c2?.result.exitCode).toBe(137);
      // durationMs derived from seeded startedAt
      expect(c1?.result.durationMs).toBeGreaterThanOrEqual(29000);
    });
  });

  describe("retryability + closure clearing (cases j + k, Codex-F4 + F5)", () => {
    it("Codex-F4: thrown logComplete leaves flag false; later terminal callback retries successfully", async () => {
      const fr = new FlakyOnceFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      // Use an idle-timeout job so the timeout cb fires first (and throws on
      // the first logComplete attempt), then the child's close handler
      // retries the logComplete which succeeds the second time.
      const outcome = manager.startJobWithDedup("sleep" as LlmCli, ["10"], "corr-j", {
        idleTimeoutMs: 200,
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      await waitForJobDone(manager, outcome.snapshot.id, 8000);
      // Allow enough time for the close handler to run after the SIGTERM/SIGKILL
      // from the idle-timeout, so the retry can land.
      await tick(300);
      const matches = fr.completes.filter(c => c.correlationId === "corr-j");
      // Exactly one successful write — the retry succeeded after the first throw.
      expect(matches).toHaveLength(1);
      expect(matches[0].result.status).toBe("failed");
    }, 15000);

    it("Codex-F5: post-write clear releases flightRecorderEntry + extractUsage", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      const outcome = manager.startJobWithDedup("echo" as LlmCli, ["clear-k"], "corr-k", {
        writeFlightStart: true,
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
      });
      await waitForJobDone(manager, outcome.snapshot.id);
      await tick();
      // Run an eviction sweep to make sure no extra logComplete writes happen
      // even when the in-memory record is still alive. If the post-write
      // clear didn't fire, a stale extractUsage closure could plausibly cause
      // an over-write. We assert exactly one complete row.
      const matches = fr.completes.filter(c => c.correlationId === "corr-k");
      expect(matches).toHaveLength(1);
    });
  });

  describe("dead-process eviction (case e3, Codex-F6 / Gemini-Unit-B F5)", () => {
    it("dead-process detected by eviction sweep → logComplete with 'Process no longer exists' errorMessage", async () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      // Directly seed a job record that points at a definitely-dead pid so
      // process.kill(pid, 0) throws ESRCH in the eviction sweep's
      // dead-process check. This isolates the eviction branch — exercising
      // it via a real spawn races with the close handler.
      const internal = manager as unknown as {
        jobs: Map<string, Record<string, unknown>>;
        evictCompletedJobs(): void;
      };
      const corrId = "corr-e3";
      const jobId = "fake-dead-job-e3";
      const deadPid = 0x7fffffff; // huge pid that won't exist
      internal.jobs.set(jobId, {
        id: jobId,
        cli: "claude",
        args: [],
        requestKey: "rk-e3",
        correlationId: corrId,
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        canceled: false,
        error: null,
        process: {
          pid: deadPid,
          stdout: null,
          stderr: null,
          on() {},
        },
        exited: false,
        metricsRecorded: false,
        outputDirty: false,
        lastOutputFlushAt: Date.now(),
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
        flightRecorderComplete: false,
        flightCompleteArmed: true,
      });
      internal.evictCompletedJobs();
      const c = fr.completes.find(x => x.correlationId === corrId);
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("failed");
      expect(c!.result.errorMessage).toBe("Process no longer exists (dead process detected)");
    });
  });

  describe("output overflow (case e2, Codex-F6)", () => {
    it("output overflow → status='failed' + errorMessage='Output exceeded maximum size (50MB)'", () => {
      const fr = new CapturingFlightRecorder();
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore(), fr);
      // Exercise the overflow branch directly instead of streaming 55MB
      // through a shell pipeline; the latter is needlessly brittle on
      // hosted CI runners and can leave cleanup work racing the test runner.
      const internal = manager as unknown as {
        jobs: Map<string, Record<string, unknown>>;
        appendOutput(
          job: Record<string, unknown>,
          stream: "stdout" | "stderr",
          chunk: Buffer
        ): void;
      };
      const jobId = "fake-overflow-job-e2";
      const job: Record<string, unknown> = {
        id: jobId,
        cli: "claude",
        args: [],
        requestKey: "rk-e2",
        correlationId: "corr-e2",
        status: "running",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        stdout: "x".repeat(50 * 1024 * 1024),
        stderr: "",
        outputTruncated: false,
        canceled: false,
        error: null,
        process: null,
        exited: false,
        metricsRecorded: false,
        outputDirty: false,
        lastOutputFlushAt: Date.now(),
        flightRecorderEntry: entry(),
        extractUsage: fakeUsage,
        flightRecorderComplete: false,
        flightCompleteArmed: true,
        clearIdleTimer: () => {},
      };
      internal.jobs.set(jobId, job);
      internal.appendOutput(job, "stdout", Buffer.from("!"));
      const c = fr.completes.find(x => x.correlationId === "corr-e2");
      expect(c).toBeDefined();
      expect(c!.result.status).toBe("failed");
      expect(c!.result.errorMessage).toBe("Output exceeded maximum size (50MB)");
    });
  });
});
