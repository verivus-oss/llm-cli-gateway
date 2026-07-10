#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

echo "==> npm vulnerability audit"
npm audit --omit=dev --audit-level=moderate

echo "==> source dynamic execution scan"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src');
const findings = [];
const pattern = /(?:^|[^\w$])(?:eval\s*\(|Function\s*\(|new\s+Function\s*\(|[\w$)]+\s*\.\s*eval\s*\()/;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(full);
      continue;
    }
    if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        findings.push(`${path.relative(process.cwd(), full)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

walk(root);

if (findings.length > 0) {
  console.error('Dynamic execution patterns found in production source:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log('No production source dynamic execution patterns found.');
NODE

echo "==> sqlite adapter-isolation + pragma API scan"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src');
// The node:sqlite adapter (src/sqlite-driver.ts) MUST be the only production
// module that touches node:sqlite — every other module talks to SQLite through
// the adapter's GatewayDatabase/GatewayStatement surface. We also forbid the
// better-sqlite3 `db.pragma()` helper API anywhere in prod source (it never
// existed on node:sqlite; a reappearance signals a botched migration).
const ADAPTER_REL = path.join('src', 'sqlite-driver.ts');
const nodeSqlitePattern = /["']node:sqlite["']/;
const pragmaPattern = /\.\s*pragma\s*\(/;
const nodeSqliteFindings = [];
const pragmaFindings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(full);
      continue;
    }
    if (!/\.[cm]?[jt]s$/.test(entry.name)) continue;
    const rel = path.relative(process.cwd(), full);
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (nodeSqlitePattern.test(line) && rel !== ADAPTER_REL) {
        nodeSqliteFindings.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
      if (pragmaPattern.test(line)) {
        pragmaFindings.push(`${rel}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

walk(root);

if (nodeSqliteFindings.length > 0) {
  console.error(`node:sqlite referenced outside the adapter (${ADAPTER_REL}) — the adapter must remain the sole node:sqlite touchpoint:`);
  for (const finding of nodeSqliteFindings) console.error(finding);
  process.exit(1);
}

if (pragmaFindings.length > 0) {
  console.error('db.pragma() helper API found in production source (not a node:sqlite API):');
  for (const finding of pragmaFindings) console.error(finding);
  process.exit(1);
}

console.log(`node:sqlite confined to the adapter (${ADAPTER_REL}); no db.pragma() helper API in production source.`);
NODE

echo "==> shrinkwrap presence + prod-projection parity"
if [ ! -f npm-shrinkwrap.json ]; then
  echo "npm-shrinkwrap.json missing — consumers would resolve their own (unpinned) transitive versions. It is generated, never committed: run node scripts/make-prod-shrinkwrap.mjs (pre-release.sh and the CI/publish workflows do this before auditing/packing)." >&2
  exit 1
fi
# The shipped shrinkwrap is the PROD-ONLY projection of package-lock.json
# (dev-only entries + root devDependencies stripped — npm/cli#4323), not a
# byte-identical copy. Parity = regenerate the expected projection from the
# current lockfile via the same deterministic generator into a temp file and
# compare byte-for-byte. Determinism makes this exact; no semantic diff needed.
EXPECTED_SHRINKWRAP="$(mktemp)"
trap 'rm -f "${EXPECTED_SHRINKWRAP}"' EXIT
node scripts/make-prod-shrinkwrap.mjs "${EXPECTED_SHRINKWRAP}" >/dev/null
if ! cmp -s "${EXPECTED_SHRINKWRAP}" npm-shrinkwrap.json; then
  echo "npm-shrinkwrap.json is not the prod-only projection of package-lock.json — regenerate with scripts/pre-release.sh (node scripts/make-prod-shrinkwrap.mjs) so the shipped pin set matches the audited lockfile." >&2
  exit 1
fi
rm -f "${EXPECTED_SHRINKWRAP}"
trap - EXIT
echo "npm-shrinkwrap.json present and matches the prod-only projection of package-lock.json."

echo "==> dependency tree policy"
node --input-type=module <<'NODE'
import fs from 'node:fs';

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const blocked = new Map([
  ['content-type', new Set(['2.0.0'])],
  ['type-is', new Set(['2.1.0'])],
  ['tar-stream', new Set(['2.2.0', '2.1.4', '2.0.0'])],
]);
const findings = [];

for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  // PROD-GRAPH tripwire: in 2.0.0 better-sqlite3 is a devDependency, so its
  // install-time tar-stream@2.2.0 legitimately lives in the lockfile as a
  // dev-transitive (`dev: true`) — it never reaches consumers (dev deps don't
  // install transitively, and the prod-only shrinkwrap excludes it). The
  // blocklist stays as a HARD tripwire for the PROD graph: skip dev-only
  // entries, fail on any blocked version that is prod or prod-required
  // (devOptional). This catches the chain re-entering production while not
  // false-failing on the deliberate devDependency retention.
  if (meta.dev === true) continue;
  // 'node_modules/x' and 'node_modules/a/node_modules/x' both end in the
  // package name; splitting on '/node_modules/' misses TOP-LEVEL entries
  // (no leading slash before the delimiter) — that bug masked the
  // tar-stream@2.2.0 consumer finding in 1.17.7.
  const name = meta.name ?? path.split(/node_modules\//).pop();
  const versions = blocked.get(name);
  if (versions?.has(meta.version)) {
    findings.push(`${name}@${meta.version} at ${path || '.'}`);
  }
}

if (findings.length > 0) {
  console.error('Blocked Socket-flagged dependency versions found in lockfile prod graph:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log('Lockfile does not contain blocked Socket-flagged dependency versions.');
NODE

echo "==> hono floor tripwire"
node --input-type=module <<'NODE'
import fs from 'node:fs';

// hono ships transitively via @modelcontextprotocol/sdk. 4.12.22 and below carry
// known advisories (SNYK-JS-HONO-*; fix line = upgrade to 4.12.25+). A
// package.json#overrides pin (hono ^4.12.25) raises the floor; this tripwire
// fails the release if anything regresses below it. Mirrors the blocked-version
// checks above but as a minimum-version floor rather than a blocklist.
const FLOOR = [4, 12, 25];
function below(version) {
  const parts = version.split('.').map(n => parseInt(n, 10));
  for (let i = 0; i < FLOOR.length; i++) {
    const v = parts[i] ?? 0;
    if (v < FLOOR[i]) return true;
    if (v > FLOOR[i]) return false;
  }
  return false; // equal → at floor, allowed
}

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const findings = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  const name = meta.name ?? path.split(/node_modules\//).pop();
  if (name !== 'hono' || typeof meta.version !== 'string') continue;
  if (below(meta.version)) {
    findings.push(`hono@${meta.version} at ${path || '.'}`);
  }
}

if (findings.length > 0) {
  console.error(`hono below the ${FLOOR.join('.')} security floor (advisory regression — keep the package.json overrides pin):`);
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log(`hono is at or above the ${FLOOR.join('.')} security floor.`);
NODE

echo "==> packed consumer install policy"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

PACKAGE_TGZ="$(npm pack --pack-destination "${TMP_DIR}" --silent)"
mkdir -p "${TMP_DIR}/consumer"
pushd "${TMP_DIR}/consumer" >/dev/null
npm init -y >/dev/null
npm install "../${PACKAGE_TGZ}" --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null
node --input-type=module <<'NODE'
import fs from 'node:fs';

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const blocked = new Map([
  ['content-type', new Set(['2.0.0'])],
  ['type-is', new Set(['2.1.0'])],
  ['tar-stream', new Set(['2.2.0', '2.1.4', '2.0.0'])],
]);
// 2.0.0: the entire better-sqlite3 → prebuild-install → tar-fs → tar-stream
// chain left the prod graph (node:sqlite is built into Node). better-sqlite3
// is a devDependency now and dev deps do not install for consumers, so a
// packed consumer install must contain NO tar-stream at all — any version,
// any path, is a hard fail (the advisory carve-out is gone). Blocked versions
// of content-type/type-is remain hard tripwires via `blocked`.
const findings = [];
const tarStreamSightings = [];

for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  // Same top-level-entry fix as the repo lockfile check above.
  const name = meta.name ?? path.split(/node_modules\//).pop();
  if (blocked.get(name)?.has(meta.version)) {
    findings.push(`${name}@${meta.version} at ${path || '.'}`);
  }
  if (name === 'tar-stream') {
    tarStreamSightings.push(`${meta.version} at ${path || '.'}`);
  }
}

if (findings.length > 0) {
  console.error('Blocked Socket-flagged dependency versions found in packed consumer install:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

if (tarStreamSightings.length > 0) {
  console.error('tar-stream present in packed consumer install — the better-sqlite3 chain must be gone from the prod graph in 2.0.0:');
  for (const sighting of tarStreamSightings) console.error(sighting);
  process.exit(1);
}

console.log('Packed consumer install policy passed (no blocked versions; no tar-stream in the consumer tree).');
NODE
popd >/dev/null

echo "==> packed skill-pack MCP resource smoke"
node scripts/verify-packed-skill-pack-e2e.mjs

echo "==> shipped dist Socket network heuristic scan"
npm run build --silent
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const dist = path.resolve('dist');
const pattern = /\bfetch\b/i;
const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      walk(full);
      continue;
    }
    if (!entry.name.endsWith('.js')) continue;
    const lines = fs.readFileSync(full, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (pattern.test(line)) {
        findings.push(`${path.relative(process.cwd(), full)}:${index + 1}: ${line.trim()}`);
      }
    });
  }
}

if (!fs.existsSync(dist)) {
  console.error('dist/ missing; run npm run build before release-security-audit');
  process.exit(1);
}

walk(dist);

if (findings.length > 0) {
  console.error('Literal "fetch" found in shipped dist/*.js (Socket networkAccess heuristic):');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log('No literal "fetch" in shipped dist/*.js.');
NODE

echo "==> supply-chain guard (prod-closure allowlist / tag-along)"
# The prod-closure allowlist layer (docs/plans/supply-chain-guard.draft.md).
# --frozen scores the committed package-lock.json via the shared prodFilter (the
# same prod projection the shrinkwrap step above regenerates), never a fresh
# install. It requires exit 0: a tag-along (un-ledgered package), source anomaly,
# integrity mismatch, unaccepted-version drift, or dropped instance exits non-zero
# and, under `set -e`, fails the audit until the ledger + baseline are refreshed
# through the /supply-chain-guard reviewed process.
node scripts/supply-chain/dep-drift-scan.mjs --frozen

echo "Release security audit passed."
