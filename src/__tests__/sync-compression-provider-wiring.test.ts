/**
 * Regression coverage for the synchronous CLI handlers. The effective
 * compression decision is computed in each handler and must reach
 * buildCliResponse for every provider that exposes compressResponse.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeCliMock } = vi.hoisted(() => ({ executeCliMock: vi.fn() }));

vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  return { ...actual, executeCli: executeCliMock };
});

import { AsyncJobManager } from "../async-job-manager.js";
import {
  createGatewayServer,
  handleCursorRequest,
  handleDevinRequest,
  handleGeminiRequest,
  handleGrokRequest,
  handleMistralRequest,
  type GatewayServerRuntime,
  type HandlerDeps,
} from "../index.js";
import type { AcpConfig } from "../config.js";
import { PersonalConfigManager } from "../personal-config.js";
import type { ISessionManager, ProviderType, Session } from "../session-manager.js";

const REPEATED_REPLY = "provider diagnostic: retrying the same operation\n".repeat(80);
const noopLogger = { info() {}, warn() {}, error() {}, debug() {} };

function createSessionManager(): ISessionManager {
  const sessions = new Map<string, Session>();
  return {
    createSession: async (cli: ProviderType, description?: string, requestedId?: string) => {
      const id = requestedId ?? `gw-${sessions.size + 1}`;
      const session: Session = { id, cli, description, createdAt: "t", lastUsedAt: "t" };
      sessions.set(id, session);
      return session;
    },
    getSession: async id => sessions.get(id) ?? null,
    listSessions: async () => [...sessions.values()],
    deleteSession: async id => sessions.delete(id),
    setActiveSession: async () => true,
    getActiveSession: async () => null,
    updateSessionUsage: async () => {},
    updateSessionMetadata: async (id, metadata) => {
      const session = sessions.get(id);
      if (!session) return false;
      session.metadata = { ...session.metadata, ...metadata };
      return true;
    },
    clearAllSessions: async () => 0,
  };
}

function runtimeForSync(): GatewayServerRuntime {
  const sessionManager = createSessionManager();
  return {
    sessionManager,
    asyncJobManager: new AsyncJobManager(noopLogger),
    approvalManager: { decide: () => ({ status: "approved" }) },
    flightRecorder: { logStart() {}, logComplete() {}, recordCompressionTelemetry() {} },
    logger: noopLogger,
    performanceMetrics: { recordRequest() {} },
    persistence: { backend: "none", asyncJobsEnabled: false },
    compression: { enabled: false, sources: { configFile: null } },
    workspaces: {
      enabled: false,
      defaultAlias: null,
      allowUnregisteredWorkingDir: false,
      repos: [],
      allowedRoots: [],
      sources: { configFile: null },
    },
    personalConfig: { settings: { enabled: false } },
    providers: { xai: null, providers: {}, sources: { configFile: null } },
  } as unknown as GatewayServerRuntime;
}

function deps(runtime: GatewayServerRuntime): HandlerDeps {
  return { runtime, sessionManager: runtime.sessionManager, logger: noopLogger };
}

function disabledAcpConfig(): AcpConfig {
  return {
    enabled: false,
    defaultTransport: "cli",
    smokeOnStartup: false,
    processIdleTimeoutMs: 600_000,
    initializeTimeoutMs: 10_000,
    sessionNewTimeoutMs: 10_000,
    promptTimeoutMs: 600_000,
    allowWriteHostServices: false,
    allowTerminalHostServices: false,
    allowMutatingSessionOps: false,
    fallbackToCliWhenUnhealthy: true,
    providers: {},
    sources: { configFile: null },
  };
}

interface RegisteredTool {
  inputSchema: { parse(value: unknown): unknown };
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

function createRegisteredCallbackServer(
  compressionEnabled: boolean
): ReturnType<typeof createGatewayServer> {
  const runtime = runtimeForSync();
  return createGatewayServer({
    sessionManager: runtime.sessionManager,
    asyncJobManager: runtime.asyncJobManager,
    approvalManager: runtime.approvalManager,
    flightRecorder: runtime.flightRecorder,
    logger: runtime.logger,
    performanceMetrics: runtime.performanceMetrics,
    persistence: runtime.persistence,
    compression: { enabled: compressionEnabled, sources: { configFile: null } },
    acpConfig: disabledAcpConfig(),
    workspaces: runtime.workspaces,
    providers: runtime.providers,
    personalConfig: new PersonalConfigManager({
      enabled: false,
      baselinePath: "/unused",
      maxStaleHours: 168,
    }),
  });
}

async function invokeRegisteredTool(
  server: ReturnType<typeof createGatewayServer>,
  toolName: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const tools = (server as unknown as Record<string, Record<string, RegisteredTool>>)
    ._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`tool ${toolName} not registered`);
  return tool.handler(tool.inputSchema.parse(args) as Record<string, unknown>, {});
}

const handlers = [
  {
    provider: "gemini",
    invoke: (input: HandlerDeps, compressResponse: boolean) =>
      handleGeminiRequest(input, {
        prompt: "reply",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        compressResponse,
      }),
  },
  {
    provider: "grok",
    invoke: (input: HandlerDeps, compressResponse: boolean) =>
      handleGrokRequest(input, {
        prompt: "reply",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        compressResponse,
      }),
  },
  {
    provider: "devin",
    invoke: (input: HandlerDeps, compressResponse: boolean) =>
      handleDevinRequest(input, {
        prompt: "reply",
        optimizePrompt: false,
        compressResponse,
      }),
  },
  {
    provider: "cursor",
    invoke: (input: HandlerDeps, compressResponse: boolean) =>
      handleCursorRequest(input, {
        prompt: "reply",
        optimizePrompt: false,
        compressResponse,
      }),
  },
  {
    provider: "mistral",
    invoke: (input: HandlerDeps, compressResponse: boolean) =>
      handleMistralRequest(input, {
        prompt: "reply",
        resumeLatest: false,
        createNewSession: false,
        approvalStrategy: "legacy",
        optimizePrompt: false,
        compressResponse,
      }),
  },
] as const;

describe("synchronous provider response-compression wiring", () => {
  beforeEach(() => {
    executeCliMock.mockReset();
    executeCliMock.mockResolvedValue({ stdout: REPEATED_REPLY, stderr: "", code: 0 });
  });

  it.each(handlers)("forwards compressResponse=true for $provider", async ({ invoke }) => {
    const result = await invoke(deps(runtimeForSync()), true);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain("[[gateway-note:v1");
  });

  it.each(handlers)("forwards compressResponse=false for $provider", async ({ invoke }) => {
    const result = await invoke(deps(runtimeForSync()), false);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe(REPEATED_REPLY);
    expect(result.content[0]?.text).not.toContain("[[gateway-note:v1");
  });
});

describe("synchronous registered-tool response-compression wiring", () => {
  const toolNames = [
    "gemini_request",
    "grok_request",
    "devin_request",
    "cursor_request",
    "mistral_request",
  ] as const;

  beforeEach(() => {
    executeCliMock.mockReset();
    executeCliMock.mockResolvedValue({ stdout: REPEATED_REPLY, stderr: "", code: 0 });
  });

  it.each(toolNames)(
    "%s forwards compressResponse=true over a disabled config default",
    async toolName => {
      const result = await invokeRegisteredTool(createRegisteredCallbackServer(false), toolName, {
        prompt: "reply",
        compressResponse: true,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toContain("[[gateway-note:v1");
    }
  );

  it.each(toolNames)(
    "%s forwards compressResponse=false over an enabled config default",
    async toolName => {
      const result = await invokeRegisteredTool(createRegisteredCallbackServer(true), toolName, {
        prompt: "reply",
        compressResponse: false,
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0]?.text).toBe(REPEATED_REPLY);
      expect(result.content[0]?.text).not.toContain("[[gateway-note:v1");
    }
  );
});

describe("synchronous registered-tool ACP compression rejection", () => {
  const acpToolNames = [
    "grok_request",
    "devin_request",
    "cursor_request",
    "mistral_request",
  ] as const;

  it.each([true, false])(
    "forwards compressResponse=%s to every ACP adapter for an explicit rejection",
    async compressResponse => {
      const server = createRegisteredCallbackServer(false);
      for (const toolName of acpToolNames) {
        const result = await invokeRegisteredTool(server, toolName, {
          prompt: "reply",
          transport: "acp",
          compressResponse,
        });

        expect(result.isError).toBe(true);
        expect(result.content[0]?.text).toContain("transport=acp does not support");
        expect(result.content[0]?.text).toContain("compressResponse");
      }
    }
  );

  it.each(acpToolNames)(
    "%s preserves an omitted compressResponse instead of rejecting a schema default",
    async toolName => {
      const result = await invokeRegisteredTool(createRegisteredCallbackServer(false), toolName, {
        prompt: "reply",
        transport: "acp",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain("ACP transport is disabled");
      expect(result.content[0]?.text).not.toContain("compressResponse");
    }
  );
});
