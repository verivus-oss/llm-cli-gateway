import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// s6: the ordering invariant that makes cross-writer completion safe, driven
// through a real handler rather than the unit. `flight.start()` is AWAITED, so
// the start row is down before `execute` dispatches, hence before the sync
// deadline can arm the async manager to write a completion of its own. Without
// that await the manager's status-guarded write can reach a row that does not
// exist yet and match nothing, which is how a response body disappears.
//
// The gate here is a promise the test opens, never a timer.

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import {
  handleGeminiRequest,
  type GeminiRequestParams,
  type GatewayServerRuntime,
  type HandlerDeps,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import type { FlightRecorderLike } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";

const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

function persistenceNone(): PersistenceConfig {
  return {
    backend: "none",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: false,
    sources: { configFile: null, envOverrides: [] },
  };
}

/** Every write is observable and every read is empty: this is a sink, not a store. */
function recorderStub(overrides: Partial<Record<string, unknown>>): FlightRecorderLike {
  return {
    logStart: () => {},
    logComplete: () => {},
    recordCompressionTelemetry: () => {},
    recordRouting: () => {},
    readCacheRowsBySession: () => [],
    readCacheRowsByPrefix: () => [],
    readCacheRowsGlobal: () => [],
    readRequestById: () => null,
    listRequestSummaries: () => [],
    readLcrPriorRows: () => [],
    readRoutingDecisions: () => [],
    flush: () => {},
    close: () => {},
    ...overrides,
  } as unknown as FlightRecorderLike;
}

function drainMicrotasks(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

/** Bounded event-loop turns, so pending file I/O completes. Not a delay. */
async function settleEventLoop(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i += 1) await drainMicrotasks();
}

function baseParams(overrides: Partial<GeminiRequestParams> = {}): GeminiRequestParams {
  return {
    prompt: "order the two flight phases",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    createNewSession: false,
    resumeLatest: false,
    ...overrides,
  } as unknown as GeminiRequestParams;
}

describe("flight write ordering through a handler (s6)", () => {
  let tmp: string;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "s6-flight-order-"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
  });

  afterEach(async () => {
    await manager.dispose();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function deps(recorder: FlightRecorderLike, logger = noopLogger): HandlerDeps {
    const runtime = {
      sessionManager: sessions,
      asyncJobManager: manager,
      approvalManager: { decide: () => ({ status: "approved" }) },
      flightRecorder: recorder,
      logger,
      performanceMetrics: { recordRequest: vi.fn() },
      persistence: persistenceNone(),
      compression: { enabled: false, sources: { configFile: null } },
      cacheAwareness: {
        emitAnthropicCacheControl: false,
        anthropicTtlSeconds: 300,
        warnOnTtlExpiry: false,
        minStableTokensForCacheControl: { sonnet: 0, opus: 0, haiku: 0, default: 0 },
        sources: { configFile: null },
      },
      workspaces: {
        enabled: false,
        defaultAlias: null,
        allowUnregisteredWorkingDir: false,
        repos: [],
        allowedRoots: [],
        sources: { configFile: null },
      },
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
    return { runtime, sessionManager: sessions, logger };
  }

  it("does not complete the flight while logStart is still pending", async () => {
    const calls: string[] = [];
    let releaseStart!: () => void;
    const startGate = new Promise<void>(resolve => {
      releaseStart = () => resolve();
    });
    let announceStartCalled!: () => void;
    const startCalled = new Promise<void>(resolve => {
      announceStartCalled = () => resolve();
    });
    let executeDispatched = false;
    executeCliMock.mockImplementation(async () => {
      executeDispatched = true;
      return { stdout: "answer", stderr: "", code: 0 };
    });

    const recorder = recorderStub({
      logStart: () => {
        calls.push("start");
        announceStartCalled();
        return startGate;
      },
      logComplete: () => {
        calls.push("complete");
      },
    });

    const pending = runWithRequestContext(LOCAL, () =>
      handleGeminiRequest(deps(recorder), baseParams({ correlationId: "order-1" }))
    );

    await startCalled;
    await settleEventLoop();
    // The load-bearing pair. `execute` has not dispatched, so the sync deadline
    // cannot have armed the manager, so no other writer can be completing this
    // flight while its start row is still open.
    expect(executeDispatched).toBe(false);
    expect(calls).toEqual(["start"]);

    releaseStart();
    const response = await pending;
    expect(response.isError).toBeFalsy();
    expect(calls).toEqual(["start", "complete"]);
  });

  it("logs and survives a rejecting logStart rather than failing the request", async () => {
    const errors: unknown[][] = [];
    const logger = {
      ...noopLogger,
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    } as unknown as typeof noopLogger;
    executeCliMock.mockResolvedValue({ stdout: "answer", stderr: "", code: 0 });

    const recorder = recorderStub({
      logStart: () => Promise.reject(new Error("recorder unavailable")),
    });

    const response = await runWithRequestContext(LOCAL, () =>
      handleGeminiRequest(deps(recorder, logger), baseParams({ correlationId: "reject-1" }))
    );

    // Design 3.4's chosen start-failure policy: swallow and log. The catch only
    // fires because the await sits INSIDE the try; moved outside it, the call
    // stops throwing and starts rejecting and this assertion goes to zero.
    expect(response.isError).toBeFalsy();
    expect(errors.map(entry => entry[0])).toContain("Flight recorder logStart failed");
  });
});
