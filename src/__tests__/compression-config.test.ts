import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadCompressionConfig, DEFAULT_COMPRESSION_CONFIG } from "../config.js";
import { resolveEffectiveCompression } from "../index.js";
import { noopLogger } from "../logger.js";

describe("loadCompressionConfig (native compressor PR-1)", () => {
  let tempDir: string;
  let stubbedConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "compression-config-test-"));
    stubbedConfig = process.env.LLM_GATEWAY_CONFIG;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
    if (stubbedConfig === undefined) delete process.env.LLM_GATEWAY_CONFIG;
    else process.env.LLM_GATEWAY_CONFIG = stubbedConfig;
  });

  function pointToFile(toml: string): void {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, toml);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
  }

  it("defaults to off when no config file exists", () => {
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "missing.toml"));
    const cfg = loadCompressionConfig(noopLogger);
    expect(cfg.enabled).toBe(false);
    expect(cfg.sources.configFile).toBeNull();
  });

  it("defaults to off when [compression] is absent in an existing file", () => {
    pointToFile('[persistence]\nbackend = "sqlite"\n');
    expect(loadCompressionConfig(noopLogger).enabled).toBe(false);
  });

  it("reads enabled = true", () => {
    pointToFile("[compression]\nenabled = true\n");
    const cfg = loadCompressionConfig(noopLogger);
    expect(cfg.enabled).toBe(true);
    expect(cfg.sources.configFile).not.toBeNull();
  });

  it("throws on an unknown key (strict schema)", () => {
    pointToFile("[compression]\nenabled = true\nbogus = 1\n");
    expect(() => loadCompressionConfig(noopLogger)).toThrow(/Invalid \[compression\]/);
  });

  it("exposes an off default constant", () => {
    expect(DEFAULT_COMPRESSION_CONFIG.enabled).toBe(false);
  });
});

describe("resolveEffectiveCompression (spec Sections 7/5.2)", () => {
  const on = { enabled: true, sources: { configFile: null } };
  const off = { enabled: false, sources: { configFile: null } };

  it("request param wins over config", () => {
    expect(resolveEffectiveCompression(off, { compressResponse: true })).toBe(true);
    expect(resolveEffectiveCompression(on, { compressResponse: false })).toBe(false);
  });

  it("falls back to config when the request param is absent", () => {
    expect(resolveEffectiveCompression(on, {})).toBe(true);
    expect(resolveEffectiveCompression(off, {})).toBe(false);
  });

  it("always bypasses structured output", () => {
    expect(resolveEffectiveCompression(on, { outputFormat: "json" })).toBe(false);
    expect(resolveEffectiveCompression(on, { outputSchemaDeclared: true })).toBe(false);
    expect(resolveEffectiveCompression(on, { compressResponse: true, outputFormat: "json" })).toBe(
      false
    );
  });

  it("does not bypass stream-json (not structured for this guard)", () => {
    expect(resolveEffectiveCompression(on, { outputFormat: "stream-json" })).toBe(true);
  });
});
