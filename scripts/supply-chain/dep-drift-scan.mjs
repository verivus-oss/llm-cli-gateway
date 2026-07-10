#!/usr/bin/env node
// Supply-chain guard: prod-closure dependency-drift + tag-along scanner.
//
// Spec: docs/plans/supply-chain-guard.draft.md (4-round cross-LLM-approved).
// DAG:  docs/plans/supply-chain-guard.dag.toml
//
// Reproduces the release-time prod-dependency closure and classifies every
// path-keyed package INSTANCE against a committed instance baseline + name-keyed
// ledger. Internal-only tooling; never shipped in the npm tarball.
//
// Trust unit: an instance = one node_modules/... lockfile entry carrying
// { path, name, version, resolved, integrity }. Names are path-derived (lockfile
// entries omit `name`); the root "" entry is excluded from classification.
//
// Exit codes (max severity over all instances + dropped + invariants):
//   0 clean         every instance matches the committed baseline exactly
//   2 roll-forward  ledgered names moved to an accepted version/path, and/or a
//                   baseline instance was dropped (both are baseline mismatches
//                   that BLOCK the exit-0 gate until the baseline is refreshed)
//   3 fail-closed   tag-along / new_to_tree / source anomaly / integrity
//                   mismatch / reused-invariant failure
//   1 tool error    (e.g. a non-exact acceptedVersions entry: malformed config)
//
// Modes:
//   --frozen        score the committed lock via prodFilter (no npm install).
//                   The CI / release-gate mode; scores the tree the release ships.
//   (default)       fresh resolve in a throwaway temp copy of package.json +
//                   package-lock.json, then prodFilter the temp lock. Never
//                   mutates the operator's working tree.
//   --closure FILE  inject a prod closure fixture (JSON: {packages:{...}} or an
//                   instance array) for offline tests.
//   --seed          write baseline + ledger from the committed lock (bootstrap).
//   --out DIR       output directory (default: .supply-chain/scan-<n>).

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { prodFilter } from "../make-prod-shrinkwrap.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..");
const LEDGER_PATH = join(REPO_ROOT, "supply-chain", "prod-closure.ledger.json");
const BASELINE_PATH = join(REPO_ROOT, "supply-chain", "prod-closure.baseline.json");
// Fixed bootstrap date keeps `--seed` output byte-deterministic across re-runs.
const BOOTSTRAP_DATE = "2026-07-10";
const REGISTRY_PREFIX = "https://registry.npmjs.org/";

// Reused-invariant sets, mirroring scripts/release-security-audit.sh (superset,
// not a subset, of today's coverage on the instance dimension).
const FORBIDDEN_CHAIN = new Set(["better-sqlite3", "prebuild-install", "tar-fs", "tar-stream"]);
const BLOCKED_VERSIONS = new Map([
  ["content-type", new Set(["2.0.0"])],
  ["type-is", new Set(["2.1.0"])],
  ["tar-stream", new Set(["2.2.0", "2.1.4", "2.0.0"])],
]);

// ---------------------------------------------------------------------------
// Instance construction (pure)
// ---------------------------------------------------------------------------

/**
 * Derive the package name for a lockfile entry. Lockfile `packages` entries omit
 * `name` when it equals the last path segment, so it is path-derived. MUST use
 * the `/node_modules\//` regex split (single source of truth:
 * scripts/pre-release.sh:43, scripts/release-security-audit.sh:151/190/235);
 * `split("/node_modules/")` leaves the `node_modules/` prefix on top-level
 * entries and masked the tar-stream@2.2.0 finding in 1.17.7.
 * @param {string} path lockfile `packages` key (e.g. "node_modules/@scope/pkg")
 * @param {{name?: string}} meta lockfile entry
 * @returns {string}
 */
export function deriveName(path, meta) {
  return meta.name ?? path.split(/node_modules\//).pop();
}

/**
 * Map a filtered prod `packages` object to classifiable instances. Excludes the
 * root "" entry (no resolved/integrity, first-party), so it never trips the
 * source-anomaly row.
 * @param {Record<string, any>} packagesMap prodFilter(lock).packages
 * @returns {Array<{path:string,name:string,version:string,resolved:string|null,integrity:string|null}>}
 */
export function toInstances(packagesMap) {
  const instances = [];
  for (const [path, meta] of Object.entries(packagesMap ?? {})) {
    if (path === "") continue; // root: first-party, excluded from classification
    instances.push({
      path,
      name: deriveName(path, meta),
      version: meta.version ?? null,
      resolved: meta.resolved ?? null,
      integrity: meta.integrity ?? null,
    });
  }
  return instances;
}

/** Obtain prod instances from a parsed lock object via the shared prodFilter. */
export function instancesFromLock(lock) {
  return toInstances(prodFilter(lock).packages);
}

// ---------------------------------------------------------------------------
// Ledger validation (pure)
// ---------------------------------------------------------------------------

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.]+)?$/;

/** A ledger `acceptedVersions` member must be an exact semver, never a range. */
export function isExactVersion(v) {
  return typeof v === "string" && EXACT_VERSION_RE.test(v);
}

/**
 * Validate a ledger object. Returns an array of error strings; a non-empty array
 * is a malformed-config tool error (exit 1). Rejects any non-exact
 * acceptedVersions entry so a hand-edit cannot reopen the in-range trust window.
 */
export function validateLedger(ledger) {
  const errors = [];
  const packages = ledger?.packages ?? {};
  for (const [name, entry] of Object.entries(packages)) {
    const versions = entry?.acceptedVersions;
    if (!Array.isArray(versions) || versions.length === 0) {
      errors.push(`ledger entry "${name}" has no acceptedVersions array`);
      continue;
    }
    for (const v of versions) {
      if (!isExactVersion(v)) {
        errors.push(`ledger entry "${name}" acceptedVersions contains a non-exact version "${v}"`);
      }
    }
    if (entry.state !== "trusted" && entry.state !== "revoked") {
      errors.push(`ledger entry "${name}" has invalid state "${entry.state}"`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

/** Index a baseline instance list for O(1) lookups. */
function indexBaseline(baselineInstances) {
  const byPath = new Map();
  const names = new Set();
  const byNameVersion = new Map(); // `${name}@${version}` -> instance
  for (const inst of baselineInstances) {
    byPath.set(inst.path, inst);
    names.add(inst.name);
    byNameVersion.set(`${inst.name}@${inst.version}`, inst);
  }
  return { byPath, names, byNameVersion };
}

function isRegistry(resolved) {
  return typeof resolved === "string" && resolved.startsWith(REGISTRY_PREFIX);
}

function sameInstance(a, b) {
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.version === b.version &&
    a.resolved === b.resolved &&
    a.integrity === b.integrity
  );
}

/**
 * Classify one fresh instance against the ledger + indexed baseline per the
 * spec 4.3 decision table (first match wins).
 * @returns {{class:string, exit:number}}
 */
export function classifyInstance(inst, ledger, baselineIndex) {
  const S = isRegistry(inst.resolved);
  if (!S) return { class: "source-anomaly", exit: 3 };

  const bnv = baselineIndex.byNameVersion.get(`${inst.name}@${inst.version}`);
  const integrityConflict = bnv !== undefined && bnv.integrity !== inst.integrity;
  if (integrityConflict) return { class: "integrity-mismatch", exit: 3 };

  const entry = ledger.packages?.[inst.name];
  const trusted = entry !== undefined && entry.state === "trusted";
  if (!trusted) return { class: "tag-along", exit: 3 };

  const nameInBaseline = baselineIndex.names.has(inst.name);
  if (!nameInBaseline) return { class: "tag-along-new-to-tree", exit: 3 };

  const verAccepted = Array.isArray(entry.acceptedVersions) && entry.acceptedVersions.includes(inst.version);
  if (!verAccepted) return { class: "tag-along-unaccepted-version", exit: 3 };

  const baselineAtPath = baselineIndex.byPath.get(inst.path);
  const exactBaseline = baselineAtPath !== undefined && sameInstance(baselineAtPath, inst);
  if (exactBaseline) return { class: "clean", exit: 0 };

  return { class: "roll-forward", exit: 2 };
}

/**
 * Reverse diff: baseline instances whose `path` is absent from the fresh closure
 * (path-keyed, not full-tuple: a same-path change is a forward row 2/7 case, not
 * a drop, so a change is never double-counted). Each dropped instance is exit 2.
 */
export function computeDropped(freshInstances, baselineInstances) {
  const freshPaths = new Set(freshInstances.map((i) => i.path));
  return baselineInstances
    .filter((b) => !freshPaths.has(b.path))
    .map((b) => ({ path: b.path, name: b.name, version: b.version, class: "dropped", exit: 2 }));
}

/** Reused-invariant detectors over the fresh instance set (pure). */
export function reusedInvariantFindings(freshInstances) {
  const findings = [];
  for (const inst of freshInstances) {
    if (FORBIDDEN_CHAIN.has(inst.name)) {
      findings.push({ path: inst.path, name: inst.name, version: inst.version, class: "forbidden-chain", exit: 3 });
    }
    const blocked = BLOCKED_VERSIONS.get(inst.name);
    if (blocked && blocked.has(inst.version)) {
      findings.push({ path: inst.path, name: inst.name, version: inst.version, class: "blocked-version", exit: 3 });
    }
  }
  return findings;
}

/**
 * Classify a whole closure. Pure over injected data, so tests drive it with
 * fixtures. Returns rows, dropped, invariant findings, per-class counts, and the
 * max-severity exit code.
 */
export function classifyClosure(freshInstances, ledger, baseline) {
  const ledgerErrors = validateLedger(ledger);
  if (ledgerErrors.length > 0) {
    return { exit: 1, ledgerErrors, rows: [], dropped: [], invariants: [], counts: {} };
  }
  const baselineInstances = baseline?.instances ?? [];
  const index = indexBaseline(baselineInstances);

  const rows = freshInstances.map((inst) => ({ ...inst, ...classifyInstance(inst, ledger, index) }));
  const dropped = computeDropped(freshInstances, baselineInstances);
  const invariants = reusedInvariantFindings(freshInstances);

  const counts = {};
  for (const r of [...rows, ...dropped, ...invariants]) {
    counts[r.class] = (counts[r.class] ?? 0) + 1;
  }
  const exit = Math.max(0, ...rows.map((r) => r.exit), ...dropped.map((d) => d.exit), ...invariants.map((i) => i.exit));
  return { exit, ledgerErrors: [], rows, dropped, invariants, counts };
}

// ---------------------------------------------------------------------------
// Closure acquisition (I/O; only in the CLI path)
// ---------------------------------------------------------------------------

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** --frozen: score the committed package-lock.json via prodFilter (no install). */
function frozenInstances() {
  const lock = readJson(join(REPO_ROOT, "package-lock.json"));
  return instancesFromLock(lock);
}

/**
 * Default: fresh resolve in a throwaway temp copy. Never mutates the working
 * tree; the temp dir is removed in a finally.
 */
function freshInstances() {
  const dir = mkdtempSync(join(tmpdir(), "sc-guard-"));
  try {
    writeFileSync(join(dir, "package.json"), readFileSync(join(REPO_ROOT, "package.json")));
    writeFileSync(join(dir, "package-lock.json"), readFileSync(join(REPO_ROOT, "package-lock.json")));
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      cwd: dir,
      stdio: "ignore",
    });
    return instancesFromLock(readJson(join(dir, "package-lock.json")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** --closure FILE fixture: either {packages:{...}} (a lock-ish object) or {instances:[...]}. */
function closureFromFixture(path) {
  const obj = readJson(path);
  if (Array.isArray(obj.instances)) return obj.instances;
  if (obj.packages) return toInstances(obj.packages);
  throw new Error(`--closure fixture must have {instances:[...]} or {packages:{...}}: ${path}`);
}

// ---------------------------------------------------------------------------
// Seed (bootstrap) and report writers
// ---------------------------------------------------------------------------

function seedFromCommittedLock() {
  const instances = frozenInstances();
  const baseline = {
    schemaVersion: "prod-closure-baseline.v1",
    instances: instances.map((i) => ({
      path: i.path,
      name: i.name,
      version: i.version,
      resolved: i.resolved,
      integrity: i.integrity,
    })),
  };
  const packages = {};
  for (const i of [...instances].sort((a, b) => a.name.localeCompare(b.name))) {
    const existing = packages[i.name];
    if (existing) {
      if (!existing.acceptedVersions.includes(i.version)) existing.acceptedVersions.push(i.version);
      continue;
    }
    packages[i.name] = {
      acceptedVersions: [i.version],
      source: "registry.npmjs.org",
      state: "trusted",
      firstVetted: BOOTSTRAP_DATE,
      lastReviewed: BOOTSTRAP_DATE,
      reviewers: [],
      rationale: "bootstrap from 2.16.0 shipped closure, not individually reviewed",
    };
  }
  const ledger = { schemaVersion: "prod-closure-ledger.v1", packages };
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + "\n");
  return { baselineCount: baseline.instances.length, ledgerCount: Object.keys(packages).length };
}

function renderReportMd(result) {
  const lines = [`# supply-chain guard report`, ``, `verdict exit: ${result.exit}`, ``, `## counts`];
  for (const [k, v] of Object.entries(result.counts)) lines.push(`- ${k}: ${v}`);
  const flagged = [...result.rows.filter((r) => r.exit > 0), ...result.dropped, ...result.invariants];
  if (flagged.length) {
    lines.push(``, `## flagged`);
    for (const r of flagged) lines.push(`- [${r.class}] ${r.name}@${r.version} (${r.path})`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const args = new Set(argv);
  const outIdx = argv.indexOf("--out");
  const closureIdx = argv.indexOf("--closure");

  if (args.has("--seed")) {
    const { baselineCount, ledgerCount } = seedFromCommittedLock();
    process.stderr.write(
      `[supply-chain-guard] seeded baseline (${baselineCount} instances) + ledger (${ledgerCount} names).\n`
    );
    return 0;
  }

  let freshList;
  if (closureIdx !== -1) freshList = closureFromFixture(resolve(process.cwd(), argv[closureIdx + 1]));
  else if (args.has("--frozen")) freshList = frozenInstances();
  else freshList = freshInstances();

  if (!existsSync(LEDGER_PATH) || !existsSync(BASELINE_PATH)) {
    process.stderr.write(`[supply-chain-guard] no ledger/baseline; run --seed first.\n`);
    return 1;
  }
  const ledger = readJson(LEDGER_PATH);
  const baseline = readJson(BASELINE_PATH);
  const result = classifyClosure(freshList, ledger, baseline);

  const outDir = outIdx !== -1 ? resolve(process.cwd(), argv[outIdx + 1]) : join(REPO_ROOT, ".supply-chain", "latest");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(outDir, "report.md"), renderReportMd(result));

  if (result.exit === 1) process.stderr.write(`[supply-chain-guard] ledger error:\n  ${result.ledgerErrors.join("\n  ")}\n`);
  else process.stderr.write(`[supply-chain-guard] verdict exit ${result.exit}; report at ${outDir}/report.md\n`);

  // Advisory mode (local sweep) tolerates a roll-forward (exit 2) so a human can
  // read drift without a shell failure. The gate form omits --advisory, so a
  // roll-forward or drop (exit 2) still blocks (spec 4.5: gate requires exit 0).
  if (args.has("--advisory") && result.exit === 2) return 0;
  return result.exit;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
