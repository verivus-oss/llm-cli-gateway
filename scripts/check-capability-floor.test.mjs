import { describe, expect, it } from "vitest";
import { declaredFlags, factsOf, mergeFloor, withdrawn } from "./check-capability-floor.mjs";

const flatten = subs => Object.values(subs ?? {});

describe("declaredFlags", () => {
  it("includes flags that exist only on the resolved surface", () => {
    // The reviewer's hole: grok --client-identifier lives only in the seed, so a
    // gate reading contract.flags could not see it being withdrawn.
    const declared = declaredFlags(
      { grok: { flags: { "--effort": {} }, subcommands: {} } },
      flatten,
      { grok: { "--effort": {}, "--client-identifier": { arity: "one" } } }
    );
    expect(declared.grok).toEqual(["--client-identifier:one", "--effort"]);
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
    expect(floor.grok.some(f => f.startsWith("--client-identifier"))).toBe(true);
  });

  it("holds the three capabilities a release once removed", async () => {
    const { readFileSync } = await import("node:fs");
    const floor = JSON.parse(readFileSync("seed/capability-floor.json", "utf8"));
    const has = (surface, flag) => surface.some(f => f === flag || f.startsWith(`${flag}:`));
    expect(has(floor.grok, "--best-of-n"), "grok --best-of-n").toBe(true);
    expect(has(floor.grok, "--check"), "grok --check").toBe(true);
    expect(has(floor.devin, "--agent-config"), "devin --agent-config").toBe(true);
  });
});

describe("CODEX r2: names alone are not capability", () => {
  it("records arity and values, so narrowing an enum is a withdrawal", () => {
    // The reviewer removed "stream-json" from claude --output-format, left the
    // name intact, and the gate stayed green while a previously valid request
    // became invalid.
    const before = declaredFlags(
      { claude: { flags: { "--output-format": { arity: "one", values: ["text", "json"] } } } },
      () => []
    );
    const after = declaredFlags(
      { claude: { flags: { "--output-format": { arity: "one", values: ["text"] } } } },
      () => []
    );
    expect(withdrawn(before, after)).toEqual([
      { key: "claude", missing: ["--output-format:one:json,text"] },
    ]);
  });

  it("treats an arity change as a withdrawal too", () => {
    const before = declaredFlags({ grok: { flags: { "--x": { arity: "one" } } } }, () => []);
    const after = declaredFlags({ grok: { flags: { "--x": { arity: "none" } } } }, () => []);
    expect(withdrawn(before, after)).toHaveLength(1);
  });

  it("factsOf is stable under value reordering, so a reorder is not a breach", () => {
    expect(factsOf("--x", { arity: "one", values: ["b", "a"] })).toBe(
      factsOf("--x", { arity: "one", values: ["a", "b"] })
    );
  });

  it("the committed floor records facts, not bare names", async () => {
    const { readFileSync } = await import("node:fs");
    const floor = JSON.parse(readFileSync("seed/capability-floor.json", "utf8"));
    expect(floor.__schema).toEqual(["flag:arity:values"]);
    expect(floor.claude.some(f => f.startsWith("--output-format:one:"))).toBe(true);
  });
});
