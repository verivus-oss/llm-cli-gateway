#!/usr/bin/env bash
# Run from repo root before tagging a release. Refreshes the lockfile for
# package.json overrides (e.g. tar-stream) and runs the full release gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> sync static site product-version contract"
# Stable releases synchronize every public label and package.json#publicSiteVersion
# to package.json#version. Prereleases retain the explicit stable
# publicSiteVersion while repairing stale discovery metadata.
# The companion tests make a mismatch a red build in `npm run check` below.
node scripts/sync-site-version.mjs

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

echo "==> build gateway and regenerate static site discovery"
# The generator captures dist/index.js through the live MCP tools/list surface.
# Build first, then write all generated discovery artifacts before the release
# gate verifies their checked-in bytes.
npm run build
npm run site:generate

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

echo "==> strip internal MCP names + verify the packed tarball is clean"
# MUST be the FINAL steps. verify-registry-install.sh above does an UNFLAGGED
# `npm publish` to Verdaccio, which runs prepublishOnly (`npm run build && npm
# test`) and rebuilds dist — a strip placed before it would be clobbered (and
# would publish unstripped dist to Verdaccio). The Verdaccio publish legitimately
# tests the FULL dist (dependency/shrinkwrap fidelity, not name-stripping), so an
# unstripped Verdaccio publish is correct; we strip + verify only here, last, on
# the genuinely shipped bytes. (CI's npm-publish.yml runs the same two steps after
# its own security:audit.)
node scripts/strip-internal-mcp.mjs
node scripts/verify-no-internal-mcp.mjs

echo "Pre-release checks passed."
