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

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
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
const LICENSE_ALLOWLIST_PATH = join(SCRIPT_DIR, "..", "..", "supply-chain", "license-allowlist.json");
const SOCKET_YML_PATH = join(SCRIPT_DIR, "..", "..", "socket.yml");
// P2: the reviewed socket.yml issueRules posture. Any deviation (a rule flipped,
// added, or removed) is a policy-drift finding. Update this map deliberately, in
// lock-step with a reviewed socket.yml change (same discipline as the hono floor).
const REQUIRED_SOCKET_POLICY = {
  malware: true,
  troll: true,
  didYouMean: true,
  installScripts: true,
  telemetry: true,
  hasNativeCode: true,
  shrinkwrap: false,
  shellAccess: false,
  shellScriptOverride: true,
  gitDependency: true,
  httpDependency: true,
  invalidPackageJSON: true,
  unresolvedRequire: true,
};

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
      // license is a P2 signal; a string SPDX id (or absent) in the lockfile.
      license: typeof meta.license === "string" ? meta.license : null,
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

const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;

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
 * P2 license allowlist (pure). A prod instance whose `license` is absent or not
 * an exact member of the allowed set is a license-violation (exit 3). SPDX
 * expressions that are not verbatim in the allowlist are flagged deliberately, so
 * a dual-license entry cannot slip a copyleft term in unnoticed.
 * @param {Array} instances
 * @param {Set<string>|string[]} allowed allowed SPDX ids
 */
export function licenseFindings(instances, allowed) {
  const set = allowed instanceof Set ? allowed : new Set(allowed ?? []);
  const findings = [];
  for (const inst of instances) {
    if (inst.license === null || inst.license === undefined || !set.has(inst.license)) {
      findings.push({
        path: inst.path,
        name: inst.name,
        version: inst.version,
        class: "license-violation",
        license: inst.license ?? null,
        exit: 3,
      });
    }
  }
  return findings;
}

/**
 * P2 Socket policy-drift tripwire (pure). Asserts the security-critical
 * socket.yml `issueRules` stay at their reviewed enforcing values; any deviation
 * (a rule flipped, added, or removed relative to the expected posture) is a
 * policy-drift finding (exit 3). This is an offline, deterministic cross-check;
 * a live Socket-API capability query would need network/credentials and does not
 * belong in the release gate.
 * @param {Record<string, boolean>} issueRules parsed from socket.yml
 * @param {Record<string, boolean>} expected the reviewed posture
 */
export function socketPolicyFindings(issueRules, expected) {
  const findings = [];
  const rules = issueRules ?? {};
  // Expected rule flipped or missing.
  for (const [rule, want] of Object.entries(expected)) {
    const got = rules[rule];
    if (got !== want) {
      findings.push({
        path: "socket.yml",
        name: `issueRules.${rule}`,
        version: "-",
        class: "socket-policy-drift",
        expected: want,
        actual: got ?? null,
        exit: 3,
      });
    }
  }
  // Unexpected rule ADDED to socket.yml (bidirectional check): a new issueRule not
  // in the reviewed posture is also drift. Pin the full posture, so REQUIRED_SOCKET_
  // POLICY must be updated in lock-step with any deliberate socket.yml addition.
  for (const rule of Object.keys(rules)) {
    if (!(rule in expected)) {
      findings.push({
        path: "socket.yml",
        name: `issueRules.${rule}`,
        version: "-",
        class: "socket-policy-drift",
        expected: null,
        actual: rules[rule],
        exit: 3,
      });
    }
  }
  return findings;
}

/**
 * Classify a whole closure. Pure over injected data, so tests drive it with
 * fixtures. Returns rows, dropped, invariant findings, per-class counts, and the
 * max-severity exit code. `opts.licenseAllowlist` (Set|array) enables the P2
 * license detector; `opts.extraFindings` folds in repo-level findings (P2 socket
 * policy, fetch-in-dist) computed by the caller.
 */
export function classifyClosure(freshInstances, ledger, baseline, opts = {}) {
  const ledgerErrors = validateLedger(ledger);
  if (ledgerErrors.length > 0) {
    return { exit: 1, ledgerErrors, rows: [], dropped: [], invariants: [], counts: {} };
  }
  const baselineInstances = baseline?.instances ?? [];
  const index = indexBaseline(baselineInstances);

  const rows = freshInstances.map((inst) => ({ ...inst, ...classifyInstance(inst, ledger, index) }));
  const dropped = computeDropped(freshInstances, baselineInstances);
  // Invariants: reused (P0/P1) + P2 license allowlist + caller-supplied repo-level
  // findings (P2 socket policy, fetch-in-dist).
  const invariants = [
    ...reusedInvariantFindings(freshInstances),
    ...(opts.licenseAllowlist ? licenseFindings(freshInstances, opts.licenseAllowlist) : []),
    ...(opts.extraFindings ?? []),
  ];

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

/**
 * Parse the flat `issueRules:` block of socket.yml into { rule: boolean } without
 * a YAML dependency. Only reads the two-space-indented `key: true|false` lines
 * under `issueRules:` (comments stripped); anything else is ignored.
 */
export function parseSocketIssueRules(text) {
  const rules = {};
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (const line of lines) {
    if (/^issueRules:\s*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\S/.test(line)) break; // dedent: end of the issueRules block
      const m = line.replace(/#.*$/, "").match(/^\s+([A-Za-z][A-Za-z0-9]*):\s*(true|false)\s*$/);
      if (m) rules[m[1]] = m[2] === "true";
    }
  }
  return rules;
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

/**
 * Reused invariant #7: the shipped-dist Socket heuristic (mirrors
 * release-security-audit.sh:263-305). Walks dist/**\/*.js for a literal `fetch`
 * token. Only meaningful when dist/ exists (a build has run); returns [] when it
 * is absent (e.g. offline test runs), so it never blocks a dist-less scan.
 */
export function fetchInDistFindings(repoRoot) {
  const distDir = join(repoRoot, "dist");
  if (!existsSync(distDir)) return [];
  const findings = [];
  const fetchRe = /\bfetch\b/i; // case-insensitive, matching release-security-audit.sh:270 exactly
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      // Mirror release-security-audit.sh scope exactly: skip __tests__ (not
      // shipped: excluded from the package.json files allowlist) and only .js.
      if (ent.isDirectory()) {
        if (ent.name === "__tests__") continue;
        walk(join(dir, ent.name));
      } else if (ent.isFile() && ent.name.endsWith(".js") && fetchRe.test(readFileSync(join(dir, ent.name), "utf8"))) {
        findings.push({ path: join(dir, ent.name).slice(repoRoot.length + 1), name: "dist", version: "-", class: "fetch-in-dist", exit: 3 });
      }
    }
  };
  walk(distDir);
  return findings;
}

/** Write one upgrade+advisory+test contract stub per flagged package. */
function writeContractStubs(outDir, flagged) {
  if (flagged.length === 0) return;
  const dir = join(outDir, "contracts");
  mkdirSync(dir, { recursive: true });
  const seen = new Set();
  for (const f of flagged) {
    const key = `${f.name}@${f.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const safe = `${f.name}@${f.version}`.replace(/[^A-Za-z0-9.@-]+/g, "_");
    const body = [
      `# contract: ${f.name}@${f.version}`,
      ``,
      `- class: ${f.class}`,
      `- path: ${f.path}`,
      ``,
      `## advisory research (exa)`,
      `- latest npm version:`,
      `- GHSA/OSV advisory:`,
      `- changelog baseline -> resolved:`,
      `- pulled in by:`,
      ``,
      `## upgrade decision`,
      `- safe-to-upgrade: YES/NO`,
      `- rationale:`,
      ``,
      `## cross-LLM validation`,
      `- codex:`,
      `- grok:`,
      `- mistral:`,
      ``,
    ].join("\n");
    writeFileSync(join(dir, `${safe}.md`), body);
  }
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

  // Repo-level P2 detectors (license allowlist, socket policy) + fetch-in-dist.
  // Skipped for --closure fixtures (offline tests). In the real repo path the
  // policy config files are REQUIRED: a missing license-allowlist.json or
  // socket.yml is a misconfiguration (exit 1), never a silently-disabled check,
  // so the fail-closed detectors cannot be defeated by deleting their config.
  let licenseAllowlist = null;
  const extraFindings = [];
  if (closureIdx === -1) {
    if (!existsSync(LICENSE_ALLOWLIST_PATH)) {
      process.stderr.write(`[supply-chain-guard] missing ${LICENSE_ALLOWLIST_PATH}; run --seed or restore it.\n`);
      return 1;
    }
    if (!existsSync(SOCKET_YML_PATH)) {
      process.stderr.write(`[supply-chain-guard] missing ${SOCKET_YML_PATH} (Socket policy source).\n`);
      return 1;
    }
    licenseAllowlist = new Set(readJson(LICENSE_ALLOWLIST_PATH).allowed ?? []);
    extraFindings.push(
      ...socketPolicyFindings(parseSocketIssueRules(readFileSync(SOCKET_YML_PATH, "utf8")), REQUIRED_SOCKET_POLICY)
    );
    extraFindings.push(...fetchInDistFindings(REPO_ROOT));
  }

  const result = classifyClosure(freshList, ledger, baseline, {
    licenseAllowlist,
    extraFindings,
  });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = outIdx !== -1 ? resolve(process.cwd(), argv[outIdx + 1]) : join(REPO_ROOT, ".supply-chain", `scan-${stamp}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "report.json"), JSON.stringify(result, null, 2) + "\n");
  writeFileSync(join(outDir, "report.md"), renderReportMd(result));
  writeContractStubs(outDir, [...result.rows.filter((r) => r.exit > 0), ...result.dropped, ...result.invariants]);

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
