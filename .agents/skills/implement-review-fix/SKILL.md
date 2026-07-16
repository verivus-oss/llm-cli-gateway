---
name: implement-review-fix
description: Implement a change, obtain complete evidence-backed review through the local stdio gateway, fix findings, and repeat without arbitrary review limits. Use for features, bugs, or refactoring.
metadata:
  author: verivus-oss
  version: "1.7"
---

# Implement, Review, Fix

Use one parent orchestrator. It may call gateway providers, but provider jobs do
not recursively orchestrate other providers. Every review dispatch uses the
installed local stdio gateway MCP surface, never a direct provider binary, SDK,
connector/shadow gateway, or ad hoc shell fallback.

## Outcome contract

The cycle ends only after the final change set has relevant local verification
and every required reviewer returns evidence-backed
`APPROVED_UNCONDITIONALLY`. Do not use an arbitrary review-round, turn, token,
price, budget, or wallclock cap. A timeout, malformed reply, residual
condition, unavailable reviewer, or qualified approval is not approval.

Repair and re-review until all required reviewers approve. If a provider reaches
a terminal external failure, retain the error/repair evidence and report
`INCOMPLETE` or `BLOCKED`; do not silently reduce the review roster. Stop only
on explicit user cancellation or after reporting the terminal blocker.

## Explicit user-authorized full-access review override

Keep the ordinary implementation and inspection defaults below unless the user
explicitly authorizes full provider permissions and native MCP access for the
review. In that case, follow the complete `multi-llm-review` full-access
protocol rather than weakening it into a safe-default example: build the target
checkout, launch `node dist/index.js --transport=stdio` from that checkout, and
do not use a globally installed or stale gateway process.

Apply the current provider-native full-access control on every new review job,
preserve ambient provider MCP configuration without gateway tool allowlists,
and do not assume a resumed session retained the grant. Give every reviewer the
verification report as a corrective-program specification plus the exact base,
diff or changed-file list, and persistent evidence locations. Require
independent code, docs, tests, and command inspection. A report claim, intent,
or green-check summary is never approval; a disputed finding needs direct
code/doc/test evidence.

Do not set caller review caps. When the user requests a 90-second progress
cadence, make a non-blocking wait and do not poll earlier. Re-run the complete
required roster after every material change until each reachable reviewer returns
`APPROVED_UNCONDITIONALLY` or records a concrete `BLOCKED_EXTERNAL` condition.

## 1. Establish the target and roster

1. Capture the exact target repository, base/head or dirty worktree state,
   changed-file list, relevant specs, and intended invariants.
2. Call `cli_versions()`, `list_models()`, and
   `provider_tool_capabilities({cli:"..."})` for Claude, Codex, Gemini, Grok,
   Mistral, Devin, and Cursor.
3. Use the target-routing matrix in `multi-llm-review`: explicit `workingDir`
   for Claude/Codex/Grok/Mistral/Devin, a verified registered `workspace` for
   Gemini, and `workspace` for Cursor. Do not let a default workspace decide the
   review target. An unscoped child uses a neutral temporary cwd, not the
   gateway repository.
4. Start an exhaustive CLI review roster with all seven canonical providers.
   If the user explicitly asks for a narrower scope, record excluded providers
   and the limitation before dispatching.

`approvalStrategy:"mcp_managed"` and `approvalPolicy` are Claude-only. For
Claude managed work, `workingDir`, selectors, native continuation, and other
posture changes require an approval decision plus
`LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`. Codex, Gemini, Grok, Mistral, Devin, and
Cursor use `approvalStrategy:"legacy"`.

## 2. Implement with an explicit workspace

Gateway tool call:

```text
codex_request({
  prompt:"Implement <feature> in <repo>. Requirements: <requirements>. Update focused tests and report commands actually run.",
  workingDir:"<repo>",
  sandboxMode:"workspace-write",
  approvalStrategy:"legacy",
  correlationId:"implementation"
})
```

Use `sandboxMode:"read-only"` only for inspection. `fullAuto:true` is a
deprecated compatibility shorthand for `workspace-write`; do not use it in new
dispatches. A resumed Codex session drops sandbox selection, so choose a fresh
session if the required native posture has changed.

Run the smallest relevant local tests/builds after implementation. Preserve the
commands, outputs, change set, and any failures as review evidence.

## 3. Build the review packet

For a normal read-only Git review, prefer `review_changes` when its durable
SQLite/PostgreSQL validation surface is registered. It constructs the complete
hashed committed/staged/unstaged/untracked packet without truncation and starts
repository-bound read-only reviewers. Collect its returned validation
`job_status`/`job_result` references for progress and human visibility. If a
judge was requested, wait for terminal results, then call
`synthesize_validation` with the `validationId` and same repository selector.
For `review_changes`, do not pass caller results as evidence: synthesis ignores
caller `question`/`providerResults`, reloads exact owned durable linked terminal
jobs, reconstructs unavailable requested seats as skipped, and atomically claims
the stored judge once. Stored repository, owner, judge, and consent are
authoritative. General validation still requires caller question/results. Use
the custom packet below when the user-authorized full-access protocol is
required or the target is not a Git change set.

Include:

- Base/head identifiers or an explicit uncommitted-worktree statement.
- Exact diff and changed-file list.
- Requirements, invariants, migration/deployment behavior, and docs contract.
- Tests/build/lint/typecheck commands actually run with their outcomes.
- Earlier reviewer findings and evidence-backed responses.

Require reviewers to open source/tests/docs directly and return strict JSON:

```json
{
  "verdict": "APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL",
  "findings": [
    {
      "file": "src/example.ts",
      "line": 1,
      "issue": "...",
      "evidence": "...",
      "suggested_fix": "..."
    }
  ],
  "inspected": ["..."],
  "reviewed_change_identity": "exact diff artifact or exhaustive file list"
}
```

The packet is a claim, not proof. A reviewer that cannot inspect a claimed
input must report `CHANGES_REQUIRED` with evidence or `BLOCKED_EXTERNAL` with
its exact external access error.

## 4. Review through the full roster

Use `*_request_async` when async tools are registered and dispatch the seven
provider calls described in `multi-llm-review`. They are gateway tool calls, not
shell commands. Start all required reviewers with the same substantive packet,
provider-appropriate target routing, and an explicit strict verdict clause.

- For a pure source review, start Codex with `sandboxMode:"read-only"`; move to
  `workspace-write` only when it must run checks that write artifacts.
- The preceding safe Codex posture is not the explicit full-access override.
  For that user-authorized case, use the full provider mapping in
  `multi-llm-review`, including Codex `sandboxMode:"danger-full-access"` and
  `dangerouslyBypassApprovalsAndSandbox:true` on a fresh session.
- Do not pass Claude `allowedTools` or `tools` selectors in a routine managed
  review. They are high-risk managed inputs, not a way to guarantee access.
- Gemini rejects non-empty `allowedTools`, `skipTrust:true`, JSON/stream-JSON
  output, and unsupported policy/attachment fields in the Antigravity path.
- Devin and Cursor take flat `prompt` only. Claude/Codex/Gemini/Grok/Mistral can
  receive `promptParts`, but it is mutually exclusive with `prompt`; keep the
  canonical flat packet for the two providers that do not support it.

SQLite/PostgreSQL jobs survive restarts. Acknowledged memory jobs do not, and
`persistence.backend = "none"` has no async/job tools. Poll with a non-blocking
cadence, but never treat cadence as a review deadline.

## 5. Triage, fix, and re-review

1. Verify every finding against source, tests, docs, or upstream references.
2. Fix correct findings in the target workspace and run focused verification.
3. For a disputed finding, send the same reviewer exact counter-evidence. It
   must withdraw or revise the finding with evidence; assertion is not rebuttal.
4. Refresh the packet and exact diff after every change.
5. Re-dispatch every reviewer whose prior verdict is not unconditional and any
   reviewer whose evidence predates the changed diff.
6. Repeat until all required reviewers unconditionally approve the final exact
   change set.

## Session and Kit boundaries

`session_create` creates gateway bookkeeping, not a generic provider-native
conversation. Use a provider-native handle only when the provider response and
its capability record say it is resumable. Do not pass a gateway `gw-*` ID as a
native session ID. Codex needs a real Codex UUID or `resumeLatest:true`; Gemini
only reports `resumable:true` for a caller-supplied usable conversation ID.

Personal Agent Config Kit is local-only and supports only Claude/Codex with
healthy SQLite/PostgreSQL durable admission. It disables validation and
least-cost routing. If an effective Kit profile caps turns or budget, it cannot
produce an unconditional exhaustive review. Use
`explain_effective_config({workingDir:"<repo>"})` first, then obtain an
uncapped approved profile or explicit user direction rather than silently
lowering the review scope.

That `workingDir` is valid for read-only Kit inspection only. A Claude Kit
request rejects caller-supplied `workingDir` before it compiles context. Target
Claude Kit execution through an already configured registered `workspace` alias
or the configured default workspace. It never inherits the gateway process cwd.

## Do not do this

- Do not call a provider CLI directly for implementation review.
- Do not use `route_request`, `select:"cheapest"`, a cost cap, or a fixed number
  of review rounds for a mandatory review.
- Do not skip unavailable providers or accept conditional approval.
- Do not use Claude managed approval on a non-Claude request.
- Do not treat cache hashes, a session record, a summary, or a green plan as
  substitute evidence for inspection and verification.
