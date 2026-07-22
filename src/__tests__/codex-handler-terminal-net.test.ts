import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Tier-B T3 (FlightOwnership) codex-sync sibling pin.
//
// handleCodexRequest is the second Kit-sibling handler wired to FlightOwnership
// in lockstep with handleClaudeRequest (T1/T2 wired both siblings the same way).
// This file pins the observable Mode B contract for codex-sync: on a sync
// deferral the handler arms the async manager to own the flight completion and
// does NOT write an inline completion itself.
//
// Reachability note (why there is no codex "finishHandler rejects" double-owner
// pin like claude's): a FRESH codex request ALWAYS admits a session
// (handleCodexRequest mints a gw- session id unconditionally), so on deferral its
// RequestTerminalLedger.settle TRANSFERS the request-owned worktree to that
// session rather than calling finishHandler()/removeWorktree. Every remaining
// post-arm step in the deferred branch is non-throwing (settle's transfer() is
// synchronous; safeUpdateSessionUsageAfterJobAdmission swallows its errors), so
// codex's catch is not reachable after a deferral and its inline-complete-in-catch
// cannot double-complete today. The FlightOwnership fence on codex is therefore
// defensive/symmetric with claude, whose no-session deferral CAN reach
// finishHandler and IS pinned as the reachable H-DoubleComplete fence in
// claude-handler-terminal-net.test.ts.
//
// Setup mirrors the claude deferred (Mode B) net: the deferral is forced
// deterministically by holding the single process slot so the codex job stays
// queued past the (shortened) deadline. Needs SYNC_DEADLINE_MS +
// vi.resetModules() + a dynamic index import because the deadline is captured at
// module load.

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import { AsyncJobManager } from "../async-job-manager.js";
import { PersistenceConfig, type JobLimitsConfig } from "../config.js";
import { FlightRecorder } from "../flight-recorder.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import type { CodexRequestParams, GatewayServerRuntime } from "../index.js";

const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

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
    defaultAlias: "test-workspace",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "test-workspace",
        path: root,
        providers: ["codex"],
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

function baseParams(overrides: Partial<CodexRequestParams> = {}): CodexRequestParams {
  return {
    prompt: "characterize a codex terminal path",
    outputFormat: "text",
    fullAuto: false,
    dangerouslyBypassApprovalsAndSandbox: false,
    approvalStrategy: "legacy",
    createNewSession: false,
    optimizePrompt: false,
    optimizeResponse: false,
    forceRefresh: false,
    ...overrides,
  };
}

describe("handleCodexRequest terminal net: deferred (Mode B) FlightOwnership", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "codex-terminal-net-defer-"));
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
    const { handleCodexRequest, resolveGatewayServerRuntime } = await import("../index.js");
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    // Hold the only process slot so the codex job queues and cannot run before
    // the 25ms deadline, guaranteeing the deferral (Mode B) branch.
    const slot = await manager.acquireProcessSlot("codex");
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
        handleCodexRequest(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ correlationId: "codex-deferred-modeb" })
        )
      );

      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(body.cli).toBe("codex");
      // The handler wrote logStart itself (Mode A/B handler-start)...
      expect(logStart).toHaveBeenCalledTimes(1);
      // ...and on the deadline handed completion to the manager...
      expect(arm).toHaveBeenCalledTimes(1);
      // ...so it must NOT inline-complete: flight.completeInline() is a no-op once
      // transferCompletionToManager() flips ownership. The manager is the sole
      // completer for the deferral (T3 FlightOwnership).
      expect(logComplete).not.toHaveBeenCalled();
      manager.cancelJob(body.jobId);
    } finally {
      slot.release();
      await manager.dispose();
    }
  });
});
