# Verification notes: durable instance-lease orphan recovery (#139)

Companion to `issue-139-orphan-recovery.dag.toml`, `.draft.md` (v4, APPROVED),
and `.test-plan.md`. Records the Phase 0 baseline, per-phase changed files plus
results, the verification-gate command matrix, and the cross-LLM review rounds.

Branch: `fix/issue-139-durable-orphan-recovery` (cut from `origin/master`
@ 271ca38 plus the plan-docs commit 5e1ec2c).

---

## Phase 0 baseline (audit-job-store-surface)

Environment: Node v24.15.0. Baseline suite: **152** test files under
`src/__tests__/`, **~2157** `it(`/`test(` cases (grep count; authoritative
vitest count captured at the verification gate). `node:sqlite` is referenced in
production code only from `src/sqlite-driver.ts` (the `flight-recorder.ts` and
`job-store.ts` grep hits are doc-comment mentions, not `require`/`import`; the
release audit passes on master).

### Seam inventory (confirmed file:line against the 271ca38 tree)

**`src/job-store.ts`**
- `JobStoreStatus` union: `:13` (`"running" | "completed" | "failed" | "canceled" | "orphaned"`; NO `queued`). CONFIRMED.
- `JobStore` interface: `:150-196`; `OrphanedJobSnapshot` `:203-213`. (Spec said `:147-212`; interface body is 150-196.)
- `recordComplete` status type `Exclude<JobStoreStatus, "running">`: `:169` (interface) plus `:541` (SqliteJobStore), `:876` (Memory), `:1038` (Postgres). CONFIRMED.
- `recordComplete` SQL (Sqlite `updateCompleteStmt`, keyed `WHERE id=@id` only, NO status guard): `:439-445`. (Spec `:440-444`.) CONFIRMED.
- `recordStart` inserts hard-coded `status:"running"`: Sqlite `:506`, Memory `:849`. CONFIRMED.
- `markOrphanedOnStartup`: interface `:190-193`; Sqlite `selectRunningOrphansStmt` `:466-469` plus `markOrphanedStmt` `:471-478` (`UPDATE jobs SET status='orphaned' ... WHERE status='running'`, unscoped) plus method `:588-620`; Memory no-op `:921-926`; Postgres proxy `:1060-1090`. CONFIRMED.
- `findByRequestKey`: Sqlite stmt `:451-458` (`status IN ('running','completed')`, ORDER started_at DESC), method `:574-578`; Memory `:903-915`. CONFIRMED.
- Sqlite ctor DDL plus PRAGMA site: `PRAGMA journal_mode=WAL` `:327`, `synchronous=NORMAL` `:328`, `CREATE TABLE jobs` `:330-357`, `ensureJobsOwnerColumn` `:117-123`/`:407`, `ensureJobsTransportColumns` `:132-144`/`:410`, prepared stmts `:423-480`. CONFIRMED. (No `busy_timeout` today.)
- Memory `recordStart` `:829-864`; Postgres class `:952`, `syncCall` `:987-1014`, `recordStart` `:1016-1030`, `createJobStore` `:1162-1184`. CONFIRMED.
- `ValidationRunStore` capability interface `:276-287`; `isValidationRunStore` `:290-298`. (Memory does NOT implement it.)

**`src/postgres-job-store-worker.ts`**
- `init` and DDL: `:45-134` (`CREATE TABLE jobs` `:66-87`, indexes `:88-91`, idempotent `ALTER ... ADD COLUMN IF NOT EXISTS` `:128-133`). CONFIRMED. (Spec `:66-133`.)
- `recordStart` (hard-codes `'running'`): `:141-166` (VALUES `'running'` at `:148`). CONFIRMED.
- `recordComplete` (keyed `WHERE id=$1` only): `:173-198`. CONFIRMED.
- `markOrphanedOnStartup` (`BEGIN` plus SELECT running plus blanket `UPDATE ... WHERE status='running'` plus COMMIT): `:216-240`. (Spec `:216-231`.) CONFIRMED.
- `op` dispatch switch: `:136`; unknown-method throw `:366`. New cases join here.

**`src/async-job-manager.ts`**
- `AsyncJobStatus` (already has `queued`): `:74-75`; `isAsyncJobInProgress` `:77-79`. CONFIRMED.
- ctor `:637-713`; `ownsOrphanRecovery` param `:649`; interim gate branch `:667-700` (calls `markOrphanedOnStartup` `:676`). (Spec said gate `:664`; actual `:667`.) DRIFT NOTED.
- Timers: `evictionTimer` `:623`/`:702`, `stallTimer` `:624`/`:709` (both `setInterval`, `.unref()`). (Spec `:688+`.) DRIFT NOTED. No heartbeat/sweep timer today; no `dispose()`/`close()` on the manager today.
- `recordStart` call sites: http `:1159-1172`, process `:1699-1711` (both via `safeStoreCall`). CONFIRMED.
- queued creation plus launch flip: http job `status:"queued"` `:1100`, launch flip to running `:1138`; process job `status:"queued"` `:1620`, launch flip `:1664`. CONFIRMED.
- `safeStoreCall` `:1417-1424` (swallows on throw). `persistComplete` `:1443-1464`. `maybeFlushOutput` `:1431-1441`.
- Hydration `exited` flag: `:1515` (`exited: row.status !== "running"`, which would mark a durable `queued` row exited). CONFIRMED.
- Close handlers (terminal writes): process `child.on("close")` `:1851-1900`, `child.on("error")` `:1832-1849`; idle-timeout `:1798-1816`; output-overflow `:2170-2199`; `finalizeHttpJob` `:1207-1243`; `failQueuedJob` `:1910-1927`; `cancelJob` `:1981-2057`. `fireOnComplete`/`releaseJobPermit` `:1245-1268`.
- `hasStore()` `:802-804`; `getValidationRunStore()` `:812-814`. `getRunningJobs()` `:2059-2079`. No "active owned jobs" accessor today.
- `evictCompletedJobs` `:829+` already does a dead-process `kill(pid,0)` sweep for in-memory running jobs (`:834-849`), a precedent for the advisory pid check.

**`src/config.ts`**
- `PersistenceSchema` `:107-125` (`ownsOrphanRecovery` `:123`); `PersistenceConfig` interface `:127-144` (`ownsOrphanRecovery` `:139`); `loadPersistenceConfig` `:303-364`. CONFIRMED. `DEFAULT_MAX_RUNNING_JOBS = 32` `:383`.

**`src/sqlite-driver.ts`**
- `GatewayDatabase.withTransaction` type `:51` (returns `(...args)=>void`); impl `:225-250` (returns void, does not forward the callback value). CONFIRMED. `openDatabase` `:274-283` (no pragmas). `GatewayStatement` `:42-46`.

**`src/index.ts`**
- `newAsyncJobManager` `:561-586` (computes `ownsOrphanRecovery = pc.backend !== "postgres" || pc.ownsOrphanRecovery` `:574`); `getAsyncJobManager` `:588-591`; module-global `asyncJobManager` `:509`. CONFIRMED.
- `resolveGatewayServerRuntime` isolateState `:942`/`:948`; isolate-mode null-store manager `:954-958`. CONFIRMED.
- Deferral admission gate (`hasStore()`): process path `:1173-1176`, http path `:1336-1338`. CONFIRMED.
- `shutdown(signal)` `:13634-13669` (kills groups, closes http/server/db/FR, then `process.exit`); signal handlers `:13671-13672` (fire-and-forget `() => shutdown(...)`). CONFIRMED. Manager is NOT disposed today.

### Citation drift vs v4 spec (corrected here)
- Interim-gate branch is at `async-job-manager.ts:667`, not `:664`.
- Manager timers are at `:702`/`:709`, not `:688`.
- `JobStore` interface body is `:150-196` (spec `:147-212` included the snapshot/validation types).
- Sqlite `recordComplete` SQL is `:439-445` (spec `:440-444`).
- pg worker `markOrphanedOnStartup` spans `:216-240` (spec `:216-231`).
- index isolate-mode null-store manager is constructed at `:954-958` (spec pointed at the `:948` isolateState resolution).

All other v4 citations verified accurate. No design decision changes; the
fencing-lease approach in sections 6/6a-6c is consistent with the real tree.

### Changed-file baseline
Working tree clean at branch cut (only the plan-docs commit ahead of master).
Files expected to change: `src/job-store.ts`, `src/postgres-job-store-worker.ts`,
`src/async-job-manager.ts`, `src/config.ts`, `src/sqlite-driver.ts`,
`src/index.ts`, `CHANGELOG.md`, `README.md`, plus new tests under
`src/__tests__/`.

---

## Phase log

### schema-status-and-driver (DONE)
Changed: `src/sqlite-driver.ts` (withTransaction widened to `<A, R>` forwarding
the callback return value; type + impl), `src/job-store.ts` (`JobStoreStatus`
gains `queued` + `JobStoreActiveStatus` helper; `recordComplete` status type ->
`Exclude<JobStoreStatus,'running'|'queued'>` in all 4 sites; `JobRecord` gains
`ownerInstance`/`leaseDeadline` + `rowToRecord` mapping; fresh DDL adds
`owner_instance TEXT`, `lease_deadline INTEGER`, `gateway_instances` table +
heartbeat index; `ensureJobsLeaseColumns` idempotent ALTER; `PRAGMA
busy_timeout=5000`), `src/postgres-job-store-worker.ts` (matching DDL:
`owner_instance TEXT`, `lease_deadline BIGINT`, `gateway_instances` +
`idx_jobs_owner_status` + heartbeat index + idempotent ALTERs). New test:
`src/__tests__/orphan-recovery-139.test.ts` (U14 withTransaction return/rollback;
U13 DDL idempotency fresh + legacy sqlite).

Bug caught during this phase: creating `idx_jobs_owner_status` inside the main
DDL exec block referenced `owner_instance` BEFORE `ensureJobsLeaseColumns` adds
it, so opening the store against ANY legacy sqlite DB threw `no such column:
owner_instance` at startup (broke the existing F3 migration test too). Fixed by
creating that index in a separate `exec` AFTER the ALTER migrations. Lease
columns stored as epoch-ms integers (DB-clock) so all lease/sweep comparisons are
integer arithmetic, avoiding the ISO-lexical-vs-strftime ordering hazard.

Result: `npm run build` clean; `orphan-recovery-139` + `sqlite-driver` +
`job-store` suites 45/45 green.

### config-lease-knobs (DONE)
Changed: `src/config.ts` (exported `DEFAULT_INSTANCE_HEARTBEAT_MS=15000`,
`DEFAULT_INSTANCE_LEASE_TTL_MS=90000`, `DEFAULT_HTTP_JOB_GRACE_MS=300000`,
`DEFAULT_ORPHAN_SWEEP_INTERVAL_MS=30000`, `DEFAULT_INSTANCE_GC_MS=3600000`;
`PersistenceSchema` gains the five knobs plus a `superRefine` enforcing
`instanceLeaseTtlMs >= 2*instanceHeartbeatMs` and `httpJobGraceMs >=
instanceLeaseTtlMs`; `PersistenceConfig` interface + loader return wired;
`ownsOrphanRecovery` kept parsing with a one-time deprecation `logWarn` when
explicitly set). Tests: 5 new U15 cases in `persistence-config.test.ts`
(defaults, explicit valid, both invalid ratios rejected, deprecation warn).
Result: `persistence-config` suite 46/46 green; `npm run build` clean.

### jobstore-lease-api (DONE)
Changed: `src/job-store.ts` (new `GatewayInstanceMeta`/`SweepCandidate` types;
`JobStore` interface gains `markRunning`, `registerInstance`, `heartbeat`,
`deregisterInstance`, `selectStaleProcessCandidates`, `recoverStaleJobs`,
`gcInstances`; `recordStart` now persists `status='queued'` with
`owner_instance` + an initial `lease_deadline = SQLITE_NOW_MS + leaseTtl` (DB
clock, epoch ms); guarded `recordComplete` `WHERE ... status IN
('queued','running','orphaned')` and sets `lease_deadline=NULL`; `findByRequestKey`
dedup now includes a live (lease-valid) queued row and never an orphaned/expired
one; `recoverStaleJobs` runs the advance-then-orphan fencing sweep inside one
`withTransaction` returning the orphaned list, http grace via a DB-clock
`strftime('%Y-%m-%dT%H:%M:%fZ',...)` cutoff, live-confirmed ids excluded/advanced
via `json_each`; `markOrphanedOnStartup` reduced to a deprecated shim delegating
to `recoverStaleJobs`; `MemoryJobStore` mirrors the surface (register/heartbeat/
deregister/recover are no-ops, but it represents queued/markRunning/lease for
parity); `PostgresJobStore` proxy passthroughs; `createJobStore` threads
`leaseTtlMs`). `src/postgres-job-store-worker.ts` (`PG_NOW_MS` epoch-ms clock;
`recordStart`->queued+lease; `markRunning`; `registerInstance` upsert; `heartbeat`
(instance + per-job lease in one txn); `deregisterInstance`;
`selectStaleProcessCandidates`; `recoverStaleJobs` advance+orphan+RETURNING;
`gcInstances`; guarded `recordComplete`; dedup update).

Tests: `orphan-recovery-139.test.ts` grew the sqlite lease surface (U1-U5, U7-U9,
U11, heartbeat-advances-lease, http-grace-in-predicate, register/gc) and the
MemoryJobStore parity block (U12); updated `job-store.test.ts` (recordStart->queued
assertions; markOrphanedOnStartup rewritten to the lease shim with an aged lease);
added pg lease-parity to `job-store-pg.test.ts` (run at the gate under test:pg).
Non-PG result: `orphan-recovery-139` 21/21, `job-store` 20/20 green; `npm run
build` clean.

Deferred to the manager steps: 3 `async-job-manager-persistence.test.ts` failures
(ctor blanket-sweep + interim-gate assertions) are fixed alongside the manager
rewiring (they test behavior being changed in manager-identity-heartbeat /
recover-stale-jobs).

### manager-identity-heartbeat + fail-closed-admission + queued-to-running-pid-hydration + recover-stale-jobs + dispose-and-shutdown (DONE, implemented as one coherent manager rewrite)
Changed: `src/async-job-manager.ts`:
- Identity: `instanceId` (randomUUID), `hostname` (os.hostname), `instancePid`; new `LeaseRuntimeConfig` param (7th ctor arg, defaults from config); the 6th `ownsOrphanRecovery` arg is now deprecated/ignored.
- Register-before-admit: ctor calls `store.registerInstance(...)` synchronously (fail-closed: on throw, `durableAdmission=false` and no recovery/heartbeat starts, no rethrow). Then runs the startup lease sweep and starts the heartbeat + reaper timers (all unref'd).
- Heartbeat (`startHeartbeat`/`onHeartbeatTick`): advances this instance's per-job leases via `store.heartbeat`; measures hrtime scheduling drift and sets `skipSweepThisCycle` when the loop was blocked; sustained failure (>=3) disables durable admission + sweeping (prefer self-quiescence).
- Sweep (`runOrphanSweep` + `confirmLiveProcessCandidates`): skips on drift/disabled; runs the advisory `kill(pid,0)` on same-host process candidates (EPERM counts as alive; foreign/unknown host not probed) and passes the live ids to `recoverStaleJobs` (advance-then-orphan); emits FR `logComplete` per orphaned row. Reaper also GCs `gateway_instances`.
- Fail-closed admission: `recordStartOrFailClosed` (release permit/queue entry + drop job + throw on durable recordStart failure); `assertDurableAdmission` gate at both startJob* sites; `canAdmitDurableJobs()` used by the index.ts deferral gate.
- markRunning wiring: http launch flips the durable row best-effort (no pid, no process to strand); process launch (`launchProcessJob`) flips it fail-closed with the REAL child pid (kills the child + rethrows on failure so the launch caller terminalizes).
- Hydration: `exited = row.status !== "running" && row.status !== "queued"` (a durable queued row rehydrates not-exited).
- Dispose: `dispose({timeoutMs})` stops admission, clears all four timers, aborts/kills active owned jobs, drains their terminal writes (tracked http settle promises + active-job count) AFTER the kills, then deregisters ONLY if no active owned work remains (else lets the lease expire). Idempotent; null-store no-op.
`src/index.ts`: `newAsyncJobManager` passes the `LeaseRuntimeConfig` from `[persistence]` and drops the `ownsOrphanRecovery` computation; `shutdown()` awaits `asyncJobManager.dispose()` before `killAllProcessGroups`/`process.exit`; the two sync-deferral gates use `canAdmitDurableJobs()`.

Tests: updated `async-job-manager-persistence.test.ts` (3 tests -> lease model: startup sweep orphans a lease-expired dead-owner row; a fresh instance does NOT orphan a live-lease job but DOES after expiry; FR orphan-readback with aged leases), `async-job-manager-flight-recorder.test.ts` (fakeStore mocks the new lease surface), `http-job-runner.test.ts` (aged lease + old started_at for the http grace), `validation-receipt.test.ts` (seedJob markRunning). Added the manager M/N series to `orphan-recovery-139.test.ts` (M6 register-before-admit + owner stamping, M7 null-store no-op dispose, M8 queued hydration exited=false, N1 fail-closed recordStart releases the permit, N2 registration failure disables admission, M9/M10 dispose deregisters when idle + idempotent).

Result: **full non-PG suite `npm test` = 148 files / 2279 tests, 0 failures**; `npm run build` clean; `npm run lint` 0 errors (pre-existing ACP naming warnings only); `npm run format:check` clean.

### verification-gate (DONE)

Command matrix (all green):

| Command | Result |
| --- | --- |
| `npm run build` | clean (tsc) |
| `npm run lint` | 0 errors (218 pre-existing ACP naming warnings, unrelated) |
| `npm run format:check` | all files match Prettier |
| `npm run provider:surfaces:check` | OK, no new hand-maintained surfaces |
| `npm test` | 148 files / **2279 tests, 0 failures** |
| `npm run test:pg` | 4 files / **65 tests, 0 failures** (podman postgres:16-alpine on :5433 via `CONTAINER_CLI=podman`; the shipped `scripts/test-pg.sh` hard-codes `docker`, so podman was used directly) |
| `npm run check` | build + lint + format:check + provider:surfaces:check + test + `release-security-audit.sh` all pass |

Release security audit detail: `node:sqlite confined to the adapter
(src/sqlite-driver.ts)`; no `db.pragma()` helper API; no literal `fetch` in
shipped `dist/*.js`; hono >= floor; consumer-install policy clean. The
`npm-shrinkwrap.json` prod-projection parity step passed after regenerating the
stale untracked local artifact (`node scripts/make-prod-shrinkwrap.mjs`); the
shrinkwrap is a release-time artifact, untracked/git-ignored, never committed
(regenerated by `scripts/pre-release.sh` at release), so it is not part of this
PR's diff.

PG bugs caught and fixed during the gate (both the postgres analogue of the
sqlite legacy-DDL bug caught earlier, plus a param-typing bug):
1. `idx_jobs_owner_status` was created in the pg worker's main DDL block before
   `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS owner_instance`, so opening the
   store against a migration-created (pre-lease) jobs table threw `column
   "owner_instance" does not exist`. Fixed by creating that index after the ALTERs.
2. `recoverStaleJobs`'s orphan `UPDATE` passed `leaseTtlMs` as `$1` but never
   referenced it (only the advance query uses it), so Postgres rejected the
   statement with `could not determine data type of parameter $1`. Fixed by
   renumbering the orphan query's params from `$1` and casting `$1::bigint`.

Scenario / regression coverage:
- **#139 multi-instance regression (R2)**: covered on BOTH backends. sqlite:
  `async-job-manager-persistence.test.ts` "a fresh instance does NOT orphan a
  live-lease job, but DOES once the lease expires" (two real AsyncJobManagers /
  a fresh instance's startup sweep against a live-lease vs expired-lease row).
  postgres: `job-store-pg.test.ts` "#139: does NOT orphan a fresh-lease running
  job; DOES after the lease expires" (+ guarded recordComplete wins over a
  mistaken orphan). This is the exact bug's mechanism (a fresh instance must not
  orphan another instance's in-flight job on a shared store).
- **Nested-agent E2E (E1)**: the real-world trigger (an async job whose provider
  spawns a nested Claude Code that constructs its OWN gtwy AsyncJobManager) is
  covered by construction: the nested manager registers a fresh `instanceId` and
  its startup `runOrphanSweep` orphans ONLY lease-expired rows; the parent job's
  lease is continuously advanced by the parent instance's heartbeat, so it can
  never be swept by the child's construction. The executable proof is the R2
  multi-instance regression above (same lease mechanism); a live end-to-end run
  needs interactive provider auth and is left as a manual post-merge check on the
  serverwide postgres install.
- `node:sqlite` confirmed referenced only in `src/sqlite-driver.ts` (release audit).
