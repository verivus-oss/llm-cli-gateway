import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T5a characterization net: pins the observable terminal behaviour of
// handleGeminiRequest after it is routed through the shared runKitTerminalEnvelope
// driver (kit=null). gemini has claude's in-try topology; the net mirrors
// claude/codex-handler-terminal-net. The load-bearing NEW pin is the T3
// FlightOwnership fence for gemini's previously-unfenced H-DoubleComplete: on a
// deferral the manager owns completion and the handler does NOT inline-complete,
// even when a post-handoff finishHandler() rejects into the catch.

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
  handleGeminiRequest,
  type GeminiRequestParams,
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
        providers: ["gemini"],
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

function baseParams(overrides: Partial<GeminiRequestParams> = {}): GeminiRequestParams {
  return {
    prompt: "characterize a gemini terminal path",
    approvalStrategy: "legacy",
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    createNewSession: false,
    resumeLatest: false,
    ...overrides,
  } as unknown as GeminiRequestParams;
}

function structuredCli(result: { structuredContent?: { cli?: string } }): string | undefined {
  return result.structuredContent?.cli;
}

describe("handleGeminiRequest terminal net: inline (Mode A) + state-4..8 boundary", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  let recordRequest: ReturnType<typeof vi.fn>;
  const assertUpstreamCliArgsMock = vi.mocked(assertUpstreamCliArgs);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gemini-terminal-net-"));
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
      handleGeminiRequest(deps(), baseParams({ correlationId: "gm-ok" }))
    );

    expect(result.isError).toBeFalsy();
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["gemini", expect.any(Number), true]);
  });

  it("inline failure code!=0 (10b): logStart + logComplete once, manager never armed, one non-success metric", async () => {
    executeCliMock.mockResolvedValue({ stdout: "", stderr: "gemini failed", code: 1 });
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleGeminiRequest(deps(), baseParams({ correlationId: "gm-fail" }))
    );

    expect(result.isError).toBe(true);
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["gemini", expect.any(Number), false]);
  });

  it("exception (11): one inline logComplete, manager never armed, id gemini, one non-success metric", async () => {
    executeCliMock.mockRejectedValue(new Error("gemini spawn blew up"));
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleGeminiRequest(deps(), baseParams({ correlationId: "gm-throw" }))
    );

    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("gemini");
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["gemini", expect.any(Number), false]);
  });

  it("worktree-resolve failure (ok:false seam): id gemini_request, catch NOT taken, one metric", async () => {
    const logComplete = vi.spyOn(flight, "logComplete");
    const result = await runWithRequestContext(LOCAL, () =>
      handleGeminiRequest(
        deps(false),
        baseParams({ workspace: "wt", worktree: true, correlationId: "gm-wt" })
      )
    );
    expect(result.isError).toBe(true);
    // The inline resolve-#1 catch returns the ok:false earlyResponse: the front-half
    // operation id is preserved and the envelope catch is NOT taken (no flight
    // completion), while the finally still records exactly one metric.
    expect(structuredCli(result)).toBe("gemini_request");
    expect(logComplete).not.toHaveBeenCalled();
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["gemini", expect.any(Number), false]);
  });

  it("argv/assert failure (throw to envelope catch): id gemini, one metric", async () => {
    assertUpstreamCliArgsMock.mockImplementationOnce(() => {
      throw new Error("argv admission rejected");
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleGeminiRequest(deps(), baseParams({ correlationId: "gm-argv" }))
    );
    expect(result.isError).toBe(true);
    expect(structuredCli(result)).toBe("gemini");
    expect(recordRequest).toHaveBeenCalledTimes(1);
    expect(recordRequest.mock.calls[0]).toEqual(["gemini", expect.any(Number), false]);
  });
});

describe("handleGeminiRequest terminal net: deferred (Mode B) + H-DoubleComplete fence", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;
  const removeSpy = vi.mocked(removeWorktree);

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "gemini-terminal-net-defer-"));
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

  it("deferred (10a): arms the manager and does NOT inline-complete the flight recorder", async () => {
    const { handleGeminiRequest: handleGeminiRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    const slot = await manager.acquireProcessSlot("gemini");
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
        handleGeminiRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "gm-deferred" })
        )
      );

      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("gemini");
      expect(logStart).toHaveBeenCalledTimes(1);
      expect(arm).toHaveBeenCalledTimes(1);
      // The FlightOwnership fence: completeInline no-ops once the manager owns
      // completion, so the handler does NOT inline-complete on a deferral.
      expect(logComplete).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });

  it("deferred race (cancel during poll-sleep) + finishHandler() rejects: does NOT inline-complete after arming (T3 fence, newly applied to gemini)", async () => {
    const { handleGeminiRequest: handleGeminiRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const { FileSessionManager: FileSessionManagerDyn } = await import("../session-manager.js");
    const sessionsDyn = new FileSessionManagerDyn(join(tmp, "sessions.json"));
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    // The post-handoff worktree cleanup rejects.
    removeSpy.mockRejectedValue(new Error("worktree removal failed"));
    const slot = await manager.acquireProcessSlot("gemini");
    const runtime = resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessionsDyn,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceMemory(),
        workspaces: workspaceRegistry(tmp, true),
      },
      { isolateState: true }
    );
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");
    const logComplete = vi.spyOn(flight, "logComplete");
    const realStart = manager.startJobWithDedup.bind(manager);
    let jobId: string | undefined;
    vi.spyOn(manager, "startJobWithDedup").mockImplementation(
      (...args: Parameters<typeof realStart>) => {
        const out = realStart(...args);
        jobId = out.snapshot.id;
        return out;
      }
    );

    try {
      // Fresh gemini request (no sessionId) => no session admission => the deferred
      // settle calls finishHandler() (not transfer()), so a rejecting removeWorktree
      // reaches the catch. This is the reachable H-DoubleComplete for gemini.
      const pending = runWithRequestContext(LOCAL, () =>
        handleGeminiRequestDyn(
          { runtime, sessionManager: sessionsDyn, logger: noopLogger },
          baseParams({ workspace: "wt", worktree: true, correlationId: "gm-hdc" })
        )
      );
      await vi.waitFor(() => expect(jobId).toBeDefined());
      manager.cancelJob(jobId!);

      await expect(pending).rejects.toThrow(/worktree removal failed/);
      expect(arm).toHaveBeenCalledTimes(1);
      expect(removeSpy).toHaveBeenCalled();
      // The catch did NOT write an inline completion: transferCompletionToManager()
      // flipped ownership before settle. Pre-T5a gemini would have double-completed
      // here (unconditional safeFlightComplete in the catch).
      expect(logComplete).not.toHaveBeenCalled();
    } finally {
      slot.release();
      await manager.dispose();
    }
  });
});
