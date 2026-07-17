import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistenceConfig } from "../config.js";
import type { CodexKitIsolationPlan } from "../codex-kit-isolation.js";
import type { KitPathLayout, ResolvedKitContext } from "../personal-config.js";
import type { KitExecutionRef } from "../personal-config-types.js";
import type { GatewayRequestContext } from "../request-context.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

vi.mock("../codex-kit-isolation.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../codex-kit-isolation.js")>();
  return {
    ...actual,
    assertCodexKitIsolationPlan: vi.fn(),
    createCodexKitIsolationPlan: vi.fn(
      async (
        cwd: string,
        options: { sandboxMode: "read-only" | "workspace-write"; outputFormat: "text" | "json" }
      ) =>
        ({
          cwd,
          projectRoot: cwd,
          args: [],
          env: {},
          skillPaths: [],
          contextPrefixDigest: "0".repeat(64),
          sandboxMode: options.sandboxMode,
          outputFormat: options.outputFormat,
        }) satisfies CodexKitIsolationPlan
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
  }>;
  inputSchema: { parse: (value: unknown) => Record<string, unknown> };
}

let createGatewayServer: typeof import("../index.js").createGatewayServer;
let AsyncJobManager: typeof import("../async-job-manager.js").AsyncJobManager;
let FlightRecorder: typeof import("../flight-recorder.js").FlightRecorder;
let SqliteJobStore: typeof import("../job-store.js").SqliteJobStore;
let PersonalConfigManager: typeof import("../personal-config.js").PersonalConfigManager;
let runWithRequestContext: typeof import("../request-context.js").runWithRequestContext;
let FileSessionManager: typeof import("../session-manager.js").FileSessionManager;
let noopLogger: typeof import("../logger.js").noopLogger;
let createCodexKitIsolationPlan: typeof import("../codex-kit-isolation.js").createCodexKitIsolationPlan;

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

function requestContext(): GatewayRequestContext {
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

function resolvedContext(root: string, privateContext: string): ResolvedKitContext {
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
    text: privateContext,
    contextDigest: "f".repeat(64),
    configStamp: execution.configStamp,
    execution,
    preferences: {},
    provenance: [],
  };
}

describe("Personal Agent Config Kit sync Flight Recorder privacy", () => {
  let originalDeadline: string | undefined;
  let root: string;
  let store: InstanceType<typeof import("../job-store.js").SqliteJobStore>;
  let jobs: InstanceType<typeof import("../async-job-manager.js").AsyncJobManager>;
  let flightRecorder: InstanceType<typeof import("../flight-recorder.js").FlightRecorder>;

  beforeEach(async () => {
    originalDeadline = process.env.SYNC_DEADLINE_MS;
    process.env.SYNC_DEADLINE_MS = "1000";
    vi.resetModules();
    ({ createGatewayServer } = await import("../index.js"));
    ({ AsyncJobManager } = await import("../async-job-manager.js"));
    ({ FlightRecorder } = await import("../flight-recorder.js"));
    ({ SqliteJobStore } = await import("../job-store.js"));
    ({ PersonalConfigManager } = await import("../personal-config.js"));
    ({ runWithRequestContext } = await import("../request-context.js"));
    ({ FileSessionManager } = await import("../session-manager.js"));
    ({ noopLogger } = await import("../logger.js"));
    ({ createCodexKitIsolationPlan } = await import("../codex-kit-isolation.js"));
    root = mkdtempSync(join(tmpdir(), "kit-flight-recorder-privacy-"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
    flightRecorder = new FlightRecorder(join(root, "flight-recorder.db"), { redactSecrets: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await jobs?.dispose();
    store?.close();
    flightRecorder?.close();
    rmSync(root, { recursive: true, force: true });
    if (originalDeadline === undefined) delete process.env.SYNC_DEADLINE_MS;
    else process.env.SYNC_DEADLINE_MS = originalDeadline;
    vi.resetModules();
  });

  it.each(["claude_request", "claude_request_async"])(
    "rejects an unscoped %s without reading the gateway cwd overlay or starting Claude",
    async toolName => {
      const overlay = join(root, ".agents", "gateway", "config.toml");
      mkdirSync(join(root, ".agents", "gateway"), { recursive: true });
      writeFileSync(overlay, '[preferences]\nmodel_default = "overlay-model-must-not-load"\n');
      const originalCwd = process.cwd();
      process.chdir(root);

      const sessions = new FileSessionManager(join(root, "unscoped-sessions.json"));
      const personalConfig = new PersonalConfigManager(
        { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
        layout(root)
      );
      const buildContext = vi.spyOn(personalConfig, "buildContext");
      const startJob = vi.spyOn(jobs, "startJob");
      const startJobWithDedup = vi.spyOn(jobs, "startJobWithDedup");
      const server = createGatewayServer({
        sessionManager: sessions,
        asyncJobManager: jobs,
        flightRecorder,
        persistence: persistence(join(root, "jobs.db")),
        personalConfig,
        workspaces: workspaceRegistry(root),
      });
      const registry = (server as unknown as Record<string, Record<string, RegisteredTool>>)
        ._registeredTools;
      const requestTool = registry[toolName];
      if (!requestTool) throw new Error(`expected ${toolName}`);

      try {
        const response = await runWithRequestContext(requestContext(), () =>
          requestTool.handler(requestTool.inputSchema.parse({ prompt: "Do not start Claude." }), {})
        );

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain("kit_context_conflict");
        expect(buildContext).not.toHaveBeenCalled();
        expect(startJob).not.toHaveBeenCalled();
        expect(startJobWithDedup).not.toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
      }
    }
  );

  it.each([
    ["explain_effective_config", {}],
    ["codex_request", { prompt: "Do not start Codex." }],
    ["codex_request_async", { prompt: "Do not admit a Codex job." }],
  ] as const)(
    "rejects a relative Kit workingDir through %s before overlay or provider admission",
    async (toolName, baseInput) => {
      const git = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
      expect(git.status).toBe(0);
      mkdirSync(join(root, ".agents", "gateway"), { recursive: true });
      writeFileSync(
        join(root, ".agents", "gateway", "config.toml"),
        '[preferences]\nmodel_default = "overlay-model-must-not-load"\n'
      );
      const originalCwd = process.cwd();
      process.chdir(root);

      const sessions = new FileSessionManager(join(root, `${toolName}-relative-sessions.json`));
      const personalConfig = new PersonalConfigManager(
        { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
        layout(root)
      );
      const buildContext = vi.spyOn(personalConfig, "buildContext");
      const buildContextReadOnly = vi.spyOn(personalConfig, "buildContextReadOnly");
      const startJob = vi.spyOn(jobs, "startJob");
      const startJobWithDedup = vi.spyOn(jobs, "startJobWithDedup");
      vi.mocked(createCodexKitIsolationPlan).mockClear();
      const server = createGatewayServer({
        sessionManager: sessions,
        asyncJobManager: jobs,
        flightRecorder,
        persistence: persistence(join(root, "jobs.db")),
        personalConfig,
        workspaces: workspaceRegistry(root),
      });
      const registry = (server as unknown as Record<string, Record<string, RegisteredTool>>)
        ._registeredTools;
      const requestTool = registry[toolName];
      if (!requestTool) throw new Error(`expected ${toolName}`);

      try {
        const response = await runWithRequestContext(requestContext(), () =>
          requestTool.handler(requestTool.inputSchema.parse({ ...baseInput, workingDir: "." }), {})
        );

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain("kit_context_conflict");
        expect(response.content[0]?.text).toContain("absolute workingDir");
        expect(buildContext).not.toHaveBeenCalled();
        expect(buildContextReadOnly).not.toHaveBeenCalled();
        expect(createCodexKitIsolationPlan).not.toHaveBeenCalled();
        expect(startJob).not.toHaveBeenCalled();
        expect(startJobWithDedup).not.toHaveBeenCalled();
      } finally {
        process.chdir(originalCwd);
      }
    }
  );

  it.each([
    ["claude", "claude_request"],
    ["codex", "codex_request"],
  ] as const)(
    "withholds caller task and compiled context for synchronous %s requests",
    async (_provider, toolName) => {
      const privateTask = `PRIVATE_KIT_TASK_${toolName}`;
      const privateContext = `PRIVATE_KIT_CONTEXT_${toolName}`;
      const correlationId = `kit-flight-${toolName}`;
      const sessions = new FileSessionManager(join(root, "sessions.json"));
      const personalConfig = new PersonalConfigManager(
        { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
        layout(root)
      );
      const context = resolvedContext(root, privateContext);
      vi.spyOn(personalConfig, "buildContext").mockReturnValue(context);
      vi.spyOn(personalConfig, "assertExecutionCurrent").mockImplementation(() => {});
      vi.spyOn(jobs, "startJobWithDedup").mockImplementation(() => {
        throw new Error("test stops after the synchronous Flight Recorder write");
      });

      const server = createGatewayServer({
        sessionManager: sessions,
        asyncJobManager: jobs,
        flightRecorder,
        persistence: persistence(join(root, "jobs.db")),
        personalConfig,
        workspaces: workspaceRegistry(root),
      });
      const registry = (server as unknown as Record<string, Record<string, RegisteredTool>>)
        ._registeredTools;
      const requestTool = registry[toolName];
      const persistedResultTool = registry.llm_request_result;
      if (!requestTool || !persistedResultTool)
        throw new Error("expected request and lookup tools");

      const request = await runWithRequestContext(requestContext(), () =>
        requestTool.handler(
          requestTool.inputSchema.parse({
            prompt: privateTask,
            correlationId,
            ...(toolName === "claude_request" ? { workspace: "kit-target" } : { workingDir: root }),
          }),
          {}
        )
      );
      expect(request.isError).toBe(true);

      const readback = await runWithRequestContext(requestContext(), () =>
        persistedResultTool.handler(
          persistedResultTool.inputSchema.parse({ correlationId, includePrompt: true }),
          {}
        )
      );
      expect(readback.isError).toBeUndefined();
      const payload = JSON.parse(readback.content[0].text) as {
        success: boolean;
        request: { prompt: string; promptChars: number; response: string | null };
      };

      expect(payload.success).toBe(true);
      expect(payload.request.prompt).toBe(
        "Personal Agent Config Kit prompt is withheld from durable history"
      );
      expect(payload.request.promptChars).toBe(payload.request.prompt.length);
      expect(payload.request.response).toBe(
        "Personal Agent Config Kit provider output is withheld from durable history"
      );
      expect(JSON.stringify(payload)).not.toContain(privateTask);
      expect(JSON.stringify(payload)).not.toContain(privateContext);
    }
  );
});
