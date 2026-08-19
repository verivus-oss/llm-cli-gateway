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

function observedGrok(flags: ObservedProvider["flags"]): ObservedProvider {
  return {
    cli: "grok",
    executable: "grok",
    version: "1.0.5",
    commandScope: [],
    flags,
    unreadSources: [],
  };
}

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
  it("REPORTS a source describing a different command, and does not merge it", () => {
    // Root codex accepts --ask-for-approval and `codex exec` does not. Unioning
    // the two offers a flag on a command that rejects it, so the conflicting
    // source is skipped and named rather than silently absorbed.
    const r = resolveProviderSurface([
      {
        name: "seed",
        providers: [{ cli: "codex", commandScope: ["exec"], flags: [{ flag: "--json" }] }],
      },
      {
        name: "discovery",
        providers: [{ cli: "codex", commandScope: [], flags: [{ flag: "--ask-for-approval" }] }],
      },
    ]);
    expect(r.providers[0].commandScope).toEqual(["exec"]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--json"]);
    expect(r.skipped[0]?.name).toBe("discovery");
    expect(r.skipped[0]?.reason).toMatch(/describes command/);
  });

  it("the floor derives its scope from the contract, so it agrees with the seed", () => {
    const input = retainedAsSurfaceInput({
      codex: { flags: { "--json": {} }, command: { requiredFirstArg: "exec" } },
      grok: { flags: { "--effort": {} } },
    });
    expect(input.providers.find(p => p.cli === "codex")?.commandScope).toEqual(["exec"]);
    expect(input.providers.find(p => p.cli === "grok")?.commandScope).toEqual([]);
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

  it("drops a candidate the probe found absent, which the binary will refuse anyway", () => {
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

  it("KEEPS a seed-only flag that was once present and now probes absent", () => {
    // The defect a reviewer found: --client-identifier lives only in the seed,
    // so no floor is under it. Dropping it on an absent verdict withdraws a
    // capability, and capability:floor:check could not see it because that gate
    // reads contract.flags.
    const seed = mergeSeed(
      null,
      [observed([{ flag: "--client-identifier", evidence: ["help", "probe"], probe: "absent" }])],
      PROV
    );
    expect(seedAsSurfaceInput(seed).providers[0].flags.map(f => f.flag)).toEqual([
      "--client-identifier",
    ]);
  });

  it("does NOT add a flag the binary rejected on this command", () => {
    // Not subtractive: the retained floor carries everything the gateway
    // already offered, so nothing a customer had is lost here. Adding it would
    // only admit argv the CLI then refuses, and would silently reverse
    // deliberate refusals such as codex --ask-for-approval on exec.
    const seed = mergeSeed(
      null,
      [observed([{ flag: "--tree-only", evidence: ["completions", "help"], probe: "absent" }])],
      PROV
    );
    expect(seedAsSurfaceInput(seed).providers[0].flags).toEqual([]);
  });

  it("the FLOOR is what protects a retained flag the binary now rejects", () => {
    const seed = mergeSeed(
      null,
      [observed([{ flag: "--best-of-n", evidence: ["help"], probe: "absent" }])],
      PROV
    );
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({ grok: { flags: { "--best-of-n": {} } } }),
      seedAsSurfaceInput(seed),
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--best-of-n"]);
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

describe("the floor carries facts, not just names", () => {
  it("keeps an enum only the contract knows", () => {
    // commander tells a probe nothing about enums, so claude's five effort
    // levels exist only in the contract. A floor of bare names would drop
    // twelve enums the moment anything read the surface instead.
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({
        claude: { flags: { "--effort": { arity: "one", values: ["low", "high"] } } },
      }),
      {
        name: "seed",
        providers: [{ cli: "claude", commandScope: [], flags: [{ flag: "--effort" }] }],
      },
    ]);
    expect(r.providers[0].flags[0]).toMatchObject({ arity: "one", values: ["low", "high"] });
  });

  it("still lets a source that CAN see the binary refine the floor", () => {
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({ grok: { flags: { "--mode": { values: ["stale"] } } } }),
      {
        name: "discovery",
        providers: [
          { cli: "grok", commandScope: [], flags: [{ flag: "--mode", values: ["real"] }] },
        ],
      },
    ]);
    expect(r.providers[0].flags[0].values).toEqual(["real"]);
    expect(r.providers[0].flags[0].factsFrom).toBe("discovery");
  });
});

describe("a declared refusal outranks evidence", () => {
  it("removes a flag the contract acknowledges but will not emit", () => {
    // vibe --auto-approve and claude --background are real flags recorded
    // precisely so the gateway does not emit them. A seed proving they exist is
    // not news and must not reverse the decision.
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({
        mistral: { flags: {}, acknowledgedUpstreamFlags: ["--auto-approve"] },
      }),
      {
        name: "seed",
        providers: [
          { cli: "mistral", commandScope: [], flags: [{ flag: "--auto-approve", arity: "none" }] },
        ],
      },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual([]);
  });

  it("is a DECLARATION, not an omission: an unmentioned flag still survives", () => {
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({
        mistral: { flags: {}, acknowledgedUpstreamFlags: ["--auto-approve"] },
      }),
      {
        name: "seed",
        providers: [{ cli: "mistral", commandScope: [], flags: [{ flag: "--other" }] }],
      },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--other"]);
  });
});

describe("d4c: schema derivation reads the resolver", () => {
  it("takes an enum from the injected surface, not the contract", async () => {
    const { deriveZodShapeFromGeneration } = await import("../provider-codegen.js");
    const { UPSTREAM_CLI_CONTRACTS } = await import("../upstream-contracts.js");
    const shape = deriveZodShapeFromGeneration(
      UPSTREAM_CLI_CONTRACTS.grok,
      [
        {
          flag: "--permission-mode",
          requestParameter: "permissionMode",
          emit: "value_if_present",
          inputType: "string",
        },
      ],
      () => ({ values: ["only-this"] })
    );
    expect(JSON.stringify(shape.permissionMode)).toContain("only-this");
  });

  it("falls back to the contract when the surface knows nothing", async () => {
    const { deriveZodShapeFromGeneration } = await import("../provider-codegen.js");
    const { UPSTREAM_CLI_CONTRACTS } = await import("../upstream-contracts.js");
    // A surface that failed to load must cost nothing: the contract is the floor
    // in the resolver and the fallback here for the same reason.
    const shape = deriveZodShapeFromGeneration(
      UPSTREAM_CLI_CONTRACTS.grok,
      [
        {
          flag: "--permission-mode",
          requestParameter: "permissionMode",
          emit: "value_if_present",
          inputType: "string",
        },
      ],
      () => undefined
    );
    expect(JSON.stringify(shape.permissionMode)).toContain("bypassPermissions");
  });

  it("the live derivation and the live contract agree, so relocating the source moved nothing", async () => {
    const { resolvedFlagFacts, UPSTREAM_CLI_CONTRACTS } = await import("../upstream-contracts.js");
    for (const [flag, meta] of Object.entries(UPSTREAM_CLI_CONTRACTS.grok.flags)) {
      const facts = resolvedFlagFacts("grok", flag);
      expect(facts?.values ?? null, flag).toEqual(meta.values ?? null);
    }
  });
});

describe("review findings: the merge cannot be talked out of the floor", () => {
  it("CODEX: a duplicate source name no longer replaces the first", () => {
    // Was: the second `retained` input replaced the first and the floor vanished.
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({ grok: { flags: { "--best-of-n": { arity: "one" } } } }),
      { name: "retained", providers: [] },
    ]);
    expect(r.providers[0]?.flags.map(f => f.flag)).toEqual(["--best-of-n"]);
  });

  it("GROK: only the floor may refuse; a pack or overlay cannot delete one", () => {
    // Was: `refused` was honoured from every source, so an overlay deleted a
    // floor flag. A refusal is the gateway's declaration; a pack is data.
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({ grok: { flags: { "--best-of-n": {} } } }),
      {
        name: "overlay",
        providers: [{ cli: "grok", commandScope: [], flags: [], refused: ["--best-of-n"] }],
      },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--best-of-n"]);
  });

  it("the floor's own refusal still applies", () => {
    const r = resolveProviderSurface([
      retainedAsSurfaceInput({
        mistral: { flags: { "--auto-approve": {} }, acknowledgedUpstreamFlags: ["--auto-approve"] },
      }),
    ]);
    expect(r.providers[0].flags).toEqual([]);
  });
});

describe("CODEX r2: the floor cannot be impersonated or displaced", () => {
  it("binds the source name, so a payload cannot claim to be the floor", () => {
    // The reviewer had an overlay return `{ name: "retained" }` and inherit the
    // floor's refusal authority, deleting --best-of-n.
    const r = resolveWithSkips([
      {
        name: "retained",
        load: () =>
          retainedAsSurfaceInput({ grok: { flags: { "--best-of-n": { arity: "one" } } } }),
      },
      {
        name: "overlay",
        load: () => ({
          name: "retained" as const,
          providers: [{ cli: "grok", commandScope: [], flags: [], refused: ["--best-of-n"] }],
        }),
      },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--best-of-n"]);
  });

  it("an EMPTY entry does not get to pin the command scope", () => {
    // The reviewer put an empty root-scope duplicate ahead of the real ["exec"]
    // floor; the floor was then skipped as the conflicting source and codex was
    // left with no flags at all.
    const r = resolveProviderSurface([
      { name: "retained", providers: [{ cli: "codex", commandScope: [], flags: [] }] },
      retainedAsSurfaceInput({
        codex: { flags: { "--json": {} }, command: { requiredFirstArg: "exec" } },
      }),
    ]);
    expect(r.providers[0].commandScope).toEqual(["exec"]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--json"]);
    expect(r.skipped).toEqual([]);
  });

  it("a NON-EMPTY conflicting scope is still reported and not merged", () => {
    const r = resolveProviderSurface([
      {
        name: "retained",
        providers: [{ cli: "codex", commandScope: ["exec"], flags: [{ flag: "--json" }] }],
      },
      {
        name: "overlay",
        providers: [{ cli: "codex", commandScope: ["login"], flags: [{ flag: "--with-api-key" }] }],
      },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--json"]);
    expect(r.skipped[0]?.name).toBe("overlay");
  });

  it("sameScope compares element by element, not just length", () => {
    // The surviving mutant the reviewer named: a length-only comparison merges
    // ["agent","stdio"] with ["agent","serve"], two different commands.
    const r = resolveProviderSurface([
      {
        name: "retained",
        providers: [{ cli: "grok", commandScope: ["agent", "stdio"], flags: [{ flag: "--a" }] }],
      },
      {
        name: "overlay",
        providers: [{ cli: "grok", commandScope: ["agent", "serve"], flags: [{ flag: "--b" }] }],
      },
    ]);
    expect(r.providers[0].flags.map(f => f.flag)).toEqual(["--a"]);
    expect(r.skipped).toHaveLength(1);
  });

  it("an ever-present flag keeps its FACTS, not just its name", () => {
    // The reviewer's surviving mutant: retain the name after an absent verdict
    // but discard arity and values, so the flag is offered without its shape.
    const seed = mergeSeed(
      null,
      [
        observedGrok([
          {
            flag: "--x",
            evidence: ["help", "probe"],
            probe: "absent",
            arity: "one",
            values: ["a"],
          },
        ]),
      ],
      PROV
    );
    expect(seedAsSurfaceInput(seed).providers[0].flags[0]).toMatchObject({
      flag: "--x",
      arity: "one",
      values: ["a"],
    });
  });
});
