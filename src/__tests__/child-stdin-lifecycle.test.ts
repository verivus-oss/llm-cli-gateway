import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";

import { AsyncJobManager, isAsyncJobInProgress, type LlmCli } from "../async-job-manager.js";
import {
  CHILD_STDIN_INCOMPLETE_CODE,
  CHILD_STDIN_INCOMPLETE_EXIT_CODE,
  CHILD_STDIN_INCOMPLETE_MESSAGE,
  CHILD_STDIN_WRITE_FAILED_CODE,
  CHILD_STDIN_WRITE_FAILED_MESSAGE,
  isChildStdinDeliveryIncomplete,
  writeAndCloseChildStdin,
} from "../child-stdin.js";
import {
  executeCli,
  isProcessGroupRegisteredForTest,
  PROCESS_GROUP_KILL_GRACE_MS,
  resetCliBreakersForTest,
} from "../executor.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

const LARGE_STDIN = "x".repeat(4 * 1024 * 1024);
const EARLY_EXIT_SCRIPT = "process.stdin.destroy(); setTimeout(() => process.exit(0), 100)";
const EARLY_NONZERO_EXIT_SCRIPT =
  "process.stdin.destroy(); setTimeout(() => process.exit(42), 100)";
const IMMEDIATE_EXIT_SCRIPT = "process.exit(0)";
const BLOCKED_STDIN_SCRIPT = "process.stdin.pause(); setInterval(() => {}, 1000)";
const IGNORE_TERM_DESCENDANT_SCRIPT =
  'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)';
const PROVIDER_WITH_DESCENDANT_SCRIPT = [
  'const { spawn } = require("node:child_process");',
  `const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(
    IGNORE_TERM_DESCENDANT_SCRIPT
  )}], { stdio: ["ignore", "pipe", "ignore"] });`,
  'descendant.stdout.once("data", () => process.stdout.write(`${process.pid}:${descendant.pid}\\n`));',
  "process.stdin.pause();",
  "setInterval(() => {}, 1000);",
].join("");

async function waitForTerminal(
  manager: AsyncJobManager,
  jobId: string,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = manager.getJobSnapshot(jobId);
    if (snapshot && !isAsyncJobInProgress(snapshot.status)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

async function captureUncaught(run: () => Promise<void>): Promise<Error[]> {
  const uncaught: Error[] = [];
  const onUncaught = (error: Error): void => {
    uncaught.push(error);
  };
  process.on("uncaughtException", onUncaught);
  try {
    await run();
    // Writable errors are deferred. Give any event queued behind child close a
    // full turn to surface before removing the process-level observation hook.
    await new Promise<void>(resolve => setImmediate(resolve));
    return uncaught;
  } finally {
    process.off("uncaughtException", onUncaught);
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function parseProcessIds(stdout: string): { parentPid: number; descendantPid: number } {
  const match = stdout.match(/(?:^|\n)(\d+):(\d+)(?:\n|$)/);
  if (!match) throw new Error(`missing provider process ids in stdout: ${stdout}`);
  return { parentPid: Number(match[1]), descendantPid: Number(match[2]) };
}

async function waitForGroupFence(parentPid: number, descendantPid: number): Promise<void> {
  const deadline = Date.now() + PROCESS_GROUP_KILL_GRACE_MS + 3000;
  while (Date.now() < deadline) {
    if (!pidIsAlive(descendantPid) && !isProcessGroupRegisteredForTest(parentPid)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(
    `process-group fence did not clean parent ${parentPid} / descendant ${descendantPid}`
  );
}

describe("provider child stdin lifecycle", () => {
  it("removes the temporary stdin error listener after stream close", async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const closed = new Promise<void>(resolve => sink.once("close", resolve));
    const delivery = writeAndCloseChildStdin(sink, LARGE_STDIN, () => {
      throw new Error("successful sink must not report a write failure");
    });

    await closed;
    expect(delivery.state).toBe("succeeded");
    expect(sink.listenerCount("error")).toBe(0);
    expect(() => delivery.cleanup()).not.toThrow();
  });

  it("fails closed when child close wins the race with the write callback", async () => {
    let completeWrite: ((error?: Error | null) => void) | undefined;
    const sink = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const delivery = writeAndCloseChildStdin(sink, LARGE_STDIN, () => {});

    expect(delivery.state).toBe("pending");
    expect(isChildStdinDeliveryIncomplete(delivery)).toBe(true);
    delivery.cleanup();

    // A callback that arrives after the owner observed child close cannot
    // retroactively turn that already-terminal request into a success.
    completeWrite?.();
    expect(delivery.state).toBe("succeeded");
    sink.destroy();
  });

  it("owns a late stdin error emitted after finish and before close", async () => {
    const sink = new Writable({
      autoDestroy: false,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const finished = new Promise<void>(resolve => sink.once("finish", resolve));
    const closed = new Promise<void>(resolve => sink.once("close", resolve));
    const errors: Error[] = [];
    writeAndCloseChildStdin(sink, LARGE_STDIN, error => errors.push(error));

    await finished;
    expect(sink.listenerCount("error")).toBe(1);
    const lateError = Object.assign(new Error("late write EPIPE"), { code: "EPIPE" });
    expect(() => sink.emit("error", lateError)).not.toThrow();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "ChildStdinIncompleteError",
      code: CHILD_STDIN_INCOMPLETE_CODE,
      retryable: false,
      message: CHILD_STDIN_INCOMPLETE_MESSAGE,
    });
    expect(inspect(errors[0], { depth: 5 })).not.toContain("late write EPIPE");

    sink.destroy();
    await closed;
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("reports a non-benign deferred stdin failure once and still owns its error event", async () => {
    const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback(failure);
      },
    });
    const closed = new Promise<void>(resolve => sink.once("close", resolve));
    const reported: Error[] = [];

    const uncaught = await captureUncaught(async () => {
      writeAndCloseChildStdin(sink, LARGE_STDIN, error => reported.push(error));
      await closed;
    });

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      name: "ChildStdinWriteFailedError",
      code: CHILD_STDIN_WRITE_FAILED_CODE,
      retryable: false,
      message: CHILD_STDIN_WRITE_FAILED_MESSAGE,
    });
    expect((reported[0] as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(reported[0]?.stack)).not.toContain("permission denied");
    expect(uncaught).toEqual([]);
    expect(sink.listenerCount("error")).toBe(0);
  });

  it("direct execution rejects exit 0 when the child closes stdin before full delivery", async () => {
    resetCliBreakersForTest();
    let observed: Error | undefined;
    const uncaught = await captureUncaught(async () => {
      try {
        await executeCli(process.execPath, ["-e", EARLY_EXIT_SCRIPT], {
          stdin: LARGE_STDIN,
        });
      } catch (error) {
        observed = error as Error;
      }
    });

    expect(observed).toMatchObject({ code: CHILD_STDIN_INCOMPLETE_CODE });
    expect(observed?.message).toContain(CHILD_STDIN_INCOMPLETE_MESSAGE);
    expect(observed?.message).not.toMatch(/EPIPE|ERR_STREAM_DESTROYED|ECONNRESET|x{64}/);
    expect((observed as Error & { cause?: Error }).cause).toMatchObject({
      name: "ChildStdinIncompleteError",
      code: CHILD_STDIN_INCOMPLETE_CODE,
      retryable: false,
      message: CHILD_STDIN_INCOMPLETE_MESSAGE,
    });
    expect(
      ((observed as Error & { cause?: Error }).cause as Error & { cause?: unknown }).cause
    ).toBe(undefined);
    expect(uncaught).toEqual([]);
  });

  it("stress-checks immediate clean exits without accepting incomplete stdin", async () => {
    const uncaught = await captureUncaught(async () => {
      for (let attempt = 0; attempt < 12; attempt++) {
        resetCliBreakersForTest();
        await expect(
          executeCli(process.execPath, ["-e", IMMEDIATE_EXIT_SCRIPT], { stdin: LARGE_STDIN })
        ).rejects.toMatchObject({ code: CHILD_STDIN_INCOMPLETE_CODE });
      }
    });

    expect(uncaught).toEqual([]);
  });

  it("direct execution preserves a provider nonzero exit after an incomplete stdin write", async () => {
    resetCliBreakersForTest();
    const result = await executeCli(process.execPath, ["-e", EARLY_NONZERO_EXIT_SCRIPT], {
      stdin: LARGE_STDIN,
    });

    expect(result.code).toBe(42);
    expect(result.stderr).not.toContain(CHILD_STDIN_INCOMPLETE_MESSAGE);
  });

  it("direct execution survives an idle kill while >64 KiB stdin is draining", async () => {
    resetCliBreakersForTest();
    let resultCode: number | undefined;
    const uncaught = await captureUncaught(async () => {
      const result = await executeCli(process.execPath, ["-e", BLOCKED_STDIN_SCRIPT], {
        stdin: LARGE_STDIN,
        idleTimeout: 40,
      });
      resultCode = result.code;
    });

    expect(resultCode).toBe(125);
    expect(uncaught).toEqual([]);
  });

  it.runIf(process.platform !== "win32")(
    "direct escalation kills a SIGTERM-ignoring descendant after leader close",
    async () => {
      resetCliBreakersForTest();
      const result = await executeCli(process.execPath, ["-e", PROVIDER_WITH_DESCENDANT_SCRIPT], {
        stdin: LARGE_STDIN,
        idleTimeout: 100,
      });
      const { parentPid, descendantPid } = parseProcessIds(result.stdout);

      expect(result.code).toBe(125);
      expect(pidIsAlive(descendantPid)).toBe(true);
      expect(isProcessGroupRegisteredForTest(parentPid)).toBe(true);

      await waitForGroupFence(parentPid, descendantPid);
      expect(pidIsAlive(descendantPid)).toBe(false);
      expect(isProcessGroupRegisteredForTest(parentPid)).toBe(false);
    },
    PROCESS_GROUP_KILL_GRACE_MS + 5000
  );

  it("async execution fails exit 0 when the child closes stdin before full delivery", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    try {
      const uncaught = await captureUncaught(async () => {
        const started = manager.startJobWithDedup(
          process.execPath as LlmCli,
          ["-e", EARLY_EXIT_SCRIPT],
          "stdin-early-exit",
          { stdin: LARGE_STDIN }
        );
        await waitForTerminal(manager, started.snapshot.id);

        expect(manager.getJobSnapshot(started.snapshot.id)).toMatchObject({
          status: "failed",
          exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
          error: CHILD_STDIN_INCOMPLETE_MESSAGE,
          retryable: false,
        });
        expect(store.getById(started.snapshot.id)).toMatchObject({
          status: "failed",
          exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
          error: CHILD_STDIN_INCOMPLETE_MESSAGE,
          retryable: false,
        });
        const result = manager.getJobResult(started.snapshot.id);
        expect(result).toMatchObject({
          status: "failed",
          exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
          error: CHILD_STDIN_INCOMPLETE_MESSAGE,
          retryable: false,
          stderr: CHILD_STDIN_INCOMPLETE_MESSAGE,
        });
        expect(`${result?.error}\n${result?.stderr}`).not.toMatch(
          /EPIPE|ERR_STREAM_DESTROYED|ECONNRESET|x{64}/
        );
      });

      expect(uncaught).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("async execution preserves a provider nonzero exit after an incomplete stdin write", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    try {
      const started = manager.startJobWithDedup(
        process.execPath as LlmCli,
        ["-e", EARLY_NONZERO_EXIT_SCRIPT],
        "stdin-early-nonzero-exit",
        { stdin: LARGE_STDIN }
      );
      await waitForTerminal(manager, started.snapshot.id);

      expect(manager.getJobResult(started.snapshot.id)).toMatchObject({
        status: "failed",
        exitCode: 42,
        error: null,
      });
      expect(store.getById(started.snapshot.id)).toMatchObject({
        status: "failed",
        exitCode: 42,
        error: null,
      });
    } finally {
      await manager.dispose();
    }
  });

  it("persists a payload-safe incomplete-delivery result across a SQLite reopen", async () => {
    const root = mkdtempSync(join(tmpdir(), "child-stdin-persistence-"));
    const database = join(root, "jobs.db");
    const store = new SqliteJobStore(database, noopLogger);
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    let jobId = "";
    try {
      const started = manager.startJobWithDedup(
        process.execPath as LlmCli,
        ["-e", EARLY_EXIT_SCRIPT],
        "stdin-persistence",
        { stdin: LARGE_STDIN, forceRefresh: true }
      );
      jobId = started.snapshot.id;
      await waitForTerminal(manager, jobId);

      const durable = store.getById(jobId);
      expect(durable).toMatchObject({
        status: "failed",
        exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
        error: CHILD_STDIN_INCOMPLETE_MESSAGE,
        retryable: false,
        payloadJson: null,
      });
      expect(JSON.stringify(durable)).not.toMatch(/EPIPE|ERR_STREAM_DESTROYED|ECONNRESET|x{64}/);
    } finally {
      await manager.dispose();
      store.close();
    }

    try {
      const reopened = new SqliteJobStore(database, noopLogger);
      const restartedManager = new AsyncJobManager(noopLogger, undefined, reopened);
      try {
        expect(reopened.getById(jobId)).toMatchObject({
          status: "failed",
          exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
          error: CHILD_STDIN_INCOMPLETE_MESSAGE,
          retryable: false,
          payloadJson: null,
        });
        expect(restartedManager.getJobSnapshot(jobId)).toMatchObject({
          status: "failed",
          exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
          error: CHILD_STDIN_INCOMPLETE_MESSAGE,
          retryable: false,
        });
        expect(restartedManager.getJobResult(jobId)).toMatchObject({
          status: "failed",
          exitCode: CHILD_STDIN_INCOMPLETE_EXIT_CODE,
          error: CHILD_STDIN_INCOMPLETE_MESSAGE,
          retryable: false,
        });
      } finally {
        await restartedManager.dispose();
        reopened.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps caller cancellation authoritative while stdin is still draining", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    try {
      const uncaught = await captureUncaught(async () => {
        const started = manager.startJobWithDedup(
          process.execPath as LlmCli,
          ["-e", BLOCKED_STDIN_SCRIPT],
          "stdin-cancel",
          { stdin: LARGE_STDIN, forceRefresh: true }
        );
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(manager.cancelJob(started.snapshot.id)).toEqual({ canceled: true });
        await waitForTerminal(manager, started.snapshot.id);

        expect(manager.getJobResult(started.snapshot.id)).toMatchObject({
          status: "canceled",
          error: null,
        });
        expect(store.getById(started.snapshot.id)).toMatchObject({
          status: "canceled",
          error: null,
        });
      });

      expect(uncaught).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it("async execution terminalizes after an idle kill during >64 KiB drain", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    try {
      const uncaught = await captureUncaught(async () => {
        const started = manager.startJobWithDedup(
          process.execPath as LlmCli,
          ["-e", BLOCKED_STDIN_SCRIPT],
          "stdin-mid-drain-kill",
          { stdin: LARGE_STDIN, idleTimeoutMs: 40 }
        );
        await waitForTerminal(manager, started.snapshot.id);

        expect(manager.getJobSnapshot(started.snapshot.id)).toMatchObject({
          status: "failed",
          exitCode: 125,
        });
        expect(store.getById(started.snapshot.id)).toMatchObject({
          status: "failed",
          exitCode: 125,
        });
      });

      expect(uncaught).toEqual([]);
    } finally {
      await manager.dispose();
    }
  });

  it.runIf(process.platform !== "win32")(
    "async escalation kills a SIGTERM-ignoring descendant and releases ownership",
    async () => {
      const store = new MemoryJobStore();
      const manager = new AsyncJobManager(noopLogger, undefined, store);
      try {
        const started = manager.startJobWithDedup(
          process.execPath as LlmCli,
          ["-e", PROVIDER_WITH_DESCENDANT_SCRIPT],
          "stdin-descendant-fence",
          { stdin: LARGE_STDIN, idleTimeoutMs: 100 }
        );
        await waitForTerminal(manager, started.snapshot.id);
        const result = manager.getJobResult(started.snapshot.id);
        if (!result) throw new Error("missing async job result");
        const { parentPid, descendantPid } = parseProcessIds(result.stdout);

        expect(result).toMatchObject({ status: "failed", exitCode: 125 });
        expect(store.getById(started.snapshot.id)).toMatchObject({
          status: "failed",
          exitCode: 125,
        });
        expect(pidIsAlive(descendantPid)).toBe(true);
        expect(isProcessGroupRegisteredForTest(parentPid)).toBe(true);

        await waitForGroupFence(parentPid, descendantPid);
        expect(pidIsAlive(descendantPid)).toBe(false);
        expect(isProcessGroupRegisteredForTest(parentPid)).toBe(false);
      } finally {
        await manager.dispose();
      }
    },
    PROCESS_GROUP_KILL_GRACE_MS + 5000
  );
});
