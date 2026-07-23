import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T5e characterization net: pins handleCursorRequest after routing through
// runKitTerminalEnvelope (kit=null). cursor is the MINIMAL non-Kit sibling: it
// installs NO request-owned worktree lifecycle, so the driver's settle / finally
// finishHandler / rollback worktree arg all degrade to no-ops. It uses the D4
// usageUpdateSessionId split and env.logger = deps.logger, and (like devin) it is a
// D5 slice: the driver adds the three terminal stderr log lines (failed / completed /
// threw) that the old inline cursor handler emitted NONE of. The ACP transport branch
// stays outside the envelope and is unchanged. cursor's H-DoubleComplete is inert
// (no worktree lifecycle => the deferred settle never calls finishHandler).

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

vi.mock("../upstream-contracts.js", async () => {
  const actual = await vi.importActual<typeof import("../upstream-contracts.js")>(
    "../upstream-contracts.js"
  );
  return { ...actual, assertUpstreamCliArgs: vi.fn(actual.assertUpstreamCliArgs) };
});

import {
  handleCursorRequest,
  type CursorRequestParams,
  type GatewayServerRuntime,
  type HandlerDeps,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { PersistenceConfig, type JobLimitsConfig } from "../config.js";
import { FlightRecorder } from "../flight-recorder.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import { assertUpstreamCliArgs } from "../upstream-contracts.js";

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

function persistenceMemory(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function saturationLimits(): JobLimitsConfig {
  return {
    maxRunningJobs: 1,
    maxRunningJobsPerProvider: 1,
    maxQueuedJobs: 5,
    queueTimeoutMs: 10_000,
    completedJobMemoryTtlMs: 60 * 60 * 1000,
    maxJobOutputBytes: 50 * 1024 * 1024,
  };
}

function workspaceRegistry(root: string): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "wt",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "wt",
        path: root,
        providers: ["cursor"],
        allowWorktree: false,
        allowAddDir: false,
        kind: "folder",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function capturingLogger(): { info: ReturnType<typeof vi.fn> } & typeof noopLogger {
  return { ...noopLogger, info: vi.fn() } as unknown as {
    info: ReturnType<typeof vi.fn>;
  } & typeof noopLogger;
}

function loggedLines(logger: { info: ReturnType<typeof vi.fn> }): string[] {
  return logger.info.mock.calls.map(call => String(call[0]));
}

function baseParams(overrides: Partial<CursorRequestParams> = {}): CursorRequestParams {
  return {
    prompt: "characterize a cursor terminal path",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    createNewSession: false,
    resumeLatest: false,
    ...overrides,
  } as unknown as CursorRequestParams;
}

function structuredCli(result: { structuredContent?: { cli?: string } }): string | undefined {
  return result.structuredContent?.cli;
}

describe("handleCursorRequest terminal net: inline (Mode A) + seam + D5 logs", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  let logger: ReturnType<typeof capturingLogger>;
  const assertUpstreamCliArgsMock = vi.mocked(assertUpstreamCliArgs);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "cursor-terminal-net-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    recordRequest = vi.fn();
    logger = capturingLogger();
    assertUpstreamCliArgsMock.mockClear();
  });

  afterEach(async () => {
    await manager.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runtime(): GatewayServerRuntime {
    return {
      sessionManager: sessions,
      asyncJobManager: manager,
      approvalManager: { decide: () => ({ status: "approved" }) },
      flightRecorder: flight,
      logger: noopLogger,
      performanceMetrics: { recordRequest },
      persistence: persistenceNone(),
      compression: { enabled: false, sources: { configFile: null } },
      cacheAwareness: {
        emitAnthropicCacheControl: false,
        anthropicTtlSeconds: 300,
        warnOnTtlExpiry: false,
        minStableTokensForCacheControl: { sonnet: 0, opus: 0, haiku: 0, default: 0 },
        sources: { configFile: null },
      },
      workspaces: workspaceRegistry(tmp),
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
  }

  function deps(): HandlerDeps {
    const rt = runtime();
    return { runtime: rt, sessionManager: sessions, logger };
  }

  it("inline success (10c): logStart + logComplete once, never armed, one success metric, D5 completed line", async () => {
    executeCliMock.mockResolvedValue({ stdout: "all good", stderr: "", code: 0 });
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleCursorRequest(deps(), baseParams({ correlationId: "cu-ok" }))
    );

    expect(result.isError).toBeFalsy();
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["cursor", expect.any(Number), true]);
    // D5: the driver logs the terminal "completed successfully" line the inline
    // cursor handler never emitted.
    expect(loggedLines(logger).some(l => l.includes("cursor_request completed successfully"))).toBe(
      true
    );
  });

  it("inline failure code!=0 (10b): logComplete once, one non-success metric, D5 failed line", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "cursor failed", code: 1 });
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleCursorRequest(deps(), baseParams({ correlationId: "cu-fail" }))
    );

    expect(result.isError).toBe(true);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["cursor", expect.any(Number), false]);
    expect(loggedLines(logger).some(l => l.includes("cursor_request failed"))).toBe(true);
  });

  it("exception (11): one inline logComplete, id cursor, one non-success metric, D5 threw line", async () => {
    executeCliMock.mockRejectedValue(new Error("cursor spawn blew up"));
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleCursorRequest(deps(), baseParams({ correlationId: "cu-throw" }))
    );

    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("cursor");
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["cursor", expect.any(Number), false]);
    expect(loggedLines(logger).some(l => l.includes("cursor_request threw exception"))).toBe(true);
  });

  it("argv/assert failure (throw to envelope catch): id cursor, one metric", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });

    const result = await runWithRequestContext(LOCAL, () =>
      handleCursorRequest(deps(), baseParams({ correlationId: "cu-argv" }))
    );

    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("cursor");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["cursor", expect.any(Number), false]);
  });

  it("worktree-resolve failure (ok:false seam): id cursor_request, catch NOT taken, one metric", async () => {
    // A relative addDir with no working directory throws inside the in-envelope
    // resolveWorkspaceAndWorktreeForRequest, which cursor's runInsideTerminalTry
    // catches into { ok:false, earlyResponse: createErrorResponse("cursor_request") }.
    // The early return still flows through the driver finally (one metric) but never
    // reaches a flight completion.
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleCursorRequest(deps(), baseParams({ addDir: ["relative/sub"], correlationId: "cu-wt" }))
    );

    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("cursor_request");
    expect(logComplete).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["cursor", expect.any(Number), false]);
  });
});

describe("handleCursorRequest terminal net: deferred (Mode B) + D4 split", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "cursor-terminal-net-defer-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("deferred (10a) with createNewSession: arms the manager and does NOT inline-complete", async () => {
    const { handleCursorRequest: handleCursorRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("cursor");
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceMemory(),
        workspaces: workspaceRegistry(tmp),
      },
      { isolateState: true }
    );
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    try {
      const result = await runWithRequestContext(LOCAL, () =>
        handleCursorRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ createNewSession: true, correlationId: "cu-deferred" })
        )
      );
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("cursor");
      expect(logStart).toHaveBeenCalledTimes(1);
      expect(arm).toHaveBeenCalledTimes(1);
      expect(logComplete).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  it("D4 split: minted session => deferred id present but usage NOT updated; user-provided => usage updated", async () => {
    const { handleCursorRequest: handleCursorRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("cursor");
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceMemory(),
        workspaces: workspaceRegistry(tmp),
      },
      { isolateState: true }
    );
    const updateUsage = vi.spyOn(sessions, "updateSessionUsage");

    try {
      // Minted (no sessionId): deferred returns the minted gw-* id, usage skipped.
      const minted = await runWithRequestContext(LOCAL, () =>
        handleCursorRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "cu-mint" })
        )
      );
      const mintedBody = JSON.parse(minted.content[0]!.text);
      expect(mintedBody.status).toBe("deferred");
      expect(mintedBody.sessionId).toMatch(/^gw-/);
      expect(updateUsage).not.toHaveBeenCalled();
      manager.cancelJob(mintedBody.jobId);

      // User-provided: usage update fires for the provided id.
      const providedId = "33333333-3333-4333-8333-333333333333";
      const provided = await runWithRequestContext(LOCAL, () =>
        handleCursorRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ sessionId: providedId, correlationId: "cu-user" })
        )
      );
      const providedBody = JSON.parse(provided.content[0]!.text);
      expect(providedBody.status).toBe("deferred");
      expect(providedBody.sessionId).toBe(providedId);
      expect(updateUsage).toHaveBeenCalledWith(providedId);
      manager.cancelJob(providedBody.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  // NOTE: cursor's H-DoubleComplete is INERT. It installs no request-owned worktree
  // lifecycle, so the driver's deferred settle never calls finishHandler(); the only
  // post-arm step (safeUpdateSessionUsageAfterJobAdmission) swallows its errors, so
  // the envelope catch is unreachable after a deferral and there is no rejecting
  // finishHandler to double-complete. The fence (transfer-before-settle) is therefore
  // structurally inert for cursor, distinct from gemini's reachable edge.
});
