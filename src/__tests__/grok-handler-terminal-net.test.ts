import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T5b characterization net: pins handleGrokRequest after routing through
// runKitTerminalEnvelope (kit=null). Mirrors gemini-handler-terminal-net and adds
// the grok-specific D4 usageUpdateSessionId split pin (a gateway-minted session
// gets the minted id in the deferred response but NO durable usage update). grok's
// H-DoubleComplete is documented UNREACHABLE (defensive/symmetric fence, like
// codex T3): the deferred Mode-B test pins that the handler does not inline-
// complete on a deferral, and the note in the second describe explains why the
// double-complete edge cannot be driven for grok. The ACP transport branch stays
// outside the envelope and is unchanged.

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
  handleGrokRequest,
  type GrokRequestParams,
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
import { removeWorktree } from "../worktree-manager.js";
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

function workspaceRegistry(
  root: string,
  allowWorktree: boolean
): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "wt",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "wt",
        path: root,
        providers: ["grok"],
        allowWorktree,
        allowAddDir: false,
        kind: allowWorktree ? "git" : "folder",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function seedRepo(root: string): void {
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: root, stdio: "ignore" });
}

function baseParams(overrides: Partial<GrokRequestParams> = {}): GrokRequestParams {
  return {
    prompt: "characterize a grok terminal path",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    createNewSession: false,
    resumeLatest: false,
    alwaysApprove: false,
    ...overrides,
  } as unknown as GrokRequestParams;
}

function structuredCli(result: { structuredContent?: { cli?: string } }): string | undefined {
  return result.structuredContent?.cli;
}

describe("handleGrokRequest terminal net: inline (Mode A) + state-4..8 boundary", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  const assertUpstreamCliArgsMock = vi.mocked(assertUpstreamCliArgs);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "grok-terminal-net-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    recordRequest = vi.fn();
    assertUpstreamCliArgsMock.mockClear();
  });

  afterEach(async () => {
    await manager.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runtime(allowWorktree = false): GatewayServerRuntime {
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
      workspaces: workspaceRegistry(tmp, allowWorktree),
      personalConfig: { settings: { enabled: false } },
      providers: { xai: null, providers: {}, sources: { configFile: null } },
    } as unknown as GatewayServerRuntime;
  }

  function deps(allowWorktree = false): HandlerDeps {
    const rt = runtime(allowWorktree);
    return { runtime: rt, sessionManager: sessions, logger: noopLogger };
  }

  it("inline success (10c): logStart + logComplete once, manager never armed, one success metric", async () => {
    executeCliMock.mockResolvedValue({ stdout: "all good", stderr: "", code: 0 });
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps(), baseParams({ correlationId: "gk-ok" }))
    );

    expect(result.isError).toBeFalsy();
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["grok", expect.any(Number), true]);
  });

  it("inline failure code!=0 (10b): logStart + logComplete once, manager never armed, one non-success metric", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "grok failed", code: 1 });
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps(), baseParams({ correlationId: "gk-fail" }))
    );

    expect(result.isError).toBe(true);
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["grok", expect.any(Number), false]);
  });

  it("exception (11): one inline logComplete, manager never armed, id grok, one non-success metric", async () => {
    executeCliMock.mockRejectedValue(new Error("grok spawn blew up"));
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps(), baseParams({ correlationId: "gk-throw" }))
    );

    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("grok");
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["grok", expect.any(Number), false]);
  });

  it("worktree-resolve failure (ok:false seam): id grok_request, catch NOT taken, one metric", async () => {
    // An unregistered workspace makes the (in-envelope) worktree resolve throw,
    // which grok's runInsideTerminalTry inline-catch turns into the ok:false
    // earlyResponse. (A worktree:true request would instead fail closed at
    // rejectUnreachableGatewayWorktree BEFORE the envelope, recording no metric,
    // so it is not the seam path.)
    const logComplete = vi.spyOn(flight, "logComplete");
    const result = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps(false), baseParams({ workspace: "missing", correlationId: "gk-wt" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("grok_request");
    expect(logComplete).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["grok", expect.any(Number), false]);
  });

  it("argv/assert failure (throw to envelope catch): id grok, one metric", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleGrokRequest(deps(), baseParams({ correlationId: "gk-argv" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("grok");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["grok", expect.any(Number), false]);
  });
});

describe("handleGrokRequest terminal net: deferred (Mode B) + D4 split + H-DoubleComplete fence", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;
  const removeSpy = vi.mocked(removeWorktree);

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "grok-terminal-net-defer-"));
    seedRepo(tmp);
    flight = new FlightRecorder(join(tmp, "logs.db"));
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    removeSpy.mockClear();
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
    const { handleGrokRequest: handleGrokRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("grok");
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceMemory(),
        workspaces: workspaceRegistry(tmp, false),
      },
      { isolateState: true }
    );
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    try {
      const result = await runWithRequestContext(LOCAL, () =>
        handleGrokRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ createNewSession: true, correlationId: "gk-deferred" })
        )
      );

      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("grok");
      expect(logStart).toHaveBeenCalledTimes(1);
      expect(arm).toHaveBeenCalledTimes(1);
      expect(logComplete).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  it("D4 split: a deferral on a gateway-minted session returns the minted id but does NOT update usage", async () => {
    const { handleGrokRequest: handleGrokRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("grok");
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceMemory(),
        workspaces: workspaceRegistry(tmp, false),
      },
      { isolateState: true }
    );
    const updateUsage = vi.spyOn(sessions, "updateSessionUsage");

    try {
      // Fresh, non-createNewSession => grok mints a gw-* effectiveSessionId AND
      // admits it, so the deferred response carries the minted id while the usage
      // update is skipped (usageUpdateSessionId = undefined for a minted session).
      const result = await runWithRequestContext(LOCAL, () =>
        handleGrokRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "gk-mint" })
        )
      );

      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      // The deferred response carries the minted gateway session id...
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId).toMatch(/^gw-/);
      // ...but no durable usage update fired for that minted session (the D4
      // usageUpdateSessionId split: userProvidedSession is false => undefined).
      expect(updateUsage).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  // NOTE: grok's H-DoubleComplete is UNREACHABLE (defensive/symmetric fence,
  // like codex T3). Reaching the deferred-branch finishHandler() requires the
  // deferred settle to NOT transfer, i.e. no sessionAdmission. But grok fails
  // closed at rejectUnreachableGatewayWorktree for any worktree request without a
  // provider-native sessionId, and a request WITH a (tracked-remote) sessionId
  // admits a session, so the deferred settle always transfers() rather than
  // calling finishHandler(). The FlightOwnership fence is still installed (the
  // deferred Mode-B test above pins that the handler does not inline-complete on
  // a deferral); it simply cannot be driven to the double-complete edge for grok.
});
