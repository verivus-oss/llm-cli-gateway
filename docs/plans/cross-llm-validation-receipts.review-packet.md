# Cross-LLM Validation Receipts: review packet

This packet defines exactly what each reviewer (Codex, Gemini, Grok) receives and
the rules of the review gate. It applies to the planning-phase review (DAG + doc
set) and, later, to the implementation-phase review (the code diff).

## What is under review (planning phase)

The new and modified planning artifacts on branch
`plan/cross-llm-validation-receipts`:

```text
docs/plans/cross-llm-validation-receipts.dag.toml              (new)
docs/plans/cross-llm-validation-receipts.implementation-prompt.md (new)
docs/plans/cross-llm-validation-receipts.pr-body.md           (new)
docs/plans/cross-llm-validation-receipts.verification.md      (new)
docs/plans/cross-llm-validation-receipts.review-packet.md     (new)
docs/plans/cross-llm-validation-receipts.draft.md             (citation fixes)
```

The exact diff is `git diff master...plan/cross-llm-validation-receipts` in the
repo at `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`.

## What each reviewer is given

1. The corrective-program spec:
   `docs/plans/cross-llm-validation-receipts.draft.md`. This is the verification
   report the plan is built from. It contains the code-grounded rationale and the
   (now corrected) code citations.
2. The plan under review:
   `docs/plans/cross-llm-validation-receipts.dag.toml` plus the doc set above.
3. The exact changed-file list / diff (above).
4. Full filesystem and MCP tool access to the repo, so every claim can be checked
   against the actual source.

## Review rules (binding)

- Verify every claim against the actual code and docs in the repo. Do NOT accept
  Claude's summary, the spec's prose, or the DAG's prose as evidence. Open the
  cited files at the cited lines and confirm.
- Confirm that the DAG faithfully and correctly encodes the corrective spec, that
  the spec's code citations are accurate after the fixes, and that the design is
  implementable as written against the current codebase.
- Specifically scrutinise:
  - The durability gate claim (sqlite + attached store, NOT `asyncJobsEnabled`):
    check `src/config.ts`, `src/job-store.ts`, and the registration sites in
    `src/index.ts`.
  - The §5a security claim that `job_status` / `job_result` lack the
    `principalCanAccess` check the `llm_job_*` paths enforce: check
    `src/validation-tools.ts` and the `llm_job_*` / `llm_request_result` paths in
    `src/index.ts`.
  - The "no terminal report state today" claim: check the status enums in
    `src/validation-report.ts` and the derivation in
    `src/validation-orchestrator.ts`.
  - The eviction-versus-mint timing claim: check the retention/eviction logic in
    `src/job-store.ts`.
  - The reviewer-isolation framing: the fan-out reviewers never see each other's
    output, but the optional judge synthesis DOES see the collected provider
    results. Check `src/validation-prompts.ts` (`buildValidationPrompt` header vs.
    `buildJudgePrompt` embedding `providerResults`) and
    `src/validation-orchestrator.ts` (`startJudgeSynthesis`).
  - The job-store migration pattern claim (no `_migrations`, idempotent
    `CREATE TABLE IF NOT EXISTS`): check `src/job-store.ts` and
    `src/flight-recorder.ts`.
- If you find a defect, state it as a concrete, code-cited finding with the
  file:line and the corrected fact, and label it blocking or non-blocking.
- Do NOT approve based on intent, plan-compliance claims, or "should be fixed"
  language. Approve only on inspected code, tests, docs, and persistent review
  evidence.
- End your review with exactly one of:
  - `UNCONDITIONAL APPROVAL`
  - `NOT APPROVED with findings` (followed by the concrete findings)
  - `BLOCKED: <concrete, unresolvable blocker>`

## Iteration protocol

- Claude polls each reviewer job no more than once every 90 seconds (permission
  grants in this run are not durable, so progress is checked on that cadence).
- If Claude disagrees with a finding, Claude replies with code/doc evidence
  (file:line), not assertion, and re-dispatches for re-review of the corrected
  artifact or the rebuttal.
- Iterate until every reviewer returns `UNCONDITIONAL APPROVAL` or a concrete
  blocker that cannot be resolved.
