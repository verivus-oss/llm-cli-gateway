#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="docker-compose.test.yml"
PG_TEST_FILES=()

cleanup() {
  docker compose -f "${COMPOSE_FILE}" down || true
}

trap cleanup EXIT INT TERM

docker compose -f "${COMPOSE_FILE}" up -d --wait --wait-timeout 120
if [ "$#" -gt 0 ]; then
  PG_TEST_FILES=("$@")
else
  mapfile -d '' PG_TEST_FILES < <(find src/__tests__ -type f -name '*-pg.test.ts' -print0 | LC_ALL=C sort -z)
  if [ "${#PG_TEST_FILES[@]}" -eq 0 ]; then
    echo "No PostgreSQL test files found under src/__tests__"
    exit 1
  fi
fi

PG_TESTS=1 vitest run --no-file-parallelism "${PG_TEST_FILES[@]}"
