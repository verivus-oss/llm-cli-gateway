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
# than the inlined bootstrap SQL in setup.ts.
#
# It costs something, and the cost is paid elsewhere. Once migrations have built
# every table, setup.ts's CREATE TABLE IF NOT EXISTS and ADD COLUMN IF NOT
# EXISTS can no longer fail, so a column present in setup.ts but MISSING from
# migrations/ would be silently reconciled. `schema-parity-pg.test.ts` is the
# gate for that: it builds both schemas in isolation and compares them. An
# earlier comment here claimed the two were column-for-column identical; that
# was measured after the suites had run, and PostgresJobStore.init() repairs the
# bootstrap schema on startup, so it measured the repair. Bootstrap is a strict
# SUBSET of migrations. The parity test asserts the gap is exactly the columns
# the job store adds itself.
set -euo pipefail

# The fixture's identity is declared once, in FIXTURE in scripts/pg-fixture.mjs.
# Asking for it here rather than repeating it means changing the port is one
# edit, not four with nothing catching a miss.
#
# NOT `eval "$(node ...)"`. `set -e` sees eval's own status, not the command
# substitution's, so a node that printed some assignments and THEN failed left
# those assignments in place and the script carried on; with the names already
# inherited from the environment it carried on with STALE values, and any
# unexpected stdout was executed as shell code before anything validated it.
# Capture, check the status, check the SHAPE, then evaluate.
# UNSET FIRST. Round 5 found the `:?` guards below prove nothing on their own:
# if the producer omits a name but the shell already inherited it, the stale
# value survives and every check passes. Clearing them means the guards test the
# producer's output rather than the ambient environment.
unset FIXTURE_HOST FIXTURE_PORT FIXTURE_DB FIXTURE_USER FIXTURE_PASSWORD FIXTURE_IMAGE FIXTURE_DSN

fixture_env="$(node scripts/pg-fixture.mjs --print-env)" || {
  echo "FATAL: could not read the fixture definition from scripts/pg-fixture.mjs" >&2
  exit 1
}
if [ -z "${fixture_env}" ]; then
  echo "FATAL: scripts/pg-fixture.mjs --print-env produced no output" >&2
  exit 1
fi
# Only FIXTURE_<NAME>='...' lines reach eval. A stray warning or an injected
# command is refused rather than executed.
if printf '%s\n' "${fixture_env}" | grep -qvE "^FIXTURE_[A-Z_]+='([^']|'\\\\'')*'$"; then
  echo "FATAL: unexpected output from --print-env; refusing to evaluate it:" >&2
  printf '%s\n' "${fixture_env}" >&2
  exit 1
fi
# EXACTLY the expected names, once each. A syntactically valid but unexpected
# name, or a duplicate that silently overrides the canonical value, is refused:
# shape alone does not make output correct.
fixture_names="$(printf '%s\n' "${fixture_env}" | sed "s/=.*//" | LC_ALL=C sort)"
fixture_expected="$(printf '%s\n' FIXTURE_DB FIXTURE_DSN FIXTURE_HOST FIXTURE_IMAGE \
  FIXTURE_PASSWORD FIXTURE_PORT FIXTURE_USER | LC_ALL=C sort)"
if [ "${fixture_names}" != "${fixture_expected}" ]; then
  echo "FATAL: --print-env did not emit exactly the expected assignments." >&2
  echo "got:" >&2
  printf '%s\n' "${fixture_names}" >&2
  echo "expected:" >&2
  printf '%s\n' "${fixture_expected}" >&2
  exit 1
fi
eval "${fixture_env}"
: "${FIXTURE_PORT:?fixture port missing}" "${FIXTURE_DB:?fixture database missing}"
: "${FIXTURE_USER:?fixture user missing}" "${FIXTURE_PASSWORD:?fixture password missing}"
: "${FIXTURE_IMAGE:?fixture image missing}" "${FIXTURE_DSN:?fixture dsn missing}"

CONTAINER_NAME="${PG_TEST_CONTAINER:-llm-gateway-pg-test}"
HOST_PORT="${PG_TEST_PORT:-$FIXTURE_PORT}"
IMAGE="${PG_TEST_IMAGE:-$FIXTURE_IMAGE}"
READY_TIMEOUT_SECONDS="${PG_TEST_READY_TIMEOUT:-120}"
CONTAINER_CLI="${CONTAINER_CLI:-}"
EXTERNAL_DSN="${TEST_DATABASE_URL:-}"
# PG_TEST_EXTERNAL=1 means "use the long-lived fixture" without the caller
# having to spell its DSN out. That keeps ci.yml free of a copy of the fixture
# identity, which was one of the four places a port change had to be edited.
if [ -z "${EXTERNAL_DSN}" ] && [ "${PG_TEST_EXTERNAL:-}" = "1" ]; then
  EXTERNAL_DSN="${FIXTURE_DSN}"
fi

# Prove the target is a disposable fixture, wait for it, reset it, then put the
# canonical schema on it. pg-fixture.mjs refuses anything not provably a
# fixture, which is what stands between a transposed port and the operator's
# live database on the neighbouring one.
#
# It prints ONE line on stdout: the DSN rebuilt from the fields it validated.
# Everything downstream uses THAT and never the caller's string, because pg
# honours `?host=`/`?port=` query parameters over the URL authority, so
# forwarding the original would hand the dangerous operations a target the
# guard never inspected. EXTERNAL_DSN is reassigned here for the same reason.
prepare_fixture() {
  EXTERNAL_DSN="$(node scripts/pg-fixture.mjs "$1")"
  DATABASE_URL="${EXTERNAL_DSN}" node dist/migrate.js
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

# EXTERNAL MODE, deliberately BEFORE any container-CLI discovery. On the CI
# runner podman is on PATH but cannot run, so probing for one here would turn a
# correctly configured job into a confusing failure about compose providers.
if [ -n "${EXTERNAL_DSN}" ]; then
  # Deliberately NOT echoing the DSN here. The old redactor used [^@/]* which
  # stops at a slash, so a password containing one printed intact, and it ran
  # BEFORE validation. pg-fixture.mjs prints host:port/database on stderr after
  # it has proved them, which is the only form worth showing.
  echo 'Using an external PostgreSQL server (no container will be started).'
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

# A LONG-LIVED fixture on this port is the far more likely holder, and podman's
# own message ("pasta failed ... Address already in use") names neither the
# cause nor the remedy. On a host that runs the CI fixture, container mode
# cannot bind at all, so say which of the two ways forward the caller wants.
if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q "127.0.0.1:${HOST_PORT} "; then
  printf 'Port %s on 127.0.0.1 is already served, most likely the long-lived CI fixture.\n' "${HOST_PORT}" >&2
  printf 'Either use it:      PG_TEST_EXTERNAL=1 %s\n' "$0" >&2
  printf 'or pick a free port: PG_TEST_PORT=5434 %s\n' "$0" >&2
  exit 1
fi

# Bound to 127.0.0.1 rather than every interface. A test database carrying
# fixture credentials should not be reachable from the network.
"${CONTAINER_CLI}" run -d \
  --name "${CONTAINER_NAME}" \
  -e POSTGRES_DB="${FIXTURE_DB}" \
  -e POSTGRES_USER="${FIXTURE_USER}" \
  -e POSTGRES_PASSWORD="${FIXTURE_PASSWORD}" \
  -p "127.0.0.1:${HOST_PORT}:5432" \
  --tmpfs /var/lib/postgresql/data \
  "${IMAGE}" >/dev/null

# THREE CONSECUTIVE successes, not one. The postgres entrypoint starts a local
# server to run initdb and restarts it before listening for real, so a single
# `pg_isready` can pass against the server that is about to go away and the
# first test then connects to a closed port.
consecutive=0
for _ in $(seq 1 "${READY_TIMEOUT_SECONDS}"); do
  if "${CONTAINER_CLI}" exec "${CONTAINER_NAME}" pg_isready -U "${FIXTURE_USER}" -q >/dev/null 2>&1; then
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
# Default port: the canonical fixture DSN. Overridden port: rebuild it, still
# from the fixture's own user/password/database rather than fresh literals.
if [ "${HOST_PORT}" = "${FIXTURE_PORT}" ]; then
  EXTERNAL_DSN="${FIXTURE_DSN}"
else
  EXTERNAL_DSN="postgresql://${FIXTURE_USER}:${FIXTURE_PASSWORD}@127.0.0.1:${HOST_PORT}/${FIXTURE_DB}"
fi
prepare_fixture "${EXTERNAL_DSN}"
run_suites "$@"
