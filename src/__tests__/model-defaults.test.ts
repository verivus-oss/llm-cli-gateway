import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearModelRegistryCache } from "../model-registry.js";
import {
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareGeminiRequest,
  prepareGrokRequest,
  prepareMistralRequest,
} from "../index.js";

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

describe("F15b: claude mcp_managed permission mode", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  function managedClaudeArgs(): string[] {
    const prep = prepareClaudeRequest({
      prompt: "summarize this document",
      outputFormat: "text",
      dangerouslySkipPermissions: false,
      approvalStrategy: "mcp_managed",
      strictMcpConfig: false,
      optimizePrompt: false,
      operation: "claude_request",
    });
    if (!("args" in prep)) throw new Error("expected an approved request prep with args");
    return prep.args;
  }

  it("defaults to acceptEdits (not bypassPermissions) without the operator opt-in", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    const args = managedClaudeArgs();
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("acceptEdits");
    expect(args).not.toContain("bypassPermissions");
  });

  it("escalates to bypassPermissions only with LLM_GATEWAY_APPROVAL_ALLOW_BYPASS", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const args = managedClaudeArgs();
    const idx = args.indexOf("--permission-mode");
    expect(args[idx + 1]).toBe("bypassPermissions");
  });
});

describe("F15b: gemini mcp_managed permission mode", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  function managedGeminiArgs(): string[] {
    const prep = prepareGeminiRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "gemini_request",
    });
    if (!("args" in prep)) throw new Error("expected an approved request prep with args");
    return prep.args;
  }

  // agy has no accept-edits middle rung — only prompted `default` or full yolo.
  it("does not emit --dangerously-skip-permissions without the operator opt-in", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    expect(managedGeminiArgs()).not.toContain("--dangerously-skip-permissions");
  });

  it("escalates to --dangerously-skip-permissions only with LLM_GATEWAY_APPROVAL_ALLOW_BYPASS", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    expect(managedGeminiArgs()).toContain("--dangerously-skip-permissions");
  });
});

describe("F15b: grok mcp_managed permission mode", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  function managedGrokArgs(): string[] {
    const prep = prepareGrokRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "grok_request",
    });
    if (!("args" in prep)) throw new Error("expected an approved request prep with args");
    return prep.args;
  }

  it("defaults to --permission-mode acceptEdits (not --always-approve) without the opt-in", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    const args = managedGrokArgs();
    const idx = args.indexOf("--permission-mode");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toBe("acceptEdits");
    expect(args).not.toContain("--always-approve");
  });

  it("escalates to --always-approve only with LLM_GATEWAY_APPROVAL_ALLOW_BYPASS", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    const args = managedGrokArgs();
    expect(args).toContain("--always-approve");
    expect(args).not.toContain("--permission-mode");
  });
});

describe("F15b: mistral mcp_managed agent mode", () => {
  const original = process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    } else {
      process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = original;
    }
  });

  function managedMistralAgent(): string {
    const prep = prepareMistralRequest({
      prompt: "summarize this document",
      approvalStrategy: "mcp_managed",
      optimizePrompt: false,
      operation: "mistral_request",
    });
    if (!("args" in prep)) throw new Error("expected an approved request prep with args");
    const idx = prep.args.indexOf("--agent");
    expect(idx).toBeGreaterThanOrEqual(0);
    return prep.args[idx + 1];
  }

  it("defaults to --agent accept-edits (not auto-approve) without the opt-in", () => {
    delete process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS;
    expect(managedMistralAgent()).toBe("accept-edits");
  });

  it("escalates to --agent auto-approve only with LLM_GATEWAY_APPROVAL_ALLOW_BYPASS", () => {
    process.env.LLM_GATEWAY_APPROVAL_ALLOW_BYPASS = "1";
    expect(managedMistralAgent()).toBe("auto-approve");
  });
});
