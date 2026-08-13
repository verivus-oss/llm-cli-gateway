// Offline unit tests for the contract rebaseliner. Pure text/classification
// over fixtures; probes nothing and writes nothing.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import {
  classifyRebaseline,
  findResidualReferences,
  flagTokenPattern,
  parseTargetVersions,
  rewriteRemovedAcknowledgedFlags,
  rewriteRemovedCodegenFlags,
  rewriteRemovedFlags,
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

// ---------------------------------------------------------------------------
// Removal rebaselining.
//
// Upstream dropping a flag is applied, not queued for review: the gateway
// passes through what the binary supports and does not manage the vendor's
// deprecation cycle. These cases exist because DELETING is where an entry's
// surrounding explanatory text can be stranded or over-deleted, and because the
// same flag spelling can appear under more than one provider.
// ---------------------------------------------------------------------------

/** Miniature stand-in with the comment habits of the real contract file. */
const CONTRACTS_SAMPLE = `import type { CliType } from "./provider-types.js";

export const UPSTREAM_CLI_CONTRACTS: Record<CliType, CliContract> = {
  grok: {
    executable: "grok",
    flags: {
      // Model selection: live, and this note explains it.
      "--model": { arity: "one", description: "Model" },
      // Sampling knob. This comment describes --best-of-n and nothing else.
      "--best-of-n": {
        arity: "one",
        description: "Sample N candidates",
      }, // dropped in 0.2.112
      "--effort": { arity: "one", values: ["low", "high"], description: "Effort" },
      "--secret": { arity: "none", hiddenFromHelp: true, description: "Real but undocumented" },
    },
    acknowledgedUpstreamFlags: ["--alias-of-model", "--vanished"],
    subcommands: {
      mcp: subcommand(["mcp"], "MCP", "read_only", ["--dropped", "--json"], {
        acknowledgedUpstreamFlags: ["--stale-sub"],
      }),
    },
  },
  claude: {
    executable: "claude",
    flags: {
      "--model": { arity: "one", description: "Model" },
      "--best-of-n": { arity: "one", description: "Same spelling, different provider" },
    },
  },
};
`;

const CODEGEN_SAMPLE = `import { z } from "zod/v3";

export const GROK_FLAG_GENERATION: readonly FlagGenerationMeta[] = [
  { flag: "--effort", requestParameter: "effort", emit: "value_if_present", inputType: "string" },
  // Sampling knob, dropped upstream.
  {
    flag: "--best-of-n",
    requestParameter: "bestOfN",
    emit: "value_if_defined",
    inputType: "number",
  },
];

export const UNGENERATED_GROK_FLAGS: readonly string[] = [
  "--model",
  "--best-of-n",
];
`;

describe("rewriteRemovedFlags", () => {
  it("deletes the flag record together with the comment that describes it", () => {
    const { source, removed } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, [
      "--best-of-n",
    ]);
    expect(removed).toEqual(["--best-of-n"]);
    // Grok's multi-line record specifically: claude declares the same spelling
    // on one line and must survive, which the disturbance case below asserts.
    expect(source).not.toContain('"--best-of-n": {\n');
    // The comment above it, and the trailing note beside it, described a flag
    // that no longer exists. Leaving either behind is how a file accumulates
    // documentation for things that are gone.
    expect(source).not.toContain("Sampling knob. This comment describes");
    expect(source).not.toContain("dropped in 0.2.112");
  });

  it("leaves the neighbouring entries and their comments byte-identical", () => {
    const { source } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--best-of-n"]);
    expect(source).toContain("      // Model selection: live, and this note explains it.\n");
    expect(source).toContain('      "--model": { arity: "one", description: "Model" },\n');
    expect(source).toContain(
      '      "--effort": { arity: "one", values: ["low", "high"], description: "Effort" },\n'
    );
  });

  it("does not leave a whitespace-only line where the entry was", () => {
    const { source } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--best-of-n"]);
    expect(source.split("\n").some(line => /^[ \t]+$/.test(line))).toBe(false);
  });

  it("removes the first entry without eating the next one's comment", () => {
    // previousEnd is null for the first property, so the "is this comment mine?"
    // rule has no predecessor to compare against and could over-reach forward.
    const { source } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--model"]);
    expect(source).not.toContain("Model selection: live");
    expect(source).toContain("// Sampling knob. This comment describes --best-of-n");
    expect(source).toContain('"--best-of-n": {');
  });

  it("does not disturb another provider declaring the same flag spelling", () => {
    // `--best-of-n` exists under both grok and claude here. A text-level rewrite
    // keyed on the flag alone would take both.
    const { source } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--best-of-n"]);
    expect(source).toContain('"--best-of-n": { arity: "one", description: "Same spelling');
  });

  it("refuses to remove a flag marked hiddenFromHelp", () => {
    // computeFlagDrift skips these, so reaching the writer means the classifier
    // and the contract disagree. Guessing which is right deletes a live flag.
    expect(() => rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--secret"])).toThrow(
      /hiddenFromHelp/
    );
  });

  it("removes a subcommand flag from its flag-name array", () => {
    const { source, removed } = rewriteRemovedFlags(
      CONTRACTS_SAMPLE,
      "grok",
      ["mcp"],
      ["--dropped"]
    );
    expect(removed).toEqual(["--dropped"]);
    expect(source).toContain('subcommand(["mcp"], "MCP", "read_only", ["--json"]');
  });

  it("reports a skip rather than throwing when the subcommand is not declared", () => {
    const { source, skipped } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", ["nosuch"], ["--x"]);
    expect(source).toBe(CONTRACTS_SAMPLE);
    expect(skipped).toMatch(/no subcommand\(\) declaration/);
  });

  it("is a no-op for a flag that is already absent", () => {
    const { source, removed } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--never"]);
    expect(source).toBe(CONTRACTS_SAMPLE);
    expect(removed).toEqual([]);
  });

  it("is idempotent: applying the same removal twice changes nothing further", () => {
    const once = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, ["--best-of-n"]).source;
    const twice = rewriteRemovedFlags(once, "grok", null, ["--best-of-n"]).source;
    expect(twice).toBe(once);
  });

  it("leaves the file parsing as valid TypeScript", () => {
    const { source } = rewriteRemovedFlags(CONTRACTS_SAMPLE, "grok", null, [
      "--best-of-n",
      "--effort",
    ]);
    const parsed = ts.createSourceFile(
      "x.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(parsed.parseDiagnostics ?? []).toHaveLength(0);
  });
});

describe("rewriteRemovedAcknowledgedFlags", () => {
  it("drops a stale acknowledgement from the root list", () => {
    const { source, removed } = rewriteRemovedAcknowledgedFlags(CONTRACTS_SAMPLE, "grok", null, [
      "--vanished",
    ]);
    expect(removed).toEqual(["--vanished"]);
    expect(source).toContain('acknowledgedUpstreamFlags: ["--alias-of-model"]');
  });

  it("drops a stale acknowledgement from a subcommand's options object", () => {
    const { source, removed } = rewriteRemovedAcknowledgedFlags(
      CONTRACTS_SAMPLE,
      "grok",
      ["mcp"],
      ["--stale-sub"]
    );
    expect(removed).toEqual(["--stale-sub"]);
    expect(source).not.toContain("--stale-sub");
    expect(source).toContain('acknowledgedUpstreamFlags: ["--alias-of-model", "--vanished"]');
  });

  it("is a no-op when the provider declares no acknowledged list", () => {
    const { source, removed } = rewriteRemovedAcknowledgedFlags(CONTRACTS_SAMPLE, "claude", null, [
      "--vanished",
    ]);
    expect(source).toBe(CONTRACTS_SAMPLE);
    expect(removed).toEqual([]);
  });
});

describe("rewriteRemovedCodegenFlags", () => {
  it("removes the generation entry and the ungenerated listing together", () => {
    // Both halves in one pass: deriveGrokArgs throws at call time on a
    // generation entry naming a flag the contract no longer declares, so a
    // contract-only removal is the half-applied state to avoid.
    const { source, removed } = rewriteRemovedCodegenFlags(CODEGEN_SAMPLE, "grok", ["--best-of-n"]);
    expect(removed).toEqual([
      "GROK_FLAG_GENERATION --best-of-n",
      "UNGENERATED_GROK_FLAGS --best-of-n",
    ]);
    expect(source).not.toContain("--best-of-n");
    expect(source).not.toContain("Sampling knob, dropped upstream");
    expect(source).toContain('{ flag: "--effort"');
    expect(source).toContain('"--model",');
  });

  it("is a no-op for a provider with no generation tables", () => {
    const { source, removed } = rewriteRemovedCodegenFlags(CODEGEN_SAMPLE, "claude", ["--model"]);
    expect(source).toBe(CODEGEN_SAMPLE);
    expect(removed).toEqual([]);
  });
});

describe("residual emission reporting", () => {
  it("matches a flag as a whole token, not as a prefix", () => {
    // Without the boundary, removing grok's --model reports every --model-name
    // in the tree and the signal is unusable.
    expect(flagTokenPattern("--model").test('args.push("--model", m)')).toBe(true);
    expect(flagTokenPattern("--model").test('args.push("--model-name", m)')).toBe(false);
    expect(flagTokenPattern("--dry-run").test('"--dry-run-only"')).toBe(false);
  });

  it("locates a surviving emission with its file and line", () => {
    const hits = findResidualReferences(
      ["--agent-config"],
      [{ file: "src/index.ts", text: 'const a = 1;\nargs.push("--agent-config", cfg);\n' }]
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ flag: "--agent-config", file: "src/index.ts", line: 2 });
  });

  it("reports nothing when the removal left no emission behind", () => {
    expect(
      findResidualReferences(["--gone"], [{ file: "src/index.ts", text: "const a = 1;\n" }])
    ).toEqual([]);
  });
});

describe("classifyRebaseline: stale acknowledgements", () => {
  const probe = discovered => [
    {
      cli: "grok",
      available: true,
      extraFlags: [],
      missingFlags: [],
      discoveredFlags: discovered,
    },
  ];

  it("classifies an acknowledged flag the binary no longer advertises", () => {
    // computeFlagDrift reports this as a warning STRING, so it never reached
    // the classifier and the stale acknowledgement lingered indefinitely.
    const plan = classifyRebaseline(probe(["--alias-of-model"]), [], {
      grok: { acknowledgedUpstreamFlags: ["--alias-of-model", "--vanished"], subcommands: {} },
    });
    expect(plan.acknowledgedRemovals).toEqual([
      { cli: "grok", commandPath: null, flags: ["--vanished"] },
    ]);
    expect(plan.removals).toEqual([]);
  });

  it("classifies a stale acknowledgement on a subcommand", () => {
    const plan = classifyRebaseline(
      [
        {
          cli: "grok",
          available: true,
          extraFlags: [],
          missingFlags: [],
          discoveredFlags: [],
          subcommands: {
            mcp: { commandPath: ["mcp"], available: true, discoveredFlags: ["--json"] },
          },
        },
      ],
      [],
      {
        grok: {
          acknowledgedUpstreamFlags: [],
          subcommands: { mcp: { acknowledgedUpstreamFlags: ["--json", "--stale-sub"] } },
        },
      }
    );
    expect(plan.acknowledgedRemovals).toEqual([
      { cli: "grok", commandPath: ["mcp"], flags: ["--stale-sub"] },
    ]);
  });

  it("stays empty when no contract view is supplied", () => {
    expect(classifyRebaseline(probe(["--x"]), []).acknowledgedRemovals).toEqual([]);
  });
});

describe("removal writers against the REAL sources, not just fixtures", () => {
  // A fixture only proves the writer handles the shape the fixture was written
  // in. Both of these caught a silent no-op that every fixture test passed:
  // the real generation table is composed from spread sub-arrays, so scanning
  // the named array alone matched nothing and reported success.
  const CONTRACTS = readFileSync(join(REPO, "src", "upstream-contracts.ts"), "utf8");
  const CODEGEN = readFileSync(join(REPO, "src", "provider-codegen.ts"), "utf8");

  it("removes a real grok flag from the real contract, leaving it parsable", () => {
    const { source, removed, skipped } = rewriteRemovedFlags(CONTRACTS, "grok", null, ["--effort"]);
    expect(skipped).toBeNull();
    expect(removed).toEqual(["--effort"]);
    const parsed = ts.createSourceFile(
      "c.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(parsed.parseDiagnostics ?? []).toHaveLength(0);
  });

  it("reaches generation entries through the spread sub-arrays that compose them", () => {
    const { source, removed } = rewriteRemovedCodegenFlags(CODEGEN, "grok", ["--effort"]);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.some(entry => entry.endsWith(" --effort"))).toBe(true);
    const parsed = ts.createSourceFile(
      "g.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    expect(parsed.parseDiagnostics ?? []).toHaveLength(0);
  });

  it("finds the ungenerated-flag listing in the real file", () => {
    const { removed } = rewriteRemovedCodegenFlags(CODEGEN, "grok", ["--model"]);
    expect(removed).toContain("UNGENERATED_GROK_FLAGS --model");
  });
});
