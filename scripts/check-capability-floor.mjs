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

/** Every declared flag, keyed by provider and by subcommand path. */
export function declaredFlags(contracts, flatten) {
  const declared = {};
  for (const [cli, contract] of Object.entries(contracts)) {
    declared[cli] = Object.keys(contract.flags).sort();
    for (const sub of flatten(contract.subcommands)) {
      declared[`${cli} ${sub.commandPath.join(" ")}`] = Object.keys(sub.flags ?? {}).sort();
    }
  }
  return declared;
}

/** Flags the floor records that the contract no longer declares. */
export function withdrawn(floor, declared) {
  const lost = [];
  for (const [key, flags] of Object.entries(floor)) {
    const present = new Set(declared[key] ?? []);
    const missing = flags.filter(flag => !present.has(flag));
    if (missing.length > 0) lost.push({ key, missing });
  }
  return lost;
}

/** Union, so the floor only ever grows. */
export function mergeFloor(floor, declared) {
  const merged = {};
  for (const key of new Set([...Object.keys(floor), ...Object.keys(declared)])) {
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
  const declared = declaredFlags(UPSTREAM_CLI_CONTRACTS, flattenCliSubcommands);
  const floor = existsSync(FLOOR) ? JSON.parse(readFileSync(FLOOR, "utf8")) : {};

  const lost = withdrawn(floor, declared);
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

  if (UPDATE) {
    if (lost.length > 0) {
      console.error("refusing to update: --update records NEW flags and never drops one.");
      for (const { key, missing } of lost) console.error(`  ${key}: ${missing.join(" ")}`);
      process.exit(1);
    }
    writeFileSync(FLOOR, `${JSON.stringify(mergeFloor(floor, declared), null, 2)}\n`);
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
