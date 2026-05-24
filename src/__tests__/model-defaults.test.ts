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
