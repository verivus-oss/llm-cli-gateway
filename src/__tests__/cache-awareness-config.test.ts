import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadCacheAwarenessConfig,
  loadPersistenceConfig,
  DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL,
  minStableTokensForModel,
} from "../config.js";
import { noopLogger } from "../logger.js";

describe("loadCacheAwarenessConfig", () => {
  let tempDir: string;
  let stubbedConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "cache-aware-config-test-"));
    stubbedConfig = process.env.LLM_GATEWAY_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    if (stubbedConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
    else process.env.LLM_GATEWAY_CONFIG = stubbedConfig;
  });

  function pointToFile(toml: string): string {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, toml);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
    return p;
  }

  function pointToMissing(): void {
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "missing.toml"));
  }

  it("returns all-off defaults when no config file exists", () => {
    pointToMissing();
    const cfg = loadCacheAwarenessConfig(noopLogger);
    expect(cfg.emitAnthropicCacheControl).toBe(false);
    expect(cfg.warnOnTtlExpiry).toBe(false);
    expect(cfg.anthropicTtlSeconds).toBe(300);
    expect(cfg.minStableTokensForCacheControl).toEqual(DEFAULT_MIN_STABLE_TOKENS_FOR_CACHE_CONTROL);
    expect(cfg.sources.configFile).toBeNull();
  });

  it("returns defaults when [cache_awareness] block is absent in an existing config file", () => {
    pointToFile('[persistence]\nbackend = "sqlite"\n');
    const cfg = loadCacheAwarenessConfig(noopLogger);
    expect(cfg.emitAnthropicCacheControl).toBe(false);
    expect(cfg.warnOnTtlExpiry).toBe(false);
  });

  it("reads explicit cache_awareness block", () => {
    pointToFile(
      [
        "[cache_awareness]",
        "emit_anthropic_cache_control = true",
        "anthropic_ttl_seconds = 3600",
        "warn_on_ttl_expiry = true",
        "[cache_awareness.min_stable_tokens_for_cache_control]",
        "sonnet = 2048",
        "opus = 4096",
        "haiku = 4096",
        "default = 4096",
        "",
      ].join("\n")
    );
    const cfg = loadCacheAwarenessConfig(noopLogger);
    expect(cfg.emitAnthropicCacheControl).toBe(true);
    expect(cfg.anthropicTtlSeconds).toBe(3600);
    expect(cfg.warnOnTtlExpiry).toBe(true);
    expect(cfg.minStableTokensForCacheControl.sonnet).toBe(2048);
  });

  it("rejects invalid anthropic_ttl_seconds (e.g. 999)", () => {
    pointToFile(["[cache_awareness]", "anthropic_ttl_seconds = 999", ""].join("\n"));
    expect(() => loadCacheAwarenessConfig(noopLogger)).toThrow(/cache_awareness/i);
  });

  it("rejects unknown keys at the top level of [cache_awareness]", () => {
    pointToFile(["[cache_awareness]", "bogus_key = true", ""].join("\n"));
    expect(() => loadCacheAwarenessConfig(noopLogger)).toThrow(/cache_awareness/i);
  });

  it("does not affect persistence loading and vice versa", () => {
    pointToFile(
      [
        "[persistence]",
        'backend = "memory"',
        "acknowledgeEphemeral = true",
        "[cache_awareness]",
        "emit_anthropic_cache_control = true",
        "",
      ].join("\n")
    );
    const pers = loadPersistenceConfig(noopLogger);
    expect(pers.backend).toBe("memory");
    const cache = loadCacheAwarenessConfig(noopLogger);
    expect(cache.emitAnthropicCacheControl).toBe(true);
  });

  it("malformed [cache_awareness] does NOT break loadPersistenceConfig", () => {
    pointToFile(
      [
        "[persistence]",
        'backend = "memory"',
        "acknowledgeEphemeral = true",
        "[cache_awareness]",
        "anthropic_ttl_seconds = 999", // invalid
        "",
      ].join("\n")
    );
    expect(() => loadPersistenceConfig(noopLogger)).not.toThrow();
    expect(() => loadCacheAwarenessConfig(noopLogger)).toThrow();
  });
});

describe("minStableTokensForModel", () => {
  const cfg = {
    emitAnthropicCacheControl: false,
    anthropicTtlSeconds: 300 as const,
    warnOnTtlExpiry: false,
    minStableTokensForCacheControl: {
      sonnet: 1024,
      opus: 4096,
      haiku: 4096,
      default: 4096,
    },
    sources: { configFile: null },
  };

  it("returns sonnet threshold for sonnet model names", () => {
    expect(minStableTokensForModel(cfg, "claude-sonnet-4-6")).toBe(1024);
    expect(minStableTokensForModel(cfg, "claude-3-5-sonnet-20241022")).toBe(1024);
  });

  it("returns opus threshold for opus model names", () => {
    expect(minStableTokensForModel(cfg, "claude-opus-4-7")).toBe(4096);
  });

  it("returns haiku threshold for haiku model names", () => {
    expect(minStableTokensForModel(cfg, "claude-haiku-4-5")).toBe(4096);
  });

  it("falls back to default for unknown families", () => {
    expect(minStableTokensForModel(cfg, "claude-unknown-model")).toBe(4096);
    expect(minStableTokensForModel(cfg, "sonnet")).toBe(1024); // alias
  });
});
