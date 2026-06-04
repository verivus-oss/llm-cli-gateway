#!/usr/bin/env bash
# Registry-fidelity verification (plan A3, updated for 2.0.0 / plan B5).
#
# Local-tarball installs IGNORE a package's nested shrinkwrap (our live repro on
# npm 11.12.1 — npm/cli#5349/#5325 class), so the packed-consumer-install audit
# in release-security-audit.sh CANNOT observe what real registry consumers get.
# Real consumers `npm install llm-cli-gateway` from a registry, and registry
# installs DO honour the published shrinkwrap. This script proves that end to
# end: publish the current tree to an ephemeral verdaccio, install it fresh from
# that registry, and assert the properties the prod-only shrinkwrap buys us.
#
# 2.0.0 reality (plan B5): node:sqlite is built into Node, better-sqlite3 is a
# devDependency, and the tar-stream override is gone. The consumer tree must
# therefore carry NO better-sqlite3, NO tar-stream, NO prebuild-install — no
# native module and no install scripts at all — and `npm ls` must exit 0 (the
# out-of-range tar-stream pin that caused ELSPROBLEMS is gone).
#
# The publish / consumer-install / assertion flow is scoped to throwaway temp
# dirs and the localhost verdaccio registry: every npm invocation in that flow
# hardcodes --registry http://localhost:PORT and --cache/--userconfig under
# mktemp dirs, so the package under test never reaches the public registry and
# nothing of the test flow reads or writes the user's real npm config or cache.
#
# ONE exception: the verdaccio BOOTSTRAP itself. `npx --yes verdaccio` resolves
# (and on first use downloads, ~1 minute) verdaccio through the user's normal
# npm config and npx cache — unavoidable for an ephemeral tool that is not a
# devDependency. That bootstrap touches only verdaccio's own packages, never
# the package under test; the readiness poll below has a generous timeout to
# cover a first-use download.
#
# Run by scripts/pre-release.sh (after the shrinkwrap regeneration + npm check
# build) and standalone before any release.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

EXPECTED_VERSION="$(node -p "require('./package.json').version")"
# 2.0.0: the consumer tree must contain NONE of these (native module + its
# install-time tar chain are gone from the prod graph — node:sqlite is built in).
FORBIDDEN_IN_CONSUMER=(tar-stream better-sqlite3 prebuild-install)
# Observed reified package count (incl root) = 94 on npm 11.12.1, 2026-06-04
# (verdaccio repro), asserted as observed ±2 per plan B5 ("Exact numbers
# asserted in the registry-fidelity check after implementation"). Plan
# predicted ~92; 94 observed.
EXPECTED_REIFIED_MIN=92
EXPECTED_REIFIED_MAX=96

# The shrinkwrap is generated, never committed (a committed prod-only one
# breaks npm ci). Regenerate it here so the published tree always carries a
# fresh projection of the current lockfile — standalone runs included.
node scripts/make-prod-shrinkwrap.mjs

# Pick a random free port (ask the OS for an ephemeral one, then reuse it).
PORT="$(node -e 'const net=require("net");const s=net.createServer();s.listen(0,()=>{process.stdout.write(String(s.address().port));s.close();});')"
REGISTRY="http://localhost:${PORT}"

WORK_DIR="$(mktemp -d)"
VERDACCIO_STORAGE="${WORK_DIR}/storage"
VERDACCIO_CONFIG="${WORK_DIR}/verdaccio.yaml"
VERDACCIO_LOG="${WORK_DIR}/verdaccio.log"
NPM_CACHE="${WORK_DIR}/npm-cache"
PUBLISH_NPMRC="${WORK_DIR}/publish.npmrc"
CONSUMER_DIR="${WORK_DIR}/consumer"
VERDACCIO_PID=""

cleanup() {
  local code=$?
  if [ -n "${VERDACCIO_PID}" ] && kill -0 "${VERDACCIO_PID}" 2>/dev/null; then
    kill "${VERDACCIO_PID}" 2>/dev/null || true
    wait "${VERDACCIO_PID}" 2>/dev/null || true
  fi
  rm -rf "${WORK_DIR}"
  return "${code}"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "${VERDACCIO_STORAGE}" "${NPM_CACHE}" "${CONSUMER_DIR}"

# verdaccio config: throwaway storage, anonymous publish allowed (auth omitted).
# An uplink to the public registry lets the consumer install resolve our
# package's transitive prod deps (e.g. @modelcontextprotocol/sdk) — we serve our
# own freshly published tree and proxy everything else. The uplink is read-only;
# our package is published locally and served from local storage first, so the
# shrinkwrap pins still come from our tree, not npmjs.
cat > "${VERDACCIO_CONFIG}" <<YAML
storage: ${VERDACCIO_STORAGE}
max_body_size: 200mb
listen: 0.0.0.0:${PORT}
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
    cache: true
    maxage: 30m
packages:
  'llm-cli-gateway':
    access: \$all
    publish: \$all
    unpublish: \$all
  '**':
    access: \$all
    publish: \$all
    unpublish: \$all
    proxy: npmjs
logs:
  type: stdout
  format: pretty
  level: warn
YAML

# Scratch npmrc for publishing: a fake always-true auth token so verdaccio (with
# no real auth backend) accepts the publish without prompting. Scoped to this
# file only via --userconfig; the user's ~/.npmrc is never read or written.
cat > "${PUBLISH_NPMRC}" <<NPMRC
//localhost:${PORT}/:_authToken=fake-anonymous-token
registry=${REGISTRY}
NPMRC

echo "==> starting ephemeral verdaccio on ${REGISTRY}"
npx --yes verdaccio --config "${VERDACCIO_CONFIG}" --listen "${PORT}" \
  > "${VERDACCIO_LOG}" 2>&1 &
VERDACCIO_PID=$!

echo "==> waiting for verdaccio readiness (timeout 180s; first run may download verdaccio)"
READY=0
for _ in $(seq 1 180); do
  if ! kill -0 "${VERDACCIO_PID}" 2>/dev/null; then
    echo "--- verdaccio log ---" >&2
    cat "${VERDACCIO_LOG}" >&2 || true
    fail "verdaccio process exited before becoming ready"
  fi
  if curl -fsS "${REGISTRY}/-/ping" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[ "${READY}" -eq 1 ] || { cat "${VERDACCIO_LOG}" >&2 || true; fail "verdaccio did not become ready within timeout"; }
echo "verdaccio ready."

echo "==> publishing current tree to ${REGISTRY}"
# Publish straight from the repo. --userconfig points npm at the scratch npmrc
# so no real credentials are used; --registry is hardcoded as belt-and-braces.
# Unpublish any prior copy (idempotent re-runs against a fresh registry are a
# no-op; harmless if the version does not exist yet).
npm unpublish "llm-cli-gateway@${EXPECTED_VERSION}" \
  --registry "${REGISTRY}" --userconfig "${PUBLISH_NPMRC}" \
  --force >/dev/null 2>&1 || true
# `if !` exempts the pipeline from set -e; pipefail makes it reflect npm's exit.
if ! npm publish --registry "${REGISTRY}" --userconfig "${PUBLISH_NPMRC}" \
     --cache "${NPM_CACHE}" --no-git-checks 2>&1 | sed 's/^/  /'; then
  fail "npm publish to verdaccio failed"
fi

# FIDELITY PATCH (load-bearing): the public npm registry sets the packument's
# per-version `_hasShrinkwrap` / `dist.hasShrinkwrap` flag at publish time by
# detecting npm-shrinkwrap.json inside the tarball — that flag is what tells a
# consumer's npm (arborist node.hasShrinkwrap, build-ideal-tree.js) to crack the
# tarball open and honour the nested shrinkwrap. verdaccio does NOT compute or
# propagate this flag, so a vanilla verdaccio install IGNORES the shrinkwrap and
# under-reports real-registry behaviour. We set the flag on the stored packument
# to faithfully reproduce what npmjs serves. (Verified on npm 11.12.1: with the
# flag set tar-stream resolves to 3.1.7; without it, 2.2.0.)
echo "==> patching verdaccio packument _hasShrinkwrap (mirror npmjs publish behaviour)"
PACKUMENT_JSON="$(find "${VERDACCIO_STORAGE}" -type f -name package.json -path '*llm-cli-gateway*' | head -1)"
[ -n "${PACKUMENT_JSON}" ] || fail "could not locate verdaccio's stored packument for llm-cli-gateway"
node -e '
const fs = require("fs");
const f = process.argv[1];
const expected = process.argv[2];
const p = JSON.parse(fs.readFileSync(f, "utf8"));
const v = p.versions && p.versions[expected];
if (!v) { console.error("version " + expected + " not in packument"); process.exit(1); }
v._hasShrinkwrap = true;
if (v.dist) v.dist.hasShrinkwrap = true;
fs.writeFileSync(f, JSON.stringify(p, null, 2));
console.log("    set _hasShrinkwrap=true on " + expected);
' "${PACKUMENT_JSON}" "${EXPECTED_VERSION}" || fail "failed to patch packument _hasShrinkwrap"

echo "==> fresh consumer install from ${REGISTRY}"
pushd "${CONSUMER_DIR}" >/dev/null
# Consumer-local .npmrc pins the registry + cache so nothing leaks to the user's
# global config or the public registry.
cat > .npmrc <<NPMRC
registry=${REGISTRY}
cache=${NPM_CACHE}
NPMRC
npm init -y >/dev/null 2>&1
# Install our package by name from the registry. In 2.0.0 the prod graph has no
# install scripts at all (no native module), so this is a pure metadata/extract
# install — assertions (a)/(d) verify the native chain is absent.
if ! npm install "llm-cli-gateway@${EXPECTED_VERSION}" \
     --registry "${REGISTRY}" --cache "${NPM_CACHE}" \
     --no-audit --no-fund 2>&1 | sed 's/^/  /'; then
  fail "consumer npm install from verdaccio failed"
fi

PKG_ROOT="node_modules/llm-cli-gateway"
[ -d "${PKG_ROOT}" ] || fail "installed package dir ${PKG_ROOT} missing"

# --- Assertion (a): no native module / tar chain in the consumer tree --------
# 2.0.0: better-sqlite3 is a devDependency and node:sqlite is built into Node,
# so NONE of better-sqlite3 / tar-stream / prebuild-install may appear anywhere
# in the consumer tree (hoisted to root OR nested under the package). Finding
# ANY of them is a failure — the inverse of the Phase A "pinned 3.1.7" check.
echo "==> assertion (a): no ${FORBIDDEN_IN_CONSUMER[*]} anywhere in the consumer tree"
for forbidden in "${FORBIDDEN_IN_CONSUMER[@]}"; do
  mapfile -t HITS < <(find node_modules -type f -path "*/${forbidden}/package.json" 2>/dev/null)
  if [ "${#HITS[@]}" -gt 0 ]; then
    for pj in "${HITS[@]}"; do echo "    UNEXPECTED: ${pj}" >&2; done
    fail "'${forbidden}' present in consumer tree — the prod graph must be free of the native/tar chain in 2.0.0"
  fi
done
echo "    none present (no native module, no tar chain)."

# --- Assertion (b): no dev-dep markers in the consumer tree ------------------
echo "==> assertion (b): dev deps (vitest, typescript, eslint, prettier) absent"
for devdep in vitest typescript eslint prettier; do
  if find node_modules -type d -name "${devdep}" -print -quit | grep -q .; then
    found="$(find node_modules -type d -name "${devdep}" | head -3 | tr '\n' ' ')"
    fail "dev dependency '${devdep}' present in consumer tree (${found}) — prod-only shrinkwrap leaked dev deps (npm/cli#4323)"
  fi
done
echo "    none present."

# --- Assertion (c): the installed bin prints the expected version ------------
echo "==> assertion (c): ./node_modules/.bin/llm-cli-gateway --version == ${EXPECTED_VERSION}"
[ -x "node_modules/.bin/llm-cli-gateway" ] || fail "consumer bin node_modules/.bin/llm-cli-gateway missing or not executable"
BIN_VERSION="$(./node_modules/.bin/llm-cli-gateway --version 2>&1 | tr -d '[:space:]')"
echo "    reported: ${BIN_VERSION}"
[ "${BIN_VERSION}" = "${EXPECTED_VERSION}" ] \
  || fail "bin --version printed '${BIN_VERSION}', expected '${EXPECTED_VERSION}'"

# --- Assertion (d): consumer `npm ls` exits 0 + node:sqlite runtime smoke -----
# The out-of-range tar-stream pin that caused ELSPROBLEMS is gone, so the
# consumer's dependency tree is internally consistent: `npm ls` must exit 0.
echo "==> assertion (d.1): consumer 'npm ls' exits 0 (no ELSPROBLEMS)"
if ! npm ls --all >/dev/null 2>&1; then
  echo "--- npm ls output ---" >&2
  npm ls --all >&2 || true
  fail "consumer 'npm ls' exited non-zero (dependency tree inconsistent — out-of-range pin or missing dep)"
fi
echo "    npm ls exit 0."

# node:sqlite is what the installed package now uses for persistence. Cheap
# runtime sanity that the consumer's Node has the built-in module and can open
# an in-memory DatabaseSync — the engine the prod artifact relies on.
echo "==> assertion (d.2): node:sqlite runtime available (DatabaseSync opens :memory:)"
node -e "new (require('node:sqlite').DatabaseSync)(':memory:'); console.log('    node:sqlite DatabaseSync OK');" \
  || fail "node:sqlite DatabaseSync unavailable on the running Node — engines floor (>=24.4.0) not met"

# --- Reified-package count (asserted as a range; plan B5) ---------------------
REIFIED_COUNT="$(node -e '
const fs = require("fs");
const lock = JSON.parse(fs.readFileSync("package-lock.json", "utf8"));
console.log(Object.keys(lock.packages ?? {}).length);
' 2>/dev/null || echo "0")"
echo "==> consumer reified packages (incl root): ${REIFIED_COUNT} (observed 94; asserting ${EXPECTED_REIFIED_MIN}-${EXPECTED_REIFIED_MAX})"
if [ "${REIFIED_COUNT}" -lt "${EXPECTED_REIFIED_MIN}" ] || [ "${REIFIED_COUNT}" -gt "${EXPECTED_REIFIED_MAX}" ]; then
  fail "consumer reified package count ${REIFIED_COUNT} outside expected range ${EXPECTED_REIFIED_MIN}-${EXPECTED_REIFIED_MAX} (better-sqlite3 prod subtree should be gone)"
fi

popd >/dev/null

echo "Registry-fidelity verification passed (all assertions green)."
