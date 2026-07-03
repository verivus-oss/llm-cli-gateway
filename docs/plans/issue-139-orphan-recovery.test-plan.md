# Test plan: durable instance-lease orphan recovery (#139)

Companion to `issue-139-orphan-recovery.dag.toml` and `.draft.md` (v4, APPROVED).
Every `[[steps]]` block's `validation` clause references a subset of the cases
below; the `verification-gate` step runs the whole matrix and records results in
`issue-139-orphan-recovery.verification.md`.

## How to run

```
npm run build && npm run lint && npm run format:check
npm run provider:surfaces:check
npm test                    # non-PG suites (memory + sqlite)
npm run test:pg             # PG-backed suites (scripts/test-pg.sh spins up PG)
npm run check               # full gate incl. release-security-audit
```

Conventions: vitest, AAA pattern, complete mocks for fs/child_process isolation,
each test cleans up its own DB/sessions, >=80% coverage. New durable behaviour is
tested on ALL applicable backends: `MemoryJobStore`, `SqliteJobStore`, and
`PostgresJobStore` (the last via `npm run test:pg`; skip-with-notice if PG is
unavailable locally, but it MUST pass in CI). SQLite-backed timing cases use an
injected clock / explicit `lease_deadline` values rather than real sleeps.

## Test taxonomy

- U  Unit / store-level (per backend)
- M  Manager lifecycle
- R  #139 regression (multi-instance)
- E  End-to-end (real provider spawn)
- C  Concurrency / property
- N  Negative / fail-closed

## Case matrix (by design blocker)

### B1 - fencing lease correctness (no live job swept; completion wins)
- U1  `recoverStaleJobs` orphans a `running` job whose `lease_deadline < now`.
      [sqlite, pg]  (step: recover-stale-jobs)
- U2  `recoverStaleJobs` does NOT orphan a job whose `lease_deadline >= now`
      (owner recently heartbeated). [sqlite, pg]
- U3  A legacy row with `lease_deadline IS NULL` IS orphaned (the NULL arm).
      [sqlite, pg]
- U4  A row inserted by `recordStart` has a non-null `lease_deadline` immediately
      (no NULL window for live rows). [memory, sqlite, pg]
- U5  Guarded `recordComplete` lands a terminal status even when the row is
      currently `orphaned` (completion wins); and is a no-op on an already
      terminal row. [memory, sqlite, pg]
- C1  Concurrent heartbeat (advances `lease_deadline`) and sweep on the SAME job
      row: the live job ends `running`, never `orphaned` (row-lock
      serialization). Drive via two interleaved transactions on pg; via ordered
      same-connection writes on sqlite. [pg, sqlite]
- C2  A mistaken orphan followed by a real completion yields a SINGLE terminal
      `completed`; a poller sampling throughout never needs to see a durable
      `orphaned` for a live job. [sqlite, pg]
- U6  Flight-recorder reconcile: a job FR-logged `orphaned` that later completes
      re-emits `logComplete` so the FR row converges to the terminal result.
      [sqlite]

### B2 - transport-aware TTL + advisory pid check + lag skip
- M1  A process-transport job with a live same-host `pid` (kill(pid,0) succeeds)
      is NOT orphaned at `leaseTtl`, but IS orphaned after the extra grace
      (advisory, never vetoing). [injected clock]
- M2  A process job whose `pid` is dead (kill(pid,0) ESRCH) is orphaned at
      `leaseTtl`. [injected clock]
- M3  A reused pid (kill succeeds for an unrelated process) still gets orphaned
      after the extended grace (pid reuse cannot strand the row forever). [mock]
- M4  An http-transport job (pid null) is not orphaned before `httpJobGraceMs`
      even past `leaseTtl`, and is orphaned after it. [injected clock]
- M5  Event-loop-lag skip: when measured hrtime drift > `HEARTBEAT_MS`, the sweep
      cycle is skipped (a blocked owner does not orphan others on a stale view).
      [fake timers]

### B3 - register-before-admit
- M6  `registerInstance` is called (writes `last_heartbeat=now`) before any
      `recordStart` can run; a job inserted after construction always has a live
      instance row. [memory, sqlite]
- M7  An isolateState manager (null store) registers nothing and its `dispose`
      deregisters nothing. [unit]

### B4 - fail-closed admission
- N1  A forced durable `recordStart` failure FAILS the async request (explicit
      error), releases the limiter permit, and leaves NO in-memory-only running
      job. [mock store throwing]
- N2  When `durableAdmission=false` (registration failed), new async requests are
      rejected at the admission gate and the `*_request_async` tools reflect the
      unavailability. [unit]
- N3  Sustained heartbeat failure (N consecutive) stops admission and stops
      sweeping (does not orphan on stale self-knowledge). [mock]
- N4  A forced durable `markRunning` failure at launch fails CLOSED: the launch
      is aborted (no untracked running child left against a stale durable
      `queued` row); the permit is released / the job is terminalized. Confirms
      `markRunning` is NOT best-effort. [mock store throwing]

### B5 - durable queued model
- U7  `recordStart` persists `status='queued'` with `owner_instance` and an
      initial `lease_deadline`. [memory, sqlite, pg]
- U8  `markRunning(id,{pid})` transitions `queued -> running` and stamps a
      non-null pid for process transport. [memory, sqlite, pg]
- U9  `recoverStaleJobs` targets `queued` too: a stale queued job (crash between
      enqueue and launch) is orphaned. [sqlite, pg]
- M8  Hydration: a durable `queued` row rehydrates with `exited=false`
      (regression against `exited = status !== 'running'`). [unit]
- U10 `recordComplete.status` type rejects `queued`/`running` at compile time
      (type-level; assert via a tsc-checked fixture or a runtime guard test).
- U11 Dedup: `findByRequestKey` treats a live (lease-valid) `queued` job as
      dedup-eligible and never dedups onto an `orphaned` row. [sqlite, pg]

### B6 - dispose / shutdown ordering
- M9  `dispose()` clears all timers (heartbeat/sweep/eviction/stall). [unit]
- M10 `dispose()` kills active owned jobs, awaits the terminal writes their close
      handlers enqueue (drain AFTER the kills), then deregisters. [unit]
- M11 A SIGTERM during an in-flight terminal write does not `process.exit` before
      the write lands (no stranded `running` row). [integration, mocked exit]
- M12 Drain timeout: if the bounded drain times out, `dispose` SKIPS deregister
      (lets the lease expire) rather than orphaning a job mid-finalize. [unit]

### B7 - parity / config / sqlite specifics
- U12 Cross-backend parity: `registerInstance`/`heartbeat`/`deregisterInstance`/
      `markRunning`/`recoverStaleJobs` behave identically (per their contract)
      across memory (no-ops where documented), sqlite, and pg. [matrix]
- U13 DDL idempotency: `owner_instance` + `lease_deadline` columns, the
      `gateway_instances` table, and indexes are created on a fresh DB and are
      no-ops on a legacy DB (both sqlite ctor and pg worker init). [sqlite, pg]
- U14 `withTransaction` forwards the callback return value; existing void callers
      are unaffected. [sqlite-driver unit]
- U15 Config: the new knobs default correctly; Zod rejects `leaseTtl <
      2*heartbeat` and `httpJobGrace < leaseTtl`; `ownsOrphanRecovery` still
      parses and emits the deprecation warning. [persistence-config]
- U16 `PRAGMA busy_timeout` is set and a `SQLITE_BUSY` retry path is exercised
      for the shared-file case. [sqlite]
- U17 The lease/sweep timing uses the per-backend DB clock (Postgres `now()`,
      sqlite `strftime`), NOT client `new Date()`: with the client clock
      deliberately offset from the DB clock, expired/fresh classification is
      still correct. The test FAILS if the implementation reads the client clock.
      [sqlite, pg]
- U18 The http grace is enforced in CANDIDATE SELECTION (no row is written
      `orphaned` then un-orphaned): an http job past `leaseTtl` but within
      `httpJobGrace` is observed `running` at every sample, never transiently
      `orphaned`. [sqlite, pg]

## Scenario / regression / E2E

- R2  The #139 multi-instance regression (PG): instance A starts a `running` job
      and keeps heartbeating; construct instance B (fresh AsyncJobManager) and let
      its startup recovery run; assert A's job is STILL `running`. Then stop A's
      heartbeat (or `dispose` A) and assert the next sweep orphans A's job.
      [test:pg]
- R3  markOrphanedOnStartup deprecated shim: on the single-owner sqlite/memory
      path it still recovers a genuinely stale prior-process job (no regression to
      single-instance recovery). [sqlite, memory]
- E1  Nested-agent E2E (the scenario that surfaced the bug): an async job whose
      provider spawns a nested Claude Code with `gtwy` as an MCP server (its own
      gateway construction) does NOT orphan the parent job; poll the parent status
      throughout and assert it is never spuriously `orphaned`; the parent
      completes normally. [manual/integration, PG backend]
- C3  Concurrent double-sweep (two instances sweep at once) is idempotent: a
      single `orphaned` row, no double FR logComplete side effects beyond the
      reconcile contract. [pg]

## Regression guard (existing behaviour)

- The full existing suite (2247+ cases) stays green.
- The interim-gate tests from PR #140 continue to pass until the
  `ownsOrphanRecovery` deprecation step; after deprecation, update them to assert
  the parse-and-warn behaviour rather than gating.
- `npm run check` (build + lint + format:check + provider:surfaces:check + test +
  release-security-audit) passes; `node:sqlite` remains referenced only in
  `src/sqlite-driver.ts`.

## Known non-goals (documented, not tested as failures)

- Signed / hash-chained recovery records: out of scope.
- Cross-host `kill(pid,0)`: intentionally unsupported; foreign-hostname process
  rows fall through to the pure lease decision (covered implicitly by M4-style
  http handling; add a foreign-hostname case if a cross-host CI exists).
- Perfect elimination of a genuinely-stale-then-reviving owner's transient
  orphaned state: by design it self-heals (C2/U5/U6) rather than never occurring.
