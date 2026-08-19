#!/usr/bin/env node
// Generate the provider seed from the installed binaries (d1 of
// docs/plans/provider-surface-distribution.dag.toml).
//
// Sources, in the order the discovery module defines them:
//   1. shell completions, but ONLY when the binary's own root help advertises
//      the subcommand. `claude completion` reached the model during the
//      investigation that produced this pipeline, because `completion` is not a
//      claude subcommand and parsed as a prompt. Asking help first is the
//      difference between a pure emit and a billed call.
//   2. help text, stdout AND stderr, because agy is a Go binary and writes
//      usage to stderr; a stdout-only read reports a provider with no flags.
//   3. the invalid-value probe, carrying a sentinel flag no parser knows. Every
//      dialect therefore rejects something, and the verdict is WHICH flag the
//      rejection named: only the sentinel means the flag under test parsed
//      clean. No help parsing, so a binary that prints no value placeholder is
//      probed like any other.
//
// The executable and helpArgs come from the bundled contract because they are
// gateway plumbing (which binary to run), not provider capability.
//
// Usage:
//   node scripts/generate-provider-seed.mjs            # write seed/provider-seed.json
//   node scripts/generate-provider-seed.mjs --check    # validate the committed seed
//   node scripts/generate-provider-seed.mjs --dry-run  # print, write nothing
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const SEED_PATH = join(REPO, "seed", "provider-seed.json");
const TIMEOUT_MS = 20_000;
const MAX_BUFFER = 8 * 1024 * 1024;

const argv = process.argv.slice(2);
const CHECK = argv.includes("--check");
const DRY_RUN = argv.includes("--dry-run");

async function loadDist() {
  const distSeed = join(REPO, "dist", "provider-seed.js");
  const distContracts = join(REPO, "dist", "upstream-contracts.js");
  const distDiscovery = join(REPO, "dist", "provider-discovery.js");
  for (const file of [distSeed, distContracts, distDiscovery]) {
    if (!existsSync(file)) {
      console.error(`missing ${file}; run npm run build first`);
      process.exit(1);
    }
  }
  return {
    seed: await import(`file://${distSeed}`),
    contracts: await import(`file://${distContracts}`),
    discovery: await import(`file://${distDiscovery}`),
  };
}

function run(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return {
    ok: !result.error,
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** First semver-shaped token in the output, or null. Never a guess. */
function readVersion(executable) {
  const result = run(executable, ["--version"]);
  if (!result.ok) return null;
  const match = `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+(?:[-+][\w.]+)?\b/u);
  return match ? match[0] : null;
}

/**
 * The completion subcommand this binary advertises in its own root help, or null.
 *
 * Exported because this is the billing guard, not a formatting detail: returning
 * a name for a binary that has no such subcommand turns the next call into a
 * prompt. Matches only an indented entry in a subcommand list, never a mention
 * in prose or a flag named --completions.
 */
export function advertisedCompletionSubcommand(rootHelp) {
  const match = rootHelp.match(/^\s{2,}(completions?)\b/mu);
  return match ? match[1] : null;
}

function gatherProvider(discovery, cli, contract) {
  const executable = contract.executable;
  const version = readVersion(executable);
  if (version === null) return { cli, executable, skipped: "not installed or no version" };

  const unread = [];
  const byFlag = new Map();
  const record = (flag, evidence) => {
    const existing = byFlag.get(flag);
    if (existing) existing.evidence.add(evidence);
    else byFlag.set(flag, { flag, evidence: new Set([evidence]) });
  };

  const helpTexts = [];
  for (const helpArgs of contract.helpArgs) {
    const result = run(executable, helpArgs);
    if (!result.ok) continue;
    helpTexts.push(`${result.stdout}\n${result.stderr}`);
  }
  if (helpTexts.length === 0) unread.push("help");
  else
    for (const flag of discovery.scrapeCandidateFlags(helpTexts.join("\n"))) record(flag, "help");

  // The command the gateway actually launches. codex is `codex exec`; every
  // other provider is the root command. Read from the contract because which
  // command we launch is gateway plumbing, not provider capability.
  const commandPath = contract.command?.requiredFirstArg ? [contract.command.requiredFirstArg] : [];
  const requestHelp = run(executable, [...commandPath, "--help"]);
  const rootHelp = commandPath.length === 0 ? requestHelp : run(executable, ["--help"]);
  const subcommand = rootHelp.ok
    ? advertisedCompletionSubcommand(`${rootHelp.stdout}\n${rootHelp.stderr}`)
    : null;
  if (!subcommand) {
    unread.push("completions");
  } else {
    const script = run(executable, [subcommand, "bash"]);
    const commands = script.ok
      ? discovery.parseClapBashCompletion(`${script.stdout}\n${script.stderr}`, executable)
      : null;
    if (!commands) unread.push("completions");
    else for (const flag of discovery.allFlags(commands)) record(flag, "completions");
  }

  // d1c: every probe carries a sentinel flag no parser knows, so the rejection
  // always names something and the verdict is which flag it named. No anchor is
  // derived, so a binary that prints no value placeholder is probed like any
  // other.
  for (const entry of byFlag.values()) {
    if (!discovery.isProbeSafeFlag(entry.flag)) continue;
    const probeArgv = discovery.buildProbeArgv(entry.flag, commandPath);
    const result = run(executable, probeArgv);
    if (!result.ok) continue;
    const verdict = discovery.interpretProbeOutput(`${result.stderr}\n${result.stdout}`, {
      flag: entry.flag,
      sentinel: discovery.PROBE_SENTINEL,
    });
    entry.probe = verdict.kind;
    if (verdict.kind !== "present") continue;
    entry.evidence.add("probe");
    if (verdict.arity !== "unknown") entry.arity = verdict.arity;
    if (verdict.values) entry.values = verdict.values;
  }
  return {
    cli,
    executable,
    version,
    commandScope: commandPath,
    flags: [...byFlag.values()]
      .map(f => ({
        flag: f.flag,
        evidence: [...f.evidence].sort(),
        ...(f.arity === undefined ? {} : { arity: f.arity }),
        ...(f.values === undefined ? {} : { values: f.values }),
        ...(f.probe === undefined ? {} : { probe: f.probe }),
      }))
      .sort((a, b) => a.flag.localeCompare(b.flag)),
    unreadSources: unread,
  };
}

// Importing this file must not generate anything: the test suite imports it for
// the billing guard above, and a top-level await here would spawn every binary.
async function main() {
  const { seed: seedModule, contracts, discovery } = await loadDist();

  if (CHECK) {
    if (!existsSync(SEED_PATH)) {
      console.error(`missing ${SEED_PATH}`);
      process.exit(1);
    }
    const result = seedModule.validateSeed(JSON.parse(readFileSync(SEED_PATH, "utf8")));
    if (!result.ok) {
      console.error("provider seed is invalid:");
      for (const error of result.errors) console.error(`  ${error}`);
      process.exit(1);
    }
    console.log("provider seed: valid");
    process.exit(0);
  }

  const previous = existsSync(SEED_PATH) ? JSON.parse(readFileSync(SEED_PATH, "utf8")) : null;
  const observed = [];
  for (const [cli, contract] of Object.entries(contracts.UPSTREAM_CLI_CONTRACTS)) {
    const result = gatherProvider(discovery, cli, contract);
    if (result.skipped) {
      console.error(`skip ${cli}: ${result.skipped}`);
      continue;
    }
    console.error(
      `${cli} ${result.version}: ${result.flags.length} flags, unread [${result.unreadSources.join(", ")}]`
    );
    observed.push(result);
  }

  const next = seedModule.mergeSeed(previous, observed, {
    generator: "generate-provider-seed",
    generatorVersion: JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).version,
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
  });
  seedModule.assertSeedIsAdditive(previous, next);

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (DRY_RUN) {
    console.log(serialized);
  } else {
    writeFileSync(SEED_PATH, serialized);
    console.error(`wrote ${SEED_PATH}: ${next.providers.length} providers`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
