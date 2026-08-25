#!/usr/bin/env bash
#
# The PostgreSQL suites, against a REAL server in a throwaway container.
#
# This used to drive `<cli> compose -f docker/test.compose.yml`, which meant the
# suite could not run in CI at all: the self-hosted runner has podman and no
# docker, and `podman compose` needs a compose provider the `runners` user does
# not have (`looking up compose provider failed`, exit 125). The suite was
# therefore in no gate, and stayed red on master for two days across three
# separate defects because nothing ran it.
#
# The compose file described ONE service. A plain `run` expresses all of it and
# needs no provider, so developers and CI now take the same path rather than two
# that can drift apart.
set -euo pipefail

CONTAINER_NAME="${PG_TEST_CONTAINER:-llm-gateway-pg-test}"
HOST_PORT="${PG_TEST_PORT:-5433}"
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
READY_TIMEOUT_SECONDS="${PG_TEST_READY_TIMEOUT:-120}"
CONTAINER_CLI="${CONTAINER_CLI:-}"

if [ -n "${CONTAINER_CLI}" ]; then
  if ! command -v "${CONTAINER_CLI}" >/dev/null 2>&1; then
    printf 'CONTAINER_CLI=%q is not available on PATH. Install it or set CONTAINER_CLI to docker or podman.\n' "${CONTAINER_CLI}" >&2
    exit 127
  fi
else
  for candidate in podman docker; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      CONTAINER_CLI="${candidate}"
      break
    fi
  done

  if [ -z "${CONTAINER_CLI}" ]; then
    printf 'PostgreSQL tests require podman or docker on PATH. Neither was found.\n' >&2
    exit 127
  fi
fi

cleanup() {
  "${CONTAINER_CLI}" rm -f "${CONTAINER_NAME}" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# A container left behind by an aborted run holds the port and would otherwise
# be reported as "port already allocated", which names the symptom not the cause.
cleanup

"${CONTAINER_CLI}" run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_DB=llm_gateway_test \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -p "${HOST_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data \
  "${IMAGE}" >/dev/null

# THREE CONSECUTIVE successes, not one. The postgres entrypoint starts a local
# server to run initdb and restarts it before listening for real, so a single
# `pg_isready` can pass against the server that is about to go away and the
# first test then connects to a closed port.
consecutive=0
for _ in $(seq 1 "${READY_TIMEOUT_SECONDS}"); do
  if "${CONTAINER_CLI}" exec "${CONTAINER_NAME}" pg_isready -U test -q >/dev/null 2>&1; then
    consecutive=$((consecutive + 1))
    if [ "${consecutive}" -ge 3 ]; then
      break
    fi
  else
    consecutive=0
  fi
  sleep 1
done

if [ "${consecutive}" -lt 3 ]; then
  printf 'PostgreSQL did not become ready within %ss. Container logs:\n' "${READY_TIMEOUT_SECONDS}" >&2
  "${CONTAINER_CLI}" logs "${CONTAINER_NAME}" >&2 || true
  exit 1
fi

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
