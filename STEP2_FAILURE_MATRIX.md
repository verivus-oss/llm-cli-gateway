# Step 2 Failure Matrix (Baseline: 2026-02-15)

## Scope
- Baseline logs:
  - `/tmp/llm-gateway-debug/test-all-20260215T002107Z.log`
  - `/tmp/llm-gateway-debug/integration-20260215T002107Z.log`
  - `/tmp/llm-gateway-debug/session-manager-pg-20260215T002107Z.log`
  - `/tmp/llm-gateway-debug/migration-pg-20260215T002107Z.log`
- Baseline result: `31 failed | 144 passed`.

## Failure Clusters

| Cluster | Symptom | Evidence | Likely Root Cause | Confidence | Fix Priority |
|---|---|---|---|---|---|
| ID contract mismatch | `invalid input syntax for type uuid` on custom/non-existent/empty IDs | `session-manager-pg-20260215T002107Z.log:51`, `:110`, `:162`, `:177`, `:296`, `:426`; schema uses `UUID` in `migrations/001_initial_schema.sql:6`, `:17`; tests intentionally use string IDs in `src/__tests__/session-manager-pg.test.ts:35`, `:80`, `:164`, `:208` | PostgreSQL backend enforces UUID while file-based manager and tests treat IDs as opaque strings | High | P0 |
| Cross-worker DB cleanup contention | `deadlock detected` during tests | `test-all-20260215T002107Z.log:815`; cleanup truncates both tables each test in `src/__tests__/setup.ts:79`; global setup enabled in `vitest.config.ts:10`; per-file tests also call cleanup (`src/__tests__/session-manager-pg.test.ts:9`, `src/__tests__/migration-pg.test.ts:16`) | Multiple workers/files call broad `TRUNCATE ... CASCADE` concurrently | High | P1 |
| Active-session lock/FK instability | lock failures and FK violations in active session writes | `test-all-20260215T002107Z.log:896`, `:923`, `:965`, `:978`; `migration-pg-20260215T002107Z.log:36`, `:386`, `:434`; lock throw in `src/session-manager-pg.ts:284-287`; UPSERT in `src/session-manager-pg.ts:292-297` | Current Redis lock behavior hard-fails on lock miss; concurrent lifecycle operations plus cleanup contention create race windows around active session writes | Medium-High | P2 |
| Codex `fullAuto` integration mismatch | `codex_request` with `fullAuto: true` returns MCP error | `integration-20260215T002107Z.log:71`, `:103`; handler builds `codex exec --full-auto -a never ...` in `src/index.ts:528-531` | Flag combination likely invalid for installed codex CLI behavior in test env | Medium | P3 |
| Migration PG regressions (secondary) | migration count/metadata/active restore/idempotency failures | `test-all-20260215T002107Z.log:671-760`; migration code depends on `createSession`/`setActiveSession` in `src/migrate-sessions.ts:49`, `:71` | Mostly downstream of ID/cleanup/active-session issues; may leave smaller residual migration-only gaps after upstream fixes | High (as secondary) | P4 |

## Proposed Remediation Order
1. **P0: Unify ID contract** across file and PostgreSQL backends (opaque string IDs).
2. **P1: Stabilize test isolation** to remove cross-worker deadlocks (single cleanup authority and/or non-blocking delete order).
3. **P2: Harden active-session updates** (lock miss handling and FK-safe sequencing under contention).
4. **P3: Fix Codex `fullAuto` arg policy** for gateway compatibility.
5. **P4: Re-run and patch migration-specific behavior** only after P0-P3.

## Step 2 External Review (Claude + Codex)
- Claude review: keep `P0`, suggested swapping `P1`/`P2` (active-session before cleanup), and warned about backward compatibility risk if ID handling changes.
- Codex review: keep order `P0 -> P1 -> P2 -> P3 -> P4`; rationale is cleanup deadlocks can mask/contaminate active-session test outcomes.
- Decision for implementation: keep `P1` before `P2` to reduce concurrency noise first, then tune active-session behavior on a stable test bed.

## Acceptance Checks Per Priority
- P0: `src/__tests__/session-manager-pg.test.ts` no UUID syntax failures.
- P1: no `deadlock detected` in PG test logs.
- P2: no `Failed to acquire lock` or `active_sessions_session_id_fkey` failures in PG/migration tests.
- P3: integration test `codex_request > should work with fullAuto option` passes.
- P4: `src/__tests__/migration-pg.test.ts` fully green.
