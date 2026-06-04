#!/usr/bin/env bash
# Regenerate package-lock.json after overrides change (e.g. tar-stream 3.1.7).
# Required before release when package.json#overrides changed.
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
npm ls tar-stream
echo "Expected: tar-stream@3.1.7 (overridden from prebuild-install → tar-fs chain)"