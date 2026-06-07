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
