# Design v4: Fix #139, durable instance-lease orphan recovery for the async job store

Status: APPROVED (v4). Cross-LLM design gate converged over 4 rounds
(v1 -> v4); v4 has UNANIMOUS unconditional approval from Codex, Grok, and
Mistral, all on inspected evidence against the real 9602037 tree. Ready to
implement. The layered "(vN header retained below)" sections are provenance; the
current design is sections 2-11 with the v4 refinements 5a-5d, 6/6a-6c, and 7.

Convergence trail: r1 = 7 blockers -> v2; r2 = 6 blockers (RC race, http/pid
liveness, fail-closed, durable queued, async shutdown, parity) -> v3; r3 = 1
substantive (B1 cross-table race) + 3 refinements -> v4 (per-job `lease_deadline`
fencing so heartbeat and sweep serialize on the same job row); r4 = unanimous
approval.

Status: DRAFT for review (revised after review round 3)

## v4 changes (review round 3)

Round 3: Grok closed B2/B4/B5/B6/B7 and left ONLY B1; Codex closed B2/B5 and
left B1 plus three small refinements (B4 limiter-permit, B6 active-jobs, B7
type/hydration). (Mistral re-scoped to "code not yet written" and is set aside;
its own round-3 answers endorse the design.) v4 closes the last items:

- **B1, the real fix: a per-job fencing lease, not a cross-table read.** Round 3
  nailed it: locking a `jobs` row does NOT serialize against a heartbeat that
  writes the *different* `gateway_instances` table, so a TOCTOU remained. v4
  moves the authoritative liveness signal ONTO the job row: `jobs.lease_deadline`.
  The owner advances it on every heartbeat with
  `UPDATE jobs SET lease_deadline = <db-now> + leaseTtl WHERE owner_instance = me
  AND status IN ('queued','running')`; the sweep orphans with
  `UPDATE jobs SET status='orphaned' WHERE status IN ('queued','running') AND
  lease_deadline < <db-now>`. Now heartbeat and sweep contend on the SAME job
  rows, so they serialize on the row lock in Postgres (and are trivially
  serialized under single-writer SQLite). No cross-table race, no advisory lock
  required, and the mechanism is identical across backends. See section 6a.
- **B4**: durable `recordStart` failure also releases the limiter permit / removes
  the queued entry so the job can never later launch (section 5b).
- **B6**: `dispose()` stops admission, then abort/await ACTIVE owned jobs and the
  terminal writes their close handlers produce (including those from
  `killAllProcessGroups`), and deregisters ONLY when no active owned work remains
  (section 5d).
- **B7**: `recordComplete.status` becomes `Exclude<JobStoreStatus,"running"|
  "queued">` (`src/job-store.ts:169`) and hydration sets `exited` false for a
  `queued` row (`src/async-job-manager.ts:1515`) (section 7).

**Guarantee (v4).** No job whose owner advanced its `lease_deadline` within
`leaseTtl` is ever swept: heartbeat and sweep are the same-row UPDATEs, so a
heartbeat that commits first makes the sweep's `WHERE lease_deadline < now` miss,
and a sweep that commits first is not re-touched by the heartbeat (its
`WHERE status IN ('queued','running')` skips the now-`orphaned` row). The only
residual is a genuinely stale owner (missed >= `leaseTtl`) that revives and
finishes; that self-heals to `completed` via the guarded `recordComplete` (6b)
and the flight-recorder reconcile (6c).

`gateway_instances` is retained for observability / GC / `role`, but the sweep
predicate no longer depends on reading it (that dependency was the B1 hole).

---

## (v3 header retained below)

Status: DRAFT for review (revised after review round 2)

## v3 changes (review round 2)

Round 2: Mistral approved; Codex and Grok found the same six items still
under-specified (B3 was unanimously closed). v3 closes them concretely, and
states an HONEST guarantee instead of "the flap disappears":

**Guarantee (precise).** No job whose owner wrote a heartbeat within `leaseTtl`
is ever swept. Recovery reads heartbeats with a fresh, row-locked read at sweep
time (not a stale snapshot), so a live owner is never orphaned. A genuinely
stale owner's job is orphaned; if that owner was only *reviving* (its event loop
unblocked) and later finishes the job, the guarded `recordComplete` makes
`completed` the terminal store state and re-emits the flight-recorder completion
(last-writer-wins). So: live jobs are never orphaned; the only residual is a
reviving-after-`leaseTtl` owner, which self-heals to the correct terminal state.

Key v3 mechanisms: a **fresh-read + row-lock recheck** (or `SERIALIZABLE` /
advisory-locked single sweeper) closes the Postgres READ COMMITTED snapshot race
(B1); **transport-aware TTL** and an **advisory (never-vetoing) `kill(pid,0)`**
plus a concrete **event-loop-lag skip** (B2); **fail-closed on `recordStart`
itself** and on sustained heartbeat failure (B4); an **explicit durable `queued`
model + `markRunning` API** (B5); a **concrete async `dispose()` ordering that
never uses synchronous `process.exit` for drain** (B6); and the full end-to-end
API/parity list (B7). See sections 5a-5g and 6.

---

## (v2 header retained below)

Status: DRAFT for review (revised after review round 1)
Base commit: `origin/master` @ `9602037` (the reconciled 2.14.0-rc.1 tree, which
contains the real `PostgresJobStore` + `src/postgres-job-store-worker.ts`). All
file:line references below are against that tree.
Relationship to the interim gate: the interim `[persistence].ownsOrphanRecovery`
gate (PR #140) stops the high-churn stdio case now; this durable design supersedes
it (see section 12).

## 0. What changed since v1 (review round 1)

v1 was anchored to the installed `dist` and pointed reviewers at a stale checkout
where `PostgresJobStore` is a stub. Re-anchored here. Three reviewers (Codex,
Grok, Mistral) endorsed the lease direction but raised 7 blockers, all addressed
below: (B1) completion/sweep atomicity, (B2) event-loop-block false positives +
TTL too aggressive, (B3) post-recordStart pre-heartbeat window, (B4) fail-closed
on register/heartbeat failure, (B5) `queued` persisted as `running`, (B6)
deregister/shutdown wiring, (B7) interface/config/parity + SQLite specifics.

## 1. Problem (recap, real anchors)

`markOrphanedOnStartup()` runs an unscoped `UPDATE jobs SET status='orphaned'
WHERE status='running'`:
- SqliteJobStore: `src/job-store.ts:468` (SELECT) + `:477` (UPDATE), with an
  explicit race comment at `:464` ("a status='running' row can be inserted
  between this SELECT and the UPDATE").
- PostgresJobStore worker: `src/postgres-job-store-worker.ts:223` (SELECT) +
  `:226-231` (UPDATE).
- MemoryJobStore: `src/job-store.ts:921` is a deliberate no-op (per-process).
Invoked in the AsyncJobManager constructor, gated by the interim flag as of
PR #140 at `src/async-job-manager.ts:664`+.

Under a SHARED postgres store, every instance sees the same `running` rows, so a
fresh instance orphans other live instances' in-flight jobs. Transient (the owner
later overwrites the row on completion, because `recordComplete` is keyed
`WHERE id` only with no status guard: `src/job-store.ts:440-444`), but a poller
trips on the `running -> orphaned -> completed` flap and the flight recorder logs
a false "orphaned after gateway restart".

Two axes: gateway ACCESS (stdio ephemeral, one manager per spawn, vs http
long-lived) and provider TRANSPORT (`process` has a pid, `http` API provider has
none, so pid liveness cannot be the primary mechanism).

## 2. Goal

Orphan a `queued`/`running` job iff the gateway instance that owns it is provably
not alive, never because a different live instance started. Transport-agnostic,
correct across shared postgres / single postgres / per-process + shared-file
sqlite / memory, backward-compatible, and free of the mid-flight flap.

## 3. Approach: instance lease (heartbeat) + owner stamping + explicit state machine

Each instance holds a lease (periodic heartbeat) while alive and stamps every job
it owns with its `instance_id`. Recovery orphans only jobs whose owner's lease has
expired. Layered defenses close the review blockers:
- correct liveness so live jobs are never swept (B2, B3),
- fail-closed so an instance that cannot prove its own liveness neither admits
  durable jobs nor sweeps (B4),
- a guarded completion path so even a mistaken orphan self-heals without a visible
  flap (B1),
- a real state machine that distinguishes `queued` from `running` (B5).

Rejected alternatives (unchanged from v1, reviewers concurred): instance-id-only
"orphan my own" (restart changes the id), pid-liveness as primary (http has no
pid; cross-host; reuse), Postgres advisory locks / `pg_stat_activity` (not
portable to SQLite).

## 4. Schema changes (additive, auto-created)

Precedent: the store already adds columns idempotently (e.g. owner/transport
columns) and creates indexes at open. Same pattern:

1. `jobs.owner_instance TEXT` (nullable), stamped at enqueue. Index
   `idx_jobs_status_owner ON jobs(status, owner_instance)`.
2. New table `gateway_instances`:
   `instance_id PK, role, hostname, pid INTEGER, started_at, last_heartbeat NOT NULL`.
   Postgres `TIMESTAMPTZ`; SQLite ISO-8601 TEXT.
3. Status: the in-memory machine already has `queued|running|completed|failed|
   canceled|orphaned` (`src/async-job-manager.ts:75`). The durable row must also
   persist `queued` (see B5), so the store's insert path stops hard-coding
   `status:"running"` (`src/job-store.ts:506`, `:849`).

## 5. Runtime changes (per blocker)

### B3 (register before admit) + identity
`instanceId = randomUUID()`, `role`, `os.hostname()`, `process.pid` in the
AsyncJobManager constructor. `store.registerInstance({...last_heartbeat = DB
now()...})` is called synchronously in the constructor BEFORE the manager can
accept any request, and it writes `last_heartbeat = now` at insert. Because
`recordStart`/enqueue can only run after construction returns, any job row that
exists already has a fresh instance row: the post-recordStart / pre-first-
heartbeat window Grok flagged cannot occur. This ordering invariant is asserted
in a test.

### 5b. B4 (fail-closed, end to end)
Round 2 correctly noted that gating only `registerInstance`/`heartbeat` is not
enough while `recordStart` still swallows via `safeStoreCall`
(`src/async-job-manager.ts:1417`). v3 closes the whole admission path:

- **Registration.** `registerInstance` is NOT wrapped in `safeStoreCall`. On
  throw, `durableAdmission=false`: no recovery runs, and durable async admission
  is refused. The gate is enforced at BOTH the tool-registration check
  (`hasStore()`-style, `src/async-job-manager.ts:799`) AND at each `startJob*`
  call site, so a caller gets an explicit error, never a silent in-memory-only
  job.
- **recordStart is fail-closed for durable admission.** The durable
  `recordStart` insert is taken OUT of the swallow path: if the durable row (with
  `owner_instance`) cannot be written, the async request fails rather than
  running an in-memory job with no owned durable row (the round-2 "looks
  ownerless" hole). `recordOutput`/`recordComplete` may stay best-effort (a
  completed job losing a stdout append is not a correctness hazard), but
  `recordStart` and `markRunning` are not. On a durable `recordStart` failure the
  manager also RELEASES the limiter permit and removes the queued entry (round-3
  refinement) so a job that failed durable admission can never later launch and
  become an in-memory-only orphan.
- **Sustained heartbeat failure protects owned work.** A heartbeat throw
  increments a counter; after N consecutive failures the instance (a) stops
  admitting durable jobs, (b) stops sweeping (never orphans on stale self-view),
  and (c) because OTHER instances may soon sweep its now-stale-lease jobs, it
  proactively cancels/terminalizes its own in-flight owned jobs (mark `canceled`
  with a clear reason) or self-exits, so recovery by others is correct rather
  than a surprise mid-flight orphan.

### 5a. Heartbeat + B2 (no false positives; transport-aware TTL; advisory pid check)
Unref'd heartbeat timer, `HEARTBEAT_MS` default 15000 (alongside the existing
eviction/stall timers at `src/async-job-manager.ts:688`+). Defenses, tightened
after round 2 (pid reuse, http-has-no-pid, underspecified lag):

- **Transport-aware TTL.** `instanceLeaseTtlMs` default 90000 (6x heartbeat) for
  the instance lease, PLUS a separate, larger `httpJobGraceMs` default 300000
  (5 min) applied to `transport='http'` jobs, which have NO secondary liveness
  signal. A job is a sweep candidate only when `last_heartbeat < now - leaseTtl`
  AND (for http jobs) `started_at < now - httpJobGrace`. This makes the honest
  guarantee weaker-but-safe for http (slower genuine-orphan detection) rather
  than risk orphaning a slow live HTTP call.
- **Concrete event-loop-lag skip.** The heartbeat timer measures its own
  scheduling drift (actual fire time minus expected `HEARTBEAT_MS` cadence,
  monotonic `process.hrtime`). If the most recent drift exceeds
  `HEARTBEAT_MS` (this loop was blocked and cannot trust its wall-clock view of
  others), the sweep is SKIPPED this cycle and the lag is logged. This is a
  defined metric, not hand-waving.
- **Advisory, never-vetoing `kill(pid,0)`.** For `transport='process'` jobs whose
  `hostname` matches and whose real `pid` is stamped at launch (B5), a live
  `kill(pid,0)` DELAYS orphaning by one extra `leaseTtl` (to protect a slow-but-
  live child), but never vetoes it indefinitely: after the extended grace the job
  is orphaned regardless (pid reuse cannot hold a row hostage forever). A dead
  pid, a missing pid, or a foreign hostname falls straight through to the lease
  decision. The lease is authoritative; `kill(pid,0)` only ever buys time, it is
  never required to be false. This resolves the round-2 "reused pid => stuck
  running forever" hole.

### 5c. B5 (explicit durable queued model + API)
The in-memory machine already has `queued` (`src/async-job-manager.ts:75`,
created queued at `:1091`/`:1610`, flipped to running in-memory only), but the
durable layer cannot represent it: `JobStoreStatus` excludes `queued`
(`src/job-store.ts:13`), and all three inserts hard-code `running`
(`src/job-store.ts:506`, `:849`, `src/postgres-job-store-worker.ts:148`). v3
specifies the full durable model:

- Extend `JobStoreStatus` (`src/job-store.ts:13`) with `queued`.
- `recordStart` inserts `status='queued'` with `owner_instance` (no pid yet).
- New store method `markRunning(id, { pid })`: transitions `queued -> running`
  and stamps the real child pid (needed by 5a's advisory `kill(pid,0)`), called
  from the launch path (where the in-memory flip already happens,
  `src/async-job-manager.ts` launch sites). Implemented in Sqlite + Memory +
  Postgres (`syncCall`) + worker.
- `recoverStaleJobs` targets `status IN ('queued','running')`, so a crash between
  enqueue and launch is recovered and a not-yet-launched job is never mislabeled
  running.
- Dedup: `findByRequestKey` (`src/job-store.ts:452`, filter at `:209`) is updated
  to treat a `queued` job with a LIVE owner as dedup-eligible (same as running),
  and to never dedup onto an `orphaned` row.

### 5d. B6 (concrete async shutdown / dispose ordering)
Round 2: current shutdown kills process groups and closes transports/DB/FR then
`process.exit(0)` (`src/index.ts:13634`), with fire-and-forget signal handlers
(`:13671`); it cannot safely await an async drain, and there is no pending-write
handle to drain. v3 makes the ordering explicit:

- The manager tracks its in-flight durable terminal writes in a `Set<Promise>`
  (each `recordComplete`/`markRunning` promise added on start, removed on
  settle), giving a concrete drain handle (the round-2 "drain is underspecified"
  gap).
- `async dispose({ timeoutMs })`: (1) `clearInterval` all timers (heartbeat,
  sweep, eviction, stall); (2) `await Promise.allSettled(pendingWrites)` bounded
  by `timeoutMs` (default 5000); (3) if the drain COMPLETED, `deregisterInstance`
  (fast recovery by others); if it TIMED OUT, SKIP deregister and let the lease
  expire naturally, so a job still being finalized is never orphaned mid-write.
- Wiring: the `SIGTERM`/`SIGINT` handler becomes `async () => { await
  manager.dispose(); await closeOthers(); process.exit(0); }` (or a shared
  `shutdown()` that awaits dispose BEFORE `process.exit`). No synchronous
  `process.exit` before dispose resolves. The stdio path (no such wiring today)
  gets it too.
- isolateState managers hold a `null` store (`src/index.ts:948`): they register
  nothing, so `dispose` is a no-op deregister for them.
- **Active owned jobs (round-3 refinement).** Draining only already-started
  terminal writes is not enough: `killAllProcessGroups` (`src/index.ts:13634`+)
  produces NEW terminal writes from the process close handlers
  (`src/async-job-manager.ts:1851`+) after the drain would have run. So `dispose`
  ordering is: (1) stop admission; (2) `clearInterval` timers; (3) abort/kill
  active owned jobs and AWAIT the terminal writes their close handlers enqueue
  into the pending-write Set (so the Set is drained AFTER the kills, not before);
  (4) deregister ONLY if no active owned work remains, else skip deregister and
  let the lease expire (never deregister with jobs still finalizing). This closes
  the "deregister then kill creates post-drain writes" hole.

## 6. B1: completion/sweep correctness (no live job swept; no false FR orphan)

Round 2 rightly rejected "the flap disappears" as overstated: a single UPDATE
whose `NOT EXISTS (... gateway_instances ...)` subquery is evaluated on the
statement's READ COMMITTED snapshot can still orphan a job whose owner
heartbeated *just* before the sweep (the subquery did not see the newer
heartbeat), and the flight-recorder `logComplete` side-effect on a mistaken
orphan (emitted in the ctor/sweep path, `src/async-job-manager.ts:688`) is not
undone by a later winning completion. v3 addresses all three.

### 6a. Per-job fencing lease (heartbeat and sweep contend on the same row)
Round 3 correctly refuted the v3 approach: a `jobs` row lock (`FOR UPDATE`) plus
a fresh re-read of `gateway_instances` does NOT serialize against a heartbeat that
writes `gateway_instances` (a different table), leaving a TOCTOU. v4 makes the
liveness signal a column ON the job row, so the two writers collide on it:

- New column `jobs.lease_deadline` (timestamp; nullable for terminal rows).
- **Heartbeat (owner advances its own jobs' lease):**
  ```sql
  UPDATE jobs SET lease_deadline = <db-now> + <leaseTtl>
   WHERE owner_instance = :me AND status IN ('queued','running');
  ```
- **Sweep (any instance / reaper):**
  ```sql
  UPDATE jobs
     SET status='orphaned',
         error=COALESCE(error,'owning gateway instance is no longer alive'),
         finished_at = <db-now>
   WHERE status IN ('queued','running')
     AND (lease_deadline IS NULL OR lease_deadline < <db-now>)
   RETURNING id, correlation_id, cli, owner_principal, transport, pid, http_status;
  ```
- Because both statements UPDATE the SAME job rows, Postgres serializes them on
  the row lock: a heartbeat committing first advances `lease_deadline` so the
  sweep's `WHERE lease_deadline < now` misses; a sweep committing first flips the
  row to `orphaned`, which the heartbeat's `WHERE status IN ('queued','running')`
  then skips. No cross-table dependency, no `pg_advisory_xact_lock`, no
  `SERIALIZABLE` retry. (A single-sweeper advisory lock is still optional purely
  to avoid redundant concurrent sweeps, not for correctness.)
- SQLite: single-writer, so both UPDATEs are already serialized; add
  `busy_timeout` for the shared-file case.
- Per-backend DB clock: Postgres `now()`; SQLite `strftime('%s','now')`
  arithmetic at query time (not the client `new Date()` used for timestamps
  today). `recordStart`/`markRunning` set the initial `lease_deadline = now +
  leaseTtl` in the SAME insert/update, so a live row never has a NULL deadline. The
sweep's `lease_deadline IS NULL` arm exists ONLY for legacy pre-migration
`running` rows (which predate the column and should be orphaned); it can never
strand a live job, because live rows always have the deadline set.
- `gateway_instances` remains for observability/GC/`role`; the sweep no longer
  reads it. NOTE: `withTransaction` currently returns void
  (`src/sqlite-driver.ts:225`); widen it to forward the callback value so the
  SQLite sweep can return the orphaned-row list.

Cost: a heartbeat now writes up to `maxRunningJobs` (default 32) job rows every
`HEARTBEAT_MS` instead of one `gateway_instances` row. Bounded and cheap; the
index `idx_jobs_owner_status` keeps it O(live jobs for this instance).

### 6b. recordComplete is a guarded transition (completion wins, no lost result)
`recordComplete` becomes `UPDATE ... SET status=@status ... WHERE id=@id AND
status IN ('queued','running','orphaned')` (`src/job-store.ts:440-444`). A
genuine terminal result always lands even onto a row a stale-but-reviving owner
had been marked `orphaned`; under Postgres the row lock makes sweep and
completion mutually exclusive, so order does not matter (last committed terminal
state is correct).

### 6c. Flight-recorder reconcile (no stuck false "orphaned")
The FR `logComplete` for a recovered job must be reconcilable: when a job that
was FR-logged `orphaned` later reaches a real terminal state (6b), the manager
re-emits `logComplete` with the true result (last-writer-wins on the FR row).
So the audit log converges too, not just the job store. (Implementation: FR
`logComplete` already exists; drop/adjust its `WHERE status='started'` guard for
the recovered-then-completed case, or issue a corrective completion event.)

### Honest net
Live jobs (owner heartbeated within `leaseTtl`) are NEVER orphaned: the
advisory-locked fresh-read recheck removes the snapshot race. The only residual
is a genuinely stale owner (missed >= `leaseTtl` of heartbeats) that revives and
finishes; that job self-heals to `completed` in both the job store (6b) and the
flight recorder (6c). No silent data loss, and no live job ever flaps.

## 7. B7: interface / config / parity + SQLite (end to end)

**`JobStore` interface** (`src/job-store.ts:147-212`) gains, with EXACT parity
across SqliteJobStore, MemoryJobStore, and PostgresJobStore (`syncCall`) +
`postgres-job-store-worker.ts` (new dispatch cases alongside `:216`):
- `registerInstance(meta)`, `heartbeat(instanceId)`, `deregisterInstance(instanceId)`
- `recoverStaleJobs(leaseTtl, httpJobGrace)` returning the orphaned-row list
- `markRunning(id, { pid })` (B5 queued -> running + pid stamp)
- `JobStoreStatus` (`src/job-store.ts:13`) extended with `queued`. Two dependent
  state-machine parity fixes (round-3): `recordComplete`'s `status` type must
  become `Exclude<JobStoreStatus, "running" | "queued">` (`src/job-store.ts:169`,
  currently excludes only `running`, so adding `queued` would wrongly permit it
  as a terminal status); and hydration must set `exited` false for a `queued`
  row (`src/async-job-manager.ts:1515`, currently `exited: row.status !==
  "running"` would mark a durable queued row exited)
- New column `jobs.lease_deadline` + index `idx_jobs_owner_status` (6a)
- `recordStart` inserts `queued` (all 3 impls: `:506`, `:849`,
  `postgres-job-store-worker.ts:148`); `recordComplete` gains the guarded WHERE
  (6b); `findByRequestKey` dedup filter updated (5c)
- MemoryJobStore: register/heartbeat/deregister are no-ops, `recoverStaleJobs`
  keeps its current per-process no-op (`src/job-store.ts:921`); it still
  represents `queued`/`markRunning` in memory for parity.

**DDL** (idempotent, in BOTH the SqliteJobStore open path AND the pg worker
`init`, which today only create `jobs`/`validation_*`): `jobs.owner_instance`
column + `idx_jobs_status_owner`; new `gateway_instances` table +
`gateway_instances` heartbeat index.

**Config** (`src/config.ts:107` schema, `:118` interface, `:288` loader): add
`instanceHeartbeatMs` (15000), `instanceLeaseTtlMs` (90000), `httpJobGraceMs`
(300000), `orphanSweepIntervalMs` (30000), `instanceGcMs` (~3600000);
Zod-validated `leaseTtl >= 2 x heartbeat` and `httpJobGrace >= leaseTtl`. Deprecate
`ownsOrphanRecovery` (parse + one-time warning, then remove; section 9).

**SQLite**: add `PRAGMA busy_timeout` in the SqliteJobStore open path (the driver
deliberately sets no pragmas, `src/sqlite-driver.ts:268`; WAL is set in the store
ctor, `job-store.ts:327`) + a `SQLITE_BUSY` retry around heartbeat/sweep. Widen
`withTransaction` to return the callback value (6a).

**markOrphanedOnStartup**: keep as a DEPRECATED thin shim delegating to
`recoverStaleJobs` for the single-owner sqlite/memory path (round-2 consensus:
full removal understates the test blast, e.g. `job-store.test.ts:340`, the
persistence suites, flight-recorder orphan paths, and ~20 `ownsOrphanRecovery`
fixtures). Do NOT keep blanket-sweep semantics on any production path.

**Periodic sweep**: `recoverStaleJobs` at startup and on an `orphanSweepIntervalMs`
reaper timer, plus `gateway_instances` GC
(`DELETE ... WHERE last_heartbeat < now - instanceGc`).

## 8. Edge cases

- Legacy `owner_instance IS NULL` running rows (pre-migration): `NOT EXISTS` is
  true, so orphaned; almost certainly already stale. Optional grace by
  `started_at`.
- MemoryJobStore: unchanged (per-process; register/heartbeat no-op).
- SQLite single-process: one instance; on restart the prior heartbeat is stale so
  its jobs recover. Shared-file SQLite now correct too (lease, not "startup =
  orphan all"), which the interim gate did not cover.
- dedup / `findByRequestKey`: verify it does not match `orphaned` rows in a way
  that resurrects a dead job; recovery sets a terminal state so dedup should skip
  it (add a test).
- `pid` is vestigial today (persisted null in some paths); the secondary
  `kill(pid,0)` guard requires stamping the real pid for `process` jobs at launch.

## 9. Interaction with the interim gate (#140)

Once the lease design lands, `[persistence].ownsOrphanRecovery` is obsolete
(recovery is per-job lease-scoped, not per-instance opt-in). Deprecate it: keep
parsing it for one release (ignored, with a one-time warning) then remove. The
lease recovery is safe to run from every instance concurrently, so no instance
needs to be "the owner".

## 10. Rollout / backward-compat

Additive schema, auto-created, no data migration. Rolling upgrade: mixed
old/new instances during a deploy; old instances still blanket-sweep on startup
until all upgraded (interim gate already neutralizes that for postgres). Ship
behind persistence config; defaults on. Deprecation of the interim flag as above.

## 11. Test plan

- Unit (memory + sqlite + `npm run test:pg`): recover when owner absent /
  heartbeat-stale; NOT when owner fresh; legacy NULL-owner recovered; queued-
  stale recovered; deregister then recovered next sweep; live instance untouched;
  lease-TTL boundary.
- B-specific: (B3) register-before-admit ordering invariant; (B4) registration
  failure disables durable admission and suppresses sweep; (B2) simulated
  event-loop-blocked owner (delayed heartbeat) is NOT wrongly orphaned within the
  larger TTL, and a process job with a live pid is not orphaned even past TTL;
  (B1) mistaken orphan then completion yields a single terminal `completed` with
  no observable `orphaned` to a poller; (B5) queued row not treated as running.
- #139 regression (PG): A runs a heartbeating job; construct B; assert A's job
  stays `running`; stop A's heartbeat / deregister; next sweep orphans it.
- E2E: async job whose nested agent spawns a gtwy; parent stays `running`,
  completes; poll throughout, never a spurious `orphaned`.

## 12. Round-2 question resolutions + round-3 questions

Round-2 answers, now folded into the design:
1. Keep `orphaned -> completed` as a guarded safety net (6b) AND never
   false-orphan a live job (6a). Both, not either.
2. Not sufficient as stated: v3 adds a separate, larger `httpJobGraceMs` (5 min)
   for no-pid http jobs and makes `kill(pid,0)` advisory/never-vetoing (5a).
3. Keep `markOrphanedOnStartup` as a deprecated shim (section 7).
4. The RC snapshot race was real; v3 closes it with an advisory-locked single
   sweeper + `FOR UPDATE SKIP LOCKED` fresh-read recheck (6a).

Round-3 answers, folded into v4:
1. Both reviewers preferred a fencing token over the advisory-lock/cross-table
   read. v4 adopts the cleanest form: a per-job `lease_deadline` advanced by the
   owner's heartbeat, so heartbeat and sweep serialize on the same job row (6a).
   No `gateway_instances` read in the sweep predicate.
2. On sustained heartbeat failure, prefer self-exit / "stop admitting + skip
   deregister" over proactive cancel (5b now leads with stop-admit + stop-sweep;
   cancel/self-exit is the escalation, not the default).
3. Widening `withTransaction` to return the callback value is accepted (6a, 7).

Remaining round-4 question:
1. Does the per-job `lease_deadline` fencing (6a) fully satisfy the v4 guarantee
   under Postgres READ COMMITTED, i.e. is the same-row `UPDATE` serialization
   between heartbeat and sweep sufficient with no residual TOCTOU, and is the
   per-heartbeat bulk `UPDATE` of up to `maxRunningJobs` rows an acceptable cost?
