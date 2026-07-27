import { describe, it, expect } from "vitest";
import {
  compareInstalledToTargets,
  normalizeProviderVersion,
  stripProductPrefix,
  summarizeVersionGuard,
  versionsMatch,
} from "../provider-version-guard.js";
import { PROVIDER_TARGET_VERSIONS } from "../provider-definitions.js";
import { CLI_TYPES } from "../provider-types.js";

/**
 * Versions exactly as this host reported them on 2026-07-27, captured from
 * `doctor --json` against the seven installed CLIs. These are the real strings,
 * not invented ones: the whole point of the normalizer is that the reported
 * spelling differs from the contracted spelling for several providers.
 */
const REAL_INSTALLED: Record<string, string> = {
  claude: "2.1.220 (Claude Code)",
  codex: "codex-cli 0.145.0",
  gemini: "1.1.7",
  grok: "grok 0.2.112 (9bbd559437)",
  mistral: "vibe 2.22.0",
  devin: "devin 3000.2.17 (2c489dfc)",
  cursor: "2026.07.23-e383d2b",
};

describe("normalizeProviderVersion", () => {
  it("strips a trailing product name in parentheses", () => {
    expect(normalizeProviderVersion("2.1.220 (Claude Code)").version).toBe("2.1.220");
    expect(normalizeProviderVersion("2.1.220 (Claude Code)").build).toBeUndefined();
  });

  it("keeps a parenthesised build id as a build, not a product name", () => {
    const v = normalizeProviderVersion("grok 0.2.112 (9bbd559437)");
    expect(v.version).toBe("0.2.112");
    expect(v.build).toBe("9bbd559437");
  });

  it("strips a leading product name", () => {
    expect(normalizeProviderVersion("codex-cli 0.145.0").version).toBe("0.145.0");
    expect(normalizeProviderVersion("vibe 2.22.0").version).toBe("2.22.0");
    expect(normalizeProviderVersion("agy 1.1.7").version).toBe("1.1.7");
    expect(normalizeProviderVersion("cursor-agent 2026.07.23-e383d2b").version).toBe(
      "2026.07.23-e383d2b"
    );
  });

  it("prefers the longest matching product prefix", () => {
    // "codex-cli" must win over "codex", else the result keeps a stray "-cli".
    expect(normalizeProviderVersion("codex-cli 0.145.0").version).toBe("0.145.0");
    expect(normalizeProviderVersion("claude code 2.1.220").version).toBe("2.1.220");
  });

  it("picks the longest prefix even when a shorter one is listed first", () => {
    // PRODUCT_PREFIXES currently happens to be declared longest-first for every
    // colliding pair, so the ordering guarantee is invisible to a test that
    // only calls normalizeProviderVersion. Drive stripProductPrefix directly
    // with a hostile order so the guarantee is actually exercised: with naive
    // first-match this returns "-cli 0.145.0" and "-agent 2026.07.23".
    expect(stripProductPrefix("codex-cli 0.145.0", ["codex", "codex-cli"])).toBe("0.145.0");
    expect(stripProductPrefix("cursor-agent 2026.07.23", ["cursor", "cursor-agent"])).toBe(
      "2026.07.23"
    );
    expect(stripProductPrefix("claude code 2.1.220", ["claude", "claude code"])).toBe("2.1.220");
  });

  it("leaves text alone when no product prefix applies", () => {
    expect(stripProductPrefix("1.1.7")).toBe("1.1.7");
    // A prefix must be followed by a space: "codexish 1.0" is not "codex".
    expect(stripProductPrefix("codexish 1.0", ["codex"])).toBe("codexish 1.0");
  });

  it("handles a bare version and a v-prefix", () => {
    expect(normalizeProviderVersion("1.1.7").version).toBe("1.1.7");
    expect(normalizeProviderVersion("v1.1.7").version).toBe("1.1.7");
  });

  it("returns an empty version for unparseable input rather than guessing", () => {
    expect(normalizeProviderVersion("").version).toBe("");
    expect(normalizeProviderVersion(null).version).toBe("");
    expect(normalizeProviderVersion(undefined).version).toBe("");
    expect(normalizeProviderVersion("command not found").version).toBe("");
  });

  it("retains the raw input for reporting", () => {
    expect(normalizeProviderVersion("  grok 0.2.112  ").raw).toBe("grok 0.2.112");
  });
});

describe("versionsMatch", () => {
  it("matches across differing product-name spellings", () => {
    expect(versionsMatch("1.1.7", "agy 1.1.7")).toBe(true);
    expect(versionsMatch("2026.07.23-e383d2b", "cursor-agent 2026.07.23-e383d2b")).toBe(true);
    expect(versionsMatch("2.1.220 (Claude Code)", "claude 2.1.220")).toBe(true);
  });

  it("compares build ids only when both sides carry one", () => {
    expect(versionsMatch("grok 0.2.112 (9bbd559437)", "grok 0.2.112 (9bbd559437)")).toBe(true);
    // Contract pins a build, caller only has the version: still a match, since
    // refusing here would report drift on a correct install.
    expect(versionsMatch("0.2.112", "grok 0.2.112 (9bbd559437)")).toBe(true);
    // Both carry a build and they differ: a genuine mismatch.
    expect(versionsMatch("grok 0.2.112 (aaaaaaaaaa)", "grok 0.2.112 (9bbd559437)")).toBe(false);
  });

  it("does not match different versions", () => {
    expect(versionsMatch("0.2.113", "grok 0.2.112 (9bbd559437)")).toBe(false);
    expect(versionsMatch("2.1.221", "claude 2.1.220")).toBe(false);
  });

  it("never matches when either side is unparseable", () => {
    expect(versionsMatch("", "claude 2.1.220")).toBe(false);
    expect(versionsMatch("claude 2.1.220", null)).toBe(false);
  });
});

describe("compareInstalledToTargets", () => {
  it("reports every provider as matching for this host's real installed set", () => {
    // The regression that matters: a naive string compare reports drift on
    // gemini, cursor and claude here, all of which are correct. If this test
    // ever fails, either a CLI moved or the normalizer broke; both need a look.
    const verdicts = compareInstalledToTargets(REAL_INSTALLED);
    const summary = summarizeVersionGuard(verdicts);
    expect(summary.drifted).toEqual([]);
    expect(summary.ok).toBe(true);
    expect(verdicts).toHaveLength(CLI_TYPES.length);
  });

  it("proves a naive equality check would have been wrong", () => {
    // Documents WHY the normalizer exists, so nobody simplifies it away.
    const naiveMismatches = CLI_TYPES.filter(
      cli => REAL_INSTALLED[cli] !== PROVIDER_TARGET_VERSIONS[cli]
    );
    expect(naiveMismatches.length).toBeGreaterThan(0);
    for (const cli of naiveMismatches) {
      expect(versionsMatch(REAL_INSTALLED[cli], PROVIDER_TARGET_VERSIONS[cli])).toBe(true);
    }
  });

  it("flags a provider whose installed version moved ahead of the contract", () => {
    // The grok 0.2.112 scenario that blocked a release, one version later.
    const verdicts = compareInstalledToTargets({ ...REAL_INSTALLED, grok: "grok 0.2.113" });
    const summary = summarizeVersionGuard(verdicts);
    expect(summary.ok).toBe(false);
    expect(summary.drifted).toEqual(["grok"]);
    const grok = verdicts.find(v => v.cli === "grok");
    expect(grok?.state).toBe("drift");
    expect(grok?.detail).toContain("0.2.113");
    expect(grok?.detail).toContain("0.2.112");
  });

  it("treats an absent CLI as not-installed, not as drift", () => {
    // A dev machine without all seven must not look broken.
    const verdicts = compareInstalledToTargets({ ...REAL_INSTALLED, devin: null });
    const summary = summarizeVersionGuard(verdicts);
    expect(summary.ok).toBe(true);
    expect(summary.notInstalled).toEqual(["devin"]);
    expect(summary.drifted).toEqual([]);
  });

  it("treats an unparseable version as unknown, not as a match", () => {
    const verdicts = compareInstalledToTargets({ ...REAL_INSTALLED, cursor: "command not found" });
    const summary = summarizeVersionGuard(verdicts);
    expect(summary.unknown).toEqual(["cursor"]);
    expect(summary.drifted).toEqual([]);
    expect(summary.ok).toBe(true);
  });

  it("covers every provider in CLI_TYPES with no gaps", () => {
    const verdicts = compareInstalledToTargets({});
    expect(verdicts.map(v => v.cli)).toEqual([...CLI_TYPES]);
    expect(verdicts.every(v => v.state === "not-installed")).toBe(true);
  });

  it("carries the contracted target through for reporting", () => {
    const verdicts = compareInstalledToTargets(REAL_INSTALLED);
    for (const v of verdicts) {
      expect(v.target).toBe(PROVIDER_TARGET_VERSIONS[v.cli]);
    }
  });
});
