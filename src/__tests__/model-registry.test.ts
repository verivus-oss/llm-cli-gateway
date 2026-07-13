import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearModelRegistryCache,
  getAvailableCliInfo,
  getCliInfo,
  resolveModelAlias,
} from "../model-registry.js";

const ENV_KEYS = [
  "CLAUDE_DEFAULT_MODEL",
  "CLAUDE_MODELS",
  "CLAUDE_MODEL_ALIASES",
  "CLAUDE_SETTINGS_PATH",
  "CLAUDE_SETTINGS_LOCAL_PATH",
  "CODEX_DEFAULT_MODEL",
  "CODEX_MODELS",
  "CODEX_MODEL_ALIASES",
  "CODEX_CONFIG_PATH",
  "GEMINI_DEFAULT_MODEL",
  "GEMINI_MODELS",
  "GEMINI_MODEL_ALIASES",
  "GEMINI_SETTINGS_PATH",
  "GEMINI_HISTORY_ROOT",
  "GEMINI_HISTORY_MAX_FILES",
  "GEMINI_HISTORY_MAX_FILE_BYTES",
  "GEMINI_DISABLE_HISTORY_DISCOVERY",
  "GROK_DEFAULT_MODEL",
  "GROK_MODELS",
  "GROK_MODEL_ALIASES",
  "GROK_CONFIG_PATH",
  "MISTRAL_DEFAULT_MODEL",
  "MISTRAL_MODELS",
  "MISTRAL_MODEL_ALIASES",
  "VIBE_ACTIVE_MODEL",
  "VIBE_HOME",
  "VIBE_MODELS",
  "LLM_GATEWAY_DISABLE_MODEL_DISCOVERY",
  "LLM_GATEWAY_MODEL_ALIASES",
] as const;

describe("model registry", () => {
  let tempDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tempDir = mkdtemp();
    originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
    ENV_KEYS.forEach(key => delete process.env[key]);

    process.env.CLAUDE_SETTINGS_PATH = join(tempDir, "missing-claude-settings.json");
    process.env.CLAUDE_SETTINGS_LOCAL_PATH = join(tempDir, "missing-claude-local-settings.json");
    process.env.CODEX_CONFIG_PATH = join(tempDir, "missing-codex-config.toml");
    process.env.GROK_CONFIG_PATH = join(tempDir, "missing-grok-config.toml");
    process.env.GEMINI_SETTINGS_PATH = join(tempDir, "missing-gemini-settings.json");
    process.env.GEMINI_HISTORY_ROOT = join(tempDir, "missing-gemini-history");
    process.env.VIBE_HOME = join(tempDir, "missing-vibe-home");
    clearModelRegistryCache();
  });

  afterEach(() => {
    clearModelRegistryCache();
    ENV_KEYS.forEach(key => {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    });
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("defaults Codex to gpt-5.5 (U26) and keeps gpt-5.3-codex as backwards-compat", () => {
    const info = getCliInfo(true);

    // U26: bundled fallback default is gpt-5.5.
    expect(info.codex.defaultModel).toBe("gpt-5.5");
    expect(resolveModelAlias("codex", "default", info)).toBe("gpt-5.5");
    expect(resolveModelAlias("codex", "latest", info)).toBe("gpt-5.5");

    // Backwards-compat: the legacy alias still resolves to itself.
    expect(resolveModelAlias("codex", "gpt-5.3-codex", info)).toBe("gpt-5.3-codex");
    expect(info.codex.models["gpt-5.3-codex"]).toBeDefined();
  });

  it("does not report bundled fallback hints as validated available models", () => {
    const info = getAvailableCliInfo(true);

    expect(info.claude.models).toEqual({});
    expect(info.claude.defaultModel).toBeUndefined();
    expect(info.claude.unverifiedModelHints?.sonnet).toContain("Balanced performance");
    expect(info.claude.warnings?.join("\n")).toContain("not validated");

    expect(info.codex.models).toEqual({});
    expect(info.codex.defaultModel).toBeUndefined();
    expect(info.codex.unverifiedModelHints?.["gpt-5.5"]).toContain("Latest Codex");
  });

  it("reads Codex default, profile models, and migrations from config.toml", () => {
    const configPath = join(tempDir, "codex.toml");
    writeFileSync(
      configPath,
      [
        'model = "gpt-5.5"',
        "",
        "[profiles.fast]",
        'model = "gpt-5.3-codex-spark"',
        "",
        "[notice.model_migrations]",
        '"gpt-5.2" = "gpt-5.3-codex"',
      ].join("\n")
    );
    process.env.CODEX_CONFIG_PATH = configPath;

    const info = getCliInfo(true);

    expect(info.codex.defaultModel).toBe("gpt-5.5");
    expect(info.codex.defaultModelSource).toBe(configPath);
    expect(info.codex.models["gpt-5.3-codex-spark"]).toContain("profile");
    expect(info.codex.models["gpt-5.2"]).toContain("Legacy model");
    expect(resolveModelAlias("codex", "default", info)).toBe("gpt-5.5");
  });

  it("merges observed Gemini models without making local history authoritative", () => {
    const chatDir = join(tempDir, "gemini", "project", "chats");
    mkdirSync(chatDir, { recursive: true });
    writeFileSync(
      join(chatDir, "chat.json"),
      JSON.stringify({
        history: [{ request: { model: "gemini-3.0-flash-preview" } }],
      })
    );
    process.env.GEMINI_HISTORY_ROOT = join(tempDir, "gemini");

    const info = getCliInfo(true);

    expect(info.gemini.models["gemini-3.0-flash-preview"]).toContain("Observed");
    expect(info.gemini.modelMetadata?.["gemini-3.0-flash-preview"]?.source).toBe("observed");
    expect(info.gemini.defaultModel).toBeUndefined();
    expect(resolveModelAlias("gemini", "default", info)).toBeUndefined();
    expect(resolveModelAlias("gemini", "flash", info)).toBe("gemini-3.0-flash-preview");
  });

  it("supports structured env models and explicit aliases", () => {
    process.env.GEMINI_MODELS = JSON.stringify({
      "gemini-team-default": "Team-approved Gemini model",
    });
    process.env.GEMINI_MODEL_ALIASES = "team=gemini-team-default";
    process.env.GEMINI_DEFAULT_MODEL = "gemini-team-default";
    process.env.LLM_GATEWAY_MODEL_ALIASES =
      "codex.fast=gpt-5.3-codex-spark,gemini.fast=gemini-team-default";

    const info = getCliInfo(true);

    expect(info.gemini.models["gemini-team-default"]).toBe("Team-approved Gemini model");
    expect(info.gemini.defaultModel).toBe("gemini-team-default");
    expect(resolveModelAlias("gemini", "team", info)).toBe("gemini-team-default");
    expect(resolveModelAlias("gemini", "fast", info)).toBe("gemini-team-default");
    expect(resolveModelAlias("codex", "fast", info)).toBe("gpt-5.3-codex-spark");
  });

  it("keeps explicitly configured models in the available model view", () => {
    process.env.GEMINI_MODELS = JSON.stringify({
      "gemini-team-default": "Team-approved Gemini model",
    });
    process.env.GEMINI_DEFAULT_MODEL = "gemini-team-default";

    const info = getAvailableCliInfo(true);

    expect(info.gemini.models["gemini-team-default"]).toBe("Team-approved Gemini model");
    expect(info.gemini.defaultModel).toBe("gemini-team-default");
    expect(info.gemini.unverifiedModelHints?.["gemini-2.5-pro"]).toBeDefined();
  });

  it("seeds Grok with grok-build as a fallback model and no default", () => {
    const info = getCliInfo(true);

    expect(info.grok.models["grok-build"]).toContain("Default Grok model");
    expect(info.grok.defaultModel).toBeUndefined();
    expect(resolveModelAlias("grok", "default", info)).toBeUndefined();
  });

  it("supports env-driven Grok default model and aliases", () => {
    process.env.GROK_MODELS = JSON.stringify({
      "grok-team-pin": "Team-approved Grok model",
    });
    process.env.GROK_MODEL_ALIASES = "team=grok-team-pin";
    process.env.GROK_DEFAULT_MODEL = "grok-team-pin";

    const info = getCliInfo(true);

    expect(info.grok.models["grok-team-pin"]).toBe("Team-approved Grok model");
    expect(info.grok.defaultModel).toBe("grok-team-pin");
    expect(resolveModelAlias("grok", "team", info)).toBe("grok-team-pin");
    expect(resolveModelAlias("grok", "default", info)).toBe("grok-team-pin");
  });

  it("reads Grok default and custom models from ~/.grok/config.toml", () => {
    const configPath = join(tempDir, "grok-config.toml");
    writeFileSync(
      configPath,
      [
        "[models]",
        'default = "grok-build"',
        'reasoning = "grok-reasoning-2"',
        "",
        "[ui]",
        'fork_secondary_model = "grok-fast-1"',
      ].join("\n")
    );
    process.env.GROK_CONFIG_PATH = configPath;

    const info = getCliInfo(true);

    // Configured default is represented (not hardcoded).
    expect(info.grok.defaultModel).toBe("grok-build");
    expect(info.grok.defaultModelSource).toContain("[models].default");
    // Custom model facts from config are surfaced.
    expect(info.grok.models["grok-reasoning-2"]).toContain("Custom Grok model");
    expect(info.grok.models["grok-fast-1"]).toContain("fork/secondary");
    // An explicit env default still wins over the config default.
    process.env.GROK_DEFAULT_MODEL = "grok-reasoning-2";
    const withEnv = getCliInfo(true);
    expect(withEnv.grok.defaultModel).toBe("grok-reasoning-2");
  });

  it("does not hardcode a Mistral default when Vibe has no config", () => {
    const info = getCliInfo(true);

    expect(info.mistral.models["mistral-medium-3.5"]).toContain("Vibe coding model alias");
    expect(info.mistral.defaultModel).toBeUndefined();
    expect(resolveModelAlias("mistral", "latest", info)).toBeUndefined();
    expect(resolveModelAlias("mistral", "default", info)).toBeUndefined();
    expect(resolveModelAlias("mistral", "mistral-medium-3.5", info)).toBe("mistral-medium-3.5");
  });

  it("uses VIBE_ACTIVE_MODEL to override the Mistral default when set", () => {
    process.env.VIBE_ACTIVE_MODEL = "mistral-medium-3.5";
    const info = getCliInfo(true);
    expect(info.mistral.defaultModel).toBe("mistral-medium-3.5");
    expect(resolveModelAlias("mistral", "latest", info)).toBe("mistral-medium-3.5");
  });

  it("discovers Mistral models and active_model from Vibe config", () => {
    const vibeHome = join(tempDir, "vibe-home");
    mkdirSync(vibeHome);
    process.env.VIBE_HOME = vibeHome;
    writeFileSync(
      join(vibeHome, "config.toml"),
      [
        'active_model = "mistral-medium-3.5"',
        "",
        "[[models]]",
        'name = "mistral-vibe-cli-latest"',
        'provider = "mistral"',
        'alias = "mistral-medium-3.5"',
      ].join("\n")
    );

    const info = getCliInfo(true);

    expect(info.mistral.models["mistral-medium-3.5"]).toContain("mistral-vibe-cli-latest");
    expect(info.mistral.defaultModel).toBe("mistral-medium-3.5");
    expect(resolveModelAlias("mistral", "mistral-vibe-cli-latest", info)).toBe(
      "mistral-medium-3.5"
    );
    expect(resolveModelAlias("mistral", "latest", info)).toBe("mistral-medium-3.5");
  });

  it("recovers a stale Vibe active_model from the discovered recovery list", () => {
    const vibeHome = join(tempDir, "vibe-home");
    mkdirSync(vibeHome);
    process.env.VIBE_HOME = vibeHome;
    writeFileSync(join(vibeHome, "config.toml"), 'active_model = "devstral-medium"\n');

    const info = getCliInfo(true);

    expect(info.mistral.defaultModel).toBe("mistral-medium-3.5");
    expect(info.mistral.warnings?.join("\n")).toContain("devstral-medium");
  });

  // FIX D: readVibeConfig reads `default_agent` and the registry exposes it.
  // Mutation that flips this red: removing the `default_agent` read in
  // readVibeConfig (or the `info.defaultAgent = ...` assignment in
  // applyMistralOverrides).
  it("reads Vibe default_agent from config and exposes it on the mistral registry", () => {
    const vibeHome = join(tempDir, "vibe-home");
    mkdirSync(vibeHome);
    process.env.VIBE_HOME = vibeHome;
    writeFileSync(
      join(vibeHome, "config.toml"),
      ['active_model = "mistral-medium-3.5"', 'default_agent = "plan"', ""].join("\n")
    );

    const info = getCliInfo(true);
    expect(info.mistral.defaultAgent).toBe("plan");

    // It also survives the available-model projection (getAvailableCliInfo).
    expect(getAvailableCliInfo(true).mistral.defaultAgent).toBe("plan");
  });

  it("supports env-driven Mistral aliases", () => {
    process.env.MISTRAL_MODELS = JSON.stringify({
      "vibe-team-pin": "Team-approved Vibe model",
    });
    process.env.MISTRAL_MODEL_ALIASES = "team=vibe-team-pin";
    process.env.MISTRAL_DEFAULT_MODEL = "vibe-team-pin";

    const info = getCliInfo(true);

    expect(info.mistral.models["vibe-team-pin"]).toBe("Team-approved Vibe model");
    expect(info.mistral.defaultModel).toBe("vibe-team-pin");
    expect(resolveModelAlias("mistral", "team", info)).toBe("vibe-team-pin");
    expect(resolveModelAlias("mistral", "default", info)).toBe("vibe-team-pin");
  });
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "model-registry-test-"));
}
