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

echo "==> dependency tree policy"
node --input-type=module <<'NODE'
import fs from 'node:fs';

const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const blocked = new Map([
  ['content-type', new Set(['2.0.0'])],
  ['type-is', new Set(['2.1.0'])],
]);
const findings = [];

for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  const name = meta.name ?? path.split('/node_modules/').pop();
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
]);
const findings = [];

for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  const name = meta.name ?? path.split('/node_modules/').pop();
  const versions = blocked.get(name);
  if (versions?.has(meta.version)) {
    findings.push(`${name}@${meta.version} at ${path || '.'}`);
  }
}

if (findings.length > 0) {
  console.error('Blocked Socket-flagged dependency versions found in packed consumer install:');
  for (const finding of findings) console.error(finding);
  process.exit(1);
}

console.log('Packed consumer install does not resolve blocked Socket-flagged versions.');
NODE
popd >/dev/null

echo "Release security audit passed."
