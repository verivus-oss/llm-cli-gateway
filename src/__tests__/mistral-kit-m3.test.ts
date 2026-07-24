import { mkdtempSync, rmSync } from "node:fs";
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
import {
  createMistralKitIsolationPlan,
  mistralKitSpawnEnvFragment,
} from "../mistral-kit-isolation.js";
import { runWithRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

/**
 * Mistral Kit M3: the gate-flip + integration slice. These tests drive the
 * REAL controlled-environment isolation (no mock of createMistralKitIsolationPlan)
 * through the registered `mistral_request` tool on a durable SQLite store, so they
 * prove BOTH admission gates now admit mistral, that the isolation env/native
 * capture are threaded end-to-end, and that the fail-closed paths hold.
 */

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
    text: "Private Mistral Kit context used by the M3 integration regression.",
    contextDigest: "f".repeat(64),
    configStamp: execution.configStamp,
    execution,
    preferences: {},
    provenance: [],
  };
}

describe("Mistral Kit M3 admission + wiring", () => {
  let root: string;
  let sessions: FileSessionManager;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;
  let tools: Record<string, RegisteredTool>;
  let getOrCreateKitSession: ReturnType<typeof vi.spyOn>;
  let startJobWithDedup: ReturnType<typeof vi.spyOn>;
  let savedApiKey: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mistral-kit-m3-"));
    savedApiKey = process.env.MISTRAL_API_KEY;
    process.env.MISTRAL_API_KEY = "sk-mistral-kit-m3-fixture";
    sessions = new FileSessionManager(join(root, "sessions.json"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
    const personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      layout(root)
    );
    vi.spyOn(personalConfig, "buildContext").mockReturnValue(context(root));
    vi.spyOn(personalConfig, "assertExecutionCurrent").mockImplementation(() => {});
    // Mistral Kit conflict-rejects createNewSession, so continuity is gateway-managed
    // via getOrCreateKitSession (the active-pointer path), never createKitSession.
    getOrCreateKitSession = vi.spyOn(sessions, "getOrCreateKitSession");
    startJobWithDedup = vi.spyOn(jobs, "startJobWithDedup");

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
    if (savedApiKey === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = savedApiKey;
    await jobs.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function invoke(args: Record<string, unknown>): Promise<ReturnType<RegisteredTool["handler"]>> {
    const tool = tools.mistral_request;
    if (!tool) throw new Error("mistral_request was not registered");
    return runWithRequestContext({ transport: "stdio", authKind: "disabled", authScopes: [] }, () =>
      tool.handler(tool.inputSchema.parse(args), {})
    ) as Promise<ReturnType<RegisteredTool["handler"]>>;
  }

  it("admits mistral through BOTH gates onto the verified isolation + session + job path", async () => {
    // A sentinel throw at durable admission proves the front half (gate flip,
    // isolation build, Kit session claim, env admission) all ran for mistral.
    startJobWithDedup.mockImplementation(() => {
      throw new Error("valid mistral Kit flow reached durable admission");
    });

    const response = await invoke({
      prompt: "Run the valid Mistral Kit request.",
      correlationId: "valid-mistral-kit-sync",
    });

    // getOrCreateKitSession re-enters through withStorageLock, so it is observed
    // more than once per logical resolution; the point is the gateway-managed
    // active-pointer path was used (never createNewSession) and durable admission
    // was reached exactly once.
    expect(response.isError).toBe(true);
    expect(getOrCreateKitSession).toHaveBeenCalled();
    expect(startJobWithDedup).toHaveBeenCalledOnce();

    // The isolation home is threaded for deferred disk-based native capture, and
    // the immutable Kit identity + durable session binding ride with the job.
    const opts = startJobWithDedup.mock.calls[0]![3] as {
      kitExecution?: unknown;
      kitSessionId?: unknown;
      kitNativeCaptureHome?: unknown;
    };
    expect(opts.kitExecution).toBeTruthy();
    expect(typeof opts.kitSessionId).toBe("string");
    expect(typeof opts.kitNativeCaptureHome).toBe("string");
    expect(opts.kitNativeCaptureHome as string).toContain("gw-mistral-kit-home-");
  });

  it("fails closed when MISTRAL_API_KEY is absent, before any session or job side effect", async () => {
    delete process.env.MISTRAL_API_KEY;

    const response = await invoke({
      prompt: "This must fail closed for missing auth.",
      correlationId: "mistral-kit-missing-auth",
    });

    // The detailed reason is privacy-redacted; the security-relevant fact is that
    // it fails closed BEFORE any Kit session claim or durable job admission (the
    // contrast with the admitted case above proves auth is the gate).
    expect(response.isError).toBe(true);
    expect(getOrCreateKitSession).not.toHaveBeenCalled();
    expect(startJobWithDedup).not.toHaveBeenCalled();
    expect(sessions.listSessions()).toEqual([]);
  });

  it("rejects a Kit conflict field (worktree) before any session or job side effect", async () => {
    const response = await invoke({
      prompt: "This must be rejected by the conflict list.",
      correlationId: "mistral-kit-conflict",
      worktree: true,
    });

    expect(response.isError).toBe(true);
    expect(getOrCreateKitSession).not.toHaveBeenCalled();
    expect(startJobWithDedup).not.toHaveBeenCalled();
    expect(sessions.listSessions()).toEqual([]);
  });

  it("rejects the ACP transport under Kit before routing around the isolation", async () => {
    const response = await invoke({
      prompt: "ACP must be rejected under Kit.",
      correlationId: "mistral-kit-acp",
      transport: "acp",
    });

    expect(response.isError).toBe(true);
    expect(getOrCreateKitSession).not.toHaveBeenCalled();
    expect(startJobWithDedup).not.toHaveBeenCalled();
  });

  it("accepts provider mistral in config_recover_kit_attempt (no provider-unsupported)", async () => {
    const tool = tools.config_recover_kit_attempt;
    if (!tool) throw new Error("config_recover_kit_attempt was not registered");
    const response = (await runWithRequestContext(
      { transport: "stdio", authKind: "disabled", authScopes: [] },
      () =>
        tool.handler(
          tool.inputSchema.parse({
            provider: "mistral",
            sessionId: "11111111-1111-4111-8111-111111111111",
            attemptId: "22222222-2222-4222-8222-222222222222",
            execution: {
              version: 1,
              releaseId: "a".repeat(40),
              configStamp: "b".repeat(64),
              scopeRoot: root,
              scopeHead: "c".repeat(40),
              contextIdentity: "d".repeat(64),
            },
            acknowledgement: "I_CONFIRM_THE_PREVIOUS_GATEWAY_IS_STOPPED",
          }),
          {}
        )
    )) as Awaited<ReturnType<RegisteredTool["handler"]>>;

    // Reaching the handler at all proves the pre-M3 z.enum(["claude","codex"]) no
    // longer rejects "mistral" at parse time; the unknown session then fails
    // closed inside recoverUnadmittedPersonalKitAttempt (isError, redacted reason).
    expect(response.isError).toBe(true);
  });
});

describe("mistralKitSpawnEnvFragment (M3 executor-merge projection)", () => {
  const savedApiKey = process.env.MISTRAL_API_KEY;
  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.MISTRAL_API_KEY;
    else process.env.MISTRAL_API_KEY = savedApiKey;
  });

  it("deletes ambient VIBE_*/scrub keys and applies only the gateway levers", () => {
    const cwd = mkdtempSync(join(tmpdir(), "mistral-kit-frag-cwd-"));
    try {
      const plan = createMistralKitIsolationPlan({
        cwd,
        contextPrefix: "<gateway-personal-config>ctx</gateway-personal-config>",
        apiKey: "sk-fragment-test",
      });
      const base: NodeJS.ProcessEnv = {
        PATH: "/usr/bin",
        HOME: "/home/victim",
        VIBE_SKILL_PATHS: "/home/victim/.agents/skills",
        VIBE_ENABLED_SKILLS: "danger",
        VIBE_ACTIVE_MODEL: "ambient-model",
        SAVE_DIR: "/home/victim/.vibe/logs",
        UNRELATED: "keep-me",
      };
      const fragment = mistralKitSpawnEnvFragment(base, plan);

      // Ambient VIBE_* injectors and bare-name scrub vars are deleted (undefined).
      expect(fragment.VIBE_SKILL_PATHS).toBeUndefined();
      expect(fragment.VIBE_ENABLED_SKILLS).toBeUndefined();
      expect(fragment.VIBE_ACTIVE_MODEL).toBeUndefined();
      expect(fragment.SAVE_DIR).toBeUndefined();
      expect("VIBE_SKILL_PATHS" in fragment).toBe(true);

      // Gateway levers win, redirecting HOME/VIBE_HOME into the ephemeral home.
      expect(fragment.HOME).toBe(plan.home);
      expect(fragment.VIBE_HOME).toBe(plan.vibeHome);
      expect(fragment.MISTRAL_API_KEY).toBe("sk-fragment-test");
      expect(fragment.VIBE_INCLUDE_PROJECT_CONTEXT).toBe("false");

      // Non-VIBE, non-scrub inherited keys are left to the executor's base merge.
      expect("UNRELATED" in fragment).toBe(false);
      expect("PATH" in fragment).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
