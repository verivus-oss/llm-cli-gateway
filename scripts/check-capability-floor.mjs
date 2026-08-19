#!/usr/bin/env node
// A capability the gateway has offered is never withdrawn by a build.
//
// The specific harm: 3.1.0 as drafted deleted grok --best-of-n, grok --check and
// devin --agent-config because THIS host's CLIs stopped advertising them. A
// customer on an older CLI still had all three, so a gateway upgrade took
// capability from someone who had changed nothing.
//
// The policy has said "do not" in prose since 2026-08-18, in three places, while
// scripts/rebaseline-provider-contracts.mjs kept deleting. Run today it still
// nominates exactly those three flags plus two more. Prose lost to a mechanism
// again, so this is a mechanism.
//
// Adding is free. Removing fails, and there is deliberately NO --update path for
// a removal: editing seed/capability-floor.json by hand is the escape hatch, and
// it shows up in review as what it is.
//
//   node scripts/check-capability-floor.mjs            # verify
//   node scripts/check-capability-floor.mjs --update   # record NEW flags only
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const FLOOR = join(REPO, "seed", "capability-floor.json");
const UPDATE = process.argv.includes("--update");

/**
 * Every flag the gateway currently offers, keyed by provider and subcommand.
 *
 * MEASURED ON THE RESOLVED SURFACE, not on contract.flags. A reviewer found the
 * hole: grok --client-identifier lives only in the generated seed, so a
 * regeneration that recorded it absent withdrew it while this gate stayed green,
 * because the gate was reading the one source that never mentioned it. What the
 * gateway offers is the merged view, so that is what the floor has to measure.
 *
 * `surfaceFlags` is optional so the pure function stays testable without a
 * loader, but main() always passes it.
 */
export function declaredFlags(contracts, flatten, surfaceFacts = {}) {
  const declared = {};
  for (const [cli, contract] of Object.entries(contracts)) {
    const entries = new Map();
    for (const [flag, meta] of Object.entries(contract.flags))
      entries.set(flag, factsOf(flag, meta));
    for (const [flag, meta] of Object.entries(surfaceFacts[cli] ?? {}))
      entries.set(flag, factsOf(flag, meta));
    declared[cli] = [...entries.values()].sort();
    for (const sub of flatten(contract.subcommands)) {
      declared[`${cli} ${sub.commandPath.join(" ")}`] = Object.entries(sub.flags ?? {})
        .map(([flag, meta]) => factsOf(flag, meta))
        .sort();
    }
  }
  return declared;
}

/**
 * A flag and the facts that make it usable, as one comparable string.
 *
 * NAMES ALONE ARE NOT CAPABILITY. A reviewer removed "stream-json" from claude
 * --output-format, leaving the flag name intact, and the gate stayed green while
 * a previously accepted request became invalid. An arity change is the same
 * blind spot. Encoding facts into the recorded token makes both fail here.
 */
export function factsOf(flag, meta = {}) {
  const arity = meta.arity ? `:${meta.arity}` : "";
  const values = meta.values?.length ? `:${[...meta.values].sort().join(",")}` : "";
  return `${flag}${arity}${values}`;
}

/** Flags the floor records that the contract no longer declares. */
export function withdrawn(floor, declared) {
  const lost = [];
  for (const [key, flags] of Object.entries(floor)) {
    if (key === "__schema") continue;
    const present = new Set(declared[key] ?? []);
    const missing = flags.filter(flag => !present.has(flag));
    if (missing.length > 0) lost.push({ key, missing });
  }
  return lost;
}

/** Legacy floors held bare names; compare like with like during the migration. */
export function stripFacts(floor) {
  return Object.fromEntries(
    Object.entries(floor)
      .filter(([key]) => key !== "__schema")
      .map(([key, flags]) => [key, flags.map(f => String(f).split(":")[0])])
  );
}

/** Union, so the floor only ever grows. */
export function mergeFloor(floor, declared) {
  const merged = {};
  for (const key of new Set([...Object.keys(floor), ...Object.keys(declared)])) {
    if (key === "__schema") continue;
    merged[key] = [...new Set([...(floor[key] ?? []), ...(declared[key] ?? [])])].sort();
  }
  return merged;
}

async function main() {
  const dist = join(REPO, "dist", "upstream-contracts.js");
  if (!existsSync(dist)) {
    console.error(`missing ${dist}; run npm run build first`);
    process.exit(1);
  }
  const { UPSTREAM_CLI_CONTRACTS, flattenCliSubcommands } = await import(`file://${dist}`);
  const surface = await import(`file://${join(REPO, "dist", "provider-surface.js")}`);
  const resolved = surface.resolveWithSkips([
    { name: "retained", load: () => surface.retainedAsSurfaceInput(UPSTREAM_CLI_CONTRACTS) },
    { name: "seed", load: () => surface.loadBundledSeed() },
  ]);
  for (const skipped of resolved.skipped) {
    console.error(`WARNING: surface source ${skipped.name} did not load: ${skipped.reason}`);
  }
  const surfaceFacts = Object.fromEntries(
    resolved.providers.map(provider => [
      provider.cli,
      Object.fromEntries(provider.flags.map(flag => [flag.flag, flag])),
    ])
  );
  const declared = declaredFlags(UPSTREAM_CLI_CONTRACTS, flattenCliSubcommands, surfaceFacts);
  const floor = existsSync(FLOOR) ? JSON.parse(readFileSync(FLOOR, "utf8")) : {};

  // MIGRATION, ONCE. The floor recorded bare names until 2026-08-19; it now
  // records `flag:arity:values`, because a reviewer removed an enum value while
  // leaving the name and the gate stayed green. Old entries are checked at NAME
  // level, so a genuine withdrawal still fails during the migration, and are
  // then rewritten in the richer form.
  const legacy = !Array.isArray(floor.__schema);
  const comparable = legacy
    ? Object.fromEntries(
        Object.entries(declared).map(([key, facts]) => [key, facts.map(f => f.split(":")[0])])
      )
    : declared;
  const lost = withdrawn(legacy ? stripFacts(floor) : floor, comparable);
  if (lost.length > 0 && !UPDATE) {
    console.error(
      "capability floor breached: the gateway would stop offering flags it has offered."
    );
    for (const { key, missing } of lost) console.error(`  ${key}: ${missing.join(" ")}`);
    console.error(
      "\nA flag this host stopped advertising is a VERSION BOUNDARY to record, not a\n" +
        "capability to delete: a customer on an older CLI still has it. Restore the\n" +
        "entry. If a removal is genuinely intended, edit seed/capability-floor.json by\n" +
        "hand so the deletion is visible in review."
    );
    process.exit(1);
  }

  if (legacy && lost.length === 0 && !UPDATE) {
    console.error(
      "capability floor is in the legacy name-only format; run npm run capability:floor:update"
    );
    process.exit(1);
  }

  if (UPDATE) {
    if (lost.length > 0) {
      console.error("refusing to update: --update records NEW flags and never drops one.");
      for (const { key, missing } of lost) console.error(`  ${key}: ${missing.join(" ")}`);
      process.exit(1);
    }
    const merged = legacy ? declared : mergeFloor(floor, declared);
    writeFileSync(
      FLOOR,
      `${JSON.stringify({ __schema: ["flag:arity:values"], ...merged }, null, 2)}\n`
    );
    console.log(`capability floor updated: ${Object.keys(declared).length} surfaces`);
    return;
  }

  const total = Object.values(floor).reduce((sum, flags) => sum + flags.length, 0);
  console.log(
    `capability floor: ${total} flags across ${Object.keys(floor).length} surfaces, none withdrawn`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
