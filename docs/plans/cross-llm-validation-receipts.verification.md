# Cross-LLM Validation Receipts: verification notes

This is the living verification record for the cross-LLM validation receipts
slice. As of the planning branch it contains only the planning-artifact
verification (the DAG and doc set are reviewed before any code is written): the
planning baseline, the citation audit, and the planning-review rounds. The
per-phase implementation evidence and the implementation-phase review rounds will
be appended later by the implementing agent; those sections are placeholders
today.

## Planning-phase baseline

Date: 2026-06-29
Branch: `plan/cross-llm-validation-receipts` (off `master`)

Artifacts authored in this planning phase (changed-file list):

```text
?? docs/plans/cross-llm-validation-receipts.dag.toml
?? docs/plans/cross-llm-validation-receipts.implementation-prompt.md
?? docs/plans/cross-llm-validation-receipts.pr-body.md
?? docs/plans/cross-llm-validation-receipts.review-packet.md
?? docs/plans/cross-llm-validation-receipts.verification.md
 M docs/plans/cross-llm-validation-receipts.draft.md   (citation drift fixes only)
```

No source code is changed in the planning phase. At the planning baseline the
corrective-program spec (`cross-llm-validation-receipts.draft.md`) had only its
drifted code citations corrected (see below). It was then further amended during
the round-1 review: two load-bearing wording claims were corrected (the
reviewer-isolation claim in §0.4 and the `*_request_async`-gate analogy in §2).
So the draft's substance changed beyond pure citation drift; see the Round 1
record below for the exact edits and their code evidence.

## Citation audit (corrective spec)

Every `file:line` citation in `cross-llm-validation-receipts.draft.md` was
verified against current source. Already-accurate citations are omitted. The
following drifted and were corrected in the draft:

| Original citation | Corrected | Note |
|---|---|---|
| `src/index.ts:462` (getJobStore null collapse) | `src/index.ts:461` | null assignment is at 461 |
| `src/index.ts:7055` (async tools not registered) | gate computed `src/index.ts:6680-6681` (`hasStore()`), applied `src/index.ts:8649` | `if (asyncJobsEnabled)` |
| `src/index.ts:7063` (validation/`job_*` registered unconditionally) | `src/index.ts:6688` | `registerValidationTools()` called unconditionally |
| `src/index.ts:10976-11003` (`llm_request_result` owner check) | `src/index.ts:10269-10330`, check at `10305-10306` | tool defn + `principalCanAccess` |
| `docs/agent-assurance-runtime-conformance.md:46-89,122-131` (`receipt_hash?` placeholder) | removed | that file is assertion-bundle/Merkle-ledger hashing, unrelated; the `receipt_hash?` placeholder was in the superseded proposal, not on disk |

Citations confirmed accurate (spot list): `src/validation-orchestrator.ts`
(`startValidationRun` 140-189, `validationId = randomUUID()` 144, provider
`correlationId` 287, status enums 131 / 159-160), `src/validation-report.ts`
(status enum 8, synthesis enum 19, `ValidationReport` 26 / 98, disagreements 48,
confidence 54, perModelOutputs 62-73, structuredContent 82-96, limitations
139-166, job_result reference note 163), `src/validation-normalizer.ts`
(`normalizeStartedJob` 38-60, extraction 78-120), `src/validation-tools.ts`
(`compare_answers` local_summary_only 145-171, consensus/ask_model 206-258,
`synthesize_validation` lacks `validationId` 263-269, `job_status`/`job_result`
lack owner check 328-372), `src/validation-prompts.ts` ("one independent
reviewer ... Do not claim consensus" 21-23), `src/request-context.ts`
(`resolveOwnerPrincipal`, `principalCanAccess`), `src/job-store.ts` (schema
setup + idempotent migration 243-299, eviction 404 / 492-496, MemoryJobStore
process-lifetime 516-520, PostgresJobStore stub throws 654-660),
`src/config.ts` (`asyncJobsEnabled` 327, memory process-lifetime 95),
`src/flight-recorder.ts` (`_migrations` 279-322).

## Implementation phases

(To be filled by the implementing agent, per
`cross-llm-validation-receipts.implementation-prompt.md`. One section per DAG
step: changed files, implementation notes, validation results.)

## Multi-LLM review rounds

Reviewers: Codex, Gemini, Grok. Approval must be based on inspected code, tests,
docs, and persistent review evidence, never on intent or plan-compliance claims.
Each reviewer was dispatched with full access (Codex danger-full-access, Gemini
yolo, Grok bypassPermissions) and local filesystem + MCP tool access, given the
corrective spec, the DAG + doc set, and the exact `master...plan/cross-llm-validation-receipts`
diff. Polled at 90s cadence.

### Round 1 (planning-artifact review)

Dispatch:

- Codex: `c08f0d04-2363-4d2b-9014-62c3abb253d5`, correlationId `clvr-review-codex-r1`.
- Gemini: `2890ad72-d24e-4122-b6e7-d706413b6032`, correlationId `clvr-review-gemini-r1`.
- Grok: `b0901488-8b06-476e-ae23-9d5b784008af`, correlationId `clvr-review-grok-r1`.

Round 1 endings:

- Gemini: `UNCONDITIONAL APPROVAL` (verified all 7 claim groups against source).
- Grok: `UNCONDITIONAL APPROVAL` with two non-blocking notes (an off-by-2 on the
  `principalCanAccess` citation, and that `startValidationRun` is a pure function
  today so the run-row write is new work). The off-by-2 note is itself imprecise:
  the `if (!record || !principalCanAccess(...))` is at `src/index.ts:10305`
  (the F3b comment is at 10302-10303), so the draft's `10305-10306` stands. The
  "new work" note is correct and is exactly what the `durable-validation-runs`
  step describes as target work; no false claim about today's code.
- Codex: `NOT APPROVED with findings`. Three findings, all verified accurate
  against source and all accepted (no rebuttal):
  1. (blocking) "Models never see each other's output" was overstated. The
     fan-out reviewers are isolated, but `buildJudgePrompt` embeds
     `JSON.stringify(input.providerResults)` (`src/validation-prompts.ts:64-77`)
     and `startJudgeSynthesis` passes completed provider results into it
     (`src/validation-orchestrator.ts:231-237`), so the judge DOES see prior
     model outputs. Fixed in draft §0.4, dag meta comment, and pr-body.
  2. (blocking) The "same invariant as `*_request_async`" precedent was
     imprecise: `asyncJobsEnabled` is true for `memory` too (`src/config.ts:327`)
     and `*_request_async` registers under the ephemeral memory store, so the
     receipt's sqlite-only gate is the same CONSTRUCTION but a STRICTER predicate,
     not the same invariant. Codex confirmed the receipt gate design itself is
     source-supported. Reworded in draft §2, dag `[decision]` reason, and dag
     `validation-receipt-tool` step.
  3. (non-blocking) `src/resources.ts` already serves more than
     sessions/models/metrics (also `cache-state://`,
     `provider-subcommands://catalog`, `provider-tools://catalog`,
     `src/resources.ts:241,252`). Corrected in draft §8 and dag `phase3` step.

All three findings were wording/claim-accuracy defects, not design defects; the
gate design, mint lifecycle, ownership model, and table shapes were confirmed
correct by all three reviewers. Corrections committed; re-dispatched for Round 2.

### Round 2 (re-review of corrected artifacts)

Dispatch (on commit `3398d40`):

- Codex: `1ffaa5d9-6dd3-44cf-8b9d-37017e71d831`, correlationId `clvr-review-codex-r2`.
- Gemini: `a8ff9d9f-c23d-47a7-94ba-8ba0e4a7a245`, correlationId `clvr-review-gemini-r2`.
- Grok: `4d79630f-c8fa-4147-949a-40e9b09ab973`, correlationId `clvr-review-grok-r2`.

Round 2 endings:

- Gemini: `UNCONDITIONAL APPROVAL`. Re-verified all three round-1 fixes against
  source and re-confirmed every load-bearing claim; also ran the suite (108 test
  files / 1,719 tests pass, prettier + release security audit pass).
- Grok: `UNCONDITIONAL APPROVAL`. Exhaustive re-verification of all three fixes
  and every load-bearing claim; confirmed the `principalCanAccess` citation is
  exact at `src/index.ts:10305` (resolving the round-1 off-by-2 note in our
  favour). No defects remain.
- Codex: `NOT APPROVED with findings`. Confirmed all three round-1 fixes are now
  accurate. Two NEW findings, both accepted:
  1. (blocking) `cross-llm-validation-receipts.pr-body.md` presented unbuilt work
     in shipped tense ("now apply", "gain terminal value(s)") while no source is
     changed on the planning branch (`src/validation-report.ts:6`,
     `src/validation-tools.ts:328` still unchanged). Fixed: added a STATUS
     TEMPLATE banner and reworded the "What the implementation PR will change"
     section to forward-looking tense.
  2. (non-blocking) this verification file claimed the draft was "unchanged in
     substance," which stopped being true after the round-1 wording fixes. Fixed:
     the planning-baseline note now records the round-1 substantive draft edits.

Corrections committed; re-dispatched for Round 3.

### Round 3 (re-review of doc-honesty corrections)

Dispatch (on commit `eb08bf3`):

- Codex: `0ae0ed98-f228-4c23-92e2-f74d4b88807a`, correlationId `clvr-review-codex-r3`.
- Gemini: `16e50979-7b5c-4414-a874-1173d71e7aa9`, correlationId `clvr-review-gemini-r3`.
- Grok: `5a266974-5361-44ad-85e6-59a46e1d0b5c`, correlationId `clvr-review-grok-r3`.

Round 3 endings:

- Gemini: `UNCONDITIONAL APPROVAL`. Both doc fixes verified; all load-bearing
  claims re-confirmed against source; no regressions.
- Grok: `UNCONDITIONAL APPROVAL`. Verified the 6-file docs-only diff, both fixes,
  and every load-bearing claim against current source; no defects remain.
- Codex: `NOT APPROVED with findings`. Accepted the verification-note fix as
  accurate, but found the pr-body banner alone insufficient: the Summary
  (`pr-body.md:14-18`) and the Gating / Explicitly-NOT sections (`pr-body.md:78-93`)
  still used shipped tense on a planning-only branch. Fixed: the entire pr-body
  body is now forward-looking (Summary, Gating, Explicitly-NOT all reworded to
  "will"), with an explicit note that none of it exists on the branch yet
  (`src/validation-report.ts` / `src/validation-tools.ts` untouched).

### Round 4 (final pr-body tense fix)

Gemini and Grok had already given unconditional approval at `eb08bf3`; the Round 4
delta is confined to the pr-body tense within the exact file Codex flagged, so
only Codex (the holdout) was re-dispatched.

Dispatch (on commit `3e9a521`): Codex `dc2119bb-f788-41d6-a042-4f514688aa65`,
correlationId `clvr-review-codex-r4`.

Round 4 ending:

- Codex: `NOT APPROVED with findings`. The pr-body body was confirmed fully
  forward-looking, but the pr-body "Verification" section still implied
  `verification.md` already held per-phase implementation notes and final
  approvals, when it holds only planning + rounds 1-3 with placeholders. Fixed:
  the pr-body "Verification" section and this file's opening paragraph are now
  forward-looking about the implementation-phase content (placeholders today).

### Round 5 (final verification-section tense fix)

Dispatch (on commit `ba8037f`): Codex `9e85b269-cd64-4044-829e-34ea7d928c6e`,
correlationId `clvr-review-codex-r5`. Gemini + Grok approvals from Round 3 stand;
the only deltas since are forward-looking-tense wording in the two docs Codex
flagged, which cannot regress the technical substance they verified.

Round 5 ending:

- Codex: `UNCONDITIONAL APPROVAL`.

## Final review status (planning-artifact gate)

All three reviewers gave unconditional approval based on inspected code and docs,
verifying every claim against source rather than against any summary:

- Codex (gpt-5.4): `UNCONDITIONAL APPROVAL` at round 5 (commit `ba8037f`), after
  four rounds of valid findings, all resolved with code/doc evidence.
- Gemini (gemini-3-pro-preview): `UNCONDITIONAL APPROVAL` (rounds 1-3; also ran
  the suite, 1,719 tests pass).
- Grok (grok-build): `UNCONDITIONAL APPROVAL` (rounds 1-3).

Every finding raised across the gate was a documentation-accuracy defect (an
overstated claim or shipped-tense wording), not a design defect. The gate
confirmed the technical substance throughout: the durability gate (sqlite +
attached store, not `asyncJobsEnabled`), the §5a `job_status` / `job_result`
owner-check hole, the absence of a terminal report state today, the
eviction-vs-mint timing, the job-store migration pattern, the judge's visibility
of provider results, and the DAG's faithful encoding of the corrective spec. This
gate covers the PLANNING artifacts; the implementation-phase review is a separate
future gate run after the code lands.
