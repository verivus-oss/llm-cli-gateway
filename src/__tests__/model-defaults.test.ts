import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearModelRegistryCache } from "../model-registry.js";
import {
  prepareClaudeRequest,
  prepareCodexRequest,
  prepareGeminiRequest,
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
