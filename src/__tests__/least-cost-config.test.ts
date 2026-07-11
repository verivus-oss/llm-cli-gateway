import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadLeastCostConfig,
  defaultLeastCostConfig,
  DEFAULT_LEAST_COST_TIERS,
  DEFAULT_LEAST_COST_MAX_COST_USD,
} from "../config.js";
import { noopLogger } from "../logger.js";

describe("loadLeastCostConfig ([least_cost], mirrors [acp] dormancy)", () => {
  let tempDir: string;
  let stubbedConfig: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "least-cost-config-test-"));
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

  it("defaults to all-off when no config file exists", () => {
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "missing.toml"));
    const cfg = loadLeastCostConfig(noopLogger);
    expect(cfg.enabled).toBe(false);
    expect(cfg.minTier).toBe("standard");
    expect(cfg.maxCostUsd).toBe(DEFAULT_LEAST_COST_MAX_COST_USD);
    expect(cfg.defaultExpectedOutputTokens).toBe(800);
    expect(cfg.budgetOutputSafetyFactor).toBe(1.5);
    expect(cfg.priorsScope).toBe("global");
    expect(cfg.allowUnpriced).toBe(false);
    expect(cfg.maxReroutes).toBe(2);
    expect(cfg.preferCatalogPrice).toBe(true);
    expect(cfg.sources.configFile).toBeNull();
  });

  it("ships default tiers for every priced CLI family, keyed provider:family", () => {
    const cfg = defaultLeastCostConfig();
    // Keyed EXACTLY as the router's checkTier looks them up (provider:family).
    expect(cfg.tiers["claude:claude-haiku"]).toBe("economy");
    expect(cfg.tiers["claude:claude-sonnet"]).toBe("standard");
    expect(cfg.tiers["claude:claude-opus"]).toBe("frontier");
    expect(cfg.tiers["codex:openai-gpt5"]).toBe("standard");
    expect(cfg.tiers["gemini:gemini-2.5-flash"]).toBe("economy");
    expect(cfg.tiers["grok:grok-build"]).toBe("economy");
    expect(cfg.tiers["mistral:mistral-medium"]).toBe("standard");
    // The exported constant and the resolved default agree.
    expect(cfg.tiers["claude:claude-opus"]).toBe(DEFAULT_LEAST_COST_TIERS["claude:claude-opus"]);
  });

  it("defaults to all-off when [least_cost] is absent in an existing file", () => {
    pointToFile('[persistence]\nbackend = "sqlite"\n');
    const cfg = loadLeastCostConfig(noopLogger);
    expect(cfg.enabled).toBe(false);
    // Even with only [persistence] present, the tier defaults are populated.
    expect(cfg.tiers["claude:claude-sonnet"]).toBe("standard");
  });

  it("reads a populated [least_cost] block", () => {
    pointToFile(
      [
        "[least_cost]",
        "enabled = true",
        'min_tier = "economy"',
        "max_cost_usd = 1.25",
        "default_expected_output_tokens = 1200",
        "budget_output_safety_factor = 2.0",
        'priors_scope = "principal"',
        "allow_unpriced = true",
        "max_reroutes = 3",
        "prefer_catalog_price = false",
        'preference_order = ["claude", "codex"]',
        "",
        "[least_cost.tiers]",
        '"grok:grok-4" = "frontier"',
        "",
        "[least_cost.candidates]",
        'allow = ["claude:claude-sonnet-4-6"]',
        'deny = ["mistral"]',
      ].join("\n")
    );
    const cfg = loadLeastCostConfig(noopLogger);
    expect(cfg.enabled).toBe(true);
    expect(cfg.minTier).toBe("economy");
    expect(cfg.maxCostUsd).toBe(1.25);
    expect(cfg.defaultExpectedOutputTokens).toBe(1200);
    expect(cfg.budgetOutputSafetyFactor).toBe(2.0);
    expect(cfg.priorsScope).toBe("principal");
    expect(cfg.allowUnpriced).toBe(true);
    expect(cfg.maxReroutes).toBe(3);
    expect(cfg.preferCatalogPrice).toBe(false);
    expect(cfg.preferenceOrder).toEqual(["claude", "codex"]);
    expect(cfg.candidates.allow).toEqual(["claude:claude-sonnet-4-6"]);
    expect(cfg.candidates.deny).toEqual(["mistral"]);
    expect(cfg.sources.configFile).not.toBeNull();
  });

  it("merges operator [least_cost.tiers] over the shipped defaults (operator wins)", () => {
    pointToFile(
      [
        "[least_cost.tiers]",
        '"grok:grok-4" = "frontier"',
        '"claude:claude-opus" = "standard"',
      ].join("\n")
    );
    const cfg = loadLeastCostConfig(noopLogger);
    // Overridden keys take the operator value.
    expect(cfg.tiers["grok:grok-4"]).toBe("frontier");
    expect(cfg.tiers["claude:claude-opus"]).toBe("standard");
    // Un-overridden shipped defaults survive.
    expect(cfg.tiers["claude:claude-sonnet"]).toBe("standard");
    expect(cfg.tiers["gemini:gemini-2.5-flash"]).toBe("economy");
  });

  it("throws on an unknown key (strict schema)", () => {
    pointToFile("[least_cost]\nenabled = true\nbogus = 1\n");
    expect(() => loadLeastCostConfig(noopLogger)).toThrow(/Invalid \[least_cost\] config/);
  });

  it("throws on an invalid tier enum value", () => {
    pointToFile('[least_cost.tiers]\n"claude:claude-opus" = "supreme"\n');
    expect(() => loadLeastCostConfig(noopLogger)).toThrow(/Invalid \[least_cost\] config/);
  });

  it("throws on a non-positive budget", () => {
    pointToFile("[least_cost]\nmax_cost_usd = -1\n");
    expect(() => loadLeastCostConfig(noopLogger)).toThrow(/Invalid \[least_cost\] config/);
  });

  it("throws on an invalid priors_scope", () => {
    pointToFile('[least_cost]\npriors_scope = "team"\n');
    expect(() => loadLeastCostConfig(noopLogger)).toThrow(/Invalid \[least_cost\] config/);
  });

  it("falls back to all-off defaults on syntactically-broken TOML", () => {
    pointToFile("[least_cost]\nenabled = true\nthis is = = broken toml ][\n");
    const cfg = loadLeastCostConfig(noopLogger);
    expect(cfg.enabled).toBe(false);
    expect(cfg.sources.configFile).toBeNull();
  });

  it("warns once on the deprecated env sentinel and never enables routing via env", () => {
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(tempDir, "missing.toml"));
    vi.stubEnv("LLM_GATEWAY_LEAST_COST", "1");
    const warn = vi.fn();
    const logger = { ...noopLogger, warn };
    const cfg = loadLeastCostConfig(logger);
    // Dormant-by-default is preserved: env cannot flip enabled on.
    expect(cfg.enabled).toBe(false);
    expect(cfg.sources.envOverrides).toContain("LLM_GATEWAY_LEAST_COST");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/LLM_GATEWAY_LEAST_COST is not supported/);
  });
});
