#!/usr/bin/env node
// Auto-rebaseline provider contracts against the installed CLIs.
//
// Drift comes in two kinds, and they are NOT equally automatable. That split
// is a property of how the contract is wired, established by evidence rather
// than preference:
//
//   VERSION drift and ADDITIVE flag drift are safely rewritable. A version
//   target is a factual record of what was validated against; an upstream flag
//   the gateway does not emit is an acknowledgement. Neither changes behaviour.
//
//   A flag REMOVAL is not. `flags` in a contract entry is the argv EMIT
//   allowlist, and src/__tests__/provider-codegen-grok-parity.test.ts asserts
//   that every covered flag exists in the contract. So deleting a flag from
//   the contract alone leaves GROK_FLAG_GENERATION in provider-codegen.ts and
//   the hand-written emission in index.ts still referring to it, and the tree
//   goes red. Repairing it properly is the three-file coordinated edit PR #236
//   did by hand. A textual rewrite cannot do that reliably, so removals are
//   reported precisely instead of half-applied.
//
// Usage:
//   node scripts/rebaseline-provider-contracts.mjs            # report only
//   node scripts/rebaseline-provider-contracts.mjs --apply    # write changes
//   node scripts/rebaseline-provider-contracts.mjs --json     # machine readable
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const DEFINITIONS = join(REPO, "src", "provider-definitions.ts");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const AS_JSON = args.includes("--json");

/**
 * Read the PROVIDER_TARGET_VERSIONS literal from provider-definitions.ts.
 *
 * @param source File contents.
 * @returns Map of provider to declared version string, plus the block bounds.
 */
export function parseTargetVersions(source) {
  const start = source.indexOf("export const PROVIDER_TARGET_VERSIONS");
  if (start === -1) throw new Error("PROVIDER_TARGET_VERSIONS not found");
  const open = source.indexOf("{", start);
  const close = source.indexOf("};", open);
  if (open === -1 || close === -1) throw new Error("PROVIDER_TARGET_VERSIONS block malformed");
  const body = source.slice(open + 1, close);

  const versions = {};
  for (const line of body.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*"([^"]*)"\s*,?\s*$/);
    if (m) versions[m[1]] = m[2];
  }
  return { versions, open, close, body };
}

/** Escape a string for literal use inside a RegExp. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Characters that cannot appear in a version written into a double-quoted
 * TypeScript string literal without escaping.
 *
 * This value comes from a vendor CLI's own `--version` banner, which is not
 * under our control, and it is written into SOURCE. Rather than escape and
 * hope, refuse: a version containing a quote, backslash or newline is far more
 * likely to be a parse failure than a real version, and corrupting
 * provider-definitions.ts is a much worse outcome than declining to rebaseline.
 */
const UNSAFE_IN_LITERAL = /["\\\r\n]/;

/**
 * Rewrite one provider's version string in the PROVIDER_TARGET_VERSIONS block.
 *
 * Replaces only within the located block so an identical string elsewhere in
 * the file cannot be clobbered.
 *
 * Three ways this went wrong before, all found by probing it rather than
 * reading it, and all of them silently corrupted the file:
 *   - a version containing `"` closed the string literal early and produced
 *     invalid TypeScript;
 *   - a version containing `$1` or `$&` was interpreted by String.replace as a
 *     replacement pattern, so the written value was not the value passed in;
 *   - `cli` was interpolated into the RegExp unescaped, so a key containing a
 *     metacharacter could match a different provider's line.
 *
 * @param source File contents.
 * @param cli Provider key.
 * @param nextVersion Replacement version string.
 * @returns Updated file contents.
 * @throws When the entry is absent, or the version cannot be safely embedded.
 */
export function rewriteTargetVersion(source, cli, nextVersion) {
  if (typeof nextVersion !== "string" || nextVersion.length === 0) {
    throw new Error(`Refusing to write an empty version for ${cli}`);
  }
  if (UNSAFE_IN_LITERAL.test(nextVersion)) {
    throw new Error(
      `Refusing to write version for ${cli}: contains a quote, backslash or newline ` +
        `(${JSON.stringify(nextVersion)}). This would corrupt provider-definitions.ts.`
    );
  }

  const { open, close, body } = parseTargetVersions(source);
  const pattern = new RegExp(`(^\\s*${escapeRegExp(cli)}\\s*:\\s*")([^"]*)("\\s*,?\\s*$)`, "m");
  if (!pattern.test(body)) throw new Error(`No target-version entry for ${cli}`);
  // Replacement FUNCTION, not a string: a string replacement would treat `$1`
  // and `$&` inside nextVersion as capture-group references.
  const nextBody = body.replace(
    pattern,
    (_match, prefix, _old, suffix) => prefix + nextVersion + suffix
  );
  const next = source.slice(0, open + 1) + nextBody + source.slice(close);

  // Round-trip guard. The character denylist above only covers failure modes
  // somebody thought of; this covers the rest by construction. Re-parse the
  // result and require that every provider reads back as intended: the one we
  // changed holds exactly nextVersion, and no other entry moved. A value
  // containing `};`, for instance, would truncate the block on the next parse
  // and was not on any denylist, but it cannot survive this.
  let verified;
  try {
    verified = parseTargetVersions(next).versions;
  } catch (err) {
    throw new Error(
      `Refusing to write ${cli}=${JSON.stringify(nextVersion)}: result no longer parses ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      { cause: err }
    );
  }
  if (verified[cli] !== nextVersion) {
    throw new Error(
      `Refusing to write ${cli}=${JSON.stringify(nextVersion)}: it reads back as ` +
        `${JSON.stringify(verified[cli])}`
    );
  }
  const before = parseTargetVersions(source).versions;
  for (const key of Object.keys(before)) {
    if (key !== cli && before[key] !== verified[key]) {
      throw new Error(
        `Refusing to write ${cli}: the rewrite also changed ${key} ` +
          `(${JSON.stringify(before[key])} -> ${JSON.stringify(verified[key])})`
      );
    }
  }

  return next;
}

/**
 * Classify probe results into what can be auto-applied and what cannot.
 *
 * @param probes Per-provider installed probe results.
 * @param versionVerdicts Per-provider version comparison verdicts.
 * @returns Classified actions.
 */
export function classifyRebaseline(probes, versionVerdicts) {
  const versionUpdates = [];
  const additive = [];
  const removals = [];

  for (const verdict of versionVerdicts) {
    if (verdict.state === "drift" && verdict.installed) {
      versionUpdates.push({
        cli: verdict.cli,
        from: verdict.target,
        to: verdict.installed,
      });
    }
  }

  for (const probe of probes) {
    if (!probe || !probe.available) continue;
    const extra = (probe.extraFlags ?? []).filter(f => f.startsWith("--"));
    if (extra.length > 0) additive.push({ cli: probe.cli, flags: [...extra].sort() });
    const missing = probe.missingFlags ?? [];
    if (missing.length > 0) removals.push({ cli: probe.cli, flags: [...missing].sort() });
  }

  return { versionUpdates, additive, removals };
}

async function main() {
  const { buildUpstreamContractReport } = await import(join(REPO, "dist", "upstream-contracts.js"));
  const { compareInstalledToTargets } = await import(
    join(REPO, "dist", "provider-version-guard.js")
  );
  const { getCliVersions } = await import(join(REPO, "dist", "cli-updater.js"));

  const versions = await getCliVersions();
  const installed = {};
  for (const info of versions) installed[info.cli] = info.installed ? (info.version ?? null) : null;

  const verdicts = compareInstalledToTargets(installed);
  const report = buildUpstreamContractReport({ probeInstalled: true });
  const probes = Object.values(report.installedProbe ?? {}).filter(p => p && p.cli);

  const plan = classifyRebaseline(probes, verdicts);

  const applied = [];
  if (APPLY && plan.versionUpdates.length > 0) {
    let source = readFileSync(DEFINITIONS, "utf8");
    for (const update of plan.versionUpdates) {
      source = rewriteTargetVersion(source, update.cli, update.to);
      applied.push(`PROVIDER_TARGET_VERSIONS.${update.cli}: ${update.from} -> ${update.to}`);
    }
    writeFileSync(DEFINITIONS, source);
  }

  const result = {
    generatedAt: new Date().toISOString(),
    applied: APPLY,
    versionUpdates: plan.versionUpdates,
    additiveFlagDrift: plan.additive,
    removedFlagDrift: plan.removals,
    changesWritten: applied,
    manualActionRequired: plan.removals.length > 0,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (
      plan.versionUpdates.length === 0 &&
      plan.additive.length === 0 &&
      plan.removals.length === 0
    ) {
      console.log("No provider contract drift: installed CLIs match their contracts.");
    }
    for (const u of plan.versionUpdates) {
      console.log(`${APPLY ? "rebaselined" : "would rebaseline"} ${u.cli}: ${u.from} -> ${u.to}`);
    }
    for (const a of plan.additive) {
      console.log(
        `${a.cli}: installed binary advertises ${a.flags.length} flag(s) the contract does not know: ${a.flags.join(" ")}`
      );
    }
    for (const r of plan.removals) {
      console.error(
        `\n${r.cli}: contract declares flag(s) the installed binary NO LONGER advertises: ${r.flags.join(" ")}`
      );
      console.error(
        "  NOT auto-applied. `flags` is the argv emit allowlist, so a removal has to be made in"
      );
      console.error("  lock-step across three places or the tree goes red:");
      console.error("    1. src/upstream-contracts.ts   (the contract entry's `flags`)");
      console.error("    2. src/provider-codegen.ts     (the generation table)");
      console.error("    3. src/index.ts                (the hand-written argv emission)");
      console.error(
        "  Removing it from the contract alone leaves provider-codegen-grok-parity.test.ts red,"
      );
      console.error(
        "  because that test asserts every covered flag exists in the contract. More importantly a"
      );
      console.error(
        "  flag that upstream dropped while the gateway still emits it is a live breakage, which is"
      );
      console.error("  exactly the grok 0.2.112 --best-of-n case, so it wants eyes on it.");
    }
  }

  // Exit codes are the scheduled job's whole signal, so they distinguish the
  // three outcomes that need different responses:
  //   0  clean
  //   2  drift found that this tool can rebaseline on its own
  //   3  drift found that needs a human (a flag removal)
  // Treating version drift as clean, which an earlier version did, makes a
  // timer silently report success while the contract is stale.
  if (plan.removals.length > 0) process.exit(3);
  const rebaselinable = plan.versionUpdates.length > 0 || plan.additive.length > 0;
  process.exit(rebaselinable ? 2 : 0);
}

/**
 * True when this module is the process entry point.
 *
 * Canonicalizes both sides with realpathSync rather than comparing a
 * `file://` string against import.meta.url. That naive form has already
 * produced two fail-open bugs in this repo (see scripts/check-consumer-tree.mjs):
 * it misses on any URL-escaped character such as a space, and again whenever
 * the path is reached through a symlink, because node canonicalizes
 * import.meta.url while a hand-built URL does not.
 */
function isDirectInvocation(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectInvocation(import.meta.url, process.argv[1])) {
  main().catch(err => {
    console.error(`rebaseline failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
