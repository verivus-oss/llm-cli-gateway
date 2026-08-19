import { describe, expect, it } from "vitest";
import {
  resolveProviderSurface,
  resolveWithSkips,
  seedAsSurfaceInput,
  retainedAsSurfaceInput,
  SURFACE_PRECEDENCE,
  type SurfaceInput,
} from "../provider-surface.js";
import { mergeSeed, type ObservedProvider, type SeedProvenance } from "../provider-seed.js";

const PROV: SeedProvenance = {
  generator: "test",
  generatorVersion: "1.0.0",
  generatedAt: "2026-08-19T00:00:00.000Z",
  platform: "linux",
  nodeVersion: "v24.4.0",
};

function input(
  name: SurfaceInput["name"],
  flags: SurfaceInput["providers"][0]["flags"]
): SurfaceInput {
  return { name, providers: [{ cli: "grok", commandScope: [], flags }] };
}

const flagsOf = (r: ReturnType<typeof resolveProviderSurface>) =>
  r.providers[0].flags.map(f => f.flag);

describe("precedence", () => {
  it("applies sources in the declared order whatever order they arrive in", () => {
    const overlay = input("overlay", [{ flag: "--x", arity: "none" }]);
    const seed = input("seed", [{ flag: "--x", arity: "one" }]);
    const forwards = resolveProviderSurface([seed, overlay]);
    const backwards = resolveProviderSurface([overlay, seed]);
    expect(forwards.providers[0].flags[0].arity).toBe("none");
    expect(backwards).toEqual(forwards);
  });

  it("declares the order retained, seed, pack, discovery, overlay", () => {
    expect(SURFACE_PRECEDENCE).toEqual(["retained", "seed", "pack", "discovery", "overlay"]);
  });

  it("attributes facts to the source that supplied them", () => {
    const r = resolveProviderSurface([
      input("seed", [{ flag: "--x", arity: "one" }]),
      input("discovery", [{ flag: "--x", values: ["a", "b"] }]),
    ]);
    expect(r.providers[0].flags[0]).toMatchObject({
      arity: "one",
      values: ["a", "b"],
      factsFrom: "discovery",
      sources: ["seed", "discovery"],
    });
  });

  it("does NOT re-attribute when a later source only names the flag", () => {
    const r = resolveProviderSurface([
      input("seed", [{ flag: "--x", arity: "one" }]),
      input("overlay", [{ flag: "--x" }]),
    ]);
    expect(r.providers[0].flags[0].factsFrom).toBe("seed");
    expect(r.providers[0].flags[0].arity).toBe("one");
  });
});

describe("the merge never subtracts", () => {
  it("keeps a flag a later source does not mention", () => {
    // A pack that failed to update must be indistinguishable from a pack with
    // nothing new. Otherwise every stale pack removes capability.
    const r = resolveProviderSurface([
      input("seed", [{ flag: "--kept" }]),
      input("pack", [{ flag: "--added" }]),
    ]);
    expect(flagsOf(r)).toEqual(["--added", "--kept"]);
  });

  it("adds a provider only a later source knows", () => {
    const r = resolveProviderSurface([
      { name: "seed", providers: [{ cli: "grok", commandScope: [], flags: [] }] },
      { name: "discovery", providers: [{ cli: "codex", commandScope: ["exec"], flags: [] }] },
    ]);
    expect(r.providers.map(p => p.cli)).toEqual(["codex", "grok"]);
  });

  it("does not let a later source erase a value set it does not know", () => {
    const r = resolveProviderSurface([
      input("seed", [{ flag: "--x", values: ["a"] }]),
      input("overlay", [{ flag: "--x", arity: "one" }]),
    ]);
    expect(r.providers[0].flags[0].values).toEqual(["a"]);
  });
});

describe("command scope", () => {
  it("takes the highest-precedence answer rather than merging", () => {
    const r = resolveProviderSurface([
      { name: "seed", providers: [{ cli: "codex", commandScope: [], flags: [] }] },
      { name: "discovery", providers: [{ cli: "codex", commandScope: ["exec"], flags: [] }] },
    ]);
    expect(r.providers[0].commandScope).toEqual(["exec"]);
  });
});

describe("seedAsSurfaceInput", () => {
  const observed = (flags: ObservedProvider["flags"]): ObservedProvider => ({
    cli: "grok",
    executable: "grok",
    version: "1.0.5",
    commandScope: [],
    flags,
    unreadSources: [],
  });

  it("drops a help-only candidate the probe found absent, which was never capability", () => {
    const seed = mergeSeed(
      null,
      [
        observed([
          { flag: "--auto", evidence: ["help"], probe: "absent" },
          { flag: "--real", evidence: ["help", "probe"], probe: "present" },
        ]),
      ],
      PROV
    );
    expect(seedAsSurfaceInput(seed).providers[0].flags.map(f => f.flag)).toEqual(["--real"]);
  });

  it("KEEPS a flag that probed absent but completions also saw", () => {
    // Absence is not subtractive. Completions cover the whole command tree, so
    // absent-on-this-command is a scope fact, not a removal.
    const seed = mergeSeed(
      null,
      [observed([{ flag: "--tree-only", evidence: ["completions", "help"], probe: "absent" }])],
      PROV
    );
    expect(seedAsSurfaceInput(seed).providers[0].flags.map(f => f.flag)).toEqual(["--tree-only"]);
  });

  it("keeps an UNPARSED flag, because we could not tell", () => {
    const seed = mergeSeed(
      null,
      [observed([{ flag: "--maybe", evidence: ["help"], probe: "unparsed" }])],
      PROV
    );
    expect(seedAsSurfaceInput(seed).providers[0].flags.map(f => f.flag)).toEqual(["--maybe"]);
  });
});

describe("resolveWithSkips", () => {
  it("degrades to the sources that loaded and reports the rest", () => {
    const r = resolveWithSkips([
      { name: "seed", load: () => input("seed", [{ flag: "--x" }]) },
      {
        name: "pack",
        load: () => {
          throw new Error("pack is not installed");
        },
      },
    ]);
    expect(flagsOf(r)).toEqual(["--x"]);
    expect(r.skipped).toEqual([{ name: "pack", reason: "pack is not installed" }]);
  });

  it("a broken source is never fatal", () => {
    expect(() =>
      resolveWithSkips([
        {
          name: "overlay",
          load: () => {
            throw new Error("bad toml");
          },
        },
      ])
    ).not.toThrow();
  });
});

describe("retained is the floor", () => {
  it("comes first in precedence, so anything better informed refines it", () => {
    expect(SURFACE_PRECEDENCE[0]).toBe("retained");
  });

  it("keeps a retained flag the seed does not have", () => {
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({ grok: { flags: { "--best-of-n": {} } } }),
      { name: "seed", providers: [{ cli: "grok", commandScope: [], flags: [] }] },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--best-of-n"]);
  });

  it("yields its facts to the seed, which can actually see a binary", () => {
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({ grok: { flags: { "--effort": {} } } }),
      {
        name: "seed",
        providers: [{ cli: "grok", commandScope: [], flags: [{ flag: "--effort", arity: "one" }] }],
      },
    ]);
    expect(r.providers[0].flags[0]).toMatchObject({
      arity: "one",
      factsFrom: "seed",
      sources: ["retained", "seed"],
    });
  });
});

describe("ACCEPTANCE: the three capabilities a release once removed", () => {
  // absence-is-never-subtractive names these by hand and asks for a test that
  // pins them. All three probe ABSENT on the reference host, so a loader that
  // trusted the seed alone would take them from customers a second time.
  it("survives a seed that reports them absent", async () => {
    const [{ UPSTREAM_CLI_CONTRACTS }, surface] = await Promise.all([
      import("../upstream-contracts.js"),
      import("../provider-surface.js"),
    ]);
    const resolved = surface.resolveProviderSurface([
      surface.retainedAsSurfaceInput(UPSTREAM_CLI_CONTRACTS),
      surface.loadBundledSeed(),
    ]);
    const has = (cli: string, flag: string) =>
      resolved.providers.find(p => p.cli === cli)?.flags.some(f => f.flag === flag) ?? false;
    expect(has("grok", "--best-of-n"), "grok --best-of-n").toBe(true);
    expect(has("grok", "--check"), "grok --check").toBe(true);
    expect(has("devin", "--agent-config"), "devin --agent-config").toBe(true);
  });

  it("loses all three if the retained floor is dropped, which is the point", async () => {
    const surface = await import("../provider-surface.js");
    const resolved = surface.resolveProviderSurface([surface.loadBundledSeed()]);
    const grok = resolved.providers.find(p => p.cli === "grok");
    expect(grok?.flags.some(f => f.flag === "--best-of-n")).toBe(false);
  });
});
