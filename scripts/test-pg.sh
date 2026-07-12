#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker/test.compose.yml"
CONTAINER_CLI="${CONTAINER_CLI:-}"
PG_TEST_FILES=()

container_cli_supports_compose() {
  "$1" compose version >/dev/null 2>&1
}

if [ -n "${CONTAINER_CLI}" ]; then
  if ! command -v "${CONTAINER_CLI}" >/dev/null 2>&1; then
    printf 'CONTAINER_CLI=%q is not available on PATH. Install it or set CONTAINER_CLI to docker or podman.\n' "${CONTAINER_CLI}" >&2
    exit 127
  fi

  if ! container_cli_supports_compose "${CONTAINER_CLI}"; then
    printf 'CONTAINER_CLI=%q does not provide a working compose subcommand. Install its Compose support or choose a compatible CLI.\n' "${CONTAINER_CLI}" >&2
    exit 1
  fi
else
  for candidate in docker podman; do
    if command -v "${candidate}" >/dev/null 2>&1 && container_cli_supports_compose "${candidate}"; then
      CONTAINER_CLI="${candidate}"
      break
    fi
  done

  if [ -z "${CONTAINER_CLI}" ]; then
    printf 'PostgreSQL tests require Docker or Podman with Compose support. Install Docker Compose or Podman Compose, or set CONTAINER_CLI to a compatible CLI.\n' >&2
    exit 127
  fi
fi

cleanup() {
  "${CONTAINER_CLI}" compose -f "${COMPOSE_FILE}" down || true
}

trap cleanup EXIT INT TERM

"${CONTAINER_CLI}" compose -f "${COMPOSE_FILE}" up -d --wait --wait-timeout 120
npm run build
if [ "$#" -gt 0 ]; then
  PG_TEST_FILES=("$@")
else
  mapfile -d '' PG_TEST_FILES < <(find src/__tests__ -type f -name '*-pg.test.ts' -print0 | LC_ALL=C sort -z)
  if [ "${#PG_TEST_FILES[@]}" -eq 0 ]; then
    echo "No PostgreSQL test files found under src/__tests__"
    exit 1
  fi
fi

PG_TESTS=1 npx --no-install vitest run --no-file-parallelism "${PG_TEST_FILES[@]}"
