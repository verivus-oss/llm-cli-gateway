import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname, tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { runWithRequestContext } from "../request-context.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { FileSessionManager } from "../session-manager.js";
import { createWorktree } from "../worktree-manager.js";
import type { PersistenceConfig } from "../config.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import {
  describeWorkspace,
  describeWorkspaceRemote,
  loadWorkspaceRegistry,
  registerExistingWorkspace,
  remoteSafeWorkspaceSummary,
  resolveWorkspaceForProvider,
  validatePathInsideWorkspace,
} from "../workspace-registry.js";
import { remoteSafeWorktreePath } from "../index.js";

const ORIGINAL_ENV = { ...process.env };

function initGitRepo(path: string): void {
  execFileSync("git", ["init"], { cwd: path, stdio: "ignore" });
}

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function registeredTools(
  server: ReturnType<typeof createGatewayServer>
): Record<string, RegisteredTool> {
  return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

function disabledWorkspaces(): WorkspaceRegistry {
  return {
    enabled: false,
    defaultAlias: null,
    allowUnregisteredWorkingDir: false,
    repos: [],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function disabledWorkspacesWith(
  overrides: Partial<Pick<WorkspaceRegistry, "allowUnregisteredWorkingDir">>
): WorkspaceRegistry {
  return { ...disabledWorkspaces(), ...overrides };
}

function defaultWorkspace(
  root: string,
  providers: WorkspaceRegistry["repos"][number]["providers"] = ["grok", "mistral"]
): WorkspaceRegistry {
  return {
    enabled: true,
    defaultAlias: "default",
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "default",
        path: root,
        providers,
        allowWorktree: false,
        allowAddDir: false,
        kind: "git",
        operatorEntry: true,
      },
    ],
    allowedRoots: [],
    sources: { configFile: null },
  };
}

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

class ThrowingAsyncJobManager extends AsyncJobManager {
  readonly starts: Array<{ cli: string; args: string[]; cwd: string | undefined }> = [];

  override startJob(
    ...args: Parameters<AsyncJobManager["startJob"]>
  ): ReturnType<AsyncJobManager["startJob"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3] });
    throw new Error("spawn sentinel");
  }

  override startJobWithDedup(
    ...args: Parameters<AsyncJobManager["startJobWithDedup"]>
  ): ReturnType<AsyncJobManager["startJobWithDedup"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3]?.cwd });
    throw new Error("spawn sentinel");
  }
}

function createAsyncGatewayServer(
  workspaces: WorkspaceRegistry,
  asyncJobManager: AsyncJobManager = new AsyncJobManager(
    noopLogger,
    undefined,
    new MemoryJobStore()
  ),
  sessionManager = new FileSessionManager(join(tempRootForShims, "sessions.json"))
) {
  return createGatewayServer({
    workspaces,
    sessionManager,
    asyncJobManager,
    persistence: mkPersistence(),
  });
}

function createSyncGatewayServer(workspaces: WorkspaceRegistry) {
  return createGatewayServer({
    workspaces,
    sessionManager: new FileSessionManager(join(tempRootForShims, "sync-sessions.json")),
  });
}

let tempRootForShims = "";

describe("workspace registry", () => {
  let tempDir: string;
  let repoRoot: string;
  let configPath: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    tempDir = mkdtempSync(join(tmpdir(), "workspace-registry-test-"));
    tempRootForShims = tempDir;
    repoRoot = join(tempDir, "repo");
    execFileSync("mkdir", ["-p", repoRoot]);
    initGitRepo(repoRoot);
    configPath = join(tempDir, "config.toml");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
  });

  it("Slice 4: an API provider never resolves to a workspace/worktree", () => {
    writeFileSync(
      configPath,
      [
        "[workspaces]",
        'default = "gateway"',
        "",
        "[[workspaces.repos]]",
        'alias = "gateway"',
        `path = "${repoRoot}"`,
        'providers = ["claude", "codex"]',
        "allow_worktree = true",
        "",
      ].join("\n")
    );
    const registry = loadWorkspaceRegistry(undefined, configPath);
    // API providers (kind:"api") are reviewers/generators only — they must never
    // receive a worktree. The registry is CliType-only, so an API provider name
    // is rejected rather than handed a filesystem workspace.
    expect(() => resolveWorkspaceForProvider(registry, "ollama" as any, "gateway")).toThrow(
      /does not allow provider "ollama"/
    );
  });

  it("loads repo aliases, normalizes paths, and resolves provider cwd", () => {
    writeFileSync(
      configPath,
      [
        "[workspaces]",
        'default = "gateway"',
        "",
        "[[workspaces.repos]]",
        'alias = "gateway"',
        `path = "${repoRoot}"`,
        'providers = ["claude", "codex"]',
        "allow_worktree = true",
        "allow_add_dir = false",
        "",
      ].join("\n")
    );

    const registry = loadWorkspaceRegistry(undefined, configPath);
    expect(registry.enabled).toBe(true);
    const workspace = resolveWorkspaceForProvider(registry, "codex");
    expect(workspace.alias).toBe("gateway");
    expect(workspace.cwd).toBe(repoRoot);
    expect(() => resolveWorkspaceForProvider(registry, "gemini", "gateway")).toThrow(
      /does not allow provider/
    );
  });

  it("rejects invalid aliases and non-git repo entries", () => {
    writeFileSync(
      configPath,
      [
        "[workspaces]",
        "",
        "[[workspaces.repos]]",
        'alias = "../bad"',
        `path = "${tempDir}"`,
        "",
      ].join("\n")
    );

    const registry = loadWorkspaceRegistry(undefined, configPath);
    expect(registry.enabled).toBe(false);
  });

  it("rejects workingDir and addDir that escape the selected workspace", () => {
    writeFileSync(
      configPath,
      [
        "[workspaces]",
        'default = "gateway"',
        "",
        "[[workspaces.repos]]",
        'alias = "gateway"',
        `path = "${repoRoot}"`,
        'providers = ["claude"]',
        "allow_add_dir = false",
        "",
      ].join("\n")
    );
    const registry = loadWorkspaceRegistry(undefined, configPath);
    const workspace = resolveWorkspaceForProvider(registry, "claude");

    expect(() => validatePathInsideWorkspace(workspace, "/tmp", "workingDir")).toThrow(
      /Absolute workingDir/
    );
    expect(() => validatePathInsideWorkspace(workspace, "../outside", "workingDir")).toThrow();
    expect(() => validatePathInsideWorkspace(workspace, "/tmp", "addDir")).toThrow(
      /Absolute addDir/
    );
  });

  it("rejects symlink repo paths that target denied directories", () => {
    const linkPath = join(tempDir, "gateway-link");
    symlinkSync(join(process.env.HOME ?? tempDir, ".llm-cli-gateway"), linkPath);
    writeFileSync(
      configPath,
      [
        "[workspaces]",
        "",
        "[[workspaces.repos]]",
        'alias = "gateway"',
        `path = "${linkPath}"`,
        "",
      ].join("\n")
    );

    const registry = loadWorkspaceRegistry(undefined, configPath);
    expect(registry.enabled).toBe(false);
  });

  it("local stdio/no-context provider tools allow unregistered addDir past workspace gating", async () => {
    const server = createAsyncGatewayServer(
      disabledWorkspaces(),
      new ThrowingAsyncJobManager(noopLogger, undefined, new MemoryJobStore())
    );

    const result = await registeredTools(server).claude_request_async.handler(
      {
        prompt: "hello",
        addDir: [tempDir],
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(result.content[0]?.text).not.toContain("Remote HTTP provider requests require");
    expect(result.content[0]?.text).not.toContain("workingDir/addDir require");
  });

  it("local stdio/no-context provider tools allow unregistered workingDir past workspace gating", async () => {
    const server = createAsyncGatewayServer(
      disabledWorkspaces(),
      new ThrowingAsyncJobManager(noopLogger, undefined, new MemoryJobStore())
    );

    const result = await registeredTools(server).codex_request_async.handler(
      {
        prompt: "hello",
        workingDir: tempDir,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(result.content[0]?.text).not.toContain("Remote HTTP provider requests require");
    expect(result.content[0]?.text).not.toContain("workingDir/addDir require");
  });

  it("local stdio direct paths override an implicit default workspace", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(defaultWorkspace(repoRoot), asyncJobManager);

    const result = await registeredTools(server).mistral_request_async.handler(
      {
        prompt: "hello",
        workingDir: tempDir,
        addDir: [tempDir],
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(result.content[0]?.text).not.toContain("Absolute workingDir is not allowed");
    expect(asyncJobManager.starts).toHaveLength(1);
    expect(asyncJobManager.starts[0]).toEqual(
      expect.objectContaining({ cli: "mistral", cwd: tempDir })
    );
    expect(asyncJobManager.starts[0]?.args).toEqual(
      expect.arrayContaining(["--workdir", tempDir, "--add-dir", tempDir])
    );
  });

  it.each(["claude_request", "claude_request_async"] as const)(
    "local Claude workingDir overrides an incompatible default workspace and reaches %s",
    async toolName => {
      const asyncJobManager = new ThrowingAsyncJobManager(
        noopLogger,
        undefined,
        new MemoryJobStore()
      );
      // The default intentionally excludes Claude. If the explicit local cwd
      // is dropped before workspace resolution, this request fails before the
      // child-process handoff with a provider-not-allowed error instead.
      const server = createAsyncGatewayServer(defaultWorkspace(repoRoot), asyncJobManager);

      const result = await registeredTools(server)[toolName].handler(
        {
          prompt: "hello",
          workingDir: tempDir,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        },
        {}
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("spawn sentinel");
      expect(result.content[0]?.text).not.toContain('does not allow provider "claude"');
      expect(asyncJobManager.starts).toEqual([
        expect.objectContaining({ cli: "claude", cwd: tempDir }),
      ]);
    }
  );

  it("local stdio addDir retains an implicit default workspace cwd and canonicalizes argv", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(defaultWorkspace(repoRoot), asyncJobManager);

    const result = await registeredTools(server).mistral_request_async.handler(
      {
        prompt: "hello",
        addDir: ["."],
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(asyncJobManager.starts).toHaveLength(1);
    expect(asyncJobManager.starts[0]).toEqual(
      expect.objectContaining({ cli: "mistral", cwd: repoRoot })
    );
    expect(asyncJobManager.starts[0]?.args).toEqual(
      expect.arrayContaining(["--add-dir", repoRoot])
    );
  });

  it("local stdio Cursor addDir retains an implicit default workspace cwd and canonicalizes argv", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(
      defaultWorkspace(repoRoot, ["cursor"]),
      asyncJobManager
    );

    const result = await registeredTools(server).cursor_request_async.handler(
      {
        prompt: "hello",
        addDir: ["."],
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(asyncJobManager.starts).toHaveLength(1);
    expect(asyncJobManager.starts[0]).toEqual(
      expect.objectContaining({ cli: "cursor", cwd: repoRoot })
    );
    expect(asyncJobManager.starts[0]?.args).toEqual(
      expect.arrayContaining(["--add-dir", repoRoot])
    );
  });

  it("local stdio Gemini includeDirs retains an implicit default workspace cwd and canonicalizes argv", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(
      defaultWorkspace(repoRoot, ["gemini"]),
      asyncJobManager
    );

    const result = await registeredTools(server).gemini_request_async.handler(
      {
        prompt: "hello",
        includeDirs: ["."],
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(asyncJobManager.starts).toHaveLength(1);
    expect(asyncJobManager.starts[0]).toEqual(
      expect.objectContaining({ cli: "gemini", cwd: repoRoot })
    );
    expect(asyncJobManager.starts[0]?.args).toEqual(
      expect.arrayContaining(["--add-dir", repoRoot])
    );
  });

  it.each([
    ["addDir", "mistral_request_async"],
    ["includeDirs", "gemini_request_async"],
  ] as const)(
    "does not let local %s alone bypass the gateway app-directory cwd safeguard",
    async (field, toolName) => {
      const asyncJobManager = new ThrowingAsyncJobManager(
        noopLogger,
        undefined,
        new MemoryJobStore()
      );
      const server = createAsyncGatewayServer(disabledWorkspaces(), asyncJobManager);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(homedir(), ".llm-cli-gateway"));

      try {
        const result = await registeredTools(server)[toolName].handler(
          {
            prompt: "hello",
            [field]: [tempDir],
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        );

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("No workspace selected");
        expect(asyncJobManager.starts).toHaveLength(0);
      } finally {
        cwdSpy.mockRestore();
      }
    }
  );

  it("rejects direct local paths combined with a managed worktree", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(defaultWorkspace(repoRoot), asyncJobManager);

    const result = await registeredTools(server).mistral_request_async.handler(
      {
        prompt: "hello",
        workingDir: tempDir,
        worktree: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "workingDir, addDir, or includeDirs cannot be combined with worktree"
    );
    expect(asyncJobManager.starts).toHaveLength(0);
  });

  it.each([
    ["workingDir", "."],
    ["addDir", ["."]],
  ] as const)(
    "rejects remote worktree combined with %s before scope can be discarded",
    async (field, value) => {
      const workspaces = defaultWorkspace(repoRoot, ["mistral"]);
      workspaces.repos[0]!.allowWorktree = true;
      workspaces.repos[0]!.allowAddDir = true;
      const asyncJobManager = new ThrowingAsyncJobManager(
        noopLogger,
        undefined,
        new MemoryJobStore()
      );
      const server = createAsyncGatewayServer(workspaces, asyncJobManager);
      const oauthContext = {
        transport: "http" as const,
        authKind: "oauth" as const,
        authScopes: ["mcp"],
        authPrincipal: "remote-worktree-direct-path-user",
      };

      const result = await runWithRequestContext(oauthContext, () =>
        registeredTools(server).mistral_request_async.handler(
          {
            prompt: "hello",
            workspace: "default",
            worktree: true,
            [field]: value,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "workingDir, addDir, or includeDirs cannot be combined with worktree"
      );
      expect(asyncJobManager.starts).toHaveLength(0);
    }
  );

  it("rejects reuse of a session worktree from a different selected workspace", async () => {
    const secondRepoRoot = join(tempDir, "second-repo");
    execFileSync("mkdir", ["-p", secondRepoRoot]);
    initGitRepo(secondRepoRoot);
    const workspaces: WorkspaceRegistry = {
      enabled: true,
      defaultAlias: "first",
      allowUnregisteredWorkingDir: false,
      repos: [
        {
          alias: "first",
          path: repoRoot,
          providers: ["mistral"],
          allowWorktree: true,
          allowAddDir: false,
          kind: "git",
          operatorEntry: true,
        },
        {
          alias: "second",
          path: secondRepoRoot,
          providers: ["mistral"],
          allowWorktree: true,
          allowAddDir: false,
          kind: "git",
          operatorEntry: true,
        },
      ],
      allowedRoots: [],
      sources: { configFile: null },
    };
    const sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
    const session = sessionManager.createSession("mistral", "first workspace session");
    sessionManager.updateSessionMetadata(session.id, {
      workspaceAlias: "first",
      workspaceRoot: repoRoot,
      worktreePath: join(repoRoot, ".worktrees", "first-session"),
      worktreeName: "first-session",
    });
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(workspaces, asyncJobManager, sessionManager);

    const result = await registeredTools(server).mistral_request_async.handler(
      {
        prompt: "hello",
        sessionId: session.id,
        workspace: "second",
        worktree: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Durable session worktree metadata no longer matches a same-host gateway-owned Git worktree"
    );
    expect(asyncJobManager.starts).toHaveLength(0);
  });

  it("remote OAuth rejects a reused worktree symlink that escapes its workspace", async () => {
    const externalDirectory = join(tempDir, "external-directory");
    const worktreesDirectory = join(repoRoot, ".worktrees");
    const escapedWorktree = join(worktreesDirectory, "escaped-worktree");
    execFileSync("mkdir", ["-p", externalDirectory, worktreesDirectory]);
    symlinkSync(externalDirectory, escapedWorktree, "dir");

    const workspaces: WorkspaceRegistry = {
      enabled: true,
      defaultAlias: "gateway",
      allowUnregisteredWorkingDir: false,
      repos: [
        {
          alias: "gateway",
          path: repoRoot,
          providers: ["mistral"],
          allowWorktree: true,
          allowAddDir: false,
          kind: "git",
          operatorEntry: true,
        },
      ],
      allowedRoots: [],
      sources: { configFile: null },
    };
    const oauthContext = {
      transport: "http" as const,
      authKind: "oauth" as const,
      authScopes: ["mcp"],
      authPrincipal: "remote-worktree-user",
    };
    const sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
    const session = await runWithRequestContext(oauthContext, () =>
      Promise.resolve(sessionManager.createSession("mistral", "escaped worktree session"))
    );
    await runWithRequestContext(oauthContext, () =>
      Promise.resolve(
        sessionManager.updateSessionMetadata(session.id, {
          workspaceAlias: "gateway",
          workspaceRoot: repoRoot,
          worktreePath: escapedWorktree,
          worktreeName: "escaped-worktree",
        })
      )
    );
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(workspaces, asyncJobManager, sessionManager);

    const result = await runWithRequestContext(oauthContext, () =>
      registeredTools(server).mistral_request_async.handler(
        {
          prompt: "hello",
          sessionId: session.id,
          workspace: "gateway",
          worktree: true,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        },
        {}
      )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "Durable session worktree metadata no longer matches a same-host gateway-owned Git worktree"
    );
    expect(result.content[0]?.text).not.toContain(externalDirectory);
    expect(asyncJobManager.starts).toHaveLength(0);
  });

  it("remote OAuth reuses a gateway-created worktree inside its workspace", async () => {
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Gateway Test",
        "-c",
        "user.email=gateway-test@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "initial test commit",
      ],
      { cwd: repoRoot, stdio: "ignore" }
    );
    const worktree = await createWorktree({
      repoRoot,
      name: "remote-valid",
      logger: noopLogger,
    });
    const workspaces: WorkspaceRegistry = {
      enabled: true,
      defaultAlias: "gateway",
      allowUnregisteredWorkingDir: false,
      repos: [
        {
          alias: "gateway",
          path: repoRoot,
          providers: ["mistral"],
          allowWorktree: true,
          allowAddDir: false,
          kind: "git",
          operatorEntry: true,
        },
      ],
      allowedRoots: [],
      sources: { configFile: null },
    };
    const oauthContext = {
      transport: "http" as const,
      authKind: "oauth" as const,
      authScopes: ["mcp"],
      authPrincipal: "remote-worktree-user",
    };
    const sessionManager = new FileSessionManager(join(tempDir, "sessions.json"));
    const session = await runWithRequestContext(oauthContext, () =>
      Promise.resolve(sessionManager.createSession("mistral", "valid worktree session"))
    );
    await runWithRequestContext(oauthContext, () =>
      Promise.resolve(
        sessionManager.updateSessionMetadata(session.id, {
          workspaceAlias: "gateway",
          workspaceRoot: repoRoot,
          worktreePath: worktree.path,
          worktreeName: worktree.name,
          worktreeOwnerHostname: hostname(),
          worktreeOwnerInstanceId: "workspace-registry-test-instance",
        })
      )
    );
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(workspaces, asyncJobManager, sessionManager);

    const result = await runWithRequestContext(oauthContext, () =>
      registeredTools(server).mistral_request_async.handler(
        {
          prompt: "hello",
          sessionId: session.id,
          workspace: "gateway",
          worktree: true,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        },
        {}
      )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("spawn sentinel");
    expect(asyncJobManager.starts).toEqual([
      expect.objectContaining({ cli: "mistral", cwd: worktree.path }),
    ]);
    expect(remoteSafeWorktreePath(worktree.path, repoRoot)).toBe(
      join(".worktrees", "remote-valid")
    );
  });

  it.each(["cursor_request", "cursor_request_async"] as const)(
    "local Cursor workspace paths use the requested directory for %s",
    async toolName => {
      const cursorWorkspace = join(tempDir, "cursor-local");
      execFileSync("mkdir", ["-p", cursorWorkspace]);
      const asyncJobManager = new ThrowingAsyncJobManager(
        noopLogger,
        undefined,
        new MemoryJobStore()
      );
      const server = createAsyncGatewayServer(disabledWorkspaces(), asyncJobManager);

      const result = await registeredTools(server)[toolName].handler(
        {
          prompt: "hello",
          workspace: cursorWorkspace,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        },
        {}
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("spawn sentinel");
      expect(asyncJobManager.starts).toHaveLength(1);
      expect(asyncJobManager.starts[0]).toEqual(
        expect.objectContaining({ cli: "cursor", cwd: cursorWorkspace })
      );
      expect(asyncJobManager.starts[0]?.args).toEqual(
        expect.arrayContaining(["--workspace", cursorWorkspace])
      );
    }
  );

  it.each(["cursor_request", "cursor_request_async"] as const)(
    "local Cursor workspace files remain native workspace arguments for %s",
    async toolName => {
      const cursorWorkspaceFile = join(tempDir, "review.code-workspace");
      writeFileSync(cursorWorkspaceFile, "{}");
      const asyncJobManager = new ThrowingAsyncJobManager(
        noopLogger,
        undefined,
        new MemoryJobStore()
      );
      const server = createAsyncGatewayServer(disabledWorkspaces(), asyncJobManager);

      const result = await registeredTools(server)[toolName].handler(
        {
          prompt: "hello",
          workspace: cursorWorkspaceFile,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        },
        {}
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("spawn sentinel");
      expect(asyncJobManager.starts).toHaveLength(1);
      expect(asyncJobManager.starts[0]).toEqual(
        expect.objectContaining({ cli: "cursor", cwd: undefined })
      );
      expect(asyncJobManager.starts[0]?.args).toEqual(
        expect.arrayContaining(["--workspace", cursorWorkspaceFile])
      );
    }
  );

  it("remote HTTP Cursor rejects a local workspace path before spawn", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(disabledWorkspaces(), asyncJobManager);

    const result = await runWithRequestContext(
      { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] },
      () =>
        registeredTools(server).cursor_request_async.handler(
          {
            prompt: "hello",
            workspace: tempDir,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid workspace alias");
    expect(asyncJobManager.starts).toHaveLength(0);
  });

  it("remote HTTP confines direct paths to the configured default workspace", async () => {
    const asyncJobManager = new ThrowingAsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore()
    );
    const server = createAsyncGatewayServer(defaultWorkspace(repoRoot), asyncJobManager);

    const result = await runWithRequestContext(
      { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] },
      () =>
        registeredTools(server).mistral_request_async.handler(
          {
            prompt: "hello",
            workingDir: tempDir,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Absolute workingDir is not allowed");
    expect(asyncJobManager.starts).toHaveLength(0);
  });

  it.each([
    ["gateway bearer", { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] }],
    ["auth disabled", { transport: "http", authKind: "disabled", authScopes: [] }],
    ["configured no-auth path", { transport: "http", authScopes: [] }],
    ["OAuth HTTP", { transport: "http", authKind: "oauth", authScopes: ["mcp"] }],
    ["legacy OAuth context", { authKind: "oauth", authScopes: ["mcp"] }],
  ] as const)(
    "remote %s provider tools require a registered workspace by default",
    async (_label, context) => {
      const server = createSyncGatewayServer(disabledWorkspaces());

      const result = await runWithRequestContext(context, () =>
        registeredTools(server).codex_request.handler(
          {
            prompt: "hello",
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
      );

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("Remote HTTP provider requests require");
    }
  );

  it("allow_unregistered_working_dir does not bypass remote HTTP workspace gating", async () => {
    const server = createSyncGatewayServer(disabledWorkspaces());

    const result = await runWithRequestContext(
      { transport: "http", authKind: "gateway_bearer", authScopes: [] },
      () =>
        registeredTools(server).codex_request.handler(
          {
            prompt: "hello",
            workingDir: tempDir,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Remote HTTP provider requests require");

    const allowUnregisteredServer = createSyncGatewayServer(
      disabledWorkspacesWith({ allowUnregisteredWorkingDir: true })
    );
    const stillRejected = await runWithRequestContext(
      { transport: "http", authKind: "gateway_bearer", authScopes: [] },
      () =>
        registeredTools(allowUnregisteredServer).codex_request.handler(
          {
            prompt: "hello",
            workingDir: tempDir,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
    );

    expect(stillRejected.isError).toBe(true);
    expect(stillRejected.content[0]?.text).toContain("Remote HTTP provider requests require");
  });

  it("remote HTTP codex_fork_session requires a registered workspace by default", async () => {
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

    const result = await runWithRequestContext(
      { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] },
      () =>
        registeredTools(server).codex_fork_session.handler(
          {
            prompt: "hello",
            forkLast: true,
          },
          {}
        )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Remote HTTP provider requests require");
  });

  it("remote HTTP gating covers all provider sync and async request tools before spawn", async () => {
    const server = createAsyncGatewayServer(disabledWorkspaces());
    const tools = registeredTools(server);
    const toolArgs = {
      prompt: "hello",
      approvalStrategy: "legacy",
      optimizePrompt: false,
    };

    for (const toolName of [
      "claude_request",
      "codex_request",
      "gemini_request",
      "grok_request",
      "mistral_request",
      "cursor_request",
      "claude_request_async",
      "codex_request_async",
      "gemini_request_async",
      "grok_request_async",
      "mistral_request_async",
      "cursor_request_async",
    ]) {
      const result = await runWithRequestContext(
        { transport: "http", authKind: "gateway_bearer", authScopes: [] },
        () => tools[toolName].handler(toolArgs, {})
      );

      expect(result.isError, `${toolName} should fail closed`).toBe(true);
      expect(result.content[0]?.text, `${toolName} error`).toContain(
        "Remote HTTP provider requests require"
      );
    }
  });

  it("workspace MCP tools reject stdio/no-context callers", async () => {
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });
    const tools = registeredTools(server);

    for (const [toolName, args] of [
      ["workspace_list", {}],
      ["workspace_get", { alias: "missing" }],
      ["workspace_create", { alias: "newrepo", root: "allowed", slug: "newrepo" }],
      ["workspace_register_existing_repo", { alias: "newrepo", path: tempDir }],
    ] as const) {
      const result = await tools[toolName].handler(args, {});
      expect(result.isError, `${toolName} should reject stdio/no-context callers`).toBe(true);
      expect(result.content[0]?.text).toContain("only for remote HTTP/OAuth workspace clients");
      expect(result.content[0]?.text).toContain("pass workingDir/addDir/includeDirs directly");
    }
  });

  it("workspace_list remains available to remote HTTP callers", async () => {
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

    const result = await runWithRequestContext(
      { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] },
      () => registeredTools(server).workspace_list.handler({}, {})
    );

    expect(result.isError).not.toBe(true);
    expect(result.content[0]?.text).toContain('"success": true');
  });

  it("workspace admin tools require an OAuth workspace admin scope", async () => {
    process.env.LLM_GATEWAY_WORKSPACE_ADMIN = "1";
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

    const args = {
      alias: "newrepo",
      root: "allowed",
      slug: "newrepo",
      kind: "git",
      setDefault: false,
    };
    const withoutScope = await registeredTools(server).workspace_create.handler(args, {});
    expect(withoutScope.isError).toBe(true);
    expect(withoutScope.content[0]?.text).toContain("only for remote HTTP/OAuth");

    const remoteWithoutScope = await runWithRequestContext(
      { authKind: "oauth", authScopes: ["mcp"], authClientId: "non-admin-client" },
      () => registeredTools(server).workspace_create.handler(args, {})
    );
    expect(remoteWithoutScope.isError).toBe(true);
    expect(remoteWithoutScope.content[0]?.text).toContain("workspace:admin");

    const withScope = await runWithRequestContext(
      { authKind: "oauth", authScopes: ["workspace:admin"], authClientId: "admin-client" },
      () => registeredTools(server).workspace_create.handler(args, {})
    );
    expect(withScope.isError).toBe(true);
    expect(withScope.content[0]?.text).not.toContain("requires LLM_GATEWAY_WORKSPACE_ADMIN=1");
  });

  describe("remoteSafeWorkspaceSummary", () => {
    function writeRegistry(): void {
      writeFileSync(
        configPath,
        [
          "[workspaces]",
          'default = "gateway"',
          "",
          "[[workspaces.repos]]",
          'alias = "gateway"',
          `path = "${repoRoot}"`,
          'providers = ["claude", "codex"]',
          "allow_worktree = true",
          "",
        ].join("\n")
      );
    }

    it("exposes default alias, aliases, and readiness without local paths", () => {
      writeRegistry();
      const registry = loadWorkspaceRegistry(undefined, configPath);
      const summary = remoteSafeWorkspaceSummary(registry);

      expect(summary.ready).toBe(true);
      expect(summary.default).toBe("gateway");
      expect(summary.aliases).toEqual(["gateway"]);
      expect(summary.repo_count).toBe(1);

      // The remote-safe summary must NOT leak the local absolute repo path.
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain(repoRoot);
      expect(serialized).not.toContain(tempDir);
      expect(Object.keys(summary)).not.toContain("path");
    });

    it("is not ready when no default and no registered repos exist", () => {
      writeFileSync(
        configPath,
        [
          "[workspaces]",
          "",
          "[[workspaces.allowed_roots]]",
          `path = "${repoRoot}"`,
          "allow_create_directories = true",
          "",
        ].join("\n")
      );
      const registry = loadWorkspaceRegistry(undefined, configPath);
      const summary = remoteSafeWorkspaceSummary(registry);
      expect(summary.ready).toBe(false);
      expect(summary.default).toBeNull();
      expect(summary.aliases).toEqual([]);
      expect(summary.allowed_root_count).toBe(1);
    });

    it("admin describeWorkspace still exposes local paths for operator output", () => {
      writeRegistry();
      const registry = loadWorkspaceRegistry(undefined, configPath);
      // The admin projection is intentionally different: it DOES include the path
      // so local `workspace list` keeps working. This guards against a refactor
      // that accidentally routes remote output through describeWorkspace.
      const admin = describeWorkspace(registry.repos[0]);
      expect(admin.path).toBe(repoRoot);
      expect(JSON.stringify(admin)).toContain(repoRoot);
    });

    it("describeWorkspaceRemote drops the local path but keeps alias/kind/providers", () => {
      writeRegistry();
      const registry = loadWorkspaceRegistry(undefined, configPath);
      const remote = describeWorkspaceRemote(registry.repos[0]);
      expect(remote.path).toBeUndefined();
      expect(remote.alias).toBe("gateway");
      expect(remote.kind).toBe("git");
      expect(remote.providers).toEqual(["claude", "codex"]);
      expect(JSON.stringify(remote)).not.toContain(repoRoot);
    });
  });

  describe("remote workspace MCP tools do not leak local paths", () => {
    it("workspace_list and workspace_get omit local absolute paths for remote callers", async () => {
      writeFileSync(
        configPath,
        [
          "[workspaces]",
          'default = "gateway"',
          "",
          "[[workspaces.repos]]",
          'alias = "gateway"',
          `path = "${repoRoot}"`,
          'providers = ["claude", "codex"]',
          "",
          "[[workspaces.allowed_roots]]",
          `path = "${repoRoot}"`,
          "allow_create_directories = true",
          "",
        ].join("\n")
      );
      process.env.LLM_GATEWAY_CONFIG = configPath;
      const server = createAsyncGatewayServer(disabledWorkspaces());
      const oauthCtx = {
        authKind: "oauth" as const,
        authScopes: [],
        authClientId: "remote-client",
      };

      const list = await runWithRequestContext(oauthCtx, () =>
        registeredTools(server).workspace_list.handler({}, {})
      );
      const listText = list.content[0]?.text ?? "";
      expect(list.isError).toBeFalsy();
      expect(listText).not.toContain(repoRoot);
      expect(listText).not.toContain(tempDir);
      const listJson = JSON.parse(listText);
      expect(listJson.workspaces[0].alias).toBe("gateway");
      expect(listJson.workspaces[0].path).toBeUndefined();
      // allowed_roots must not expose the local path either.
      expect(listJson.allowed_roots[0].path).toBeUndefined();
      expect(listJson.allowed_roots[0].alias).toBeDefined();

      const get = await runWithRequestContext(oauthCtx, () =>
        registeredTools(server).workspace_get.handler({ alias: "gateway" }, {})
      );
      const getText = get.content[0]?.text ?? "";
      expect(get.isError).toBeFalsy();
      expect(getText).not.toContain(repoRoot);
      expect(JSON.parse(getText).workspace.path).toBeUndefined();
    });
  });

  describe("registerExistingWorkspace is not a filesystem existence oracle", () => {
    it("rejects an out-of-root path with a generic, path-free error before any FS probe", () => {
      writeFileSync(
        configPath,
        [
          "[workspaces]",
          "",
          "[[workspaces.allowed_roots]]",
          `path = "${repoRoot}"`,
          "allow_register_existing_git_repos = true",
          "",
        ].join("\n")
      );
      // A path OUTSIDE the allowed root: whether it exists or not, the error must
      // be identical and must not echo the probed path (no existence oracle).
      const secretPath = "/root/.ssh/id_rsa_secret_dir";
      let msg = "";
      try {
        registerExistingWorkspace({ alias: "probe", repoPath: secretPath, configPath });
      } catch (err) {
        msg = err instanceof Error ? err.message : String(err);
      }
      expect(msg).toMatch(/No allowed root permits/i);
      expect(msg).not.toContain(secretPath);
      expect(msg).not.toContain("does not exist");

      // A non-existent path that IS under the allowed root also yields no path echo
      // in the generic pre-check (it fails the FS probe next, but the arbitrary
      // out-of-root oracle is closed).
      let msg2 = "";
      try {
        registerExistingWorkspace({
          alias: "probe2",
          repoPath: join(repoRoot, "does-not-exist-xyz"),
          configPath,
        });
      } catch (err) {
        msg2 = err instanceof Error ? err.message : String(err);
      }
      expect(msg2.length).toBeGreaterThan(0);
    });
  });

  describe("remoteSafeWorktreePath", () => {
    it("reduces an absolute worktree path to a workspace-relative label", () => {
      expect(remoteSafeWorktreePath("/home/op/repo/.worktrees/abc", "/home/op/repo")).toBe(
        join(".worktrees", "abc")
      );
    });
    it("falls back to basename when the root is unknown or outside", () => {
      expect(remoteSafeWorktreePath("/home/op/repo/.worktrees/abc")).toBe("abc");
      expect(remoteSafeWorktreePath("/home/op/repo/.worktrees/abc", "/other/root")).toBe("abc");
    });
    it("passes through undefined", () => {
      expect(remoteSafeWorktreePath(undefined, "/x")).toBeUndefined();
    });
  });
});
