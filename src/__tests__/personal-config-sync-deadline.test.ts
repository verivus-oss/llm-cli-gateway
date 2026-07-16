import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AsyncJobSnapshot, LlmCli } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import type { KitPathLayout, ResolvedKitContext } from "../personal-config.js";
import type { KitExecutionRef } from "../personal-config-types.js";
import type { GatewayRequestContext } from "../request-context.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: { errorCategory?: string; retryable?: boolean };
  }>;
  inputSchema: { parse: (value: unknown) => Record<string, unknown> };
}

let createGatewayServer: typeof import("../index.js").createGatewayServer;
let runWithRequestContext: typeof import("../request-context.js").runWithRequestContext;
let AsyncJobManager: typeof import("../async-job-manager.js").AsyncJobManager;
let SqliteJobStore: typeof import("../job-store.js").SqliteJobStore;
let PersonalConfigManager: typeof import("../personal-config.js").PersonalConfigManager;
let FileSessionManager: typeof import("../session-manager.js").FileSessionManager;
let noopLogger: typeof import("../logger.js").noopLogger;

function persistence(path: string): PersistenceConfig {
  return {
    backend: "sqlite",
    path,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    instanceHeartbeatMs: 15_000,
    instanceLeaseTtlMs: 90_000,
    httpJobGraceMs: 300_000,
    orphanSweepIntervalMs: 30_000,
    instanceGcMs: 3_600_000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function layout(root: string): KitPathLayout {
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

function localContext(): GatewayRequestContext {
  return { transport: "stdio", authKind: "disabled", authScopes: [] };
}

function workspaceRegistry(root: string): WorkspaceRegistry {
  return {
    enabled: true,
    defaultAlias: null,
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

function context(root: string): ResolvedKitContext {
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
      registeredWorkspaceAlias: null,
      repoHead: execution.scopeHead,
      overlayPath: null,
    },
    text: "Kit context used only by the test fixture",
    contextDigest: "f".repeat(64),
    configStamp: execution.configStamp,
    execution,
    preferences: {},
    provenance: [],
  };
}

describe("Personal Agent Config Kit sync deadline", () => {
  let originalDeadline: string | undefined;
  let root: string;
  let store: InstanceType<typeof import("../job-store.js").SqliteJobStore>;
  let jobs: InstanceType<typeof import("../async-job-manager.js").AsyncJobManager>;
  let saturatedStore: InstanceType<typeof import("../job-store.js").SqliteJobStore> | null = null;
  let saturatedJobs: InstanceType<typeof import("../async-job-manager.js").AsyncJobManager> | null =
    null;

  beforeEach(async () => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "0";
    vi.resetModules();
    ({ createGatewayServer } = await import("../index.js"));
    ({ runWithRequestContext } = await import("../request-context.js"));
    ({ AsyncJobManager } = await import("../async-job-manager.js"));
    ({ SqliteJobStore } = await import("../job-store.js"));
    ({ PersonalConfigManager } = await import("../personal-config.js"));
    ({ FileSessionManager } = await import("../session-manager.js"));
    ({ noopLogger } = await import("../logger.js"));
    root = mkdtempSync(join(tmpdir(), "kit-sync-deadline-"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await saturatedJobs?.dispose();
    saturatedStore?.close();
    await jobs.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    vi.resetModules();
  });

  it("keeps explicit async Kit requests durable while synchronous Kit calls fail closed before resolution", async () => {
    const sessions = new FileSessionManager(join(root, "sessions.json"));
    const personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      layout(root)
    );
    const resolved = context(root);
    const buildContext = vi.spyOn(personalConfig, "buildContext").mockReturnValue(resolved);
    const assertExecutionCurrent = vi
      .spyOn(personalConfig, "assertExecutionCurrent")
      .mockImplementation(() => {});
    const server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: jobs,
      persistence: persistence(join(root, "jobs.db")),
      personalConfig,
      workspaces: workspaceRegistry(root),
    });
    const registry = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const asyncRequest = registry.claude_request_async;
    const syncRequest = registry.claude_request;
    const codexSyncRequest = registry.codex_request;
    if (!asyncRequest || !syncRequest || !codexSyncRequest) {
      throw new Error("expected Claude and Codex request tools");
    }

    const startJob = vi
      .spyOn(jobs, "startJob")
      .mockImplementation(
        (
          cli,
          _args,
          correlationId,
          _cwd,
          _idleTimeoutMs,
          _outputFormat,
          _forceRefresh,
          _env,
          _onComplete,
          _flightRecorderEntry,
          _extractUsage,
          _writeFlightStart,
          _stdin,
          _compressResponse,
          kitExecution,
          _onTerminal,
          kitSessionId,
          jobId
        ) => {
          expect(kitExecution).toEqual(resolved.execution);
          expect(kitSessionId).toMatch(/^[0-9a-f-]{36}$/i);
          expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
          const startedAt = new Date().toISOString();
          return {
            id: jobId ?? randomUUID(),
            cli,
            status: "queued",
            startedAt,
            finishedAt: null,
            exitCode: null,
            correlationId,
            outputTruncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            error: null,
            exited: false,
          } satisfies AsyncJobSnapshot;
        }
      );

    const asyncResponse = await runWithRequestContext(localContext(), () =>
      asyncRequest.handler(
        asyncRequest.inputSchema.parse({
          prompt: "Run asynchronously.",
          workspace: "kit-target",
        }),
        {}
      )
    );
    expect(asyncResponse.isError).toBeUndefined();
    expect(startJob).toHaveBeenCalledOnce();

    const syncResponse = await runWithRequestContext(localContext(), () =>
      syncRequest.handler(
        syncRequest.inputSchema.parse({ prompt: "Run synchronously.", workspace: "kit-target" }),
        {}
      )
    );
    expect(syncResponse.isError).toBe(true);
    expect(syncResponse.content[0]?.text).toContain("kit_busy");

    // Codex's isolation preflight invokes the provider CLI. A zero sync
    // deadline must reject before resolving Kit context, which makes that
    // preflight unreachable as well as preventing a session lease claim.
    const codexSyncResponse = await runWithRequestContext(localContext(), () =>
      codexSyncRequest.handler(
        codexSyncRequest.inputSchema.parse({
          prompt: "Do not start a Codex preflight.",
          workingDir: root,
        }),
        {}
      )
    );
    expect(codexSyncResponse.isError).toBe(true);
    expect(codexSyncResponse.content[0]?.text).toContain("kit_busy");
    expect(startJob).toHaveBeenCalledOnce();
    expect(buildContext).toHaveBeenCalledOnce();
    expect(assertExecutionCurrent).toHaveBeenCalledTimes(2);
  });

  it("releases the exact Kit lease and keeps saturation retryable", async () => {
    saturatedStore = new SqliteJobStore(join(root, "saturated-jobs.db"));
    saturatedJobs = new AsyncJobManager(noopLogger, undefined, saturatedStore, undefined, {
      maxRunningJobs: 1,
      maxRunningJobsPerProvider: 1,
      maxQueuedJobs: 0,
      queueTimeoutMs: 1_000,
      completedJobMemoryTtlMs: 60_000,
      maxJobOutputBytes: 1_024 * 1_024,
    });
    const held = saturatedJobs.startJob("sleep" as LlmCli, ["5"], "hold-capacity");
    expect(saturatedJobs.getLimiterSnapshot().running).toBe(1);

    const sessions = new FileSessionManager(join(root, "saturated-sessions.json"));
    const personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      layout(root)
    );
    const resolved = context(root);
    vi.spyOn(personalConfig, "buildContext").mockReturnValue(resolved);
    vi.spyOn(personalConfig, "assertExecutionCurrent").mockImplementation(() => {});
    const release = vi.spyOn(sessions, "releaseKitSessionAttempt");
    const start = vi.spyOn(saturatedJobs, "startJob");
    const server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: saturatedJobs,
      persistence: persistence(join(root, "saturated-jobs.db")),
      personalConfig,
      workspaces: workspaceRegistry(root),
    });
    const registry = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const request = registry.claude_request_async;
    if (!request) throw new Error("expected async Claude request tool");

    const response = await runWithRequestContext(localContext(), () =>
      request.handler(
        request.inputSchema.parse({ prompt: "Saturate safely.", workspace: "kit-target" }),
        {}
      )
    );
    expect(response.isError).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(response.structuredContent?.errorCategory).toBe("saturated");
    expect(response.structuredContent?.retryable).toBe(true);
    expect(response.content[0]?.text).not.toContain(resolved.text);
    expect(release).toHaveBeenCalled();

    const released = release.mock.calls[release.mock.calls.length - 1];
    expect(released?.[0]).toBe("claude");
    expect(released?.[1]).toBe(resolved.execution.scopeRoot);
    expect(released?.[2]).toEqual(resolved.execution);
    const releasedSessionId = released?.[3];
    const releasedAttemptId = released?.[4];
    expect(releasedSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(releasedAttemptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(sessions.getSession(releasedSessionId!)?.metadata?.kit?.attempt).toBeUndefined();

    saturatedJobs.cancelJob(held.id);
  });
});
