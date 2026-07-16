import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs, {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { syncBuiltinESMExports } from "module";
import { homedir, hostname, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeKitStale,
  buildKitContext,
  createClaudeContextArtifact,
  ensureLocalMachineBinding,
  getCurrentPersonalConfigRelease,
  isKitStale,
  initPersonalConfig,
  KIT_ABSOLUTE_WORKING_DIR_REQUIRED,
  loadPersonalConfigSettings,
  PersonalConfigError,
  PersonalConfigManager,
  publishPersonalConfig,
  rollbackPersonalConfig,
  resolveKitScope,
  resolveCodexKitSandboxMode,
  resolveClaudeKitOutputFormat,
  resolveCodexKitOutputFormat,
  reapClaudeContextArtifacts,
  SAFE_GIT_TRANSPORT_CONFIG,
  validatePersonalConfigRemote,
  validateKitRequestSurface,
  writePersonalConfigState,
  syncPersonalConfig,
  type KitPathLayout,
  type PersonalConfigState,
} from "../personal-config.js";

const FIRST_RELEASE_ID = "a".repeat(40);
const SECOND_RELEASE_ID = "b".repeat(40);

function makeLayout(testDir: string): KitPathLayout {
  const runtimeDir = path.join(testDir, "runtime");
  return {
    baselineDir: path.join(testDir, "baseline"),
    runtimeDir,
    localTomlPath: path.join(runtimeDir, "local.toml"),
    statePath: path.join(runtimeDir, "personal-config-state.json"),
    releasesDir: path.join(runtimeDir, "personal-config", "releases"),
    currentPointerPath: path.join(runtimeDir, "personal-config", "current.json"),
    lockPath: path.join(runtimeDir, "personal-config", "lock"),
    artifactsDir: path.join(runtimeDir, "personal-config", "artifacts"),
  };
}

function releaseTreeDigest(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const relativePath of Object.keys(files).sort()) {
    if (relativePath === "manifest.json") continue;
    hash.update(relativePath);
    hash.update("\0");
    hash.update(files[relativePath]);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function writeVerifiedRelease(
  layout: KitPathLayout,
  releaseId: string,
  files: Record<string, string>
): void {
  const root = path.join(layout.releasesDir, releaseId);
  mkdirSync(root, { recursive: true });
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
  writeFileSync(
    path.join(root, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      releaseId,
      baselineCommit: releaseId,
      createdAt: "2026-07-14T00:00:00.000Z",
      verified: true,
      treeDigest: releaseTreeDigest(files),
    })}\n`
  );
}

function activateRelease(
  layout: KitPathLayout,
  releaseId: string,
  state: Partial<PersonalConfigState> = {}
): void {
  mkdirSync(path.dirname(layout.currentPointerPath), { recursive: true });
  writeFileSync(layout.currentPointerPath, `${JSON.stringify({ releaseId })}\n`);
  writePersonalConfigState(layout, {
    currentReleaseId: releaseId,
    lastSuccessAt: "2026-07-14T00:00:00.000Z",
    lastSyncError: null,
    staleAckUntil: null,
    staleAckReleaseId: null,
    staleAckUsedForReleaseId: null,
    staleAckUsedForReleaseIds: [],
    staleAckHistoryComplete: true,
    ...state,
  });
}

function rewriteReleaseManifest(layout: KitPathLayout, releaseId: string): void {
  const root = path.join(layout.releasesDir, releaseId);
  const files: Record<string, string> = {};
  for (const name of ["instructions.md", "preferences.toml", "config.toml"]) {
    const filePath = path.join(root, name);
    if (existsSync(filePath)) files[name] = readFileSync(filePath, "utf8");
  }
  writeFileSync(
    path.join(root, "manifest.json"),
    `${JSON.stringify({
      version: 1,
      releaseId,
      baselineCommit: releaseId,
      createdAt: "2026-07-14T00:00:00.000Z",
      verified: true,
      treeDigest: releaseTreeDigest(files),
    })}\n`
  );
}

function expectKitError(action: () => unknown, code: PersonalConfigError["code"]): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof PersonalConfigError)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`Expected PersonalConfigError with code ${code}`);
}

interface TestKitLockOwner {
  token: string;
  pid: number;
  hostname: string;
}

function writeKitLock(layout: KitPathLayout, owner: TestKitLockOwner): void {
  mkdirSync(path.dirname(layout.lockPath), { recursive: true, mode: 0o700 });
  writeFileSync(layout.lockPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
}

function confirmedDeadPid(): number {
  for (const candidate of [2_147_483_647, 1_073_741_823, 999_999_999]) {
    try {
      process.kill(candidate, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
    }
  }
  throw new Error("Unable to find a provably absent PID for the Kit lock test");
}

function prepareStaleReleaseForLockTest(layout: KitPathLayout): number {
  const now = Date.parse("2026-07-15T00:00:00.000Z");
  writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "lock test" });
  activateRelease(layout, FIRST_RELEASE_ID, {
    lastSuccessAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
  });
  return now;
}

function runGit(directory: string, args: string[]): void {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Git test setup failed for ${args[0] ?? "command"}: ${result.stderr}`);
  }
}

function initializeCommittedBaseline(layout: KitPathLayout): void {
  mkdirSync(layout.baselineDir, { recursive: true });
  runGit(layout.baselineDir, ["init"]);
  runGit(layout.baselineDir, ["config", "user.name", "Kit Test"]);
  runGit(layout.baselineDir, ["config", "user.email", "kit-test@example.invalid"]);
  writeFileSync(path.join(layout.baselineDir, "instructions.md"), "# Test baseline\n");
  runGit(layout.baselineDir, ["add", "instructions.md"]);
  runGit(layout.baselineDir, ["commit", "-m", "Initialize baseline"]);
  runGit(layout.baselineDir, ["branch", "-M", "kit-test"]);
}

describe("Personal Agent Config Kit compiler and release safety", () => {
  let testDir: string | null = null;

  afterEach(() => {
    if (testDir && existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  });

  function newTestLayout(): KitPathLayout {
    testDir = path.join(
      tmpdir(),
      `personal-config-test-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });
    return makeLayout(testDir);
  }

  it("rejects unsafe configured baseline paths before initialization", () => {
    const layout = newTestLayout();
    const configPath = path.join(testDir!, "gateway.toml");
    for (const baselinePath of ["~", "~/..", "/", "relative-baseline", "/tmp/baseline"]) {
      writeFileSync(
        configPath,
        `[personal_config]\nenabled = true\nbaseline_path = "${baselinePath}"\n`
      );
      expectKitError(() => loadPersonalConfigSettings(configPath), "kit_invalid_baseline");
    }

    writeFileSync(
      configPath,
      '[personal_config]\nenabled = true\nbaseline_path = "~/.agent-config-review-safe"\n'
    );
    expect(loadPersonalConfigSettings(configPath).settings.baselinePath).toBe(
      path.join(realpathSync(homedir()), ".agent-config-review-safe")
    );
    expect(layout.baselineDir).toBeDefined();
  });

  it("fails closed instead of adopting a repository overlay from process cwd", () => {
    newTestLayout();
    const originalCwd = process.cwd();
    const overlayPath = path.join(testDir!, ".agents", "gateway", "config.toml");
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, '[preferences]\ncodex_sandbox_mode = "read-only"\n');
    runGit(testDir!, ["init"]);

    try {
      process.chdir(testDir!);
      expectKitError(() => resolveKitScope(), "kit_context_conflict");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it.each([".", "child"])(
    "rejects relative Kit scope %s before resolving it against process cwd",
    relativeCwd => {
      newTestLayout();
      const originalCwd = process.cwd();
      mkdirSync(path.join(testDir!, "child"), { recursive: true });
      runGit(testDir!, ["init"]);

      try {
        process.chdir(testDir!);
        let captured: unknown;
        try {
          resolveKitScope({ cwd: relativeCwd });
        } catch (error) {
          captured = error;
        }
        expect(captured).toBeInstanceOf(PersonalConfigError);
        expect(captured).toMatchObject({
          code: "kit_context_conflict",
          message: KIT_ABSOLUTE_WORKING_DIR_REQUIRED,
        });
      } finally {
        process.chdir(originalCwd);
      }
    }
  );

  it("refuses a symlinked baseline path before recursive permission hardening", () => {
    const layout = newTestLayout();
    const symlinkedBaseline = path.join(testDir!, "baseline-link");
    symlinkSync(process.cwd(), symlinkedBaseline);
    layout.baselineDir = symlinkedBaseline;

    expectKitError(() => initPersonalConfig(layout), "kit_invalid_baseline");
  });

  it("validates stored origin and push URLs before synchronization or publish", () => {
    const layout = newTestLayout();
    initializeCommittedBaseline(layout);
    runGit(layout.baselineDir, ["remote", "add", "origin", "file:///tmp/kit-baseline.git"]);

    expectKitError(
      () =>
        syncPersonalConfig(layout, {
          enabled: true,
          baselinePath: layout.baselineDir,
          maxStaleHours: 24,
        }),
      "kit_invalid_baseline"
    );

    runGit(layout.baselineDir, [
      "remote",
      "set-url",
      "origin",
      "https://example.invalid/kit.git?ref=untrusted",
    ]);
    expectKitError(
      () =>
        syncPersonalConfig(layout, {
          enabled: true,
          baselinePath: layout.baselineDir,
          maxStaleHours: 24,
        }),
      "kit_invalid_baseline"
    );

    runGit(layout.baselineDir, ["remote", "set-url", "origin", "https://example.invalid/kit.git"]);
    runGit(layout.baselineDir, [
      "config",
      "remote.origin.pushurl",
      "ssh://git@example.invalid/kit.git#untrusted",
    ]);
    expectKitError(() => publishPersonalConfig(layout), "kit_invalid_baseline");

    runGit(layout.baselineDir, ["config", "remote.origin.pushurl", "ext::unsafe-helper"]);

    expectKitError(() => publishPersonalConfig(layout), "kit_invalid_baseline");
  });

  it("prevents Git URL rewriting from downgrading an accepted HTTPS remote to HTTP", () => {
    const result = spawnSync(
      "git",
      [
        ...SAFE_GIT_TRANSPORT_CONFIG,
        "-c",
        "url.http://127.0.0.1:9/.insteadOf=https://approved.example/",
        "ls-remote",
        "https://approved.example/kit.git",
      ],
      {
        encoding: "utf8",
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_TRACE: "1" },
      }
    );

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain("transport 'http' not allowed");
    expect(output).not.toContain("remote-http");
  });

  it("cleans up an uncommitted Kit lock when writing its ownership record fails", () => {
    const layout = newTestLayout();
    const now = prepareStaleReleaseForLockTest(layout);
    const writeSpy = vi.spyOn(fs, "writeFileSync").mockImplementationOnce(() => {
      throw new Error("injected lock write failure");
    });
    syncBuiltinESMExports();

    try {
      expectKitError(() => acknowledgeKitStale(layout, 1, now), "kit_busy");
      expect(existsSync(layout.lockPath)).toBe(false);
    } finally {
      writeSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("reclaims a same-host Kit configuration lock only after its owner PID is provably absent", () => {
    const layout = newTestLayout();
    const now = prepareStaleReleaseForLockTest(layout);
    writeKitLock(layout, {
      token: "dead-owner-lock-token",
      pid: confirmedDeadPid(),
      hostname: hostname(),
    });

    const state = acknowledgeKitStale(layout, 1, now);

    expect(state.staleAckReleaseId).toBe(FIRST_RELEASE_ID);
    expect(existsSync(layout.lockPath)).toBe(false);
    expect(existsSync(`${layout.lockPath}.recovery`)).toBe(false);
  });

  it("retains a same-host Kit configuration lock while its owner is live", () => {
    const layout = newTestLayout();
    const now = prepareStaleReleaseForLockTest(layout);
    const owner: TestKitLockOwner = {
      token: "live-owner-lock-token",
      pid: process.pid,
      hostname: hostname(),
    };
    writeKitLock(layout, owner);

    expectKitError(() => acknowledgeKitStale(layout, 1, now), "kit_busy");

    expect(JSON.parse(readFileSync(layout.lockPath, "utf8"))).toEqual(owner);
  });

  it("retains a foreign-host Kit configuration lock even when its PID is absent locally", () => {
    const layout = newTestLayout();
    const now = prepareStaleReleaseForLockTest(layout);
    const owner: TestKitLockOwner = {
      token: "foreign-owner-lock-token",
      pid: confirmedDeadPid(),
      hostname: `${hostname()}-other-host`,
    };
    writeKitLock(layout, owner);

    expectKitError(() => acknowledgeKitStale(layout, 1, now), "kit_busy");

    expect(JSON.parse(readFileSync(layout.lockPath, "utf8"))).toEqual(owner);
  });

  it("never unlinks a replacement Kit configuration lock after the original owner token changes", () => {
    const layout = newTestLayout();
    const fakeBin = path.join(testDir!, "fake-bin");
    const fakeGit = path.join(fakeBin, "git");
    const replacement: TestKitLockOwner = {
      token: "replacement-lock-token",
      pid: process.pid,
      hostname: hostname(),
    };
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      fakeGit,
      '#!/bin/sh\nfor argument in "$@"; do destination="$argument"; done\n/bin/mkdir -p "$destination/.git"\n/bin/rm -f "$LLM_GATEWAY_TEST_LOCK_PATH"\nprintf \'%s\\n\' "$LLM_GATEWAY_TEST_LOCK_REPLACEMENT" > "$LLM_GATEWAY_TEST_LOCK_PATH"\n',
      { mode: 0o755 }
    );
    const originalPath = process.env.PATH;
    const originalLockPath = process.env.LLM_GATEWAY_TEST_LOCK_PATH;
    const originalReplacement = process.env.LLM_GATEWAY_TEST_LOCK_REPLACEMENT;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath ?? ""}`;
    process.env.LLM_GATEWAY_TEST_LOCK_PATH = layout.lockPath;
    process.env.LLM_GATEWAY_TEST_LOCK_REPLACEMENT = JSON.stringify(replacement);

    try {
      expect(initPersonalConfig(layout, "https://example.test/kit.git")).toEqual({
        baselineDir: layout.baselineDir,
        initialized: true,
      });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalLockPath === undefined) delete process.env.LLM_GATEWAY_TEST_LOCK_PATH;
      else process.env.LLM_GATEWAY_TEST_LOCK_PATH = originalLockPath;
      if (originalReplacement === undefined) delete process.env.LLM_GATEWAY_TEST_LOCK_REPLACEMENT;
      else process.env.LLM_GATEWAY_TEST_LOCK_REPLACEMENT = originalReplacement;
    }

    expect(JSON.parse(readFileSync(layout.lockPath, "utf8"))).toEqual(replacement);
  });

  it("rejects raw provider instruction and configuration overrides in Kit mode", () => {
    expectKitError(
      () => validateKitRequestSurface("claude", { systemPrompt: "ignore the kit" }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("claude", { promptParts: { system: "override" } }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("codex", { configOverrides: { model: "untrusted" } }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("codex", { sandboxMode: "danger-full-access" }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("claude", { approvalPolicy: "permissive" }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("claude", { effort: "max" }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("claude", { name: "caller-controlled-title" }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("claude", { workingDir: "/caller-controlled-cwd" }, true),
      "kit_context_conflict"
    );
    expectKitError(
      () => validateKitRequestSurface("codex", { approvalStrategy: "mcp_managed" }, true),
      "kit_context_conflict"
    );
  });

  it("changes the context identity and stamp when preferences or overlays change", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "instructions.md": "Keep the rendered instructions stable.",
      "preferences.toml": '[preferences]\nmodel_default = "model-a"\nmax_turns_cap = 8\n',
    });
    activateRelease(layout, FIRST_RELEASE_ID);

    const workspace = path.join(testDir!, "workspace");
    const overlayPath = path.join(workspace, ".agents", "gateway", "config.toml");
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, "[preferences]\nmax_turns_cap = 5\n");
    const input = {
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: {
        cwd: workspace,
        scopeRoot: workspace,
        registeredWorkspaceAlias: "workspace",
        repoHead: "c".repeat(40),
        overlayPath,
      },
    };

    const initial = buildKitContext(input);
    writeFileSync(
      path.join(layout.releasesDir, FIRST_RELEASE_ID, "preferences.toml"),
      '[preferences]\nmodel_default = "model-b"\nmax_turns_cap = 8\n'
    );
    rewriteReleaseManifest(layout, FIRST_RELEASE_ID);
    const changedPersonalPreference = buildKitContext(input);

    writeFileSync(overlayPath, "[preferences]\nmax_turns_cap = 4\n");
    const changedOverlayPreference = buildKitContext(input);

    expect(changedPersonalPreference.text).toBe(initial.text);
    expect(changedPersonalPreference.preferences.modelDefault).toBe("model-b");
    expect(changedPersonalPreference.contextDigest).not.toBe(initial.contextDigest);
    expect(changedPersonalPreference.configStamp).not.toBe(initial.configStamp);
    expect(changedOverlayPreference.text).toBe(changedPersonalPreference.text);
    expect(changedOverlayPreference.preferences.maxTurnsCap).toBe(4);
    expect(changedOverlayPreference.contextDigest).not.toBe(
      changedPersonalPreference.contextDigest
    );
    expect(changedOverlayPreference.configStamp).not.toBe(changedPersonalPreference.configStamp);
  });

  it.skipIf(process.platform !== "linux")(
    "rejects an overlay when a parent directory is swapped to an outside symlink during open",
    () => {
      const layout = newTestLayout();
      writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "trusted baseline" });
      activateRelease(layout, FIRST_RELEASE_ID);
      const workspace = path.join(testDir!, "workspace");
      const overlayPath = path.join(workspace, ".agents", "gateway", "config.toml");
      const gatewayDirectory = path.dirname(overlayPath);
      const movedGatewayDirectory = path.join(testDir!, "moved-gateway");
      const outsideDirectory = path.join(testDir!, "outside-overlay");
      mkdirSync(gatewayDirectory, { recursive: true });
      mkdirSync(outsideDirectory, { recursive: true });
      writeFileSync(overlayPath, "[preferences]\nmax_turns_cap = 5\n");
      writeFileSync(
        path.join(outsideDirectory, "config.toml"),
        "[preferences]\nmax_turns_cap = 1\n"
      );

      const originalOpenSync = fs.openSync;
      let replacementInjected = false;
      const openSpy = vi.spyOn(fs, "openSync").mockImplementation((target, flags, mode) => {
        if (!replacementInjected && target === overlayPath) {
          replacementInjected = true;
          renameSync(gatewayDirectory, movedGatewayDirectory);
          symlinkSync(outsideDirectory, gatewayDirectory);
        }
        return originalOpenSync(target, flags, mode);
      });
      syncBuiltinESMExports();

      try {
        expectKitError(
          () =>
            buildKitContext({
              layout,
              machine: { machineId: "machine-a", providers: {} },
              scope: {
                cwd: workspace,
                scopeRoot: workspace,
                registeredWorkspaceAlias: "workspace",
                repoHead: "c".repeat(40),
                overlayPath,
              },
            }),
          "kit_invalid_baseline"
        );
        expect(replacementInjected).toBe(true);
      } finally {
        openSpy.mockRestore();
        syncBuiltinESMExports();
      }
    }
  );

  it("partitions execution identity by the selected working folder", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "instructions.md": "Keep separate folders from sharing a native session.",
    });
    activateRelease(layout, FIRST_RELEASE_ID);

    const workspace = path.join(testDir!, "workspace");
    const firstFolder = path.join(workspace, "first");
    const secondFolder = path.join(workspace, "second");
    mkdirSync(firstFolder, { recursive: true });
    mkdirSync(secondFolder, { recursive: true });
    const baseScope = {
      scopeRoot: workspace,
      registeredWorkspaceAlias: "workspace",
      repoHead: "c".repeat(40),
      overlayPath: null,
    };
    const first = buildKitContext({
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: { ...baseScope, cwd: firstFolder },
    });
    const second = buildKitContext({
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: { ...baseScope, cwd: secondFolder },
    });

    expect(second.contextDigest).not.toBe(first.contextDigest);
    expect(second.configStamp).not.toBe(first.configStamp);
    expect(second.execution).not.toEqual(first.execution);
  });

  it("allows a repository overlay to tighten but not relax personal execution caps", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "instructions.md": "Keep caps safe.",
      "preferences.toml": "[preferences]\nmax_turns_cap = 8\nmax_budget_usd_cap = 4\n",
    });
    activateRelease(layout, FIRST_RELEASE_ID);

    const workspace = path.join(testDir!, "workspace");
    const overlayPath = path.join(workspace, ".agents", "gateway", "config.toml");
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, "[preferences]\nmax_turns_cap = 99\nmax_budget_usd_cap = 99\n");
    const input = {
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: {
        cwd: workspace,
        scopeRoot: workspace,
        registeredWorkspaceAlias: "workspace",
        repoHead: "c".repeat(40),
        overlayPath,
      },
    };

    expect(buildKitContext(input).preferences).toMatchObject({
      maxTurnsCap: 8,
      maxBudgetUsdCap: 4,
    });

    writeFileSync(overlayPath, "[preferences]\nmax_turns_cap = 5\nmax_budget_usd_cap = 2\n");
    expect(buildKitContext(input).preferences).toMatchObject({
      maxTurnsCap: 5,
      maxBudgetUsdCap: 2,
    });
  });

  it("uses a Kit-owned Codex sandbox and lets an overlay only tighten it", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "instructions.md": "Keep filesystem access deliberate.",
      "preferences.toml": '[preferences]\ncodex_sandbox_mode = "workspace-write"\n',
    });
    activateRelease(layout, FIRST_RELEASE_ID);

    const workspace = path.join(testDir!, "workspace");
    const overlayPath = path.join(workspace, ".agents", "gateway", "config.toml");
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, '[preferences]\ncodex_sandbox_mode = "read-only"\n');
    const context = buildKitContext({
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: {
        cwd: workspace,
        scopeRoot: workspace,
        registeredWorkspaceAlias: "workspace",
        repoHead: "c".repeat(40),
        overlayPath,
      },
    });

    expect(resolveCodexKitSandboxMode({})).toBe("workspace-write");
    expect(resolveCodexKitSandboxMode(context.preferences)).toBe("read-only");

    writeFileSync(overlayPath, '[preferences]\ncodex_sandbox_mode = "workspace-write"\n');
    writeFileSync(
      path.join(layout.releasesDir, FIRST_RELEASE_ID, "preferences.toml"),
      '[preferences]\ncodex_sandbox_mode = "read-only"\n'
    );
    rewriteReleaseManifest(layout, FIRST_RELEASE_ID);
    expect(
      resolveCodexKitSandboxMode(
        buildKitContext({
          layout,
          machine: { machineId: "machine-a", providers: {} },
          scope: {
            cwd: workspace,
            scopeRoot: workspace,
            registeredWorkspaceAlias: "workspace",
            repoHead: "c".repeat(40),
            overlayPath,
          },
        }).preferences
      )
    ).toBe("read-only");
  });

  it("rejects an unsafe Codex sandbox preference", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "preferences.toml": '[preferences]\ncodex_sandbox_mode = "danger-full-access"\n',
    });
    activateRelease(layout, FIRST_RELEASE_ID);
    expectKitError(
      () =>
        buildKitContext({
          layout,
          machine: { machineId: "machine-a", providers: {} },
          scope: {
            cwd: testDir!,
            scopeRoot: null,
            registeredWorkspaceAlias: null,
            repoHead: null,
            overlayPath: null,
          },
        }),
      "kit_invalid_baseline"
    );
  });

  it("honours baseline output formats only where the provider supports them", () => {
    expect(resolveClaudeKitOutputFormat({})).toBe("stream-json");
    expect(resolveCodexKitOutputFormat({})).toBe("text");
    expect(resolveClaudeKitOutputFormat({ outputFormatDefault: "json" })).toBe("json");
    expect(resolveCodexKitOutputFormat({ outputFormatDefault: "json" })).toBe("json");
  });

  it("rejects an unsupported baseline output format", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "preferences.toml": '[preferences]\noutput_format_default = "stream-json"\n',
    });
    activateRelease(layout, FIRST_RELEASE_ID);
    expectKitError(
      () =>
        buildKitContext({
          layout,
          machine: { machineId: "machine-a", providers: {} },
          scope: {
            cwd: testDir!,
            scopeRoot: null,
            registeredWorkspaceAlias: null,
            repoHead: null,
            overlayPath: null,
          },
        }),
      "kit_invalid_baseline"
    );
  });

  it("fails closed for malformed recognized baseline preferences", () => {
    const layout = newTestLayout();
    const malformedPreferences = [
      'model_default = ""\n',
      "model_default = 42\n",
      'model_default = "model name"\n',
      'model_default = "model\\nname"\n',
      `model_default = "${"a".repeat(129)}"\n`,
      "max_turns_cap = 0\n",
      "max_turns_cap = 1.5\n",
      "max_turns_cap = 10001\n",
      'max_turns_cap = "12"\n',
      "max_budget_usd_cap = 0\n",
      "max_budget_usd_cap = 10001\n",
      'max_budget_usd_cap = "5"\n',
    ];
    for (const preferencesToml of malformedPreferences) {
      writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "preferences.toml": preferencesToml });
      activateRelease(layout, FIRST_RELEASE_ID);
      expectKitError(
        () =>
          buildKitContext({
            layout,
            machine: { machineId: "machine-a", providers: {} },
            scope: {
              cwd: testDir!,
              scopeRoot: null,
              registeredWorkspaceAlias: null,
              repoHead: null,
              overlayPath: null,
            },
          }),
        "kit_invalid_baseline"
      );
    }
  });

  it("fails closed for unknown baseline and repository overlay preferences", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "preferences.toml": '[preferences]\ncodex_sandbox_mdoe = "read-only"\n',
    });
    activateRelease(layout, FIRST_RELEASE_ID);
    const workspace = path.join(testDir!, "workspace");
    const overlayPath = path.join(workspace, ".agents", "gateway", "config.toml");
    const input = {
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: {
        cwd: workspace,
        scopeRoot: workspace,
        registeredWorkspaceAlias: null,
        repoHead: null,
        overlayPath,
      },
    };
    expectKitError(() => buildKitContext(input), "kit_invalid_baseline");

    writeFileSync(
      path.join(layout.releasesDir, FIRST_RELEASE_ID, "preferences.toml"),
      '[preferences]\ncodex_sandbox_mode = "read-only"\n'
    );
    rewriteReleaseManifest(layout, FIRST_RELEASE_ID);
    mkdirSync(path.dirname(overlayPath), { recursive: true });
    writeFileSync(overlayPath, "[preferences]\nmax_turn_cap = 1\n");
    expectKitError(() => buildKitContext(input), "kit_invalid_baseline");

    writeFileSync(overlayPath, '[preference]\ncodex_sandbox_mode = "read-only"\n');
    expectKitError(() => buildKitContext(input), "kit_invalid_baseline");

    writeFileSync(overlayPath, "");
    writeFileSync(
      path.join(layout.releasesDir, FIRST_RELEASE_ID, "config.toml"),
      '[preference]\ncodex_sandbox_mode = "read-only"\n'
    );
    rewriteReleaseManifest(layout, FIRST_RELEASE_ID);
    expectKitError(() => buildKitContext(input), "kit_invalid_baseline");
  });

  it("rejects insecure or unsafe Git remotes before baseline creation", () => {
    const layout = newTestLayout();
    for (const remote of [
      "ext::sh -c touch /tmp/should-not-run",
      "helper::example",
      "file:///tmp/baseline",
      "git://example.test/repo.git",
      "https://token@example.test/repo.git",
      "C:baseline",
      "git@example.test:repo;touch",
      "https://example.test/repo.git\nextra",
      " https://example.test/repo.git",
      "https://safe.test\\@evil.test/repo.git",
    ]) {
      expectKitError(() => initPersonalConfig(layout, remote), "kit_invalid_baseline");
      expect(existsSync(layout.baselineDir)).toBe(false);
    }
    expect(validatePersonalConfigRemote("https://example.test/repo.git")).toBe(
      "https://example.test/repo.git"
    );
    expect(validatePersonalConfigRemote("ssh://git@example.test/team/repo.git")).toBe(
      "ssh://git@example.test/team/repo.git"
    );
    expect(validatePersonalConfigRemote("git@example.test:team/repo.git")).toBe(
      "git@example.test:team/repo.git"
    );
    for (const remote of [
      "https://example.test/repo.git?revision=untrusted",
      "ssh://git@example.test/team/repo.git#untrusted",
    ]) {
      expectKitError(() => validatePersonalConfigRemote(remote), "kit_invalid_baseline");
    }
    expectKitError(
      () => validatePersonalConfigRemote("ssh://git@-example.test/team/repo.git"),
      "kit_invalid_baseline"
    );
    expectKitError(
      () => validatePersonalConfigRemote("git@-example.test:team/repo.git"),
      "kit_invalid_baseline"
    );
  });

  it("reaps only an aged artifact whose owner job is positively absent", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, {
      "instructions.md": "Keep the rendered instructions stable.",
    });
    activateRelease(layout, FIRST_RELEASE_ID);
    const context = buildKitContext({
      layout,
      machine: { machineId: "machine-a", providers: {} },
      scope: {
        cwd: testDir!,
        scopeRoot: null,
        registeredWorkspaceAlias: null,
        repoHead: null,
        overlayPath: null,
      },
    });
    const now = Date.now();
    const agedAt = new Date(now - 24 * 60 * 60 * 1000 - 1_000);

    const missing = createClaudeContextArtifact(layout, context);
    missing.bindToJob("a".repeat(32));
    utimesSync(missing.path, agedAt, agedAt);
    expect(reapClaudeContextArtifacts(layout, () => "not_found", now)).toBe(1);
    expect(existsSync(missing.path)).toBe(false);

    const unavailable = createClaudeContextArtifact(layout, context);
    unavailable.bindToJob("b".repeat(32));
    utimesSync(unavailable.path, agedAt, agedAt);
    expect(reapClaudeContextArtifacts(layout, () => "unavailable", now)).toBe(0);
    expect(existsSync(unavailable.path)).toBe(true);
  });

  it("fails closed when a local machine binding is corrupt", () => {
    const layout = newTestLayout();
    mkdirSync(path.dirname(layout.localTomlPath), { recursive: true });
    writeFileSync(layout.localTomlPath, "machine_id = 42\n");
    const corruptBinding = readFileSync(layout.localTomlPath, "utf8");

    expectKitError(() => ensureLocalMachineBinding(layout), "kit_invalid_baseline");
    expect(readFileSync(layout.localTomlPath, "utf8")).toBe(corruptBinding);
  });

  it("builds diagnostic context without acquiring the execution lock", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "diagnostic context" });
    activateRelease(layout, FIRST_RELEASE_ID, { lastSuccessAt: new Date().toISOString() });
    const machine = ensureLocalMachineBinding(layout);
    const manager = new PersonalConfigManager(
      { enabled: true, baselinePath: layout.baselineDir, maxStaleHours: 24 },
      layout
    );

    const context = manager.buildContextReadOnly({
      machine,
      scope: {
        cwd: testDir!,
        scopeRoot: null,
        registeredWorkspaceAlias: null,
        repoHead: null,
        overlayPath: null,
      },
    });

    expect(context.release.id).toBe(FIRST_RELEASE_ID);
    expect(existsSync(layout.lockPath)).toBe(false);
  });

  it("rejects traversal release identifiers and retains the verified release", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "verified" });
    activateRelease(layout, FIRST_RELEASE_ID);

    writeFileSync(layout.currentPointerPath, '{"releaseId":"../../outside"}\n');
    expect(getCurrentPersonalConfigRelease(layout)?.id).toBe(FIRST_RELEASE_ID);
    expectKitError(() => rollbackPersonalConfig(layout, "../../outside"), "kit_release_missing");
    expect(getCurrentPersonalConfigRelease(layout)?.id).toBe(FIRST_RELEASE_ID);
  });

  it("binds a one-time stale acknowledgement to the active release", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "verified" });
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    activateRelease(layout, FIRST_RELEASE_ID, {
      lastSuccessAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });

    const acknowledged = acknowledgeKitStale(layout, 1, now);
    expect(acknowledged.staleAckReleaseId).toBe(FIRST_RELEASE_ID);
    expect(acknowledged.staleAckUsedForReleaseId).toBe(FIRST_RELEASE_ID);
    expect(isKitStale(acknowledged, 1, now + 23 * 60 * 60 * 1000, FIRST_RELEASE_ID)).toBe(false);
    expect(isKitStale(acknowledged, 1, now + 1, SECOND_RELEASE_ID)).toBe(true);
    expectKitError(() => acknowledgeKitStale(layout, 1, now + 25 * 60 * 60 * 1000), "kit_stale");
  });

  it("does not renew stale acknowledgements through rollback cycles without a sync", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "first release" });
    writeVerifiedRelease(layout, SECOND_RELEASE_ID, { "instructions.md": "second release" });
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    activateRelease(layout, FIRST_RELEASE_ID, {
      lastSuccessAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });

    const firstAcknowledgement = acknowledgeKitStale(layout, 1, now);
    expect(firstAcknowledgement.staleAckUsedForReleaseId).toBe(FIRST_RELEASE_ID);
    expect(firstAcknowledgement.staleAckUsedForReleaseIds).toEqual([FIRST_RELEASE_ID]);

    rollbackPersonalConfig(layout, SECOND_RELEASE_ID);
    const secondAcknowledgement = acknowledgeKitStale(layout, 1, now + 1);
    expect(secondAcknowledgement.staleAckUsedForReleaseId).toBe(SECOND_RELEASE_ID);
    expect(secondAcknowledgement.staleAckUsedForReleaseIds).toEqual([
      FIRST_RELEASE_ID,
      SECOND_RELEASE_ID,
    ]);

    rollbackPersonalConfig(layout, FIRST_RELEASE_ID);
    expectKitError(() => acknowledgeKitStale(layout, 1, now + 2), "kit_stale");
  });

  it("fails closed for incomplete legacy stale acknowledgement history", () => {
    const layout = newTestLayout();
    writeVerifiedRelease(layout, FIRST_RELEASE_ID, { "instructions.md": "first release" });
    const now = Date.parse("2026-07-14T12:00:00.000Z");
    activateRelease(layout, FIRST_RELEASE_ID, {
      lastSuccessAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
    });
    writeFileSync(
      layout.statePath,
      `${JSON.stringify({
        currentReleaseId: FIRST_RELEASE_ID,
        lastSuccessAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
        lastSyncError: null,
        staleAckUntil: null,
        staleAckReleaseId: null,
        staleAckUsedForReleaseId: SECOND_RELEASE_ID,
      })}\n`
    );

    expectKitError(() => acknowledgeKitStale(layout, 1, now), "kit_stale");
  });
});
