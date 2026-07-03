# Durable instance-lease orphan recovery (#139): implementation kickoff prompt

You are implementing the durable orphan-recovery fix for GitHub issue #139 in the
llm-cli-gateway MCP server. Work strictly from the code-grounded artifacts in
this repo, not from memory. The design has already been through a 4-round
adversarial cross-LLM gate and is APPROVED; your job is to implement it exactly,
verify it, re-review the implementation, and land it.

## Start here

- Base your work on `origin/master` (the reconciled tree that contains the real
  `PostgresJobStore` + `src/postgres-job-store-worker.ts`). Cut a fresh branch,
  e.g. `fix/issue-139-durable-orphan-recovery`. Do NOT use `ci/prerelease-support`
  (a stale checkout whose `PostgresJobStore` is a stub).
- The interim gate (`[persistence].ownsOrphanRecovery`, PR #140) is already
  merged. This work supersedes it and deprecates it; it does not revert it.

## Read first (in order)

1. `docs/plans/issue-139-orphan-recovery.draft.md` (v4, APPROVED): the design
   spec. Every decision, the honest guarantee, and every code citation live here.
   Source of truth for WHAT and WHY. The current design is sections 2-11 plus the
   v4 refinements 5a-5d and 6/6a-6c; the "(vN header retained below)" sections are
   provenance.
2. `docs/plans/issue-139-orphan-recovery.dag.toml`: the executable plan. Each
   `[[steps]]` block is a unit of work with `depends_on`, an `action`, and a
   `validation` clause. Execute in dependency order. Source of truth for HOW and
   IN WHAT ORDER. The `[decision]` block is the locked design; do not relitigate
   it without new code evidence.
3. `docs/plans/issue-139-orphan-recovery.test-plan.md`: the test matrix every
   change must satisfy and the `verification-gate` must execute.
4. `CLAUDE.md`: repository conventions (snake_case tool names, Zod validation,
   stderr-only logging, explicit return types, >=80% coverage, atomic writes, and
   the `node:sqlite` adapter rule).

## The one idea to hold onto

The bug is that `markOrphanedOnStartup` blanket-orphans every `running` row on
every AsyncJobManager construction, which is destructive on a SHARED store. The
fix is a PER-JOB FENCING LEASE: a new column `jobs.lease_deadline` that the owner
advances on each heartbeat and the sweep checks. Because heartbeat and sweep are
BOTH `UPDATE`s on the same `jobs` rows, they serialize on the row lock (Postgres
READ COMMITTED) and are trivially serial under single-writer sqlite. The sweep
never reads `gateway_instances` (that cross-table read was the race that four
review rounds killed). Guarantee: no job whose owner advanced its `lease_deadline`
within `leaseTtl` is ever swept; a genuinely stale-then-reviving owner self-heals
via the guarded `recordComplete` and the flight-recorder reconcile.

## Ground rules

- All new SQLite access goes through `src/sqlite-driver.ts`. The release security
  audit hard-fails if `node:sqlite` is referenced anywhere else.
- The job store uses its own idempotent `CREATE TABLE IF NOT EXISTS` + column-add
  pattern in its constructor (NOT the flight recorder's `_migrations` system).
  Add the new DDL idempotently in BOTH the SqliteJobStore open path AND the pg
  worker `init`.
- The sweep CANDIDATE predicate is `status IN ('queued','running') AND
  (lease_deadline IS NULL OR lease_deadline < db_now) AND (transport <> 'http' OR
  started_at < db_now - httpJobGrace)`. The transport grace is IN the candidate
  selection, NOT applied by the manager after a row is already flipped to
  `orphaned` (you cannot un-orphan a flipped row). The `IS NULL` arm exists ONLY
  to orphan legacy pre-migration rows; live rows always have `lease_deadline` set
  at `recordStart`/`markRunning` in the same write, so a NULL never strands a live
  job. Use the per-backend DB clock (Postgres `now()`, sqlite `strftime`), not
  client `new Date()`.
- The `kill(pid,0)` advisory is applied BEFORE the terminal write: for a
  process-transport candidate with a live same-host pid, the sweeper ADVANCES
  that row's `lease_deadline` by one `leaseTtl` (grace) instead of orphaning it,
  and excludes it from the orphan statement; a dead/missing/foreign-host pid falls
  through to orphaning. It is advisory and never vetoing (bounded to one extra
  `leaseTtl`, so pid reuse cannot strand a row). http-transport jobs have no pid
  and rely on `httpJobGraceMs` (default 5 min) plus the lease.
- `recordComplete` must be guarded: `WHERE id=@id AND status IN
  ('queued','running','orphaned')`, and its `status` type is
  `Exclude<JobStoreStatus,'running'|'queued'>`.
- Durable admission is fail-closed: durable `recordStart`, `markRunning`, AND
  `registerInstance` bypass `safeStoreCall`; on failure the async request/launch
  fails AND the limiter permit + queued entry are released so nothing later runs
  untracked. Only `recordOutput`/`recordComplete` may stay best-effort in
  `safeStoreCall`.
- `gateway_instances` is retained for observability/GC/`role` only; the sweep
  does not read it.
- Prefer self-exit over proactive cancellation when heartbeats/store writes are
  failing (the failure that breaks heartbeats often breaks other writes too).
- Never use the em dash (U+2014) anywhere (a PreToolUse hook enforces this on
  edits and commit/PR bodies). Do not add a Co-Authored-By trailer.

## Execution protocol

1. Run `audit-job-store-surface` first and write the inventory into
   `docs/plans/issue-139-orphan-recovery.verification.md` under a Phase 0
   baseline heading (confirmed file:line for every seam, current test count,
   changed-file baseline). Correct any spec citation that has drifted.
2. Implement each `[[steps]]` block in dependency order. After each, run its
   `validation` clause and the matching cases from the test plan. Add tests under
   `src/__tests__/` (AAA pattern, complete mocks for isolation; PG-backed cases
   via `npm run test:pg`). Record changed files, notes, and results per phase in
   the verification notes.
3. Do not advance a step whose `depends_on` predecessors are not green.
4. At `verification-gate`, run `npm run build && npm run lint && npm run
   format:check && npm run provider:surfaces:check && npm test && npm run test:pg
   && npm run check`, plus the multi-instance #139 regression and the nested-agent
   E2E, and capture exact commands + results.
5. At `cross-llm-review-gate`, dispatch Codex, Grok, and Mistral via the gateway
   (async; read verdicts by `correlationId` with `llm_request_result`; poll ~every
   90s; jobs may transiently show `orphaned` under the shared store, read stdout
   regardless). Gemini/agy returns empty on this class of task; do not gate on it.
   Give reviewers the spec, this DAG, the test plan, the verification notes, and
   the exact diff. Iterate to unconditional approval or a concrete blocker; answer
   findings with code/test evidence, not assertion.
6. At `pr-and-land`, pre-check the CI-only gates locally (typos clean; no new
   high-entropy gitleaks fixtures), open the PR via `git-as werner_veriai` push +
   `gh-as werner_veriai pr create` (base master), wait for the four CI checks
   (build-and-test, pack-smoke-test, sast, security), then merge with `--merge`
   (NOT `--squash`). Do not admin-bypass.

## Definition of done

The DAG `acceptance_resource` holds: a `queued`/`running` job is orphaned iff its
own `lease_deadline` expired (never because another live instance started);
heartbeat and sweep serialize on the job row; a stale-then-reviving owner
self-heals; durable admission is fail-closed; graceful shutdown drains before
deregister; the #139 regression and the nested-agent E2E never observe a spurious
`orphaned`; `npm run check` and `npm run test:pg` pass; `ownsOrphanRecovery` is
deprecated; and all three substantive reviewers give unconditional approval.
