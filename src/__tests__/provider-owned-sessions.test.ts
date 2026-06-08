import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { ProvidersConfig, PersistenceConfig } from "../config.js";
import { createGatewayServer } from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { PerformanceMetrics } from "../metrics.js";
import { ResourceProvider } from "../resources.js";
import { FileSessionManager, type ProviderType } from "../session-manager.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function mkPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function mkProviders(): ProvidersConfig {
  return {
    xai: {
      apiKeyEnv: "XAI_API_KEY",
      baseUrl: "http://127.0.0.1:1/v1",
      defaultModel: "grok-build-0.1",
    },
    sources: { configFile: null },
  };
}

function registeredTools(
  server: ReturnType<typeof createGatewayServer>
): Record<string, RegisteredTool> {
  return (server as unknown as Record<string, Record<string, RegisteredTool>>)._registeredTools;
}

function baseArgs(toolName: string, sessionId: string): Record<string, unknown> {
  const common = {
    prompt: "hello",
    sessionId,
    createNewSession: false,
    approvalStrategy: "legacy",
    optimizePrompt: false,
  };
  switch (toolName) {
    case "claude_request":
    case "claude_request_async":
      return {
        ...common,
        outputFormat: "text",
        continueSession: false,
        dangerouslySkipPermissions: false,
        strictMcpConfig: false,
      };
    case "codex_request":
    case "codex_request_async":
      return {
        ...common,
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
      };
    case "codex_fork_session":
      return { prompt: "hello", sessionId };
    case "gemini_request":
    case "gemini_request_async":
    case "grok_request":
    case "grok_request_async":
    case "mistral_request":
    case "mistral_request_async":
      return { ...common, resumeLatest: false };
    case "grok_api_request":
      return { prompt: "hello", sessionId, optimizePrompt: false };
    default:
      throw new Error(`unknown test tool ${toolName}`);
  }
}

function expectedProvider(toolName: string): ProviderType {
  if (toolName.startsWith("claude")) return "claude";
  if (toolName.startsWith("codex")) return "codex";
  if (toolName.startsWith("gemini")) return "gemini";
  if (toolName === "grok_api_request") return "grok-api";
  if (toolName.startsWith("grok")) return "grok";
  return "mistral";
}

async function exerciseWrongProvider(toolName: string): Promise<{
  result: Awaited<ReturnType<RegisteredTool["handler"]>>;
  startJobSpy: ReturnType<typeof vi.spyOn>;
  usageSpy: ReturnType<typeof vi.spyOn>;
  metadataSpy: ReturnType<typeof vi.spyOn>;
  expected: ProviderType;
  actual: ProviderType;
}> {
  vi.stubEnv("XAI_API_KEY", "test-key");
  const dir = mkdtempSync(join(tmpdir(), "provider-owned-sessions-"));
  const sessionManager = new FileSessionManager(join(dir, "sessions.json"));
  const asyncJobManager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
  const startJobSpy = vi.spyOn(asyncJobManager, "startJob");
  const usageSpy = vi.spyOn(sessionManager, "updateSessionUsage");
  const metadataSpy = vi.spyOn(sessionManager, "updateSessionMetadata");
  const expected = expectedProvider(toolName);
  const actual: ProviderType = expected === "grok-api" ? "grok" : "grok-api";
  const session = sessionManager.createSession(actual, "wrong provider", "stored-session");
  const server = createGatewayServer({
    sessionManager,
    asyncJobManager,
    persistence: mkPersistence(),
    providers: mkProviders(),
  });

  try {
    const result = await registeredTools(server)[toolName].handler(
      baseArgs(toolName, session.id),
      {}
    );
    return { result, startJobSpy, usageSpy, metadataSpy, expected, actual };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("provider-owned stored gateway sessions", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    "claude_request",
    "codex_request",
    "codex_fork_session",
    "gemini_request",
    "grok_request",
    "mistral_request",
    "grok_api_request",
  ])(
    "%s rejects an existing wrong-provider stored session before sync execution",
    async toolName => {
      const { result, startJobSpy, usageSpy, metadataSpy, expected, actual } =
        await exerciseWrongProvider(toolName);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        `Session stored-session belongs to provider '${actual}', not '${expected}'`
      );
      expect(startJobSpy).not.toHaveBeenCalled();
      expect(usageSpy).not.toHaveBeenCalled();
      expect(metadataSpy).not.toHaveBeenCalled();
    }
  );

  it.each([
    "claude_request_async",
    "codex_request_async",
    "gemini_request_async",
    "grok_request_async",
    "mistral_request_async",
  ])(
    "%s rejects an existing wrong-provider stored session before async job start",
    async toolName => {
      const { result, startJobSpy, usageSpy, metadataSpy, expected, actual } =
        await exerciseWrongProvider(toolName);

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        `Session stored-session belongs to provider '${actual}', not '${expected}'`
      );
      expect(startJobSpy).not.toHaveBeenCalled();
      expect(usageSpy).not.toHaveBeenCalled();
      expect(metadataSpy).not.toHaveBeenCalled();
    }
  );

  it("sessions://all includes the active grok-api session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "provider-owned-sessions-resource-"));
    const sessionManager = new FileSessionManager(join(dir, "sessions.json"));
    try {
      const session = sessionManager.createSession("grok-api", "Grok API active");
      const resourceProvider = new ResourceProvider(sessionManager, new PerformanceMetrics());
      const resource = await resourceProvider.readResource("sessions://all");

      expect(resource).not.toBeNull();
      const parsed = JSON.parse(resource!.text);
      expect(parsed.activeSessions["grok-api"]).toBe(session.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
