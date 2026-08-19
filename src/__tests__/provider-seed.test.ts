import { describe, expect, it } from "vitest";
import {
  assertSeedIsAdditive,
  mergeSeed,
  validateSeed,
  type ObservedProvider,
  type ProviderSeed,
  type SeedProvenance,
} from "../provider-seed.js";

const PROV: SeedProvenance = {
  generator: "generate-provider-seed",
  generatorVersion: "1.0.0",
  generatedAt: "2026-08-19T00:00:00.000Z",
  platform: "linux",
  nodeVersion: "v24.4.0",
};

function observed(over: Partial<ObservedProvider> = {}): ObservedProvider {
  return {
    cli: "grok",
    executable: "grok",
    version: "1.0.4",
    commandScope: [],
    flags: [{ flag: "--effort", evidence: ["completions"] }],
    unreadSources: [],
    ...over,
  };
}

describe("mergeSeed", () => {
  it("records a first observation with matching version bounds", () => {
    const seed = mergeSeed(null, [observed()], PROV);
    expect(seed.providers[0].flags[0]).toMatchObject({
      flag: "--effort",
      firstSeen: "1.0.4",
      lastSeen: "1.0.4",
    });
  });

  it("KEEPS a flag the binary stopped advertising, with lastSeen frozen", () => {
    const before = mergeSeed(null, [observed()], PROV);
    const after = mergeSeed(
      before,
      [observed({ version: "1.1.0", flags: [{ flag: "--new", evidence: ["help"] }] })],
      PROV
    );
    const effort = after.providers[0].flags.find(f => f.flag === "--effort");
    expect(effort, "the dropped flag must survive").toBeDefined();
    expect(effort?.lastSeen).toBe("1.0.4");
    expect(after.providers[0].flags.find(f => f.flag === "--new")?.lastSeen).toBe("1.1.0");
  });

  it("advances lastSeen for a flag still present", () => {
    const before = mergeSeed(null, [observed()], PROV);
    const after = mergeSeed(before, [observed({ version: "1.1.0" })], PROV);
    expect(after.providers[0].flags[0]).toMatchObject({ firstSeen: "1.0.4", lastSeen: "1.1.0" });
  });

  it("unions evidence rather than replacing it", () => {
    const before = mergeSeed(null, [observed()], PROV);
    const after = mergeSeed(
      before,
      [observed({ flags: [{ flag: "--effort", evidence: ["probe"] }] })],
      PROV
    );
    expect(after.providers[0].flags[0].evidence).toEqual(["completions", "probe"]);
  });

  it("does not let a probe that could not tell erase a value set it read before", () => {
    const before = mergeSeed(
      null,
      [observed({ flags: [{ flag: "--effort", evidence: ["probe"], values: ["low", "high"] }] })],
      PROV
    );
    const after = mergeSeed(
      before,
      [observed({ flags: [{ flag: "--effort", evidence: ["probe"] }] })],
      PROV
    );
    expect(after.providers[0].flags[0].values).toEqual(["low", "high"]);
  });

  it("leaves a provider untouched when every source failed to read", () => {
    const before = mergeSeed(null, [observed()], PROV);
    const after = mergeSeed(
      before,
      [observed({ version: "9.9.9", flags: [], unreadSources: ["completions", "help", "probe"] })],
      PROV
    );
    expect(after.providers[0].version).toBe("1.0.4");
    expect(after.providers[0].flags).toHaveLength(1);
  });

  it("records a genuinely empty read as an observation only when a source WAS read", () => {
    const before = mergeSeed(null, [observed()], PROV);
    const after = mergeSeed(before, [observed({ version: "2.0.0", flags: [] })], PROV);
    expect(after.providers[0].version).toBe("2.0.0");
    expect(after.providers[0].flags.map(f => f.flag)).toEqual(["--effort"]);
  });
});

describe("assertSeedIsAdditive", () => {
  it("passes when nothing was lost", () => {
    const before = mergeSeed(null, [observed()], PROV);
    expect(() => assertSeedIsAdditive(before, mergeSeed(before, [observed()], PROV))).not.toThrow();
  });

  it("THROWS when a flag disappeared", () => {
    const before = mergeSeed(null, [observed()], PROV);
    const stripped: ProviderSeed = {
      ...before,
      providers: [{ ...before.providers[0], flags: [] }],
    };
    expect(() => assertSeedIsAdditive(before, stripped)).toThrow(/subtractive/);
  });

  it("THROWS when an entire provider disappeared", () => {
    const before = mergeSeed(null, [observed()], PROV);
    expect(() => assertSeedIsAdditive(before, { ...before, providers: [] })).toThrow(
      /entire provider/
    );
  });
});

describe("validateSeed", () => {
  const good = mergeSeed(null, [observed()], PROV);

  it("accepts a seed this module produced", () => {
    expect(validateSeed(good)).toEqual({ ok: true, errors: [] });
  });

  it("REFUSES an undeclared provenance field, which is how a hostname would ship", () => {
    const leaky = { ...good, provenance: { ...PROV, hostname: "workhorse3.internal" } };
    const result = validateSeed(leaky);
    expect(result.ok).toBe(false);
    expect(result.errors.join("; ")).toMatch(/provenance.hostname is not a declared field/);
  });

  it("refuses a missing provenance field", () => {
    const { platform: _drop, ...rest } = PROV;
    expect(validateSeed({ ...good, provenance: rest }).ok).toBe(false);
  });

  it("refuses an unsupported schema version", () => {
    expect(validateSeed({ ...good, schemaVersion: 2 }).ok).toBe(false);
  });

  it("refuses an empty value set, which would read as a rejection list of nothing", () => {
    const seed = {
      ...good,
      providers: [{ ...good.providers[0], flags: [{ ...good.providers[0].flags[0], values: [] }] }],
    };
    expect(validateSeed(seed).ok).toBe(false);
  });
});

describe("command scope", () => {
  const rootRun = observed({
    commandScope: [],
    flags: [{ flag: "--root-only", evidence: ["help"] }],
  });
  const execRun = observed({
    commandScope: ["exec"],
    flags: [{ flag: "--exec-only", evidence: ["help"] }],
  });

  it("does NOT carry a root-scope fact into a request-scope entry", () => {
    // Root codex reports --ask-for-approval present and --output-schema absent;
    // `codex exec` reports the exact opposite. One entry cannot hold both.
    const after = mergeSeed(mergeSeed(null, [rootRun], PROV), [execRun], PROV);
    expect(after.providers[0].commandScope).toEqual(["exec"]);
    expect(after.providers[0].flags.map(f => f.flag)).toEqual(["--exec-only"]);
  });

  it("still unions within the same scope", () => {
    const before = mergeSeed(null, [execRun], PROV);
    const after = mergeSeed(
      before,
      [observed({ commandScope: ["exec"], flags: [{ flag: "--another", evidence: ["help"] }] })],
      PROV
    );
    expect(after.providers[0].flags.map(f => f.flag)).toEqual(["--another", "--exec-only"]);
  });

  it("treats a scope change as a correction, not a subtraction", () => {
    const before = mergeSeed(null, [rootRun], PROV);
    expect(() => assertSeedIsAdditive(before, mergeSeed(before, [execRun], PROV))).not.toThrow();
  });

  it("refuses a scope that holds a flag rather than a command name", () => {
    const seed = mergeSeed(null, [execRun], PROV);
    const bad = { ...seed, providers: [{ ...seed.providers[0], commandScope: ["--exec"] }] };
    expect(validateSeed(bad).ok).toBe(false);
  });
});
