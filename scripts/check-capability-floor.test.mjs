import { describe, expect, it } from "vitest";
import { declaredFlags, mergeFloor, withdrawn } from "./check-capability-floor.mjs";

const flatten = subs => Object.values(subs ?? {});

describe("declaredFlags", () => {
  it("includes flags that exist only on the resolved surface", () => {
    // The reviewer's hole: grok --client-identifier lives only in the seed, so a
    // gate reading contract.flags could not see it being withdrawn.
    const declared = declaredFlags(
      { grok: { flags: { "--effort": {} }, subcommands: {} } },
      flatten,
      { grok: ["--effort", "--client-identifier"] }
    );
    expect(declared.grok).toEqual(["--client-identifier", "--effort"]);
  });

  it("keys subcommand surfaces separately from the root", () => {
    const declared = declaredFlags(
      {
        codex: {
          flags: { "--json": {} },
          subcommands: { exec: { commandPath: ["exec"], flags: { "--sandbox": {} } } },
        },
      },
      flatten
    );
    expect(declared).toEqual({ codex: ["--json"], "codex exec": ["--sandbox"] });
  });
});

describe("withdrawn", () => {
  it("names a flag the contract stopped declaring", () => {
    expect(withdrawn({ grok: ["--best-of-n", "--check"] }, { grok: ["--check"] })).toEqual([
      { key: "grok", missing: ["--best-of-n"] },
    ]);
  });

  it("treats a whole surface disappearing as a withdrawal, not as nothing to check", () => {
    expect(withdrawn({ "codex exec": ["--sandbox"] }, {})).toEqual([
      { key: "codex exec", missing: ["--sandbox"] },
    ]);
  });

  it("says nothing about a flag that was only ADDED", () => {
    expect(withdrawn({ grok: ["--check"] }, { grok: ["--check", "--new"] })).toEqual([]);
  });
});

describe("mergeFloor", () => {
  it("only ever grows", () => {
    expect(mergeFloor({ grok: ["--old"] }, { grok: ["--new"] })).toEqual({
      grok: ["--new", "--old"],
    });
  });

  it("keeps a surface the contract no longer has", () => {
    expect(mergeFloor({ "codex exec": ["--sandbox"] }, {})).toEqual({
      "codex exec": ["--sandbox"],
    });
  });
});

describe("the committed floor", () => {
  it("holds a flag that exists only in the seed", async () => {
    const { readFileSync } = await import("node:fs");
    const floor = JSON.parse(readFileSync("seed/capability-floor.json", "utf8"));
    expect(floor.grok).toContain("--client-identifier");
  });

  it("holds the three capabilities a release once removed", async () => {
    const { readFileSync } = await import("node:fs");
    const floor = JSON.parse(readFileSync("seed/capability-floor.json", "utf8"));
    expect(floor.grok, "grok --best-of-n").toContain("--best-of-n");
    expect(floor.grok, "grok --check").toContain("--check");
    expect(floor.devin, "devin --agent-config").toContain("--agent-config");
  });
});
