#!/usr/bin/env bash
# Build the llm-cli-gateway release artifact set.
#
# Produces, under installer/dist/:
#   - llm-cli-gateway-<version>-<os>-<arch>(.exe) for the requested target(s)
#   - llm-cli-gateway-bundle-<version>-<os>-<arch>.tar.gz (the platform bundle
#     the bootstrapper consumes via `install-bundle`; includes the compiled
#     gateway, production dependencies, and a managed Node runtime)
#   - SHA256SUMS (one line per artifact)
#   - release-manifest.json (machine-readable copy/paste commands)
#
# U13 acceptance gates that this script must satisfy:
#   1. Desktop binaries are built on local OS runners. This script defaults to
#      the current host target; release CI invokes it once per OS runner.
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
#   installer/build-release.sh [--version <ver>] [--skip-bundle] [--skip-binaries] [--target os/arch]
#
# Environment overrides:
#   RVWR_RELEASE_VERSION   release version label (default: package.json version)
#   RVWR_RELEASE_DIR       artifact output dir (default: installer/dist)
#   RVWR_RELEASE_PUBLIC_BASE  optional public download base used to
#                              compose release-manifest.json copy/paste URLs

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ALL_TARGETS=(
  "darwin/arm64"
  "darwin/amd64"
  "linux/amd64"
  "linux/arm64"
  "windows/amd64"
)
TARGETS=()
SKIP_BUNDLE=0
SKIP_BINARIES=0
ALL_TARGETS_REQUESTED=0
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      VERSION="$2"; shift 2;;
    --skip-bundle)
      SKIP_BUNDLE=1; shift;;
    --skip-binaries)
      SKIP_BINARIES=1; shift;;
    --all-targets)
      ALL_TARGETS_REQUESTED=1; shift;;
    --target)
      TARGETS+=("$2"); shift 2;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0;;
    *)
      echo "build-release.sh: unknown arg $1" >&2; exit 2;;
  esac
done

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

if [[ "${SKIP_BINARIES}" -eq 0 && ! -x "$(command -v go)" ]]; then
  echo "build-release.sh: go toolchain not found in PATH" >&2
  exit 2
fi

if [[ ${#TARGETS[@]} -eq 0 && "${SKIP_BINARIES}" -eq 0 ]]; then
  if [[ "${ALL_TARGETS_REQUESTED}" -eq 1 || "${RVWR_RELEASE_ALL_TARGETS:-}" == "1" ]]; then
    TARGETS=("${ALL_TARGETS[@]}")
  else
    TARGETS=("$(go env GOOS)/$(go env GOARCH)")
  fi
fi

mkdir -p "${DIST_DIR}"
rm -f "${DIST_DIR}/SHA256SUMS"

echo "build-release.sh: version=${VERSION}"
echo "build-release.sh: output=${DIST_DIR}"

cd "${REPO_ROOT}"

# 1. Build the Go bootstrapper for each requested target. Release CI calls this
#    from local Linux, Windows, and macOS runners; direct local runs default to
#    the host target instead of silently producing every platform artifact.
if [[ "${SKIP_BINARIES}" -eq 0 ]]; then
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
  done
fi

node_platform_for_goos() {
  case "$1" in
    windows) printf 'win';;
    darwin) printf 'darwin';;
    linux) printf 'linux';;
    *) echo "build-release.sh: unsupported node runtime os $1" >&2; return 2;;
  esac
}

npm_platform_for_goos() {
  case "$1" in
    windows) printf 'win32';;
    darwin) printf 'darwin';;
    linux) printf 'linux';;
    *) echo "build-release.sh: unsupported npm platform $1" >&2; return 2;;
  esac
}

node_arch_for_goarch() {
  case "$1" in
    amd64) printf 'x64';;
    arm64) printf 'arm64';;
    *) echo "build-release.sh: unsupported node runtime arch $1" >&2; return 2;;
  esac
}

download_node_runtime() {
  local target="$1"
  local runtime_dir="$2"
  local goos="${target%/*}"
  local goarch="${target#*/}"
  local node_platform node_arch node_version archive archive_url extracted

  node_platform="$(node_platform_for_goos "${goos}")"
  node_arch="$(node_arch_for_goarch "${goarch}")"
  node_version="${RVWR_NODE_RUNTIME_VERSION:-}"
  if [[ -z "${node_version}" ]]; then
    node_version="$(node -p "process.versions.node")"
  fi

  mkdir -p "${runtime_dir}"
  touch "${runtime_dir}/.llm-cli-gateway-runtime"

  archive="$(mktemp)"
  case "${goos}" in
    windows)
      archive_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-${node_platform}-${node_arch}.zip"
      ;;
    darwin)
      archive_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-${node_platform}-${node_arch}.tar.gz"
      ;;
    linux)
      archive_url="https://nodejs.org/dist/v${node_version}/node-v${node_version}-${node_platform}-${node_arch}.tar.xz"
      ;;
  esac

  echo "build-release.sh: downloading Node runtime ${archive_url}"
  curl -fsSL "${archive_url}" -o "${archive}"

  extracted="$(mktemp -d)"
  case "${goos}" in
    windows)
      if command -v unzip >/dev/null 2>&1; then
        unzip -q "${archive}" -d "${extracted}"
      elif command -v 7z >/dev/null 2>&1; then
        7z x "-o${extracted}" "${archive}" >/dev/null
      else
        powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '${archive}' -DestinationPath '${extracted}' -Force"
      fi
      cp "${extracted}"/node-v"${node_version}"-"${node_platform}"-"${node_arch}"/node.exe "${runtime_dir}/node.exe"
      ;;
    darwin)
      tar -xzf "${archive}" -C "${extracted}"
      cp "${extracted}"/node-v"${node_version}"-"${node_platform}"-"${node_arch}"/bin/node "${runtime_dir}/node"
      chmod 755 "${runtime_dir}/node"
      ;;
    linux)
      tar -xJf "${archive}" -C "${extracted}"
      cp "${extracted}"/node-v"${node_version}"-"${node_platform}"-"${node_arch}"/bin/node "${runtime_dir}/node"
      chmod 755 "${runtime_dir}/node"
      ;;
  esac
  rm -rf "${archive}" "${extracted}"
}

package_platform_bundle() {
  local target="$1"
  local goos="${target%/*}"
  local goarch="${target#*/}"
  local npm_platform node_arch bundle_name bundle_path staging

  if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1; then
    echo "build-release.sh: node and npm are required to package platform bundles" >&2
    exit 2
  fi
  if ! command -v curl >/dev/null 2>&1; then
    echo "build-release.sh: curl is required to download the managed Node runtime" >&2
    exit 2
  fi

  npm_platform="$(npm_platform_for_goos "${goos}")"
  node_arch="$(node_arch_for_goarch "${goarch}")"
  bundle_name="llm-cli-gateway-bundle-${VERSION}-${goos}-${goarch}.tar.gz"
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
    cp package.json "${staging}/gateway/"
    if [[ -f package-lock.json ]]; then
      cp package-lock.json "${staging}/gateway/"
    fi
    (
      cd "${staging}/gateway"
      npm_config_platform="${npm_platform}" npm_config_arch="${node_arch}" npm ci --omit=dev >/dev/null
    )
    cp -R dist "${staging}/gateway/dist"
    cp -R setup "${staging}/gateway/setup"
    if [[ -d .agents ]]; then
      cp -R .agents "${staging}/gateway/.agents"
    fi
  )
  download_node_runtime "${target}" "${staging}/runtime"
  tar -C "${staging}" -czf "${bundle_path}" gateway runtime
  rm -rf "${staging}"
  trap - EXIT
}

# 2. Package platform bundles. Each bundle includes the compiled gateway,
#    production dependencies resolved for the target platform, and a managed
#    Node runtime so users do not have to install Node globally.
if [[ "${SKIP_BUNDLE}" -eq 0 ]]; then
  if [[ ${#TARGETS[@]} -eq 0 ]]; then
    TARGETS=("$(go env GOOS)/$(go env GOARCH)")
  fi
  for target in "${TARGETS[@]}"; do
    package_platform_bundle "${target}"
  done
fi

build_artifacts_payload() {
  local dist_dir="$1"
  local version="$2"
  local first=1
  local payload="["
  local entry name stem suffix os arch

  shopt -s nullglob
  for entry in "${dist_dir}"/llm-cli-gateway-"${version}"-* "${dist_dir}"/llm-cli-gateway-bundle-"${version}"-*.tar.gz; do
    if [[ ! -f "${entry}" ]]; then
      continue
    fi
    name="$(basename "${entry}")"
    if [[ "${first}" -eq 0 ]]; then
      payload+=", "
    fi
    first=0
    if [[ "${name}" == llm-cli-gateway-bundle-"${version}"-*.tar.gz ]]; then
      stem="${name%.tar.gz}"
      suffix="${stem#llm-cli-gateway-bundle-${version}-}"
      os="${suffix%-*}"
      arch="${suffix##*-}"
      payload+="{\"name\":\"${name}\",\"role\":\"platform-bundle\",\"os\":\"${os}\",\"arch\":\"${arch}\"}"
      continue
    fi
    stem="${name%.exe}"
    suffix="${stem#llm-cli-gateway-${version}-}"
    os="${suffix%-*}"
    arch="${suffix##*-}"
    payload+="{\"name\":\"${name}\",\"os\":\"${os}\",\"arch\":\"${arch}\"}"
  done
  shopt -u nullglob
  payload+="]"
  printf '%s' "${payload}"
}

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
  for entry in llm-cli-gateway-"${VERSION}"-* llm-cli-gateway-bundle-"${VERSION}"-*.tar.gz; do
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
artifacts_payload="$(build_artifacts_payload "${DIST_DIR}" "${VERSION}")"

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
    "install_unix_oneliner": "export RVWR_GATEWAY_BUNDLE_URL=${PUBLIC_BASE}/llm-cli-gateway-bundle-${VERSION}-<os>-<arch>.tar.gz RVWR_GATEWAY_BUNDLE_SHA256=<bundle-sha256>; chmod +x ./llm-cli-gateway-${VERSION}-<os>-<arch> && ./llm-cli-gateway-${VERSION}-<os>-<arch> setup && ./llm-cli-gateway-${VERSION}-<os>-<arch> install-bundle",
    "install_windows_powershell": "\$env:RVWR_GATEWAY_BUNDLE_URL='${PUBLIC_BASE}/llm-cli-gateway-bundle-${VERSION}-windows-amd64.tar.gz'; \$env:RVWR_GATEWAY_BUNDLE_SHA256='<bundle-sha256>'; .\\\\llm-cli-gateway-${VERSION}-windows-amd64.exe setup; .\\\\llm-cli-gateway-${VERSION}-windows-amd64.exe install-bundle",
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
