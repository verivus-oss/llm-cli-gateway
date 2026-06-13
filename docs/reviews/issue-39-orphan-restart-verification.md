# Issue 39 orphan restart verification

Date: 2026-06-14
Branch: `fix/async-orphan-restart-status`

## Scope

Issue #39 covers async jobs that are orphaned after gateway restart. The root
cause is in startup orphan handling: durable job rows are correctly marked
`orphaned`, but the flight-recorder completion row was always written as
`failed`, even when the provider response had already been captured in stdout.

This review is for the local uncommitted diff on this branch. Reviewers must
inspect the code, tests, and docs directly. This document is the corrective
program specification and verification record, not evidence by itself.

## Changed files

- `src/async-job-manager.ts`
- `src/__tests__/async-job-manager-flight-recorder.test.ts`
- `src/__tests__/async-job-manager-persistence.test.ts`
- `docs/personal-mcp/ASYNC_FLIGHT_RECORDER_SURFACES.md`
- `docs/reviews/issue-39-orphan-restart-verification.md`
- `CHANGELOG.md`

## Corrective specification

- On gateway startup, durable running-job rows that cannot be reattached still
  become `orphaned`; this preserves the operational truth that the original
  process is no longer owned by the new gateway instance.
- The persisted flight-recorder/readback result for an orphan must preserve a
  captured provider response when stdout exists and no failure was recorded.
- A known successful exit (`exitCode === 0`) or captured stdout with unknown exit
  (`exitCode === null`) must be logged as `completed`, with `exitCode: 0`, the
  captured stdout as `response`, and no orphan error message.
- A known nonzero exit remains `failed`; stderr is preferred as the response, and
  stdout is retained only as fallback when stderr is empty.
- A null-exit orphan with no captured stdout remains a restart/orphan failure,
  with `exitCode: 1` and `errorMessage: "orphaned after gateway restart"`.
- The current async flight-recorder surfaces doc must describe that split:
  JobStore keeps the row `orphaned`, while flight-recorder/readback may be
  `completed` for captured stdout and no recorded failure.
- The changelog must not leave the older cancel/orphan-as-failed note as the
  only discoverable guidance for current orphan readback semantics.

## Verification already run locally

Focused regression suite:

```bash
npx vitest run src/__tests__/async-job-manager-flight-recorder.test.ts src/__tests__/async-job-manager-persistence.test.ts src/__tests__/job-store.test.ts
```

Observed result: 3 files passed, 40 tests passed.

Formatting, build, and lint:

```bash
npm run format:check
npm run build
npm run lint
```

Observed result: all passed. Lint emitted existing warnings only.

Full test suite:

```bash
npm test
```

Observed result: 85 files passed, 1425 tests passed.

## Reviewer instructions

Use the following commands as starting points, then inspect any related code
needed to verify or falsify the claims above:

```bash
git status --short --branch
git diff -- src/async-job-manager.ts src/__tests__/async-job-manager-flight-recorder.test.ts src/__tests__/async-job-manager-persistence.test.ts docs/personal-mcp/ASYNC_FLIGHT_RECORDER_SURFACES.md docs/reviews/issue-39-orphan-restart-verification.md CHANGELOG.md
npx vitest run src/__tests__/async-job-manager-flight-recorder.test.ts src/__tests__/async-job-manager-persistence.test.ts src/__tests__/job-store.test.ts
npm run format:check
npm run build
```

Do not approve based on this document, the primary agent's summary, or intent.
Approval must be based on inspected code, tests, docs, and persistent evidence.

Final verdict must be one of:

- `FINAL VERDICT: APPROVED`
- `FINAL VERDICT: NOT APPROVED`

Conditional approvals count as `NOT APPROVED`. If not approved, list concrete
blockers with file and line evidence plus the exact required correction.
