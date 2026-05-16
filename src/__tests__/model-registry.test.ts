import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearModelRegistryCache, getCliInfo, resolveModelAlias } from "../model-registry.js";

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
    process.env.GEMINI_SETTINGS_PATH = join(tempDir, "missing-gemini-settings.json");
    process.env.GEMINI_HISTORY_ROOT = join(tempDir, "missing-gemini-history");
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

  it("does not invent a Codex default when no config or env default exists", () => {
    const info = getCliInfo(true);

    expect(info.codex.defaultModel).toBeUndefined();
    expect(resolveModelAlias("codex", "default", info)).toBeUndefined();
    expect(resolveModelAlias("codex", "latest", info)).toBeUndefined();
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
});

function mkdtemp(): string {
  return mkdtempSync(join(tmpdir(), "model-registry-test-"));
}
