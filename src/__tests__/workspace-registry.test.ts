import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { runWithRequestContext } from "../request-context.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import {
  loadWorkspaceRegistry,
  resolveWorkspaceForProvider,
  validatePathInsideWorkspace,
} from "../workspace-registry.js";

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

describe("workspace registry", () => {
  let tempDir: string;
  let repoRoot: string;
  let configPath: string;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    tempDir = mkdtempSync(join(tmpdir(), "workspace-registry-test-"));
    repoRoot = join(tempDir, "repo");
    execFileSync("mkdir", ["-p", repoRoot]);
    initGitRepo(repoRoot);
    configPath = join(tempDir, "config.toml");
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    process.env = { ...ORIGINAL_ENV };
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

  it("provider tools reject unregistered workingDir path selection by default", async () => {
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

    const result = await registeredTools(server).codex_request.handler(
      {
        prompt: "hello",
        workingDir: tempDir,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("workingDir/addDir require a registered workspace");
  });

  it("remote OAuth provider tools require a registered workspace by default", async () => {
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

    const result = await runWithRequestContext(
      { authKind: "oauth", authScopes: ["mcp"], authClientId: "remote-client" },
      () =>
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
    expect(result.content[0]?.text).toContain("Remote OAuth provider requests require");
  });

  it("remote OAuth codex_fork_session requires a registered workspace by default", async () => {
    const server = createGatewayServer({ workspaces: disabledWorkspaces() });

    const result = await runWithRequestContext(
      { authKind: "oauth", authScopes: ["mcp"], authClientId: "remote-client" },
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
    expect(result.content[0]?.text).toContain("Remote OAuth provider requests require");
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
    expect(withoutScope.content[0]?.text).toContain("workspace:admin");

    const withScope = await runWithRequestContext(
      { authKind: "oauth", authScopes: ["workspace:admin"], authClientId: "admin-client" },
      () => registeredTools(server).workspace_create.handler(args, {})
    );
    expect(withScope.isError).toBe(true);
    expect(withScope.content[0]?.text).not.toContain("requires LLM_GATEWAY_WORKSPACE_ADMIN=1");
  });
});
