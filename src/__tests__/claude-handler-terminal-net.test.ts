import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T0.5 characterization net: pins the observable terminal behavior of the
// extracted handleClaudeRequest(deps, params) so later envelope stages (T1..T4)
// refactor against a fixed contract. This file drives the handler DIRECTLY (not
// via the tool registration) so it can assert the internal flight-ownership call
// sequence, which is the core Mode A/B/C invariant from spec sections 3 and 8.
//
// Increment 1 (this commit): the three INLINE non-kit terminals (success 10c,
// failure code!=0 10b, exception 11) are Mode A: the handler writes BOTH flight
// ends inline (logStart + logComplete once each) and never arms the manager for
// deferral. Deferred (Mode B), the worktree latch, the Kit variants, and the
// H-DoubleComplete pin land in follow-up increments of the same net.

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import {
  handleClaudeRequest,
  type ClaudeRequestParams,
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

const PROVIDER_SESSION_ID = "019ec070-26ab-7fa3-b66b-72fc6964f250";
const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

function claudeResult(subtype: "success" | "error", isError: boolean): string {
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: PROVIDER_SESSION_ID,
      model: "sonnet",
    }),
    JSON.stringify({
      type: "result",
      subtype,
      is_error: isError,
      result: isError ? "partial output" : "all good",
      session_id: PROVIDER_SESSION_ID,
      stop_reason: isError ? "error" : "end_turn",
    }),
  ].join("\n");
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

function workspaceRegistry(root: string): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "test-workspace",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "test-workspace",
        path: root,
        providers: ["claude"],
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

function baseParams(overrides: Partial<ClaudeRequestParams> = {}): ClaudeRequestParams {
  return {
    prompt: "characterize a terminal path",
    outputFormat: "json",
    continueSession: false,
    createNewSession: false,
    dangerouslySkipPermissions: false,
    approvalStrategy: "legacy",
    mcpServers: [],
    strictMcpConfig: false,
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    ...overrides,
  };
}

describe("handleClaudeRequest terminal net: inline non-kit (Mode A)", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-terminal-net-"));
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
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
      performanceMetrics: { recordRequest() {} },
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

  function deps(value: GatewayServerRuntime): HandlerDeps {
    return { runtime: value, sessionManager: sessions, logger: noopLogger };
  }

  it("inline success (10c): logStart + logComplete once each, manager never armed", async () => {
    executeCliMock.mockResolvedValue({
      stdout: claudeResult("success", false),
      stderr: "",
      code: 0,
    });
    const rt = runtime();
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(rt), baseParams({ correlationId: "inline-success" }))
    );

    expect(result.isError).toBeFalsy();
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
    // Mode A completion is a terminal success status, not a deferral.
    expect(logComplete.mock.calls[0]?.[0]).toBe("inline-success");
  });

  it("inline failure code!=0 (10b): logStart + logComplete once each, manager never armed", async () => {
    executeCliMock.mockResolvedValue({
      stdout: claudeResult("error", true),
      stderr: "provider failed",
      code: 1,
    });
    const rt = runtime();
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(rt), baseParams({ correlationId: "inline-failure" }))
    );

    expect(result.isError).toBe(true);
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
  });

  it("exception (11): still writes exactly one inline logComplete, manager never armed", async () => {
    executeCliMock.mockRejectedValue(new Error("spawn blew up"));
    const rt = runtime();
    const logStart = vi.spyOn(flight, "logStart");
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(manager, "armFlightCompleteForDeferral");

    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(rt), baseParams({ correlationId: "inline-exception" }))
    );

    expect(result.isError).toBe(true);
    expect(logStart).toHaveBeenCalledTimes(1);
    expect(logComplete).toHaveBeenCalledTimes(1);
    expect(arm).not.toHaveBeenCalled();
  });
});

// Increment 2: the DEFERRED terminal (10a) is Mode B. When the sync deadline is
// exceeded, the handler arms the manager to own flight completion and returns a
// deferral WITHOUT writing logComplete itself. Deferral is forced
// deterministically by holding the single process slot so the claude job stays
// queued past the (shortened) deadline, exactly as sync-deferred-queued.test.ts
// does. Needs SYNC_DEADLINE_MS + vi.resetModules() + a dynamic index import
// because the deadline is captured at module load.
describe("handleClaudeRequest terminal net: deferred (Mode B)", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "claude-terminal-net-defer-"));
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

  it("deferred (10a): arms the manager and does NOT inline-complete the flight recorder", async () => {
    const { handleClaudeRequest: handleClaudeRequestDyn, resolveGatewayServerRuntime } =
      await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    // Hold the only process slot so the claude job queues and cannot run before
    // the 25ms deadline, guaranteeing the deferral (Mode B) branch.
    const slot = await manager.acquireProcessSlot("claude");
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
        handleClaudeRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "deferred-modeb" })
        )
      );

      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("claude");
      expect(arm).toHaveBeenCalledTimes(1);
      expect(logStart).toHaveBeenCalledTimes(1);
      // Mode B: the manager owns completion; the handler must not inline-complete.
      expect(logComplete).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });
});
