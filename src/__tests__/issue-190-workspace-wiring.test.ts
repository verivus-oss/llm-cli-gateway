import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AsyncJobManager,
  type AsyncJobErrorCategory,
  type AsyncJobResult,
  type AsyncJobSnapshot,
} from "../async-job-manager.js";
import { CLI_INPUT_TOO_LARGE_CATEGORY, CLI_INVALID_INPUT_CATEGORY } from "../cli-input-limits.js";
import { defaultLeastCostConfig, type PersistenceConfig } from "../config.js";
import { createGatewayServer } from "../index.js";
import { MemoryJobStore, SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  getRequestContext,
  resolveOwnerPrincipal,
  runWithRequestContext,
} from "../request-context.js";
import { DEFAULT_REVIEW_PROMPT_MAX_BYTES } from "../review-prompt.js";
import { DEFAULT_REVIEW_ARTIFACT_MAX_BYTES } from "../review-scope.js";
import { FileSessionManager } from "../session-manager.js";
import { removeWorktree } from "../worktree-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

vi.mock("../provider-status.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../provider-status.js")>();
  return {
    ...actual,
    getProviderRuntimeStatus: (provider: string) => ({
      provider,
      displayName: provider,
      command: provider,
      installed: true,
      version: `${provider}-test`,
      versionCommand: [provider, "--version"],
      loginStatus: "authenticated",
      loginCheck: {
        method: "not_checked",
        command: null,
        credentialStore: "not_checked",
        detail: "test runtime",
      },
      guidance: {
        provider,
        displayName: provider,
        install: { summary: "install", commands: [] },
        login: { summary: "login", commands: [], credentialHandling: "none" },
        verification: { command: `${provider} --version`, expected: "test" },
      },
    }),
  };
});

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    gatewaySessionId?: string;
    resumable?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

function registeredTools(
  server: ReturnType<typeof createGatewayServer>
): Record<string, RegisteredTool> {
  return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

function persistence(): PersistenceConfig {
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

function workspaceRegistry(
  repository: string,
  providers: WorkspaceRegistry["repos"][number]["providers"],
  defaultAlias: string | null = null
): WorkspaceRegistry {
  return {
    enabled: true,
    defaultAlias,
    allowUnregisteredWorkingDir: false,
    repos: [
      {
        alias: "review",
        path: repository,
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

function forceGitWorktreeRemoveFailure(): () => void {
  const originalPath = process.env.PATH;
  const gitBinary = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const fakeBin = mkdtempSync(join(tmpdir(), "issue-190-remove-failure-"));
  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/bin/sh\ncase " $* " in\n  *" worktree remove "*) exit 42 ;;\nesac\nexec "${gitBinary}" "$@"\n`
  );
  chmodSync(fakeGit, 0o755);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
  };
}

interface StartCall {
  cli: string;
  cwd: string | undefined;
  args: string[];
}

class CapturingJobManager extends AsyncJobManager {
  readonly starts: StartCall[] = [];
  private readonly capturedResults = new Map<string, AsyncJobResult>();
  private readonly capturedOwners = new Map<string, string>();

  override startJob(
    ...args: Parameters<AsyncJobManager["startJob"]>
  ): ReturnType<AsyncJobManager["startJob"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3] });
    return this.snapshot(args[0], args[2]);
  }

  override startJobWithDedup(
    ...args: Parameters<AsyncJobManager["startJobWithDedup"]>
  ): ReturnType<AsyncJobManager["startJobWithDedup"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3].cwd });
    const snapshot = this.snapshot(args[0], args[2]);
    this.capturedOwners.set(snapshot.id, resolveOwnerPrincipal(getRequestContext()));
    this.capturedResults.set(snapshot.id, {
      ...snapshot,
      status: "completed",
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      stdoutBytes: 8,
      stdout: "complete",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutOffsetChars: 0,
      stdoutTotalChars: 8,
      stdoutNextOffsetChars: null,
      stderrOffsetChars: 0,
      stderrTotalChars: 0,
      stderrNextOffsetChars: null,
    });

    const admission = args[3].validationAdmission;
    if (admission) {
      const store = this.getValidationRunStore();
      if (!store) throw new Error("test fixture requires a durable validation-run store");
      const link = {
        provider: admission.provider,
        jobId: snapshot.id,
        correlationId: snapshot.correlationId,
      };
      if (admission.role === "judge") {
        store.setValidationJudgeLink(admission.validationId, link);
      } else {
        const run = store.getValidationRun(admission.validationId);
        if (!run) throw new Error("test fixture could not find the review run");
        store.setValidationProviderLinks(admission.validationId, [...run.providerLinks, link]);
      }
    }

    return {
      snapshot,
      deduped: false,
      ...(args[3].deferLaunch
        ? {
            deferredLaunch: {
              release: () => undefined,
              cancel: () => true,
            },
          }
        : {}),
    };
  }

  override getJobOwner(jobId: string): string | null | undefined {
    return this.capturedOwners.get(jobId) ?? super.getJobOwner(jobId);
  }

  override getJobResult(jobId: string): AsyncJobResult | null {
    return this.capturedResults.get(jobId) ?? super.getJobResult(jobId);
  }

  private snapshot(cli: string, correlationId: string): AsyncJobSnapshot {
    return {
      id: `job-${this.starts.length}`,
      cli,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      correlationId,
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error: null,
      exited: false,
      progress: {
        capability: "activity_only",
        lastActivityAt: new Date().toISOString(),
        lastSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
  }
}

class CompletingJobManager extends CapturingJobManager {
  private completed: AsyncJobSnapshot | null = null;

  override startJobWithDedup(
    ...args: Parameters<AsyncJobManager["startJobWithDedup"]>
  ): ReturnType<AsyncJobManager["startJobWithDedup"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3].cwd });
    this.completed = {
      id: "completed-job",
      cli: args[0],
      status: "completed",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      exitCode: 0,
      correlationId: args[2],
      outputTruncated: false,
      stdoutBytes: 8,
      stderrBytes: 0,
      error: null,
      exited: true,
      progress: {
        capability: "activity_only",
        lastActivityAt: new Date(1).toISOString(),
        lastSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
    return { snapshot: this.completed, deduped: false };
  }

  override getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    return this.completed?.id === jobId ? this.completed : null;
  }

  override getJobResult(jobId: string): AsyncJobResult | null {
    if (!this.completed || this.completed.id !== jobId) return null;
    return {
      ...this.completed,
      stdout: "complete",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutOffsetChars: 0,
      stdoutTotalChars: 8,
      stdoutNextOffsetChars: null,
      stderrOffsetChars: 0,
      stderrTotalChars: 0,
      stderrNextOffsetChars: null,
    };
  }
}

class RejectingJobManager extends CapturingJobManager {
  override startJob(
    ...args: Parameters<AsyncJobManager["startJob"]>
  ): ReturnType<AsyncJobManager["startJob"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3] });
    throw new Error("job admission rejected");
  }
}

class ClassifiedFailureJobManager extends CapturingJobManager {
  private completed: AsyncJobSnapshot | null = null;

  constructor(readonly category: AsyncJobErrorCategory) {
    super(noopLogger, undefined, new MemoryJobStore());
  }

  override startJobWithDedup(
    ...args: Parameters<AsyncJobManager["startJobWithDedup"]>
  ): ReturnType<AsyncJobManager["startJobWithDedup"]> {
    this.starts.push({ cli: args[0], args: [...args[1]], cwd: args[3].cwd });
    this.completed = {
      id: "classified-failure-job",
      cli: args[0],
      status: "failed",
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      exitCode: 126,
      correlationId: args[2],
      outputTruncated: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      error:
        this.category === CLI_INPUT_TOO_LARGE_CATEGORY
          ? "grok argv is too large for the provider CLI argv transport. The gateway will not truncate instructions."
          : "grok argv cannot be passed to the provider CLI because it contains an embedded NUL byte.",
      errorCategory: this.category,
      retryable: false,
      exited: true,
      progress: {
        capability: "activity_only",
        lastActivityAt: new Date(1).toISOString(),
        lastSeq: 0,
        droppedCount: 0,
        events: [],
      },
    };
    return { snapshot: this.completed, deduped: false };
  }

  override getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    return this.completed?.id === jobId ? this.completed : null;
  }

  override getJobResult(jobId: string): AsyncJobResult | null {
    if (!this.completed || this.completed.id !== jobId) return null;
    return {
      ...this.completed,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutOffsetChars: 0,
      stdoutTotalChars: 0,
      stdoutNextOffsetChars: null,
      stderrOffsetChars: 0,
      stderrTotalChars: 0,
      stderrNextOffsetChars: null,
    };
  }
}

const remoteContext = {
  transport: "http" as const,
  authKind: "gateway_bearer" as const,
  authScopes: ["mcp"],
};

describe("issue #190 workspace wiring", () => {
  let root: string;
  let repository: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gateway-issue-190-"));
    repository = join(root, "repository");
    execFileSync("mkdir", ["-p", repository]);
    execFileSync("git", ["init", "-b", "main"], { cwd: repository, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "review@example.invalid"], {
      cwd: repository,
    });
    execFileSync("git", ["config", "user.name", "Review Test"], { cwd: repository });
    writeFileSync(join(repository, "tracked.txt"), "baseline\n");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "baseline"], { cwd: repository, stdio: "ignore" });
    execFileSync("mkdir", ["-p", join(repository, "src")]);
    execFileSync("mkdir", ["-p", join(repository, "auxiliary")]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function server(
    workspaces: WorkspaceRegistry,
    manager: CapturingJobManager,
    leastCostEnabled = false,
    sessionManager = new FileSessionManager(join(root, "sessions.json"))
  ): ReturnType<typeof createGatewayServer> {
    return createGatewayServer({
      workspaces,
      asyncJobManager: manager,
      sessionManager,
      persistence: persistence(),
      leastCost: { ...defaultLeastCostConfig(), enabled: leastCostEnabled },
    });
  }

  it.each(["devin_request", "devin_request_async"])(
    "fails closed before %s can spawn for a remote request without a registered workspace",
    async toolName => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(disabledWorkspaces(), manager);

      const response = await runWithRequestContext(remoteContext, () =>
        registeredTools(gateway)[toolName].handler(
          { prompt: "inspect", approvalStrategy: "legacy", optimizePrompt: false },
          {}
        )
      );

      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain("Remote HTTP provider requests require");
      expect(manager.starts).toHaveLength(0);
      await gateway.close();
    }
  );

  it("passes an authorized workspace cwd to direct Devin async execution", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = server(workspaceRegistry(repository, ["devin"]), manager);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).devin_request_async.handler(
        {
          prompt: "inspect",
          approvalStrategy: "legacy",
          optimizePrompt: false,
          workspace: "review",
        },
        {}
      )
    );

    expect(response.isError).not.toBe(true);
    expect(manager.starts).toEqual([expect.objectContaining({ cli: "devin", cwd: repository })]);
    await gateway.close();
  });

  it("persists the selected workspace on a session minted after successful sync Devin execution", async () => {
    const manager = new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "sync-devin-sessions.json"));
    const gateway = server(workspaceRegistry(repository, ["devin"]), manager, false, sessions);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).devin_request.handler(
        {
          prompt: "inspect",
          approvalStrategy: "legacy",
          optimizePrompt: false,
          workspace: "review",
        },
        {}
      )
    );

    expect(response.isError).not.toBe(true);
    expect(sessions.listSessions("devin")).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceAlias: "review",
          workspaceRoot: repository,
        }),
      }),
    ]);
    await gateway.close();
  });

  it.each(["workingDir", "worktree"] as const)(
    "rejects Devin ACP's CLI-only %s field instead of ignoring it",
    async field => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(disabledWorkspaces(), manager);
      const value = field === "workingDir" ? repository : true;

      const response = await registeredTools(gateway).devin_request.handler(
        {
          prompt: "inspect",
          transport: "acp",
          approvalStrategy: "legacy",
          optimizePrompt: false,
          [field]: value,
        },
        {}
      );

      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain("transport=acp");
      expect(response.content[0]?.text).toContain(field);
      expect(manager.starts).toHaveLength(0);
      await gateway.close();
    }
  );

  it("fails closed for cwd-scoped Devin continuation without a stable cwd selection", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = server(disabledWorkspaces(), manager);

    const response = await registeredTools(gateway).devin_request_async.handler(
      {
        prompt: "continue",
        resumeLatest: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toMatch(/workingDir|workspace/);
    expect(manager.starts).toHaveLength(0);
    await gateway.close();
  });

  it.each(["claude_request", "claude_request_async"])(
    "fails closed before unscoped Claude --continue can spawn through %s",
    async toolName => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(disabledWorkspaces(), manager);

      const response = await registeredTools(gateway)[toolName].handler(
        {
          prompt: "continue",
          outputFormat: "text",
          continueSession: true,
          createNewSession: false,
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
        },
        {}
      );

      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain("latest-session continuation requires");
      expect(response.content[0]?.text).toMatch(/workingDir|workspace/);
      expect(manager.starts).toHaveLength(0);
      await gateway.close();
    }
  );

  it.each(["claude_request", "claude_request_async"])(
    "fails closed before an unscoped worktree request can spawn through %s",
    async toolName => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(disabledWorkspaces(), manager);

      const response = await registeredTools(gateway)[toolName].handler(
        {
          prompt: "inspect",
          outputFormat: "text",
          worktree: true,
          continueSession: false,
          createNewSession: false,
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
        },
        {}
      );

      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toMatch(/worktree/i);
      expect(response.content[0]?.text).toMatch(/workspace|repository root/i);
      expect(manager.starts).toHaveLength(0);
      await gateway.close();
    }
  );

  it.each(["claude_request", "claude_request_async"])(
    "does not reuse an owned legacy worktree without a workspace binding through %s",
    async toolName => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${toolName}-legacy-sessions.json`));
      const session = sessions.createSession("claude", "legacy-unscoped-worktree");
      sessions.updateSessionMetadata(session.id, { worktreePath: repository });
      const gateway = server(disabledWorkspaces(), manager, false, sessions);

      const response = await registeredTools(gateway)[toolName].handler(
        {
          prompt: "inspect",
          outputFormat: "text",
          sessionId: session.id,
          worktree: true,
          continueSession: false,
          createNewSession: false,
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
        },
        {}
      );

      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toMatch(/worktree/i);
      expect(response.content[0]?.text).toMatch(/workspace/i);
      expect(manager.starts).toHaveLength(0);
      await gateway.close();
    }
  );

  it.each(["cursor_request", "cursor_request_async"])(
    "preserves a relative Cursor saved-workspace name through %s without deriving cwd from the gateway process",
    async toolName => {
      const originalCwd = process.cwd();
      const savedWorkspaceName = "saved-workspace";
      execFileSync("mkdir", ["-p", join(repository, savedWorkspaceName)]);
      process.chdir(repository);
      const manager =
        toolName === "cursor_request"
          ? new CompletingJobManager(noopLogger, undefined, new MemoryJobStore())
          : new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(disabledWorkspaces(), manager);

      try {
        const response = await registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            workspace: savedWorkspaceName,
            outputFormat: "text",
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        );

        expect(response.isError).not.toBe(true);
        expect(manager.starts).toHaveLength(1);
        expect(manager.starts[0]).toEqual(
          expect.objectContaining({ cli: "cursor", cwd: undefined })
        );
        expect(manager.starts[0].args).toEqual(
          expect.arrayContaining(["--workspace", savedWorkspaceName])
        );
        expect(manager.starts[0].args).not.toContain(join(repository, savedWorkspaceName));
      } finally {
        process.chdir(originalCwd);
        await gateway.close();
      }
    }
  );

  it.each(["cursor_request", "cursor_request_async"] as const)(
    "passes a relative Cursor saved-workspace name through %s from the gateway app directory",
    async toolName => {
      const manager =
        toolName === "cursor_request"
          ? new CompletingJobManager(noopLogger, undefined, new MemoryJobStore())
          : new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(
        join(root, `${toolName}-saved-workspace-sessions.json`)
      );
      const gateway = server(disabledWorkspaces(), manager, false, sessions);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(homedir(), ".llm-cli-gateway"));

      try {
        const response = await registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            workspace: "saved-workspace",
            outputFormat: "text",
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        );

        expect(response.isError).not.toBe(true);
        expect(manager.starts).toHaveLength(1);
        expect(manager.starts[0]).toEqual(
          expect.objectContaining({ cli: "cursor", cwd: undefined })
        );
        expect(manager.starts[0].args).toEqual(
          expect.arrayContaining(["--workspace", "saved-workspace"])
        );
      } finally {
        cwdSpy.mockRestore();
        await gateway.close();
      }
    }
  );

  it.each(["cursor_request", "cursor_request_async"] as const)(
    "retains the unscoped gateway app-directory safeguard through %s without minting a session",
    async toolName => {
      const manager =
        toolName === "cursor_request"
          ? new CompletingJobManager(noopLogger, undefined, new MemoryJobStore())
          : new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${toolName}-unscoped-sessions.json`));
      const gateway = server(disabledWorkspaces(), manager, false, sessions);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(homedir(), ".llm-cli-gateway"));

      try {
        const response = await registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            outputFormat: "text",
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        );

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain("No workspace selected");
        expect(manager.starts).toHaveLength(0);
        expect(sessions.listSessions("cursor")).toEqual([]);
      } finally {
        cwdSpy.mockRestore();
        await gateway.close();
      }
    }
  );

  it("persists an admitted Cursor async workspace on its newly minted session", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "cursor-async-workspace-sessions.json"));
    const gateway = server(workspaceRegistry(repository, ["cursor"]), manager, false, sessions);

    const response = await registeredTools(gateway).cursor_request_async.handler(
      {
        prompt: "inspect",
        workspace: "review",
        outputFormat: "text",
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
      {}
    );

    expect(response.isError).not.toBe(true);
    expect(manager.starts).toEqual([expect.objectContaining({ cli: "cursor", cwd: repository })]);
    expect(sessions.listSessions("cursor")).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceAlias: "review",
          workspaceRoot: repository,
        }),
      }),
    ]);
    await gateway.close();
  });

  it("updates Claude async usage for the effective active session after job admission", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "claude-async-effective-usage.json"));
    const active = sessions.createSession("claude", "active", "claude-active-session");
    sessions.setActiveSession("claude", active.id);
    const updateUsage = vi.spyOn(sessions, "updateSessionUsage");
    const gateway = server(workspaceRegistry(repository, ["claude"]), manager, false, sessions);

    const response = await registeredTools(gateway).claude_request_async.handler(
      {
        prompt: "inspect",
        outputFormat: "text",
        continueSession: false,
        createNewSession: false,
        dangerouslySkipPermissions: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        strictMcpConfig: false,
        optimizePrompt: false,
        workspace: "review",
      },
      {}
    );

    expect(response.isError).not.toBe(true);
    expect(JSON.parse(response.content[0]!.text)).toMatchObject({ sessionId: active.id });
    expect(updateUsage).toHaveBeenCalledWith(active.id);
    await gateway.close();
  });

  it("updates Codex async usage for its generated effective session after job admission", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "codex-async-effective-usage.json"));
    const updateUsage = vi.spyOn(sessions, "updateSessionUsage");
    const gateway = server(workspaceRegistry(repository, ["codex"]), manager, false, sessions);

    const response = await registeredTools(gateway).codex_request_async.handler(
      {
        prompt: "inspect",
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        createNewSession: true,
        optimizePrompt: false,
        outputFormat: "text",
        workspace: "review",
      },
      {}
    );

    expect(response.isError).not.toBe(true);
    const body = JSON.parse(response.content[0]!.text) as { sessionId?: string };
    expect(body.sessionId).toMatch(/^gw-/);
    expect(updateUsage).toHaveBeenCalledWith(body.sessionId);
    await gateway.close();
  });

  it("keeps the injected Codex active session through sync workspace admission", async () => {
    const manager = new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "codex-sync-active-session.json"));
    const active = sessions.createSession("codex", "active", "gw-codex-active-session");
    sessions.setActiveSession("codex", active.id);
    const updateUsage = vi.spyOn(sessions, "updateSessionUsage");
    const gateway = server(workspaceRegistry(repository, ["codex"]), manager, false, sessions);

    const response = await registeredTools(gateway).codex_request.handler(
      {
        prompt: "inspect",
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        createNewSession: false,
        optimizePrompt: false,
        outputFormat: "text",
        workspace: "review",
      },
      {}
    );

    expect(response.isError).not.toBe(true);
    expect(response).toMatchObject({ sessionId: active.id });
    expect(updateUsage).toHaveBeenCalledWith(active.id);
    expect(manager.starts).toEqual([expect.objectContaining({ cli: "codex", cwd: repository })]);
    await gateway.close();
  });

  it("cleans a Codex sync output-schema artifact when session lookup fails", async () => {
    const manager = new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "codex-sync-cleanup.json"));
    vi.spyOn(sessions, "getSession").mockImplementation(() => {
      throw new Error("session read failed");
    });
    const gateway = server(workspaceRegistry(repository, ["codex"]), manager, false, sessions);
    const schemasBefore = readdirSync(tmpdir()).filter(name => name.startsWith("codex-schema-"));

    const response = await registeredTools(gateway).codex_request.handler(
      {
        prompt: "inspect",
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        sessionId: "codex-cleanup-session",
        createNewSession: false,
        optimizePrompt: false,
        outputFormat: "text",
        outputSchema: { type: "object" },
        workspace: "review",
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("session read failed");
    expect(manager.starts).toHaveLength(0);
    expect(readdirSync(tmpdir()).filter(name => name.startsWith("codex-schema-"))).toEqual(
      schemasBefore
    );
    await gateway.close();
  });

  it.each([
    { provider: "grok" as const, toolName: "grok_request" },
    { provider: "grok" as const, toolName: "grok_request_async" },
    { provider: "devin" as const, toolName: "devin_request" },
    { provider: "devin" as const, toolName: "devin_request_async" },
    { provider: "cursor" as const, toolName: "cursor_request" },
    { provider: "cursor" as const, toolName: "cursor_request_async" },
    { provider: "mistral" as const, toolName: "mistral_request" },
    { provider: "mistral" as const, toolName: "mistral_request_async" },
  ])(
    "labels fresh $toolName identifiers as non-resumable gateway tracking IDs",
    async ({ provider, toolName }) => {
      const manager = toolName.endsWith("_async")
        ? new CapturingJobManager(noopLogger, undefined, new MemoryJobStore())
        : new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${toolName}-tracking-only.json`));
      const gateway = server(workspaceRegistry(repository, [provider]), manager, false, sessions);

      const response = await registeredTools(gateway)[toolName].handler(
        {
          prompt: "inspect",
          resumeLatest: false,
          createNewSession: false,
          outputFormat: provider === "grok" ? "plain" : "text",
          approvalStrategy: "legacy",
          optimizePrompt: false,
          workspace: "review",
        },
        {}
      );

      expect(response.isError).not.toBe(true);
      if (toolName.endsWith("_async")) {
        const body = JSON.parse(response.content[0]!.text) as {
          sessionId?: string;
          gatewaySessionId?: string;
          resumable?: boolean;
        };
        expect(body.gatewaySessionId).toMatch(/^gw-/);
        expect(body.sessionId).toBe(body.gatewaySessionId);
        expect(body.resumable).toBe(false);
      } else {
        expect(response.gatewaySessionId).toMatch(/^gw-/);
        expect(response.resumable).toBe(false);
        expect(response.structuredContent).toMatchObject({
          sessionId: response.gatewaySessionId,
          gatewaySessionId: response.gatewaySessionId,
          resumable: false,
        });
      }
      await gateway.close();
    }
  );

  it.each([
    { provider: "grok" as const, toolName: "grok_request_async" },
    { provider: "devin" as const, toolName: "devin_request_async" },
    { provider: "mistral" as const, toolName: "mistral_request_async" },
  ])(
    "rejects unscoped $provider async admission before minting a session",
    async ({ provider, toolName }) => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${provider}-unscoped-sessions.json`));
      const gateway = server(disabledWorkspaces(), manager, false, sessions);
      const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(join(homedir(), ".llm-cli-gateway"));

      try {
        const response = await registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            resumeLatest: false,
            createNewSession: false,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        );

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain("No workspace selected");
        expect(manager.starts).toHaveLength(0);
        expect(sessions.listSessions(provider)).toEqual([]);
      } finally {
        cwdSpy.mockRestore();
        await gateway.close();
      }
    }
  );

  it.each([
    {
      provider: "claude" as const,
      toolName: "claude_request_async",
      auxiliary: { addDir: ["auxiliary"] },
    },
    {
      provider: "codex" as const,
      toolName: "codex_request_async",
      auxiliary: { addDir: ["auxiliary"] },
    },
    {
      provider: "gemini" as const,
      toolName: "gemini_request_async",
      auxiliary: { includeDirs: ["auxiliary"] },
    },
    {
      provider: "mistral" as const,
      toolName: "mistral_request_async",
      auxiliary: { addDir: ["auxiliary"] },
    },
    {
      provider: "cursor" as const,
      toolName: "cursor_request_async",
      auxiliary: { addDir: ["auxiliary"] },
    },
  ])(
    "rejects unscoped relative auxiliary paths before $provider dispatch",
    async ({ provider, toolName, auxiliary }) => {
      const originalCwd = process.cwd();
      process.chdir(repository);
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${provider}-relative-dirs.json`));
      const gateway = server(disabledWorkspaces(), manager, false, sessions);

      try {
        const response = await registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            resumeLatest: false,
            createNewSession: false,
            approvalStrategy: "legacy",
            optimizePrompt: false,
            ...auxiliary,
          },
          {}
        );

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain(
          "Relative addDir or includeDirs paths require workingDir or a registered workspace"
        );
        expect(manager.starts).toHaveLength(0);
        expect(sessions.listSessions(provider)).toEqual([]);
      } finally {
        process.chdir(originalCwd);
        await gateway.close();
      }
    }
  );

  it.each([
    { provider: "grok" as const, toolName: "grok_request_async" },
    { provider: "devin" as const, toolName: "devin_request_async" },
    { provider: "mistral" as const, toolName: "mistral_request_async" },
  ])(
    "persists admitted workspace metadata after creating a missing $provider session",
    async ({ provider, toolName }) => {
      const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${provider}-missing-session.json`));
      const gateway = server(workspaceRegistry(repository, [provider]), manager, false, sessions);
      const sessionId = `${provider}-native-session`;

      const response = await registeredTools(gateway)[toolName].handler(
        {
          prompt: "inspect",
          sessionId,
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
          workspace: "review",
        },
        {}
      );

      expect(response.isError).not.toBe(true);
      expect(manager.starts).toEqual([expect.objectContaining({ cli: provider, cwd: repository })]);
      expect(sessions.getSession(sessionId)).toEqual(
        expect.objectContaining({
          metadata: expect.objectContaining({
            workspaceAlias: "review",
            workspaceRoot: repository,
          }),
        })
      );
      await gateway.close();
    }
  );

  it.each([
    { provider: "grok" as const, toolName: "grok_request" },
    { provider: "grok" as const, toolName: "grok_request_async" },
    { provider: "devin" as const, toolName: "devin_request" },
    { provider: "devin" as const, toolName: "devin_request_async" },
    { provider: "mistral" as const, toolName: "mistral_request" },
    { provider: "mistral" as const, toolName: "mistral_request_async" },
  ])(
    "mirrors native session precedence for $toolName worktree admission",
    async ({ provider, toolName }) => {
      const manager = toolName.endsWith("_async")
        ? new CapturingJobManager(noopLogger, undefined, new MemoryJobStore())
        : new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
      const sessions = new FileSessionManager(join(root, `${toolName}-unreachable-worktree.json`));
      const workspaces = workspaceRegistry(repository, [provider]);
      workspaces.repos[0]!.allowWorktree = true;
      const gateway = server(workspaces, manager, false, sessions);
      const nativeSessionId = `${provider}-native-worktree-session`;
      sessions.createSession(provider, "native", nativeSessionId);

      const combinations = [
        { withSession: false, resumeLatest: false, createNewSession: false, allowed: false },
        { withSession: false, resumeLatest: true, createNewSession: false, allowed: false },
        { withSession: false, resumeLatest: false, createNewSession: true, allowed: false },
        { withSession: false, resumeLatest: true, createNewSession: true, allowed: false },
        { withSession: true, resumeLatest: false, createNewSession: true, allowed: false },
        { withSession: true, resumeLatest: true, createNewSession: true, allowed: false },
        { withSession: true, resumeLatest: false, createNewSession: false, allowed: true },
        { withSession: true, resumeLatest: true, createNewSession: false, allowed: true },
      ];

      for (const combination of combinations) {
        const startsBefore = manager.starts.length;
        const response = await registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            ...(combination.withSession ? { sessionId: nativeSessionId } : {}),
            resumeLatest: combination.resumeLatest,
            createNewSession: combination.createNewSession,
            approvalStrategy: "legacy",
            optimizePrompt: false,
            workspace: "review",
            worktree: true,
          },
          {}
        );

        if (combination.allowed) {
          expect(response.isError).not.toBe(true);
          expect(manager.starts).toHaveLength(startsBefore + 1);
        } else {
          expect(response.isError).toBe(true);
          expect(response.content[0]?.text).toContain(
            "gateway worktree requests require an explicit provider-native sessionId"
          );
          expect(manager.starts).toHaveLength(startsBefore);
        }
      }
      expect(manager.starts).toHaveLength(2);
      expect(sessions.listSessions(provider)).toHaveLength(1);
      expect(existsSync(join(repository, ".worktrees"))).toBe(true);
      await gateway.close();
    }
  );

  it("does not overwrite concurrent session metadata during Gemini async admission", async () => {
    const manager = new RejectingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "gemini-concurrent-metadata.json"));
    const session = sessions.createSession("gemini", "existing", "gemini-concurrent-session");
    sessions.updateSessionMetadata(session.id, { marker: "before" });
    const gateway = server(workspaceRegistry(repository, ["gemini"]), manager, false, sessions);
    const originalCompareAndSet = sessions.compareAndSetSession.bind(sessions);
    let binds = 0;
    vi.spyOn(sessions, "compareAndSetSession").mockImplementation((identity, mutation) => {
      if (mutation.kind === "replace_metadata") {
        binds += 1;
        sessions.updateSessionMetadata(session.id, {
          marker: "concurrent",
          concurrentField: "must-survive",
        });
      }
      return originalCompareAndSet(identity, mutation);
    });

    const response = await registeredTools(gateway).gemini_request_async.handler(
      {
        prompt: "inspect",
        sessionId: session.id,
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("Failed to bind workspace scope");
    expect(binds).toBeGreaterThan(0);
    expect(manager.starts).toHaveLength(0);
    expect(sessions.getSession(session.id)?.metadata).toEqual({
      marker: "concurrent",
      concurrentField: "must-survive",
    });
    await gateway.close();
  });

  it("does not materialize a worktree when post-admission session persistence fails", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "failed-session-before-worktree.json"));
    const workspaces = workspaceRegistry(repository, ["mistral"]);
    workspaces.repos[0]!.allowWorktree = true;
    const gateway = server(workspaces, manager, false, sessions);
    const branchesBefore = execFileSync("git", ["branch", "--format=%(refname:short)"], {
      cwd: repository,
      encoding: "utf8",
    });
    vi.spyOn(sessions, "createSessionWithMetadata").mockImplementation(() => {
      throw new Error("session persistence failed");
    });

    const response = await registeredTools(gateway).mistral_request_async.handler(
      {
        prompt: "inspect",
        sessionId: "mistral-native-persistence-failure",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
        worktree: true,
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("session persistence failed");
    expect(manager.starts).toHaveLength(0);
    expect(existsSync(join(repository, ".worktrees"))).toBe(false);
    expect(
      execFileSync("git", ["branch", "--format=%(refname:short)"], {
        cwd: repository,
        encoding: "utf8",
      })
    ).toBe(branchesBefore);
    await gateway.close();
  });

  it("does not create an unscoped row when atomic session scope persistence fails", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "failed-new-session-scope.json"));
    vi.spyOn(sessions, "createSessionWithMetadata").mockImplementation(() => {
      throw new Error("atomic session scope persistence failed");
    });
    const workspaces = workspaceRegistry(repository, ["mistral"]);
    workspaces.repos[0]!.allowWorktree = true;
    const gateway = server(workspaces, manager, false, sessions);
    const worktreePath = join(repository, ".worktrees", "scope-persistence-failure");

    const response = await registeredTools(gateway).mistral_request_async.handler(
      {
        prompt: "inspect",
        sessionId: "mistral-native-scope-failure",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
        worktree: { name: "scope-persistence-failure" },
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("atomic session scope persistence failed");
    expect(manager.starts).toHaveLength(0);
    expect(sessions.listSessions("mistral")).toEqual([]);
    expect(existsSync(worktreePath)).toBe(false);
    expect(
      execFileSync("git", ["branch", "--list", "gateway/scope-persistence-failure"], {
        cwd: repository,
        encoding: "utf8",
      })
    ).toBe("");
    await gateway.close();
  });

  it("does not adopt a wrong-provider row that races session creation", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "wrong-provider-create-race.json"));
    const originalCreate = sessions.createSession.bind(sessions);
    vi.spyOn(sessions, "createSession").mockImplementation((_provider, _description, sessionId) => {
      originalCreate("grok", "raced row", sessionId);
      throw new Error("simulated create race");
    });
    const gateway = server(workspaceRegistry(repository, ["mistral"]), manager, false, sessions);

    const response = await registeredTools(gateway).mistral_request_async.handler(
      {
        prompt: "inspect",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("belongs to provider 'grok', not 'mistral'");
    expect(manager.starts).toHaveLength(0);
    expect(sessions.listSessions("mistral")).toEqual([]);
    expect(sessions.listSessions("grok")).toHaveLength(1);
    await gateway.close();
  });

  it("binds a post-admission worktree to a newly persisted missing session", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "missing-session-worktree.json"));
    const workspaces = workspaceRegistry(repository, ["mistral"]);
    workspaces.repos[0]!.allowWorktree = true;
    const gateway = server(workspaces, manager, false, sessions);
    const sessionId = "mistral-worktree-session";

    const response = await registeredTools(gateway).mistral_request_async.handler(
      {
        prompt: "inspect",
        sessionId,
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
        worktree: { name: "post-admission" },
      },
      {}
    );

    expect(response.isError).not.toBe(true);
    expect(manager.starts).toHaveLength(1);
    const worktreeCwd = manager.starts[0]!.cwd!;
    expect(worktreeCwd).toContain(join(repository, ".worktrees"));
    expect(sessions.getSession(sessionId)).toEqual(
      expect.objectContaining({
        metadata: expect.objectContaining({
          workspaceAlias: "review",
          workspaceRoot: repository,
          worktreePath: worktreeCwd,
          worktreeName: "post-admission",
        }),
      })
    );
    await gateway.close();
  });

  it("removes a newly created worktree when its session binding cannot persist", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "failed-worktree-binding.json"));
    const sessionId = "mistral-binding-failure-session";
    sessions.createSession("mistral", "existing", sessionId);
    const originalCompareAndSet = sessions.compareAndSetSession.bind(sessions);
    vi.spyOn(sessions, "compareAndSetSession").mockImplementation((identity, mutation) => {
      if (
        mutation.kind === "replace_metadata" &&
        typeof mutation.metadata?.worktreePath === "string"
      ) {
        throw new Error("worktree session binding failed");
      }
      return originalCompareAndSet(identity, mutation);
    });
    const workspaces = workspaceRegistry(repository, ["mistral"]);
    workspaces.repos[0]!.allowWorktree = true;
    const gateway = server(workspaces, manager, false, sessions);
    const worktreePath = join(repository, ".worktrees", "binding-failure");

    const response = await registeredTools(gateway).mistral_request_async.handler(
      {
        prompt: "inspect",
        sessionId,
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
        worktree: { name: "binding-failure" },
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("worktree session binding failed");
    expect(manager.starts).toHaveLength(0);
    expect(existsSync(worktreePath)).toBe(false);
    expect(
      execFileSync("git", ["branch", "--list", "gateway/binding-failure"], {
        cwd: repository,
        encoding: "utf8",
      })
    ).toBe("");
    expect(sessions.getSession(sessionId)?.metadata?.worktreePath).toBeUndefined();
    await gateway.close();
  });

  it("retains durable cleanup ownership when pre-job rollback cannot remove the worktree", async () => {
    const manager = new RejectingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "failed-pre-job-cleanup.json"));
    const sessionId = "mistral-pre-job-cleanup-session";
    sessions.createSession("mistral", "existing", sessionId);
    const workspaces = workspaceRegistry(repository, ["mistral"]);
    workspaces.repos[0]!.allowWorktree = true;
    const gateway = server(workspaces, manager, false, sessions);
    const worktreePath = join(repository, ".worktrees", "pre-job-cleanup");
    const restoreGit = forceGitWorktreeRemoveFailure();

    let response!: Awaited<ReturnType<RegisteredTool["handler"]>>;
    try {
      response = await registeredTools(gateway).mistral_request_async.handler(
        {
          prompt: "inspect",
          sessionId,
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
          workspace: "review",
          worktree: { name: "pre-job-cleanup" },
        },
        {}
      );
    } finally {
      restoreGit();
    }

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("job admission rejected");
    expect(existsSync(worktreePath)).toBe(true);
    expect(sessions.getSession(sessionId)?.metadata).toEqual(
      expect.objectContaining({
        worktreePath,
        worktreeName: "pre-job-cleanup",
        worktreeCleanupPending: true,
      })
    );

    await removeWorktree({
      repoRoot: repository,
      path: worktreePath,
      name: "pre-job-cleanup",
      logger: noopLogger,
    });
    await gateway.close();
  });

  it("does not mutate an existing session when canonical argv fails final admission", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const sessions = new FileSessionManager(join(root, "final-argv-session-state.json"));
    const sessionId = "mistral-existing-session";
    sessions.createSession("mistral", "existing", sessionId);
    sessions.updateSessionMetadata(sessionId, {
      workspaceAlias: "before",
      workspaceRoot: "/before",
    });
    const before = JSON.stringify(sessions.getSession(sessionId));

    let deepDirectory = repository;
    for (let index = 0; index < 120; index += 1) {
      deepDirectory = join(deepDirectory, `segment-${String(index).padStart(3, "0")}`);
    }
    mkdirSync(deepDirectory, { recursive: true });
    symlinkSync(deepDirectory, join(repository, "deep-link"), "dir");

    const gateway = server(workspaceRegistry(repository, ["mistral"]), manager, false, sessions);
    const response = await registeredTools(gateway).mistral_request_async.handler(
      {
        prompt: "inspect",
        sessionId,
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        workspace: "review",
        addDir: Array.from({ length: 1_000 }, () => "deep-link"),
      },
      {}
    );

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
      retryable: false,
    });
    expect(manager.starts).toHaveLength(0);
    expect(JSON.stringify(sessions.getSession(sessionId))).toBe(before);
    await gateway.close();
  });

  it("passes an authorized workspace cwd through route_request_async CLI dispatch", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = server(workspaceRegistry(repository, ["codex"]), manager, true);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).route_request_async.handler(
        {
          prompt: "inspect",
          candidates: [{ provider: "codex", model: "gpt-5.5" }],
          workspace: "review",
        },
        {}
      )
    );

    expect(response.isError).not.toBe(true);
    expect(manager.starts).toEqual([expect.objectContaining({ cli: "codex", cwd: repository })]);
    await gateway.close();
  });

  it("uses the configured default workspace for remote validation CLI jobs", async () => {
    const manager = new CapturingJobManager(noopLogger, undefined, new MemoryJobStore());
    const gateway = server(workspaceRegistry(repository, ["codex"], "review"), manager);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).validate_with_models.handler(
        {
          question: "inspect",
          models: ["codex"],
          focus: "correctness",
        },
        {}
      )
    );

    expect(response.isError).not.toBe(true);
    expect(manager.starts).toEqual([expect.objectContaining({ cli: "codex", cwd: repository })]);
    await gateway.close();
  });

  it("uses the selected review_changes repository for every CLI reviewer", async () => {
    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const store = new SqliteJobStore(join(root, "review-jobs.db"));
    const manager = new CapturingJobManager(noopLogger, undefined, store);
    const gateway = server(workspaceRegistry(repository, ["codex", "grok"]), manager);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).review_changes.handler(
        {
          workspace: "review",
          scope: "uncommitted",
          stance: "standard",
          models: ["codex", "grok"],
          allowApiUpload: false,
          maxArtifactBytes: DEFAULT_REVIEW_ARTIFACT_MAX_BYTES,
          maxPromptBytes: DEFAULT_REVIEW_PROMPT_MAX_BYTES,
        },
        {}
      )
    );

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(manager.starts).toEqual([
      expect.objectContaining({ cli: "codex", cwd: repository }),
      expect.objectContaining({ cli: "grok", cwd: repository }),
    ]);
    await gateway.close();
    store.close();
  });

  it("promotes a local absolute nested review_changes directory to its canonical Git root", async () => {
    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const store = new SqliteJobStore(join(root, "local-nested-review-jobs.db"));
    const manager = new CapturingJobManager(noopLogger, undefined, store);
    const gateway = server(disabledWorkspaces(), manager);

    const response = await registeredTools(gateway).review_changes.handler(
      {
        workingDir: join(repository, "src"),
        scope: "uncommitted",
        stance: "standard",
        models: ["claude"],
        judgeModel: "codex",
        allowApiUpload: false,
        maxArtifactBytes: DEFAULT_REVIEW_ARTIFACT_MAX_BYTES,
        maxPromptBytes: DEFAULT_REVIEW_PROMPT_MAX_BYTES,
      },
      {}
    );

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(manager.starts).toEqual([expect.objectContaining({ cli: "claude", cwd: repository })]);
    const report = response.structuredContent?.report as { validationId?: unknown } | undefined;
    expect(report?.validationId).toEqual(expect.any(String));
    expect(
      JSON.parse(store.getValidationRun(String(report!.validationId))!.requestJson)
    ).toMatchObject({
      reviewAuthorization: {
        repositoryPath: repository,
        repositoryRoot: repository,
        judgeProvider: "codex",
      },
    });

    const synthesis = await registeredTools(gateway).synthesize_validation.handler(
      {
        validationId: report!.validationId,
        judgeModel: "codex",
        workingDir: join(repository, "src"),
      },
      {}
    );
    expect(synthesis.isError).not.toBe(true);
    expect(synthesis.structuredContent).toMatchObject({ success: true });
    expect(manager.starts).toEqual([
      expect.objectContaining({ cli: "claude", cwd: repository }),
      expect.objectContaining({ cli: "codex", cwd: repository }),
    ]);

    await gateway.close();
    store.close();
  });

  it("rejects a remote review workspace whose Git root escapes its registered path", async () => {
    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const store = new SqliteJobStore(join(root, "remote-review-escape-jobs.db"));
    const manager = new CapturingJobManager(noopLogger, undefined, store);
    const gateway = server(workspaceRegistry(join(repository, "src"), ["codex"]), manager);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).review_changes.handler(
        {
          workspace: "review",
          scope: "uncommitted",
          stance: "standard",
          models: ["codex"],
          allowApiUpload: false,
          maxArtifactBytes: DEFAULT_REVIEW_ARTIFACT_MAX_BYTES,
          maxPromptBytes: DEFAULT_REVIEW_PROMPT_MAX_BYTES,
        },
        {}
      )
    );

    expect(response.structuredContent).toMatchObject({
      success: false,
      errorCategory: "invalid_input",
    });
    expect(response.content[0]?.text).toContain(
      "Resolved Git worktree root is outside the authorized review repository path"
    );
    expect(manager.starts).toHaveLength(0);

    await gateway.close();
    store.close();
  });

  it("authorizes a CLI judge against the selected review_changes workspace", async () => {
    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const store = new SqliteJobStore(join(root, "judge-auth-jobs.db"));
    const manager = new CapturingJobManager(noopLogger, undefined, store);
    const gateway = server(workspaceRegistry(repository, ["codex"]), manager);

    await expect(
      runWithRequestContext(remoteContext, () =>
        registeredTools(gateway).review_changes.handler(
          {
            workspace: "review",
            scope: "uncommitted",
            stance: "standard",
            models: ["codex"],
            judgeModel: "claude",
            allowApiUpload: false,
            maxArtifactBytes: DEFAULT_REVIEW_ARTIFACT_MAX_BYTES,
            maxPromptBytes: DEFAULT_REVIEW_PROMPT_MAX_BYTES,
          },
          {}
        )
      )
    ).rejects.toThrow('does not allow provider "claude"');
    expect(manager.starts).toHaveLength(0);
    await gateway.close();
    store.close();
  });

  it("binds a review judge to the re-authorized repository cwd and read-only CLI mode", async () => {
    writeFileSync(join(repository, "tracked.txt"), "changed\n");
    const store = new SqliteJobStore(join(root, "judge-binding-jobs.db"));
    const manager = new CapturingJobManager(noopLogger, undefined, store);
    const gateway = server(workspaceRegistry(repository, ["claude", "codex"]), manager);

    const kickoff = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).review_changes.handler(
        {
          workspace: "review",
          scope: "uncommitted",
          stance: "standard",
          models: ["claude"],
          judgeModel: "codex",
          allowApiUpload: false,
          maxArtifactBytes: DEFAULT_REVIEW_ARTIFACT_MAX_BYTES,
          maxPromptBytes: DEFAULT_REVIEW_PROMPT_MAX_BYTES,
        },
        {}
      )
    );
    const kickoffReport = kickoff.structuredContent?.report as
      { validationId?: unknown } | undefined;
    expect(kickoffReport?.validationId).toEqual(expect.any(String));
    expect(
      JSON.parse(store.getValidationRun(String(kickoffReport!.validationId))!.requestJson)
    ).toMatchObject({
      reviewAuthorization: {
        schemaVersion: "review-run-authorization.v1",
        repositoryPath: repository,
        repositoryRoot: repository,
        judgeProvider: "codex",
        allowApiUpload: false,
      },
    });

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).synthesize_validation.handler(
        {
          validationId: kickoffReport!.validationId,
          judgeModel: "codex",
          workspace: "review",
        },
        {}
      )
    );

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ success: true });
    expect(manager.starts).toEqual([
      expect.objectContaining({ cli: "claude", cwd: repository }),
      expect.objectContaining({
        cli: "codex",
        cwd: repository,
        args: expect.arrayContaining(["--sandbox", "read-only"]),
      }),
    ]);
    await gateway.close();
    store.close();
  });

  it("rejects admission_failed review synthesis replay before provider dispatch", async () => {
    const store = new SqliteJobStore(join(root, "admission-failed-replay.db"));
    const manager = new CapturingJobManager(noopLogger, undefined, store);
    store.recordValidationRun({
      validationId: "failed-review",
      ownerPrincipal: "gateway-bearer",
      intent: "review",
      createdAt: new Date(0).toISOString(),
      requestJson: JSON.stringify({
        question: "Review artifact sha256=failed",
        modelList: ["claude"],
        judgeProvider: "codex",
        reviewAuthorization: {
          schemaVersion: "review-run-authorization.v1",
          repositoryPath: repository,
          repositoryRoot: repository,
          judgeProvider: "codex",
          allowApiUpload: false,
        },
      }),
      providerLinks: [],
      judgeLink: null,
      status: "admission_failed",
    });
    const gateway = server(workspaceRegistry(repository, ["codex"]), manager);

    const response = await runWithRequestContext(remoteContext, () =>
      registeredTools(gateway).synthesize_validation.handler(
        {
          validationId: "failed-review",
          judgeModel: "codex",
          workspace: "review",
        },
        {}
      )
    );

    expect(JSON.parse(response.content[0].text)).toMatchObject({
      success: false,
      errorCategory: "review_synthesis_binding_failed",
      error: expect.stringContaining("not open"),
    });
    expect(manager.starts).toHaveLength(0);
    expect(store.getValidationRun("failed-review")?.status).toBe("admission_failed");
    await gateway.close();
    store.close();
  });

  it.each([
    {
      provider: "claude" as const,
      toolName: "claude_request",
      params: {
        prompt: "inspect",
        outputFormat: "text",
        continueSession: false,
        createNewSession: true,
        dangerouslySkipPermissions: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        strictMcpConfig: false,
        addDir: ["auxiliary"],
        optimizePrompt: false,
      },
    },
    {
      provider: "claude" as const,
      toolName: "claude_request_async",
      params: {
        prompt: "inspect",
        outputFormat: "text",
        continueSession: false,
        createNewSession: true,
        dangerouslySkipPermissions: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        strictMcpConfig: false,
        addDir: ["auxiliary"],
        optimizePrompt: false,
      },
    },
    {
      provider: "devin" as const,
      toolName: "devin_request",
      params: {
        prompt: "inspect",
        resumeLatest: false,
        createNewSession: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
    },
    {
      provider: "devin" as const,
      toolName: "devin_request_async",
      params: {
        prompt: "inspect",
        resumeLatest: false,
        createNewSession: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      },
    },
  ])(
    "uses the contained remote workingDir as the child cwd for $toolName",
    async ({ provider, toolName, params }) => {
      const manager = toolName.endsWith("_async")
        ? new CapturingJobManager(noopLogger, undefined, new MemoryJobStore())
        : new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(workspaceRegistry(repository, [provider]), manager);
      const expectedCwd = realpathSync(join(repository, "src"));

      const response = await runWithRequestContext(remoteContext, () =>
        registeredTools(gateway)[toolName].handler(
          { ...params, workspace: "review", workingDir: "src" },
          {}
        )
      );

      expect(response.isError).not.toBe(true);
      expect(manager.starts).toEqual([
        expect.objectContaining({ cli: provider, cwd: expectedCwd }),
      ]);
      if (provider === "claude") {
        const addDirIndex = manager.starts[0]!.args.indexOf("--add-dir");
        expect(addDirIndex).toBeGreaterThanOrEqual(0);
        expect(manager.starts[0]!.args[addDirIndex + 1]).toBe(
          realpathSync(join(repository, "auxiliary"))
        );
      }
      await gateway.close();
    }
  );

  it.each([
    { provider: "codex", toolName: "codex_request", flag: "-C" },
    { provider: "codex", toolName: "codex_request_async", flag: "-C" },
    { provider: "grok", toolName: "grok_request", flag: "--cwd" },
    { provider: "grok", toolName: "grok_request_async", flag: "--cwd" },
    { provider: "mistral", toolName: "mistral_request", flag: "--workdir" },
    { provider: "mistral", toolName: "mistral_request_async", flag: "--workdir" },
  ] as const)(
    "uses one canonical remote workingDir in cwd and argv for $toolName",
    async ({ provider, toolName, flag }) => {
      const manager = toolName.endsWith("_async")
        ? new CapturingJobManager(noopLogger, undefined, new MemoryJobStore())
        : new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(workspaceRegistry(repository, [provider]), manager);
      const expectedCwd = realpathSync(join(repository, "src"));
      const shared = {
        prompt: "inspect",
        workspace: "review",
        workingDir: "src",
        resumeLatest: false,
        createNewSession: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      };
      const providerParams =
        provider === "codex"
          ? {
              ...shared,
              fullAuto: false,
              dangerouslyBypassApprovalsAndSandbox: false,
            }
          : shared;

      const response = await runWithRequestContext(remoteContext, () =>
        registeredTools(gateway)[toolName].handler(providerParams, {})
      );

      expect(response.isError).not.toBe(true);
      expect(manager.starts).toHaveLength(1);
      expect(manager.starts[0]?.cwd).toBe(expectedCwd);
      const flagIndex = manager.starts[0]!.args.indexOf(flag);
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      expect(manager.starts[0]!.args[flagIndex + 1]).toBe(expectedCwd);
      await gateway.close();
    }
  );

  it.each(["cursor_request", "cursor_request_async"] as const)(
    "keeps Cursor's supported registered workspace root aligned through %s",
    async toolName => {
      const manager = toolName.endsWith("_async")
        ? new CapturingJobManager(noopLogger, undefined, new MemoryJobStore())
        : new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(workspaceRegistry(repository, ["cursor"]), manager);

      const response = await runWithRequestContext(remoteContext, () =>
        registeredTools(gateway)[toolName].handler(
          {
            prompt: "inspect",
            workspace: "review",
            outputFormat: "text",
            approvalStrategy: "legacy",
            optimizePrompt: false,
          },
          {}
        )
      );

      expect(response.isError).not.toBe(true);
      expect(manager.starts).toHaveLength(1);
      expect(manager.starts[0]?.cwd).toBe(repository);
      expect(manager.starts[0]?.args).toEqual(expect.arrayContaining(["--workspace", repository]));
      await gateway.close();
    }
  );

  it.each([
    { provider: "codex", toolName: "codex_request", flag: "-C" },
    { provider: "codex", toolName: "codex_request_async", flag: "-C" },
    { provider: "grok", toolName: "grok_request", flag: "--cwd" },
    { provider: "grok", toolName: "grok_request_async", flag: "--cwd" },
    { provider: "mistral", toolName: "mistral_request", flag: "--workdir" },
    { provider: "mistral", toolName: "mistral_request_async", flag: "--workdir" },
  ] as const)(
    "canonicalizes local relative workingDir once for $toolName",
    async ({ provider, toolName, flag }) => {
      const originalCwd = process.cwd();
      process.chdir(repository);
      const manager = toolName.endsWith("_async")
        ? new CapturingJobManager(noopLogger, undefined, new MemoryJobStore())
        : new CompletingJobManager(noopLogger, undefined, new MemoryJobStore());
      const gateway = server(disabledWorkspaces(), manager);
      const expectedCwd = realpathSync(join(repository, "src"));
      const shared = {
        prompt: "inspect",
        workingDir: "src",
        resumeLatest: false,
        createNewSession: true,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      };
      const providerParams =
        provider === "codex"
          ? {
              ...shared,
              fullAuto: false,
              dangerouslyBypassApprovalsAndSandbox: false,
            }
          : shared;

      try {
        const response = await registeredTools(gateway)[toolName].handler(providerParams, {});

        expect(response.isError).not.toBe(true);
        expect(manager.starts).toHaveLength(1);
        expect(manager.starts[0]?.cwd).toBe(expectedCwd);
        const flagIndex = manager.starts[0]!.args.indexOf(flag);
        expect(flagIndex).toBeGreaterThanOrEqual(0);
        expect(manager.starts[0]!.args[flagIndex + 1]).toBe(expectedCwd);
        expect(manager.starts[0]!.args[flagIndex + 1]).not.toBe("src");
      } finally {
        process.chdir(originalCwd);
        await gateway.close();
      }
    }
  );

  it.each([CLI_INPUT_TOO_LARGE_CATEGORY, CLI_INVALID_INPUT_CATEGORY] as const)(
    "preserves %s through the async-to-sync and route_request boundaries",
    async errorCategory => {
      const directManager = new ClassifiedFailureJobManager(errorCategory);
      const directGateway = server(disabledWorkspaces(), directManager);
      const directResponse = await registeredTools(directGateway).grok_request.handler(
        {
          prompt: "inspect",
          resumeLatest: false,
          createNewSession: true,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        },
        {}
      );

      expect(directResponse.isError).toBe(true);
      expect(directResponse.structuredContent).toMatchObject({
        cli: "grok",
        exitCode: 126,
        errorCategory,
        retryable: false,
      });
      await directGateway.close();

      const routeManager = new ClassifiedFailureJobManager(errorCategory);
      const routeGateway = server(disabledWorkspaces(), routeManager, true);
      const routeResponse = await registeredTools(routeGateway).route_request.handler(
        {
          prompt: "inspect",
          candidates: [{ provider: "codex", model: "gpt-5.5" }],
          allowUnpriced: true,
          maxCostUsd: 100,
        },
        {}
      );

      expect(routeResponse.isError).toBe(true);
      expect(routeResponse.structuredContent).toMatchObject({
        cli: "route_request",
        provider: "codex",
        model: "gpt-5.5",
        exitCode: 126,
        errorCategory,
        retryable: false,
        lastFailure: {
          provider: "codex",
          errorCategory,
          retryable: false,
        },
      });
      await routeGateway.close();
    }
  );
});
