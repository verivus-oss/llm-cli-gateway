# Cache-awareness slice 1.5 — async-path flight recorder + codex parser fix (v1.7.0)

## Scope

Closes the two telemetry gaps that v1.6.0 explicitly deferred. After this slice,
`cache_state://*` aggregates include both sync- and async-tool activity, and
cache hits on codex rows populate `cache_read_tokens` in the flight recorder.

- **Async-path flight recorder.** `AsyncJobManager` had zero FR calls in v1.6.x.
  The v3 `stable_prefix_hash` / `stable_prefix_tokens` columns therefore stayed
  NULL on async-job rows even when `promptParts` was supplied. This slice wires
  `logStart` (at startJob entry) and `logComplete` (on every terminal state —
  completed / failed / orphaned / canceled) into the manager via a constructor-
  injected `FlightRecorderLike` dependency, with `writeFlightStart` opt-in so
  the sync-deferred path (where the sync handler already wrote `logStart`) does
  not double-INSERT. Sync-inline completions still get their rich-metadata
  `safeFlightComplete` from the sync handler, via an "arm-on-deferral" flag the
  manager only flips when `awaitJobOrDefer` returns a `DeferredJobResponse`.
- **Codex parser fix.** `src/codex-json-parser.ts` now accepts
  `cached_input_tokens` (the field the current Codex CLI emits, verified by a
  live 2026-05-26 smoke test) in addition to the legacy `cache_read_input_tokens`
  and a bare `cache_read_tokens` fallback.

Both ship together as **v1.7.0** (minor — observability surface materially
expands; new flight-recorder data appears where previously empty).

## Files touched

(Curated scope summary; for the literal byte-level diff run
`git diff --stat origin/master..feat/cache-awareness-slice-1.5`. The
diff additionally carries
`docs/plans/cache-awareness-slice-1.5.next-session-prompt.md` — the
session-handoff prompt that launched this slice, preserved for
reproducibility; not part of the v1.7.0 behaviour change.)

- [x] `src/async-job-manager.ts` — `FlightRecorderLike` constructor dep
      (default `NoopFlightRecorder`), `StartJobOptions` extended with
      `writeFlightStart` + `flightRecorderEntry` + `extractUsage`, new private
      `writeFlightComplete` helper wired into all 9 terminal-state code paths
      (close success, close failure, error, idle timeout, output overflow,
      cancel, dead-process eviction, exited-mismatch eviction, orphan recovery).
      Single-shot guard set only on successful write so a thrown logComplete
      can be retried. Retained `flightRecorderEntry` + `extractUsage` cleared
      after successful write. New public `armFlightCompleteForDeferral(jobId)`.
- [x] `src/job-store.ts` — `JobStore.markOrphanedOnStartup()` return shape
      extended from `number` to `{ count, orphaned: Array<{id, correlationId,
      startedAt, stdout, stderr, exitCode}> }`. `SqliteJobStore` SELECTs the
      per-orphan fields before the UPDATE (no transaction wrapper needed —
      gateway boot is single-threaded). `MemoryJobStore` returns
      `{count: 0, orphaned: []}`. `PostgresJobStore` stub signature updated.
- [x] `src/codex-json-parser.ts` — `cached_input_tokens` preferred over the
      legacy Anthropic-style names, with both fallbacks retained for safety.
- [x] `src/index.ts` — new `buildAsyncFlightRecorderHandoff(cli, prep,
      sessionId, outputFormat)` helper that constructs the FR payload from a
      `prep` object AND a primitive-only `extractUsage` closure (no `params`
      or `prep` capture). Threaded through all 5 sync handlers'
      `awaitJobOrDefer` calls and all 5 async handlers' `startJob` calls.
      `awaitJobOrDefer` calls `armFlightCompleteForDeferral` right before
      returning a deferred response, so manager-owned logComplete writes only
      fire after the sync handler is known to NOT write its own.
- [x] `src/__tests__/async-job-manager-flight-recorder.test.ts` — NEW. 18
      tests covering: logStart opt-in (case a / a2 / a3 / a4 / i), terminal
      states (b / c / c2 / d / e / f), orphan recovery (g / h + a fake-store
      path that exercises the rich-snapshot return), Codex-F4 retryability,
      Codex-F5 post-write field clear, dead-process eviction (e3), output
      overflow (e2).
- [x] `src/__tests__/codex-json-parser.test.ts` — +3 cases for the new field
      preference, dual-field-present preference, legacy fallback.
- [x] `src/__tests__/cache-state-resources.test.ts` — +2 cases verifying
      `cache_state://global` and `cache_state://prefix/{hash}` aggregate
      async-job rows (`asyncJobId` set on the seeded FR row).
- [x] `src/__tests__/job-store.test.ts` — assertion updated for the new
      `{count, orphaned[]}` shape.
- [x] `src/__tests__/persistence-config.test.ts` — assertion updated.
- [x] `docs/plans/async-flight-recorder.dag.toml` — NEW (this slice's plan).
- [x] `docs/personal-mcp/ASYNC_FLIGHT_RECORDER_SURFACES.md` — NEW (research
      note: terminal-state catalogue, data contract per FR write site,
      sync-path responsibility split table, dedup + cancel + orphan
      semantics).
- [x] `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` — Codex section updated
      (parser now accepts `cached_input_tokens`); slice 2 implications
      corrected (claude + codex populate `cache_read_tokens`).
- [x] `docs/launch/blog-cache-awareness.md` — "What's next" → "Update —
      slice 1.5 landing as v1.7.0" subsection (release-sequenced; the
      main-body Codex paragraph at ~line 74 references this subsection
      with future-tense framing so the post is internally consistent
      pre-publish).
- [x] `docs/plans/cache-awareness.dag.toml` — header comment notes that
      slice 4 is blocked on 24h+ of dogfood data after v1.7.0 ships.
- [x] `CHANGELOG.md` — `[Unreleased]` entry that becomes the `[1.7.0] -
      <release-date>` heading at release time.
- [x] `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` — UNCHANGED.

## Test count delta

| Snapshot              | Total tests |
|-----------------------|-------------|
| Base (post-v1.6.1)    | 681         |
| After slice 1.5       | 704         |
| **Delta**             | **+23**     |

No existing test was modified to make a failing test pass — `job-store.test.ts`
and `persistence-config.test.ts` had their `markOrphanedOnStartup` assertions
shape-updated (not weakened) to match the new return type. All other test
edits are pure additions.

## What's intentionally NOT shipped

- **Slice 4** (cache-aware multi-LLM routing) — gated on 24h+ of
  `cache_state://global` dogfood data collected AFTER v1.7.0 ships.
- **Slice 5** (explicit Claude `cache_control` injection via stream-json —
  Branch A) — separate plan; requires a live smoke test against the
  Anthropic API with a real account, which is a human-in-the-loop step.
- **Sync-deferred-dedup correlationId orphan**. When a sync request hits
  dedup AND the sync deadline expires, the dedup'd caller's sync-side
  `logStart` row stays at `status='started'` forever. Documented as a
  pre-existing limitation (predates this slice — the sync handler writes
  logStart at handler entry before dedup is consulted). A future slice
  can address via per-request corrId fan-out.

## Multi-LLM review log

Each unit was reviewed concurrently by Codex, Gemini, Grok, and Mistral via
the `gtwy` MCP, async, with the standard permission flags.

| Unit       | Round | Codex             | Gemini          | Grok            | Mistral         | Resolution                                                       |
|------------|-------|-------------------|-----------------|-----------------|-----------------|------------------------------------------------------------------|
| A — plan   | r1    | request_changes (F1-F6) | request_changes (F1-F5) | request_changes (F1-F5) | request_changes (F1-F4) | Plan rewrites: writeFlightStart opt-in, sync-helper failure semantics, richer orphan snapshot, retryable single-shot, primitives-only closure, expanded test matrix, doc consistency. |
| A — plan   | r2    | request_changes (F1 still / F3 doc inconsistency) | approve | approve         | approve         | F3 doc consistency fixed; F1 documented as pre-existing limitation. |
| A — plan   | r3    | approve           | (skipped)       | (skipped)       | (skipped)       | Unanimous.                                                       |
| B — impl   | r1    | request_changes (F1 sync-inline metadata regression) | request_changes (F5 missing dead-process test) | approve         | approve         | Arm-on-deferral added; dead-process eviction test added.        |
| B — impl   | r2    | approve           | approve         | (skipped)       | (skipped)       | Unanimous.                                                       |
| C — release | r1   | request_changes (blog/PR-body fidelity) | approve (low-sev flake note) | request_changes (blog Codex stale paragraph + duplicate in surfaces) | approve | Doc fixes: blog Codex paragraph + v1.7.0-publish overclaim, duplicate paragraph in surfaces, PR-body file list + CHANGELOG section heading. |
| C — release | r2   | request_changes (F1 blog tense / F2 PR-body bullet wording) | (skipped)       | approve         | (skipped)       | Blog line-74 tense + PR-body bullet wording fixed for r3.        |
| C — release | r3   | approve           | (skipped)       | (skipped)       | (skipped)       | Unanimous (carries Gemini r1 + Grok r2 + Mistral r1 approvals).  |

## Rollback

Hard rollback only (no opt-in flag to flip). Revert the release commit. The
SQLite flight-recorder schema is unchanged from v1.6.x, so existing
`logs.db` files keep working; new rows written post-revert continue to be
sync-path-only.

## Invariant statement

"No conversation content in session storage" holds. The session manager
(`~/.llm-cli-gateway/sessions.json`) is UNTOUCHED. The new FR writes go to
the existing `~/.llm-cli-gateway/logs.db`, which already records
prompts/responses for audit and is not subject to the session-storage rule.
`getJobSnapshot` callers still see the distinct `'canceled'` and
`'orphaned'` JobStore statuses; the FR's `status='failed' + errorMessage`
encoding is a separate audit projection.

## Acceptance gate

`cache_state://global` should show `total_hits` continuously rising over the
24h dogfooding window after v1.7.0 install. Codex rows in particular should
finally show non-NULL `cache_read_tokens` aggregated under the per-CLI
breakdown (where the v1.6.x flight-recorder showed claude-only data).
