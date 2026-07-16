import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AsyncJobManager,
  type AsyncJobTerminalHook,
  type AsyncJobSnapshot,
} from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import { createGatewayServer } from "../index.js";
import { SqliteJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  PersonalConfigError,
  PersonalConfigManager,
  type KitPathLayout,
  type ResolvedKitContext,
} from "../personal-config.js";
import type { KitExecutionRef, KitSessionAttempt } from "../personal-config-types.js";
import { runWithRequestContext, type GatewayRequestContext } from "../request-context.js";
import { FileSessionManager, getKitSessionBinding } from "../session-manager.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";

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

function execution(overrides: Partial<KitExecutionRef> = {}): KitExecutionRef {
  return {
    version: 1,
    releaseId: "a".repeat(40),
    configStamp: "b".repeat(64),
    scopeRoot: "/workspace/kit-recovery",
    scopeHead: "c".repeat(40),
    contextIdentity: "d".repeat(64),
    ...overrides,
  };
}

function localContext(): GatewayRequestContext {
  return { transport: "stdio", authKind: "disabled", authScopes: [] };
}

function remoteContext(): GatewayRequestContext {
  return {
    transport: "http",
    authKind: "oauth",
    authScopes: [],
    authPrincipal: "remote-reviewer",
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

function runGit(directory: string, args: string[]): void {
  const result = spawnSync("git", ["-C", directory, ...args], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`Git test setup failed for ${args[0] ?? "command"}: ${result.stderr}`);
  }
}

describe("config_recover_kit_attempt", () => {
  let root: string;
  let sessions: FileSessionManager;
  let store: SqliteJobStore;
  let jobs: AsyncJobManager;
  let server: ReturnType<typeof createGatewayServer>;
  let personalConfig: PersonalConfigManager;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kit-recovery-tool-"));
    mkdirSync(root, { recursive: true });
    sessions = new FileSessionManager(join(root, "sessions.json"));
    store = new SqliteJobStore(join(root, "jobs.db"));
    jobs = new AsyncJobManager(noopLogger, undefined, store);
    personalConfig = new PersonalConfigManager(
      { enabled: true, baselinePath: join(root, "baseline"), maxStaleHours: 168 },
      layout(root)
    );
    server = createGatewayServer({
      sessionManager: sessions,
      asyncJobManager: jobs,
      persistence: persistence(join(root, "jobs.db")),
      personalConfig,
      workspaces: workspaceRegistry(root),
    });
  });

  afterEach(async () => {
    await jobs.dispose();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  function tool(): RegisteredTool {
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const recovery = registered.config_recover_kit_attempt;
    if (!recovery) throw new Error("config_recover_kit_attempt was not registered");
    return recovery;
  }

  function providerTool(
    name: "claude_request" | "claude_request_async" | "codex_request"
  ): RegisteredTool {
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const request = registered[name];
    if (!request) throw new Error(`${name} was not registered`);
    return request;
  }

  function publishTool(): RegisteredTool {
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const publish = registered.config_publish;
    if (!publish) throw new Error("config_publish was not registered");
    return publish;
  }

  function initTool(): RegisteredTool {
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const init = registered.config_init;
    if (!init) throw new Error("config_init was not registered");
    return init;
  }

  function statusTool(): RegisteredTool {
    const registered = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const status = registered.config_status;
    if (!status) throw new Error("config_status was not registered");
    return status;
  }

  async function call(
    args: Record<string, unknown>,
    context: GatewayRequestContext = localContext()
  ): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const recovery = tool();
    const parsed = recovery.inputSchema.parse(args);
    return await runWithRequestContext(context, () => recovery.handler(parsed, {}));
  }

  function createHeldSession(overrides: Partial<KitSessionAttempt> = {}): {
    sessionId: string;
    attempt: KitSessionAttempt;
    execution: KitExecutionRef;
  } {
    const now = Date.now();
    const attempt: KitSessionAttempt = {
      id: randomUUID(),
      kind: "durable",
      acquiredAt: new Date(now - 1_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
      expectedNativeSessionId: null,
      ...overrides,
    };
    const ref = execution();
    const sessionId = randomUUID();
    sessions.createKitSession(
      "claude",
      {
        execution: ref,
        nativeSessionId: null,
        resumeEligible: false,
        attempt,
      },
      "recovery test",
      sessionId
    );
    return { sessionId, attempt, execution: ref };
  }

  function argsFor(input: {
    sessionId: string;
    attempt: KitSessionAttempt;
    execution: KitExecutionRef;
  }): Record<string, unknown> {
    return {
      provider: "claude",
      sessionId: input.sessionId,
      attemptId: input.attempt.id,
      execution: input.execution,
      acknowledgement: "I_CONFIRM_THE_PREVIOUS_GATEWAY_IS_STOPPED",
    };
  }

  it("is local-only and retains attempts on provider, identity, and acknowledgement mismatches", async () => {
    const held = createHeldSession();
    const remote = await call(argsFor(held), remoteContext());
    expect(remote.isError).toBe(true);
    expect(remote.content[0]?.text).toContain("kit_context_conflict");
    expect(getKitSessionBinding(sessions.getSession(held.sessionId)!)?.attempt?.id).toBe(
      held.attempt.id
    );

    const providerMismatch = await call({ ...argsFor(held), provider: "codex" });
    expect(providerMismatch.isError).toBe(true);
    const attemptMismatch = await call({ ...argsFor(held), attemptId: randomUUID() });
    expect(attemptMismatch.isError).toBe(true);
    const identityMismatch = await call({
      ...argsFor(held),
      execution: execution({ contextIdentity: "e".repeat(64) }),
    });
    expect(identityMismatch.isError).toBe(true);
    expect(() => tool().inputSchema.parse({ ...argsFor(held), acknowledgement: "yes" })).toThrow();
    expect(getKitSessionBinding(sessions.getSession(held.sessionId)!)?.attempt?.id).toBe(
      held.attempt.id
    );
  });

  it("does not treat the public Claude output-format default as a Kit override", async () => {
    const context = vi.spyOn(personalConfig, "buildContext").mockImplementation(() => {
      throw new PersonalConfigError("kit_busy", "test context reached");
    });

    for (const name of ["claude_request", "claude_request_async"] as const) {
      const request = providerTool(name);
      const parsed = request.inputSchema.parse({ prompt: "Confirm default handling." });
      expect(parsed.outputFormat).toBe("stream-json");

      const response = await runWithRequestContext(localContext(), () =>
        request.handler(parsed, {})
      );
      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain(
        "kit_busy: Personal Agent Config is busy or requires local recovery"
      );
      expect(response.content[0]?.text).not.toContain("Kit mode rejects provider instruction");
    }

    expect(context).toHaveBeenCalledTimes(2);
  });

  it("rejects Claude baseline-authority controls before compiling Kit context in both request paths", async () => {
    const context = vi.spyOn(personalConfig, "buildContext").mockImplementation(() => {
      throw new Error("Kit context compilation must not run after a caller-control conflict");
    });

    for (const [field, value] of [
      ["approvalPolicy", "permissive"],
      ["effort", "max"],
      ["name", "caller-controlled-title"],
      ["workingDir", join(root, "missing-caller-controlled-working-dir")],
    ] as const) {
      for (const name of ["claude_request", "claude_request_async"] as const) {
        const request = providerTool(name);
        const parsed = request.inputSchema.parse({
          prompt: "Reject an untrusted caller control.",
          [field]: value,
        });
        expect(parsed[field]).toBe(value);

        const response = await runWithRequestContext(localContext(), () =>
          request.handler(parsed, {})
        );
        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain("kit_context_conflict");
      }
    }

    expect(context).not.toHaveBeenCalled();
  });

  it("accepts terminal release already completed by a concurrent gateway", async () => {
    const ref = execution();
    const now = new Date().toISOString();
    const context: ResolvedKitContext = {
      release: {
        id: ref.releaseId,
        root,
        manifest: {
          version: 1,
          releaseId: ref.releaseId,
          baselineCommit: ref.releaseId,
          createdAt: now,
          verified: true,
          treeDigest: "e".repeat(64),
        },
      },
      scope: {
        cwd: process.cwd(),
        scopeRoot: ref.scopeRoot,
        registeredWorkspaceAlias: null,
        repoHead: ref.scopeHead,
        overlayPath: null,
      },
      text: "terminal finalizer regression context",
      contextDigest: "f".repeat(64),
      configStamp: ref.configStamp,
      execution: ref,
      preferences: {},
      provenance: [],
    };
    const buildContext = vi.spyOn(personalConfig, "buildContext").mockReturnValue(context);
    const assertExecutionCurrent = vi
      .spyOn(personalConfig, "assertExecutionCurrent")
      .mockImplementation(() => {});
    let terminalHook: AsyncJobTerminalHook | undefined;
    let admitted: { jobId: string; kitSessionId: string; snapshot: AsyncJobSnapshot } | undefined;
    const startedArgs: string[][] = [];
    let continuationServer: ReturnType<typeof createGatewayServer> | null = null;
    const startJob = vi
      .spyOn(jobs, "startJob")
      .mockImplementation(
        (
          cli,
          args,
          correlationId,
          _cwd,
          _idleTimeoutMs,
          _outputFormat,
          _forceRefresh,
          _env,
          _onComplete,
          _flightRecorderEntry,
          _extractUsage,
          _writeFlightStart,
          _stdin,
          _compressResponse,
          kitExecution,
          onTerminal,
          kitSessionId,
          jobId
        ) => {
          if (!kitExecution || !onTerminal || !kitSessionId || !jobId) {
            throw new Error("test request did not hand off a complete Kit terminal hook");
          }
          const startedAt = new Date().toISOString();
          startedArgs.push([...args]);
          const snapshot: AsyncJobSnapshot = {
            id: jobId,
            cli,
            status: "completed",
            startedAt,
            finishedAt: startedAt,
            exitCode: 0,
            correlationId,
            outputTruncated: false,
            stdoutBytes: 0,
            stderrBytes: 0,
            error: null,
            exited: true,
          };
          store.recordStart({
            id: jobId,
            correlationId,
            requestKey: `terminal-release-${jobId}`,
            cli,
            args: ["-p", "terminal release regression"],
            startedAt,
            pid: null,
            kitExecution,
            kitSessionId,
            ownerPrincipal: "local",
          });
          store.recordComplete({
            id: jobId,
            status: "completed",
            exitCode: 0,
            stdout: "",
            stderr: "",
            outputTruncated: false,
            error: null,
            finishedAt: startedAt,
            kitTerminalMetadata: null,
          });
          terminalHook = onTerminal;
          admitted = { jobId, kitSessionId, snapshot };
          return snapshot;
        }
      );

    try {
      const request = providerTool("claude_request_async");
      const response = await runWithRequestContext(localContext(), () =>
        request.handler(request.inputSchema.parse({ prompt: "Finalize safely." }), {})
      );
      expect(response.isError).toBeUndefined();
      expect(terminalHook).toBeDefined();
      expect(admitted).toBeDefined();
      expect(getKitSessionBinding(sessions.getSession(admitted!.kitSessionId)!)?.attempt?.id).toBe(
        admitted!.jobId
      );

      const release = vi
        .spyOn(sessions, "releaseKitSessionAttempt")
        .mockImplementation((...input) => {
          // Another gateway commits the exact release between this finalizer's
          // session update and its release call. Its false result is therefore
          // a benign concurrent success, not a failed terminal hook.
          expect(input[3]).toBe(admitted!.kitSessionId);
          expect(input[4]).toBe(admitted!.jobId);
          const binding = getKitSessionBinding(sessions.getSession(input[3])!);
          expect(binding?.attempt?.id).toBe(input[4]);
          expect(
            runWithRequestContext(localContext(), () => {
              return sessions.updateKitSessionBinding(
                input[3],
                {
                  execution: binding!.execution,
                  nativeSessionId: binding!.nativeSessionId,
                  resumeEligible: binding!.resumeEligible,
                },
                input[4]
              );
            })
          ).toBe(true);
          return false;
        });
      try {
        await expect(
          terminalHook!({
            snapshot: admitted!.snapshot,
            ownerPrincipal: "local",
            kitExecution: ref,
            kitSessionId: admitted!.kitSessionId,
            terminalMetadata: null,
          })
        ).resolves.toBeUndefined();
      } finally {
        release.mockRestore();
      }

      expect(store.getById(admitted!.jobId)?.kitTerminalFinalized).toBe(true);
      expect(
        getKitSessionBinding(sessions.getSession(admitted!.kitSessionId)!)?.attempt
      ).toBeUndefined();

      // A direct handler can reconstruct a GatewayServerRuntime around the
      // same durable job manager. The in-process provider continuation must
      // survive that reconstruction, while a restart with a new manager must
      // still retire it.
      const originalSessionId = admitted!.kitSessionId;
      continuationServer = createGatewayServer({
        sessionManager: sessions,
        asyncJobManager: jobs,
        persistence: persistence(join(root, "jobs.db")),
        personalConfig,
        workspaces: workspaceRegistry(root),
      });
      const continuationRequest = (
        continuationServer as unknown as Record<string, Record<string, RegisteredTool>>
      )._registeredTools.claude_request_async;
      const continuation = await runWithRequestContext(localContext(), () =>
        continuationRequest.handler(
          continuationRequest.inputSchema.parse({
            prompt: "Resume safely.",
            sessionId: originalSessionId,
          }),
          {}
        )
      );
      expect(continuation.isError).toBeUndefined();
      expect(startedArgs.at(-1)).toEqual(expect.arrayContaining(["--resume", originalSessionId]));
    } finally {
      await continuationServer?.close();
      startJob.mockRestore();
      assertExecutionCurrent.mockRestore();
      buildContext.mockRestore();
    }
  });

  it("retires terminal provider state during restart reconciliation", async () => {
    const held = createHeldSession();
    const legacyNativeHandle = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3";
    const finishedAt = new Date().toISOString();
    store.recordStart({
      id: held.attempt.id,
      correlationId: "restart-native-handle-retirement",
      requestKey: "restart-native-handle-retirement",
      cli: "claude",
      args: ["-p", "private Kit request"],
      startedAt: finishedAt,
      pid: null,
      kitExecution: held.execution,
      kitSessionId: held.sessionId,
      ownerPrincipal: "local",
    });
    store.recordComplete({
      id: held.attempt.id,
      status: "completed",
      exitCode: 0,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt,
      kitTerminalMetadata: { version: 1, nativeSessionId: legacyNativeHandle },
    });

    const restartedJobs = new AsyncJobManager(noopLogger, undefined, store);
    try {
      createGatewayServer({
        sessionManager: sessions,
        asyncJobManager: restartedJobs,
        persistence: persistence(join(root, "jobs.db")),
        personalConfig,
      });

      const deadline = Date.now() + 1_000;
      while (!store.getById(held.attempt.id)?.kitTerminalFinalized && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      expect(store.getById(held.attempt.id)?.kitTerminalFinalized).toBe(true);
      expect(getKitSessionBinding(sessions.getSession(held.sessionId)!)?.attempt).toBeUndefined();
      expect(
        sessions.getActiveKitSession("claude", held.execution.scopeRoot, held.execution)
      ).toBeNull();
      expect(readFileSync(join(root, "sessions.json"), "utf8")).not.toContain(legacyNativeHandle);
    } finally {
      await restartedJobs.dispose();
    }
  });

  it("never exposes raw Git diagnostics from config_publish", async () => {
    const kitLayout = layout(root);
    const privateRemoteSentinel = "PRIVATE_REMOTE_SENTINEL";
    mkdirSync(kitLayout.baselineDir, { recursive: true });
    runGit(kitLayout.baselineDir, ["init"]);
    runGit(kitLayout.baselineDir, ["symbolic-ref", "HEAD", "refs/heads/kit-test"]);
    runGit(kitLayout.baselineDir, [
      "remote",
      "add",
      "origin",
      `file://${join(root, privateRemoteSentinel)}`,
    ]);

    const rawFetch = spawnSync("git", ["-C", kitLayout.baselineDir, "fetch", "origin"], {
      encoding: "utf8",
    });
    expect(`${rawFetch.stdout ?? ""}${rawFetch.stderr ?? ""}`).toContain(privateRemoteSentinel);

    const publish = publishTool();
    const response = await runWithRequestContext(localContext(), () =>
      publish.handler(publish.inputSchema.parse({}), {})
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain(
      "kit_invalid_baseline: Personal Agent Config baseline validation failed"
    );
    expect(response.content[0]?.text).not.toContain(privateRemoteSentinel);
    expect(response.structuredContent?.response).not.toContain(privateRemoteSentinel);
  });

  it("never exposes unexpected local errors from config management", async () => {
    const privatePathSentinel = "PRIVATE_RUNTIME_PATH_SENTINEL";
    vi.spyOn(personalConfig, "init").mockImplementation(() => {
      throw new Error(`EACCES: permission denied, mkdir ${join(root, privatePathSentinel)}`);
    });

    const init = initTool();
    const response = await runWithRequestContext(localContext(), () =>
      init.handler(init.inputSchema.parse({}), {})
    );

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain(
      "kit_busy: Personal Agent Config operation failed safely"
    );
    expect(response.content[0]?.text).not.toContain(privatePathSentinel);
    expect(response.structuredContent?.response).not.toContain(privatePathSentinel);
  });

  it("never exposes legacy state diagnostics through config_status", async () => {
    const kitLayout = layout(root);
    const privatePathSentinel = "PRIVATE_STATUS_PATH_SENTINEL";
    const privateRemoteSentinel = "PRIVATE_STATUS_REMOTE_SENTINEL";
    const privateSecretSentinel = "PRIVATE_STATUS_SECRET_SENTINEL";
    const legacyDiagnostic =
      `git fetch failed at /home/${privatePathSentinel} ` +
      `remote=https://${privateRemoteSentinel}/${privateSecretSentinel}`;
    mkdirSync(kitLayout.runtimeDir, { recursive: true });
    writeFileSync(
      kitLayout.statePath,
      `${JSON.stringify({
        currentReleaseId: null,
        lastSuccessAt: null,
        lastSyncError: legacyDiagnostic,
        staleAckUntil: null,
        staleAckReleaseId: null,
        staleAckUsedForReleaseId: null,
      })}\n`
    );

    const status = statusTool();
    const response = await runWithRequestContext(localContext(), () =>
      status.handler(status.inputSchema.parse({}), {})
    );
    const surfaces = `${response.content.map(block => block.text).join("\n")}\n${JSON.stringify(
      response.structuredContent ?? {}
    )}`;

    expect(response.isError).toBeUndefined();
    for (const sentinel of [privatePathSentinel, privateRemoteSentinel, privateSecretSentinel]) {
      expect(surfaces).not.toContain(sentinel);
    }
  });

  it("never exposes typed local paths from Kit request validation", async () => {
    const privatePathSentinel = "PRIVATE_TYPED_PATH_SENTINEL";
    const request = providerTool("codex_request");
    const parsed = request.inputSchema.parse({
      prompt: "Validate the configured working directory.",
      workingDir: join(root, privatePathSentinel),
    });

    const response = await runWithRequestContext(localContext(), () => request.handler(parsed, {}));

    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain(
      "kit_invalid_baseline: Personal Agent Config baseline validation failed"
    );
    expect(response.content[0]?.text).not.toContain(privatePathSentinel);
    expect(response.structuredContent?.response).not.toContain(privatePathSentinel);
  });

  it("fences before release, then prevents a paused late admission from launching", async () => {
    const held = createHeldSession();
    const result = await call(argsFor(held));
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('"fence": "reserved"');
    expect(result.content[0]?.text).not.toContain("scopeRoot");
    expect(result.content[0]?.text).not.toContain("configStamp");
    expect(result.content[0]?.text).not.toContain("nativeSessionId");
    expect(getKitSessionBinding(sessions.getSession(held.sessionId)!)?.attempt).toBeUndefined();

    expect(() =>
      jobs.startJobWithDedup("claude", ["-p", "late admission"], "late-admission-corr", {
        forceRefresh: true,
        kitExecution: held.execution,
        kitSessionId: held.sessionId,
        jobId: held.attempt.id,
      })
    ).toThrow(/Durable job admission failed/);
    expect(store.getById(held.attempt.id)).toBeNull();
  });

  it("retries an exact recovered fence and retains attempts when a job is found or unavailable", async () => {
    const retried = createHeldSession();
    expect(
      store.fenceUnadmittedKitAttempt({
        attemptId: retried.attempt.id,
        cli: "claude",
        kitExecution: retried.execution,
        kitSessionId: retried.sessionId,
        ownerPrincipal: "local",
        fencedAt: new Date().toISOString(),
      })
    ).toBe("reserved");
    const retry = await call(argsFor(retried));
    expect(retry.isError).toBeUndefined();
    expect(retry.content[0]?.text).toContain('"fence": "already_recovered"');
    expect(getKitSessionBinding(sessions.getSession(retried.sessionId)!)?.attempt).toBeUndefined();

    const found = createHeldSession();
    store.recordStart({
      id: found.attempt.id,
      correlationId: "found-job",
      requestKey: "found-job-key",
      cli: "claude",
      args: ["-p", "found"],
      startedAt: new Date().toISOString(),
      pid: null,
      kitExecution: found.execution,
      kitSessionId: found.sessionId,
      ownerPrincipal: "local",
    });
    const foundResult = await call(argsFor(found));
    expect(foundResult.isError).toBe(true);
    expect(foundResult.content[0]?.text).toContain(
      "kit_busy: Personal Agent Config is busy or requires local recovery"
    );
    expect(getKitSessionBinding(sessions.getSession(found.sessionId)!)?.attempt?.id).toBe(
      found.attempt.id
    );

    const unavailable = createHeldSession();
    const lookup = vi.spyOn(jobs, "lookupJobSnapshot").mockReturnValue({ state: "unavailable" });
    const unavailableResult = await call(argsFor(unavailable));
    lookup.mockRestore();
    expect(unavailableResult.isError).toBe(true);
    expect(unavailableResult.content[0]?.text).toContain(
      "kit_busy: Personal Agent Config is busy or requires local recovery"
    );
    expect(getKitSessionBinding(sessions.getSession(unavailable.sessionId)!)?.attempt?.id).toBe(
      unavailable.attempt.id
    );
  });

  it("retains the exact lease on fence conflict, legacy attempts, and release failure", async () => {
    const conflicting = createHeldSession();
    expect(
      store.fenceUnadmittedKitAttempt({
        attemptId: conflicting.attempt.id,
        cli: "claude",
        kitExecution: conflicting.execution,
        kitSessionId: "different-session",
        ownerPrincipal: "local",
        fencedAt: new Date().toISOString(),
      })
    ).toBe("reserved");
    const conflict = await call(argsFor(conflicting));
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]?.text).toContain(
      "kit_busy: Personal Agent Config is busy or requires local recovery"
    );
    expect(getKitSessionBinding(sessions.getSession(conflicting.sessionId)!)?.attempt?.id).toBe(
      conflicting.attempt.id
    );

    const legacy = createHeldSession({ kind: "direct" });
    const legacyResult = await call(argsFor(legacy));
    expect(legacyResult.isError).toBe(true);
    expect(legacyResult.content[0]?.text).toContain(
      "kit_busy: Personal Agent Config is busy or requires local recovery"
    );
    expect(getKitSessionBinding(sessions.getSession(legacy.sessionId)!)?.attempt?.id).toBe(
      legacy.attempt.id
    );

    const releaseFailure = createHeldSession();
    const release = vi.spyOn(sessions, "releaseKitSessionAttempt").mockImplementation(() => {
      throw new Error("driver detail must not escape");
    });
    const failed = await call(argsFor(releaseFailure));
    release.mockRestore();
    expect(failed.isError).toBe(true);
    expect(failed.content[0]?.text).toContain("kit_busy");
    expect(failed.content[0]?.text).not.toContain("driver detail");
    expect(getKitSessionBinding(sessions.getSession(releaseFailure.sessionId)!)?.attempt?.id).toBe(
      releaseFailure.attempt.id
    );

    const superseded = createHeldSession();
    const replacement: KitSessionAttempt = {
      ...superseded.attempt,
      id: randomUUID(),
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const fence = vi.spyOn(jobs, "fenceUnadmittedKitAttempt").mockImplementation(() => {
      const current = getKitSessionBinding(sessions.getSession(superseded.sessionId)!);
      expect(
        sessions.updateKitSessionBinding(
          superseded.sessionId,
          {
            execution: current!.execution,
            nativeSessionId: current!.nativeSessionId,
            resumeEligible: current!.resumeEligible,
            attempt: replacement,
          },
          superseded.attempt.id
        )
      ).toBe(true);
      return "reserved";
    });
    const supersededResult = await call(argsFor(superseded));
    fence.mockRestore();
    expect(supersededResult.isError).toBe(true);
    expect(supersededResult.content[0]?.text).toContain(
      "kit_busy: Personal Agent Config is busy or requires local recovery"
    );
    expect(getKitSessionBinding(sessions.getSession(superseded.sessionId)!)?.attempt?.id).toBe(
      replacement.id
    );
  });
});
