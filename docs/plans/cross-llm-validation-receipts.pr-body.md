# feat(validation): cross-LLM validation receipts (durable, owner-scoped, hashed)

> STATUS: TEMPLATE for the future implementation PR. This document lives on the
> planning branch `plan/cross-llm-validation-receipts`, which changes NO source
> code. Every item below describes what the implementation PR WILL do; nothing
> here is implemented on this branch yet. The whole body is written in
> forward-looking tense for that reason; the implementing agent flips it to
> present tense and fills the real per-phase results into
> `cross-llm-validation-receipts.verification.md` at PR time.

## Summary

The implementation PR will add durable, immutable, owner-scoped receipts for
completed cross-LLM validation runs. A terminal run will mint exactly one
`validation_receipts` row that envelopes the existing `validation-report.v1`
artifact and carries a deterministic `canonical_sha256`. A new
`validation_receipt` tool will retrieve a receipt by `validationId` with
own-or-not-found ownership. None of this exists on the current branch yet
(`src/validation-report.ts` still has no terminal status, `src/validation-tools.ts`
has no `validation_receipt` tool and no owner check on `job_status`/`job_result`).

This supersedes the "Structured Deliberation Receipts" proposal, which was
written against a mental model the gateway does not implement. See
`docs/plans/cross-llm-validation-receipts.draft.md` for the code-grounded
rationale and `docs/plans/cross-llm-validation-receipts.dag.toml` for the plan.

## Why the rename and rewrite

Three load-bearing facts, each verified in code:

1. The validation tools are asynchronous fan-out, not synchronous deliberation.
   `startValidationRun` returns with provider jobs still `running`, so a receipt
   minted at kickoff captures nothing.
2. There is no single correlation id per run. Each provider job has its own
   `correlationId`; the run is keyed by a separate `validationId = randomUUID()`.
3. `validationId` was not durably stored anywhere. "Fetch a receipt later by id"
   was unbuildable until run identity was made durable.

The fan-out reviewers never see each other's output (every reviewer prompt says
"You are one independent reviewer ... Do not claim consensus"). The optional
judge synthesis is the one exception: it is given the collected provider results
verbatim. So the artifact is a validation receipt over independent reviews plus
an optional output-aware judge, not a peer-visible deliberation.

## What the implementation PR will change

### Phase 0 (prerequisites)
- `validation-report.v1` status and synthesis-status enums will gain terminal
  value(s); `buildValidationReport` will emit them when all jobs are terminal.
- A durable `validation_runs` table will be written at kickoff by
  `startValidationRun`, keyed by `validationId`, stamped with the owner principal
  and the provider job links.
- `synthesize_validation` will accept an optional `validationId` and link the
  judge job into the run.
- Security fix: `job_status` / `job_result` will apply the `principalCanAccess`
  owner check the `llm_job_*` paths already enforce (closes a pre-existing
  cross-principal read hole).

### Phase 1
- Immutable `validation_receipts` table + migration (job-store DB, idempotent
  pattern).
- Eager mint at first terminal observation (race-guarded INSERT-OR-IGNORE);
  mint-on-read fallback; `expired_unminted` when linked jobs were evicted before
  any mint.
- Canonical serialization + `canonical_sha256` (sorted keys, no insignificant
  whitespace, UTF-8, fixed array order; `humanReadable` excluded).
- `validation_receipt` tool (JSON), own-or-not-found, statuses minted / pending /
  expired_unminted / not_found; `includeRawResponses` as a read-time expansion
  that is never persisted or hashed.

### Phase 2
- `format:"markdown"` rendering on read (derived, not stored).
- Auto-mint on `synthesize_validation` when the run is terminal.

### Phase 3
- `validation-receipt://{validationId}` MCP resource through `src/resources.ts`.

## Gating and safety

- Durable artifacts and tool/resource registration will exist only under an
  implemented durable backend (today `sqlite`) AND a job store attached at
  runtime. Under `memory` / `postgres` / `none` no run/receipt row will be
  written and the receipt tool/resource will not be registered; `validationId`
  will still be returned at kickoff. Silent loss will be impossible by
  construction.
- All new SQLite access will route through `src/sqlite-driver.ts`; the release
  security audit hard-fails otherwise.

## Explicitly NOT in this PR

- Cryptographic signing and hash-chaining. The `prev_sha256` / `seq` /
  `signature` columns will be reserved (NULL); the canonical byte definition they
  will build on is fixed by the plan.
- Semantic enrichment (`key_points`, `evidence_cited`, `uncertainty_signals`,
  numeric per-model confidence). No extraction source exists; deferred to
  `validation-receipt.v2`.
- Quorum / policy evaluation.

## Verification

`docs/plans/cross-llm-validation-receipts.verification.md` is the living record.
As of the planning branch it holds the planning-phase baseline, the citation
audit, and the planning-review rounds (Codex / Gemini / Grok) with dispatch ids.
The implementing agent will append, at PR time, the per-phase changed files,
implementation notes, command results, and the final implementation-phase review
rounds and unconditional approvals. Do not cite this section as evidence that the
implementation review has happened yet.

## Test plan

- `npm run build`
- `npm test`
- `npm run lint`
- `npm run format:check`
- `npm run check`
