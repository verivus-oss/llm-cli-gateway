import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// Keep createWorktree real (so a genuine request-owned worktree is produced) but
// wrap removeWorktree in a spy that calls through, so the worktree-latch increment
// can observe transfer (no removal) vs finishHandler/abort (removal) without
// leaking worktree directories.
vi.mock("../worktree-manager.js", async () => {
  const actual =
    await vi.importActual<typeof import("../worktree-manager.js")>("../worktree-manager.js");
  return { ...actual, removeWorktree: vi.fn(actual.removeWorktree) };
});

import {
  handleClaudeRequest,
  resolveGatewayServerRuntime,
  type ClaudeRequestParams,
  type GatewayServerRuntime,
  type HandlerDeps,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { PersistenceConfig, type JobLimitsConfig } from "../config.js";
import { FlightRecorder } from "../flight-recorder.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  PersonalConfigManager,
  type KitPathLayout,
  type ResolvedKitContext,
} from "../personal-config.js";
import type { KitExecutionRef } from "../personal-config-types.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import { removeWorktree } from "../worktree-manager.js";

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

// Increment 3: the worktree latch. When a request owns a git worktree, the
// terminal outcome is one of transfer / finishHandler / abort. Its only external
// signal is whether removeWorktree fires (the lifecycle latch state is
// closure-private, index.ts:2183-2185), so this block uses a REAL git repo +
// real createWorktree and observes the (call-through) removeWorktree spy:
//  - no session  + success  -> finishHandler -> worktree removed
//  - session     + success  -> transfer      -> worktree NOT removed (session owns it)
//  - no session  + failure  -> abort         -> worktree removed
function seedRepo(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: root, stdio: "ignore" });
}

function worktreeRegistry(root: string): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "wt",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "wt",
        path: root,
        providers: ["claude"],
        allowWorktree: true,
        allowAddDir: false,
        kind: "git",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

describe("handleClaudeRequest terminal net: worktree latch", () => {
  let tmp: string;
  let flight: FlightRecorder;
  let manager: AsyncJobManager;
  let sessions: FileSessionManager;
  const removeSpy = vi.mocked(removeWorktree);

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "claude-terminal-net-wt-"));
    seedRepo(tmp);
    flight = new FlightRecorder(join(tmp, "logs.db"));
    manager = new AsyncJobManager(noopLogger);
    sessions = new FileSessionManager(join(tmp, "sessions.json"));
    executeCliMock.mockReset();
    removeSpy.mockClear();
  });

  afterEach(async () => {
    await manager.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function runtime(): GatewayServerRuntime {
    return resolveGatewayServerRuntime(
      {
        asyncJobManager: manager,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceNone(),
        workspaces: worktreeRegistry(tmp),
      },
      { isolateState: true }
    );
  }

  function deps(value: GatewayServerRuntime): HandlerDeps {
    return { runtime: value, sessionManager: sessions, logger: noopLogger };
  }

  it("no session + success (finishHandler): removes the request-owned worktree", async () => {
    executeCliMock.mockResolvedValue({
      stdout: claudeResult("success", false),
      stderr: "",
      code: 0,
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(runtime()), baseParams({ workspace: "wt", worktree: true }))
    );

    expect(result.isError).toBeFalsy();
    expect(sessions.listSessions().length).toBe(0);
    expect(removeSpy).toHaveBeenCalled();
  });

  it("session admission + success (transfer): keeps the worktree, binds it to the session", async () => {
    executeCliMock.mockResolvedValue({
      stdout: claudeResult("success", false),
      stderr: "",
      code: 0,
    });
    // A concrete sessionId drives real session admission (plannedEffectiveSessionId
    // = sessionId at index.ts:9654); createNewSession alone mints no id, so no
    // admission and thus no transfer.
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(
        deps(runtime()),
        baseParams({
          workspace: "wt",
          worktree: true,
          sessionId: "11111111-1111-4111-8111-111111111111",
        })
      )
    );

    expect(result.isError).toBeFalsy();
    const listed = sessions.listSessions();
    expect(listed.length).toBe(1);
    expect(listed[0]?.metadata?.worktreePath).toBeDefined();
    // Transfer disowns the request half; the session now owns removal.
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it("no session + failure code!=0 (abort): removes the request-owned worktree", async () => {
    executeCliMock.mockResolvedValue({
      stdout: claudeResult("error", true),
      stderr: "provider failed",
      code: 1,
    });
    const result = await runWithRequestContext(LOCAL, () =>
      handleClaudeRequest(deps(runtime()), baseParams({ workspace: "wt", worktree: true }))
    );

    expect(result.isError).toBe(true);
    expect(sessions.listSessions().length).toBe(0);
    expect(removeSpy).toHaveBeenCalled();
  });
});

// Increment 4: the Kit variants. A Kit request withholds provider output from
// durable history and its terminal handling is Kit-gated. Kit finalize/discard
// are module-private, so this block observes them through their injectable
// effects: the flight recorder's Kit-withheld completion text and the session
// manager's releaseKitSessionAttempt (which discardPendingPersonalKitSession
// calls, index.ts). Kit needs durable (SQLite) job admission.
function kitLayout(root: string): KitPathLayout {
  const runtimeDir = join(root, "runtime");
  return {
    baselineDir: join(root, "baseline"),
    runtimeDir,
    localTomlPath: join(runtimeDir, "local.toml"),
    statePath: join(runtimeDir, "personal-config-state.json"),
    releasesDir: join(runtimeDir, "personal-config", "releases"),
    currentPointerPath: join(runtimeDir, "personal-config", "current.json"),
    lockPath: join(runtimeDir, "personal-config", "lock"),
    artifactsDir: join(runtimeDir, "personal-config", "artifacts"),
  };
}

function kitPersistence(path: string): PersistenceConfig {
  return {
    backend: "sqlite",
    path,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function kitRegistry(root: string): GatewayServerRuntime["workspaces"] {
  return {
    enabled: true,
    defaultAlias: "kit-target",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "kit-target",
        path: root,
        providers: ["claude", "codex"],
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

function kitContext(root: string): ResolvedKitContext {
  const execution: KitExecutionRef = {
    version: 1,
    releaseId: "a".repeat(40),
    configStamp: "b".repeat(64),
    scopeRoot: root,
    scopeHead: "c".repeat(40),
    contextIdentity: "d".repeat(64),
  };
  return {
    release: {
      id: execution.releaseId,
      root,
      manifest: {
        version: 1,
        releaseId: execution.releaseId,
        baselineCommit: execution.releaseId,
        createdAt: new Date().toISOString(),
        verified: true,
        treeDigest: "e".repeat(64),
      },
    },
    scope: {
      cwd: root,
      scopeRoot: root,
      registeredWorkspaceAlias: "kit-target",
      repoHead: execution.scopeHead,
      overlayPath: null,
    },
    text: "Private Kit context which must never reach durable history.",
    contextDigest: "f".repeat(64),
    configStamp: execution.configStamp,
    execution,
    preferences: {},
    provenance: [],
  };
}

// The Kit terminal reachable without simulating a child process is the DEFERRED
// one: holding the process slot keeps the kit job queued (it never spawns), so
// this pins the Kit-gated terminal ledger without a spawnCliProcess fake. On
// defer the kit path is Mode B (arms the manager, no inline logComplete) AND
// hands the claimed kit session off to the job rather than discarding it
// (kitJobHandedOff): releaseKitSessionAttempt must NOT fire. The genuine Kit
// inline success/failure execution paths (and their durable-history withholding)
// are covered by personal-config-flight-recorder-privacy.test.ts, which already
// stands up a full kit run; re-deriving them here would need a child-process
// simulation for no added ledger coverage.
describe("handleClaudeRequest terminal net: Kit deferred (Mode B, kitJobHandedOff)", () => {
  let originalDeadline: string | undefined;
  let root: string;
  let flight: FlightRecorder;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;
  let sessions: FileSessionManager;

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    root = mkdtempSync(join(tmpdir(), "claude-terminal-net-kit-"));
    flight = new FlightRecorder(join(root, "logs.db"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store, undefined, saturationLimits());
    sessions = new FileSessionManager(join(root, "sessions.json"));
    executeCliMock.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    await jobs.dispose();
    store.close();
    flight.close();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("kit deferred (10a): arms the manager, no inline complete, hands off (does not discard) the kit session", async () => {
    const {
      handleClaudeRequest: handleClaudeRequestDyn,
      resolveGatewayServerRuntime: resolveRuntimeDyn,
    } = await import("../index.js");
    // Hold the only process slot so the kit job queues past the 25ms deadline.
    const slot = await jobs.acquireProcessSlot("claude");
    const personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      kitLayout(root)
    );
    vi.spyOn(personalConfig, "buildContext").mockReturnValue(kitContext(root));
    vi.spyOn(personalConfig, "assertExecutionCurrent").mockImplementation(() => {});
    const runtime = resolveRuntimeDyn(
      {
        asyncJobManager: jobs,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: kitPersistence(join(root, "jobs.db")),
        personalConfig,
        workspaces: kitRegistry(root),
      },
      { isolateState: true }
    );
    const logComplete = vi.spyOn(flight, "logComplete");
    const arm = vi.spyOn(jobs, "armFlightCompleteForDeferral");
    const release = vi.spyOn(sessions, "releaseKitSessionAttempt");

    try {
      const result = await runWithRequestContext(LOCAL, () =>
        handleClaudeRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ workspace: "kit-target", correlationId: "kit-deferred" })
        )
      );

      const body = JSON.parse(result.content[0]!.text);
      expect(body.status).toBe("deferred");
      expect(arm).toHaveBeenCalledTimes(1);
      // Mode B: manager owns completion; the handler must not inline-complete.
      expect(logComplete).not.toHaveBeenCalled();
      // kitJobHandedOff: the claimed kit session attempt is handed to the job,
      // not discarded, so the pending attempt survives for the async terminal.
      expect(release).not.toHaveBeenCalled();
      jobs.cancelJob(body.jobId);
    } finally {
      slot.release();
    }
  });
});

// Increment 5: the H-DoubleComplete pre-existing hazard (spec section 4),
// reproduced deterministically. An earlier version of this test skipped the
// hazard on the (wrong) belief that the worktree `terminal` latch could not be
// set in-handler on a deferred path; the cross-LLM review gate (Codex + Grok)
// rejected that and supplied the lever, which this test now uses.
//
// Lever: a job that TERMINALIZES DURING awaitJobOrDefer's poll sleep. With
// SYNC_DEADLINE_MS=25 << SYNC_POLL_INTERVAL_MS=1000 (index.ts:1447) the loop
// checks the snapshot once (job still queued -> in progress), sleeps 1000ms, and
// on waking exits on the expired deadline WITHOUT re-checking the snapshot
// (index.ts:1685-1719). Cancelling the queued job mid-sleep sets a terminal
// status and fires onComplete -> worktreeLifecycle.onTerminal, so `terminal` is
// true while handlerFinished is still false (no cleanup runs yet). The loop then
// arms the manager (index.ts:1719) and returns deferred; the deferred branch's
// `await finishHandler()` (index.ts:10017) now reaches removeWorktree, which we
// make reject. The rejection lands in the catch (index.ts:10218): the guard is
// skipped (kitJobHandedOff is true) but the unconditional
// safePersonalKitFlightComplete (index.ts:10233) STILL runs, so the handler
// inline-completes the flight recorder AFTER arming the manager to own it -- the
// double owner. This pins the CURRENT behavior so T3 (FlightOwnership) flips it
// visibly. Do NOT "fix" it here.
describe("handleClaudeRequest terminal net: H-DoubleComplete (pre-fence pin)", () => {
  let originalDeadline: string | undefined;
  let tmp: string;
  let flight: FlightRecorder;
  let jobs: AsyncJobManager;
  const removeSpy = vi.mocked(removeWorktree);

  beforeEach(() => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "25";
    tmp = mkdtempSync(join(tmpdir(), "claude-terminal-net-hdc-"));
    seedRepo(tmp);
    flight = new FlightRecorder(join(tmp, "logs.db"));
    jobs = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      saturationLimits()
    );
    executeCliMock.mockReset();
    removeSpy.mockReset();
    vi.resetModules();
  });

  afterEach(async () => {
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    await jobs.dispose();
    flight.close();
    rmSync(tmp, { recursive: true, force: true });
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("deferred race (cancel during poll-sleep) + finishHandler() rejects: the handler STILL inline-completes after arming (double owner)", async () => {
    const {
      handleClaudeRequest: handleClaudeRequestDyn,
      resolveGatewayServerRuntime: resolveRuntimeDyn,
    } = await import("../index.js");
    // The worktree gate is `sessionManager instanceof FileSessionManager`, so use
    // the dynamically re-imported class the fresh index module sees; a statically
    // imported instance fails the check.
    const { FileSessionManager: FileSessionManagerDyn } = await import("../session-manager.js");
    const sessions = new FileSessionManagerDyn(join(tmp, "sessions.json"));
    // The post-handoff worktree cleanup rejects.
    removeSpy.mockRejectedValue(new Error("worktree removal failed"));
    // Hold the only slot so the job queues (in progress at the first poll check).
    const slot = await jobs.acquireProcessSlot("claude");
    const runtime = resolveRuntimeDyn(
      {
        asyncJobManager: jobs,
        sessionManager: sessions,
        logger: noopLogger,
        flightRecorder: flight,
        persistence: persistenceMemory(),
        workspaces: worktreeRegistry(tmp),
      },
      { isolateState: true }
    );
    const arm = vi.spyOn(jobs, "armFlightCompleteForDeferral");
    const logComplete = vi.spyOn(flight, "logComplete");
    // Capture the queued job id the instant it is created. startJobWithDedup is
    // synchronous and the first poll check runs before the handler yields to the
    // 1000ms sleep, so by the time this resolves the handler is already sleeping.
    const realStart = jobs.startJobWithDedup.bind(jobs);
    let jobId: string | undefined;
    vi.spyOn(jobs, "startJobWithDedup").mockImplementation(
      (...args: Parameters<typeof realStart>) => {
        const out = realStart(...args);
        jobId = out.snapshot.id;
        return out;
      }
    );

    try {
      const pending = runWithRequestContext(LOCAL, () =>
        handleClaudeRequestDyn(
          { runtime, sessionManager: sessions, logger: noopLogger },
          baseParams({ workspace: "wt", worktree: true, correlationId: "hdc" })
        )
      );
      // Cancel the queued job mid-sleep so it terminalizes (fires onTerminal ->
      // sets the worktree terminal latch) before the loop wakes and arms.
      await vi.waitFor(() => expect(jobId).toBeDefined());
      jobs.cancelJob(jobId!);

      // The deferred-branch finishHandler() (index.ts:10017) rejects; the catch
      // inline-completes (index.ts:10233), then the unconditional finally
      // (index.ts:10250) re-runs finishHandler(), re-awaits the cached rejected
      // cleanup, and re-throws, so the handler ultimately REJECTS. Pin that.
      await expect(pending).rejects.toThrow(/worktree removal failed/);

      // The manager was armed to own completion for the deferral...
      expect(arm).toHaveBeenCalledTimes(1);
      // ...the terminal latch let the deferred-branch finishHandler reach the
      // (rejecting) worktree removal...
      expect(removeSpy).toHaveBeenCalled();
      // ...and the catch STILL wrote an inline completion despite the manager
      // being armed. This is the pre-existing double owner (H-DoubleComplete).
      expect(logComplete).toHaveBeenCalled();
    } finally {
      slot.release();
    }
  });
});
