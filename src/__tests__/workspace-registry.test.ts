import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { runWithRequestContext } from "../request-context.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { FileSessionManager } from "../session-manager.js";
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

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: true,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

class ThrowingAsyncJobManager extends AsyncJobManager {
  override startJob(
    ..._args: Parameters<AsyncJobManager["startJob"]>
  ): ReturnType<AsyncJobManager["startJob"]> {
    throw new Error("spawn sentinel");
  }
}

function createAsyncGatewayServer(
  workspaces: WorkspaceRegistry,
  asyncJobManager: AsyncJobManager = new AsyncJobManager(
    noopLogger,
    undefined,
    new MemoryJobStore()
  )
) {
  return createGatewayServer({
    workspaces,
    sessionManager: new FileSessionManager(join(tempRootForShims, "sessions.json")),
    asyncJobManager,
    persistence: mkPersistence(),
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

  it.each([
    ["gateway bearer", { transport: "http", authKind: "gateway_bearer", authScopes: ["mcp"] }],
    ["auth disabled", { transport: "http", authKind: "disabled", authScopes: [] }],
    ["configured no-auth path", { transport: "http", authScopes: [] }],
    ["OAuth HTTP", { transport: "http", authKind: "oauth", authScopes: ["mcp"] }],
    ["legacy OAuth context", { authKind: "oauth", authScopes: ["mcp"] }],
  ] as const)(
    "remote %s provider tools require a registered workspace by default",
    async (_label, context) => {
      const server = createGatewayServer({ workspaces: disabledWorkspaces() });

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
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

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

    const allowUnregisteredServer = createGatewayServer({
      workspaces: disabledWorkspacesWith({ allowUnregisteredWorkingDir: true }),
    });
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
      "claude_request_async",
      "codex_request_async",
      "gemini_request_async",
      "grok_request_async",
      "mistral_request_async",
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
