# PostgreSQL Testing Guide

## Prerequisites

- Node.js >=24.4.0
- EITHER podman or docker (for the throwaway container), OR a PostgreSQL server
  you already run, reached with `TEST_DATABASE_URL` or `PG_TEST_EXTERNAL=1`.
  Compose is NOT required and NOT used: `scripts/test-pg.sh` calls `run`, `exec`
  and `rm` directly, because `podman compose` needs a provider the CI user does
  not have. CI takes the external path and starts no container at all.

## Quick Start

```bash
# Throwaway container: started, migrated, torn down for you
npm run test:pg

# Against the long-lived CI fixture instead of starting a container
PG_TEST_EXTERNAL=1 npm run test:pg

# A server you already run
TEST_DATABASE_URL=postgresql://test:test@127.0.0.1:5433/llm_gateway_test npm run test:pg
```

`CONTAINER_CLI` selects the runtime when a container IS started; podman is
tried first, then docker. There is no compose file: `docker/test.compose.yml`
was removed because `podman compose` needs a provider the CI user does not
have, which is why these suites ran in no gate at all.

```bash
CONTAINER_CLI=podman npm run test:pg
```

### The DSN is validated before anything destructive runs

`scripts/pg-fixture.mjs` refuses any `TEST_DATABASE_URL` that is not provably
the disposable fixture, because the suites `DELETE FROM` nine tables and the
script issues `DROP DATABASE`, one port away from the operator's live database.
Every identity field is pinned to `FIXTURE` in that file:

| field    | required                                                      |
| -------- | ------------------------------------------------------------- |
| host     | `127.0.0.1` (NOT `localhost`, whose resolution is not pinned) |
| port     | any port except `5432`, and never absent or zero              |
| database | `llm_gateway_test`                                            |
| user     | `test`                                                        |
| password | `test`, never empty                                           |

Query parameters and fragments are refused outright: `pg` reads `?host=` and
`?port=` in preference to the URL authority, so they can redirect a
`DROP DATABASE` past a check that only inspected the authority. The guard hands
downstream a DSN it REBUILDS from the validated fields, never the caller's
string, and `src/__tests__/setup.ts` runs the same guard so a direct
`npx vitest run <file>-pg.test.ts` cannot bypass it.

## Test Suites

Every `src/__tests__/*-pg.test.ts` file, discovered by `scripts/test-pg.sh`
rather than listed anywhere. This table names what each one covers; it
deliberately carries NO test counts, because the two counts it used to carry
were both wrong by round 6 and a number nothing checks goes stale silently.

```bash
# The current counts, from the suites themselves
npm run test:pg
```

| File                                     | Covers                                                     |
| ---------------------------------------- | ---------------------------------------------------------- |
| `session-manager-pg.test.ts`             | CRUD, active-session updates, concurrency                  |
| `migration-pg.test.ts`                   | File-to-PG migration, metadata, errors                     |
| `job-store-pg.test.ts`                   | Async-job persistence, status fences, instance scoping     |
| `flight-recorder-pg.test.ts`             | Request transcripts, the five states, co-resident tables   |
| `schema-parity-pg.test.ts`               | Bootstrap SQL against `migrations/`, gap pinned explicitly |
| `storage-drivers-pg.test.ts`             | The storage port over the PostgreSQL driver                |
| `personal-config-persistence-pg.test.ts` | Kit admission and durable artefacts                        |
| `provider-open-names-pg.test.ts`         | Provider-name projections on PostgreSQL                    |

## Running Tests

```bash
# File-based tests only (no container and no server needed)
npm test

# PostgreSQL tests only
npm run test:pg

# All tests (file-based + PG)
npm run test:all

# Specific PG test file
npm run test:session-pg
```

## Environment Variables

| Variable            | Default                                                  | Description                                                         |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| `CONTAINER_CLI`     | auto-detect (`podman`, then `docker`)                    | Container CLI for the throwaway container. Unused in external mode. |
| `TEST_DATABASE_URL` | `postgresql://test:test@127.0.0.1:5433/llm_gateway_test` | Test PG connection                                                  |
| `PG_TESTS`          | unset                                                    | Set to `1` to include PG tests                                      |
| `PG_TEST_EXTERNAL`  | unset                                                    | `1` uses the long-lived fixture without spelling its DSN out        |
| `PG_TEST_PORT`      | `FIXTURE.port` (5433)                                    | Host port for the throwaway container, to avoid a busy 5433         |
| `PG_TEST_CONTAINER` | `llm-gateway-pg-test`                                    | Name of the throwaway container                                     |
| `PG_TEST_IMAGE`     | `FIXTURE.image`                                          | Image for the throwaway container                                   |

## Test Infrastructure

**Containers** (started by `scripts/test-pg.sh`, no compose file):

- `postgres:17-alpine` on `127.0.0.1:5433`, tmpfs data directory, torn down by
  an EXIT trap. Bound to loopback only. The image and port come from `FIXTURE`
  in `scripts/pg-fixture.mjs`, which is the single place they are declared.

**Setup** (`src/__tests__/setup.ts`):

- Advisory-locked schema bootstrap (safe for parallel workers)
- `beforeEach`: DELETE database rows for clean state
- `afterAll`: close pool

## Debugging

```bash
# Verbose test output
DEBUG=1 npm run test:pg

# Connect to the throwaway test PG (name from PG_TEST_CONTAINER)
podman exec -it llm-gateway-pg-test psql -U test -d llm_gateway_test

# Run single test by name
npx vitest -t "should create a session with auto-generated ID"
```

## Troubleshooting

| Problem               | Fix                                                                                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Port conflict on 5433 | The long-lived CI fixture may hold it. `PG_TEST_EXTERNAL=1 npm run test:pg` to use it, or `PG_TEST_PORT=5434` for a free port. test-pg.sh names this rather than surfacing podman's "Address already in use". |
| Connection refused    | `scripts/pg-fixture.mjs` waits for three consecutive successes and then says whether the fixture is missing, printing the command that recreates it.                                                          |
| DSN refused           | Deliberate. The guard pins host, port, database, user and password; see the table under Quick Start.                                                                                                          |
| Stale data            | Verify `cleanTestDatabase()` runs in `beforeEach`                                                                                                                                                             |
| Tests timing out      | Check container resources; increase `testTimeout` in `vitest.config.ts`                                                                                                                                       |

## CI (GitHub Actions)

The real configuration is the `postgres-tests` job in `.github/workflows/ci.yml`.
It does NOT carry a DSN: it sets a flag and the fixture identity comes from
`FIXTURE`, so changing the port is one edit rather than four.

```yaml
postgres-tests:
  env:
    # A flag, not a DSN. Set only off the public mirror; where it is empty,
    # test-pg.sh starts its own throwaway container instead.
    PG_TEST_EXTERNAL: ${{ github.repository != 'verivus-oss/llm-cli-gateway' && '1' || '' }}
  steps:
    - run: npm run test:pg
      env:
        # Node's tmpdir() is /tmp unless told otherwise, and setup.ts writes the
        # test config, sessions file and logs database through it. On a shared
        # runner /tmp is one small tmpfs used by every unit on the host.
        TMPDIR: ${{ runner.temp }}
        TMP: ${{ runner.temp }}
        TEMP: ${{ runner.temp }}
```

Note the inverted condition: GitHub's `a && b || c` is short-circuit and `''` is
falsy, so `cond && '' || '1'` yields `'1'` on BOTH branches. The truthy branch
has to carry the value.
