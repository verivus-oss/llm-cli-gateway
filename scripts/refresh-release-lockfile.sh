#!/usr/bin/env bash
# Regenerate package-lock.json + npm-shrinkwrap.json after overrides change
# (e.g. tar-stream 3.1.7). Required before release when package.json#overrides
# changed. The shrinkwrap is the PROD-ONLY projection of the lockfile (dev-only
# entries and root devDependencies stripped — npm/cli#4323), generated
# deterministically by scripts/make-prod-shrinkwrap.mjs; release-security-audit
# enforces parity by regenerating and comparing.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f npm-shrinkwrap.json
npm install
node scripts/make-prod-shrinkwrap.mjs
npm ls tar-stream
echo "Expected: tar-stream@3.1.7 (overridden from prebuild-install → tar-fs chain)"
