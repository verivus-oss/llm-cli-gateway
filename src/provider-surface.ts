/**
 * The surface loader: one merged view of what each provider accepts.
 *
 * d4 of docs/plans/provider-surface-distribution.dag.toml. Four sources, merged
 * in a fixed precedence, so a surface change can ship without shipping a
 * runtime:
 *
 *   retained   the bundled contract, which is the FLOOR and never shrinks
   seed       the bundled artefact, generated from the reference host
 *   pack       a separately versioned data package (d5)
 *   discovery  this host's binaries, probed at startup (d6/d7)
 *   overlay    a local file, for unblocking one machine today (d8)
 *
 * PRECEDENCE IS A CONSTANT, NOT AN ARGUMENT. Callers hand over inputs in any
 * order and the order they are applied in is decided here. An argument would
 * make the merge depend on a call site, and there will be several.
 *
 * THE MERGE IS A UNION AND NEVER SUBTRACTS. A source that does not mention a
 * flag has said nothing about it, which is not the same as saying it is gone. A
 * pack that failed to update must be indistinguishable from a pack that has
 * nothing new, or every stale pack silently removes capability.
 *
 * RETAINED IS THE FLOOR, AND IT IS NOT OPTIONAL. The invariant is that the
 * merged set is `discovered UNION retained`, so a flag the gateway already
 * offers survives a host that no longer advertises it. Measured on this host:
 * grok --best-of-n, grok --check and devin --agent-config all probe ABSENT and
 * are exactly the three capabilities a release once took from customers. Drop
 * the retained source and the loader takes them again.
 *
 * SEED ONLY BY DEFAULT. Three of the four sources are host state, and the
 * published tool surface must not vary by host (d2). Callers that need a
 * reproducible surface, the site capture above all, pass the seed alone and get
 * exactly what the artefact says.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateSeed, type ProviderSeed } from "./provider-seed.js";

export type SurfaceSourceName = "retained" | "seed" | "pack" | "discovery" | "overlay";

/** Applied in this order. Later refines earlier; later never removes. */
export const SURFACE_PRECEDENCE: readonly SurfaceSourceName[] = [
  "retained",
  "seed",
  "pack",
  "discovery",
  "overlay",
];

export interface SurfaceFlagInput {
  readonly flag: string;
  readonly arity?: "none" | "one";
  readonly values?: readonly string[];
}

export interface SurfaceProviderInput {
  readonly cli: string;
  readonly commandScope: readonly string[];
  readonly flags: readonly SurfaceFlagInput[];
  /**
   * Flags this source DECLARES it will not emit, which no evidence overturns.
   *
   * The one place the merge removes anything, and it is not an absence. An
   * omission means a source said nothing; a refusal means the contract said
   * "we know this exists, and no": vibe's --auto-approve and claude's
   * --background are both real flags recorded precisely so the gateway does not
   * emit them. A seed proving they exist is not news, and must not reverse the
   * decision. Callers still reach them through providerFlags, where the remote
   * class deny-list applies.
   */
  readonly refused?: readonly string[];
}

/** The shape of a bundled contract this module needs; it imports no contract. */
export interface RetainedContract {
  readonly flags: Readonly<
    Record<string, { readonly arity?: string; readonly values?: readonly string[] }>
  >;
  /** Real upstream flags the gateway declares it does not emit. See `refused`. */
  readonly acknowledgedUpstreamFlags?: readonly string[];
}

export interface SurfaceInput {
  readonly name: SurfaceSourceName;
  readonly providers: readonly SurfaceProviderInput[];
}

export interface SurfaceFlag {
  readonly flag: string;
  readonly arity?: "none" | "one";
  readonly values?: readonly string[];
  /** Every source that named this flag, in precedence order. */
  readonly sources: readonly SurfaceSourceName[];
  /** The source whose facts are in `arity` and `values`. */
  readonly factsFrom: SurfaceSourceName;
}

export interface ProviderSurface {
  readonly cli: string;
  readonly commandScope: readonly string[];
  readonly flags: readonly SurfaceFlag[];
  readonly sources: readonly SurfaceSourceName[];
}

export interface SurfaceResolution {
  readonly providers: readonly ProviderSurface[];
  /** Sources that were offered but could not be read. Never fatal. */
  readonly skipped: readonly { readonly name: SurfaceSourceName; readonly reason: string }[];
}

function orderInputs(inputs: readonly SurfaceInput[]): SurfaceInput[] {
  const byName = new Map(inputs.map(input => [input.name, input]));
  return SURFACE_PRECEDENCE.flatMap(name => {
    const input = byName.get(name);
    return input ? [input] : [];
  });
}

function mergeFlag(
  previous: SurfaceFlag | undefined,
  incoming: SurfaceFlagInput,
  source: SurfaceSourceName
): SurfaceFlag {
  if (!previous) {
    return {
      flag: incoming.flag,
      ...(incoming.arity === undefined ? {} : { arity: incoming.arity }),
      ...(incoming.values === undefined ? {} : { values: [...incoming.values] }),
      sources: [source],
      factsFrom: source,
    };
  }
  // A source that names a flag without describing it has refined nothing, so the
  // earlier facts and their attribution both stand.
  const refines = incoming.arity !== undefined || incoming.values !== undefined;
  return {
    flag: previous.flag,
    ...((incoming.arity ?? previous.arity) ? { arity: incoming.arity ?? previous.arity } : {}),
    ...((incoming.values ?? previous.values)
      ? { values: [...(incoming.values ?? previous.values ?? [])] }
      : {}),
    sources: previous.sources.includes(source) ? previous.sources : [...previous.sources, source],
    factsFrom: refines ? source : previous.factsFrom,
  };
}

/**
 * Merge every offered source into one surface per provider.
 *
 * A provider named by a later source but not an earlier one is added, not
 * rejected: a customer's binary may simply have something the reference host
 * does not.
 */
export function resolveProviderSurface(inputs: readonly SurfaceInput[]): SurfaceResolution {
  const providers = new Map<string, { entry: ProviderSurface; flags: Map<string, SurfaceFlag> }>();
  const refused = new Map<string, Set<string>>();
  for (const input of orderInputs(inputs)) {
    for (const provider of input.providers) {
      const existing = providers.get(provider.cli);
      const flags = existing?.flags ?? new Map<string, SurfaceFlag>();
      for (const flag of provider.flags) {
        flags.set(flag.flag, mergeFlag(flags.get(flag.flag), flag, input.name));
      }
      for (const flag of provider.refused ?? []) {
        const set = refused.get(provider.cli) ?? new Set<string>();
        set.add(flag);
        refused.set(provider.cli, set);
      }
      const sources = existing?.entry.sources.includes(input.name)
        ? existing.entry.sources
        : [...(existing?.entry.sources ?? []), input.name];
      providers.set(provider.cli, {
        flags,
        entry: {
          cli: provider.cli,
          // Scope is not merged. A later source describing a different command
          // is describing a different subject, and the highest-precedence
          // answer is the one that applies.
          commandScope: [...provider.commandScope],
          flags: [],
          sources,
        },
      });
    }
  }
  return {
    providers: [...providers.values()]
      .map(({ entry, flags }) => ({
        ...entry,
        flags: [...flags.values()]
          .filter(flag => !refused.get(entry.cli)?.has(flag.flag))
          .sort((a, b) => a.flag.localeCompare(b.flag)),
      }))
      .sort((a, b) => a.cli.localeCompare(b.cli)),
    skipped: [],
  };
}

/**
 * Project the bundled contract into the lowest-precedence source.
 *
 * Contributes the flag SET and yields its facts to anything better informed,
 * which is what "retained" means: we keep offering it, and whoever can actually
 * see the binary describes it.
 */
export function retainedAsSurfaceInput(
  contracts: Readonly<Record<string, RetainedContract>>,
  scopes: Readonly<Record<string, readonly string[]>> = {}
): SurfaceInput {
  return {
    name: "retained",
    providers: Object.entries(contracts).map(([cli, contract]) => ({
      cli,
      commandScope: scopes[cli] ?? [],
      // Carry the FACTS, not just the names. The floor is the only source that
      // knows claude's five effort levels or cursor's sandbox modes, because
      // commander tells a probe nothing; contributing bare names would drop
      // twelve enums the moment anything reads the surface instead.
      flags: Object.entries(contract.flags).map(([flag, meta]) => ({
        flag,
        ...(meta.arity === "none" || meta.arity === "one" ? { arity: meta.arity } : {}),
        ...(meta.values && meta.values.length > 0 ? { values: meta.values } : {}),
      })),
      ...(contract.acknowledgedUpstreamFlags
        ? { refused: contract.acknowledgedUpstreamFlags }
        : {}),
    })),
  };
}

/** Project a generated seed into a surface input. */
export function seedAsSurfaceInput(seed: ProviderSeed): SurfaceInput {
  return {
    name: "seed",
    providers: seed.providers.map(provider => ({
      cli: provider.cli,
      commandScope: provider.commandScope,
      // The seed ADDS what the binary demonstrably has, and NEVER TAKES BACK
      // what it once demonstrated.
      //
      // An earlier version dropped every `absent` verdict, on the argument that
      // the retained floor carries anything already offered. That holds only for
      // flags the CONTRACT names. A seed-only flag such as grok
      // --client-identifier has no floor under it, so the next regeneration that
      // recorded it absent would have withdrawn it silently, which is the exact
      // harm this programme exists to prevent.
      //
      // `evidence` carries the discriminator already: the generator adds "probe"
      // only on a PRESENT verdict, so a flag that has ever been present says so
      // permanently. Absent-and-never-present is a scrape or tree artefact that
      // was never capability on this command, and dropping it keeps deliberate
      // refusals such as codex --ask-for-approval on exec intact.
      flags: provider.flags
        .filter(flag => flag.probe?.verdict !== "absent" || flag.evidence.includes("probe"))
        .map(flag => ({
          flag: flag.flag,
          ...(flag.arity === undefined ? {} : { arity: flag.arity }),
          ...(flag.values === undefined ? {} : { values: flag.values }),
        })),
    })),
  };
}

/**
 * Where the bundled seed lives in the published package.
 *
 * Resolved from this module rather than from cwd, because the gateway is
 * launched from wherever its caller happens to be.
 */
export function bundledSeedPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "seed", "provider-seed.json");
}

/**
 * Read the bundled seed. Throws so `resolveWithSkips` can record it as a skip
 * rather than each caller inventing its own fallback.
 */
export function loadBundledSeed(path: string = bundledSeedPath()): SurfaceInput {
  const seed = JSON.parse(readFileSync(path, "utf8")) as ProviderSeed;
  const validation = validateSeed(seed);
  if (!validation.ok) {
    throw new Error(`bundled seed is invalid: ${validation.errors.join("; ")}`);
  }
  return seedAsSurfaceInput(seed);
}

/**
 * Resolve from whichever sources loaded, reporting the rest rather than failing.
 *
 * A broken pack must degrade to the seed, not to a dead gateway.
 */
export function resolveWithSkips(
  offered: readonly { name: SurfaceSourceName; load: () => SurfaceInput }[]
): SurfaceResolution {
  const inputs: SurfaceInput[] = [];
  const skipped: { name: SurfaceSourceName; reason: string }[] = [];
  for (const source of offered) {
    try {
      inputs.push(source.load());
    } catch (error) {
      skipped.push({
        name: source.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { ...resolveProviderSurface(inputs), skipped };
}
