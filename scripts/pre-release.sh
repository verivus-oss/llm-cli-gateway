#!/usr/bin/env bash
# Run from repo root before tagging a release. Refreshes the lockfile for
# package.json overrides (e.g. tar-stream) and runs the full release gate.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

echo "==> npm install (apply overrides)"
npm install

echo "==> tar-stream resolution"
npm ls tar-stream

echo "==> release gate"
npm run check

echo "Pre-release checks passed."