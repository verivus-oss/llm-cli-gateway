import { describe, it, expect } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";

/** Poll until predicate returns true, or reject after timeoutMs. */
function waitFor(fn: () => boolean, timeoutMs: number, intervalMs = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/** Helper: wait for a job to leave "running" status. */
function waitForJobDone(manager: AsyncJobManager, jobId: string, timeoutMs = 5000): Promise<void> {
  return waitFor(() => {
    const s = manager.getJobSnapshot(jobId);
    return s !== null && s.status !== "running";
  }, timeoutMs);
}

describe("AsyncJobManager", () => {
  describe("basic lifecycle", () => {
    it("should start and complete a job", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("echo" as LlmCli, ["hello"], "corr-1");
      expect(job.status).toBe("running");

      await waitForJobDone(manager, job.id);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("completed");
      expect(snapshot.exitCode).toBe(0);

      const result = manager.getJobResult(job.id)!;
      expect(result.stdout.trim()).toBe("hello");
    });

    it("should track a failed job", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("sh" as LlmCli, ["-c", "exit 42"], "corr-2");

      await waitForJobDone(manager, job.id);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("failed");
      expect(snapshot.exitCode).toBe(42);
    });

    it("should return null for unknown job ID", () => {
      const manager = new AsyncJobManager();
      expect(manager.getJobSnapshot("nonexistent")).toBeNull();
      expect(manager.getJobResult("nonexistent")).toBeNull();
    });
  });

  describe("idle timeout", () => {
    it("should kill job after idle timeout with no output", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("sleep" as LlmCli, ["30"], "corr-idle-1", undefined, 500);

      await waitForJobDone(manager, job.id, 10000);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("failed");
      expect(snapshot.exitCode).toBe(125);
      expect(snapshot.error).toContain("inactivity");
    }, 15000);

    it("should reset idle timer on output", async () => {
      const manager = new AsyncJobManager();
      // Process outputs every 200ms — idle timeout of 500ms should not fire
      const job = manager.startJob("sh" as LlmCli, [
        "-c", "for i in 1 2 3 4 5; do echo tick; sleep 0.2; done"
      ], "corr-idle-2", undefined, 500);

      await waitForJobDone(manager, job.id);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("completed");
      expect(snapshot.exitCode).toBe(0);
    }, 15000);

    it("should not idle-timeout when idleTimeoutMs is not set", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("sleep" as LlmCli, ["1"], "corr-idle-3");

      await waitForJobDone(manager, job.id, 5000);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("completed");
    }, 15000);

    it("should set exitCode 125 distinct from wall-clock timeout 124", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("sleep" as LlmCli, ["30"], "corr-idle-4", undefined, 300);

      await waitForJobDone(manager, job.id, 10000);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.exitCode).toBe(125);
      expect(snapshot.exitCode).not.toBe(124);
    }, 15000);
  });

  describe("cancel", () => {
    it("should cancel a running job", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("sleep" as LlmCli, ["30"], "corr-cancel-1");

      const result = manager.cancelJob(job.id);
      expect(result.canceled).toBe(true);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("canceled");
      expect(snapshot.finishedAt).toBeTruthy();
    });

    it("should return error for non-existent job", () => {
      const manager = new AsyncJobManager();
      const result = manager.cancelJob("nonexistent-id");
      expect(result.canceled).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("should return error for already completed job", async () => {
      const manager = new AsyncJobManager();
      const job = manager.startJob("true" as LlmCli, [], "corr-cancel-2");

      await waitForJobDone(manager, job.id);

      const result = manager.cancelJob(job.id);
      expect(result.canceled).toBe(false);
      expect(result.reason).toContain("already");
    });

    it("should SIGKILL a canceled job that ignores SIGTERM", async () => {
      // If the exited flag fix works, SIGKILL fires after 5s and the
      // process dies. If the old proc.killed bug was present, SIGKILL
      // would never fire and the process would hang for 30s (timeout).
      const manager = new AsyncJobManager();
      const job = manager.startJob("bash" as LlmCli, [
        "-c", "trap '' TERM; sleep 30"
      ], "corr-cancel-3");

      // Give process time to set up trap
      await new Promise(r => setTimeout(r, 200));
      manager.cancelJob(job.id);

      // Wait for the process to actually exit via SIGKILL escalation (~5s).
      // Signal-killed processes have code=null, so exitCode stays null for
      // canceled jobs. Use the exited flag instead.
      await waitFor(() => {
        const s = manager.getJobSnapshot(job.id);
        return s !== null && s.exited === true;
      }, 10000);

      const snapshot = manager.getJobSnapshot(job.id)!;
      expect(snapshot.status).toBe("canceled");
    }, 15000);
  });
});
