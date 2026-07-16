import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { PersistenceConfig } from "../config.js";
import {
  createGatewayServer,
  prepareClaudeRequest,
  prepareGrokRequest,
  type GatewayServerRuntime,
} from "../index.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";
import { validateClaudeAgentsMap } from "../request-helpers.js";
import { FileSessionManager } from "../session-manager.js";

const MALFORMED_DEFINITION = { prompt: "prompt without a description" };
const EXPECTED_VALIDATION_DETAIL = "Invalid agent definition at agents[1].description: Required";
const RESERVED_AGENT_KEYS = ["__proto__", "constructor", "prototype"] as const;
const TEST_RUNTIME = {
  logger: noopLogger,
  cacheAwareness: {
    emitAnthropicCacheControl: false,
    anthropicTtlSeconds: 300,
    warnOnTtlExpiry: false,
    minStableTokensForCacheControl: { sonnet: 1024, opus: 4096, haiku: 4096, default: 4096 },
    sources: { configFile: null },
  },
} as unknown as GatewayServerRuntime;

interface RegisteredTool {
  inputSchema: { parse: (value: unknown) => Record<string, unknown> };
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }>;
}

function memoryPersistence(): PersistenceConfig {
  return {
    backend: "memory",
    path: null,
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3_600_000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
  };
}

function reservedAgentMap(): Record<string, unknown> {
  return JSON.parse(
    '{"__proto__":{"description":"proto agent","prompt":"proto prompt"},' +
      '"constructor":{"description":"constructor agent","prompt":"constructor prompt"},' +
      '"prototype":{"description":"prototype agent","prompt":"prototype prompt"}}'
  ) as Record<string, unknown>;
}

function expectReservedAgentKeys(value: unknown): void {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  const record = value as Record<string, unknown>;
  expect(Object.keys(record)).toEqual(RESERVED_AGENT_KEYS);
  for (const key of RESERVED_AGENT_KEYS) {
    expect(Object.hasOwn(record, key)).toBe(true);
  }
  expect(record.__proto__).toEqual({ description: "proto agent", prompt: "proto prompt" });
  expect(record.constructor).toEqual({
    description: "constructor agent",
    prompt: "constructor prompt",
  });
  expect(record.prototype).toEqual({
    description: "prototype agent",
    prompt: "prototype prompt",
  });
}

function claudeErrorForKey(key: string) {
  return prepareClaudeRequest(
    {
      prompt: "review",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "legacy",
      mcpServers: [],
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
      correlationId: "agent-map-privacy-claude",
      agents: {
        valid: { description: "valid", prompt: "valid" },
        [key]: MALFORMED_DEFINITION,
      },
    },
    TEST_RUNTIME
  );
}

function grokErrorForKey(key: string) {
  return prepareGrokRequest(
    {
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "grok_request",
      correlationId: "agent-map-privacy-grok",
      agents: {
        valid: { description: "valid", prompt: "valid" },
        [key]: MALFORMED_DEFINITION,
      },
    },
    TEST_RUNTIME
  );
}

function expectPrivateValidationResponse(
  response: ReturnType<typeof claudeErrorForKey> | ReturnType<typeof grokErrorForKey>,
  key: string,
  leakMarker: string
): void {
  expect("args" in response).toBe(false);
  if ("args" in response) throw new Error("expected an error response");

  const contentText = response.content[0]?.text ?? "";
  const structuredText = response.structuredContent?.response;
  expect(contentText).toContain(EXPECTED_VALIDATION_DETAIL);
  expect(structuredText).toBe(contentText);
  expect(contentText).not.toContain(key);
  expect(contentText).not.toContain(leakMarker);
  expect(JSON.stringify(response)).not.toContain(key);
  expect(JSON.stringify(response)).not.toContain(leakMarker);
  expect(contentText.length).toBeLessThan(500);
}

describe("agent map validation response privacy", () => {
  const sensitiveKeys = [
    {
      key: `credential_name=caller-secret-marker-${"x".repeat(64_000)}`,
      leakMarker: "credential_name=caller-secret-marker-",
    },
    {
      key: "tenant-secret-秘密-🔐-do-not-disclose",
      leakMarker: "tenant-secret-秘密",
    },
    { key: "nul\0secret\0agent", leakMarker: "nul\0secret" },
  ];

  it.each(sensitiveKeys)("redacts a malformed Claude agent map key %#", testCase => {
    expectPrivateValidationResponse(
      claudeErrorForKey(testCase.key),
      testCase.key,
      testCase.leakMarker
    );
  });

  it.each(sensitiveKeys)("redacts a malformed Grok agent map key %#", testCase => {
    expectPrivateValidationResponse(
      grokErrorForKey(testCase.key),
      testCase.key,
      testCase.leakMarker
    );
  });

  it("reports an actionable bounded ordinal path while preserving first-failure semantics", () => {
    const sensitiveKey = "secret-first-invalid";
    const result = validateClaudeAgentsMap({
      valid: { description: "valid", prompt: "valid" },
      [sensitiveKey]: MALFORMED_DEFINITION,
      later: { description: "later missing prompt" },
    });

    expect(result).toEqual({
      ok: false,
      agentKey: "agents[1]",
      message: EXPECTED_VALIDATION_DETAIL,
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveKey);
    expect(JSON.stringify(result)).not.toContain("later");
  });

  it("keeps nested array issue paths bounded and actionable", () => {
    const result = validateClaudeAgentsMap({
      "secret-agent-name": {
        description: "valid",
        prompt: "valid",
        tools: [17],
      },
    });

    expect(result).toMatchObject({
      ok: false,
      agentKey: "agents[0]",
    });
    if (!result.ok) {
      expect(result.message).toContain("agents[0].tools[0]");
      expect(result.message).not.toContain("secret-agent-name");
    }
  });

  it("preserves valid caller keys and definition values", () => {
    const agents = {
      "unicode-代理-🔐": { description: "unicode", prompt: "valid" },
      "nul\0key": { description: "NUL remains subject to argv admission", prompt: "valid" },
    };

    expect(validateClaudeAgentsMap(agents)).toEqual({ ok: true, value: agents });
  });

  it("reconstructs reserved own agent names on a null-prototype map", () => {
    const result = validateClaudeAgentsMap(reservedAgentMap());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expectReservedAgentKeys(result.value);
    expectReservedAgentKeys(JSON.parse(JSON.stringify(result.value)));
  });

  it.each(RESERVED_AGENT_KEYS)(
    "reports a bounded error for a malformed reserved agent name %s",
    reservedKey => {
      const agents = reservedAgentMap();
      Object.defineProperty(agents, reservedKey, {
        value: MALFORMED_DEFINITION,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const result = validateClaudeAgentsMap(agents);

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected reserved-key validation failure");
      expect(result.agentKey).toMatch(/^agents\[\d+\]$/);
      expect(result.message).not.toContain(reservedKey);
    }
  );

  it.each(["claude_request", "claude_request_async", "grok_request", "grok_request_async"])(
    "preserves reserved own agent names through the registered %s schema",
    async toolName => {
      const root = mkdtempSync(join(tmpdir(), "agent-map-reserved-schema-"));
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
      const server = createGatewayServer({
        asyncJobManager: manager,
        sessionManager: new FileSessionManager(join(root, "sessions.json")),
        persistence: memoryPersistence(),
      });
      const tools = (server as unknown as Record<string, Record<string, RegisteredTool>>)
        ._registeredTools;
      try {
        const tool = tools[toolName];
        expect(tool).toBeDefined();
        const parsed = tool.inputSchema.parse({
          prompt: "review",
          agents: reservedAgentMap(),
        });

        expectReservedAgentKeys(parsed.agents);
      } finally {
        await server.close();
        await manager.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );

  it.each(["claude", "grok"] as const)(
    "preserves all reserved own agent names in %s argv JSON",
    provider => {
      const agents = reservedAgentMap();
      const prep =
        provider === "claude"
          ? prepareClaudeRequest(
              {
                prompt: "review",
                outputFormat: "text",
                dangerouslySkipPermissions: false,
                approvalStrategy: "legacy",
                mcpServers: [],
                strictMcpConfig: false,
                optimizePrompt: false,
                operation: "claude_request",
                correlationId: "agent-map-reserved-claude",
                agents,
              },
              TEST_RUNTIME
            )
          : prepareGrokRequest(
              {
                prompt: "review",
                approvalStrategy: "legacy",
                optimizePrompt: false,
                operation: "grok_request",
                correlationId: "agent-map-reserved-grok",
                agents,
              },
              TEST_RUNTIME
            );

      if (!("args" in prep)) throw new Error(prep.content[0]?.text ?? "expected argv");
      const agentsIndex = prep.args.indexOf("--agents");
      expect(agentsIndex).toBeGreaterThan(-1);
      expectReservedAgentKeys(JSON.parse(prep.args[agentsIndex + 1]!));
    }
  );

  it.each(["claude_request", "claude_request_async", "grok_request", "grok_request_async"])(
    "keeps hostile agent keys out of the registered %s schema error surface",
    async toolName => {
      const root = mkdtempSync(join(tmpdir(), "agent-map-registered-schema-"));
      const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
      const server = createGatewayServer({
        asyncJobManager: manager,
        sessionManager: new FileSessionManager(join(root, "sessions.json")),
        persistence: memoryPersistence(),
      });
      const tools = (server as unknown as Record<string, Record<string, RegisteredTool>>)
        ._registeredTools;
      const tool = tools[toolName];
      const hostileKey = "credential_name=registered-schema-secret-marker";
      try {
        expect(tool).toBeDefined();
        const parsed = tool.inputSchema.parse({
          prompt: "review",
          agents: {
            valid: { description: "valid", prompt: "valid" },
            [hostileKey]: MALFORMED_DEFINITION,
          },
        });
        const response = await tool.handler(parsed, {});

        expect(response.isError).toBe(true);
        expect(response.content[0]?.text).toContain(EXPECTED_VALIDATION_DETAIL);
        expect(JSON.stringify(response)).not.toContain(hostileKey);
        expect(JSON.stringify(response)).not.toContain("registered-schema-secret-marker");
      } finally {
        await server.close();
        await manager.dispose();
        rmSync(root, { recursive: true, force: true });
      }
    }
  );
});
