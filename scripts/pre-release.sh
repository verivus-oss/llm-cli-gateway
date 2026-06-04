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

echo "==> better-sqlite3 native binding sanity"
# npm install after an overrides change can re-lay the better-sqlite3 subtree
# without re-running its install script, leaving no build/Release binding —
# the whole test suite then fails with "Could not locate the bindings file"
# (hit during v1.17.7 prep).
node -e "require('better-sqlite3')" 2>/dev/null || npm rebuild better-sqlite3

echo "==> tar-stream resolution"
npm ls tar-stream

echo "==> release gate"
npm run check

echo "==> registry-fidelity verification (verdaccio publish + fresh consumer install)"
# Real consumers install from a registry, and registry installs DO honour the
# shipped shrinkwrap (unlike local-tarball installs). Publish the current tree
# to an ephemeral verdaccio and assert the consumer gets the pinned tar chain,
# no dev-dep bloat, a working bin, and a loadable better-sqlite3 binding. Needs
# the regenerated npm-shrinkwrap.json (above) and the built dist/ (npm check).
bash scripts/verify-registry-install.sh

echo "Pre-release checks passed."