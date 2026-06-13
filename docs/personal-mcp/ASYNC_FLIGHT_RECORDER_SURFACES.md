# Async-path flight-recorder surfaces (slice 1.5 research)

**Date:** 2026-05-26. **Source files re-verified:** `src/async-job-manager.ts`,
`src/job-store.ts`, `src/index.ts` safeFlightStart/Complete call sites at
the time of writing. Re-verify with `rg` before relying on cited line
numbers — they drift.

## Why this exists

v1.6.0 wired `stable_prefix_hash` / `stable_prefix_tokens` through the
sync-path flight recorder but explicitly deferred the async path (see
`docs/plans/cache-awareness.dag.toml` step
`slice1-wire-prompt-parts-into-request-helpers` point 5). The async
job manager has **zero** flight-recorder calls today: `grep -n
"FlightLogStart\|safeFlightStart\|logStart\|flightRecorder"
src/async-job-manager.ts` returns empty.

Consequence: `cache-state://*` resources see only sync-path activity.
Async tools (`*_request_async`) write nothing observable, even when
`promptParts` was supplied.

This slice closes that gap. The decisions below are what `docs/plans/
async-flight-recorder.dag.toml` codifies.

## Terminal-state catalogue

Every path that flips `job.status` away from `"running"` must call
`writeFlightComplete(job, finalStatus)` exactly once. Listed by callsite
shape; use `rg` before relying on exact line numbers:

| # | Trigger                                  | Location | Resulting status | FlightLogResult.status |
|---|------------------------------------------|-----------------|------------------|------------------------|
| 1 | Clean child exit, exitCode=0             | close handler | `completed` | `completed` |
| 2 | Clean child exit, exitCode!=0            | close handler | `failed`    | `failed` |
| 3 | Child error / launch failure             | error handler | `failed`    | `failed` |
| 4 | Idle timeout                             | resetIdleTimer callback | `failed` (125) | `failed` |
| 5 | Output overflow (>50MB)                  | appendOutput | `failed` (126) | `failed` |
| 6 | User cancel (cancelJob)                  | cancelJob | `canceled`  | `failed` + errorMessage="canceled by caller" |
| 7 | Dead-process detector (eviction sweep)   | eviction sweep | `failed`    | `failed` |
| 8 | Exited-without-status mismatch (eviction)| eviction sweep | `failed`    | `failed` |
| 9 | Orphan-on-startup (constructor boot)     | constructor boot calls JobStore.markOrphanedOnStartup | `orphaned` (in JobStore) | `completed` when a provider response was already captured in stdout and no failure was recorded; otherwise `failed` + errorMessage="orphaned after gateway restart" |

FlightLogResult.status is only `"completed" | "failed"` (see
`src/flight-recorder.ts`). Canceled still collapses to `"failed"`
with a distinguishing `errorMessage`. Boot-time orphan rows are split:
if stdout already contains a provider response and no failure was recorded,
the flight-recorder/readback row is completed; otherwise it is failed with
the orphan restart message.

**Cross-table asymmetry (R2 Grok-F3 clarification):** the underlying
`jobs` table in JobStore retains the distinct `"canceled"` and
`"orphaned"` statuses (consumed by `getJobSnapshot` callers and the
durable-store retention sweep). In the `requests` table, canceled jobs still
read back as `"failed" + errorMessage`, while boot-time orphan rows are split:
orphans without captured stdout read back as failed, and orphans with captured
stdout plus no recorded failure read back as completed even though the JobStore
row remains `orphaned`, because the new gateway cannot reattach the old child
process. External consumers of `~/.llm-cli-gateway/logs.db` (or future
error-rate queries that filter `status='failed'`) will count user cancels and
boot-time orphans without captured stdout as errors. This is documented in
CHANGELOG; future work can either widen FlightLogResult.status or convert
cancel/orphan querying to an errorMessage prefix scan.

## Data contract per callsite

What's already in scope at each point — drives the `flightRecorderEntry`
+ `extractUsage` plumbing in `StartJobOptions`:

| Field needed by FlightLogStart | At `startJob` time | At terminal time |
|--------------------------------|--------------------|------------------|
| `correlationId`                | `correlationId` arg | `job.correlationId` |
| `cli`                          | `cli` arg | `job.cli` |
| `model`                        | From caller `prep.resolvedModel` (must thread through `flightRecorderEntry.model`) | n/a |
| `prompt`                       | From caller `prep.effectivePrompt` (via `flightRecorderEntry.prompt`) | n/a |
| `sessionId`                    | From caller `params.sessionId` (via `flightRecorderEntry.sessionId`) | n/a |
| `asyncJobId`                   | The freshly-generated `id` inside `startJobWithDedup` | n/a |
| `stablePrefixHash`             | `prep.stablePrefixHash` (via `flightRecorderEntry`) | n/a |
| `stablePrefixTokens`           | `prep.stablePrefixTokens` (via `flightRecorderEntry`) | n/a |

| Field needed by FlightLogResult | At terminal time |
|---------------------------------|------------------|
| `response`                      | `isFailure ? (job.stderr || job.stdout) : job.stdout` (R2 Codex-F2: mirrors sync helpers; stderr is where the useful text lives on launch errors). |
| `durationMs`                    | `Date.now() - new Date(job.startedAt).getTime()` |
| `retryCount`                    | `0` (async manager doesn't retry; that's the sync helper's job) |
| `circuitBreakerState`           | `"closed"` (manager doesn't own a CB) |
| `optimizationApplied`           | `false` (manager doesn't apply optimisations) |
| `exitCode`                      | `job.exitCode ?? (completed ? 0 : 1)` |
| `errorMessage`                  | failure only: `overrideErrorMessage ?? job.error ?? job.stderr ?? "Exit code N"` (R2 Codex-F2: `job.error` is null on most non-zero exits). Per-callsite overrides: cancel → "canceled by caller"; output-overflow → "Output exceeded maximum size (50MB)"; dead-process → "Process no longer exists (dead process detected)"; exited-without-status → "Process exited without proper status transition"; orphan failure → "orphaned after gateway restart". Captured-output orphan completions omit `errorMessage`. |
| `status`                        | derived per the catalogue above |
| `inputTokens` / `outputTokens` / `cacheReadTokens` / `cacheCreationTokens` / `costUsd` | **Only when `finalStatus === "completed"`** (R2 Grok-F2 / Mistral-F2 clarification) AND `job.extractUsage` is set. For every failure path (catalogue rows 2–9), usage stays undefined even when a partial CLI emit captured tokens before the error. Manager does NOT import `extractUsageAndCost` to avoid `index.ts ↔ async-job-manager.ts` circularity — handlers supply the closure, constructed from primitive locals only (R2 Codex-F5 / Gemini-F3: capturing `params` directly pins large promptParts/attachments for JOB_TTL_MS). |

### asyncJobId null vs non-null (R2 Mistral-F2 clarification)

The `asyncJobId` column on `requests` distinguishes how the row was
initiated:

- `asyncJobId = NULL`: row was written by the sync-path `safeFlightStart`
  in `src/index.ts` (one of the 5 sync handlers: `claude_request`,
  `codex_request`, `gemini_request`, `grok_request`, `mistral_request`).
  The sync handler also writes the `logComplete`, UNLESS the underlying
  job was deferred — in which case AsyncJobManager writes the complete
  on terminal state (and the asyncJobId stays NULL on that row because
  no new logStart was written; see "Sync-path responsibility split"
  below).
- `asyncJobId = <UUID>`: row was written by AsyncJobManager's
  `writeFlightStart` path, invoked by one of the 5
  `handle*RequestAsync` handlers via `startJobWithDedup({writeFlightStart:
  true})`. The UUID matches the AsyncJobManager job id.

Cache-stats aggregation queries do NOT filter by asyncJobId — both row
types contribute to global / per-prefix totals. The column is preserved
for future routing decisions (slice 4) and for incident triage.

## Dedup-hit rule

`startJobWithDedup` short-circuits at `src/async-job-manager.ts:457-493`
when an existing job matches the request key within the dedup window.
**The dedup path MUST NOT write a new FR row.** The original job already
wrote its own logStart at start time and will write its own logComplete
at terminal time. Writing a duplicate would create two rows for one
logical request, inflating cache-stats counts.

The handler's per-request resources (onComplete cleanup) are still freed
synchronously in the dedup path (existing behaviour; see U26 fix at
lines ~471-482). The FR-aware change adds nothing here.

**Limitation (R2 Grok-F4 / Codex-F1 documentation):** the deduped
caller's correlationId is NOT recorded in the flight recorder. The FR
row carries the original job's correlationId. For sync-deferred-dedup
(sync request → dedup-hit → sync deadline expires → returns deferred
response), the dedup'd request's sync-side logStart row (which the sync
handler wrote at handler entry, before dedup was even discovered) stays
at `status='started'` forever because the manager only ever calls
logComplete for the ORIGINAL job's correlationId. This is the same
pre-existing tracing limitation as the prompt-parts wiring and is
documented in CHANGELOG for v1.7.0; a future slice can address it via
per-request corrId fan-out.

## Sync-path responsibility split (R2 Codex-F1)

Two writers, two roles:

| Path                          | Writes `logStart`                       | Writes `logComplete`                                                                          |
|-------------------------------|-----------------------------------------|-----------------------------------------------------------------------------------------------|
| Sync handler completes inline | sync handler (`safeFlightStart`)        | sync handler (`safeFlightComplete`); manager's terminal callback is a `WHERE status='started'` no-op |
| Sync handler defers           | sync handler (`safeFlightStart`)        | **AsyncJobManager.writeFlightComplete** (sync handler returned without writing complete) |
| `handle*RequestAsync`         | **AsyncJobManager** (writeFlightStart=true) | AsyncJobManager.writeFlightComplete                                                       |

The `writeFlightStart` flag on `StartJobOptions` toggles whether the
manager INSERTs a logStart row. Without this distinction, the
sync-deferred case would either (a) silently leave rows at
`status='started'` forever, or (b) crash on a duplicate primary-key
INSERT when the manager attempts to also write logStart for a corrId
the sync handler already inserted.

## Cancel decision

User cancel ⇒ FR write with `status="failed"`, `errorMessage="canceled
by caller"`. Rationale:

- `FlightLogResult.status` only has `"completed" | "failed"`, so canceled
  has to overload one of them.
- The FR is the gateway's audit trail; an unrecorded cancel makes
  diagnostic timelines lie ("the request started and then... ?").
- Cache-stats does not currently distinguish a "failed" row beyond
  "not-completed", so the cancel-as-failed encoding doesn't pollute the
  hit-rate calculation. If a future slice wants to break out cancel rates,
  the `errorMessage` substring is a stable parse target.

## Orphan-on-startup rule

`AsyncJobManager` constructor calls
`store.markOrphanedOnStartup()`. To write FR complete rows for those rows
with the full sync-helper-equivalent payload (response from captured stdout
or failure stderr/stdout, errorMessage with proper fallback, durationMs
computed from `startedAt`), the method returns enough data per orphan that
the constructor can populate every field of `FlightLogResult`.

**Interface change** (breaking at the TypeScript level; R2 Codex-F3 /
Mistral-F1 fix — richer per-orphan snapshot):

```ts
// before
markOrphanedOnStartup(): number;

// after
markOrphanedOnStartup(): {
  count: number;
  orphaned: Array<{
    id: string;
    correlationId: string;
    startedAt: string;     // ISO string, for durationMs computation
    stdout: string;        // partial output captured before orphan
    stderr: string;        // partial output captured before orphan
    exitCode: number | null;
  }>;
};
```

Update all three implementations:

- `SqliteJobStore.markOrphanedOnStartup` (`src/job-store.ts`):
  do a `SELECT id, correlation_id, started_at, stdout, stderr,
  exit_code FROM jobs WHERE status='running'` BEFORE the UPDATE, then
  run the existing UPDATE. **No transaction wrapper is required** —
  the local `DatabaseLike` interface (`src/job-store.ts:37-41`) has no
  `transaction` method, and gateway boot is single-threaded before any
  new jobs can arrive, so the SELECT-then-UPDATE race window is
  closed in practice (no new `status='running'` row can be inserted
  between the two statements during the constructor's run).
- `MemoryJobStore.markOrphanedOnStartup` (`src/job-store.ts`):
  iterate `this.rows` and collect rows with `status==="running"` into
  the orphan array (snapshot fields above) before flipping them.
- `PostgresJobStore` stub (`src/job-store.ts`): mirror the shape;
  the stub is interface-only today and the rollout is mechanical.

Each iterated orphan triggers one `flightRecorder.logComplete` call. A
known successful exit (`exitCode === 0`) or captured stdout with unknown
exit (`exitCode === null`) writes a completed result with `exitCode: 0`,
the stdout response, and no orphan error. A known nonzero exit, or a null
exit with no captured stdout, writes a failed result using `stderr ||
stdout`, `exitCode: orphan.exitCode ?? 1`, and
`errorMessage: "orphaned after gateway restart"`. The FR row may not exist
(pre-slice-1.5 async jobs never wrote a logStart) — the underlying UPDATE
has a `WHERE status='started'` guard and silently becomes a no-op in that
case. That is the correct degradation path.

## Why a closure-based extractUsage instead of `import extractUsageAndCost`

`extractUsageAndCost` lives in `src/index.ts` (line 670). Importing it
from `src/async-job-manager.ts` would create an `index.ts ↔
async-job-manager.ts` circular dependency at module-init time. The
already-existing `onJobComplete` callback in the manager constructor
follows the same dependency-injection precedent — keep the manager
provider-agnostic; let the handler that already knows `cli` and
`outputFormat` supply the parser closure.

## What this slice does not change

- The session manager (`~/.llm-cli-gateway/sessions.json`) is untouched.
  The new FR writes go to the existing `~/.llm-cli-gateway/logs.db`,
  which already records prompts/responses for audit and is **not**
  subject to the "no conversation content in session storage" rule.
- The flight recorder schema is unchanged from v1.6.x (no v4 migration).
- No opt-in flag. Async-path FR writes happen unconditionally whenever a
  caller supplies a `flightRecorderEntry` in `StartJobOptions`. Tests
  that construct `AsyncJobManager` without injecting a recorder fall
  through to the `NoopFlightRecorder` default.
- The codex parser change (`cached_input_tokens`) is bundled into the
  same release for telemetry-completeness but is structurally
  independent of the async-FR wiring above.
