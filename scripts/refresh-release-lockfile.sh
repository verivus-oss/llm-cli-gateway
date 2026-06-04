#!/usr/bin/env bash
# Regenerate package-lock.json + npm-shrinkwrap.json after overrides change
# (e.g. tar-stream 3.1.7). Required before release when package.json#overrides
# changed. The shrinkwrap must stay byte-identical to the lockfile
# (release-security-audit enforces parity).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -f npm-shrinkwrap.json
npm install
cp package-lock.json npm-shrinkwrap.json
npm ls tar-stream
echo "Expected: tar-stream@3.1.7 (overridden from prebuild-install → tar-fs chain)"