# PostgreSQL Testing Guide

## Prerequisites

- Docker & Docker Compose
- Node.js 20+

## Quick Start

```bash
# Start test databases, run PG tests, tear down
npm run test:pg

# Or manually:
docker compose -f docker-compose.test.yml up -d
TEST_DATABASE_URL=postgresql://test:test@localhost:5433/llm_gateway_test \
TEST_REDIS_URL=redis://localhost:6380/1 \
PG_TESTS=1 npx vitest --no-file-parallelism src/__tests__/*-pg.test.ts
docker compose -f docker-compose.test.yml down
```

## Test Suites

| Suite | File | Tests | Description |
|-------|------|-------|-------------|
| Session Manager PG | `session-manager-pg.test.ts` | 47 | CRUD, caching, locking, concurrency |
| Migration | `migration-pg.test.ts` | 13 | File-to-PG migration, metadata, errors |

## Running Tests

```bash
# File-based tests only (no Docker needed)
npm test

# PostgreSQL tests only
npm run test:pg

# All tests (file-based + PG)
npm run test:all

# Specific PG test file
npm run test:session-pg
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_DATABASE_URL` | `postgresql://test:test@localhost:5433/llm_gateway_test` | Test PG connection |
| `TEST_REDIS_URL` | `redis://localhost:6380/1` | Test Redis connection |
| `PG_TESTS` | unset | Set to `1` to include PG tests |

## Test Infrastructure

**Containers** (via `docker-compose.test.yml`):
- PostgreSQL 16 on port 5433 (tmpfs for speed)
- Redis 7 on port 6380/db1

**Setup** (`src/__tests__/setup.ts`):
- Advisory-locked schema bootstrap (safe for parallel workers)
- `beforeEach`: DELETE + FLUSHDB for clean state
- `afterAll`: close pool and Redis

## Debugging

```bash
# Verbose test output
DEBUG=1 npm run test:pg

# Connect to test PG
docker compose -f docker-compose.test.yml exec postgres-test \
  psql -U test -d llm_gateway_test

# Connect to test Redis
docker compose -f docker-compose.test.yml exec redis-test redis-cli

# Run single test by name
npx vitest -t "should create a session with auto-generated ID"
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Port conflict on 5433/6380 | `lsof -i :5433` and kill, or change ports in `docker-compose.test.yml` |
| Connection refused | Wait for health checks: `docker compose -f docker-compose.test.yml ps` |
| Stale data | Verify `cleanTestDatabase()` runs in `beforeEach` |
| Tests timing out | Check Docker resources; increase `testTimeout` in `vitest.config.ts` |

## CI (GitHub Actions)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    env:
      POSTGRES_DB: llm_gateway_test
      POSTGRES_USER: test
      POSTGRES_PASSWORD: test
    ports: ["5433:5432"]
    options: --health-cmd pg_isready --health-interval 10s --health-timeout 5s --health-retries 5
  redis:
    image: redis:7-alpine
    ports: ["6380:6379"]
    options: --health-cmd "redis-cli ping" --health-interval 10s --health-timeout 5s --health-retries 5

steps:
  - uses: actions/checkout@v4
  - uses: actions/setup-node@v4
    with: { node-version: "20" }
  - run: npm ci && npm run build
  - run: npm run test:pg
    env:
      TEST_DATABASE_URL: postgresql://test:test@localhost:5433/llm_gateway_test
      TEST_REDIS_URL: redis://localhost:6380/1
```
