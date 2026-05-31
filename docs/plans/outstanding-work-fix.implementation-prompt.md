# Implementation Prompt: Execute Outstanding Work Fix Plan

Paste this prompt into a fresh coding-agent session opened from:

```bash
/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
```

Do not paste this header if the receiving agent does not need it.

---

## Task

Execute the DAG plan:

```text
/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/outstanding-work-fix.dag.toml
```

The objective is to fix the outstanding work review blockers from 2026-05-31:

1. `doctor --json` emits top-level `upstream`, but `setup/status.schema.json` rejects it.
2. Codex CLI flag assumptions drifted; the installed `codex exec` rejects `--ask-for-approval`.
3. `scripts/upstream-scan.mjs --probe-installed` must work offline, not only under `--live`.
4. The Grok drift report/snapshot must be resolved or clearly quarantined as advisory evidence.
5. Formatting and targeted validation gates must be green.

Important correction: treat xAI Build docs as canonical for Grok Build wording:

- https://docs.x.ai/build/overview
- https://docs.x.ai/build/enterprise

Do not treat "Grok Build" naming as a bug. Preserve that wording unless canonical xAI docs and repo guidance require a specific copy change.

## Read First

Read these before editing:

- `docs/plans/outstanding-work-fix.dag.toml`
- `docs/guides/BEST_PRACTICES.md`
- `src/doctor.ts`
- `setup/status.schema.json`
- `src/request-helpers.ts`
- `src/index.ts`
- `src/upstream-contracts.ts`
- `scripts/upstream-scan.mjs`
- `docs/upstream/README.md`
- `docs/upstream/reports/2026-05-31-grok.md`
- `docs/upstream/snapshots/grok.json`
- `site/install.md`
- `site/index.html`
- `site/llms.txt`

If `AGENTS.md` exists in this checkout, read and follow it. Treat internal machine/release context as private and do not add secrets, private paths beyond already-local plan paths, account IDs, or credentials to tracked public-facing files.

## Non-Negotiable Review Requirement For Each Phase

For every phase below, before marking the phase complete, apply this requirement exactly:

> ask the other llm's for a detailed review, provide each with full access permissions and mcp tool access, on every iteration if permission grant is not durabe (only check on progress once every 90 seconds), provide the verification report used as the corrective-program spec; the exact commit/diff or changed-file list being reviewed; the other llm's must verify claims against code and docs, not accept your summary as evidence. If you disagree with a the other llm's finding, you must respond with code/doc evidence, not assertion. Iterate until the other llm's gives unconditional approval or lists a concrete blocker that cannot be resolved. Do not ask the other llm's to approve based on intent, plan compliance claims, or “should be fixed” language. Approval must be based on inspected code, tests, docs, and persistent review evidence.

Operational interpretation:

- Ask at least Codex, Gemini, Grok, and Mistral when available. Add Claude if available and useful.
- Give reviewers permission/full access suitable for code review in this local repo, plus MCP tool access. Use `sqry` for code inspection; include docs/search MCPs where available and relevant.
- If grants are not durable, do not spam status checks. Poll async review progress no more than once every 90 seconds.
- Provide each reviewer with:
  - the verification report or baseline notes being used as the corrective-program spec,
  - the exact `git diff`, commit range, or changed-file list under review,
  - the DAG phase/step IDs being reviewed,
  - the validation commands and outputs,
  - instructions to inspect code/docs directly and cite evidence.
- If a reviewer finding is wrong, rebut with file:line, command output, or canonical docs. Do not rebut with intent.
- Iterate fixes and re-review until every reviewer gives unconditional approval, or a reviewer identifies a concrete blocker that cannot be resolved inside this plan.

## Suggested Reviewer Dispatch

Use the gateway MCP async tools if available. Adjust tool namespace to the current environment.

Use these settings as the default:

- Codex: full access / no approval prompts where supported. Do not pass `askForApproval`; this plan exists partly because current Codex rejects that flag.
- Gemini: `approvalMode: "yolo"` or equivalent.
- Grok: full/bypass permission mode, `alwaysApprove: true`, and `mcpServers: ["sqry"]` unless ref/exa are known to work in this environment.
- Mistral/Vibe: auto-approve/trust mode.
- All reviewers: `mcpServers` should include `sqry`; include docs/search MCPs where working.
- Use unique `correlationId`s per phase, reviewer, and round.
- Poll no more often than every 90 seconds.

Reviewer prompt template:

```text
ROLE: Critical reviewer for llm-cli-gateway outstanding-work fix phase.

PHASE UNDER REVIEW
- Phase ID(s): <PHASE_OR_STEP_IDS>
- Repo root: /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
- DAG plan: docs/plans/outstanding-work-fix.dag.toml
- Implementation prompt: docs/plans/outstanding-work-fix.implementation-prompt.md

CORRECTIVE-PROGRAM SPEC / VERIFICATION REPORT
<paste baseline notes, command outputs, previous reviewer findings, and fix responses>

ARTIFACTS TO INSPECT
- Changed-file list: <git diff --name-only>
- Diff: inspect with `git diff` or `git show`; do not rely on this summary.
- Relevant docs: docs/upstream/README.md, docs/upstream/reports/2026-05-31-grok.md, xAI Build docs when reviewing Grok copy.

REVIEW REQUIREMENTS
1. Inspect code and docs directly. Do not accept the implementer's summary as evidence.
2. Verify each claimed fix against source, tests, docs, and command output.
3. Cite file:line, command output, or canonical URL for every finding.
4. If evidence is unavailable, say what could not be verified and why.
5. Do not approve based on intent, plan-compliance claims, or "should be fixed" language.
6. End with exactly one of:
   - UNCONDITIONAL APPROVAL
   - NOT APPROVED with findings
   - CONCRETE BLOCKER: <why it cannot be resolved in this phase>
```

## Phase 0: Baseline And Decisions

Execute DAG steps:

- `baseline-current-failures`
- `decide-codex-flag-policy`

Run and capture:

```bash
npm run build
npm test -- src/__tests__/doctor.test.ts src/__tests__/cli-entrypoint.test.ts src/__tests__/upstream-contracts.test.ts
npm run format:check
codex exec --help
codex exec resume --help
npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical
npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical
```

Write a short local verification note for this phase. It must include:

- current doctor schema result,
- Codex advertised flags and the compatibility decision,
- upstream-scan behavior with offline `--probe-installed`,
- format failures,
- whether Grok report drift is resolved, unresolved, or to be quarantined.

Then run the mandatory multi-LLM review requirement for Phase 0.

Do not edit behavior until Phase 0 review has unconditional approval or a concrete blocker.

## Phase 1: Doctor Schema Fix

Execute DAG step:

- `fix-doctor-schema-upstream`

Preferred implementation:

- Add `upstream` to `setup/status.schema.json` top-level `required`.
- Add a schema for the `upstream` block emitted by `src/doctor.ts`.
- Keep contract report internals permissive enough to avoid duplicating `upstream-contracts.ts` schema in the doctor schema, but strict enough for the public doctor envelope.

Alternative only if necessary:

- Remove the full contract report from `doctor --json` and keep a `next_actions` pointer to `contracts --json`.

Validate:

```bash
npm test -- src/__tests__/doctor.test.ts
```

Prepare a Phase 1 verification note with the diff, test output, and schema reasoning. Then run the mandatory multi-LLM review requirement for Phase 1. Iterate until unconditional approval or concrete blocker.

## Phase 2: Codex Contract And Argv Fix

Execute DAG step:

- `fix-codex-contract-and-argv`

Use the Phase 0 Codex decision. Likely targets:

- `src/request-helpers.ts`
- `src/index.ts`
- `src/upstream-contracts.ts`
- `src/__tests__/request-helpers.test.ts`
- `src/__tests__/codex-handler.test.ts`
- `src/__tests__/upstream-contracts.test.ts`

Rules:

- Do not emit `--ask-for-approval` if the installed/current Codex CLI does not accept it.
- Do not leave a contract flag that the current CLI rejects unless there is an explicit compatibility reason and test coverage.
- Any argv emitted by `prepareCodexRequest` must pass `validateUpstreamCliArgs("codex", args)`.
- Preserve backwards compatibility through explicit no-op/deprecation handling or clear error responses where needed. Avoid silently emitting bad flags.

Validate:

```bash
npm test -- src/__tests__/request-helpers.test.ts src/__tests__/codex-handler.test.ts src/__tests__/upstream-contracts.test.ts
npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical
```

If possible, repeat the local async smoke path that previously failed with `unexpected argument '--ask-for-approval'` and verify it no longer fails for that reason.

Prepare a Phase 2 verification note with the diff, test output, smoke evidence, and Codex help evidence. Then run the mandatory multi-LLM review requirement for Phase 2. Iterate until unconditional approval or concrete blocker.

## Phase 3: Upstream Scan Offline Probe Fix

Execute DAG step:

- `fix-upstream-scan-offline-probe`

Implementation goal:

- Move installed-help probing outside the `if (flags.live)` branch.
- Keep network fetching gated behind `--live`.
- Ensure `--probe-installed --fail-on-critical` exits non-zero when installed drift exists, even in offline scan mode.
- Keep report/snapshot writes gated by explicit write flags.
- Update `docs/upstream/README.md` if its wording implies `--probe-installed` requires live mode.

Validate:

```bash
npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical
npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical
npm run upstream:contracts
```

If final Codex/Grok drift is resolved and both scan commands exit zero, prove the red path with a temporary local mutation or documented provider drift evidence, then revert the mutation before committing.

Prepare a Phase 3 verification note with before/after scan behavior and command outputs. Then run the mandatory multi-LLM review requirement for Phase 3. Iterate until unconditional approval or concrete blocker.

## Phase 4: Grok Report Handling And xAI Build Copy

Execute DAG steps:

- `resolve-or-quarantine-grok-report`
- `preserve-xai-build-doc-copy`

Grok report handling:

- Either resolve Grok contract drift and regenerate report/snapshot so no unresolved critical finding remains, or quarantine/archive the report as advisory-only evidence.
- Do not ship a fresh release-bound report that says "critical" unless that is intentionally documented as unresolved advisory input.

xAI Build copy:

- Treat https://docs.x.ai/build/overview and https://docs.x.ai/build/enterprise as canonical.
- Preserve "Grok Build" wording.
- Only change install commands or wording if canonical docs and repo support guidance require it.

Validate:

```bash
npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical
npm run upstream:contracts
```

Prepare a Phase 4 verification note with the Grok report decision, xAI copy decision, changed-file list, and command outputs. Then run the mandatory multi-LLM review requirement for Phase 4. Iterate until unconditional approval or concrete blocker.

## Phase 5: Formatting And Final Gates

Execute DAG steps:

- `format-touched-files`
- `run-final-gates`
- `review-evidence`

Run formatting on touched TypeScript files. If `src/__tests__/read-persisted-request.test.ts` is still an unrelated pre-existing formatter failure, either:

- leave it untouched and document it as unrelated residual risk, or
- format it only if the repo gate requires it and the mechanical scope is acceptable.

Final targeted gates:

```bash
npm run build
npm run lint
npm test -- src/__tests__/doctor.test.ts src/__tests__/cli-entrypoint.test.ts src/__tests__/upstream-contracts.test.ts src/__tests__/request-helpers.test.ts src/__tests__/codex-handler.test.ts
npm run upstream:contracts
npm run format:check
```

If time allows:

```bash
npm test
```

Prepare the final verification report with:

- changed files grouped by finding,
- before/after behavior for doctor schema,
- before/after behavior for Codex argv,
- upstream scan offline-probe evidence,
- Grok report decision,
- xAI Build copy decision,
- exact commands and outcomes,
- any residual risk.

Then run the mandatory multi-LLM review requirement for Phase 5 using the final verification report and full changed-file list. Iterate until unconditional approval or concrete blocker.

## Final Handoff

Do not claim complete until:

- Every DAG step validation has passed or has a documented concrete blocker.
- Every phase has gone through the mandatory multi-LLM review loop.
- All reviewer disagreements are answered with code/doc evidence.
- Final gates are green, or any remaining failure is clearly documented as unrelated/pre-existing with evidence.

Final response should include:

- files changed,
- tests/commands run,
- review status by phase and reviewer,
- unresolved blockers or residual risks.
