import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../approval-manager.js";
import { AsyncJobManager, type AsyncJobSnapshot } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import type { CodexKitIsolationPlan } from "../codex-kit-isolation.js";
import { createGatewayServer } from "../index.js";
import { SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  PersonalConfigManager,
  type KitPathLayout,
  type ResolvedKitContext,
} from "../personal-config.js";
import type { KitExecutionRef } from "../personal-config-types.js";
import { runWithRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

vi.mock("../codex-kit-isolation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../codex-kit-isolation.js")>();
  return {
    ...actual,
    assertCodexKitIsolationPlan: vi.fn(),
    createCodexKitIsolationPlan: vi.fn(
      async (
        cwd: string,
        options: {
          contextPrefix: string;
          sandboxMode: "read-only" | "workspace-write";
          outputFormat: "text" | "json";
        }
      ) => {
        const projection = actual.createCodexKitIsolationProjection(cwd, options);
        return Object.freeze({
          cwd: projection.cwd,
          projectRoot: projection.projectRoot,
          args: projection.args,
          env: {},
          skillPaths: [],
          contextPrefixDigest: projection.contextPrefixDigest,
          sandboxMode: projection.sandboxMode,
          outputFormat: projection.outputFormat,
        }) satisfies CodexKitIsolationPlan;
      }
    ),
  };
});

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

function workspaceRegistry(root: string): WorkspaceRegistry {
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
      registeredWorkspaceAlias: "kit-target",
      repoHead: execution.scopeHead,
      overlayPath: null,
    },
    text: "Private Codex Kit context used by the pre-admission regression.",
    contextDigest: "f".repeat(64),
    configStamp: execution.configStamp,
    execution,
    preferences: {},
    provenance: [],
  };
}

describe("Codex Kit argv pre-admission", () => {
  let root: string;
  let sessions: FileSessionManager;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;
  let tools: Record<string, RegisteredTool>;
  let createIsolationPlan: ReturnType<typeof vi.fn>;
  let getOrCreateKitSession: ReturnType<typeof vi.spyOn>;
  let createKitSession: ReturnType<typeof vi.spyOn>;
  let claimKitSessionAttempt: ReturnType<typeof vi.spyOn>;
  let updateSessionMetadata: ReturnType<typeof vi.spyOn>;
  let startJob: ReturnType<typeof vi.spyOn>;
  let startJobWithDedup: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "codex-kit-preadmission-"));
    sessions = new FileSessionManager(join(root, "sessions.json"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
    const personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      layout(root)
    );
    vi.spyOn(personalConfig, "buildContext").mockReturnValue(context(root));
    vi.spyOn(personalConfig, "assertExecutionCurrent").mockImplementation(() => {});
    getOrCreateKitSession = vi.spyOn(sessions, "getOrCreateKitSession");
    createKitSession = vi.spyOn(sessions, "createKitSession");
    claimKitSessionAttempt = vi.spyOn(sessions, "claimKitSessionAttempt");
    updateSessionMetadata = vi.spyOn(sessions, "updateSessionMetadata");
    startJob = vi.spyOn(jobs, "startJob");
    startJobWithDedup = vi.spyOn(jobs, "startJobWithDedup");
    const isolation = await import("../codex-kit-isolation.js");
    createIsolationPlan = vi.mocked(isolation.createCodexKitIsolationPlan);
    createIsolationPlan.mockClear();

    const server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: jobs,
      persistence: persistence(join(root, "jobs.db")),
      personalConfig,
      workspaces: workspaceRegistry(root),
      approvalManager: new ApprovalManager(join(root, "approvals.jsonl"), noopLogger),
      flightRecorder: { logStart() {}, logComplete() {} },
      logger: noopLogger,
    });
    tools = (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await jobs.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function expectRejectedBeforeSideEffects(
    name: "codex_request" | "codex_request_async",
    model: string,
    errorCategory: "input_too_large" | "invalid_input"
  ): Promise<void> {
    const tool = tools[name];
    if (!tool) throw new Error(`${name} was not registered`);

    const response = await runWithRequestContext(
      { transport: "stdio", authKind: "disabled", authScopes: [] },
      () =>
        tool.handler(
          tool.inputSchema.parse({
            prompt: "Do not probe or mutate state.",
            model,
            createNewSession: false,
          }),
          {}
        )
    );

    expect(response).toMatchObject({
      isError: true,
      structuredContent: { errorCategory, retryable: false },
    });
    expect(createIsolationPlan).not.toHaveBeenCalled();
    expect(getOrCreateKitSession).not.toHaveBeenCalled();
    expect(createKitSession).not.toHaveBeenCalled();
    expect(claimKitSessionAttempt).not.toHaveBeenCalled();
    expect(updateSessionMetadata).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
    expect(startJobWithDedup).not.toHaveBeenCalled();
    expect(sessions.listSessions()).toEqual([]);
  }

  it.each(["codex_request", "codex_request_async"] as const)(
    "rejects an oversized effective model before %s probes or mutates state",
    async name => {
      await expectRejectedBeforeSideEffects(name, "m".repeat(132_000), "input_too_large");
    }
  );

  it.each(["codex_request", "codex_request_async"] as const)(
    "rejects a NUL-bearing effective model before %s probes or mutates state",
    async name => {
      await expectRejectedBeforeSideEffects(name, "gpt-5\0injected", "invalid_input");
    }
  );

  it("keeps a valid async Kit request on the verified probe, session, and job path", async () => {
    const startedAt = new Date().toISOString();
    startJob.mockResolvedValue({
      id: "11111111-1111-4111-8111-111111111111",
      cli: "codex",
      status: "queued",
      startedAt,
      finishedAt: null,
      exitCode: null,
      correlationId: "valid-codex-kit-async",
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
      exited: false,
    } satisfies AsyncJobSnapshot);
    const tool = tools.codex_request_async!;

    const response = await runWithRequestContext(
      { transport: "stdio", authKind: "disabled", authScopes: [] },
      () =>
        tool.handler(
          tool.inputSchema.parse({
            prompt: "Run the valid Kit request.",
            model: "gpt-5.4",
            correlationId: "valid-codex-kit-async",
            createNewSession: true,
          }),
          {}
        )
    );

    expect(response.isError).toBeUndefined();
    expect(createIsolationPlan).toHaveBeenCalledOnce();
    expect(createKitSession).toHaveBeenCalledOnce();
    expect(startJob).toHaveBeenCalledOnce();
  });

  it("keeps a valid sync Kit request on the verified probe, session, and job path", async () => {
    startJobWithDedup.mockImplementation(() => {
      throw new Error("valid sync flow reached durable admission");
    });
    const tool = tools.codex_request!;

    const response = await runWithRequestContext(
      { transport: "stdio", authKind: "disabled", authScopes: [] },
      () =>
        tool.handler(
          tool.inputSchema.parse({
            prompt: "Run the valid Kit request.",
            model: "gpt-5.4",
            correlationId: "valid-codex-kit-sync",
            createNewSession: true,
          }),
          {}
        )
    );

    expect(response.isError).toBe(true);
    expect(createIsolationPlan).toHaveBeenCalledOnce();
    expect(createKitSession).toHaveBeenCalledOnce();
    expect(startJobWithDedup).toHaveBeenCalledOnce();
  });
});
