# Test-veracity audit — node:sqlite migration (sqlite-driver, 2.0.0)

## Scope

You are auditing the **veracity of the tests** added/changed by the
`node:sqlite` migration (Phase B of
`docs/plans/node-sqlite-migration-2.0.0.md`) on branch
`feat/node-sqlite-2.0.0` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits at
v1.17.8; the branch ships as **2.0.0**. HEAD at audit time: `2467149`.

This audit answers: **do the new/changed tests prove what they claim, and
would they go red if the migrated code broke?** — strict-evidence,
mutation-probe method, per the ε protocol and the exemplar format
(`docs/plans/test-veracity-audit-slice-theta.spec.md`).

Phase B replaces the two `createRequire(...)("better-sqlite3")` blocks in
`flight-recorder.ts` / `job-store.ts` with a single shared `node:sqlite`
adapter (`src/sqlite-driver.ts`). The adapter is a thin
connection/statement/transaction wrapper; all pragmas (journal_mode=WAL,
synchronous=NORMAL) stay in the consumers (plan B2/B3). `queryRequests`
now runs on a dedicated **read-only** connection (`openReadOnly` →
`new DatabaseSync(path, { readOnly: true })`), giving an engine-level
SQLITE_READONLY guard in place of the old JS `stmt.readonly` check (B4).

### New / changed test surface under audit

```
src/sqlite-driver.ts                              # NEW: the node:sqlite adapter (production code under test)
src/flight-recorder.ts                            # MODIFIED: openDatabase/openReadOnly; queryRequests on RO connection; WAL pragma in ctor
src/job-store.ts                                  # MODIFIED: openDatabase; WAL pragma in ctor; .changes consumers (markOrphanedOnStartup, evictExpired)
src/__tests__/sqlite-driver.test.ts               # NEW: 18 adapter unit tests (B8 + B4)
src/__tests__/cross-engine-wal.test.ts            # NEW: 2 cross-engine WAL crash-recovery fixtures (B3/B8)
docs/plans/test-veracity-audit-sqlite-driver.spec.md   # NEW: this spec
```

Existing regression suites (`flight-recorder.test.ts`, `job-store.test.ts`,
`test-veracity-regressions-slice-kappa.test.ts`, and every suite that
constructs the real `FlightRecorder` / `SqliteJobStore` against a temp DB)
now transparently exercise the new driver and are part of the standing
coverage. Two suites (`flight-recorder.test.ts`,
`test-veracity-regressions-slice-kappa.test.ts`) deliberately keep using
devDependency `better-sqlite3` to seed legacy-schema fixtures — that makes
them standing cross-engine coverage (old-engine writer → node:sqlite
production reader) in every CI run (plan B8).

Baseline at audit time (clean tree):
`npx vitest run src/__tests__/sqlite-driver.test.ts src/__tests__/cross-engine-wal.test.ts`
→ **2 files, 20 tests passed** (18 + 2). Full `npx vitest run` →
**64 files, 1066 tests passed**.

## Method

Mutation-probe, observed-evidence-only. For each probe:

1. Apply the mutation to **PRODUCTION** code (never a test).
2. Run the candidate detector file(s) first with `npx vitest run <file>`.
   If nothing fails there, escalate to the FULL `npm test` /
   `npx vitest run` before concluding the probe survived.
3. Record the **exact** observed failing test name(s) + a short assertion
   excerpt and the failure count — run, not asserted.
4. `git checkout -- <mutated-file>`; re-run the touched detector file to
   confirm green restoration.

A probe that kills NO test even at full-suite scope is an **audit finding**,
recorded here with analysis — never hidden.

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD -- src/sqlite-driver.ts src/flight-recorder.ts src/job-store.ts

# Baseline (must be green before any probe):
npx vitest run src/__tests__/sqlite-driver.test.ts src/__tests__/cross-engine-wal.test.ts
npm test
```

## Probe table

Probes are the plan §B8 "Minimum probe set with candidate detectors". The
"observed failing test (run)" column is the REAL output captured at HEAD
`2467149` on this host (Node 24, node:sqlite SQLite 3.51.3, better-sqlite3
SQLite 3.53.1 — skew confirmed by the cross-engine fixture's disclosure
line). Where the observed detector differs from the plan's candidate, the
reality is recorded in the Notes column.

| # | Mutation (production code) | vitest command(s) | Observed failing test(s) — run, not asserted (assertion excerpt) | Fails | Notes vs plan candidate |
|---|----------------------------|-------------------|------------------------------------------------------------------|-------|-------------------------|
| **P1** | `src/sqlite-driver.ts` `withTransaction`: remove the `try { ROLLBACK } catch {}` block on throw (swallow + skip rollback), keep re-throw. | `npx vitest run src/__tests__/sqlite-driver.test.ts` | (1) `sqlite-driver adapter > withTransaction > rolls back on throw: no rows persist and the original error propagates` — `AssertionError: expected 1 to be +0` at `sqlite-driver.test.ts:163`. (2) `sqlite-driver adapter > withTransaction > recovers after a rolled-back transaction (no dangling BEGIN state)` — `Error: cannot start a transaction within a transaction` at `sqlite-driver.ts:135` (BEGIN) via `sqlite-driver.test.ts:198`. | 2 | Matches plan candidate ("withTransaction rolls back on throw") and additionally kills the recovery/dangling-BEGIN test (the un-rolled-back BEGIN poisons the next txn). |
| **P2** | `src/flight-recorder.ts:407` `queryRequests`: change `openReadOnly(this.dbPath)` → `openDatabase(this.dbPath)`. | `npx vitest run src/__tests__/flight-recorder.test.ts` | (1) `FlightRecorder migrations (U23 cache columns) > queryRequests refuses non-readonly statements (DELETE … RETURNING)` — `expected [Function] to throw /non-readonly\|readonly/i; Received: "FOREIGN KEY constraint failed"` at `flight-recorder.test.ts:297`. (2) `... > queryRequests refuses UPDATE … RETURNING` — `expected [Function] to throw an error; Received: undefined` at `flight-recorder.test.ts:321`. | 2 | Matches plan candidate ("queryRequests refuses non-readonly SQL"). With a RW connection the DELETE throws a *different* error (FK constraint) and the UPDATE silently succeeds (no throw) — both kill the test. The readonly guard is genuinely engine-level. |
| **P3** | `src/sqlite-driver.ts` `wrapStatement.run`: replace any plain-object (non-array) bind arg with `{}` before `stmt.run`. | `npx vitest run src/__tests__/sqlite-driver.test.ts` then `npx vitest run` (full) | Driver: `sqlite-driver adapter > binding styles > binds bare @name objects without setAllowBareNamedParameters (Node >= 24.4 default)` — `TypeError: Cannot read properties of undefined (reading 'x')` at `sqlite-driver.test.ts:104` (bind dropped → row not inserted). Full suite: **55 tests across 10 files** red — broad flight-recorder/job-store failures (e.g. `test-veracity-regressions-slice-kappa.test.ts:522` via `FlightRecorder.logStart`). | 1 (driver) / 55 (full) | Matches plan candidate ("binds bare @name objects" + broad flight-recorder/job-store failures). Bare-`@name` binding is load-bearing across the whole persistence layer. |
| **P4** | Consumer WAL pragma → DELETE: `src/flight-recorder.ts:201` AND `src/job-store.ts:178` `PRAGMA journal_mode = WAL` → `= DELETE`. | `npx vitest run src/__tests__/cross-engine-wal.test.ts` then `npx vitest run` (full) | `cross-engine WAL crash-recovery (plan B3/B8) > Direction 2 — rollback: node:sqlite production writer → better-sqlite3 reader > better-sqlite3 recovers WAL-only rows that node:sqlite production modules wrote` — `expected false to be true` at `cross-engine-wal.test.ts:450` (`existsSync(logsPath + "-wal")`: no `-wal` sidecar exists under DELETE journaling). Full suite: **1 test** red (only this one). | 1 | Plan candidate also named the driver test "journal_mode is wal". That driver test (`sqlite-driver.test.ts:252`) issues the pragma **in-test** to validate the *adapter*, so it is INTENTIONALLY insensitive to the consumer pragma and stays green — reality recorded. Direction 2's WAL-nonempty guard is the real consumer-pragma detector. See Finding F-P4. |
| **P5** | `src/sqlite-driver.ts` `wrapStatement.run`: call `stmt.run(...args)` then `return { changes: 0, lastInsertRowid: 0 }` unconditionally. | `npx vitest run src/__tests__/job-store.test.ts` then `npx vitest run` (full) | Job-store: (1) `JobStore > markOrphanedOnStartup > flips running rows to orphaned and leaves terminal rows alone` — `expect(changes.count).toBe(1)` at `job-store.test.ts:257`. (2) `JobStore > evictExpired > deletes rows whose expires_at is in the past` — `expect(removed).toBe(1)` at `job-store.test.ts:296`. Full suite: **6 tests** red (the 2 job-store `.changes` assertions + driver run-shape tests `sqlite-driver.test.ts:64,82` + cross-engine `result.changes` checks). | 2 (job-store) / 6 (full) | Matches plan candidate. Plan cited `job-store.test.ts:257,295`; the eviction assertion is actually at **:296** (`:295` is the `evictExpired()` call line) — reality recorded. |
| **P6** | `src/sqlite-driver.ts` `openDatabase`: before constructing `DatabaseSync`, `rmSync(dbPath + "-wal", { force: true })` (WAL-recovery sabotage). | `npx vitest run src/__tests__/cross-engine-wal.test.ts` then `npx vitest run` (full) | `cross-engine WAL crash-recovery (plan B3/B8) > Direction 1 — upgrade: better-sqlite3 writer → node:sqlite production reader/writer > recovers WAL-only rows for logs.db AND jobs.db, then operates normally` — `expect(Number(recoveredReqs[0].c)).toBe(LOG_ROWS)` at `cross-engine-wal.test.ts:287` (deleting the snapshot's `-wal` discards the uncheckpointed rows; recovered count < 60). Full suite: **1 test** red (only Direction 1). | 1 | Matches plan candidate ("the B3 fixture test"). Direction 1 opens the crash snapshot through the production `FlightRecorder`/`SqliteJobStore` (both call `openDatabase`), so the sabotage lands on the production read path; the recovery-delta guard (`:290 toBeGreaterThan(mainOnlyCount)`) is what makes the WAL contribution load-bearing. |
| **P7** | `src/sqlite-driver.ts` `guardReadOnly`: make it a no-op (`return;`) so the read-only connection no longer rejects `VACUUM`. | `npx vitest run src/__tests__/sqlite-driver.test.ts src/__tests__/flight-recorder.test.ts` | (1) `sqlite-driver adapter > openReadOnly > rejects VACUUM / VACUUM INTO on a read-only connection (writes to disk despite readOnly)` — `expected [Function] to throw /read-only connection rejects VACUUM/i` and `expect(existsSync(vacuumTarget)).toBe(false)` becomes `true` (file escaped to disk) at `sqlite-driver.test.ts`. The test includes comment/whitespace prefixes plus an empty-statement/multi-statement `exec` bypass shape (`; SELECT 1; VACUUM INTO ...`). (2) `FlightRecorder ... > queryRequests refuses VACUUM INTO (filesystem-write disguised as a read)` — same, including `; /* bypass */ VACUUM INTO ...`, at `flight-recorder.test.ts`. | 2 | Added in B-review (Mistral security probe): `VACUUM INTO '<path>'` writes a NEW file, which node:sqlite `{ readOnly: true }` does NOT block but better-sqlite3's `stmt.readonly` DID. The guard restores parity; this probe proves the guard is load-bearing (its removal lets a file escape to disk). |

### Per-probe restoration

After every probe the mutated file(s) were restored with
`git checkout -- <file>` and the touched detector file re-run green:

- P1 → `sqlite-driver.test.ts` 18 passed.
- P2 → `flight-recorder.test.ts` 12 passed.
- P3 → `sqlite-driver.test.ts` 18 passed.
- P4 → `cross-engine-wal.test.ts` + `sqlite-driver.test.ts` 20 passed.
- P5 → `job-store.test.ts` + `sqlite-driver.test.ts` 34 passed.
- P6 → `sqlite-driver.test.ts` + `cross-engine-wal.test.ts` 20 passed.
- P7 → `sqlite-driver.test.ts` + `flight-recorder.test.ts` green (probe run
  in a scratch copy `cp -a`, never the main tree; copy deleted).

Final restoration proof (audit close):
`npx vitest run src/__tests__/sqlite-driver.test.ts src/__tests__/cross-engine-wal.test.ts`
→ **20 passed**; `git status --short` empty; `git diff` empty.

## Audit findings

**F-P4 (not a survival; a candidate-detector correction).** The plan's
P4 candidate named `sqlite-driver.test.ts` "journal_mode is wal" as a
detector. That test (`sqlite-driver.test.ts:251-265`) issues
`PRAGMA journal_mode = WAL` **inside the test body** to prove the adapter
does not break a consumer-issued pragma round-trip. It deliberately does
not depend on any consumer setting the pragma, so swapping the *consumer*
pragma to DELETE leaves it green — correctly. The real, falsifiable
detector for the consumer WAL pragma is the cross-engine Direction 2
WAL-nonempty guard (`cross-engine-wal.test.ts:450-455`), which goes red
because DELETE journaling produces no `-wal` sidecar. No coverage gap:
the consumer pragma IS pinned, just by a different (and stronger,
behaviour-level) test than the plan guessed. No probe survived.

**F-P7 (security regression caught in B-review, fixed + probed).** Mistral's
security-beat review found that `VACUUM INTO '<path>'` succeeds on a
node:sqlite `{ readOnly: true }` connection and writes a new file to disk —
the engine read-only mode only blocks writes to the OPEN database, not the
creation of a new file. better-sqlite3's old `stmt.readonly` guard (plan B4)
returned false for VACUUM and DID block it, so the migrated engine-level
connection was momentarily *weaker* than the guard it replaced — contradicting
B4's "strictly stronger" claim. Fixed by `GatewayDatabaseImpl.guardReadOnly`
(rejects statement-leading `VACUUM` keywords,
comment/whitespace/empty-statement-normalised and multi-statement aware for
`exec`) on the read-only connection; ATTACH-then-write and `writable_schema`
schema edits were already engine-blocked (Mistral verified). Probe P7 pins the
guard.

**No surviving probes.** All seven mutations produced at least one red test
at the detector-file scope (P3/P5 additionally fan out across the full
suite). The new test surface is falsifiable on every probed axis:
rollback-on-throw, read-only-connection enforcement (incl. the VACUUM
filesystem-write vector), bare-named-param binding, consumer WAL journaling,
`run().changes` pass-through, and cross-engine WAL crash recovery (both
directions).

## Round expectations

- 4–5 LLM auditors (Codex, Gemini, Grok, Mistral, Claude) launched async
  via the gateway, ≥90 s polling cadence, per
  `feedback_test_veracity_audit_protocol.md`.
- Each reviewer MUST independently re-run every probe (mutate production
  code → run the listed vitest command → observe colour → `git checkout --`
  → confirm restoration) and cite `file:line` for any disagreement.
- Approval criterion: each probe produces a red test as recorded here; no
  probe leaves the suite green when the migrated code is broken; F-P4's
  detector-substitution is accepted (or a concrete blocker named).

## LLM-auditor verdicts

4 independent auditors, 2026-06-04, each instructed to re-run ≥2 probes of
their choosing in a scratch copy (`cp -a` → `/tmp/audit-<name>`, deleted
after) and judge the spec strictly on observed evidence. Combined
independent re-run coverage: P1 ×2, P4 ×4, P5 ×2, P6 ×1; P2/P3 verified at
code level (detector + mutation site inspection) by Grok.

| Auditor | Model | Verdict | Notes (file:line) |
|---------|-------|---------|-------------------|
| Codex | gpt-5.5 | AUDIT PASS | re-ran P4 (cross-engine-wal.test.ts:450, driver suite stays 18/18 → F-P4 confirmed), P6 (:287, recovered 0 vs 60), P5 (job-store.test.ts:257,:296 + 4 driver run-shape tests) |
| Gemini | gemini-3-pro | AUDIT PASS | re-ran P1 (sqlite-driver.test.ts:163 row leak + dangling-BEGIN via sqlite-driver.ts:135) and P4 (:450); calls F-P4 + P5 line-drift corrections sound |
| Grok | grok | AUDIT PASS | re-ran P1 (2 failures exactly as recorded, restored → 18/18) and P4 (driver pragma round-trip test stays green → F-P4 confirmed); per-axis detector table all "pins behaviour" |
| Mistral | Vibe | AUDIT PASS | re-ran P4 (flight-recorder.ts:201/job-store.ts:178 → :450) and P5 (:257,:296, full suite 6 failures); format compliance confirmed |

Overall: **PASS 4/4** — every probe kills at least one test; the two
reality-corrections (F-P4 detector substitution, P5 line drift :296) were
independently re-verified; no surviving probes.
