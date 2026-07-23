import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T5c characterization net: pins handleDevinRequest after routing through
// runKitTerminalEnvelope (kit=null). devin has claude's in-try topology but, unlike
// gemini/grok, NO inline worktree-resolve catch (a resolve failure reaches the
// envelope catch, id "devin", not an ok:false seam) and NO applyEffectiveWorkingDirectory
// / invoked log. It uses the D4 usageUpdateSessionId split and decorates its deferred
// response with the approval decision. D5 pin: the driver's three terminal log lines
// (failed/completed/threw, via deps.logger) are NEW for devin (which logged none),
// asserted here as an intended, documented, stderr-only observability addition. The
// ACP transport branch stays outside the envelope and is unchanged.

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

vi.mock("../worktree-manager.js", async () => {
  const actual =
    await vi.importActual<typeof import("../worktree-manager.js")>("../worktree-manager.js");
  return { ...actual, removeWorktree: vi.fn(actual.removeWorktree) };
});

vi.mock("../upstream-contracts.js", async () => {
  const actual = await vi.importActual<typeof import("../upstream-contracts.js")>(
    "../upstream-contracts.js"
  );
  return { ...actual, assertUpstreamCliArgs: vi.fn(actual.assertUpstreamCliArgs) };
});

import {
  handleDevinRequest,
  type DevinRequestParams,
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
        providers: ["devin"],
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

function baseParams(overrides: Partial<DevinRequestParams> = {}): DevinRequestParams {
  return {
    prompt: "characterize a devin terminal path",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    createNewSession: false,
    resumeLatest: false,
    ...overrides,
  } as unknown as DevinRequestParams;
}

function structuredCli(result: { structuredContent?: { cli?: string } }): string | undefined {
  return result.structuredContent?.cli;
}

describe("handleDevinRequest terminal net: inline (Mode A) + envelope catch + D5 logs", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  let depsLogger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
  const assertUpstreamCliArgsMock = vi.mocked(assertUpstreamCliArgs);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "devin-terminal-net-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    recordRequest = vi.fn();
    depsLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
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

  // devin logs the three terminal lines via deps.logger (the driver's env.logger =
  // deps.logger). Pass a spy-able deps.logger to observe the D5 addition.
  function deps(): HandlerDeps {
    const rt = runtime();
    return { runtime: rt, sessionManager: sessions, logger: depsLogger } as unknown as HandlerDeps;
  }

  it("inline success (10c): metric once (success), one flight completion, D5 completed log fires", async () => {
    executeCliMock.mockResolvedValue({ stdout: "all good", stderr: "", code: 0 });
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleDevinRequest(deps(), baseParams({ correlationId: "dv-ok" }))
    );

    expect(result.isError).toBeFalsy();
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["devin", expect.any(Number), true]);
    // D5: devin now emits the completed terminal log (via deps.logger).
    expect(depsLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/devin_request completed successfully/)
    );
  });

  it("inline failure code!=0 (10b): metric once (not success), one flight completion, D5 failed log fires", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "devin failed", code: 1 });
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleDevinRequest(deps(), baseParams({ correlationId: "dv-fail" }))
    );

    expect(result.isError).toBe(true);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["devin", expect.any(Number), false]);
    expect(depsLogger.info).toHaveBeenCalledWith(expect.stringMatching(/devin_request failed/));
  });

  it("exception (11): id devin, one inline flight completion, metric once, D5 threw log fires", async () => {
    executeCliMock.mockRejectedValue(new Error("devin spawn blew up"));
    const logComplete = vi.spyOn(flight, "logComplete");
    const result = await runWithRequestContext(LOCAL, () =>
      handleDevinRequest(deps(), baseParams({ correlationId: "dv-throw" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("devin");
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["devin", expect.any(Number), false]);
    expect(depsLogger.info).toHaveBeenCalledWith(
      expect.stringMatching(/devin_request threw exception/)
    );
  });

  it("worktree-resolve failure (no inline seam): reaches the envelope catch, id devin, one metric", async () => {
    // devin has NO inline resolve catch, so an unregistered-workspace resolve
    // failure throws into the envelope catch (id "devin"), not an ok:false seam.
    const result = await runWithRequestContext(LOCAL, () =>
      handleDevinRequest(deps(), baseParams({ workspace: "missing", correlationId: "dv-wt" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("devin");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["devin", expect.any(Number), false]);
  });

  it("argv/assert failure (throw to envelope catch): id devin, one metric", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleDevinRequest(deps(), baseParams({ correlationId: "dv-argv" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("devin");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["devin", expect.any(Number), false]);
  });
});

describe("handleDevinRequest terminal net: deferred (Mode B) + D4 split + decorateDeferred", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "devin-terminal-net-defer-"));
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

  it("deferred (10a): arms the manager, does NOT inline-complete, and decorates with approval", async () => {
    const { handleDevinRequest: handleDevinRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("devin");
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
        handleDevinRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ createNewSession: true, correlationId: "dv-deferred" })
        )
      );
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("devin");
      expect(logStart).toHaveBeenCalledTimes(1);
      expect(arm).toHaveBeenCalledTimes(1);
      expect(logComplete).not.toHaveBeenCalled();
      // decorateDeferred attaches the approval decision (envelope hook).
      expect("approval" in result).toBe(true);
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  it("D4 split: a deferral on a gateway-minted session returns the minted id but does NOT update usage", async () => {
    const { handleDevinRequest: handleDevinRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("devin");
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
      const result = await runWithRequestContext(LOCAL, () =>
        handleDevinRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "dv-mint" })
        )
      );
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId).toMatch(/^gw-/);
      expect(updateUsage).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  it("D4 split (user-provided): a deferral on a user-provided session DOES update usage for it", async () => {
    const { handleDevinRequest: handleDevinRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("devin");
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
    const providedId = "11111111-1111-4111-8111-111111111111";

    try {
      // A user-provided sessionId makes sessionResult.userProvidedSession true, so
      // the D4 split wires usageUpdateSessionId = effectiveSessionId: the durable
      // usage update MUST fire for that id (the direction the design's test plan
      // section 6 mandates and the requireTrackedRemoteSession admission arm).
      const result = await runWithRequestContext(LOCAL, () =>
        handleDevinRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ sessionId: providedId, correlationId: "dv-user" })
        )
      );
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.sessionId).toBe(providedId);
      expect(updateUsage).toHaveBeenCalledWith(providedId);
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  // NOTE: devin's H-DoubleComplete is UNREACHABLE (defensive/symmetric fence, like
  // grok/codex): a worktree request without a provider-native sessionId fails closed
  // at rejectUnreachableGatewayWorktree, and a request with a tracked-remote sessionId
  // admits a session, so the deferred settle always transfer()s rather than calling
  // finishHandler(). The fence is installed (the deferred Mode-B test pins no inline
  // complete on a deferral); it cannot be driven to the double-complete edge for devin.
});
