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
 * Versions exactly as this host reported them on 2026-08-13, captured from
 * `cli_versions` against the seven installed CLIs. These are the real strings,
 * not invented ones: the whole point of the normalizer is that the reported
 * spelling differs from the contracted spelling for several providers.
 *
 * Refreshed alongside `npm run providers:rebaseline:apply` after every provider
 * CLI was brought to latest. claude and cursor still report a spelling that
 * differs from their contracted one, which is what keeps the naive-equality
 * test below meaningful.
 */
const REAL_INSTALLED: Record<string, string> = {
  claude: "2.1.229 (Claude Code)",
  codex: "codex-cli 0.147.0",
  // agy reports a bare version with no product prefix, unlike codex and mistral.
  gemini: "1.1.13",
  // grok 1.0.4 appends a release-channel marker AFTER the build hash, which
  // 1.0.3 did not. Pinned verbatim, `[stable]` included: that trailing suffix
  // is exactly the spelling this fixture exists to exercise, and it is what
  // made `npm run providers:rebaseline:apply` write a hash-less target that
  // could never match, until normalizeProviderVersion stopped requiring the
  // build id to be last. See the comment on PROVIDER_TARGET_VERSIONS.grok.
  grok: "grok 1.0.4 (d846eb93d9) [stable]",
  mistral: "vibe 2.24.1",
  devin: "devin 3000.4.25 (7e8e528a)",
  cursor: "2026.08.11-e8db854",
};

// Refresh this alongside `npm run providers:rebaseline:apply`. It deliberately
// pins the exact strings the installed binaries report, because the normalizer
// exists precisely because those spellings differ from the contracted ones, so
// deriving it from PROVIDER_TARGET_VERSIONS would make the match tests
// tautological. The cost is that a provider upgrade makes it stale, which is
// how the agy 1.1.7 -> 1.1.8 bump surfaced here.
//
// That cost is accepted HERE and nowhere else. Every other version in this file
// is derived, because a literal that has to stay ahead of a moving contract is
// a maintenance treadmill that fails silently when somebody skips a lap.

/**
 * The contracted version with its final numeric segment incremented, and the
 * build id dropped, so it is always exactly one release ahead of whatever the
 * contract says today.
 *
 * Exists because a hardcoded "ahead" version stops being ahead the moment the
 * CLI passes it. Drift is direction-agnostic, so the assertion keeps passing
 * while the case silently becomes "installed fell behind", which is the
 * opposite of what it is named for.
 */
function oneReleaseAhead(contracted: string): string {
  const segments = normalizeProviderVersion(contracted).version.split(".");
  const last = Number(segments[segments.length - 1]);
  if (!Number.isFinite(last)) {
    throw new Error(`cannot derive a later version from "${contracted}"`);
  }
  segments[segments.length - 1] = String(last + 1);
  return `grok ${segments.join(".")}`;
}

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

  it("finds a build id that is not the last thing in the banner", () => {
    // grok 1.0.4 appends a release-channel marker after the hash. An
    // end-anchored match found no build id here, and `comparableVersion` in
    // scripts/upstream-scan.mjs finds one regardless, so the two components
    // read one banner two ways: `providers:rebaseline --apply` wrote a
    // hash-less target that the drift scan then reported as permanently
    // mismatched. Both halves are asserted, because dropping the marker while
    // also dropping the hash would still pass a version-only check.
    const v = normalizeProviderVersion("grok 1.0.4 (d846eb93d9) [stable]");
    expect(v.version).toBe("1.0.4");
    expect(v.build).toBe("d846eb93d9");
    // And it still matches the contracted spelling, which carries no marker.
    expect(versionsMatch("grok 1.0.4 (d846eb93d9) [stable]", "grok 1.0.4 (d846eb93d9)")).toBe(true);
  });

  it("prefers a hash build id over earlier numeric parenthesized metadata", () => {
    // Found by adversarial review of the fix above, not by writing it. Scanning
    // for the FIRST group matching either the hash test or the digit-leading
    // fallback keeps "2026 xAI" here and never reaches the real hash, so a
    // correct install compares "2026 xAI" against a contracted "d846eb93d9" and
    // reports drift. The end-anchored version this replaced was immune by
    // accident, because it only ever looked at the last group.
    const installed = "grok 9.9.9 (2026 xAI) (d846eb93d9)";
    const target = "grok 9.9.9 (d846eb93d9)";
    expect(normalizeProviderVersion(installed).build).toBe("d846eb93d9");
    expect(versionsMatch(installed, target)).toBe(true);
  });

  it("prefers the hash whichever side of the prose it sits on", () => {
    // The case above puts the hash LAST, which every "take the last group"
    // implementation also gets right, so on its own it does not pin the
    // preference at all: round-2 mutation testing showed last-wins and
    // last-group-only surviving against it. This is the same claim with the
    // groups reversed, and it is the ordering that separates preferring a hash
    // from merely preferring the end of the string.
    const installed = "grok 9.9.9 (d846eb93d9) (2026 xAI)";
    expect(normalizeProviderVersion(installed).build).toBe("d846eb93d9");
    expect(versionsMatch(installed, "grok 9.9.9 (d846eb93d9)")).toBe(true);
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
    // Originally the grok 0.2.112 scenario that blocked a release. BOTH halves
    // are derived now, neither is a literal.
    //
    // The installed half used to be hardcoded one release above whatever the
    // contract said, and that quietly rotted. Drift is direction-agnostic, so
    // once the CLI passed the literal the assertion kept passing while the case
    // silently inverted from "installed moved AHEAD" to "installed fell
    // BEHIND", and the scenario this exists for stopped being covered with
    // nothing to say so. A control that changes what it tests without failing
    // is worse than one that breaks. Measured: with the literal at 1.0.5 and
    // the contract at 1.0.24, the test still passes.
    //
    // Deriving it means this needs no maintenance across any number of
    // rebaselines, which is the same rule the contracts follow: track what is
    // installed, never pin a number a human has to remember to move.
    const verdicts = compareInstalledToTargets({
      ...REAL_INSTALLED,
      grok: oneReleaseAhead(PROVIDER_TARGET_VERSIONS.grok),
    });
    const summary = summarizeVersionGuard(verdicts);
    expect(summary.ok).toBe(false);
    expect(summary.drifted).toEqual(["grok"]);
    const grok = verdicts.find(v => v.cli === "grok");
    expect(grok?.state).toBe("drift");
    // Both sides of the reported drift, derived: the invented installed version
    // and the contracted one. Asserting only the contracted half would pass
    // against a detail string that never mentioned what was installed.
    expect(grok?.detail).toContain(
      normalizeProviderVersion(oneReleaseAhead(PROVIDER_TARGET_VERSIONS.grok)).version
    );
    expect(grok?.detail).toContain(normalizeProviderVersion(PROVIDER_TARGET_VERSIONS.grok).version);
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
