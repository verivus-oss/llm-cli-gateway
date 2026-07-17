import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import { createGatewayServer } from "../index.js";
import { SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  PERSONAL_CONFIG_NETWORK_GIT_TIMEOUT_MS,
  PERSONAL_CONFIG_SYNC_ERROR_WITHHELD,
  PersonalConfigError,
  PersonalConfigManager,
  buildKitContext,
  initPersonalConfig,
  publishPersonalConfig,
  readPersonalConfigState,
  resolveKitScope,
  syncPersonalConfig,
  type KitPathLayout,
  type PersonalConfigGitHooks,
  type PersonalConfigNetworkGitResult,
  type PersonalConfigSettings,
} from "../personal-config.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager } from "../session-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

const PRIVATE_REMOTE_HOST = "private-remote-sentinel.example";
const PRIVATE_REMOTE = `https://${PRIVATE_REMOTE_HOST}/baseline.git`;

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: { response?: string };
  }>;
  inputSchema: { parse: (value: unknown) => Record<string, unknown> };
}

interface RecordedSpawn {
  args: readonly string[];
  timeoutMs: number;
  killSignal: NodeJS.Signals;
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

function settings(root: string, enabled = true): PersonalConfigSettings {
  return { enabled, baselinePath: join(root, "baseline"), maxStaleHours: 168 };
}

function runGit(directory: string, args: string[]): void {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Git test setup failed for ${args[0] ?? "command"}: ${result.stderr}`);
  }
}

/** A committed baseline on a named branch with a policy-valid HTTPS origin. */
function seedBaseline(baselineDir: string): void {
  mkdirSync(baselineDir, { recursive: true, mode: 0o700 });
  runGit(baselineDir, ["init", "--initial-branch=main"]);
  runGit(baselineDir, ["config", "user.email", "kit@example.invalid"]);
  runGit(baselineDir, ["config", "user.name", "Kit Test"]);
  writeFileSync(join(baselineDir, "instructions.md"), "# Personal Agent Instructions\n", {
    mode: 0o600,
  });
  runGit(baselineDir, ["add", "instructions.md"]);
  runGit(baselineDir, ["commit", "-m", "baseline"]);
  runGit(baselineDir, ["remote", "add", "origin", PRIVATE_REMOTE]);
}

/** spawnSync surfaces an exceeded timeout as an ETIMEDOUT error. */
function timedOutSpawn(): PersonalConfigNetworkGitResult {
  const error = new Error("spawnSync git ETIMEDOUT") as NodeJS.ErrnoException;
  error.code = "ETIMEDOUT";
  return { stdout: "", stderr: "", status: null, signal: "SIGKILL", error };
}

function recordingHooks(
  calls: RecordedSpawn[],
  result: () => PersonalConfigNetworkGitResult
): PersonalConfigGitHooks {
  return {
    spawnNetworkGit: (args, options) => {
      calls.push({ args, timeoutMs: options.timeoutMs, killSignal: options.killSignal });
      return result();
    },
  };
}

function expectKitError(action: () => unknown, code: PersonalConfigError["code"]): Error {
  try {
    action();
  } catch (error) {
    if (!(error instanceof PersonalConfigError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
  throw new Error(`Expected PersonalConfigError with code ${code}`);
}

describe("Personal Agent Config Kit network Git is bounded", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-network-timeout-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a bounded timeout and kill signal to every network Git invocation", () => {
    const kitLayout = layout(root);
    seedBaseline(kitLayout.baselineDir);
    const calls: RecordedSpawn[] = [];

    expectKitError(
      () => publishPersonalConfig(kitLayout, { hooks: recordingHooks(calls, timedOutSpawn) }),
      "kit_invalid_baseline"
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("fetch");
    expect(calls[0]?.timeoutMs).toBe(PERSONAL_CONFIG_NETWORK_GIT_TIMEOUT_MS);
    expect(calls[0]?.killSignal).toBe("SIGKILL");
  });

  it("routes only network Git through the bounded runner, never local plumbing", () => {
    const kitLayout = layout(root);
    seedBaseline(kitLayout.baselineDir);
    const calls: RecordedSpawn[] = [];

    expectKitError(
      () =>
        publishPersonalConfig(kitLayout, {
          hooks: recordingHooks(calls, timedOutSpawn),
          timeoutMs: 25,
        }),
      "kit_invalid_baseline"
    );

    // publish runs status/branch/remote plumbing before it reaches the network.
    // Only the fetch may be bounded, so a slow healthy local repository is never
    // cut short by a transport budget.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(25);
    for (const call of calls) {
      expect(call.args.some(argument => ["clone", "fetch", "push"].includes(argument))).toBe(true);
    }
  });

  it("fails config_publish closed when the upstream fetch exceeds its budget", () => {
    const kitLayout = layout(root);
    seedBaseline(kitLayout.baselineDir);

    const error = expectKitError(
      () => publishPersonalConfig(kitLayout, { hooks: recordingHooks([], timedOutSpawn) }),
      "kit_invalid_baseline"
    );

    expect(error.message).toBe("Timed out contacting the baseline Git upstream");
    expect(error.message).not.toContain(PRIVATE_REMOTE_HOST);
  });

  it("fails config_init closed when the clone exceeds its budget without leaking the remote", () => {
    const kitLayout = layout(root);

    const error = expectKitError(
      () =>
        initPersonalConfig(kitLayout, PRIVATE_REMOTE, { hooks: recordingHooks([], timedOutSpawn) }),
      "kit_invalid_baseline"
    );

    expect(error.message).toBe("Timed out cloning the baseline Git repository");
    expect(error.message).not.toContain(PRIVATE_REMOTE_HOST);
  });

  it("treats a child killed by the configured signal as a timeout", () => {
    const kitLayout = layout(root);
    seedBaseline(kitLayout.baselineDir);

    // Some platforms surface only the kill, with no ETIMEDOUT error object.
    const error = expectKitError(
      () =>
        publishPersonalConfig(kitLayout, {
          hooks: recordingHooks([], () => ({
            stdout: "",
            stderr: "",
            status: null,
            signal: "SIGKILL",
          })),
        }),
      "kit_invalid_baseline"
    );

    expect(error.message).toBe("Timed out contacting the baseline Git upstream");
  });

  it("keeps the release active and withholds diagnostics when config_sync fetch times out", () => {
    const kitLayout = layout(root);
    seedBaseline(kitLayout.baselineDir);
    mkdirSync(kitLayout.runtimeDir, { recursive: true });

    const error = expectKitError(
      () =>
        syncPersonalConfig(kitLayout, settings(root), {
          hooks: recordingHooks([], timedOutSpawn),
        }),
      "kit_stale"
    );

    expect(error.message).toBe(
      "Timed out verifying the baseline against its upstream; the current release remains active and its freshness was not extended"
    );
    expect(error.message).not.toContain(PRIVATE_REMOTE_HOST);

    const state = readPersonalConfigState(kitLayout);
    // A timed-out fetch is an unverified upstream: it must not extend freshness
    // and must not persist raw Git diagnostics.
    expect(state.lastSyncError).toBe(PERSONAL_CONFIG_SYNC_ERROR_WITHHELD);
    expect(state.lastSuccessAt).toBeNull();
    expect(state.currentReleaseId).toBeNull();
  });
});

describe("resolveKitScope workspace alias containment", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-scope-alias-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects a requested workspace alias that does not contain the working directory", () => {
    const inside = join(root, "inside");
    const outside = join(root, "outside");
    mkdirSync(inside, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const error = expectKitError(
      () =>
        resolveKitScope({
          cwd: outside,
          registeredWorkspaces: [{ alias: "inside", path: inside }],
          requestedWorkspaceAlias: "inside",
        }),
      "kit_context_conflict"
    );

    expect(error.message).toContain('workspace "inside"');
    expect(error.message).not.toContain(outside);
  });

  it("selects the requested workspace alias when it contains the working directory", () => {
    const workspace = join(root, "workspace");
    const nested = join(workspace, "package");
    mkdirSync(nested, { recursive: true });

    const scope = resolveKitScope({
      cwd: nested,
      registeredWorkspaces: [{ alias: "workspace", path: workspace }],
      requestedWorkspaceAlias: "workspace",
    });

    expect(scope.scopeRoot).toBe(realpathSync(workspace));
  });

  it("keeps the unaliased Git-root fallback for a request that names no workspace", () => {
    const repository = join(root, "repository");
    mkdirSync(repository, { recursive: true });
    runGit(root, ["init", "--initial-branch=main"]);

    const scope = resolveKitScope({ cwd: repository, registeredWorkspaces: [] });

    expect(scope.scopeRoot).toBe(realpathSync(root));
  });

  it("falls back to Git-root scope when only a configured default alias misses the working directory", () => {
    // The caller named no workspace on this request. The configured default is a
    // default, not an assertion, so working in another checkout stays legal.
    const defaultWorkspace = join(root, "default-workspace");
    const otherCheckout = join(root, "other-checkout");
    mkdirSync(defaultWorkspace, { recursive: true });
    mkdirSync(otherCheckout, { recursive: true });
    runGit(otherCheckout, ["init", "--initial-branch=main"]);

    const scope = resolveKitScope({
      cwd: otherCheckout,
      registeredWorkspaces: [{ alias: "default-workspace", path: defaultWorkspace }],
      defaultWorkspaceAlias: "default-workspace",
    });

    expect(scope.scopeRoot).toBe(realpathSync(otherCheckout));
    expect(scope.registeredWorkspaceAlias).toBeNull();
  });

  it("selects the configured default alias when it contains the working directory", () => {
    const defaultWorkspace = join(root, "default-workspace");
    const nested = join(defaultWorkspace, "package");
    mkdirSync(nested, { recursive: true });

    const scope = resolveKitScope({
      cwd: nested,
      registeredWorkspaces: [{ alias: "default-workspace", path: defaultWorkspace }],
      defaultWorkspaceAlias: "default-workspace",
    });

    expect(scope.scopeRoot).toBe(realpathSync(defaultWorkspace));
    expect(scope.registeredWorkspaceAlias).toBe("default-workspace");
  });

  it("prefers the configured default over a more specific containing workspace", () => {
    // Pre-existing precedence: a matching default alias wins over the longest
    // containing registered workspace. Only an absent/mismatched default falls
    // through to ordinary discovery.
    const outer = join(root, "outer");
    const inner = join(outer, "inner");
    const nested = join(inner, "package");
    mkdirSync(nested, { recursive: true });
    const registeredWorkspaces = [
      { alias: "outer", path: outer },
      { alias: "inner", path: inner },
    ];

    const withDefault = resolveKitScope({
      cwd: nested,
      registeredWorkspaces,
      defaultWorkspaceAlias: "outer",
    });
    const withoutDefault = resolveKitScope({ cwd: nested, registeredWorkspaces });

    expect(withDefault.registeredWorkspaceAlias).toBe("outer");
    expect(withDefault.scopeRoot).toBe(realpathSync(outer));
    expect(withoutDefault.registeredWorkspaceAlias).toBe("inner");
    expect(withoutDefault.scopeRoot).toBe(realpathSync(inner));
  });

  it("still fails closed for an explicit alias even when the same alias is the configured default", () => {
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(outside, { recursive: true });

    // An explicit alias wins over the default and keeps assertion semantics.
    expectKitError(
      () =>
        resolveKitScope({
          cwd: outside,
          registeredWorkspaces: [{ alias: "workspace", path: workspace }],
          requestedWorkspaceAlias: "workspace",
          defaultWorkspaceAlias: "workspace",
        }),
      "kit_context_conflict"
    );
  });
});

const STAMP_RELEASE_ID = "e".repeat(40);

function releaseTreeDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    if (relativePath === "manifest.json") continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(files[relativePath] ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeVerifiedRelease(
  kitLayout: KitPathLayout,
  releaseId: string,
  files: Record<string, string>
): void {
  const releaseRoot = join(kitLayout.releasesDir, releaseId);
  mkdirSync(releaseRoot, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    writeFileSync(join(releaseRoot, relativePath), content);
  }
  writeFileSync(
    join(releaseRoot, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      releaseId,
      baselineCommit: releaseId,
      createdAt: "2026-07-14T00:00:00.000Z",
      verified: true,
      treeDigest: releaseTreeDigest(files),
    })}\n`
  );
  mkdirSync(dirname(kitLayout.currentPointerPath), { recursive: true });
  writeFileSync(kitLayout.currentPointerPath, `${JSON.stringify({ releaseId })}\n`);
}

describe("Kit identity in the default-alias fallback path", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-fallback-identity-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("derives configStamp from the resolved fallback scope, not from the configured default alias", () => {
    const kitLayout = layout(root);
    writeVerifiedRelease(kitLayout, STAMP_RELEASE_ID, {
      "instructions.md": "Keep the rendered instructions stable.",
    });
    const defaultWorkspace = join(root, "default-workspace");
    const otherCheckout = join(root, "other-checkout");
    mkdirSync(defaultWorkspace, { recursive: true });
    mkdirSync(otherCheckout, { recursive: true });
    runGit(otherCheckout, ["init", "--initial-branch=main"]);
    const registeredWorkspaces = [{ alias: "default-workspace", path: defaultWorkspace }];
    const machine = { machineId: "machine-fallback", providers: {} };

    const withDefault = resolveKitScope({
      cwd: otherCheckout,
      registeredWorkspaces,
      defaultWorkspaceAlias: "default-workspace",
    });
    const withoutDefault = resolveKitScope({ cwd: otherCheckout, registeredWorkspaces });

    // The fallback scope is self-consistent: root, HEAD, and overlay all come
    // from the checkout the caller actually selected.
    expect(withDefault.scopeRoot).toBe(realpathSync(otherCheckout));
    expect(withDefault.repoHead).toBe(withoutDefault.repoHead);
    expect(withDefault.overlayPath).toBe(withoutDefault.overlayPath);

    const fallbackContext = buildKitContext({ layout: kitLayout, machine, scope: withDefault });
    const unconfiguredContext = buildKitContext({
      layout: kitLayout,
      machine,
      scope: withoutDefault,
    });

    // configStamp is a pure function of the RESOLVED scope (scopeRoot, scopeCwd,
    // repoHead, overlay digest), so a configured default the request never named
    // cannot perturb Kit identity.
    expect(fallbackContext.configStamp).toBe(unconfiguredContext.configStamp);
    expect(fallbackContext.execution.scopeRoot).toBe(realpathSync(otherCheckout));
    expect(fallbackContext.execution.contextIdentity).toBe(
      unconfiguredContext.execution.contextIdentity
    );
    expect(fallbackContext.execution.releaseId).toBe(STAMP_RELEASE_ID);
  });

  it("gives the default workspace scope a distinct identity from the fallback scope", () => {
    const kitLayout = layout(root);
    writeVerifiedRelease(kitLayout, STAMP_RELEASE_ID, {
      "instructions.md": "Keep the rendered instructions stable.",
    });
    const defaultWorkspace = join(root, "default-workspace");
    const otherCheckout = join(root, "other-checkout");
    mkdirSync(defaultWorkspace, { recursive: true });
    mkdirSync(otherCheckout, { recursive: true });
    runGit(otherCheckout, ["init", "--initial-branch=main"]);
    const registeredWorkspaces = [{ alias: "default-workspace", path: defaultWorkspace }];
    const machine = { machineId: "machine-fallback", providers: {} };

    const inDefault = buildKitContext({
      layout: kitLayout,
      machine,
      scope: resolveKitScope({
        cwd: defaultWorkspace,
        registeredWorkspaces,
        defaultWorkspaceAlias: "default-workspace",
      }),
    });
    const inOther = buildKitContext({
      layout: kitLayout,
      machine,
      scope: resolveKitScope({
        cwd: otherCheckout,
        registeredWorkspaces,
        defaultWorkspaceAlias: "default-workspace",
      }),
    });

    // Distinct scopes must not share a Kit execution identity, so the fallback
    // can never resume the default workspace's native continuation.
    expect(inDefault.execution.scopeRoot).toBe(realpathSync(defaultWorkspace));
    expect(inOther.execution.scopeRoot).toBe(realpathSync(otherCheckout));
    expect(inDefault.configStamp).not.toBe(inOther.configStamp);
  });
});

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

function workspaceRegistryWithDefault(
  root: string,
  defaultAlias: string | null
): WorkspaceRegistry {
  return { ...workspaceRegistry(root), defaultAlias };
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

function localContext(): GatewayRequestContext {
  return { transport: "stdio", authKind: "disabled", authScopes: [] };
}

describe("codex_request default-workspace scope wiring", () => {
  let root: string;
  let sessions: FileSessionManager;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-default-alias-wiring-"));
    sessions = new FileSessionManager(join(root, "sessions.json"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
  });

  afterEach(async () => {
    await jobs.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function codexTool(defaultAlias: string | null): RegisteredTool {
    const server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: jobs,
      persistence: persistence(join(root, "jobs.db")),
      personalConfig: new PersonalConfigManager(settings(root, true), layout(root)),
      workspaces: workspaceRegistryWithDefault(join(root, "kit-target"), defaultAlias),
    });
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const request = registered.codex_request;
    if (!request) throw new Error("codex_request was not registered");
    return request;
  }

  it("does not turn a configured default workspace into a scope conflict for an outside workingDir", async () => {
    const kitTarget = join(root, "kit-target");
    const otherCheckout = join(root, "other-checkout");
    mkdirSync(kitTarget, { recursive: true });
    mkdirSync(otherCheckout, { recursive: true });
    runGit(otherCheckout, ["init", "--initial-branch=main"]);
    const request = codexTool("kit-target");

    const response = await runWithRequestContext(localContext(), () =>
      request.handler(
        request.inputSchema.parse({
          prompt: "Work in the other checkout.",
          workingDir: otherCheckout,
        }),
        {}
      )
    );

    // The caller named a workingDir, not a workspace. The configured default
    // must not be treated as an assertion about this request, so scope
    // resolution has to succeed and fail later on real Kit state instead.
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).not.toContain(
      "The request conflicts with the active Personal Agent Config context"
    );
    expect(response.content[0]?.text).toContain("kit_stale");
  });

  it("still resolves scope when no default workspace is configured", async () => {
    const otherCheckout = join(root, "other-checkout");
    mkdirSync(join(root, "kit-target"), { recursive: true });
    mkdirSync(otherCheckout, { recursive: true });
    runGit(otherCheckout, ["init", "--initial-branch=main"]);
    const request = codexTool(null);

    const response = await runWithRequestContext(localContext(), () =>
      request.handler(
        request.inputSchema.parse({
          prompt: "Work in the other checkout.",
          workingDir: otherCheckout,
        }),
        {}
      )
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).not.toContain(
      "The request conflicts with the active Personal Agent Config context"
    );
    expect(response.content[0]?.text).toContain("kit_stale");
  });
});

describe("config_init enablement gate", () => {
  let root: string;
  let sessions: FileSessionManager;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;

  function buildServer(enabled: boolean): ReturnType<typeof createGatewayServer> {
    return createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: jobs,
      persistence: persistence(join(root, "jobs.db")),
      personalConfig: new PersonalConfigManager(settings(root, enabled), layout(root)),
      workspaces: workspaceRegistry(root),
    });
  }

  function initTool(server: ReturnType<typeof createGatewayServer>): RegisteredTool {
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const init = registered.config_init;
    if (!init) throw new Error("config_init was not registered");
    return init;
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-init-gate-"));
    sessions = new FileSessionManager(join(root, "sessions.json"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
  });

  afterEach(async () => {
    await jobs.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses config_init while the Kit is disabled", async () => {
    const init = initTool(buildServer(false));

    const response = await runWithRequestContext(localContext(), () =>
      init.handler(init.inputSchema.parse({}), {})
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain(
      "kit_disabled: Personal Agent Config Kit is disabled"
    );
    // The refusal must precede any baseline mutation.
    expect(existsSync(layout(root).baselineDir)).toBe(false);
  });

  it("still initializes a local baseline once the Kit is enabled", async () => {
    const init = initTool(buildServer(true));

    const response = await runWithRequestContext(localContext(), () =>
      init.handler(init.inputSchema.parse({}), {})
    );

    expect(response.isError).toBeUndefined();
    expect(response.content[0]?.text).toContain('"initialized": true');
    expect(existsSync(layout(root).baselineDir)).toBe(true);
  });
});
