# Test-veracity mutation-probe audit — 2.2.0 release gate

Scope: the 4 tests added since 2.1.0, all in
src/__tests__/mcp-surface-usability.test.ts (commit 3d11be0, MCP tool-surface
usability slice). The test file itself was line-inspected by all four review
seats during the slice's 4-round gate; this audit adds kill-evidence that the
tests are real (non-tautological).

## Probes (run 2026-06-07, clean tree at 3d11be0)

| # | Mutation | Target test | Result |
|---|----------|-------------|--------|
| P1 | blank one tool description (list_available_models → "") | "every registered tool carries a clear description (>= 20 chars)" | KILL |
| P2 | replace job_status description with generic text (drop VALIDATION/llm_job_status markers) | "job_status/job_result descriptions disambiguate from llm_job_*" | KILL |
| P3 | make buildServerInstructions advertise *_request_async unconditionally | "server instructions advertise async/job tools only when they are registered" | KILL |
| P4 | force the derived asyncJobsEnabled gate to true (register async tools on backend=none) | "backend=none registers no async/job tools" | KILL |

Post-revert: 4/4 tests pass on the clean tree; `git status` shows no tracked
src/ modifications.

Note (carried from the slice review, advisory): the deferral-gating code path
in awaitJobOrDefer has structural coverage only (tool-absence invariant); a
behavioural inline-result-on-none integration test remains follow-up work.

Verdict: 4/4 probes kill; release gate satisfied pending auditor verification.

## Auditor round (Codex executing; Gemini/Grok/Mistral read-only)

Codex re-executed P1-P4 independently: 4/4 KILL, post-revert 4/4 pass, tree
byte-identical. Grok and Mistral requested sub-assertion coverage; resolved
with four additional probes (run 2026-06-07):

| # | Mutation | Sub-assertion killed | Result |
|---|----------|----------------------|--------|
| P5 | job_result description loses the VALIDATION/llm_job_result markers | T2 job_result check | KILL |
| P6 | compare_answers description loses "does not call any provider" | T2 compare_answers check | KILL |
| P7 | enabled-branch deferral line loses "auto-defers"/poll wording | T3 withAsync positives | KILL |
| P8 | deferral line emitted as a single-quoted string (literal ${SYNC_DEADLINE_MS}) | T3 interpolation guard | KILL |

Post-revert: 4/4 pass, tree clean. Operational note: the executing and
read-only seats ran concurrently and Grok transiently observed Codex's P2
mutation in the shared tree (handled by re-running from a detached worktree);
future audits should serialize the executing seat or isolate it in a worktree.

Final verdict: 8/8 probes kill across all primary and contested sub-assertions.

## Gemini seat addendum (ran pre-P5/P8; remaining gap closed)

Gemini's findings overlapped Grok/Mistral (interpolation guard → P8;
job_result/compare_answers → P5/P6) with one new item: the T1 tool-count floor
(>= 37) was unprobed. P9 (2026-06-07): delete the entire list_available_models
registration → T1 KILL (count floor + description loop both bind). Handler
presence is asserted separately by the 2.1.0 callback-forwarding test
(typeof tool.handler === "function" for every provider tool).

Final: 9/9 probes kill.

### Correction (process integrity)

The first P9 run recorded above was INVALID: the mutation script's text
pattern no longer matched (prettier had reformatted the registration), the
probe never applied, and the runner mis-reported. Caught immediately after
push; P9 was re-executed against the actual registration (deleting
src/validation-tools.ts lines 228-233 wholesale): T1 FAILED under the
mutation (KILL, now genuinely verified), 4/4 pass after revert. Lesson
recorded: probe runners must assert mutation application (the assert fired
correctly — the failure was committing the doc before reading the runner
output).

## Post-release gate correction (Codex finding, LOW)

The P5 row above overclaimed: the test asserted only /VALIDATION/ on
job_result (not the llm_job_result marker), so P5 killed via the VALIDATION
assertion alone — Codex proved it by removing only the llm_job_result marker,
which survived 4/4. Resolution: the test now also asserts /llm_job_result/ on
job_result's description (parity with job_status), and the finer mutation
(P5b) was re-run: KILL. Clean tree: 4/4 pass.
