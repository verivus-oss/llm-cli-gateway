---
name: multi-llm-review
description: "Run complete, evidence-backed code reviews through the local stdio gateway across the seven canonical CLI providers: Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor. Use for quality, security, correctness, or release validation that requires independent reviewers."
metadata:
  author: verivus-oss
  version: "1.8"
---

# Multi-LLM Code Review

Use this skill for a real review gate, not a popularity vote or a summary-only
second opinion. Dispatch review requests through the current agent's local
stdio gateway MCP surface, never a direct provider CLI, shadow connector, or
remote gateway when the requested validation path is stdio.

## Completion contract

A required reviewer is complete only when it inspected the target and returned
an evidence-backed `APPROVED_UNCONDITIONALLY`. A qualified approval, a
conditional result, missing evidence, a malformed response, a timeout, or a
provider error is not approval.

Do not set a review-round, turn, token, price, budget, or wallclock cap. Do not
use `route_request`, `select:"cheapest"`, `maxCostUsd`, `maxOutputTokens`,
`maxTurns`, `maxPrice`, or a provider print deadline to reduce an exhaustive
review. Continue evidence-based repair and re-review until every required
healthy reviewer returns `APPROVED_UNCONDITIONALLY`, the user explicitly
cancels, or it returns `BLOCKED_EXTERNAL` with a concrete external error. A
blocked reviewer never becomes an implied approval.

## Discover the actual roster

The gateway has seven canonical CLI provider types: Claude, Codex, Gemini
(Antigravity), Grok, Mistral Vibe, Devin, and Cursor Agent. Start a full CLI
review with all seven in its intended roster. Before dispatching, inspect what
this gateway can actually run:

```text
cli_versions()
list_models()
provider_tool_capabilities({cli:"claude"})
provider_tool_capabilities({cli:"codex"})
provider_tool_capabilities({cli:"gemini"})
provider_tool_capabilities({cli:"grok"})
provider_tool_capabilities({cli:"mistral"})
provider_tool_capabilities({cli:"devin"})
provider_tool_capabilities({cli:"cursor"})
```

Use `provider-tools://{provider}` as a cached read-only alternative. Optional
API providers are configured availability discovered through `list_models` and
their reported capabilities. They have no local CLI checkout/worktree or native
ACP guarantee, so they are not silently interchangeable with a required
source-inspecting CLI reviewer.

Record a roster before sending prompts:

| Provider | Available/authenticated | Target checkout verified | Required controls verified | Result              |
| -------- | ----------------------- | ------------------------ | -------------------------- | ------------------- |
| Claude   | yes/no                  | yes/no                   | yes/no                     | required or blocked |
| Codex    | yes/no                  | yes/no                   | yes/no                     | required or blocked |
| Gemini   | yes/no                  | yes/no                   | yes/no                     | required or blocked |
| Grok     | yes/no                  | yes/no                   | yes/no                     | required or blocked |
| Mistral  | yes/no                  | yes/no                   | yes/no                     | required or blocked |
| Devin    | yes/no                  | yes/no                   | yes/no                     | required or blocked |
| Cursor   | yes/no                  | yes/no                   | yes/no                     | required or blocked |

If the user explicitly requests a narrower review, name the excluded providers,
the reason, and the resulting limitation before dispatch. Otherwise repair an
unavailable required provider, its authentication, its workspace routing, or
its request shape. Do not skip it and call the result comprehensive.

## Verify the target checkout

Never allow a provider to inspect a configured default workspace by accident.
Capture the repository identity, exact change set, dirty-file list, and the
working directory that each provider will see.

| Provider | Exact target selection                                                                                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | Pass local `workingDir:"<repo>"`. With Claude managed approval this is a high-risk posture input and needs an approval decision plus the operator's managed-bypass setting.           |
| Codex    | Pass local `workingDir:"<repo>"`; start with `sandboxMode:"read-only"` for inspection, or use `workspace-write` only for write-producing checks.                                      |
| Gemini   | Pass a verified registered `workspace` to select cwd. `includeDirs` is an extra read path, not cwd selection.                                                                         |
| Grok     | Pass local `workingDir:"<repo>"`.                                                                                                                                                     |
| Mistral  | Pass local `workingDir:"<repo>"`.                                                                                                                                                     |
| Devin    | Pass local `workingDir:"<repo>"` or a verified registered `workspace`. Use gateway `worktree` only with an explicit provider-native `sessionId` not overridden by `createNewSession`. |
| Cursor   | Pass local `workspace:"<repo>"` or a verified registered workspace alias.                                                                                                             |

Do not request a fresh gateway worktree for Grok, Mistral, or Devin. For these
providers, gateway worktree admission requires an explicit provider-native
`sessionId` that is not overridden by `createNewSession`; fresh,
`createNewSession`, and `resumeLatest`-only worktree requests fail closed. For
a fresh isolated review, prepare the target checkout separately and select it
with `workingDir` or a verified registered `workspace`.

Do not use `workspace_*` administration tools as an ad hoc workaround for a
stdio review path. Correct the gateway launch configuration or use a verified
registered workspace.

An unscoped local CLI child runs in a fresh private neutral directory, not the
gateway process repository. Do not rely on process cwd as implicit target
routing. A cwd-scoped `resumeLatest` fails closed unless `workingDir`,
`workspace`, or a configured default workspace provides a stable target.

## First-class safe repository review

Prefer `review_changes` for an ordinary read-only Git review when durable
SQLite/PostgreSQL validation storage is available. It captures committed,
staged, unstaged, and regular non-ignored untracked evidence without truncation, fences the
artifact as untrusted data, returns exact byte and SHA-256 identities, and
starts provider-native read-only jobs in the selected repository.

Pass an absolute local `workingDir` or a registered `workspace`, then choose the
scope, providers, optional judge, stance, and optional literal path filters.
Use each returned validation `job_status`/`job_result` reference for progress
and human visibility. If a judge was requested, wait for every result to become
terminal, then call `synthesize_validation` with the `validationId` and same
repository selector. For `review_changes`, synthesis ignores caller
`question`/`providerResults`, reloads exact owned durable linked terminal jobs,
reconstructs unavailable requested seats as skipped, and atomically claims the
stored judge once. Stored repository, owner, judge, and consent are
authoritative. General validation still requires caller question/results. The
exact fenced prompt is retained in expiry-bound job `payload_json`; persisted
argv contains a hash marker and the flight recorder receives no
repository-review prompt.

HTTP/API reviewer seats require `allowApiUpload:true`, and remote workspace
reviews reject API upload. The tool is absent in Kit mode and when a durable
validation-run store is unavailable. It is intentionally read-only, so it does
not replace the explicit user-authorized full-access protocol below.

## Provider controls and prompt shape

- `approvalStrategy:"mcp_managed"` and `approvalPolicy` work only for Claude.
  Every other CLI must use `approvalStrategy:"legacy"`; managed approval is
  rejected before launch because its ambient MCP configuration cannot be
  isolated.
- Claude managed requests use only provisioned gateway-owned local MCP
  definitions. Non-empty tool selectors, `workingDir`, native resume, and other
  posture changes need a managed approval decision and
  `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`. For a routine source review, do not
  pass Claude `allowedTools`/`tools` selectors. Use legacy only when the
  operator deliberately accepts provider-native posture.
- Query capability data before applying a provider-specific tool list, output
  format, MCP setting, session field, sandbox, or native ACP transport. Do not
  copy Claude tool names into another provider.
- Claude, Codex, Gemini, Grok, and Mistral accept either `prompt` or
  `promptParts`, never both. Devin and Cursor accept only `prompt`. Preserve a
  canonical flat evidence packet for all seven and use `promptParts` only on
  the five supporting providers. Prefix hashes show gateway-side stable-prefix
  tracking, not proof of equivalent provider cache hits.
- Use `*_request_async` when async tools are registered. SQLite/PostgreSQL
  results are durable, acknowledged memory is ephemeral, and `none` registers
  no async/job tools. Poll on a non-blocking cadence without turning cadence
  into a deadline. A failed job must be diagnosed and retried or reported
  blocked, never counted as a review.
- Personal Agent Config Kit is not a seven-provider review mode: it is local
  only, supports Claude/Codex only, requires healthy SQLite/PostgreSQL durable
  admission, and disables validation and least-cost routing. Do not disable it
  or reduce the roster without the user's explicit choice of security boundary.
  Its normal Claude `workingDir` rule is not available in Kit mode: Claude Kit
  requests reject caller-supplied `workingDir` before context compilation. Use
  `explain_effective_config` to inspect a candidate folder, then select Claude's
  target through an already configured registered `workspace` alias or the
  configured default workspace. It never inherits the gateway process cwd.

## Explicit user-authorized full-access review protocol

Keep the normal inspection defaults above for ordinary review work. Replace
them only when the user explicitly authorizes full provider permissions and
native MCP access for a review. This is a review capability override, not an
authorization to modify the target: tell each reviewer not to edit, stage,
commit, reset, or otherwise mutate the repository unless the user separately
asks for that work.

1. Build the exact target checkout, then start a fresh local stdio gateway from
   that checkout with `node dist/index.js --transport=stdio`. Do not dispatch
   the review through a globally installed or already-running gateway process
   whose source revision might differ from the reviewed tree.
2. Before every iteration, use that fresh process to inspect live provider
   capability and availability. Reapply the full-access control on every new
   provider job. Do not assume a previous job, a resumed session, or a provider
   configuration reload retained the grant. Codex resume inherits its original
   sandbox and cannot accept a new sandbox selection, so start a new Codex
   session when the access posture must be established again.
3. Preserve each provider's ambient native MCP configuration. Do not pass an
   `allowedTools`, `disallowedTools`, `tools`, `allow`, `deny`, `mcpServers`,
   or `strictMcpConfig` list as a purported full-access setting. The gateway
   cannot create a general full native-MCP allowlist for the non-Claude
   providers; their native configuration is the actual MCP surface. Require
   the reviewer to use available MCP tools when useful, and record a missing
   required native MCP tool as an access finding or external blocker rather
   than pretending it was available.
4. Do not set caller-imposed `maxTurns`, `maxBudgetUsd`, `maxPrice`,
   `maxTokens`, `maxCostUsd`, `maxOutputTokens`, `printTimeout`, or review-loop
   limits. Do not use a provider-specific deadline to replace a complete
   review. A gateway's configured safety defaults are not evidence of a caller
   review cap.

Use these native controls for a new full-access CLI review. All use legacy
approval because managed approval is Claude-only. Omit every restriction named
in the final column.

| Provider             | Full-access request controls                                                                                 | Do not combine with the full-access review                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Claude               | `approvalStrategy:"legacy"`, `permissionMode:"bypassPermissions"`                                            | `allowedTools`, `disallowedTools`, `tools`, `mcpServers`, `strictMcpConfig`                              |
| Codex                | `approvalStrategy:"legacy"`, `sandboxMode:"danger-full-access"`, `dangerouslyBypassApprovalsAndSandbox:true` | `fullAuto`, a resume that needs a new sandbox, MCP restriction fields                                    |
| Gemini (Antigravity) | `approvalStrategy:"legacy"`, `yolo:true`                                                                     | `sandbox`, `skipTrust`, non-empty `allowedTools`, policy/attachment fields, `mcpServers`                 |
| Grok                 | `approvalStrategy:"legacy"`, `alwaysApprove:true`                                                            | `permissionMode` (the `alwaysApprove` branch wins), `sandbox`, `allow`, `deny`, tool lists, `mcpServers` |
| Mistral Vibe         | `approvalStrategy:"legacy"`, `permissionMode:"auto-approve"`, `trust:true`                                   | `allowedTools`, `disallowedTools`, `maxTurns`, `maxPrice`, `maxTokens`, `mcpServers`                     |
| Devin                | `approvalStrategy:"legacy"`, `permissionMode:"dangerous"`, `respectWorkspaceTrust:false`                     | `sandbox` (a true value adds a sandbox)                                                                  |
| Cursor               | `approvalStrategy:"legacy"`, `force:true`, `sandbox:"disabled"`, `trust:true`                                | `mode`, `autoReview`                                                                                     |

These are current gateway request controls, not claims that every provider has
identical tool behavior. Check the live capability response and the provider's
native configuration on each review iteration. If a required control is
rejected or a provider cannot access the target or its native MCP tools, retain
the exact error as a concrete blocker and repair it before treating that
provider as reviewed.

## Full-access evidence packet and verdict

For every iteration, give every reviewer a corrective-program specification
that contains all of the following:

- The exact base SHA and current HEAD SHA, or an explicit dirty-worktree
  statement.
- The exact reviewable change identity: a `git diff --binary <base>` artifact
  and digest, or an exhaustive `git diff --name-status <base>` list together
  with every product-relevant untracked file.
- The verification report used as the corrective-program specification:
  requirements, invariants, commands actually run, results, remaining risks,
  prior findings, and each `FIXED`, `DISAGREE`, or `BLOCKED_EXTERNAL` response.
- Persistent evidence locations: job IDs, correlation IDs, raw terminal
  outputs, test/build logs, and any durable-store or artifact references.

The verification report is a set of corrective claims, not evidence that the
claims are true. In the prompt, require the reviewer to inspect the current
source, changed and neighboring files, docs, tests, command results, and any
needed provider/MCP evidence independently. It must not approve from an intent,
plan, summary, green test claim, or "should be fixed" statement. A disagreement
with a finding requires exact code, documentation, test, or command evidence,
not assertion.

Require this terminal JSON contract in every full-access review prompt:

```json
{
  "verdict": "APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL",
  "findings": [
    {
      "severity": "blocker | major | minor | nit",
      "file_or_doc": "path:line",
      "issue": "concrete defect or verification gap",
      "evidence": "code/doc/test/command evidence actually inspected",
      "required_action": "concrete correction or external dependency"
    }
  ],
  "inspected": ["code, docs, tests, commands, MCP evidence actually inspected"],
  "reviewed_base": "sha or dirty-worktree statement",
  "reviewed_change_identity": "diff artifact digest or exhaustive file list"
}
```

`APPROVED_UNCONDITIONALLY` is valid only when the reviewer has directly
inspected the final exact change identity and has no finding or verification
gap. `CHANGES_REQUIRED` must cite a resolvable finding. `BLOCKED_EXTERNAL` must
name a concrete unavailable dependency or access failure and include its exact
error. A qualified approval, a response based only on the packet, or an output
without inspected evidence is not an approval.

When the user specifies a 90-second progress cadence, make a non-blocking wait
and do not call `llm_job_status` or otherwise check progress more often than
once every 90 seconds. That cadence is not a deadline. Keep the raw durable
review evidence, refresh the packet after every material change, and re-run the
full required roster until every reachable reviewer returns
`APPROVED_UNCONDITIONALLY` or a concrete external blocker remains.

## Normal safe-review packet and dispatch

Every required reviewer receives the same substantive packet. It is a set of
claims to verify, not a substitute for opening the target. This section keeps
the normal safe provider controls, but it uses the same strict terminal verdict
contract above. It is not an alternative approval grammar for the explicit
user-authorized full-access protocol.

- Exact base and head commit IDs or an explicit dirty-worktree statement.
- `git diff --no-ext-diff <base>..<head>`, changed-file list, and relevant
  neighboring files.
- Commands actually run, result summaries, and raw-output/digest locations.
- Intended behavior, invariants, security constraints, migration/deployment
  implications, and documentation contract.
- Earlier findings with a per-finding `FIXED`, `DISAGREE`, or
  `BLOCKED_EXTERNAL`
  response backed by file:line, command, test, or upstream-doc evidence.

Require every reviewer to inspect changed files and surrounding code directly,
run or inspect relevant verification, cite evidence for every finding, and say
what it could not verify. Do not tell reviewers to rely only on a supplied
summary or to avoid tools.

## Dispatch the full CLI roster

Substitute the verified packet and target. The Gemini and Devin calls below are
valid only after their target-routing conditions above are satisfied.

```text
claude_request_async({
  prompt:"Review <packet>. Inspect <repo> directly. Return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workingDir:"<repo>",
  approvalStrategy:"legacy",
  correlationId:"review-claude"
})

codex_request_async({
  prompt:"Review <packet>. Inspect <repo> directly for correctness, races, error paths, and tests. Return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workingDir:"<repo>",
  sandboxMode:"read-only",
  approvalStrategy:"legacy",
  correlationId:"review-codex"
})

gemini_request_async({
  prompt:"Review <packet> in the verified target workspace. Inspect security, edge cases, and documentation. Return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workspace:"<verified-gemini-workspace>",
  approvalStrategy:"legacy",
  correlationId:"review-gemini"
})

grok_request_async({
  prompt:"Independently review <packet> and <repo>. Verify claims directly and report blind spots with evidence. Return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workingDir:"<repo>",
  approvalStrategy:"legacy",
  correlationId:"review-grok"
})

mistral_request_async({
  prompt:"Independently review <packet> and <repo>. Verify correctness, maintainability, tests, and security directly. Return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workingDir:"<repo>",
  approvalStrategy:"legacy",
  correlationId:"review-mistral"
})

devin_request_async({
  prompt:"Independently review <packet> and <repo>. Inspect directly and return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workingDir:"<repo>",
  approvalStrategy:"legacy",
  correlationId:"review-devin"
})

cursor_request_async({
  prompt:"Independently review <packet> and <repo>. Verify claims directly and return the required terminal JSON verdict: APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL.",
  workspace:"<repo>",
  approvalStrategy:"legacy",
  correlationId:"review-cursor"
})
```

For a Claude managed review, replace only the Claude request after the operator
has approved the required target/posture. Do not add an `allowedTools` list just
to make it look restrictive: a reviewer needs real inspection access.

## Triage and re-review

1. Poll each async job until its terminal result is available. Keep job IDs,
   provider, target identity, and raw result evidence.
2. Validate each verdict. A response lacking direct-inspection evidence is
   incomplete even if it says `APPROVED_UNCONDITIONALLY`.
3. Consolidate duplicate findings, but verify unique findings rather than
   discarding them because only one provider noticed them.
4. Fix correct findings and run relevant local verification. For disputed
   findings, send the reviewer the exact counter-evidence and require an
   evidence-backed withdrawal or revised finding.
5. Refresh the evidence packet and exact change set. Re-dispatch every reviewer
   whose prior result was not unconditional, plus any reviewer whose evidence
   became stale after the fix.
6. Finish only when every required healthy reviewer returns
   `APPROVED_UNCONDITIONALLY` and the final evidence packet matches the
   reviewed change set.

If a provider repeatedly reaches a terminal external failure, preserve its
error and attempted repair evidence, report `BLOCKED_EXTERNAL`, and ask the
user how to proceed. Do not proceed with a smaller set by default.

## Anti-patterns

- Calling a provider directly instead of through the local stdio gateway.
- Reviewing a default or wrong workspace because target routing was not proved.
- Passing unsupported provider controls or Claude tool names to another CLI.
- Treating a gateway bookkeeping session ID as a provider-native resume handle.
- Selecting a cheapest reviewer or applying a cost/time cap to an exhaustive
  review.
- Accepting summaries, intent, plan compliance, or "should be fixed" as proof.
- Skipping an unavailable provider, treating a timeout as a pass, or ending
  after an arbitrary number of rounds.
