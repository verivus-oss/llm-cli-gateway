// Offline unit tests for the contract rebaseliner. Pure text/classification
// over fixtures; probes nothing and writes nothing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  classifyRebaseline,
  parseTargetVersions,
  rewriteTargetVersion,
} from "./rebaseline-provider-contracts.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A miniature stand-in with the same shape as the real declaration. */
const SAMPLE = `import type { CliType } from "./provider-types.js";

export const PROVIDER_TARGET_VERSIONS: Record<CliType, string> = {
  claude: "claude 2.1.220",
  codex: "codex-cli 0.145.0",
  gemini: "agy 1.1.7",
  grok: "grok 0.2.112 (9bbd559437)",
  mistral: "vibe 2.22.0",
  devin: "devin 3000.2.17 (2c489dfc)",
  cursor: "cursor-agent 2026.07.23-e383d2b",
};

const OTHER = { grok: "grok 0.2.112 (9bbd559437)" };
`;

describe("parseTargetVersions", () => {
  it("reads every provider entry", () => {
    const { versions } = parseTargetVersions(SAMPLE);
    expect(versions.grok).toBe("grok 0.2.112 (9bbd559437)");
    expect(Object.keys(versions)).toHaveLength(7);
  });

  it("parses the real provider-definitions.ts, not just the fixture", () => {
    // Guards against the real declaration drifting into a shape the parser
    // cannot read, which would make the rebaseliner silently do nothing.
    const source = readFileSync(join(REPO, "src", "provider-definitions.ts"), "utf8");
    const { versions } = parseTargetVersions(source);
    expect(Object.keys(versions).length).toBeGreaterThanOrEqual(7);
    expect(versions.grok).toMatch(/grok \d+\.\d+\.\d+/);
  });

  it("throws rather than guessing when the block is absent", () => {
    expect(() => parseTargetVersions("const x = 1;")).toThrow(/not found/);
  });
});

describe("rewriteTargetVersion", () => {
  it("updates only the named provider", () => {
    const next = rewriteTargetVersion(SAMPLE, "grok", "grok 0.2.113 (deadbeef99)");
    const { versions } = parseTargetVersions(next);
    expect(versions.grok).toBe("grok 0.2.113 (deadbeef99)");
    expect(versions.claude).toBe("claude 2.1.220");
    expect(versions.cursor).toBe("cursor-agent 2026.07.23-e383d2b");
  });

  it("does not touch an identical string outside the block", () => {
    // The same version literal appears in OTHER below the block; a careless
    // global replace would rewrite it too.
    const next = rewriteTargetVersion(SAMPLE, "grok", "grok 0.2.113");
    expect(next).toContain('const OTHER = { grok: "grok 0.2.112 (9bbd559437)" };');
  });

  it("throws for a provider that has no entry", () => {
    expect(() => rewriteTargetVersion(SAMPLE, "nosuch", "1.0.0")).toThrow(/No target-version/);
  });

  it("round-trips: rewriting to the same value is a no-op", () => {
    expect(rewriteTargetVersion(SAMPLE, "claude", "claude 2.1.220")).toBe(SAMPLE);
  });

  it("handles CRLF line endings", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const next = rewriteTargetVersion(crlf, "grok", "grok 0.2.113");
    expect(parseTargetVersions(next).versions.grok).toBe("grok 0.2.113");
  });

  // The version written here comes from a vendor CLI's own --version banner,
  // which is outside our control, and it lands in SOURCE. Each of the
  // following silently corrupted provider-definitions.ts before, and was found
  // by probing the function rather than reading it.
  describe("refuses input it cannot embed safely", () => {
    it("rejects a version containing a double quote", () => {
      // Previously closed the string literal early: `grok: "grok 0.2."113"`.
      expect(() => rewriteTargetVersion(SAMPLE, "grok", 'grok 0.2."113')).toThrow(/Refusing/);
    });

    it("rejects a version containing a backslash", () => {
      expect(() => rewriteTargetVersion(SAMPLE, "grok", "grok 0.2\\113")).toThrow(/Refusing/);
    });

    it("rejects a version containing a newline", () => {
      expect(() => rewriteTargetVersion(SAMPLE, "grok", 'grok 1.0\nclaude: "evil"')).toThrow(
        /Refusing/
      );
    });

    it("rejects an empty version rather than blanking the entry", () => {
      expect(() => rewriteTargetVersion(SAMPLE, "grok", "")).toThrow(/empty version/);
    });

    it("writes $1 and $& literally instead of expanding them", () => {
      // String.replace treats these as capture-group references, so a string
      // replacement wrote something other than the value passed in.
      const next = rewriteTargetVersion(SAMPLE, "grok", "grok $1$&x");
      expect(parseTargetVersions(next).versions.grok).toBe("grok $1$&x");
    });

    it("does not let a regex metacharacter in the key match another provider", () => {
      // `cli` used to be interpolated into the RegExp unescaped, so "gr.k"
      // matched the grok line.
      expect(() => rewriteTargetVersion(SAMPLE, "gr.k", "x")).toThrow(/No target-version/);
    });

    it("refuses a version containing the block terminator", () => {
      // Raised in review: parseTargetVersions locates the end of the block with
      // indexOf("};"), so a value carrying `};` truncates the block on the next
      // parse. It was on no denylist; the round-trip check catches it anyway.
      expect(() => rewriteTargetVersion(SAMPLE, "grok", "grok 1.0};")).toThrow(/reads back as/);
    });

    it("still allows a harmless brace, rather than over-blocking", () => {
      const next = rewriteTargetVersion(SAMPLE, "grok", "grok 1.0}");
      expect(parseTargetVersions(next).versions.grok).toBe("grok 1.0}");
    });

    it("refuses if the rewrite would disturb another provider", () => {
      // The denylist only covers failure modes somebody thought of. This
      // asserts the general property: nothing but the named provider moves.
      const next = rewriteTargetVersion(SAMPLE, "grok", "grok 9.9.9");
      const before = parseTargetVersions(SAMPLE).versions;
      const after = parseTargetVersions(next).versions;
      for (const key of Object.keys(before)) {
        if (key !== "grok") expect(after[key]).toBe(before[key]);
      }
    });
  });
});

describe("classifyRebaseline", () => {
  const clean = [{ cli: "grok", available: true, extraFlags: [], missingFlags: [] }];

  it("finds nothing to do when everything matches", () => {
    const plan = classifyRebaseline(clean, [{ cli: "grok", state: "match", installed: "0.2.112" }]);
    expect(plan.versionUpdates).toEqual([]);
    expect(plan.additive).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it("proposes a version rebaseline for drift", () => {
    const plan = classifyRebaseline(clean, [
      { cli: "grok", state: "drift", installed: "grok 0.2.113", target: "grok 0.2.112" },
    ]);
    expect(plan.versionUpdates).toEqual([
      { cli: "grok", from: "grok 0.2.112", to: "grok 0.2.113" },
    ]);
  });

  it("does not propose a rebaseline for a provider that is not installed", () => {
    const plan = classifyRebaseline(clean, [
      { cli: "devin", state: "not-installed", installed: null, target: "devin 3000.2.17" },
    ]);
    expect(plan.versionUpdates).toEqual([]);
  });

  it("separates additive drift from removals", () => {
    // The distinction that matters: a new upstream flag is an acknowledgement,
    // a disappeared one may mean the gateway is emitting something dead.
    const plan = classifyRebaseline(
      [
        {
          cli: "grok",
          available: true,
          extraFlags: ["--sandbox-new"],
          missingFlags: ["--best-of-n"],
        },
      ],
      []
    );
    // `commandPath` is null for root-level drift and carries the path for a
    // subcommand, so the acknowledgement writer knows which object to edit.
    expect(plan.additive).toEqual([{ cli: "grok", commandPath: null, flags: ["--sandbox-new"] }]);
    expect(plan.removals).toEqual([{ cli: "grok", flags: ["--best-of-n"] }]);
  });

  it("ignores short flags in additive drift, matching the probe's long-flag-only scan", () => {
    const plan = classifyRebaseline(
      [{ cli: "grok", available: true, extraFlags: ["-x", "--real"], missingFlags: [] }],
      []
    );
    expect(plan.additive).toEqual([{ cli: "grok", commandPath: null, flags: ["--real"] }]);
  });

  it("classifies subcommand-level drift with its command path", () => {
    // Subcommand drift was previously neither classified nor written, so
    // findings the tool could have cleared were left for a human. The path is
    // what lets the writer target the right `subcommand()` declaration rather
    // than the provider's root acknowledgement list.
    const plan = classifyRebaseline(
      [
        {
          cli: "codex",
          available: true,
          extraFlags: [],
          missingFlags: [],
          subcommands: {
            exec: {
              commandPath: ["exec"],
              available: true,
              extraFlags: ["--approve-for-me", "-q"],
              missingFlags: [],
            },
            gone: {
              commandPath: ["gone"],
              available: true,
              extraFlags: [],
              missingFlags: ["--vanished"],
            },
          },
        },
      ],
      []
    );
    expect(plan.additive).toEqual([
      { cli: "codex", commandPath: ["exec"], flags: ["--approve-for-me"] },
    ]);
    expect(plan.removals).toEqual([{ cli: "codex", commandPath: ["gone"], flags: ["--vanished"] }]);
  });

  it("skips subcommands the probe could not reach, rather than inventing drift", () => {
    const plan = classifyRebaseline(
      [
        {
          cli: "codex",
          available: true,
          extraFlags: [],
          missingFlags: [],
          subcommands: {
            unreachable: {
              commandPath: ["unreachable"],
              available: false,
              extraFlags: ["--phantom"],
              missingFlags: [],
            },
          },
        },
      ],
      []
    );
    expect(plan.additive).toEqual([]);
    expect(plan.removals).toEqual([]);
  });

  it("skips providers whose binary is unavailable", () => {
    const plan = classifyRebaseline(
      [{ cli: "devin", available: false, extraFlags: ["--x"], missingFlags: ["--y"] }],
      []
    );
    expect(plan.additive).toEqual([]);
    expect(plan.removals).toEqual([]);
  });
});
