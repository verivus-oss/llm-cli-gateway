import { describe, it, expect } from "vitest";
import {
  UPGRADE_PROBES,
  checkUpgradeAvailability,
  parseCliCheckVersion,
  upgradableProviders,
} from "../provider-upgrade-availability.js";
import { CLI_TYPES } from "../provider-types.js";

const INSTALLED = {
  claude: "2.1.220 (Claude Code)",
  codex: "codex-cli 0.145.0",
  gemini: "1.1.7",
  grok: "grok 0.2.112 (9bbd559437)",
  mistral: "vibe 2.22.0",
  devin: "devin 3000.2.17 (2c489dfc)",
  cursor: "2026.07.23-e383d2b",
};

describe("parseCliCheckVersion", () => {
  it("parses the real `grok update --check` output", () => {
    // Captured verbatim from grok 0.2.112 on 2026-07-27. The first parser
    // written for this missed it, because it required the word "version"
    // after "latest" and grok prints a bare "latest:" label.
    expect(parseCliCheckVersion("Grok Build - v0.2.112 (latest: 0.2.112) [stable]")).toBe(
      "0.2.112"
    );
  });

  it("parses a newer latest from the same shape", () => {
    expect(parseCliCheckVersion("Grok Build - v0.2.112 (latest: 0.2.115) [stable]")).toBe(
      "0.2.115"
    );
  });

  it("parses common alternative phrasings", () => {
    expect(parseCliCheckVersion("Latest version: 1.2.3")).toBe("1.2.3");
    expect(parseCliCheckVersion("A new version 4.5.6 is available")).toBe("4.5.6");
    expect(parseCliCheckVersion("updating 1.0.0 -> 1.1.0")).toBe("1.1.0");
  });

  it("returns null rather than guessing on unrecognised output", () => {
    expect(parseCliCheckVersion("")).toBeNull();
    expect(parseCliCheckVersion("You are up to date.")).toBeNull();
    expect(parseCliCheckVersion("error: network unreachable")).toBeNull();
  });
});

describe("UPGRADE_PROBES", () => {
  it("declares a strategy for every provider so none is silently skipped", () => {
    for (const cli of CLI_TYPES) {
      expect(UPGRADE_PROBES[cli]).toBeDefined();
      expect(UPGRADE_PROBES[cli].source).toBeTruthy();
    }
  });

  it("gives a reason for every provider that cannot be probed", () => {
    // An unexplained "unknown" is indistinguishable from a bug, so each
    // un-probeable provider must say why.
    for (const cli of CLI_TYPES) {
      const probe = UPGRADE_PROBES[cli];
      if (probe.source === "none") {
        expect(probe.reason && probe.reason.length).toBeGreaterThan(20);
      } else if (probe.source === "npm" || probe.source === "pypi") {
        expect(probe.pkg).toBeTruthy();
      }
    }
  });
});

describe("checkUpgradeAvailability", () => {
  it("performs no network or subprocess work when disabled", async () => {
    const results = await checkUpgradeAvailability({ installed: INSTALLED, enabled: false });
    expect(results).toHaveLength(CLI_TYPES.length);
    expect(results.every(r => r.state === "unknown")).toBe(true);
    expect(results.every(r => r.latest === null)).toBe(true);
  });

  it("reports a missing CLI as not-installed, not as unknown", async () => {
    const results = await checkUpgradeAvailability({
      installed: { ...INSTALLED, devin: null },
      enabled: false,
    });
    expect(results.find(r => r.cli === "devin")?.state).toBe("not-installed");
  });

  it("reports un-probeable providers as unknown with an explanation", async () => {
    // enabled:true but these three spawn and fetch nothing, so this stays offline.
    for (const cli of ["gemini", "devin", "cursor"] as const) {
      const [result] = await checkUpgradeAvailability({
        installed: INSTALLED,
        enabled: true,
        only: cli,
      });
      expect(result.state).toBe("unknown");
      expect(result.source).toBe("none");
      expect(result.detail.length).toBeGreaterThan(30);
    }
  });

  it("never reports 'current' off the back of a failed probe", async () => {
    // The one wrong answer: claiming up-to-date when the check did not work
    // would hide a needed upgrade. Disabled probing must yield unknown.
    const results = await checkUpgradeAvailability({ installed: INSTALLED, enabled: false });
    expect(results.some(r => r.state === "current")).toBe(false);
  });

  it("summarises upgradable providers", () => {
    expect(
      upgradableProviders([
        { cli: "grok", state: "upgrade-available" } as never,
        { cli: "claude", state: "current" } as never,
        { cli: "devin", state: "unknown" } as never,
      ])
    ).toEqual(["grok"]);
  });
});
