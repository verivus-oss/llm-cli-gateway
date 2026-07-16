import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getProviderDefinition } from "../provider-definitions.js";
import {
  discoverProviderCapabilities,
  type DiscoveryOptions,
  type ProbeResult,
  type ProbeRunner,
} from "../provider-capability-discovery.js";
import {
  computeCacheKey,
  lookupCapabilityCache,
  writeCapabilityCache,
} from "../provider-capability-cache.js";
import { discoverProviderModels } from "../provider-model-discovery.js";
import type { CliInfo } from "../model-registry.js";

/** Fake probe runner keyed by `"<exe> <argv...>"`; missing keys return empty. */
function makeRunner(config: Record<string, string | Error>): ProbeRunner {
  return async (exe, argv): Promise<ProbeResult> => {
    const key = `${exe} ${argv.join(" ")}`.trim();
    const canned = config[key];
    if (canned === undefined) return { stdout: "", stderr: "", code: 0 };
    if (canned instanceof Error) throw canned;
    return { stdout: canned, stderr: "", code: 0 };
  };
}

const options = (config: Record<string, string | Error>, exe: string): DiscoveryOptions => ({
  runner: makeRunner(config),
  gatewayVersion: "test-gw-1.0.0",
  resolveExecutablePath: () => `/abs/bin/${exe}`,
});

const CODEX_MODELS_JSON = JSON.stringify({
  models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", description: "Frontier", visibility: "list" },
    { slug: "codex-auto-review", display_name: "Auto Review", visibility: "hide" },
  ],
});

describe("provider-model-discovery", () => {
  // Acceptance 1: Codex bundled/live catalog via `codex debug models`.
  it("parses codex debug models JSON with a live/hidden and bundled distinction", async () => {
    const def = getProviderDefinition("codex");
    const set = await discoverProviderCapabilities(
      def,
      options(
        { "codex --version": "codex 0.142.5", "codex debug models": CODEX_MODELS_JSON },
        "codex"
      )
    );
    const bundled: CliInfo = {
      description: "d",
      models: { "gpt-5.4": "Bundled fallback" },
      modelMetadata: {
        "gpt-5.4": { source: "fallback", sourceDetail: "bundled", confidence: "low" },
      },
    };
    const listing = discoverProviderModels(def, set, { registryInfo: bundled });

    expect(listing.source).toBe("live-command");
    const live = listing.models.find(m => m.id === "gpt-5.5");
    expect(live?.origin).toBe("live-catalog");
    const hidden = listing.models.find(m => m.id === "codex-auto-review");
    expect(hidden?.origin).toBe("live-hidden");
    // Bundled catalog is represented distinctly from the live catalog.
    expect(listing.models.find(m => m.id === "gpt-5.4")?.origin).toBe("curated-fallback");
    expect(listing.facts.effortLevels).toContain("xhigh");
  });

  it("surfaces a codex model with a missing slug as discovered-unmapped (kind model)", async () => {
    const def = getProviderDefinition("codex");
    const bad = JSON.stringify({ models: [{ display_name: "No Slug", visibility: "list" }] });
    const set = await discoverProviderCapabilities(
      def,
      options({ "codex --version": "codex 0.142.5", "codex debug models": bad }, "codex")
    );
    const listing = discoverProviderModels(def, set);
    const unmapped = listing.discoveredUnmapped.find(u => u.kind === "model");
    expect(unmapped).toBeDefined();
    expect(unmapped?.reason).toMatch(/slug/);
    expect(unmapped?.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  // Acceptance 2: Antigravity uses `agy models` (account-aware labels).
  it("parses agy models account labels", async () => {
    const def = getProviderDefinition("gemini");
    const set = await discoverProviderCapabilities(
      def,
      options(
        {
          "agy --version": "agy 1.0.15",
          "agy models": "Gemini 3.5 Flash (Medium)\nClaude Opus 4.6 (Thinking)\n",
        },
        "agy"
      )
    );
    const listing = discoverProviderModels(def, set);
    expect(listing.parse).toBe("agy-models-text");
    expect(listing.models.map(m => m.id)).toContain("Gemini 3.5 Flash (Medium)");
    expect(listing.models[0].origin).toBe("account-label");
  });

  // Acceptance 3: Grok CLI-local listing + default + config custom models (via registry).
  it("parses grok models list with the default marker and merges config models", async () => {
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      options(
        {
          "grok --version": "grok 0.2.77",
          "grok models":
            "Default model: grok-build\n\nAvailable models:\n  * grok-build (default)\n  - grok-composer-2.5-fast\n",
        },
        "grok"
      )
    );
    const configInfo: CliInfo = {
      description: "d",
      models: { "grok-reasoning-2": "Custom from config" },
      defaultModel: "grok-build",
      modelMetadata: {
        "grok-reasoning-2": {
          source: "config",
          sourceDetail: "~/.grok/config.toml",
          confidence: "medium",
        },
      },
    };
    const listing = discoverProviderModels(def, set, { registryInfo: configInfo });
    expect(listing.defaultModel).toBe("grok-build");
    expect(listing.models.find(m => m.id === "grok-build")?.isDefault).toBe(true);
    expect(listing.models.find(m => m.id === "grok-composer-2.5-fast")?.origin).toBe(
      "live-catalog"
    );
    // Config custom model is represented with a config origin.
    expect(listing.models.find(m => m.id === "grok-reasoning-2")?.origin).toBe("config");
  });

  // FIX C follow-up: the live-derived defaultModel is a user-visible scalar and
  // must be scrubbed too. parseGrokModelsText reads `Default model: <token>`
  // straight from stdout, so an account id printed there must not leak onto the
  // models:// / list_models surfaces. Mutation that flips this red: drop the
  // scrubString wrapper on defaultModel in discoverProviderModels.
  it("scrubs a secret-bearing default model from the emitted listing", async () => {
    const def = getProviderDefinition("grok");
    const set = await discoverProviderCapabilities(
      def,
      options(
        {
          "grok --version": "grok 0.2.77",
          "grok models": "Default model: leaked-account@example.com\n  - grok-build\n",
        },
        "grok"
      )
    );
    const listing = discoverProviderModels(def, set);
    expect(JSON.stringify(listing)).not.toContain("leaked-account@example.com");
    expect(listing.defaultModel).not.toBe("leaked-account@example.com");
  });

  // Acceptance 4: Mistral config/env active-model facts + agent profiles.
  it("represents Mistral agent profiles and config-or-env source", async () => {
    const def = getProviderDefinition("mistral");
    const set = await discoverProviderCapabilities(
      def,
      options({ "vibe --version": "vibe 2.18.3" }, "vibe")
    );
    const listing = discoverProviderModels(def, set);
    expect(listing.source).toBe("config-or-env");
    expect(listing.facts.agentProfiles).toEqual([
      "default",
      "plan",
      "accept-edits",
      "auto-approve",
    ]);
    expect(listing.configSources.some(s => s.keys.includes("VIBE_ACTIVE_MODEL"))).toBe(true);
  });

  // Acceptance 5: Devin surfaces model controls without a hardcoded account list.
  it("represents Devin cli-owned model surface without a static account list", async () => {
    const def = getProviderDefinition("devin");
    const set = await discoverProviderCapabilities(
      def,
      options({ "devin --version": "devin 2026.8.18" }, "devin")
    );
    const listing = discoverProviderModels(def, set);
    expect(listing.fallbackPolicy).toBe("cli-owned-surface-only");
    expect(listing.configSources.some(s => s.keys.includes("DEVIN_MODEL"))).toBe(true);
    // No live catalog and no registry info => no fabricated account models.
    expect(listing.models).toEqual([]);
  });

  // Acceptance 6: Claude aliases, effort levels, and fallback chains.
  it("represents Claude aliases, effort levels, and fallback-model chains", async () => {
    const def = getProviderDefinition("claude");
    const set = await discoverProviderCapabilities(
      def,
      options({ "claude --version": "2.1.198" }, "claude")
    );
    const listing = discoverProviderModels(def, set);
    expect(listing.source).toBe("curated-catalog");
    expect(listing.facts.aliases).toEqual(expect.arrayContaining(["opus", "sonnet"]));
    expect(listing.facts.effortLevels).toEqual(expect.arrayContaining(["xhigh", "max"]));
    expect(listing.facts.supportsFallbackModelChain).toBe(true);
  });

  // FIX C: emitted model fields are scrubbed of secrets/account-ids even on the
  // non-cached path (a listing can be returned straight from an in-memory set).
  // agy prints one account label per line, so an email that leaks into the raw
  // output would otherwise become a model label verbatim.
  // Mutation that flips this red: dropping `.map(scrubModel)` (or the scrubModel
  // helper) in discoverProviderModels so the raw email is emitted.
  it("scrubs a secret/account-id that leaks into an emitted model label", async () => {
    const def = getProviderDefinition("gemini");
    const set = await discoverProviderCapabilities(
      def,
      options(
        {
          "agy --version": "agy 1.0.15",
          "agy models": "leaked-account@example.com\nGemini 3.5 Flash (Medium)\n",
        },
        "agy"
      )
    );
    const listing = discoverProviderModels(def, set);
    const serialized = JSON.stringify(listing);
    expect(serialized).not.toContain("leaked-account@example.com");
    // The redaction marker is present where the email was; the clean model stays.
    expect(listing.models.some(m => m.id.includes("[REDACTED]"))).toBe(true);
    expect(listing.models.some(m => m.id === "Gemini 3.5 Flash (Medium)")).toBe(true);
  });

  describe("cache invalidation on model-catalog checksum change", () => {
    let cacheDir: string;
    beforeEach(() => {
      cacheDir = mkdtempSync(join(tmpdir(), "pmd-cache-"));
      process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR = cacheDir;
    });
    afterEach(() => {
      delete process.env.LLM_GATEWAY_CAPABILITY_CACHE_DIR;
      rmSync(cacheDir, { recursive: true, force: true });
    });

    it("a changed model catalog invalidates the cached capability set", async () => {
      const def = getProviderDefinition("grok");
      const setA = await discoverProviderCapabilities(
        def,
        options(
          { "grok --version": "grok 0.2.77", "grok models": "* grok-build (default)\n" },
          "grok"
        )
      );
      writeCapabilityCache(setA);
      // Same catalog => hit.
      expect(lookupCapabilityCache(setA).hit).toBe(true);

      const setB = await discoverProviderCapabilities(
        def,
        options(
          {
            "grok --version": "grok 0.2.77",
            "grok models": "* grok-build (default)\n  - grok-4\n",
          },
          "grok"
        )
      );
      // Only the model catalog changed; its checksum differs, so it is a miss.
      expect(setB.checksums.modelCatalog).not.toBe(setA.checksums.modelCatalog);
      expect(computeCacheKey(setB)).not.toBe(computeCacheKey(setA));
      expect(lookupCapabilityCache(setB).hit).toBe(false);

      // And the parsed listing reflects the new catalog.
      const listing = discoverProviderModels(def, setB);
      expect(listing.models.map(m => m.id)).toContain("grok-4");
    });
  });
});
