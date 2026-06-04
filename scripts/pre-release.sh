#!/usr/bin/env bash
# Run from repo root before tagging a release. Refreshes the lockfile for
# package.json overrides (e.g. tar-stream) and runs the full release gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> npm install (apply overrides; package-lock.json is the source of truth)"
# Remove the shrinkwrap first: when npm-shrinkwrap.json exists npm treats it
# as authoritative and lets package-lock.json go stale. Regenerating from a
# fresh lockfile keeps the two byte-identical (release-security-audit enforces
# parity).
rm -f npm-shrinkwrap.json
npm install

echo "==> regenerate npm-shrinkwrap.json (ships in the tarball; pins consumer resolution, e.g. tar-stream 3.1.7)"
cp package-lock.json npm-shrinkwrap.json

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

echo "Pre-release checks passed."