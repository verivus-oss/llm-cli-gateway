#!/usr/bin/env bash
# Run from repo root before tagging a release. Refreshes the lockfile for
# package.json overrides (e.g. tar-stream) and runs the full release gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> npm install (apply overrides; package-lock.json is the source of truth)"
# Remove the shrinkwrap first: when npm-shrinkwrap.json exists npm treats it
# as authoritative and lets package-lock.json go stale. The shrinkwrap is then
# regenerated below as the prod-only projection of the fresh lockfile
# (release-security-audit regenerates and compares to enforce parity).
rm -f npm-shrinkwrap.json
npm install

echo "==> regenerate npm-shrinkwrap.json (prod-only; ships in the tarball, pins REGISTRY consumer resolution, e.g. tar-stream 3.1.7)"
# Prod-only shrinkwrap: filter package-lock.json so dev-only entries and the
# root devDependencies field are dropped (npm/cli#4323 — a byte-identical copy
# would reify all ~316 packages into consumer trees instead of the prod ~124).
# Deterministic; the security audit regenerates and compares for parity.
node scripts/make-prod-shrinkwrap.mjs

echo "==> prod graph is free of the better-sqlite3 / tar chain (2.0.0)"
# 2.0.0 moved better-sqlite3 to devDependencies and dropped the tar-stream
# override; node:sqlite is built into Node, so the prod graph carries no native
# module and no better-sqlite3 → prebuild-install → tar-fs → tar-stream chain.
# Robust assertion: inspect the GENERATED prod-only shrinkwrap (the exact tree
# registry consumers receive) rather than `npm ls`, which still shows these as
# dev-transitives in the repo tree. tar-stream/better-sqlite3/prebuild-install/
# tar-fs MUST be absent from the prod projection.
node --input-type=module <<'NODE'
import fs from 'node:fs';
const lock = JSON.parse(fs.readFileSync('npm-shrinkwrap.json', 'utf8'));
const forbidden = new Set(['better-sqlite3', 'prebuild-install', 'tar-fs', 'tar-stream']);
const found = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  const name = meta.name ?? path.split(/node_modules\//).pop();
  if (forbidden.has(name)) found.push(`${name}@${meta.version} at ${path || '.'}`);
}
if (found.length > 0) {
  console.error('Forbidden native/tar-chain packages in the prod-only shrinkwrap (should be devDependency-only in 2.0.0):');
  for (const f of found) console.error(f);
  process.exit(1);
}
console.log('Prod-only shrinkwrap is free of better-sqlite3/prebuild-install/tar-fs/tar-stream.');
NODE

echo "==> release gate"
npm run check

echo "==> registry-fidelity verification (verdaccio publish + fresh consumer install)"
# Real consumers install from a registry, and registry installs DO honour the
# shipped shrinkwrap (unlike local-tarball installs). Publish the current tree
# to an ephemeral verdaccio and assert the consumer tree has no native module
# or tar chain (no better-sqlite3/tar-stream), no dev-dep bloat, a working bin,
# a clean `npm ls`, and a working node:sqlite runtime. Needs the regenerated
# npm-shrinkwrap.json (above) and the built dist/ (npm check).
bash scripts/verify-registry-install.sh

echo "Pre-release checks passed."