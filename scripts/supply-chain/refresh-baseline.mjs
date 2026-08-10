#!/usr/bin/env node
/**
 * Refresh `supply-chain/prod-closure.baseline.json` from the committed
 * lockfile, and touch nothing else.
 *
 * Why this exists rather than `npm run supply-chain:seed`: `--seed` rewrites the
 * ledger AND the baseline, rebuilding every name's `acceptedVersions` from
 * whatever happens to be resolved right now and resetting the review dates. That
 * discards the curated acceptance history the ledger exists to hold, which is
 * the whole audit trail. The runbook records `--seed` as bootstrap-only for
 * exactly this reason, and a roll-forward needs the baseline alone. The ledger
 * append stays a deliberate, reviewed, hand-written edit.
 *
 * Reuses the scanner's own `instancesFromLock`, which already applies the shared
 * `prodFilter` internally, so this is the identical call the gate's
 * `frozenInstances()` makes and the baseline is by construction the same
 * instance set the `--frozen` gate scores. Do not add a `prodFilter` call here:
 * that filters twice. Reimplementing the projection would let the two drift
 * apart silently, and the gate would then compare against a baseline built by
 * different rules.
 *
 * Usage:
 *   node scripts/supply-chain/refresh-baseline.mjs --check   # diff only, exit 1 if stale
 *   node scripts/supply-chain/refresh-baseline.mjs           # write
 */

import {
  closeSync,
  fchmodSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { instancesFromLock } from "./dep-drift-scan.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOCK_PATH = join(REPO_ROOT, "package-lock.json");
const BASELINE_PATH = join(REPO_ROOT, "supply-chain", "prod-closure.baseline.json");

/**
 * The five fields the committed baseline stores per instance.
 *
 * `instancesFromLock` returns a sixth, `license`, which the P2 license detector
 * uses but the baseline has never carried. Writing the raw objects would append
 * `license` to all ~94 instances, turning a three-line roll-forward into a
 * whole-file rewrite and quietly diverging from the shape `--seed` produces.
 * The gate would still pass, since instance comparison ignores `license`, which
 * is exactly what makes it the kind of drift nobody notices. Project explicitly.
 * Caught by Grok in cross-LLM review.
 */
const BASELINE_FIELDS = ["path", "name", "version", "resolved", "integrity"];

/** @returns {Array<object>} prod instances, in the shape the baseline stores. */
function currentInstances() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  return instancesFromLock(lock).map(inst =>
    Object.fromEntries(BASELINE_FIELDS.map(field => [field, inst[field]]))
  );
}

function main(argv) {
  const checkOnly = argv.includes("--check");
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  const before = baseline.instances ?? [];
  const after = currentInstances();

  const key = i => `${i.path}@${i.version}`;
  const beforeIndex = new Map(before.map(i => [i.path, i]));
  const afterIndex = new Map(after.map(i => [i.path, i]));

  const added = after.filter(i => !beforeIndex.has(i.path));
  const removed = before.filter(i => !afterIndex.has(i.path));
  // Compare every field the baseline stores, not just version and integrity.
  // The frozen gate's instance identity spans all five, so a drift in `name` or
  // `resolved` alone (a registry host change, say) would otherwise be reported
  // as "already matches" and could never be refreshed, while the gate went on
  // failing. Caught by Codex in cross-LLM review.
  const changed = after.filter(i => {
    const prev = beforeIndex.get(i.path);
    return prev && BASELINE_FIELDS.some(field => prev[field] !== i[field]);
  });

  for (const i of added) process.stderr.write(`  + ${key(i)}\n`);
  for (const i of removed) process.stderr.write(`  - ${key(i)}\n`);
  for (const i of changed) {
    const prev = beforeIndex.get(i.path);
    process.stderr.write(`  ~ ${i.path}: ${prev.version} -> ${i.version}\n`);
  }

  const stale = added.length + removed.length + changed.length > 0;
  if (!stale) {
    process.stderr.write("[refresh-baseline] baseline already matches the lockfile.\n");
    return 0;
  }
  if (checkOnly) {
    process.stderr.write(
      `[refresh-baseline] baseline is STALE (${added.length} added, ${removed.length} removed, ${changed.length} changed).\n`
    );
    return 1;
  }

  // Atomic write: temp file, fsync, rename. This is the repository's standing
  // convention for any file worth keeping (CLAUDE.md, "Atomic File Writes"), and
  // it matters more here than usual: a plain writeFileSync interrupted midway
  // leaves a truncated prod-closure baseline committed, which is the file the
  // release gate compares every shipped dependency against. Codex flagged the
  // non-atomic first version in review.
  // The mode is carried over from the existing file rather than forced to
  // 0o600. The convention's 0o600 exists for sessions.json, which holds
  // credentials; this baseline is a git-tracked file that CI and every
  // developer must be able to read, and 0o600 would leave a working copy
  // nobody but the writer can open. Preserving the current mode keeps the
  // atomicity guarantee without inventing a permissions change.
  const payload = JSON.stringify({ ...baseline, instances: after }, null, 2) + "\n";
  const mode = statSync(BASELINE_PATH).mode & 0o777;
  const tempPath = `${BASELINE_PATH}.${process.pid}.tmp`;
  try {
    // "wx" so a stale or attacker-planted temp path is an error rather than
    // something we write through, and fchmodSync rather than openSync's mode
    // argument, which is only a creation hint: umask filters it, and it is
    // ignored outright if the file already exists. Codex flagged both.
    const handle = openSync(tempPath, "wx", mode);
    try {
      writeFileSync(handle, payload);
      fchmodSync(handle, mode);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(tempPath, BASELINE_PATH);
  } catch (error) {
    // Without this the pid-suffixed temp file survives a failed write, fsync or
    // rename, and the next run leaves another. Codex flagged the leak.
    rmSync(tempPath, { force: true });
    throw error;
  }
  process.stderr.write(`[refresh-baseline] wrote ${after.length} instances to ${BASELINE_PATH}.\n`);
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
