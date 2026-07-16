---
name: multi-llm-consensus
description: Obtain complete, evidence-backed agreement from a required roster of llm-cli-gateway providers. Use for high-stakes generation, conflict resolution, or final quality gates that require unconditional approval from every required reviewer.
---

# Multi-LLM Consensus

Use the local gtwy stdio MCP server to obtain independent evidence from the
required provider roster, reconcile disagreements, and continue until every
required reviewer gives an unconditional verdict. Do not invoke provider CLIs
directly for consensus or review requests.

The complete CLI roster is Claude, Codex, Gemini, Grok, Mistral, Devin, and
Cursor. Confirm the live usable roster first with provider_tool_capabilities.
A deliberately scoped subset is valid only when the user or governing process
explicitly chose it. A required provider that is unavailable is a blocker, not
a successful consensus with fewer voters.

Configured API providers are dynamic rather than members of this canonical CLI
roster. Discover them with `list_models` and reported capabilities. They do not
have a local CLI checkout/worktree or native ACP guarantee and must not silently
replace a required source-inspecting CLI consensus reviewer.

## Consensus Contract

For a mandatory approval review:

1. Give every required reviewer the same target, revision, acceptance criteria,
   and evidence requirements.
2. Require the terminal JSON verdict `APPROVED_UNCONDITIONALLY`,
   `CHANGES_REQUIRED`, or `BLOCKED_EXTERNAL` with evidence-backed findings.
3. Use approvalStrategy: "legacy" for Codex, Gemini, Grok, Mistral, Devin, and
   Cursor. They reject mcp_managed and their approvalPolicy fields have no
   effect. Use mcp_managed only for a deliberately configured Claude request.
4. Use sandboxMode: "read-only" for an inspection-only Codex review, or
   sandboxMode: "workspace-write" only when it must create build or test
   artifacts. Do not use fullAuto.
5. Do not impose a review-round, turn, token, price, cost, or wallclock cap.
   The configured idle-timeout safeguard is only for lack of process output.
6. Accept the gate only when every required reviewer gives explicit,
   evidence-backed `APPROVED_UNCONDITIONALLY`. Conditional approval, residual
   issues, a malformed response, inability to verify, cancellation, timeout, or
   provider failure is not approval.

Repair findings or evidence and re-dispatch as long as work remains. Stop only
on explicit user cancellation or a terminal external provider failure. Preserve
that failure as `BLOCKED_EXTERNAL` with the exact error; never count it as
agreement or silently shrink the roster.

## Explicit user-authorized full-access consensus

For a user who explicitly grants every reviewer full provider permissions and
native MCP access, use the full `multi-llm-review` protocol, not the normal
read-only examples below. Build the exact target checkout and start
`node dist/index.js --transport=stdio` from it for the review. Do not use a
globally installed or stale `gtwy` process.

Apply the per-provider full-access controls to each fresh job and verify their
live capability. Do not use gateway allowlists or deny lists as a substitute for
native MCP access, and do not assume a resumed job retained a grant. Give every
reviewer a verification report as a corrective-program specification with the
exact base, diff or exhaustive changed-file list, relevant untracked files, and
durable job/test evidence. Require direct inspection of source, docs, tests,
commands, and native MCP facts. A response must be
`APPROVED_UNCONDITIONALLY`, evidence-backed `CHANGES_REQUIRED`, or a concrete
`BLOCKED_EXTERNAL` condition. Do not impose caller caps; on a user-required
90-second progress cadence, wait non-blockingly and do not poll early.

## Target the Same Repository

| Provider                     | Local target rule                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude, Codex, Grok, Mistral | Use workingDir on a new session, or select a registered workspace explicitly or by configured default.                                     |
| Gemini                       | It has no workingDir. includeDirs is auxiliary and does not select cwd. Select a registered workspace explicitly or by configured default. |
| Devin                        | Use workingDir on a new CLI session, or select a registered workspace explicitly or by configured default.                                 |
| Cursor                       | Set workspace to the local directory or registered alias.                                                                                  |

Do not use workspace_* tools to fix a local stdio targeting failure. For managed
Claude, a custom working directory or other posture-expanding input needs its
gateway approval decision and operator bypass configuration.

## Full-Roster Unanimous Review

Use async gateway tools so the independent reviews can run in parallel. Apply
the target rule before each call.

```
claude_request_async({
  prompt: "Review [target] for correctness, architecture, maintainability,
    security, and test coverage. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "consensus-claude"
})

codex_request_async({
  prompt: "Review [target] for correctness, edge cases, regressions, and tests.
    Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  sandboxMode: "read-only",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "consensus-codex"
})

gemini_request_async({
  prompt: "Review [target] for security, data flow, edge cases, and operational
    risks. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workspace: "[verified Gemini workspace]",
  correlationId: "consensus-gemini"
})

grok_request_async({
  prompt: "Independently review [target] for assumptions and issues the other
    reviewers might miss. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "consensus-grok"
})

mistral_request_async({
  prompt: "Independently review [target] for implementation and maintainability
    risks. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "consensus-mistral"
})

devin_request_async({
  prompt: "Independently review [target] for security, correctness, and
    verification gaps. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  correlationId: "consensus-devin"
})
// Dispatch Devin only from a gateway process whose confirmed cwd is [repo].

cursor_request_async({
  prompt: "Independently review [target] for repository-specific defects,
    usability concerns, and regressions. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workspace: "[repo]",
  correlationId: "consensus-cursor"
})
```

Poll each job through gtwy with llm_job_status and collect it with
llm_job_result. Use non-blocking waits. Do not cancel a required review because
it takes a long time.

If persistence.backend = "none" and async tools are not registered, dispatch
the same required roster with the corresponding sync request tools. Those calls
run to completion without auto-deferral; do not use the absence of async jobs
to shrink the review scope.

## Reconcile Evidence, Not Votes

For generation or design choices:

1. Compare the implementation, testable claims, and supporting evidence.
2. Treat any disagreement as a question to investigate, not a vote to
   overrule an outlier.
3. Run focused validation, revise the specification, or ask a reviewer to
   inspect the competing evidence.
4. Send the corrected context back to every required reviewer.

For approval gates:

- Union all findings.
- Resolve every finding or establish evidence that the reviewer accepts.
- Re-run all required reviewers after material changes, not just the one that
  found the issue.
- Do not transform a qualified approval into an unconditional one. Require a
  fresh explicit verdict.

## PromptParts and Stable Context

Claude, Codex, Gemini, Grok, and Mistral accept promptParts. Devin and Cursor
accept only flat prompt. Keep a canonical exact review text, deliver it as
prompt to Devin and Cursor, and use identical stable structured context for the
other five:

```
codex_request_async({
  promptParts: {
    system: "Stable consensus review rules",
    context: "Stable target paths, revision, and acceptance criteria",
    task: "Review independently. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence."
  },
  sandboxMode: "read-only",
  workingDir: "[repo]",
  approvalStrategy: "legacy"
})
```

Use exactly one of prompt or promptParts. Cache-state resources offer aggregate
hashes and token data only. They can validate prefix discipline but never prove
review completeness.

## Sessions, Persistence, and Kit Mode

Mistral Vibe uses approvalStrategy: "legacy" and defaults its programmatic
agent mode to accept-edits. Current Vibe defaults session logging to enabled.
Before relying on Mistral resume, run doctor and correct an explicit
[session_logging] enabled = false setting.

Codex native continuation requires a real Codex UUID and inherits its original
target and sandbox posture. Each other provider has provider-native continuity;
verify the live capability before relying on a stored handle.

SQLite and Postgres persistence retain async jobs durably. Memory persistence is
process-lifetime only and needs explicit acknowledgement; persistence.backend =
"none" does not register async or job tools. Do not equate a failed persistence
surface with a successful review.

Personal Agent Config Kit supports Claude and Codex only and requires durable
job admission. It cannot run a complete seven-provider consensus. Treat that
as a scope blocker unless the user explicitly chooses a different review scope.
The usual Claude `workingDir` rule does not apply to a Claude Kit request: it
rejects caller-supplied `workingDir` before context compilation. Use
`explain_effective_config({workingDir:"<repo>"})` only to inspect a candidate
scope, then select Claude's target through an already configured registered
`workspace` alias or the configured default workspace. It never inherits the
gateway process cwd.
