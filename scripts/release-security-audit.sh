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

echo "==> sqlite pragma API scan"
node --input-type=module <<'NODE'
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('src');
const findings = [];
const pattern = /\.\s*pragma\s*\(/;

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
  console.error('better-sqlite3 db.pragma() calls found in production source:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log('No production source calls better-sqlite3 db.pragma().');
NODE

echo "==> shrinkwrap presence + lockfile parity"
if [ ! -f npm-shrinkwrap.json ]; then
  echo "npm-shrinkwrap.json missing — consumers would resolve their own (unpinned) transitive versions. Run scripts/pre-release.sh." >&2
  exit 1
fi
if ! cmp -s package-lock.json npm-shrinkwrap.json; then
  echo "npm-shrinkwrap.json differs from package-lock.json — regenerate with scripts/pre-release.sh so the shipped pin set matches the audited lockfile." >&2
  exit 1
fi
echo "npm-shrinkwrap.json present and identical to package-lock.json."

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
  console.error('Blocked Socket-flagged dependency versions found in lockfile:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log('Lockfile does not contain blocked Socket-flagged dependency versions.');
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
// ADVISORY (warn, don't fail) in the CONSUMER tree only: tar-stream 2.x
// arrives via better-sqlite3 → prebuild-install → tar-fs, used solely at
// install time to extract the prebuilt binding fetched over HTTPS from
// better-sqlite3's GitHub releases. We ship npm-shrinkwrap.json pinning
// tar-stream 3.1.7, but npm currently IGNORES published shrinkwraps
// (npm/cli#7977) — so dependents re-resolve 2.x and we cannot prevent it
// from this package. The repo's own lockfile check above still hard-fails
// on these versions. Revisit (remove this advisory carve-out) when
// npm/cli#7977 is fixed or better-sqlite3 drops prebuild-install.
const consumerAdvisory = new Map([
  ['tar-stream', new Set(['2.2.0', '2.1.4', '2.0.0'])],
]);
const findings = [];
const advisories = [];
const tarStreamVersions = [];

for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  // Same top-level-entry fix as the repo lockfile check above.
  const name = meta.name ?? path.split(/node_modules\//).pop();
  if (blocked.get(name)?.has(meta.version)) {
    const line = `${name}@${meta.version} at ${path || '.'}`;
    if (consumerAdvisory.get(name)?.has(meta.version)) {
      advisories.push(line);
    } else {
      findings.push(line);
    }
  }
  if (name === 'tar-stream') tarStreamVersions.push(meta.version);
}

if (findings.length > 0) {
  console.error('Blocked Socket-flagged dependency versions found in packed consumer install:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

if (tarStreamVersions.length > 0 && tarStreamVersions.every(v => v.startsWith('3.'))) {
  // npm honoured the shipped shrinkwrap — npm/cli#7977 is presumably fixed.
  console.log(`Packed consumer install resolves tar-stream ${tarStreamVersions.join(', ')} (shrinkwrap honoured — consider removing the advisory carve-out).`);
} else {
  for (const advisory of advisories) {
    console.warn(`ADVISORY (known, upstream, install-time only — npm/cli#7977): ${advisory}`);
  }
}

console.log('Packed consumer install policy passed (no blocked versions beyond the documented advisory).');
NODE
popd >/dev/null

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

echo "Release security audit passed."
