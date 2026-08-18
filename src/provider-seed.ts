/**
 * The provider seed: discovered provider facts as a generated ARTEFACT.
 *
 * d1 of docs/plans/provider-surface-distribution.dag.toml. `UPSTREAM_CLI_CONTRACTS`
 * and `GROK_FLAG_GENERATION` are compiled constants, so changing what a customer
 * may send costs a product release. This module owns the shape that replaces
 * them, and the one rule that makes regenerating it safe.
 *
 * ADDITIVE BY CONSTRUCTION. `mergeSeed` unions the previous seed with what was
 * just observed. A flag the binary stopped advertising is KEPT, with `lastSeen`
 * frozen at the last version that showed it, which is the version boundary the
 * policy asks to be recorded. The rebaseliner deleted such flags instead, and
 * that is how three capabilities were taken from customers who had not touched
 * their CLI. `assertSeedIsAdditive` makes the rule mechanical rather than
 * remembered.
 *
 * WHAT IS NOT HERE. Positional bounds, required headless flags, mutual exclusion
 * and the argument-injection guard are gateway policy, not provider facts. They
 * are about protecting this host from a wedged or hostile child, they are not
 * discoverable from any binary, and they stay hand-authored without violating
 * no-hand-authored-provider-data.
 *
 * PRIVACY. This artefact ships in the npm tarball. Provenance records the
 * platform and the tool versions, never a hostname, a path or a user. Keys are
 * closed for exactly that reason: an added field is a leak nobody reviewed.
 */

/** Which discovery source saw a flag. Distinct sources, not a confidence score. */
export type SeedEvidence = "completions" | "help" | "probe";

/** One flag as the binaries have reported it over time. */
export interface SeededFlag {
  readonly flag: string;
  readonly evidence: readonly SeedEvidence[];
  /** Set only when a probe determined it. Absent means unknown, never "none". */
  readonly arity?: "none" | "one";
  /** Set only when the binary printed its own value set. Never invented. */
  readonly values?: readonly string[];
  /** Binary version that first recorded this flag. */
  readonly firstSeen: string;
  /** Latest binary version that still advertised it. Frozen once it stops. */
  readonly lastSeen: string;
}

/** One provider's discovered surface. */
export interface SeededProvider {
  readonly cli: string;
  readonly executable: string;
  readonly version: string;
  readonly flags: readonly SeededFlag[];
  /**
   * Sources that could not be read, by name. Load-bearing: a source that failed
   * is evidence about our plumbing, and must never be read as evidence that the
   * binary has no flags.
   */
  readonly unreadSources: readonly string[];
}

/** How this artefact was produced. Closed key set; see the privacy note above. */
export interface SeedProvenance {
  readonly generator: string;
  readonly generatorVersion: string;
  readonly generatedAt: string;
  readonly platform: string;
  readonly nodeVersion: string;
}

export interface ProviderSeed {
  readonly schemaVersion: 1;
  readonly provenance: SeedProvenance;
  readonly providers: readonly SeededProvider[];
}

/** What one generation run actually saw for one provider. */
export interface ObservedProvider {
  readonly cli: string;
  readonly executable: string;
  readonly version: string;
  readonly flags: readonly {
    readonly flag: string;
    readonly evidence: readonly SeedEvidence[];
    readonly arity?: "none" | "one";
    readonly values?: readonly string[];
  }[];
  readonly unreadSources: readonly string[];
}

const PROVENANCE_KEYS: readonly (keyof SeedProvenance)[] = [
  "generator",
  "generatorVersion",
  "generatedAt",
  "platform",
  "nodeVersion",
];

function mergeEvidence(
  a: readonly SeedEvidence[],
  b: readonly SeedEvidence[]
): readonly SeedEvidence[] {
  return [...new Set([...a, ...b])].sort();
}

function mergeFlag(
  previous: SeededFlag | undefined,
  observed: ObservedProvider["flags"][number],
  version: string
): SeededFlag {
  if (!previous) {
    return {
      flag: observed.flag,
      evidence: [...observed.evidence].sort(),
      ...(observed.arity === undefined ? {} : { arity: observed.arity }),
      ...(observed.values === undefined ? {} : { values: [...observed.values] }),
      firstSeen: version,
      lastSeen: version,
    };
  }
  return {
    flag: previous.flag,
    evidence: mergeEvidence(previous.evidence, observed.evidence),
    // A probe that could not tell must not erase a value set an earlier probe read.
    ...((observed.arity ?? previous.arity) ? { arity: observed.arity ?? previous.arity } : {}),
    ...((observed.values ?? previous.values)
      ? { values: [...(observed.values ?? previous.values!)] }
      : {}),
    firstSeen: previous.firstSeen,
    lastSeen: version,
  };
}

/**
 * Union the previous seed with one run's observations.
 *
 * A provider whose sources ALL failed to read contributes nothing and keeps its
 * previous entry untouched, because "we could not look" is not an observation.
 */
export function mergeSeed(
  previous: ProviderSeed | null,
  observed: readonly ObservedProvider[],
  provenance: SeedProvenance
): ProviderSeed {
  const byCli = new Map((previous?.providers ?? []).map(p => [p.cli, p]));
  for (const run of observed) {
    const prior = byCli.get(run.cli);
    if (run.flags.length === 0 && run.unreadSources.length > 0) continue;
    const observedByFlag = new Map(run.flags.map(f => [f.flag, f]));
    const flags: SeededFlag[] = [];
    for (const flag of observedByFlag.values()) {
      flags.push(
        mergeFlag(
          prior?.flags.find(f => f.flag === flag.flag),
          flag,
          run.version
        )
      );
    }
    for (const old of prior?.flags ?? []) {
      if (!observedByFlag.has(old.flag)) flags.push(old);
    }
    flags.sort((a, b) => a.flag.localeCompare(b.flag));
    byCli.set(run.cli, {
      cli: run.cli,
      executable: run.executable,
      version: run.version,
      flags,
      unreadSources: [...run.unreadSources].sort(),
    });
  }
  return {
    schemaVersion: 1,
    provenance,
    providers: [...byCli.values()].sort((a, b) => a.cli.localeCompare(b.cli)),
  };
}

/**
 * Throw if regenerating dropped anything. The whole safety property of d1 in one
 * function, so a future generator cannot quietly reintroduce the removal loop.
 */
export function assertSeedIsAdditive(previous: ProviderSeed | null, next: ProviderSeed): void {
  if (!previous) return;
  const lost: string[] = [];
  const byCli = new Map(next.providers.map(p => [p.cli, p]));
  for (const before of previous.providers) {
    const after = byCli.get(before.cli);
    if (!after) {
      lost.push(`${before.cli}: entire provider`);
      continue;
    }
    const has = new Set(after.flags.map(f => f.flag));
    for (const flag of before.flags)
      if (!has.has(flag.flag)) lost.push(`${before.cli} ${flag.flag}`);
  }
  if (lost.length > 0) {
    throw new Error(
      `provider seed regeneration is subtractive, which absence-is-never-subtractive forbids: ${lost.join(", ")}`
    );
  }
}

/** Structural check for a seed read off disk, including the closed provenance keys. */
export function validateSeed(value: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seed = value as ProviderSeed | null;
  if (!seed || typeof seed !== "object") return { ok: false, errors: ["seed is not an object"] };
  if (seed.schemaVersion !== 1)
    errors.push(`unsupported schemaVersion: ${String(seed.schemaVersion)}`);
  const provenance = seed.provenance as unknown as Record<string, unknown> | undefined;
  if (!provenance || typeof provenance !== "object") {
    errors.push("provenance is missing");
  } else {
    for (const key of PROVENANCE_KEYS) {
      if (typeof provenance[key] !== "string" || provenance[key] === "") {
        errors.push(`provenance.${key} is missing`);
      }
    }
    for (const key of Object.keys(provenance)) {
      if (!(PROVENANCE_KEYS as readonly string[]).includes(key)) {
        errors.push(`provenance.${key} is not a declared field; provenance keys are closed`);
      }
    }
  }
  if (!Array.isArray(seed.providers)) {
    errors.push("providers is not an array");
    return { ok: false, errors };
  }
  for (const provider of seed.providers) {
    if (!provider.cli || !provider.executable || !provider.version) {
      errors.push(`provider entry is incomplete: ${JSON.stringify(provider.cli ?? provider)}`);
    }
    for (const flag of provider.flags ?? []) {
      if (!flag.flag.startsWith("-")) errors.push(`${provider.cli}: ${flag.flag} is not a flag`);
      if (!flag.firstSeen || !flag.lastSeen)
        errors.push(`${provider.cli} ${flag.flag}: missing version bounds`);
      if (flag.values && flag.values.length === 0)
        errors.push(`${provider.cli} ${flag.flag}: empty value set`);
    }
  }
  return { ok: errors.length === 0, errors };
}
