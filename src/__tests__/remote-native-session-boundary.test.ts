/**
 * Remote callers may resume only native CLI sessions that the gateway has
 * already tracked and attributed to them. API providers are intentionally
 * different: an explicit API session ID can create a new bookkeeping row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { executeCliMock, runApiRequestMock } = vi.hoisted(() => ({
  executeCliMock: vi.fn(),
  runApiRequestMock: vi.fn(),
}));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

vi.mock("../api-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../api-provider.js")>("../api-provider.js");
  return { ...actual, runApiRequest: runApiRequestMock };
});

import { AsyncJobManager } from "../async-job-manager.js";
import type { GatewayServerRuntime } from "../index.js";
import {
  createGatewayServer,
  handleCodexRequestAsync,
  handleCursorRequest,
  handleDevinRequest,
  handleGeminiRequest,
  handleGrokApiRequest,
  handleGrokRequest,
  handleMistralRequest,
} from "../index.js";
import { NoopFlightRecorder } from "../flight-recorder.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import {
  getRequestContext,
  resolveOwnerPrincipal,
  runWithRequestContext,
  type GatewayRequestContext,
} from "../request-context.js";
import type { ISessionManager, ProviderType, Session } from "../session-manager.js";

const REMOTE_ALICE: GatewayRequestContext = {
  transport: "http",
  authKind: "oauth",
  authScopes: [],
  authPrincipal: "alice",
};

const REMOTE_BOB: GatewayRequestContext = {
  transport: "http",
  authKind: "oauth",
  authScopes: [],
  authPrincipal: "bob",
};

const LOCAL: GatewayRequestContext = { transport: "stdio", authScopes: [] };

const disabledWorkspaces = {
  enabled: false,
  defaultAlias: null,
  allowUnregisteredWorkingDir: false,
  repos: [],
  allowedRoots: [],
  sources: { configFile: null },
};

function session(id: string, cli: ProviderType, ownerPrincipal: string): Session {
  return {
    id,
    cli,
    createdAt: "t",
    lastUsedAt: "t",
    ownerPrincipal,
  };
}

function createSessionManager(initial: Session[] = []): {
  manager: ISessionManager;
  records: Map<string, Session>;
} {
  const records = new Map(initial.map(value => [value.id, value]));
  const manager = {
    createSession: vi.fn(
      async (cli: ProviderType, description?: string, requestedId?: string): Promise<Session> => {
        const id = requestedId ?? `gw-${records.size + 1}`;
        const created = {
          ...session(id, cli, resolveOwnerPrincipal(getRequestContext())),
          description,
        };
        records.set(id, created);
        return created;
      }
    ),
    getSession: vi.fn(async (id: string): Promise<Session | null> => records.get(id) ?? null),
    listSessions: vi.fn(async (): Promise<Session[]> => [...records.values()]),
    deleteSession: vi.fn(async (id: string): Promise<boolean> => records.delete(id)),
    setActiveSession: vi.fn(async (): Promise<boolean> => true),
    getActiveSession: vi.fn(async (): Promise<Session | null> => null),
    updateSessionUsage: vi.fn(async (): Promise<void> => {}),
    updateSessionMetadata: vi.fn(async (id: string, metadata: Record<string, unknown>) => {
      const existing = records.get(id);
      if (!existing) return false;
      existing.metadata = { ...existing.metadata, ...metadata };
      return true;
    }),
    clearAllSessions: vi.fn(async (): Promise<number> => 0),
  } as unknown as ISessionManager;
  return { manager, records };
}

function runtimeFor(
  sessionManager: ISessionManager,
  asyncJobManager: AsyncJobManager,
  withXai = false
): GatewayServerRuntime {
  return {
    sessionManager,
    asyncJobManager,
    approvalManager: { decide: () => ({ status: "approved" }) },
    flightRecorder: { logStart() {}, logComplete() {}, recordCompressionTelemetry() {} },
    logger: noopLogger,
    performanceMetrics: { recordRequest() {} },
    persistence: { backend: "none", asyncJobsEnabled: false },
    compression: { enabled: false, sources: { configFile: null } },
    workspaces: disabledWorkspaces,
    personalConfig: { settings: { enabled: false } },
    providers: {
      xai: withXai
        ? {
            apiKeyEnv: "REMOTE_NATIVE_SESSION_TEST_XAI_KEY",
            baseUrl: "https://api.example.test/v1",
            defaultModel: "grok-test",
          }
        : null,
      providers: {},
      sources: { configFile: null },
    },
  } as unknown as GatewayServerRuntime;
}

function responseText(result: { content: Array<{ text: string }> }): string {
  return result.content[0]?.text ?? "";
}

interface RegisteredTool {
  inputSchema: { parse(input: unknown): Record<string, unknown> };
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function registeredTool(
  server: ReturnType<typeof createGatewayServer>,
  name: string
): RegisteredTool {
  const tools = (server as unknown as Record<string, Record<string, RegisteredTool>>)
    ._registeredTools;
  const tool = tools[name];
  if (!tool) throw new Error(`Expected registered tool ${name}`);
  return tool;
}

function nativeResumeParams(provider: ProviderType, sessionId: string): Record<string, unknown> {
  const common = {
    prompt: "resume this",
    sessionId,
    resumeLatest: false,
    createNewSession: false,
    approvalStrategy: "legacy",
    optimizePrompt: false,
  };
  if (provider === "claude") {
    return {
      ...common,
      outputFormat: "text",
      continueSession: false,
      dangerouslySkipPermissions: false,
      strictMcpConfig: false,
    };
  }
  if (provider === "codex") {
    return {
      ...common,
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
    };
  }
  return common;
}

describe("remote native session ownership boundary", () => {
  const managers: AsyncJobManager[] = [];

  beforeEach(() => {
    executeCliMock.mockReset();
    executeCliMock.mockResolvedValue({ stdout: "done", stderr: "", code: 0 });
    runApiRequestMock.mockReset();
    runApiRequestMock.mockResolvedValue({
      text: "api done",
      model: "grok-test",
      responseId: "response-1",
      httpStatus: 200,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, costUsd: 0 },
    });
    process.env.REMOTE_NATIVE_SESSION_TEST_XAI_KEY = "test-key";
  });

  afterEach(async () => {
    delete process.env.REMOTE_NATIVE_SESSION_TEST_XAI_KEY;
    await Promise.all(managers.splice(0).map(manager => manager.dispose()));
  });

  function harness(initial: Session[] = [], withXai = false) {
    const sessions = createSessionManager(initial);
    const jobs = new AsyncJobManager(noopLogger);
    managers.push(jobs);
    const runtime = runtimeFor(sessions.manager, jobs, withXai);
    return {
      ...sessions,
      jobs,
      runtime,
      deps: { sessionManager: sessions.manager, logger: noopLogger, runtime },
    };
  }

  it.each([
    ["Devin", "devin"],
    ["Grok", "grok"],
  ] as const)(
    "returns one opaque error and never launches %s for missing or foreign IDs",
    async (_name, provider) => {
      const foreignId = `${provider}-alice-native`;
      const { deps, jobs } = harness([session(foreignId, provider, "alice")]);
      const acquireSlot = vi.spyOn(jobs, "acquireProcessSlot");
      const call = (sessionId: string) => {
        const params = {
          prompt: "resume this",
          sessionId,
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy" as const,
          optimizePrompt: false,
          correlationId: `${provider}-remote-boundary`,
        };
        return provider === "devin"
          ? handleDevinRequest(deps, params)
          : handleGrokRequest(deps, params);
      };

      const foreign = await runWithRequestContext(REMOTE_BOB, () => call(foreignId));
      const missing = await runWithRequestContext(REMOTE_BOB, () => call(`${provider}-missing`));

      expect(responseText(foreign)).toBe(responseText(missing));
      expect(responseText(foreign)).toContain("Requested session is not accessible");
      expect(responseText(foreign)).not.toContain(foreignId);
      expect(executeCliMock).not.toHaveBeenCalled();
      expect(acquireSlot).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "Gemini",
      "gemini",
      (deps: ReturnType<typeof harness>["deps"], _jobs: AsyncJobManager, sessionId: string) =>
        handleGeminiRequest(deps, {
          ...nativeResumeParams("gemini", sessionId),
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        }),
    ],
    [
      "Cursor",
      "cursor",
      (deps: ReturnType<typeof harness>["deps"], _jobs: AsyncJobManager, sessionId: string) =>
        handleCursorRequest(deps, {
          ...nativeResumeParams("cursor", sessionId),
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        }),
    ],
    [
      "Mistral",
      "mistral",
      (deps: ReturnType<typeof harness>["deps"], _jobs: AsyncJobManager, sessionId: string) =>
        handleMistralRequest(deps, {
          ...nativeResumeParams("mistral", sessionId),
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
        }),
    ],
    [
      "Codex async",
      "codex",
      (deps: ReturnType<typeof harness>["deps"], jobs: AsyncJobManager, sessionId: string) =>
        handleCodexRequestAsync(
          { ...deps, asyncJobManager: jobs },
          {
            ...nativeResumeParams("codex", sessionId),
            fullAuto: false,
            dangerouslyBypassApprovalsAndSandbox: false,
            createNewSession: false,
            approvalStrategy: "legacy",
            optimizePrompt: false,
          }
        ),
    ],
  ] as const)(
    "rejects missing and foreign remote native IDs before %s process or job admission",
    async (_name, provider, call) => {
      const foreignId = `${provider}-alice-native`;
      const { deps, jobs } = harness([session(foreignId, provider, "alice")]);
      const acquireSlot = vi.spyOn(jobs, "acquireProcessSlot");
      const startJob = vi.spyOn(jobs, "startJob");
      const startJobWithDedup = vi.spyOn(jobs, "startJobWithDedup");

      const foreign = await runWithRequestContext(REMOTE_BOB, () => call(deps, jobs, foreignId));
      const missing = await runWithRequestContext(REMOTE_BOB, () =>
        call(deps, jobs, `${provider}-missing`)
      );

      expect(responseText(foreign)).toBe(responseText(missing));
      expect(responseText(foreign)).toContain("Requested session is not accessible");
      expect(responseText(foreign)).not.toContain(foreignId);
      expect(executeCliMock).not.toHaveBeenCalled();
      expect(acquireSlot).not.toHaveBeenCalled();
      expect(startJob).not.toHaveBeenCalled();
      expect(startJobWithDedup).not.toHaveBeenCalled();
    }
  );

  it("covers the registered Claude native-resume boundary before process admission", async () => {
    const foreignId = "01940000-0000-7000-8000-000000000aaa";
    const missingId = "01940000-0000-7000-8000-000000000bbb";
    const { manager } = createSessionManager([session(foreignId, "claude", "alice")]);
    const jobs = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    managers.push(jobs);
    const server = createGatewayServer({
      sessionManager: manager,
      asyncJobManager: jobs,
      logger: noopLogger,
      flightRecorder: new NoopFlightRecorder(),
      persistence: {
        backend: "memory",
        path: null,
        dsn: null,
        retentionDays: 30,
        dedupWindowMs: 3_600_000,
        acknowledgeEphemeral: true,
        ownsOrphanRecovery: false,
        asyncJobsEnabled: true,
        sources: { configFile: null, envOverrides: [] },
      },
    });
    const tool = registeredTool(server, "claude_request");
    const acquireSlot = vi.spyOn(jobs, "acquireProcessSlot");
    const startJob = vi.spyOn(jobs, "startJob");
    const startJobWithDedup = vi.spyOn(jobs, "startJobWithDedup");
    const call = (sessionId: string) =>
      tool.handler(tool.inputSchema.parse(nativeResumeParams("claude", sessionId)), {});

    const foreign = await runWithRequestContext(REMOTE_BOB, () => call(foreignId));
    const missing = await runWithRequestContext(REMOTE_BOB, () => call(missingId));

    expect(responseText(foreign)).toBe(responseText(missing));
    expect(responseText(foreign)).toContain("Requested session is not accessible");
    expect(responseText(foreign)).not.toContain(foreignId);
    expect(executeCliMock).not.toHaveBeenCalled();
    expect(acquireSlot).not.toHaveBeenCalled();
    expect(startJob).not.toHaveBeenCalled();
    expect(startJobWithDedup).not.toHaveBeenCalled();
  });

  it("allows a local caller to resume an untracked native CLI session", async () => {
    const { deps } = harness();

    const result = await runWithRequestContext(LOCAL, () =>
      handleDevinRequest(deps, {
        prompt: "resume locally",
        sessionId: "local-native-session",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
      })
    );

    expect(result.isError).toBeUndefined();
    expect(executeCliMock).toHaveBeenCalledWith(
      "devin",
      expect.arrayContaining(["--resume", "local-native-session"]),
      expect.any(Object)
    );
  });

  it("keeps remote API session creation available for a new bookkeeping ID", async () => {
    const { deps, records } = harness([], true);

    const result = await runWithRequestContext(REMOTE_ALICE, () =>
      handleGrokApiRequest(deps, {
        prompt: "start API continuity",
        sessionId: "api-bookkeeping-id",
        optimizePrompt: false,
      })
    );

    expect(result.isError).toBeUndefined();
    expect(records.get("api-bookkeeping-id")?.ownerPrincipal).toBe("alice");
    expect(runApiRequestMock).toHaveBeenCalledOnce();
  });
});
