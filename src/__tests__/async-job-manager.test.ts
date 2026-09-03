import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { ensureDevinTranscriptPath } from "../devin-transcript.js";
import { DEFAULT_JOB_LIMITS } from "../config.js";

class LostTerminalAcknowledgementStore extends MemoryJobStore {
  private loseFirstAcknowledgement = true;

  override async recordComplete(
    input: Parameters<MemoryJobStore["recordComplete"]>[0]
  ): Promise<boolean> {
    const applied = await super.recordComplete(input);
    if (applied && this.loseFirstAcknowledgement) {
      this.loseFirstAcknowledgement = false;
      throw new Error("terminal acknowledgement lost after commit");
    }
    return applied;
  }
}

/** Poll until predicate returns true, or reject after timeoutMs. */
function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = async () => {
      if (await fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(() => void check(), intervalMs);
    };
    void check();
  });
}

/** Helper: wait for a job to leave "running" status. */
function waitForJobDone(manager: AsyncJobManager, jobId: string, timeoutMs = 5000): Promise<void> {
  return waitFor(async () => {
    const s = await manager.getJobSnapshot(jobId);
    return s !== null && s.status !== "running";
  }, timeoutMs);
}

describe("AsyncJobManager", () => {
  describe("basic lifecycle", () => {
    it("should start and complete a job", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("echo" as LlmCli, ["hello"], "corr-1");
      expect(job.status).toBe("running");

      await waitForJobDone(manager, job.id);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("completed");
      expect(snapshot.exitCode).toBe(0);

      const result = (await manager.getJobResult(job.id))!;
      expect(result.stdout.trim()).toBe("hello");
    });

    it("forwards a resolved cwd scope through the backwards-compatible startJob wrapper", async () => {
      const cwd = mkdtempSync(join(tmpdir(), "async-cwd-scope-"));
      const store = new MemoryJobStore();
      const manager = new AsyncJobManager(undefined, undefined, store);
      const parameters: Parameters<AsyncJobManager["startJob"]> = [
        "pwd" as LlmCli,
        [],
        "corr-cwd-scope",
        cwd,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { effectiveWorkingDir: cwd },
      ];

      try {
        const job = await manager.startJob(...parameters);
        await waitForJobDone(manager, job.id);
        expect((await manager.getJobResult(job.id))?.executionContext?.cwd).toEqual({
          scope: "caller",
          path: cwd,
          workspaceAlias: null,
        });
      } finally {
        await manager.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    });

    it("should track a failed job", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("sh" as LlmCli, ["-c", "exit 42"], "corr-2");

      await waitForJobDone(manager, job.id);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("failed");
      expect(snapshot.exitCode).toBe(42);
    });

    it("should normalize missing CLI launch failures", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("missing-cli-for-test" as LlmCli, [], "corr-missing");

      await waitForJobDone(manager, job.id);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("failed");
      expect(snapshot.exitCode).toBe(127);
      expect(snapshot.error).toContain("command was not found");

      const result = (await manager.getJobResult(job.id))!;
      expect(result.stderr).toContain("command was not found");
    });

    it("reconciles an atomic terminal capture whose acknowledgement is lost", async () => {
      const store = new LostTerminalAcknowledgementStore();
      const manager = new AsyncJobManager(undefined, undefined, store);
      try {
        const job = await manager.startJob("echo" as LlmCli, ["whole"], "capture-ack-lost");
        await waitFor(async () => (await store.getById(job.id))?.status === "completed", 5000, 10);
        expect(await store.getById(job.id)).toMatchObject({
          status: "completed",
          captureStatus: "not_captured",
        });
      } finally {
        await manager.dispose();
      }
    });

    it("should return null for unknown job ID", async () => {
      const manager = new AsyncJobManager();
      expect(await manager.getJobSnapshot("nonexistent")).toBeNull();
      expect(await manager.getJobResult("nonexistent")).toBeNull();
    });

    it("harvests, persists, and removes the exact gateway-owned Devin transcript", async () => {
      const temp = mkdtempSync(join(tmpdir(), "devin-capture-"));
      const fakeDevin = join(temp, "devin");
      const correlationId = `capture-${process.pid}-${Date.now()}`;
      const originalHome = process.env.HOME;
      process.env.HOME = temp;
      const transcriptPath = ensureDevinTranscriptPath(correlationId, temp);
      if (!transcriptPath) throw new Error("failed to mint Devin transcript path");
      const store = new MemoryJobStore();
      const manager = new AsyncJobManager(undefined, undefined, store);
      writeFileSync(
        fakeDevin,
        `#!/bin/sh
out=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--export" ]; then
    out="$2"
    shift 2
  else
    shift
  fi
done
printf '%s' '{"version":"ATIF-v1.7","messages":[{"role":"assistant","content":"whole"}]}' > "$out"
printf '%s\n' 'done'
`
      );
      chmodSync(fakeDevin, 0o755);

      try {
        const job = await manager.startJob(
          "devin",
          ["--export", transcriptPath, "-p", "capture"],
          correlationId,
          undefined,
          undefined,
          "text",
          true,
          { PATH: `${temp}:${process.env.PATH ?? ""}` }
        );
        await waitFor(async () => {
          const current = await manager.getJobSnapshot(job.id);
          return Boolean(current && !["queued", "running"].includes(current.status));
        }, 5000);

        const result = await manager.getJobResult(job.id);
        const durable = await store.getById(job.id);
        expect(result?.nativeTranscript).toContain('"version":"ATIF-v1.7"');
        expect(result?.executionContext?.capture.status).toBe("captured_whole");
        expect(durable?.nativeTranscript).toContain('"content":"whole"');
        expect(durable?.captureStatus).toBe("captured_whole");
        expect(durable?.captureError).toBeNull();
        expect(existsSync(transcriptPath)).toBe(false);
      } finally {
        await manager.dispose();
        rmSync(transcriptPath, { force: true });
        rmSync(temp, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it("removes an oversized Devin export after bounded capture is durable", async () => {
      const temp = mkdtempSync(join(tmpdir(), "devin-capture-limit-"));
      const fakeDevin = join(temp, "devin");
      const correlationId = `capture-limit-${process.pid}-${Date.now()}`;
      const originalHome = process.env.HOME;
      process.env.HOME = temp;
      const transcriptPath = ensureDevinTranscriptPath(correlationId, temp);
      if (!transcriptPath) throw new Error("failed to mint Devin transcript path");
      const store = new MemoryJobStore();
      const manager = new AsyncJobManager(undefined, undefined, store, undefined, {
        ...DEFAULT_JOB_LIMITS,
        maxJobOutputBytes: 128,
      });
      writeFileSync(
        fakeDevin,
        `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--export");
fs.writeFileSync(args[at + 1], JSON.stringify({ version: "ATIF-v1.7", messages: [{ role: "assistant", content: "x".repeat(4096) }] }));
process.stdout.write("done\\n");
`
      );
      chmodSync(fakeDevin, 0o755);

      try {
        const job = await manager.startJob(
          "devin",
          ["--export", transcriptPath, "-p", "capture"],
          correlationId,
          undefined,
          undefined,
          "text",
          true,
          { PATH: `${temp}:${process.env.PATH ?? ""}` }
        );
        await waitFor(async () => (await store.getById(job.id))?.captureStatus !== null, 5000, 10);
        expect(await store.getById(job.id)).toMatchObject({
          captureStatus: "captured_to_limit",
          nativeTranscriptTruncated: true,
        });
        expect(existsSync(transcriptPath)).toBe(false);
      } finally {
        await manager.dispose();
        rmSync(transcriptPath, { force: true });
        rmSync(temp, { recursive: true, force: true });
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
      }
    });

    it("should truncate job results from the beginning of each stream", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob(
        "sh" as LlmCli,
        ["-c", "printf abcdefghij; printf klmnopqrst >&2"],
        "corr-truncate"
      );

      await waitForJobDone(manager, job.id);

      const result = (await manager.getJobResult(job.id, 4))!;
      expect(result.stdout).toBe("abcd");
      expect(result.stderr).toBe("klmn");
      expect(result.stdoutTruncated).toBe(true);
      expect(result.stderrTruncated).toBe(true);
    });

    it("should expose resumable stdout and stderr pages without losing captured bytes", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob(
        "sh" as LlmCli,
        ["-c", "printf abcdefghij; printf klmnopqrst >&2"],
        "corr-paginated-result"
      );

      await waitForJobDone(manager, job.id);

      const first = (await manager.getJobResult(job.id, 4))!;
      expect(first.stdout).toBe("abcd");
      expect(first.stderr).toBe("klmn");
      expect(first.stdoutOffsetChars).toBe(0);
      expect(first.stdoutTotalChars).toBe(10);
      expect(first.stdoutNextOffsetChars).toBe(4);
      expect(first.stderrOffsetChars).toBe(0);
      expect(first.stderrTotalChars).toBe(10);
      expect(first.stderrNextOffsetChars).toBe(4);

      const second = (await manager.getJobResult(job.id, 4, {
        stdoutOffsetChars: first.stdoutNextOffsetChars!,
        stderrOffsetChars: first.stderrNextOffsetChars!,
      }))!;
      const third = (await manager.getJobResult(job.id, 4, {
        stdoutOffsetChars: second.stdoutNextOffsetChars!,
        stderrOffsetChars: second.stderrNextOffsetChars!,
      }))!;

      expect(first.stdout + second.stdout + third.stdout).toBe("abcdefghij");
      expect(first.stderr + second.stderr + third.stderr).toBe("klmnopqrst");
      expect(third.stdoutTruncated).toBe(false);
      expect(third.stderrTruncated).toBe(false);
      expect(third.stdoutNextOffsetChars).toBeNull();
      expect(third.stderrNextOffsetChars).toBeNull();
    });
  });

  describe("idle timeout", () => {
    it("should kill job after idle timeout with no output", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("sleep" as LlmCli, ["30"], "corr-idle-1", undefined, 500);

      await waitForJobDone(manager, job.id, 10000);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("failed");
      expect(snapshot.exitCode).toBe(125);
      expect(snapshot.error).toContain("inactivity");
    }, 15000);

    it("should reset idle timer on output", async () => {
      const manager = new AsyncJobManager();
      // Process outputs every 200ms — idle timeout of 500ms should not fire
      const job = await manager.startJob(
        "sh" as LlmCli,
        ["-c", "for i in 1 2 3 4 5; do echo tick; sleep 0.2; done"],
        "corr-idle-2",
        undefined,
        500
      );

      await waitForJobDone(manager, job.id);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("completed");
      expect(snapshot.exitCode).toBe(0);
    }, 15000);

    it("should not idle-timeout when idleTimeoutMs is not set", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("sleep" as LlmCli, ["1"], "corr-idle-3");

      await waitForJobDone(manager, job.id, 5000);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("completed");
    }, 15000);

    it("should set exitCode 125 distinct from wall-clock timeout 124", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("sleep" as LlmCli, ["30"], "corr-idle-4", undefined, 300);

      await waitForJobDone(manager, job.id, 10000);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.exitCode).toBe(125);
      expect(snapshot.exitCode).not.toBe(124);
    }, 15000);
  });

  describe("cancel", () => {
    it("should cancel a running job", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("sleep" as LlmCli, ["30"], "corr-cancel-1");

      const result = await manager.cancelJob(job.id);
      expect(result.canceled).toBe(true);

      // SIGTERM is only a request. The provider attempt remains owned until
      // ChildProcess `close` proves it cannot keep running.
      await waitForJobDone(manager, job.id);
      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("canceled");
      expect(snapshot.finishedAt).toBeTruthy();
    });

    it("should return error for non-existent job", async () => {
      const manager = new AsyncJobManager();
      const result = await manager.cancelJob("nonexistent-id");
      expect(result.canceled).toBe(false);
      expect(result.reason).toContain("not found");
    });

    it("should return error for already completed job", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("true" as LlmCli, [], "corr-cancel-2");

      await waitForJobDone(manager, job.id);

      const result = await manager.cancelJob(job.id);
      expect(result.canceled).toBe(false);
      expect(result.reason).toContain("already");
    });

    it("should SIGKILL a canceled job that ignores SIGTERM", async () => {
      // If the exited flag fix works, SIGKILL fires after 5s and the
      // process dies. If the old proc.killed bug was present, SIGKILL
      // would never fire and the process would hang for 30s (timeout).
      const manager = new AsyncJobManager();
      const job = await manager.startJob(
        "bash" as LlmCli,
        ["-c", "trap '' TERM; sleep 30"],
        "corr-cancel-3"
      );

      // Give process time to set up trap
      await new Promise(r => setTimeout(r, 200));
      await manager.cancelJob(job.id);

      // Wait for the process to actually exit via SIGKILL escalation (~5s).
      // Signal-killed processes have code=null, so exitCode stays null for
      // canceled jobs. Use the exited flag instead.
      await waitFor(async () => {
        const s = await manager.getJobSnapshot(job.id);
        return s !== null && s.exited === true;
      }, 10000);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("canceled");
    }, 15000);
  });

  describe("process health", () => {
    it("should return health for running jobs", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("sleep" as LlmCli, ["10"], "corr-health-1");
      expect(job.status).toBe("running");

      const running = manager.getRunningJobs();
      expect(running).toHaveLength(1);
      expect(running[0].jobId).toBe(job.id);
      expect(running[0].cli).toBe("sleep");

      const health = manager.getJobHealth();
      expect(health.runningJobs).toBe(1);
      expect(health.deadJobs).toBe(0);
      expect(health.jobs).toHaveLength(1);
      expect(health.jobs[0].processHealth?.alive).toBe(true);

      // Cleanup
      await manager.cancelJob(job.id);
    });

    it("should return empty health when no jobs are running", () => {
      const manager = new AsyncJobManager();
      const health = manager.getJobHealth();
      expect(health.runningJobs).toBe(0);
      expect(health.deadJobs).toBe(0);
      expect(health.zombieJobs).toBe(0);
      expect(health.jobs).toHaveLength(0);
    });
  });

  describe("outputFormat tracking", () => {
    it("should store and retrieve output format", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob(
        "echo" as LlmCli,
        ["test"],
        "corr-fmt-1",
        undefined,
        undefined,
        "stream-json"
      );

      expect(manager.getJobOutputFormat(job.id)).toBe("stream-json");

      await waitForJobDone(manager, job.id);
    });

    it("should return undefined for jobs without output format", async () => {
      const manager = new AsyncJobManager();
      const job = await manager.startJob("echo" as LlmCli, ["test"], "corr-fmt-2");

      expect(manager.getJobOutputFormat(job.id)).toBeUndefined();

      await waitForJobDone(manager, job.id);
    });

    it("should return undefined for non-existent jobs", () => {
      const manager = new AsyncJobManager();
      expect(manager.getJobOutputFormat("nonexistent")).toBeUndefined();
    });
  });

  describe("metrics callback", () => {
    it("should fire callback exactly once on successful completion", async () => {
      const callback = vi.fn();
      const manager = new AsyncJobManager(undefined, callback);
      const job = await manager.startJob("echo" as LlmCli, ["hello"], "corr-metrics-1");

      await waitForJobDone(manager, job.id);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("completed");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith("echo", expect.any(Number), true);
    });

    it("should fire callback exactly once on failure", async () => {
      const callback = vi.fn();
      const manager = new AsyncJobManager(undefined, callback);
      const job = await manager.startJob("sh" as LlmCli, ["-c", "exit 42"], "corr-metrics-2");

      await waitForJobDone(manager, job.id);

      const snapshot = (await manager.getJobSnapshot(job.id))!;
      expect(snapshot.status).toBe("failed");
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith("sh", expect.any(Number), false);
    });

    it("should NOT fire callback on cancellation", async () => {
      const callback = vi.fn();
      const manager = new AsyncJobManager(undefined, callback);
      const job = await manager.startJob("sleep" as LlmCli, ["30"], "corr-metrics-3");

      await manager.cancelJob(job.id);

      // Wait for process exit
      await waitFor(async () => {
        const s = await manager.getJobSnapshot(job.id);
        return s !== null && s.exited === true;
      }, 10000);

      expect(callback).not.toHaveBeenCalled();
    }, 15000);

    it("should fire callback on idle timeout kill", async () => {
      const callback = vi.fn();
      const manager = new AsyncJobManager(undefined, callback);
      const job = await manager.startJob(
        "sleep" as LlmCli,
        ["30"],
        "corr-metrics-4",
        undefined,
        300
      );

      await waitForJobDone(manager, job.id, 10000);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith("sleep", expect.any(Number), false);
    }, 15000);

    it("should not destabilize manager when callback throws", async () => {
      const throwingCallback = vi.fn().mockImplementation(() => {
        throw new Error("callback boom");
      });
      const manager = new AsyncJobManager(undefined, throwingCallback);

      // First job — callback throws
      const job1 = await manager.startJob("echo" as LlmCli, ["first"], "corr-metrics-5");
      await waitForJobDone(manager, job1.id);
      expect(throwingCallback).toHaveBeenCalledTimes(1);
      expect((await manager.getJobSnapshot(job1.id)!).status).toBe("completed");

      // Second job — manager still works after throw
      const job2 = await manager.startJob("echo" as LlmCli, ["second"], "corr-metrics-6");
      await waitForJobDone(manager, job2.id);
      expect(throwingCallback).toHaveBeenCalledTimes(2);
      expect((await manager.getJobSnapshot(job2.id)!).status).toBe("completed");
    });

    it("should fire callback exactly once even if error and close both fire", async () => {
      // Simulate a scenario where the process triggers both error and close events
      // by using a command that fails. The metricsRecorded guard prevents double-counting.
      const callback = vi.fn();
      const manager = new AsyncJobManager(undefined, callback);
      const job = await manager.startJob(
        "sh" as LlmCli,
        ["-c", "echo err >&2; exit 1"],
        "corr-metrics-7"
      );

      await waitForJobDone(manager, job.id);

      // Regardless of event ordering, callback fires exactly once
      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith("sh", expect.any(Number), false);
    });
  });
});
