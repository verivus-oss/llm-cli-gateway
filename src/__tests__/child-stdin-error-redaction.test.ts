import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

const { RAW_STDIN_ERROR_SENTINEL, DELAYED_STDIN_FAILURE, RAW_STDIN_ERROR_REPORTS } = vi.hoisted(
  () => ({
    RAW_STDIN_ERROR_SENTINEL: "PRIVATE_STDIN_NATIVE_ERROR_SENTINEL",
    DELAYED_STDIN_FAILURE: "trigger-delayed-private-stdin-failure",
    RAW_STDIN_ERROR_REPORTS: [] as string[],
  })
);

vi.mock("../child-stdin.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../child-stdin.js")>();
  return {
    ...actual,
    writeAndCloseChildStdin: (
      _stdin: NodeJS.WritableStream,
      payload: string,
      onError: (error: Error) => void
    ) => {
      let state: "pending" | "failed" = "pending";
      const report = (): void => {
        state = "failed";
        RAW_STDIN_ERROR_REPORTS.push(payload);
        const raw = Object.assign(new Error(RAW_STDIN_ERROR_SENTINEL), {
          name: `NativePipeError:${RAW_STDIN_ERROR_SENTINEL}`,
          code: "EACCES",
          cause: { privateDetail: RAW_STDIN_ERROR_SENTINEL },
        });
        onError(raw);
      };
      const timer = payload === DELAYED_STDIN_FAILURE ? setTimeout(report, 120) : undefined;
      if (!timer) report();
      return {
        get state(): "pending" | "failed" {
          return state;
        },
        cleanup(): void {
          if (timer) clearTimeout(timer);
        },
      };
    },
  };
});

import { AsyncJobManager, isAsyncJobInProgress, type LlmCli } from "../async-job-manager.js";
import { CHILD_STDIN_WRITE_FAILED_CODE, CHILD_STDIN_WRITE_FAILED_MESSAGE } from "../child-stdin.js";
import { executeCli, primeCliBreakerStateForTest, resetCliBreakersForTest } from "../executor.js";
import type { FlightLogResult, FlightLogStart, FlightRecorderLike } from "../flight-recorder.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import type { Logger } from "../logger.js";
import { CircuitBreakerState } from "../retry.js";

class CapturingFlightRecorder implements FlightRecorderLike {
  readonly starts: FlightLogStart[] = [];
  readonly completes: Array<{ correlationId: string; result: FlightLogResult }> = [];

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

class CapturingLogger implements Logger {
  readonly entries: Array<{ level: string; message: string; meta?: unknown }> = [];

  info(message: string, meta?: unknown): void {
    this.entries.push({ level: "info", message, meta });
  }

  error(message: string, meta?: unknown): void {
    this.entries.push({ level: "error", message, meta });
  }

  debug(message: string, meta?: unknown): void {
    this.entries.push({ level: "debug", message, meta });
  }
}

const tempRoots: string[] = [];

afterEach(() => {
  RAW_STDIN_ERROR_REPORTS.length = 0;
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitForTerminal(manager: AsyncJobManager, jobId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const snapshot = manager.getJobSnapshot(jobId);
    if (snapshot && !isAsyncJobInProgress(snapshot.status)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`job ${jobId} did not reach a terminal state`);
}

describe("child stdin native-error redaction", () => {
  it("removes raw native details from direct errors and their causes", async () => {
    resetCliBreakersForTest();

    let observed: unknown;
    try {
      await executeCli(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdin: "private request payload",
      });
    } catch (error) {
      observed = error;
    }

    expect(observed).toBeInstanceOf(Error);
    expect(observed).toMatchObject({ code: CHILD_STDIN_WRITE_FAILED_CODE });
    const direct = observed as Error & { cause?: Error };
    expect(direct.message).toContain(CHILD_STDIN_WRITE_FAILED_MESSAGE);
    expect(direct.cause).toMatchObject({
      name: "ChildStdinWriteFailedError",
      code: CHILD_STDIN_WRITE_FAILED_CODE,
      retryable: false,
      message: CHILD_STDIN_WRITE_FAILED_MESSAGE,
    });
    expect((direct.cause as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(inspect(observed, { depth: 10 })).not.toContain(RAW_STDIN_ERROR_SENTINEL);
  });

  it("keeps live, durable, result, flight, and logger surfaces payload-safe", async () => {
    const root = mkdtempSync(join(tmpdir(), "stdin-error-redaction-"));
    tempRoots.push(root);
    const database = join(root, "jobs.db");
    const logger = new CapturingLogger();
    const flightRecorder = new CapturingFlightRecorder();
    const store = new SqliteJobStore(database, logger);
    const manager = new AsyncJobManager(logger, undefined, store, flightRecorder);
    let jobId = "";

    try {
      const started = manager.startJobWithDedup(
        process.execPath as LlmCli,
        ["-e", "setInterval(() => {}, 1000)"],
        "stdin-native-error-redaction",
        {
          stdin: "private request payload",
          forceRefresh: true,
          flightRecorderEntry: { model: "test-model", prompt: "public prompt marker" },
          writeFlightStart: true,
        }
      );
      jobId = started.snapshot.id;
      await waitForTerminal(manager, jobId);

      const snapshot = manager.getJobSnapshot(jobId);
      const result = manager.getJobResult(jobId);
      const durable = store.getById(jobId);
      expect(snapshot).toMatchObject({
        status: "failed",
        exitCode: 1,
        error: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        retryable: false,
      });
      expect(result).toMatchObject({
        status: "failed",
        exitCode: 1,
        error: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        stderr: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        retryable: false,
      });
      expect(durable).toMatchObject({
        status: "failed",
        exitCode: 1,
        error: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        stderr: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        retryable: false,
      });
      expect(flightRecorder.completes).toHaveLength(1);
      expect(flightRecorder.completes[0]?.result).toMatchObject({
        status: "failed",
        exitCode: 1,
        errorMessage: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        response: CHILD_STDIN_WRITE_FAILED_MESSAGE,
      });

      const allSurfaces = inspect(
        { snapshot, result, durable, flight: flightRecorder.completes, logs: logger.entries },
        { depth: 20 }
      );
      expect(allSurfaces).not.toContain(RAW_STDIN_ERROR_SENTINEL);
      expect(allSurfaces).not.toContain("NativePipeError");
      expect(allSurfaces).not.toContain("privateDetail");
      expect(allSurfaces).not.toContain("EACCES");
    } finally {
      await manager.dispose();
      store.close();
    }

    const reopened = new SqliteJobStore(database, logger);
    try {
      const durableAfterRestart = reopened.getById(jobId);
      expect(durableAfterRestart).toMatchObject({
        status: "failed",
        exitCode: 1,
        error: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        stderr: CHILD_STDIN_WRITE_FAILED_MESSAGE,
        retryable: false,
      });
      expect(inspect(durableAfterRestart, { depth: 10 })).not.toContain(RAW_STDIN_ERROR_SENTINEL);
    } finally {
      reopened.close();
    }
  });

  it("keeps a racing provider nonzero exit authoritative without leaking the native error", async () => {
    const providerExit = [
      'process.on("SIGTERM", () => {});',
      "setTimeout(() => process.exit(42), 250);",
    ].join("");

    resetCliBreakersForTest();
    const direct = await executeCli(process.execPath, ["-e", providerExit], {
      stdin: DELAYED_STDIN_FAILURE,
    });
    expect(direct).toMatchObject({ code: 42, stderr: "" });
    expect(RAW_STDIN_ERROR_REPORTS).toEqual([DELAYED_STDIN_FAILURE]);
    expect(inspect(direct, { depth: 10 })).not.toContain(RAW_STDIN_ERROR_SENTINEL);
    expect(inspect(direct, { depth: 10 })).not.toContain(CHILD_STDIN_WRITE_FAILED_MESSAGE);

    const logger = new CapturingLogger();
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(logger, undefined, store);
    try {
      const started = manager.startJobWithDedup(
        process.execPath as LlmCli,
        ["-e", providerExit],
        "stdin-nonzero-precedence",
        { stdin: DELAYED_STDIN_FAILURE, forceRefresh: true }
      );
      await waitForTerminal(manager, started.snapshot.id);
      expect(RAW_STDIN_ERROR_REPORTS).toEqual([DELAYED_STDIN_FAILURE, DELAYED_STDIN_FAILURE]);

      const snapshot = manager.getJobSnapshot(started.snapshot.id);
      const result = manager.getJobResult(started.snapshot.id);
      const durable = store.getById(started.snapshot.id);
      expect(snapshot).toMatchObject({ status: "failed", exitCode: 42, error: null });
      expect(result).toMatchObject({ status: "failed", exitCode: 42, error: null, stderr: "" });
      expect(durable).toMatchObject({ status: "failed", exitCode: 42, error: null, stderr: "" });

      const allSurfaces = inspect(
        { snapshot, result, durable, logs: logger.entries },
        { depth: 20 }
      );
      expect(allSurfaces).not.toContain(RAW_STDIN_ERROR_SENTINEL);
      expect(allSurfaces).not.toContain("NativePipeError");
      expect(allSurfaces).not.toContain("privateDetail");
      expect(allSurfaces).not.toContain("EACCES");
    } finally {
      await manager.dispose();
    }
  });

  it("keeps a racing wall-clock timeout authoritative without leaking the native error", async () => {
    // The wall clock and the idle clock are different knobs with different exit
    // codes: `timeout` arms `timeoutMs` -> `timedOut` -> exit 124
    // (executor.ts:694-703, :788-802), while `idleTimeout` arms `idleMs` ->
    // `idledOut` -> exit 125 (executor.ts:706-723, :804-818). Only the wall
    // clock is checked first in the close handler, ahead of the `stdinFailure`
    // branch at executor.ts:842.
    const providerExit = [
      'process.on("SIGTERM", () => {});',
      "setTimeout(() => process.exit(0), 250);",
    ].join("");

    resetCliBreakersForTest();
    // Exit 124 is transient (retry.ts:71), so a CLOSED breaker would burn five
    // attempts and ~15s of backoff before returning. A HALF_OPEN breaker settles
    // on the first attempt (retry.ts:193-200) while still carrying `error.result`
    // through to executeCli's return (retry.ts:132-134, executor.ts:903-906), so
    // the close handler under test runs exactly once and the test stays fast.
    primeCliBreakerStateForTest(process.execPath, CircuitBreakerState.HALF_OPEN);
    const directTimeout = await executeCli(process.execPath, ["-e", providerExit], {
      stdin: DELAYED_STDIN_FAILURE,
      timeout: 100,
    });

    // The wall timeout at 100ms precedes the stdin failure at 120ms, which
    // precedes the child's own exit 0 at 250ms: the close handler sees a real
    // stdinFailure and must still report the wall timeout.
    expect(directTimeout).toMatchObject({ code: 124 });
    expect(directTimeout.stderr).toContain("Process timed out after 100ms");
    expect(directTimeout.stderr).not.toContain("inactivity");
    expect(RAW_STDIN_ERROR_REPORTS).toEqual([DELAYED_STDIN_FAILURE]);
    expect(inspect(directTimeout, { depth: 10 })).not.toContain(RAW_STDIN_ERROR_SENTINEL);
    expect(inspect(directTimeout, { depth: 10 })).not.toContain(CHILD_STDIN_WRITE_FAILED_MESSAGE);
    expect(inspect(directTimeout, { depth: 10 })).not.toContain("NativePipeError");
    expect(inspect(directTimeout, { depth: 10 })).not.toContain("privateDetail");
    expect(inspect(directTimeout, { depth: 10 })).not.toContain("EACCES");
  });

  it("keeps timeout and cancellation authoritative over a delayed native stdin error", async () => {
    const providerExit = [
      'process.on("SIGTERM", () => {});',
      "setTimeout(() => process.exit(0), 250);",
    ].join("");

    resetCliBreakersForTest();
    const directTimeout = await executeCli(process.execPath, ["-e", providerExit], {
      stdin: DELAYED_STDIN_FAILURE,
      idleTimeout: 100,
    });
    expect(directTimeout).toMatchObject({ code: 125 });
    expect(RAW_STDIN_ERROR_REPORTS).toEqual([DELAYED_STDIN_FAILURE]);
    expect(inspect(directTimeout, { depth: 10 })).not.toContain(RAW_STDIN_ERROR_SENTINEL);

    const logger = new CapturingLogger();
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(logger, undefined, store);
    try {
      const idle = manager.startJobWithDedup(
        process.execPath as LlmCli,
        ["-e", providerExit],
        "stdin-idle-precedence",
        {
          stdin: DELAYED_STDIN_FAILURE,
          idleTimeoutMs: 100,
          forceRefresh: true,
        }
      );
      await waitForTerminal(manager, idle.snapshot.id);
      await new Promise(resolve => setTimeout(resolve, 40));
      expect(RAW_STDIN_ERROR_REPORTS).toEqual([DELAYED_STDIN_FAILURE, DELAYED_STDIN_FAILURE]);
      expect(manager.getJobResult(idle.snapshot.id)).toMatchObject({
        status: "failed",
        exitCode: 125,
        error: "Process killed after 100ms of inactivity",
      });
      expect(store.getById(idle.snapshot.id)).toMatchObject({ status: "failed", exitCode: 125 });

      const canceled = manager.startJobWithDedup(
        process.execPath as LlmCli,
        ["-e", providerExit],
        "stdin-cancel-precedence",
        { stdin: DELAYED_STDIN_FAILURE, forceRefresh: true }
      );
      await new Promise(resolve => setTimeout(resolve, 80));
      expect(manager.cancelJob(canceled.snapshot.id)).toEqual({ canceled: true });
      await new Promise(resolve => setTimeout(resolve, 240));
      expect(RAW_STDIN_ERROR_REPORTS).toEqual([
        DELAYED_STDIN_FAILURE,
        DELAYED_STDIN_FAILURE,
        DELAYED_STDIN_FAILURE,
      ]);
      expect(manager.getJobResult(canceled.snapshot.id)).toMatchObject({
        status: "canceled",
        error: null,
      });
      expect(store.getById(canceled.snapshot.id)).toMatchObject({
        status: "canceled",
        error: null,
      });

      const allSurfaces = inspect(
        {
          idleStatus: manager.getJobSnapshot(idle.snapshot.id),
          idleResult: manager.getJobResult(idle.snapshot.id),
          idleDurable: store.getById(idle.snapshot.id),
          canceledStatus: manager.getJobSnapshot(canceled.snapshot.id),
          canceledResult: manager.getJobResult(canceled.snapshot.id),
          canceledDurable: store.getById(canceled.snapshot.id),
          logs: logger.entries,
        },
        { depth: 20 }
      );
      expect(allSurfaces).not.toContain(RAW_STDIN_ERROR_SENTINEL);
      expect(allSurfaces).not.toContain("NativePipeError");
      expect(allSurfaces).not.toContain("privateDetail");
      expect(allSurfaces).not.toContain("EACCES");
    } finally {
      await manager.dispose();
    }
  });
});
