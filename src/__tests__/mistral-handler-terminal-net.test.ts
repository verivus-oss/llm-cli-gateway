import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T5d characterization net: pins handleMistralRequest after routing through
// runKitTerminalEnvelope (kit=null). mistral has claude's in-try topology (the
// inline worktree-resolve ok:false seam, applyEffectiveWorkingDirectory, the invoked
// log). It uses the D4 usageUpdateSessionId split and env.logger = deps.logger
// (mistral already logs all three terminal lines, so there is NO D5 delta). The
// load-bearing mistral-specific pin is the model-selection RETRY loop, folded into
// the execute hook: a first dispatch that fails with a stale-model error triggers a
// single rearm + retry with a recovery model, and the driver still sees one terminal
// result. The ACP transport branch stays outside the envelope and is unchanged.

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
  handleMistralRequest,
  type MistralRequestParams,
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
        providers: ["mistral"],
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

function baseParams(overrides: Partial<MistralRequestParams> = {}): MistralRequestParams {
  return {
    prompt: "characterize a mistral terminal path",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    createNewSession: false,
    resumeLatest: false,
    ...overrides,
  } as unknown as MistralRequestParams;
}

function structuredCli(result: { structuredContent?: { cli?: string } }): string | undefined {
  return result.structuredContent?.cli;
}

describe("handleMistralRequest terminal net: inline (Mode A) + seam + retry", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  const assertUpstreamCliArgsMock = vi.mocked(assertUpstreamCliArgs);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "mistral-terminal-net-"));
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
    return { runtime: rt, sessionManager: sessions, logger: noopLogger };
  }

  it("inline success (10c): logStart + logComplete once, manager never armed, one success metric", async () => {
    executeCliMock.mockResolvedValue({ stdout: "all good", stderr: "", code: 0 });
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ correlationId: "mi-ok" }))
    );

    expect(result.isError).toBeFalsy();
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), true]);
  });

  it("inline failure code!=0 (10b): logStart + logComplete once, one non-success metric", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "mistral failed", code: 1 });
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ correlationId: "mi-fail" }))
    );

    expect(result.isError).toBe(true);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), false]);
  });

  it("exception (11): one inline logComplete, id mistral, one non-success metric", async () => {
    executeCliMock.mockRejectedValue(new Error("mistral spawn blew up"));
    const logComplete = vi.spyOn(flight, "logComplete");
    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ correlationId: "mi-throw" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("mistral");
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), false]);
  });

  it("worktree-resolve failure (ok:false seam): id mistral_request, catch NOT taken, one metric", async () => {
    const logComplete = vi.spyOn(flight, "logComplete");
    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ workspace: "missing", correlationId: "mi-wt" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("mistral_request");
    expect(logComplete).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), false]);
  });

  it("argv/assert failure (throw to envelope catch): id mistral, one metric", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ correlationId: "mi-argv" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("mistral");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), false]);
  });

  it("model-selection retry (folded into execute): first dispatch fails stale-model, rearm + retry succeeds", async () => {
    // First dispatch returns a stale-model failure (isMistralModelSelectionFailure
    // matches "model '...' not found"); the execute hook selects a recovery model,
    // rearms the worktree lifecycle, and dispatches once more, which succeeds. The
    // driver sees a single inline success result.
    executeCliMock
      .mockResolvedValueOnce({ stdout: "", stderr: "active model 'stale-x' not found", code: 1 })
      .mockResolvedValue({ stdout: "recovered output", stderr: "", code: 0 });
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ correlationId: "mi-retry" }))
    );

    expect(result.isError).toBeFalsy();
    // The CLI was invoked twice: the first (stale-model) dispatch and the retry.
    expect(executeCliMock).toHaveBeenCalledTimes(2);
    // Exactly one terminal completion + one metric (the retry reuses corrId).
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), true]);
  });

  it("model-selection retry then non-recoverable failure: two dispatches, driver failure branch", async () => {
    // First dispatch fails stale-model => rearm + retry; the retry fails with a
    // non-stale error, so it falls through to the driver's failure branch (one
    // terminal completion, one non-success metric) after invoking the CLI twice.
    executeCliMock
      .mockResolvedValueOnce({ stdout: "", stderr: "active model 'stale-x' not found", code: 1 })
      .mockResolvedValue({ stdout: "", stderr: "the retry also failed", code: 1 });
    const logComplete = vi.spyOn(flight, "logComplete");

    const result = await runWithRequestContext(LOCAL, () =>
      handleMistralRequest(deps(), baseParams({ correlationId: "mi-retry-fail" }))
    );

    expect(result.isError).toBe(true);
    expect(executeCliMock).toHaveBeenCalledTimes(2);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["mistral", expect.any(Number), false]);
  });
});

describe("handleMistralRequest terminal net: deferred (Mode B) + D4 split", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "mistral-terminal-net-defer-"));
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
    const { handleMistralRequest: handleMistralRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("mistral");
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
        handleMistralRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ createNewSession: true, correlationId: "mi-deferred" })
        )
      );
      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("mistral");
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
    const { handleMistralRequest: handleMistralRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("mistral");
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
        handleMistralRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "mi-mint" })
        )
      );
      const mintedBody = JSON.parse(minted.content[0]!.text);
      expect(mintedBody.status).toBe("deferred");
      expect(mintedBody.sessionId).toMatch(/^gw-/);
      expect(updateUsage).not.toHaveBeenCalled();
      manager.cancelJob(mintedBody.jobId);

      // User-provided: usage update fires for the provided id.
      const providedId = "22222222-2222-4222-8222-222222222222";
      const provided = await runWithRequestContext(LOCAL, () =>
        handleMistralRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ sessionId: providedId, correlationId: "mi-user" })
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

  // NOTE: the retry-then-defer COMBINATION (first dispatch completes inline with a
  // stale-model failure, the execute hook rearms, and the SECOND dispatch defers) is
  // the one route into the driver's deferred branch from a rearmed worktree lifecycle,
  // but it is unreachable in either harness by construction. The inline harness
  // (describe 1) forces the sync-inline branch (executeCli mock, no deferral). The
  // async harness (describe 2) forces the async-manager branch, which runs the REAL
  // executor for its jobs (the executeCli mock is NOT on that path, which is why the
  // deferred tests hold the process slot rather than mock a result), so a controlled
  // stale-model failure cannot be injected on the first dispatch. The branch decision
  // (SYNC_DEADLINE_MS + deferralAvailable) is constant across both dispatches of one
  // invocation, so a single handler call cannot be inline for the first dispatch and
  // async for the retry. Both CONSTITUENTS are pinned independently: the driver's
  // deferred branch by "deferred (10a)" + "D4 split" above, and the retry rearm +
  // second dispatch by the two "model-selection retry" tests in describe 1. The fold
  // that routes BOTH deferred sites through the driver's single deferred branch is
  // verified byte-for-byte against base 046378e by the T5d cross-LLM review.

  // NOTE: mistral's H-DoubleComplete is UNREACHABLE (defensive/symmetric fence, like
  // grok/devin/codex): a worktree request without a provider-native sessionId fails
  // closed at rejectUnreachableGatewayWorktree, and a request with a tracked-remote
  // sessionId admits a session, so the deferred settle always transfer()s rather than
  // calling finishHandler(). Both deferred sites (first dispatch and the retry) route
  // through the driver's single deferred branch, which installs the fence.
});
