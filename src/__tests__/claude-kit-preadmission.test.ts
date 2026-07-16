import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../approval-manager.js";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
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
    text: "Private Kit context which must not be materialized for rejected argv.",
    contextDigest: "f".repeat(64),
    configStamp: execution.configStamp,
    execution,
    preferences: {},
    provenance: [],
  };
}

describe("Claude Kit argv pre-admission", () => {
  let root: string;
  let paths: KitPathLayout;
  let sessions: FileSessionManager;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;
  let tools: Record<string, RegisteredTool>;
  let startJob: ReturnType<typeof vi.spyOn>;
  let getOrCreateKitSession: ReturnType<typeof vi.spyOn>;
  let createKitSession: ReturnType<typeof vi.spyOn>;
  let claimKitSessionAttempt: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "claude-kit-preadmission-"));
    paths = layout(root);
    sessions = new FileSessionManager(join(root, "sessions.json"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
    const personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      paths
    );
    vi.spyOn(personalConfig, "buildContext").mockReturnValue(context(root));
    vi.spyOn(personalConfig, "assertExecutionCurrent").mockImplementation(() => {});
    startJob = vi.spyOn(jobs, "startJob");
    getOrCreateKitSession = vi.spyOn(sessions, "getOrCreateKitSession");
    createKitSession = vi.spyOn(sessions, "createKitSession");
    claimKitSessionAttempt = vi.spyOn(sessions, "claimKitSessionAttempt");
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

  async function expectRejectedWithoutKitState(
    name: "claude_request" | "claude_request_async",
    input: Record<string, unknown>
  ): Promise<void> {
    const tool = tools[name];
    if (!tool) throw new Error(`${name} was not registered`);

    const response = await runWithRequestContext(
      { transport: "stdio", authKind: "disabled", authScopes: [] },
      () => tool.handler(tool.inputSchema.parse(input), {})
    );

    expect(response).toMatchObject({
      isError: true,
      structuredContent: {
        errorCategory: "input_too_large",
        retryable: false,
      },
    });
    expect(response.content[0]?.text).toContain("provider CLI argv transport");
    expect(existsSync(paths.artifactsDir) ? readdirSync(paths.artifactsDir) : []).toEqual([]);
    expect(sessions.listSessions()).toEqual([]);
    expect(getOrCreateKitSession).not.toHaveBeenCalled();
    expect(createKitSession).not.toHaveBeenCalled();
    expect(claimKitSessionAttempt).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
  }

  it.each(["claude_request", "claude_request_async"] as const)(
    "rejects a schema-valid multibyte prompt before %s creates Kit state",
    async name => {
      await expectRejectedWithoutKitState(name, {
        prompt: "🧪".repeat(40_000),
        createNewSession: true,
      });
    }
  );

  it.each(["claude_request", "claude_request_async"] as const)(
    "rejects the complete projected %s aggregate before Kit state",
    async name => {
      vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
      await expectRejectedWithoutKitState(name, {
        prompt: "p".repeat(60_000),
        model: "m".repeat(40_000),
        sessionId: "s".repeat(40_000),
      });
    }
  );

  it("cleans the sync context artifact and releases its Kit attempt when session read fails", async () => {
    const releaseAttempt = vi.spyOn(sessions, "releaseKitSessionAttempt");
    const getSession = vi.spyOn(sessions, "getSession").mockImplementation(() => {
      throw new Error("session read failed after Kit materialization");
    });
    const tool = tools.claude_request;
    if (!tool) throw new Error("claude_request was not registered");

    const response = await runWithRequestContext(
      { transport: "stdio", authKind: "disabled", authScopes: [] },
      () =>
        tool.handler(
          tool.inputSchema.parse({
            prompt: "Exercise the post-materialization session read.",
            outputFormat: "text",
            createNewSession: true,
          }),
          {}
        )
    );

    expect(response.isError).toBe(true);
    expect(createKitSession).toHaveBeenCalledOnce();
    expect(releaseAttempt).toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
    expect(existsSync(paths.artifactsDir) ? readdirSync(paths.artifactsDir) : []).toEqual([]);
    getSession.mockRestore();
    expect(sessions.listSessions("claude")[0]?.metadata?.kit).not.toHaveProperty("attempt");
  });
});
