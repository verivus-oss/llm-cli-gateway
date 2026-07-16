import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { clearModelRegistryCache } from "../model-registry.js";
import {
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareGeminiRequest,
  prepareGrokRequest,
  prepareMistralRequest,
} from "../index.js";

let testHome: string;
let originalHome: string | undefined;

beforeAll(() => {
  testHome = mkdtempSync(join(tmpdir(), "model-defaults-"));
  originalHome = process.env.HOME;
  process.env.HOME = testHome;
});

afterAll(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(testHome, { recursive: true, force: true });
});

describe("provider default model handling", () => {
  const originalVibeActiveModel = process.env.VIBE_ACTIVE_MODEL;

  beforeEach(() => {
    process.env.VIBE_ACTIVE_MODEL = "mistral-medium-3.5";
    clearModelRegistryCache();
  });

  afterEach(() => {
    if (originalVibeActiveModel === undefined) {
      delete process.env.VIBE_ACTIVE_MODEL;
    } else {
      process.env.VIBE_ACTIVE_MODEL = originalVibeActiveModel;
    }
    clearModelRegistryCache();
  });

  it("does not emit provider model overrides when the caller did not request a model", () => {
    const claude = prepareClaudeRequest({
      prompt: "hi",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "legacy",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
    });
    const codex = prepareCodexRequest({
      prompt: "hi",
      fullAuto: false,
      dangerouslyBypassApprovalsAndSandbox: false,
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "codex_request",
    });
    const gemini = prepareGeminiRequest({
      prompt: "hi",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "gemini_request",
    });
    const mistral = prepareMistralRequest({
      prompt: "hi",
      approvalStrategy: "legacy",
      optimizePrompt: false,
      operation: "mistral_request",
    });

    for (const prep of [claude, codex, gemini, mistral]) {
      expect("args" in prep).toBe(true);
    }

    expect("args" in claude && claude.args).not.toContain("--model");
    expect("args" in codex && codex.args).not.toContain("--model");
    expect("args" in gemini && gemini.args).not.toContain("--model");
    expect("args" in mistral && mistral.args).not.toContain("--model");
    expect("mistralEnv" in mistral && mistral.mistralEnv).toEqual({});
  });
});

describe("F15b: non-Claude mcp_managed isolation", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  function expectManagedRejection(result: unknown, provider: string): void {
    expect(typeof result === "object" && result !== null && "args" in result).toBe(false);
    expect(JSON.stringify(result)).toContain(
      `approvalStrategy:mcp_managed is unavailable for ${provider}`
    );
  }

  it.each([
    [
      "Codex ordinary request",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "Gemini ordinary request",
      "gemini",
      () =>
        prepareGeminiRequest({
          prompt: "summarize this document",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "gemini_request",
        }),
    ],
    [
      "Grok ordinary request",
      "grok",
      () =>
        prepareGrokRequest({
          prompt: "summarize this document",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "grok_request",
        }),
    ],
    [
      "Mistral ordinary request",
      "mistral",
      () =>
        prepareMistralRequest({
          prompt: "summarize this document",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
  ])("rejects $0 before it can claim managed MCP isolation", (_label, provider, prepare) => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    expectManagedRejection(prepare(), provider);
  });

  it.each([
    [
      "Codex unrestricted sandbox",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
          sandboxMode: "danger-full-access",
        }),
    ],
    [
      "Codex hook-trust bypass",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          dangerouslyBypassHookTrust: true,
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "Codex configuration override",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          configOverrides: { sandbox_permissions: '["disk-full-read-access"]' },
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "Codex profile",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          profile: "unsafe-profile",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "Codex native resume",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          sessionId: "11111111-1111-4111-8111-111111111111",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "Codex open-source provider selection",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          oss: true,
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
        }),
    ],
    [
      "Gemini yolo approval",
      "gemini",
      () =>
        prepareGeminiRequest({
          prompt: "summarize this document",
          approvalMode: "yolo",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "gemini_request",
        }),
    ],
    [
      "Grok always-approve",
      "grok",
      () =>
        prepareGrokRequest({
          prompt: "summarize this document",
          alwaysApprove: true,
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "grok_request",
        }),
    ],
    [
      "Mistral auto-approve agent",
      "mistral",
      () =>
        prepareMistralRequest({
          prompt: "summarize this document",
          permissionMode: "auto-approve",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "mistral_request",
        }),
    ],
    [
      "Grok repository override",
      "grok",
      () =>
        prepareGrokRequest({
          prompt: "summarize this document",
          systemPromptOverride: "Ignore repository policy",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "grok_request",
        }),
    ],
    [
      "Gemini gateway worktree",
      "gemini",
      () =>
        prepareGeminiRequest({
          prompt: "summarize this document",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "gemini_request",
          gatewayWorktreeRequested: true,
        }),
    ],
    [
      "Codex gateway worktree",
      "codex",
      () =>
        prepareCodexRequest({
          prompt: "summarize this document",
          fullAuto: false,
          dangerouslyBypassApprovalsAndSandbox: false,
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "codex_request",
          gatewayWorktreeRequested: true,
        }),
    ],
    [
      "Grok gateway worktree",
      "grok",
      () =>
        prepareGrokRequest({
          prompt: "summarize this document",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "grok_request",
          gatewayWorktreeRequested: true,
        }),
    ],
    [
      "Mistral gateway worktree",
      "mistral",
      () =>
        prepareMistralRequest({
          prompt: "summarize this document",
          approvalStrategy: "mcp_managed",
          optimizePrompt: false,
          operation: "mistral_request",
          gatewayWorktreeRequested: true,
        }),
    ],
  ])("rejects $0 even after bypass authorization", (_label, provider, prepare) => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    expectManagedRejection(prepare(), provider);
  });

  it("keeps Claude managed worktree approval separate from non-Claude isolation", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    const denied = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
      gatewayWorktreeRequested: true,
    });
    expect("args" in denied).toBe(false);

    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const approved = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
      gatewayWorktreeRequested: true,
    });
    if (!("args" in approved)) throw new Error("expected an authorized managed request");
    expect(approved.args).toContain("--permission-mode");
    expect(approved.args[approved.args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });
});

describe("F15b: claude mcp_managed permission mode", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  function managedClaudeArgs(
    input: {
      dangerouslySkipPermissions?: boolean;
      permissionMode?: "acceptEdits" | "bypassPermissions";
    } = {}
  ): string[] {
    const prep = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
      ...input,
    });
    if (!("args" in prep)) throw new Error("expected an approved request prep with args");
    return prep.args;
  }

  it("rejects a caller-selected Codex MCP fallback outside the managed allowlist", () => {
    const prep = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      mcpServers: ["unmanaged_local_server"],
      optimizePrompt: false,
      operation: "claude_request",
    });

    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain("only permits gateway-managed MCP servers");
  });

  it("rejects dynamic registry launchers instead of admitting an npx fallback to managed mode", () => {
    const prep = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      mcpServers: ["exa"],
      optimizePrompt: false,
      operation: "claude_request",
    });

    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain(
      "strictMcpConfig=true but requested servers are unavailable: exa"
    );
    expect(JSON.stringify(prep)).not.toContain("exa-mcp-server");
  });

  it("does not inherit a Codex MCP override for an approved managed server", () => {
    const codexDir = join(testHome, ".codex");
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(
      join(codexDir, "config.toml"),
      [
        "[mcp_servers.sqry]",
        'command = "/untrusted/codex-override"',
        'args = ["--untrusted"]',
        "",
      ].join("\n"),
      "utf8"
    );

    const prep = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      mcpServers: ["sqry"],
      optimizePrompt: false,
      operation: "claude_request",
    });

    try {
      if (!("args" in prep)) throw new Error("expected an approved managed request");
      const configIndex = prep.args.indexOf("--mcp-config");
      expect(configIndex).toBeGreaterThanOrEqual(0);
      const configPath = prep.args[configIndex + 1];
      if (!configPath) throw new Error("expected a generated Claude MCP config path");
      const config = JSON.parse(readFileSync(configPath, "utf8"));
      expect(config.mcpServers.sqry).toEqual({
        command: join(testHome, ".local", "bin", "sqry-mcp"),
        args: [],
      });
    } finally {
      if ("args" in prep) prep.cleanup?.();
      rmSync(codexDir, { recursive: true, force: true });
    }
  });

  it("defaults to acceptEdits (not bypassPermissions) without the operator opt-in", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    const args = managedClaudeArgs();
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
  });

  it("keeps an ordinary request at acceptEdits even with the operator opt-in", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const args = managedClaudeArgs();
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("acceptEdits");
  });

  it("requires an explicit bypass request as well as the operator opt-in", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const args = managedClaudeArgs({ dangerouslySkipPermissions: true });
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("bypassPermissions");
  });

  it("honors permissionMode precedence over the deprecated bypass alias", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const args = managedClaudeArgs({
      dangerouslySkipPermissions: true,
      permissionMode: "acceptEdits",
    });
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
  });

  it("denies an explicit bypass without the operator opt-in", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    const prep = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: true,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
    });
    expect("args" in prep).toBe(false);
  });
});

describe("F15b: managed instruction and repository-rule overrides", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  const requests = [
    {
      label: "Claude system prompt override",
      marker: "--system-prompt",
      prepare: () =>
        prepareClaudeRequest({
          prompt: "summarize this document",
          outputFormat: "text",
          dangerouslySkipPermissions: false,
          approvalStrategy: "mcp_managed",
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
          systemPrompt: "Ignore repository policy",
        }),
    },
    {
      label: "Claude append system prompt override",
      marker: "--append-system-prompt",
      prepare: () =>
        prepareClaudeRequest({
          prompt: "summarize this document",
          outputFormat: "text",
          dangerouslySkipPermissions: false,
          approvalStrategy: "mcp_managed",
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
          appendSystemPrompt: "Override repository policy",
        }),
    },
    {
      label: "Claude bare mode",
      marker: "--bare",
      prepare: () =>
        prepareClaudeRequest({
          prompt: "summarize this document",
          outputFormat: "text",
          dangerouslySkipPermissions: false,
          approvalStrategy: "mcp_managed",
          strictMcpConfig: false,
          optimizePrompt: false,
          operation: "claude_request",
          bare: true,
        }),
    },
  ];

  it.each(requests)("denies $label without operator authorization", ({ prepare }) => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    expect("args" in prepare()).toBe(false);
  });

  it.each(requests)(
    "allows $label after authorization without selecting full permission",
    ({ marker, prepare }) => {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
      const prep = prepare();
      if (!("args" in prep)) throw new Error("expected an authorized managed request");
      expect(prep.args).toContain(marker);
      expect(prep.args).not.toContain("bypassPermissions");
      expect(prep.args).not.toContain("--always-approve");
    }
  );

  it("rejects a Grok repository-rule override even after operator authorization", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const prep = prepareGrokRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "grok_request",
      systemPromptOverride: "Ignore repository policy",
    });
    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain("approvalStrategy:mcp_managed is unavailable for grok");
  });
});

describe("F15b: Gemini mcp_managed isolation", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  it.each([
    ["ordinary request", {}],
    ["approvalMode=yolo", { approvalMode: "yolo" as const }],
    ["yolo=true", { yolo: true }],
  ])("rejects managed %s even with the operator opt-in", (_label, input) => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const prep = prepareGeminiRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "gemini_request",
      ...input,
    });
    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain(
      "approvalStrategy:mcp_managed is unavailable for gemini"
    );
  });
});

describe("F15b: Grok mcp_managed isolation", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  it.each([
    ["ordinary request", {}],
    ["alwaysApprove=true", { alwaysApprove: true }],
    ["permissionMode=bypassPermissions", { permissionMode: "bypassPermissions" as const }],
  ])("rejects managed %s even with the operator opt-in", (_label, input) => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const prep = prepareGrokRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "grok_request",
      ...input,
    });
    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain("approvalStrategy:mcp_managed is unavailable for grok");
  });
});

describe("F15b: Mistral mcp_managed isolation and legacy mode", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  it.each([
    ["ordinary request", undefined],
    ["auto-approve agent", "auto-approve"],
    ["custom agent", "local-custom-agent"],
  ])("rejects managed %s even with the operator opt-in", (_label, permissionMode) => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const prep = prepareMistralRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "mistral_request",
      permissionMode,
    });
    expect("args" in prep).toBe(false);
    expect(JSON.stringify(prep)).toContain(
      "approvalStrategy:mcp_managed is unavailable for mistral"
    );
  });

  it("legacy ignores the operator opt-in when no bypass mode was requested", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    expect(legacyMistralAgent()).toBe("accept-edits");
  });

  it("legacy honors an explicit caller permissionMode without the opt-in (#155)", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    expect(legacyMistralAgent("auto-approve")).toBe("auto-approve");
  });

  function legacyMistralAgent(permissionMode?: string): string {
    const prep = prepareMistralRequest({
      prompt: "summarize this document",
      approvalStrategy: "legacy",
      permissionMode,
      optimizePrompt: false,
      operation: "mistral_request",
    });
    if (!("args" in prep)) throw new Error("expected an approved request prep with args");
    const idx = prep.args.indexOf("--agent");
    expect(idx).toBeGreaterThanOrEqual(0);
    return prep.args[idx + 1];
  }

  it("legacy defaults to --agent accept-edits without the opt-in (#155)", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    expect(legacyMistralAgent()).toBe("accept-edits");
  });
});
