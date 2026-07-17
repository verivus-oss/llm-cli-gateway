import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import {
  CLI_INVALID_INPUT_CATEGORY,
  CliInvalidInputError,
  normalizeCliInputAdmissionError,
} from "../cli-input-limits.js";
import {
  cliBreakerState,
  executeCli,
  resetCliBreakersForTest,
  spawnCliProcess,
} from "../executor.js";
import { FlightRecorder } from "../flight-recorder.js";
import { createErrorResponse } from "../index.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import type { Logger } from "../logger.js";
import {
  activeNeutralExecutionWorkspaceCountForTest,
  cleanupNeutralExecutionWorkspaces,
} from "../neutral-workspace.js";
import { CircuitBreakerState } from "../retry.js";

const SENSITIVE_PREFIX = "nul-secret-prefix";
const SENSITIVE_SUFFIX = "nul-secret-suffix";
const SENSITIVE_NUL_VALUE = `${SENSITIVE_PREFIX}\0${SENSITIVE_SUFFIX}`;
const INVALID_ARGV_REDACTION_MARKER = "[invalid argv redacted]";

interface InspectedAsyncJob {
  args: string[];
  flightRecorderEntry?: unknown;
}

function inspectAsyncJob(manager: AsyncJobManager, jobId: string): InspectedAsyncJob | undefined {
  const jobs = (manager as unknown as { jobs: Map<string, InspectedAsyncJob> }).jobs;
  return jobs.get(jobId);
}

function expectNoSensitiveNativeError(value: unknown): void {
  const serialized = JSON.stringify(value);
  expect(serialized).not.toContain(SENSITIVE_PREFIX);
  expect(serialized).not.toContain(SENSITIVE_SUFFIX);
  expect(serialized).not.toContain("The argument 'args[0]'");
  expect(serialized).not.toContain("Received");
}

describe("embedded NUL CLI admission", () => {
  afterEach(() => {
    cleanupNeutralExecutionWorkspaces();
    resetCliBreakersForTest();
  });

  it("rejects an embedded NUL in command and argv at the shared pre-spawn chokepoint", () => {
    const before = activeNeutralExecutionWorkspaceCountForTest();

    for (const [command, args] of [
      [SENSITIVE_NUL_VALUE, []],
      ["provider", [SENSITIVE_NUL_VALUE]],
    ] as const) {
      try {
        spawnCliProcess(command, [...args], {
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
        throw new Error("expected embedded NUL admission to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(CliInvalidInputError);
        expect(error).toMatchObject({
          code: "ERR_INVALID_ARG_VALUE",
          errorCategory: CLI_INVALID_INPUT_CATEGORY,
          retryable: false,
        });
        expectNoSensitiveNativeError(error);
      }
    }

    expect(activeNeutralExecutionWorkspaceCountForTest()).toBe(before);
  });

  it("returns a typed, redacted direct result without exposing Node's native message", async () => {
    let rejection: Error | undefined;
    try {
      await executeCli("codex", ["exec", SENSITIVE_NUL_VALUE], { cwd: "/" });
    } catch (error) {
      rejection = error as Error;
    }

    expect(rejection).toBeInstanceOf(CliInvalidInputError);
    expect(cliBreakerState("codex")).toBe(CircuitBreakerState.CLOSED);
    const response = createErrorResponse("codex", 1, "", "corr-nul-direct", rejection);
    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
      },
    });
    expectNoSensitiveNativeError(response);

    const native = Object.assign(
      new TypeError(
        `The argument 'args[0]' must be a string without null bytes. Received '${SENSITIVE_NUL_VALUE}'`
      ),
      { code: "ERR_INVALID_ARG_VALUE" }
    );
    const normalized = normalizeCliInputAdmissionError(
      new Error("launch failed", { cause: native }),
      {
        provider: "codex",
        inputName: "argv",
      }
    );
    expect(normalized).toBeInstanceOf(CliInvalidInputError);
    expectNoSensitiveNativeError(normalized);
    const nativeResponse = createErrorResponse("codex", 1, "", "corr-nul-native", native);
    expect(nativeResponse.structuredContent).toMatchObject({
      errorCategory: CLI_INVALID_INPUT_CATEGORY,
      retryable: false,
    });
    expectNoSensitiveNativeError(nativeResponse);
  });

  it("persists only the safe async classification, message, and argv marker", async () => {
    const logEntries: Array<[string, unknown]> = [];
    const logger: Logger = {
      info: (message, meta) => logEntries.push([message, meta]),
      error: (message, meta) => logEntries.push([message, meta]),
      debug: (message, meta) => logEntries.push([message, meta]),
      warn: (message, meta) => logEntries.push([message, meta]),
    };
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(logger, undefined, store);

    try {
      const started = manager.startJob(
        "codex",
        ["exec", SENSITIVE_NUL_VALUE],
        "corr-nul-async",
        "/"
      );
      expect(started).toMatchObject({
        status: "failed",
        exitCode: 126,
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
        exited: true,
      });

      const result = manager.getJobResult(started.id);
      const durable = store.getById(started.id);
      expect(result).toMatchObject({
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
      });
      expect(durable).toMatchObject({
        status: "failed",
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
        argsJson: JSON.stringify([INVALID_ARGV_REDACTION_MARKER]),
      });
      expect(inspectAsyncJob(manager, started.id)?.args).toEqual([INVALID_ARGV_REDACTION_MARKER]);

      expectNoSensitiveNativeError({
        started,
        result,
        retainedJob: inspectAsyncJob(manager, started.id),
        durableError: durable?.error,
        durableStderr: durable?.stderr,
        logs: logEntries,
      });
    } finally {
      await manager.dispose();
    }
  });

  it("hydrates the safe async failure without recovering rejected argv content", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gateway-nul-admission-"));
    const dbPath = path.join(root, "jobs.db");
    const firstStore = new SqliteJobStore(dbPath);
    const firstManager = new AsyncJobManager(
      { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} },
      undefined,
      firstStore
    );
    let jobId = "";

    try {
      const started = firstManager.startJob(
        "codex",
        ["exec", SENSITIVE_NUL_VALUE],
        "corr-nul-hydration",
        "/"
      );
      jobId = started.id;
    } finally {
      await firstManager.dispose();
      firstStore.close();
    }

    const restartedStore = new SqliteJobStore(dbPath);
    const restartedManager = new AsyncJobManager(
      { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} },
      undefined,
      restartedStore
    );
    try {
      const durable = restartedStore.getById(jobId);
      const snapshot = restartedManager.getJobSnapshot(jobId);
      const result = restartedManager.getJobResult(jobId);
      expect(snapshot).toMatchObject({
        status: "failed",
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
      });
      expect(result).toMatchObject({
        status: "failed",
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
      });
      expect(durable?.argsJson).toBe(JSON.stringify([INVALID_ARGV_REDACTION_MARKER]));
      expect(inspectAsyncJob(restartedManager, jobId)?.args).toEqual([
        INVALID_ARGV_REDACTION_MARKER,
      ]);
      expectNoSensitiveNativeError({
        durable,
        snapshot,
        result,
        retainedJob: inspectAsyncJob(restartedManager, jobId),
      });
    } finally {
      await restartedManager.dispose();
      restartedStore.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("redacts an invalid vector from real SQLite job and flight-recorder rows", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "gateway-nul-flight-"));
    const store = new SqliteJobStore(path.join(root, "jobs.db"));
    const flight = new FlightRecorder(path.join(root, "logs.db"), { redactSecrets: false });
    const manager = new AsyncJobManager(
      { info: () => {}, error: () => {}, debug: () => {}, warn: () => {} },
      undefined,
      store,
      flight
    );

    try {
      const outcome = manager.startJobWithDedup(
        "codex",
        ["exec", SENSITIVE_NUL_VALUE],
        "corr-nul-flight",
        {
          cwd: "/",
          forceRefresh: true,
          writeFlightStart: true,
          payloadJson: JSON.stringify({ rejectedVector: SENSITIVE_NUL_VALUE }),
          flightRecorderEntry: {
            model: SENSITIVE_NUL_VALUE,
            prompt: SENSITIVE_NUL_VALUE,
            sessionId: SENSITIVE_NUL_VALUE,
            stablePrefixHash: SENSITIVE_NUL_VALUE,
            stablePrefixTokens: 42,
          },
        }
      );

      expect(outcome.snapshot).toMatchObject({
        status: "failed",
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
      });
      expect(inspectAsyncJob(manager, outcome.snapshot.id)?.args).toEqual([
        INVALID_ARGV_REDACTION_MARKER,
      ]);

      const durable = store.getById(outcome.snapshot.id);
      expect(durable).toMatchObject({
        argsJson: JSON.stringify([INVALID_ARGV_REDACTION_MARKER]),
        payloadJson: null,
        errorCategory: CLI_INVALID_INPUT_CATEGORY,
        retryable: false,
      });

      const rows = flight.queryRequests<{
        model: string;
        prompt: string;
        response: string | null;
        error_message: string | null;
        status: string;
      }>(
        `SELECT r.model, r.prompt, r.response,
                gm.error_message, gm.status
           FROM requests r
           JOIN gateway_metadata gm ON gm.request_id = r.id
          WHERE r.id = ?`,
        "corr-nul-flight"
      );
      expect(rows).toEqual([
        expect.objectContaining({
          model: "invalid-input",
          prompt: INVALID_ARGV_REDACTION_MARKER,
          status: "failed",
        }),
      ]);
      expectNoSensitiveNativeError({
        retainedJob: inspectAsyncJob(manager, outcome.snapshot.id),
        durable,
        flightRows: rows,
      });
    } finally {
      await manager.dispose();
      flight.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
