#!/usr/bin/env bash
# Build the llm-cli-gateway release artifact set.
#
# Produces, under installer/dist/:
#   - llm-cli-gateway-<version>-<os>-<arch>(.exe) per target
#   - llm-cli-gateway-bundle-<version>.tar.gz (the Node gateway bundle the
#     bootstrapper consumes via `install-bundle`)
#   - SHA256SUMS (one line per artifact)
#   - release-manifest.json (machine-readable copy/paste commands)
#
# U13 acceptance gates that this script must satisfy:
#   1. Cross-platform binaries for macOS arm64+amd64, Linux amd64+arm64,
#      Windows amd64.
#   2. Checksum verification: every artifact gets a SHA256 line in SHA256SUMS.
#   3. Docker Compose remains a fallback (see docker-compose.personal.yml).
#   4. Artifacts include copy/paste commands suitable for target-LLM setup
#      prompts (release-manifest.json's `setup_commands`).
#
# Constraints (U13):
#   - Release packages must be verifiable before execution.
#   - Do not require npm/git/Docker for the happy-path install.
#   - Never embed user secrets in artifacts; the auth token is generated
#     locally by `bootstrapper setup`.
#
# Usage:
#   installer/build-release.sh [--version <ver>] [--skip-bundle] [--target os/arch]
#
# Environment overrides:
#   RVWR_RELEASE_VERSION   release version label (default: package.json version)
#   RVWR_RELEASE_DIR       artifact output dir (default: installer/dist)
#   RVWR_RELEASE_PUBLIC_BASE  optional public download base used to
#                              compose release-manifest.json copy/paste URLs

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_TARGETS=(
  "darwin/arm64"
  "darwin/amd64"
  "linux/amd64"
  "linux/arm64"
  "windows/amd64"
)
TARGETS=()
SKIP_BUNDLE=0
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"; shift 2;;
    --skip-bundle)
      SKIP_BUNDLE=1; shift;;
    --target)
      TARGETS+=("$2"); shift 2;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0;;
    *)
      echo "build-release.sh: unknown arg $1" >&2; exit 2;;
  esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=("${DEFAULT_TARGETS[@]}")
fi

if [[ -z "${VERSION}" ]]; then
  VERSION="${RVWR_RELEASE_VERSION:-}"
fi
if [[ -z "${VERSION}" ]]; then
  if command -v node >/dev/null 2>&1; then
    VERSION="$(node -e "console.log(require('./package.json').version)" 2>/dev/null || true)"
  fi
fi
if [[ -z "${VERSION}" ]]; then
  echo "build-release.sh: cannot determine version (pass --version or set RVWR_RELEASE_VERSION)" >&2
  exit 2
fi

DIST_DIR="${RVWR_RELEASE_DIR:-${REPO_ROOT}/installer/dist}"
PUBLIC_BASE="${RVWR_RELEASE_PUBLIC_BASE:-}"

if [[ ! -x "$(command -v go)" ]]; then
  echo "build-release.sh: go toolchain not found in PATH" >&2
  exit 2
fi

mkdir -p "${DIST_DIR}"
rm -f "${DIST_DIR}/SHA256SUMS"

echo "build-release.sh: version=${VERSION}"
echo "build-release.sh: output=${DIST_DIR}"

ARTIFACTS_JSON=""

cd "${REPO_ROOT}"

# 1. Cross-compile the Go bootstrapper for each target.
for target in "${TARGETS[@]}"; do
  GOOS="${target%/*}"
  GOARCH="${target#*/}"
  ext=""
  if [[ "${GOOS}" == "windows" ]]; then
    ext=".exe"
  fi
  bin_name="llm-cli-gateway-${VERSION}-${GOOS}-${GOARCH}${ext}"
  out="${DIST_DIR}/${bin_name}"
  echo "build-release.sh: building ${bin_name}"
  (
    cd installer
    CGO_ENABLED=0 GOOS="${GOOS}" GOARCH="${GOARCH}" \
      go build -trimpath -ldflags "-s -w -X main.releaseVersion=${VERSION}" \
        -o "${out}" .
  )
  ARTIFACTS_JSON+="{\"name\":\"${bin_name}\",\"os\":\"${GOOS}\",\"arch\":\"${GOARCH}\"}, "
done

# 2. Package the Node gateway bundle the bootstrapper installs via
#    `install-bundle`. The bundle ships the compiled dist/, package.json,
#    package-lock.json, and the runtime-required setup/status.schema.json
#    so node_modules can be reproduced locally without git.
if [[ "${SKIP_BUNDLE}" -eq 0 ]]; then
  bundle_name="llm-cli-gateway-bundle-${VERSION}.tar.gz"
  bundle_path="${DIST_DIR}/${bundle_name}"
  staging="$(mktemp -d)"
  trap 'rm -rf "${staging}"' EXIT
  echo "build-release.sh: producing ${bundle_name}"
  (
    cd "${REPO_ROOT}"
    if [[ ! -d dist ]] || [[ ! -f dist/index.js ]]; then
      npm run build >/dev/null
    fi
    mkdir -p "${staging}/gateway"
    cp -R dist "${staging}/gateway/dist"
    cp package.json "${staging}/gateway/"
    if [[ -f package-lock.json ]]; then
      cp package-lock.json "${staging}/gateway/"
    fi
    mkdir -p "${staging}/gateway/setup"
    cp setup/status.schema.json "${staging}/gateway/setup/"
  )
  tar -C "${staging}" -czf "${bundle_path}" gateway
  ARTIFACTS_JSON+="{\"name\":\"${bundle_name}\",\"role\":\"node-bundle\"}, "
  rm -rf "${staging}"
  trap - EXIT
fi

# 3. Checksums. Use shasum on macOS, sha256sum on Linux.
if command -v sha256sum >/dev/null 2>&1; then
  SUM_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SUM_CMD=(shasum -a 256)
else
  echo "build-release.sh: no sha256 tool found (need sha256sum or shasum)" >&2
  exit 2
fi

(
  cd "${DIST_DIR}"
  files=()
  for entry in llm-cli-gateway-*; do
    if [[ -f "${entry}" ]]; then
      files+=("${entry}")
    fi
  done
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "build-release.sh: nothing to checksum in ${DIST_DIR}" >&2
    exit 2
  fi
  "${SUM_CMD[@]}" "${files[@]}" > SHA256SUMS
)

# 4. Release manifest with copy/paste commands suitable for assistant
#    prompts. Tokens, URLs, and provider credentials are NEVER embedded.
manifest="${DIST_DIR}/release-manifest.json"
artifacts_payload="[${ARTIFACTS_JSON%, }]"

cat > "${manifest}" <<EOF
{
  "schema_version": "release-manifest.v1",
  "version": "${VERSION}",
  "checksums_file": "SHA256SUMS",
  "public_base": "${PUBLIC_BASE}",
  "artifacts": ${artifacts_payload},
  "setup_commands": {
    "verify_checksum_linux": "sha256sum --check SHA256SUMS",
    "verify_checksum_macos": "shasum -a 256 --check SHA256SUMS",
    "install_unix_oneliner": "chmod +x ./llm-cli-gateway-${VERSION}-<os>-<arch> && ./llm-cli-gateway-${VERSION}-<os>-<arch> setup",
    "doctor_after_install": "./llm-cli-gateway-${VERSION}-<os>-<arch> doctor",
    "upgrade_unix_oneliner": "./llm-cli-gateway-<new-version>-<os>-<arch> upgrade",
    "uninstall_unix_oneliner": "./llm-cli-gateway-<version>-<os>-<arch> uninstall --yes",
    "docker_fallback": "docker compose -f docker-compose.personal.yml up -d",
    "docker_doctor": "docker compose -f docker-compose.personal.yml run --rm gateway node dist/index.js doctor --json"
  },
  "notes": [
    "All artifacts must be verified against SHA256SUMS before execution.",
    "Auth tokens are generated locally by 'setup'; never paste tokens into chat.",
    "Docker compose is the explicit fallback path; the single binary is primary."
  ]
}
EOF

echo "build-release.sh: wrote ${manifest}"
echo "build-release.sh: wrote ${DIST_DIR}/SHA256SUMS"
echo "build-release.sh: done."
