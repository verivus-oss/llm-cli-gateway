---
name: design-review-cycle
description: Run evidence-backed design, specification, and implementation-plan reviews through the local llm-cli-gateway stdio MCP server. Use for single-provider or complete cross-LLM design review before implementation. Covers all seven CLI request surfaces and Mistral Vibe's current accept-edits default.
---

# Design Review Cycle

Review a design, specification, or implementation plan before code changes make
the decision expensive to reverse. Dispatch every review through the local gtwy
stdio MCP server, not by launching provider CLIs directly.

The gateway has seven CLI request surfaces: Claude, Codex, Gemini, Grok,
Mistral, Devin, and Cursor. Each has a sync request tool and an async request
tool when async jobs are enabled. Grok, Mistral, Devin, and Cursor also expose
native ACP transports, but review requests still go through the gateway request
tools.

Configured API providers can add generic request tools. Discover them with
`list_models` and their reported capabilities. They do not supply a local CLI
checkout/worktree or native ACP boundary, so they are not an automatic
replacement for a source-inspecting required CLI reviewer.

## Start With Scope, Capability, and Target Checks

1. Call provider_tool_capabilities through gtwy to discover the usable request
   surface, native transport capability, and local provider state.
2. Define the review roster. A full cross-LLM review requires every provider
   that the user or process names. Do not silently reduce that roster because a
   provider is slow or unavailable.
3. Verify that every reviewer will inspect the same repository and revision.
   A review of a default or unrelated workspace is invalid.
4. If Personal Agent Config Kit mode is enabled, it supports Claude and Codex
   only. route_request and normal cross-provider validation surfaces are
   unavailable. A requested seven-provider review is therefore blocked until
   Kit is disabled for that workflow or the user explicitly changes scope.
   Claude Kit requests also reject caller-supplied `workingDir` before context
   compilation. `explain_effective_config({workingDir:"<repo>"})` can inspect a
   candidate scope, but execute Claude Kit work with an already configured
   registered `workspace` alias or the configured default workspace. It never
   inherits the gateway process cwd.

Use this local stdio targeting map:

| Provider                     | Target the repository                                                                                                                                                |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude, Codex, Grok, Mistral | Pass local workingDir on a new session when supported by the request, or select a registered workspace explicitly or by configured default.                          |
| Gemini                       | It has no workingDir field. includeDirs adds auxiliary paths and does not select the process cwd. Select a registered workspace explicitly or by configured default. |
| Devin                        | Pass local workingDir on a new CLI session, or select a registered workspace explicitly or by configured default.                                                    |
| Cursor                       | Pass workspace as a local directory or registered alias. Cursor uses that selection for its native workspace and child cwd.                                          |

Do not use workspace_* administration tools to repair a local stdio path
problem. They are for remote HTTP/OAuth workspace clients.

For Claude mcp_managed, a custom working directory, expanded workspace, native
resume, custom tool rules, and similar posture changes require a gateway
approval decision plus the operator bypass setting. Use only the minimal managed
Claude request unless that approval path is deliberately configured.

## Complete-Review Contract

Every required reviewer prompt must require this terminal JSON verdict:

```
APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL
```

Apply these rules:

1. Omit model unless the caller explicitly selected one.
2. Use approvalStrategy: "legacy" for all non-Claude providers. Their
   approvalPolicy field has no effect and mcp_managed is rejected.
3. Use mcp_managed only for a deliberately configured Claude request. Do not
   carry its approval semantics into another provider or ACP transport.
4. Use sandboxMode: "read-only" for a Codex document inspection. Use
   sandboxMode: "workspace-write" only if the review must create generated
   build or test output. Do not use fullAuto; it is deprecated shorthand.
5. Do not set review-round, turn, token, price, cost, or wallclock limits.
   The configured idle-timeout safeguard detects lack of output, not completion.
6. Accept only explicit, evidence-backed `APPROVED_UNCONDITIONALLY` results. A
   condition, remaining finding, incomplete evidence, malformed response,
   timeout, cancellation, or provider failure is not approval.

Continue to revise and re-review without a numeric cap. Stop only when the user
cancels or a provider has a terminal external failure. A terminal failure is
`BLOCKED_EXTERNAL` with its exact error, never a reason to omit the reviewer or
approve the design.

## Explicit user-authorized full-access design review

Keep the normal review controls above unless the user explicitly grants full
provider permissions and native MCP access. For that exception, follow the
complete `multi-llm-review` full-access protocol: build the exact target,
launch `node dist/index.js --transport=stdio` from it, and do not use a global
or stale gateway process. Reapply each provider-native grant to every new job,
not a resumed assumption, and preserve ambient native MCP configuration without
adding gateway allowlists or deny lists.

Every provider receives the verification report as a corrective-program
specification plus the exact base, diff or exhaustive changed-file list,
product-relevant untracked files, and persistent evidence references. Require
independent code, docs, tests, command, and native-MCP inspection. The only
acceptable terminal outcomes are `APPROVED_UNCONDITIONALLY`, evidence-backed
`CHANGES_REQUIRED`, or concrete `BLOCKED_EXTERNAL`. Do not impose caller caps.
For a user-required 90-second progress cadence, use non-blocking waits and do
not poll earlier. Full capability remains non-mutating review access unless the
user separately authorizes edits.

## Dispatch the Review

For a single Codex design review:

```
codex_request({
  prompt: "Review [design path] for completeness, feasibility, alternatives,
    risks, dependencies, test strategy, rollout, rollback, and project
    conventions. Return terminal JSON verdict APPROVED_UNCONDITIONALLY,
    CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  sandboxMode: "read-only",
  workingDir: "[repo]",
  approvalStrategy: "legacy",
  correlationId: "design-review-codex"
})
```

For a full cross-LLM review, dispatch the required roster in parallel after
applying the targeting map above:

```
claude_request_async({
  prompt: "Review [design path] for architecture, assumptions, failure modes,
    and missing alternatives. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "design-review-claude"
})

codex_request_async({
  prompt: "Review [design path] for feasibility, task ordering, test strategy,
    and implementation risks. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  sandboxMode: "read-only",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "design-review-codex"
})

gemini_request_async({
  prompt: "Review [design path] for security, data flow, operational failure
    modes, and missing requirements. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workspace: "[verified Gemini workspace]",
  correlationId: "design-review-gemini"
})

grok_request_async({
  prompt: "Independently review [design path] for assumptions, blind spots, and
    alternatives. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "design-review-grok"
})

mistral_request_async({
  prompt: "Independently review [design path] for feasibility, maintainability,
    and missing constraints. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "design-review-mistral"
})

devin_request_async({
  prompt: "Independently review [design path] for implementation risk, security,
    and missing verification. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  correlationId: "design-review-devin"
})
// Dispatch Devin only from a gateway process whose confirmed cwd is [repo].

cursor_request_async({
  prompt: "Independently review [design path] for usability, implementation
    gaps, and regressions. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",
  approvalStrategy: "legacy",
  workspace: "[repo]",
  correlationId: "design-review-cursor"
})
```

Use prompt, not promptParts, for Devin and Cursor. The other five CLI request
surfaces accept promptParts. Keep a canonical flat review text and derive the
five structured requests from it so all reviewers receive the same substantive
criteria.

## Process Findings

1. Union all findings. A finding reported by one reviewer still needs
   verification; a majority vote is not evidence that it is wrong.
2. Update the design or provide focused counter-evidence.
3. Build or validate any technical claims that can be checked locally.
4. Re-dispatch every required reviewer against the changed design.
5. Record each verdict and evidence trail. Do not call a qualified response
   informational unless the reviewer gives a fresh
   `APPROVED_UNCONDITIONALLY` after the issue is resolved.

## Deferred Jobs and Continuity

When async tools are registered, poll through gtwy with llm_job_status and
collect results with llm_job_result. Use a non-blocking wakeup mechanism. Do
not cancel because a review is taking a long time.

When persistence.backend = "none", use the corresponding sync request tools;
they run to completion and do not auto-defer. Lack of async tools does not
justify reducing the required reviewer roster.

SQLite and Postgres persistence retain jobs durably. Memory persistence is
ephemeral and requires explicit acknowledgement; persistence.backend = "none"
does not register async or job tools. Reissue an identical deduplicable request
only when the design inputs are unchanged.

Mistral Vibe defaults session logging to enabled. Before relying on
resumeLatest or sessionId continuity, run doctor and correct an explicit
[session_logging] enabled = false configuration. Codex native resume requires a
real Codex UUID and inherits its original target and sandbox settings.

## Acceptance Record

- Review scope and required provider roster
- Target repository, revision, and targeting method for every reviewer
- Prompt and review criteria used
- Every finding, response, validation result, and re-review
- Explicit `APPROVED_UNCONDITIONALLY` from every required reviewer
- Any terminal provider error labeled as `BLOCKED_EXTERNAL`, never as approval
