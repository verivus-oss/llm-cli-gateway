#!/usr/bin/env node
// Prod-only shrinkwrap generator.
//
//   node scripts/make-prod-shrinkwrap.mjs [output-path]
//
// Pure, deterministic filter from package-lock.json → npm-shrinkwrap.json.
// A shipped shrinkwrap pins consumers' transitive resolution for REGISTRY
// installs (the real distribution channel — verified honoured via
// scripts/verify-registry-install.sh). A byte-identical copy of the lockfile
// would also drag every devDependency entry into the consumer tree
// (npm/cli#4323: 316 reified packages vs the prod ~124), so we filter:
//
//   - drop every `packages` entry whose metadata has `dev === true`;
//   - keep `optional` and prod entries unchanged (prod installs include
//     optionals); entries with `devOptional === true` are NEEDED by prod
//     installs and are kept (none exist in the current lockfile);
//   - in the root "" entry, delete the `devDependencies` field so npm does
//     not attempt registry re-resolution of dev deps absent from the pruned
//     tree (the SAP/ui5 workaround for npm/cli#4323).
//
// name / version / lockfileVersion:3 / requires are preserved verbatim, and
// key insertion order is preserved (the filtered object is rebuilt in source
// order), so JSON.stringify of identical input is byte-deterministic. Output
// ends with a trailing newline, matching how npm writes lockfiles/shrinkwraps.
//
// DESIGN INVARIANT: this script reads package-lock.json and writes the output
// path only (default npm-shrinkwrap.json). It never mutates the lockfile and
// never re-resolves anything from a registry; it is a pure function of the
// committed lockfile on disk.
//
// The pure filter is exported as `prodFilter(lock)` so it can be reused by
// scripts/supply-chain/dep-drift-scan.mjs against an arbitrary (e.g. temp-tree)
// lock object WITHOUT reading this repo's hardcoded LOCKFILE_PATH. The script
// entrypoint below runs only when the file is invoked directly, not on import.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure prod-only filter of a parsed package-lock object. Returns a NEW top-level
 * lock object (input is never mutated) with:
 *   - every `packages` entry whose meta has `dev === true` dropped (`devOptional`
 *     entries are required by prod installs and are kept);
 *   - the root "" entry's `devDependencies` field removed (npm/cli#4323);
 *   - all other top-level keys (name/version/lockfileVersion/requires/...) and
 *     source key order preserved verbatim, so JSON.stringify is byte-stable.
 *
 * This is the shared heart used by both the shrinkwrap generator (below) and the
 * supply-chain guard scanner. Consumers that want just the filtered packages map
 * read `prodFilter(lock).packages`.
 *
 * @param {Record<string, unknown>} lock parsed package-lock.json object
 * @returns {Record<string, unknown>} filtered top-level lock object
 */
export function prodFilter(lock) {
  const out = {};
  for (const [key, value] of Object.entries(lock)) {
    if (key === "packages") continue;
    out[key] = value;
  }

  const packages = lock.packages ?? {};
  const filtered = {};
  for (const [pkgPath, meta] of Object.entries(packages)) {
    // Drop dev-only entries. `devOptional` entries are required by prod installs
    // and are NOT dropped (only `dev === true` is).
    if (meta.dev === true) continue;

    if (pkgPath === "") {
      // Root entry: strip devDependencies so npm does not re-resolve pruned dev
      // deps from the registry (npm/cli#4323). Rebuild in source order minus
      // that one key; everything else is copied verbatim.
      const rootOut = {};
      for (const [field, fieldValue] of Object.entries(meta)) {
        if (field === "devDependencies") continue;
        rootOut[field] = fieldValue;
      }
      filtered[pkgPath] = rootOut;
    } else {
      filtered[pkgPath] = meta;
    }
  }

  out.packages = filtered;
  return out;
}

// Script entrypoint: run only when this file is invoked directly (not imported).
const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  const REPO_ROOT = resolve(SCRIPT_DIR, "..");
  const LOCKFILE_PATH = join(REPO_ROOT, "package-lock.json");

  // argv[2] (optional) = output path. Default: npm-shrinkwrap.json in repo root.
  // release-security-audit.sh uses this to regenerate into a temp file for the
  // parity check without clobbering the shipped shrinkwrap.
  const outputArg = process.argv[2];
  const OUTPUT_PATH = outputArg
    ? resolve(process.cwd(), outputArg)
    : join(REPO_ROOT, "npm-shrinkwrap.json");

  const lock = JSON.parse(readFileSync(LOCKFILE_PATH, "utf8"));
  const out = prodFilter(lock);

  // npm writes lockfiles/shrinkwraps with 2-space indentation and a trailing
  // newline. Match that exactly so the output is byte-deterministic and the
  // audit's regenerate-and-compare parity check is exact.
  writeFileSync(OUTPUT_PATH, JSON.stringify(out, null, 2) + "\n");

  const total = Object.keys(lock.packages ?? {}).length;
  const kept = Object.keys(out.packages).length;
  console.log(
    `[make-prod-shrinkwrap] wrote ${OUTPUT_PATH}: ${kept}/${total} packages (dropped ${total - kept} dev-only, root devDependencies removed).`
  );
}
