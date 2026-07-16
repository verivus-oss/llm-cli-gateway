import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  handleGeminiRequestAsync,
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareCursorRequest,
  prepareDevinRequest,
  prepareGeminiRequest,
  prepareGrokRequest,
  prepareMistralRequest,
} from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import {
  CODEX_CONFIG_OVERRIDES_SCHEMA,
  prepareClaudeHighImpactFlags,
  prepareCodexHighImpactFlags,
  plannedCodexOutputSchemaPath,
  resolveCodexSessionArgs,
  resolveGeminiSessionPlan,
  resolveGrokSessionArgs,
  resolveMistralSessionArgs,
} from "../request-helpers.js";
import {
  CLI_INPUT_TOO_LARGE_CATEGORY,
  CliInputTooLargeError,
  MAX_CLI_ARG_UTF8_BYTES,
  MAX_CLI_ARGV_UTF8_BYTES_LINUX,
  measureCliArgvUtf8Bytes,
} from "../cli-input-limits.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

const OVERSIZED = "中".repeat(Math.ceil((MAX_CLI_ARG_UTF8_BYTES + 1) / 3));
const WINDOWS_CMD_WRAPPER_OVERSIZED = "^".repeat(4_000);
const TEST_RUNTIME = {
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  personalConfig: { settings: { enabled: false } },
} as never;

function overrideProcessPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!descriptor) throw new Error("process.platform descriptor is unavailable");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  return () => Object.defineProperty(process, "platform", descriptor);
}

function expectAdmissionError(result: unknown, inputName: string): void {
  expect(result).toMatchObject({
    isError: true,
    structuredContent: {
      errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
      retryable: false,
    },
  });
  const response = result as { content: Array<{ text: string }> };
  expect(response.content[0]?.text).toContain(inputName);
  expect(response.content[0]?.text).not.toContain(OVERSIZED);
}

function expectTypedAdmissionError(run: () => unknown, provider: string, inputName: string): void {
  try {
    run();
    throw new Error("expected argv admission to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(CliInputTooLargeError);
    expect(error).toMatchObject({
      provider,
      inputName,
      errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
      retryable: false,
    });
  }
}

describe("provider argv admission", () => {
  it.each([
    ["agent", { agent: OVERSIZED }],
    ["agents", { agents: { reviewer: { description: "review", prompt: OVERSIZED } } }],
    ["systemPrompt", { systemPrompt: OVERSIZED }],
    ["appendSystemPrompt", { appendSystemPrompt: OVERSIZED }],
    ["fallbackModel", { fallbackModel: OVERSIZED }],
    ["jsonSchema", { jsonSchema: { description: OVERSIZED } }],
    ["addDir[0]", { addDir: [OVERSIZED] }],
    ["settingSources", { settingSources: OVERSIZED }],
    ["settings", { settings: OVERSIZED }],
    ["tools[0]", { tools: [OVERSIZED] }],
    ["systemPromptFile", { systemPromptFile: OVERSIZED }],
    ["appendSystemPromptFile", { appendSystemPromptFile: OVERSIZED }],
    ["name", { name: OVERSIZED }],
    ["pluginDir[0]", { pluginDir: [OVERSIZED] }],
    ["pluginUrl[0]", { pluginUrl: [OVERSIZED] }],
    ["debug", { debug: OVERSIZED }],
    ["debugFile", { debugFile: OVERSIZED }],
  ] as const)("rejects Claude %s during pure pre-spawn planning", (inputName, input) => {
    expectTypedAdmissionError(
      () => prepareClaudeHighImpactFlags(input as never),
      "claude",
      inputName
    );
  });

  it.each([
    ["outputSchema", { outputSchema: OVERSIZED }],
    ["profile", { profile: OVERSIZED }],
    ["configOverrides[0]", { configOverrides: { rule: OVERSIZED } }],
    ["images[0]", { images: [OVERSIZED] }],
    ["enable[0]", { enable: [OVERSIZED] }],
    ["disable[0]", { disable: [OVERSIZED] }],
  ] as const)("rejects Codex %s during pure pre-spawn planning", (inputName, input) => {
    expectTypedAdmissionError(
      () => prepareCodexHighImpactFlags(input as never),
      "codex",
      inputName
    );
  });

  it("keeps a valid oversized Codex override key out of public error metadata", () => {
    const key = "a".repeat(131_072);
    expect(CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ [key]: "" }).success).toBe(true);
    try {
      prepareCodexHighImpactFlags({ configOverrides: { [key]: "" } });
      throw new Error("expected argv admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(CliInputTooLargeError);
      expect(error).toMatchObject({ inputName: "configOverrides[0]" });
      expect((error as Error).message).not.toContain(key);
      const serialized = JSON.stringify(error);
      expect(serialized).not.toContain(key);
      expect(serialized.length).toBeLessThan(2_048);
    }
  });

  it("keeps an invalid oversized Codex override key out of serialized Zod errors", () => {
    const key = `invalid=${"sensitive".repeat(16_384)}`;
    const parsed = CODEX_CONFIG_OVERRIDES_SCHEMA.safeParse({ [key]: "" });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    expect(parsed.error.issues).toMatchObject([
      {
        path: ["configOverrides[0]"],
        message:
          "configOverrides keys must match /^[a-zA-Z0-9._]+$/ (no whitespace, '=', or flag-like prefixes)",
      },
    ]);
    for (const serialized of [parsed.error.message, JSON.stringify(parsed.error)]) {
      expect(serialized).not.toContain(key);
      expect(serialized).not.toContain(key.slice(0, 1_024));
      expect(serialized.length).toBeLessThan(2_048);
    }
  });

  it("rejects aggregate Codex overrides before schema materialization or image reads", () => {
    const testTmp = mkdtempSync(join(tmpdir(), "codex-argv-admission-"));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = testTmp;
    try {
      const configOverrides = Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [
          `${String.fromCharCode(97 + index)}${"a".repeat(119_999)}`,
          "",
        ])
      );
      const result = prepareCodexRequest({
        prompt: "review",
        fullAuto: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        optimizePrompt: false,
        operation: "codex_request",
        configOverrides,
        outputSchema: { type: "object" },
        images: [join(testTmp, "missing.png")],
      });
      expectAdmissionError(result, "argv aggregate");
      expect(readdirSync(testTmp)).toEqual([]);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      rmSync(testTmp, { recursive: true, force: true });
    }
  });

  it("uses an exact-byte-length placeholder for deferred Codex schema materialization", () => {
    const plan = prepareCodexHighImpactFlags(
      { outputSchema: { type: "object" } },
      { deferFilesystem: true }
    );
    const materialized = prepareCodexHighImpactFlags({ outputSchema: { type: "object" } });
    const actualPath = materialized.args[materialized.args.indexOf("--output-schema") + 1]!;
    try {
      const plannedPath = plan.args[plan.args.indexOf("--output-schema") + 1]!;
      expect(plannedPath).toBe(plannedCodexOutputSchemaPath());
      expect(Buffer.byteLength(actualPath, "utf8")).toBe(Buffer.byteLength(plannedPath, "utf8"));
      expect(existsSync(actualPath)).toBe(true);
    } finally {
      materialized.cleanup();
      expect(existsSync(actualPath)).toBe(false);
    }
  });

  it("returns structured admission metadata for Claude instruction JSON", () => {
    const result = prepareClaudeRequest({
      prompt: "review",
      outputFormat: "text",
      allowedTools: [],
      disallowedTools: [],
      dangerouslySkipPermissions: false,
      approvalStrategy: "legacy",
      mcpServers: [],
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
      agents: { reviewer: { description: "review", prompt: OVERSIZED } },
    });
    expectAdmissionError(result, "agents");
  });

  it("rejects oversized Claude argv before creating an MCP config artifact", () => {
    const testHome = mkdtempSync(join(tmpdir(), "claude-argv-admission-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = testHome;
    try {
      const artifactRoot = join(testHome, ".llm-cli-gateway", "claude-mcp");
      const result = prepareClaudeRequest({
        prompt: "review",
        outputFormat: "text",
        allowedTools: [],
        disallowedTools: [],
        dangerouslySkipPermissions: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        strictMcpConfig: true,
        optimizePrompt: false,
        operation: "claude_request",
        systemPrompt: OVERSIZED,
      });
      expectAdmissionError(result, "systemPrompt");
      expect(existsSync(artifactRoot)).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("rejects aggregate Claude argv before creating an MCP config artifact", () => {
    const testHome = mkdtempSync(join(tmpdir(), "claude-argv-aggregate-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = testHome;
    try {
      const artifactRoot = join(testHome, ".llm-cli-gateway", "claude-mcp");
      const result = prepareClaudeRequest({
        prompt: "review",
        outputFormat: "text",
        allowedTools: Array.from(
          { length: 9 },
          (_, index) => `${String(index)}${"x".repeat(119_999)}`
        ),
        disallowedTools: [],
        dangerouslySkipPermissions: false,
        approvalStrategy: "legacy",
        mcpServers: [],
        strictMcpConfig: true,
        optimizePrompt: false,
        operation: "claude_request",
      });
      expectAdmissionError(result, "argv aggregate");
      expect(existsSync(artifactRoot)).toBe(false);
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("applies Windows cmd-wrapper preflight to every provider before Claude artifacts", () => {
    const testHome = mkdtempSync(join(tmpdir(), "windows-provider-preflight-home-"));
    const originalHome = process.env.HOME;
    process.env.HOME = testHome;
    const restorePlatform = overrideProcessPlatform("win32");

    try {
      const runs: Array<[string, () => unknown]> = [
        [
          "claude",
          () =>
            prepareClaudeRequest({
              prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
              outputFormat: "text",
              allowedTools: [],
              disallowedTools: [],
              dangerouslySkipPermissions: false,
              approvalStrategy: "legacy",
              mcpServers: [],
              strictMcpConfig: true,
              optimizePrompt: false,
              operation: "claude_request",
            }),
        ],
        [
          "codex",
          () =>
            prepareCodexRequest({
              prompt: "review",
              model: WINDOWS_CMD_WRAPPER_OVERSIZED,
              fullAuto: false,
              dangerouslyBypassApprovalsAndSandbox: false,
              approvalStrategy: "legacy",
              mcpServers: [],
              optimizePrompt: false,
              operation: "codex_request",
            }),
        ],
        [
          "gemini",
          () =>
            prepareGeminiRequest({
              prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
              approvalStrategy: "legacy",
              optimizePrompt: false,
              operation: "gemini_request",
            }),
        ],
        [
          "grok",
          () =>
            prepareGrokRequest({
              prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
              approvalStrategy: "legacy",
              optimizePrompt: false,
              operation: "grok_request",
            }),
        ],
        [
          "mistral",
          () =>
            prepareMistralRequest({
              prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
              approvalStrategy: "legacy",
              optimizePrompt: false,
              operation: "mistral_request",
            }),
        ],
        [
          "devin",
          () =>
            prepareDevinRequest(
              {
                prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
                optimizePrompt: false,
                operation: "devin_request",
              },
              TEST_RUNTIME
            ),
        ],
        [
          "cursor",
          () =>
            prepareCursorRequest(
              {
                prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
                optimizePrompt: false,
                operation: "cursor_request",
              },
              TEST_RUNTIME
            ),
        ],
      ];

      for (const [provider, run] of runs) {
        const result = run();
        expectAdmissionError(result, "argv aggregate");
        expect((result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
          provider
        );
      }

      expect(existsSync(join(testHome, ".llm-cli-gateway", "claude-mcp"))).toBe(false);
    } finally {
      restorePlatform();
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      rmSync(testHome, { recursive: true, force: true });
    }
  });

  it("rejects a Windows wrapper-sized async request before worktree, session, or job writes", async () => {
    const repository = mkdtempSync(join(tmpdir(), "windows-async-admission-repo-"));
    const store = new MemoryJobStore();
    const recordStart = vi.spyOn(store, "recordStart");
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const startJob = vi.spyOn(manager, "startJob");
    const sessionManager = {
      createSession: vi.fn(),
      getSession: vi.fn(),
      listSessions: vi.fn(),
      deleteSession: vi.fn(),
      setActiveSession: vi.fn(),
      getActiveSession: vi.fn(),
      updateSessionUsage: vi.fn(),
      updateSessionMetadata: vi.fn(),
      clearAllSessions: vi.fn(),
    };
    const runtime = {
      sessionManager,
      asyncJobManager: manager,
      logger: noopLogger,
      personalConfig: { settings: { enabled: false } },
      workspaces: {
        enabled: true,
        defaultAlias: null,
        allowUnregisteredWorkingDir: false,
        repos: [
          {
            alias: "review",
            path: repository,
            providers: ["gemini"],
            allowWorktree: true,
            allowAddDir: false,
            kind: "git",
            operatorEntry: true,
          },
        ],
        allowedRoots: [],
        sources: { configFile: null },
      },
      compression: { enabled: false, sources: { configFile: null } },
    } as never;
    const restorePlatform = overrideProcessPlatform("win32");

    try {
      const result = await handleGeminiRequestAsync(
        {
          sessionManager: sessionManager as never,
          asyncJobManager: manager,
          logger: noopLogger,
          runtime,
        },
        {
          prompt: WINDOWS_CMD_WRAPPER_OVERSIZED,
          sessionId: "00000000-0000-4000-8000-000000000001",
          resumeLatest: false,
          createNewSession: false,
          approvalStrategy: "legacy",
          optimizePrompt: false,
          workspace: "review",
          worktree: { name: "must-not-exist" },
        }
      );

      expectAdmissionError(result, "argv aggregate");
      expect(sessionManager.createSession).not.toHaveBeenCalled();
      expect(sessionManager.getSession).not.toHaveBeenCalled();
      expect(sessionManager.updateSessionUsage).not.toHaveBeenCalled();
      expect(startJob).not.toHaveBeenCalled();
      expect(recordStart).not.toHaveBeenCalled();
      expect(readdirSync(repository)).toEqual([]);
    } finally {
      restorePlatform();
      await manager.dispose();
      store.close();
      rmSync(repository, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === "linux")(
    "includes planned Claude continuation in admission before MCP artifact materialization",
    () => {
      const testHome = mkdtempSync(join(tmpdir(), "claude-session-argv-home-"));
      const originalHome = process.env.HOME;
      process.env.HOME = testHome;
      try {
        const baseTools = Array.from(
          { length: 8 },
          (_, index) => `${String(index)}${"x".repeat(119_998)}`
        );
        const seedTools = [...baseTools, "x"];
        const seed = prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: seedTools,
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
        });
        if (!("args" in seed)) throw new Error("expected seed argv");
        const delta = MAX_CLI_ARGV_UTF8_BYTES_LINUX - measureCliArgvUtf8Bytes("claude", seed.args);
        expect(delta).toBeGreaterThan(0);
        seedTools[seedTools.length - 1] = "x".repeat(1 + delta);

        const result = prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: seedTools,
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: true,
          optimizePrompt: false,
          operation: "claude_request",
          nativeResumeRequested: true,
          nativeSessionArgs: ["--continue"],
        });
        expectAdmissionError(result, "final argv aggregate");
        expect(existsSync(join(testHome, ".llm-cli-gateway", "claude-mcp"))).toBe(false);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
      }
    }
  );

  it.runIf(process.platform === "linux")(
    "cleans a Claude MCP artifact when its generated path crosses the exact-final argv limit",
    () => {
      const testHome = mkdtempSync(join(tmpdir(), "claude-argv-final-home-"));
      const originalHome = process.env.HOME;
      process.env.HOME = testHome;
      try {
        const baseTools = Array.from(
          { length: 8 },
          (_, index) => `${String(index)}${"x".repeat(119_999)}`
        );
        const base = prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: baseTools,
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
        }) as { args: string[] };
        const remaining =
          MAX_CLI_ARGV_UTF8_BYTES_LINUX - measureCliArgvUtf8Bytes("claude", base.args);
        expect(remaining).toBeGreaterThan(1);
        expect(remaining - 1).toBeLessThanOrEqual(MAX_CLI_ARG_UTF8_BYTES);

        const boundaryTools = [...baseTools, "z".repeat(remaining - 1)];
        const pureBoundary = prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: boundaryTools,
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
        }) as { args: string[] };
        expect(measureCliArgvUtf8Bytes("claude", pureBoundary.args)).toBe(
          MAX_CLI_ARGV_UTF8_BYTES_LINUX
        );

        const result = prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: boundaryTools,
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: true,
          optimizePrompt: false,
          operation: "claude_request",
        });
        expectAdmissionError(result, "argv aggregate");

        const artifactRoot = join(testHome, ".llm-cli-gateway", "claude-mcp");
        const artifactEntries = readdirSync(artifactRoot);
        const requestDirectories = artifactEntries.filter(entry => entry.startsWith("request."));
        expect(requestDirectories).toHaveLength(1);
        // Cleanup removes the sensitive config payload. The scope-only request
        // directory remains by design so durable cleanup/recovery can prove its
        // identity without recreating filesystem authority.
        expect(readdirSync(join(artifactRoot, requestDirectories[0]!))).toEqual([
          ".artifact-scope-id",
        ]);
      } finally {
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ["model", { model: OVERSIZED }],
    ["reasoningEffort", { reasoningEffort: OVERSIZED }],
    ["promptJson", { promptJson: { instruction: OVERSIZED } }],
    ["agents", { agents: { reviewer: { description: "review", prompt: OVERSIZED } } }],
    ["systemPromptOverride", { systemPromptOverride: OVERSIZED }],
    ["rules", { rules: OVERSIZED }],
    ["workingDir", { workingDir: OVERSIZED }],
    ["sandbox", { sandbox: OVERSIZED }],
    ["agent", { agent: OVERSIZED }],
    ["jsonSchema", { jsonSchema: { description: OVERSIZED } }],
    ["nativeWorktree", { nativeWorktree: OVERSIZED }],
    ["worktreeRef", { nativeWorktree: true, worktreeRef: OVERSIZED }],
    ["allow[0]", { allow: [OVERSIZED] }],
    ["deny[0]", { deny: [OVERSIZED] }],
    ["promptFile", { promptFile: OVERSIZED }],
    ["leaderSocket", { leaderSocket: OVERSIZED }],
  ] as const)("rejects Grok %s before a provider can spawn", (inputName, input) => {
    const result = prepareGrokRequest({
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "grok_request",
      ...input,
    } as never);
    expectAdmissionError(result, inputName);
  });

  it("checks Grok's final joined tool CSV instead of only its source elements", () => {
    const half = "x".repeat(Math.ceil(MAX_CLI_ARG_UTF8_BYTES / 2));
    const result = prepareGrokRequest({
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "grok_request",
      allowedTools: [half, half],
    });
    expectAdmissionError(result, "allowedTools");
  });

  it("checks Grok's final joined disallowed-tool CSV", () => {
    const half = "x".repeat(Math.ceil(MAX_CLI_ARG_UTF8_BYTES / 2));
    const result = prepareGrokRequest({
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "grok_request",
      disallowedTools: [half, half],
    });
    expectAdmissionError(result, "disallowedTools");
  });

  it.each([
    [
      "claude",
      "model",
      () =>
        prepareClaudeRequest({
          prompt: "review",
          model: OVERSIZED,
          outputFormat: "text",
          allowedTools: [],
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
        }),
    ],
    [
      "claude",
      "allowedTools[0]",
      () =>
        prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: [OVERSIZED],
          disallowedTools: [],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
        }),
    ],
    [
      "claude",
      "disallowedTools[0]",
      () =>
        prepareClaudeRequest({
          prompt: "review",
          outputFormat: "text",
          allowedTools: [],
          disallowedTools: [OVERSIZED],
          dangerouslySkipPermissions: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
        }),
    ],
    [
      "codex",
      "model",
      () =>
        prepareCodexRequest({
          prompt: "review",
          model: OVERSIZED,
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "codex",
      "workingDir",
      () =>
        prepareCodexRequest({
          prompt: "review",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          optimizePrompt: false,
          operation: "codex_request",
          workingDir: OVERSIZED,
        }),
    ],
    [
      "codex",
      "addDir[0]",
      () =>
        prepareCodexRequest({
          prompt: "review",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          optimizePrompt: false,
          operation: "codex_request",
          addDir: [OVERSIZED],
        }),
    ],
    [
      "codex",
      "outputLastMessage",
      () =>
        prepareCodexRequest({
          prompt: "review",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "legacy",
          mcpServers: [],
          optimizePrompt: false,
          operation: "codex_request",
          outputLastMessage: OVERSIZED,
        }),
    ],
    [
      "gemini",
      "model",
      () =>
        prepareGeminiRequest({
          prompt: "review",
          model: OVERSIZED,
          approvalStrategy: "legacy",
          optimizePrompt: false,
          operation: "gemini_request",
        }),
    ],
    [
      "gemini",
      "includeDirs[0]",
      () =>
        prepareGeminiRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          includeDirs: [OVERSIZED],
          optimizePrompt: false,
          operation: "gemini_request",
        }),
    ],
    [
      "gemini",
      "project",
      () =>
        prepareGeminiRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          project: OVERSIZED,
          optimizePrompt: false,
          operation: "gemini_request",
        }),
    ],
    [
      "gemini",
      "printTimeout",
      () =>
        prepareGeminiRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          printTimeout: OVERSIZED,
          optimizePrompt: false,
          operation: "gemini_request",
        }),
    ],
    [
      "mistral",
      "permissionMode",
      () =>
        prepareMistralRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          permissionMode: OVERSIZED,
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
    [
      "mistral",
      "allowedTools[0]",
      () =>
        prepareMistralRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          allowedTools: [OVERSIZED],
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
    [
      "mistral",
      "disallowedTools[0]",
      () =>
        prepareMistralRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          disallowedTools: [OVERSIZED],
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
    [
      "mistral",
      "workingDir",
      () =>
        prepareMistralRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          workingDir: OVERSIZED,
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
    [
      "mistral",
      "addDir[0]",
      () =>
        prepareMistralRequest({
          prompt: "review",
          approvalStrategy: "legacy",
          addDir: [OVERSIZED],
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
    [
      "devin",
      "model",
      () =>
        prepareDevinRequest(
          {
            prompt: "review",
            model: OVERSIZED,
            optimizePrompt: false,
            operation: "devin_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "devin",
      "promptFile",
      () =>
        prepareDevinRequest(
          {
            prompt: "review",
            promptFile: OVERSIZED,
            optimizePrompt: false,
            operation: "devin_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "devin",
      "config",
      () =>
        prepareDevinRequest(
          {
            prompt: "review",
            config: OVERSIZED,
            optimizePrompt: false,
            operation: "devin_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "devin",
      "exportSession",
      () =>
        prepareDevinRequest(
          {
            prompt: "review",
            exportSession: OVERSIZED,
            optimizePrompt: false,
            operation: "devin_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "devin",
      "agentConfig",
      () =>
        prepareDevinRequest(
          {
            prompt: "review",
            agentConfig: OVERSIZED,
            optimizePrompt: false,
            operation: "devin_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "cursor",
      "model",
      () =>
        prepareCursorRequest(
          {
            prompt: "review",
            model: OVERSIZED,
            optimizePrompt: false,
            operation: "cursor_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "cursor",
      "workspace",
      () =>
        prepareCursorRequest(
          {
            prompt: "review",
            workspace: OVERSIZED,
            optimizePrompt: false,
            operation: "cursor_request",
          },
          TEST_RUNTIME
        ),
    ],
    [
      "cursor",
      "addDir[0]",
      () =>
        prepareCursorRequest(
          {
            prompt: "review",
            addDir: [OVERSIZED],
            optimizePrompt: false,
            operation: "cursor_request",
          },
          TEST_RUNTIME
        ),
    ],
  ] as const)("rejects %s %s through its public prep contract", (_provider, inputName, run) => {
    expectAdmissionError(run(), inputName);
  });

  it.each([
    ["codex", () => resolveCodexSessionArgs({ sessionId: OVERSIZED })],
    ["gemini", () => resolveGeminiSessionPlan({ sessionId: OVERSIZED })],
    ["grok", () => resolveGrokSessionArgs({ sessionId: OVERSIZED, provider: "grok" })],
    ["devin", () => resolveGrokSessionArgs({ sessionId: OVERSIZED, provider: "devin" })],
    ["cursor", () => resolveGrokSessionArgs({ sessionId: OVERSIZED, provider: "cursor" })],
    ["mistral", () => resolveMistralSessionArgs({ sessionId: OVERSIZED })],
  ] as const)("rejects %s sessionId before handler-side argv insertion", (provider, run) => {
    expectTypedAdmissionError(run, provider, "sessionId");
  });

  it("keeps normal serialized, joined, and scalar values byte-exact", () => {
    const claudeAgents = {
      reviewer: { description: "review", prompt: "inspect code", tools: ["Read"] },
    };
    expect(prepareClaudeHighImpactFlags({ agents: claudeAgents })).toEqual([
      "--agents",
      JSON.stringify(claudeAgents),
    ]);

    const grok = prepareGrokRequest({
      prompt: "review",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "grok_request",
      allowedTools: ["Read", "Write"],
      promptJson: { role: "reviewer", strict: true },
    });
    if (!("args" in grok)) throw new Error("expected Grok argv");
    expect(grok.args).toContain("Read,Write");
    expect(grok.args).toContain(JSON.stringify({ role: "reviewer", strict: true }));

    expect(prepareCodexHighImpactFlags({ configOverrides: { review: '"strict"' } }).args).toEqual([
      "-c",
      'review="strict"',
    ]);
  });
});
