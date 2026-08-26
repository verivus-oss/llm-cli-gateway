#!/usr/bin/env bash
#
# The PostgreSQL suites, against a REAL server.
#
# This used to drive `<cli> compose -f docker/test.compose.yml`, which meant the
# suite could not run in CI at all: the self-hosted runner has podman and no
# docker, and `podman compose` needs a compose provider the `runners` user does
# not have (`looking up compose provider failed`, exit 125). The suite was
# therefore in no gate, and stayed red on master for two days across three
# separate defects because nothing ran it.
#
# TWO MODES, ONE PATH. With TEST_DATABASE_URL set the script talks to a server
# somebody else runs and never invokes a container CLI at all. Without it, it
# starts a throwaway container as before. CI takes the first, because the runner
# unit forbids user namespaces and so cannot run podman; developers take the
# second. Everything after "a server exists" is shared, so the two modes cannot
# drift in what they actually test.
#
# BOTH modes reset the fixture and apply migrations/ before vitest.
#
# Resetting is what makes a LONG-LIVED server behave like a throwaway one:
# `cleanTestDatabase` deletes rows and never tables, so without a reset a schema
# change would leave the previous shape in place and the suites would run
# against it.
#
# Applying migrations is what makes the tested schema the CANONICAL one rather
# than the inlined bootstrap SQL in setup.ts. Measured: bootstrap alone produces
# 9 tables and 86 columns, migrations produce 13 and 144, and the 9 shared
# tables are column-for-column identical. So this costs nothing today. It is
# here to stop that agreement from being a coincidence nothing enforces.
set -euo pipefail

CONTAINER_NAME="${PG_TEST_CONTAINER:-llm-gateway-pg-test}"
HOST_PORT="${PG_TEST_PORT:-5433}"
IMAGE="${PG_TEST_IMAGE:-postgres:17-alpine}"
READY_TIMEOUT_SECONDS="${PG_TEST_READY_TIMEOUT:-120}"
CONTAINER_CLI="${CONTAINER_CLI:-}"
EXTERNAL_DSN="${TEST_DATABASE_URL:-}"

# Prove the target is a disposable fixture, wait for it, reset it, then put the
# canonical schema on it. pg-fixture.mjs refuses anything not provably a
# fixture, which is what stands between a transposed port and the operator's
# live database on the neighbouring one.
prepare_fixture() {
  node scripts/pg-fixture.mjs "$1"
  DATABASE_URL="$1" node dist/migrate.js
}

run_suites() {
  local files=()
  if [ "$#" -gt 0 ]; then
    files=("$@")
  else
    mapfile -d '' files < <(find src/__tests__ -type f -name '*-pg.test.ts' -print0 | LC_ALL=C sort -z)
    if [ "${#files[@]}" -eq 0 ]; then
      echo "No PostgreSQL test files found under src/__tests__" >&2
      exit 1
    fi
  fi
  TEST_DATABASE_URL="${EXTERNAL_DSN}" PG_TESTS=1 \
    npx --no-install vitest run --no-file-parallelism "${files[@]}"
}

# Never echo a DSN as given: it carries the fixture password.
redact_dsn() {
  printf '%s' "$1" | sed -E 's#://[^@/]*@#://***@#'
}

# EXTERNAL MODE, deliberately BEFORE any container-CLI discovery. On the CI
# runner podman is on PATH but cannot run, so probing for one here would turn a
# correctly configured job into a confusing failure about compose providers.
if [ -n "${EXTERNAL_DSN}" ]; then
  printf 'Using the PostgreSQL server at %s (no container will be started).\n' \
    "$(redact_dsn "${EXTERNAL_DSN}")"
  npm run build
  prepare_fixture "${EXTERNAL_DSN}"
  run_suites "$@"
  exit $?
fi

# CONTAINER MODE from here down.
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
    printf 'Alternatively set TEST_DATABASE_URL to a PostgreSQL server you already run.\n' >&2
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

# Bound to 127.0.0.1 rather than every interface. A test database carrying
# fixture credentials should not be reachable from the network.
"${CONTAINER_CLI}" run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_DB=llm_gateway_test \
  -e POSTGRES_USER=test \
  -e POSTGRES_PASSWORD=test \
  -p "127.0.0.1:${HOST_PORT}:5432" \
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
EXTERNAL_DSN="postgresql://test:test@127.0.0.1:${HOST_PORT}/llm_gateway_test"
prepare_fixture "${EXTERNAL_DSN}"
run_suites "$@"
