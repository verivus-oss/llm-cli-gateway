---
name: multi-llm-orchestration
description: Orchestrate the complete llm-cli-gateway provider surface through its local stdio MCP server. Use for parallel implementation, review, session, async-job, cache-aware prompt, and cross-LLM workflows across Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor.
---

# Multi-LLM Orchestration

Use the local gtwy stdio MCP server as the single orchestration surface. Do not
launch provider CLIs directly for implementation, review, or consensus work.
In Codex the tools usually appear as mcp__gtwy__<tool>; other clients can show
their short tool names.

## Discover the Live Surface

Call provider_tool_capabilities before planning a cross-provider workflow and
use cli_versions when behavior is unexpected. The canonical CLI provider roster
has seven members:

| Provider | Request tools                          | Important boundary                                           |
| -------- | -------------------------------------- | ------------------------------------------------------------ |
| Claude   | claude_request, claude_request_async   | Only provider with mcp_managed.                              |
| Codex    | codex_request, codex_request_async     | Use sandboxMode, not fullAuto.                               |
| Gemini   | gemini_request, gemini_request_async   | No workingDir; Antigravity owns native MCP configuration.    |
| Grok     | grok_request, grok_request_async       | Native ACP capability is also available through the gateway. |
| Mistral  | mistral_request, mistral_request_async | Native ACP capability; programmatic default is accept-edits. |
| Devin    | devin_request, devin_request_async     | Native ACP capability; accepts flat prompt only.             |
| Cursor   | cursor_request, cursor_request_async   | Native ACP capability; accepts flat prompt only.             |

Async tools and llm_job_* tools are absent when persistence.backend = "none".
Do not invent an unavailable tool or silently change a required reviewer roster.

Configured API providers are discovered dynamically with `list_models` and
their runtime capability data. They are not canonical local CLI providers and
do not imply local workspace/worktree targeting or native ACP. Do not use one
as an unannounced replacement for a required source-inspecting CLI reviewer.

## Approval, Sandboxing, and Targeting

- Use approvalStrategy: "legacy" for Codex, Gemini, Grok, Mistral, Devin, and
  Cursor. They reject mcp_managed and approvalPolicy has no effect.
- Use mcp_managed only for a deliberately configured Claude CLI request. ACP
  transport does not accept mcp_managed or approvalPolicy.
- For Codex inspection, use sandboxMode: "read-only". Use
  sandboxMode: "workspace-write" only when code edits or write-producing tests
  are needed. fullAuto is deprecated shorthand.
- For local stdio calls, never use workspace_* tools merely to fix a path.
  Those tools are remote HTTP/OAuth administration surfaces.

| Provider                     | Local repository targeting                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Claude, Codex, Grok, Mistral | Use workingDir on a new session, or select a registered workspace explicitly or by configured default.                              |
| Gemini                       | No workingDir. includeDirs is auxiliary and does not select cwd. Select a registered workspace explicitly or by configured default. |
| Devin                        | Use workingDir on a new CLI session, or select a registered workspace explicitly or by configured default.                          |
| Cursor                       | Set workspace to the local directory or registered alias.                                                                           |

Managed Claude treats expanded workspace, custom workingDir, custom selectors,
native continuation, and similar posture changes as approval-gated. Do not
assume they are free additions to a managed request.

## Explicit user-authorized full-access review orchestration

Keep the safe defaults in this skill for ordinary work. When the user explicitly
requires full provider permissions and native MCP access for review, switch to
the full `multi-llm-review` protocol. Build the exact target checkout and start
`node dist/index.js --transport=stdio` from it. Do not use a globally installed
or stale `gtwy` process that might run different code.

Reapply the source-verified provider-native full-access mapping on every new
job. Preserve ambient provider MCP configuration, do not present gateway
tool/MCP lists as a full-access grant, and do not rely on a resume to retain a
new permission posture. Every reviewer receives the verification report as a
corrective-program specification, the exact base and diff or exhaustive
changed-file list including relevant untracked files, and persistent evidence
locations. Require independent source, documentation, test, command, and MCP
inspection. Accept only `APPROVED_UNCONDITIONALLY`, evidence-backed
`CHANGES_REQUIRED`, or concrete `BLOCKED_EXTERNAL`. Set no caller caps; honor a
user-required 90-second progress cadence without polling early.

## Cache-Aware Prompting

Claude, Codex, Gemini, Grok, and Mistral accept promptParts:

```
codex_request({
  promptParts: {
    system: "Stable orchestration policy",
    tools: "Stable tool constraints",
    context: "Stable repository facts",
    task: "Implement or review the current task."
  },
  sandboxMode: "read-only",
  approvalStrategy: "legacy"
})
```

Use exactly one of prompt or promptParts. Devin and Cursor accept only prompt,
so keep a canonical flat request for them when fanning out. Cache-state
resources expose aggregate hashes and token data, not prompt text or a quality
verdict.

## Parallel Workflows

For independent tasks, dispatch the selected providers with the async tools,
associate each call with a correlationId, and retain every job identifier. Use
llm_job_status and llm_job_result through gtwy when those tools are registered.
Use non-blocking waits between polls.

If async tools are absent because persistence.backend = "none", use the
corresponding sync request tools. They run to completion without auto-deferral;
the missing async surface does not authorize a smaller review roster.

For an implement-review-fix workflow:

1. Dispatch the implementation through an appropriate gateway provider.
2. Build and test the resulting change.
3. Dispatch every required reviewer through gtwy against the same target and
   revision.
4. Union findings, fix or rebut them with evidence, then re-run the required
   reviewer set after material changes.

## Complete Review Rule

Every mandatory review prompt must require this terminal JSON verdict:

```
APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL
```

Do not set a review round, turn, token, price, cost, or wallclock cap. Do not
use cost routing to drop a mandatory reviewer. Continue until every required
reviewer returns explicit `APPROVED_UNCONDITIONALLY`. Conditional approval,
remaining findings, inability to verify, malformed output, timeout,
cancellation, or provider failure is not approval.

Stop only on explicit user cancellation or a terminal external provider failure.
Record a terminal failure as `BLOCKED_EXTERNAL` with its exact error. Never call
a partial roster or failed reviewer an unconditional approval.

Use multi-llm-consensus for a complete seven-provider gate and
implement-review-fix for the detailed repair loop.

## Sessions, Jobs, and Persistence

All seven providers have provider-native continuity behavior. Codex requires a
real native Codex UUID and resume inherits its original working directory and
sandbox posture. Do not pass a gateway-generated gw-* identifier as a native
Codex sessionId.

Mistral Vibe defaults session logging to enabled. Run doctor before relying on
Vibe resume and correct an explicit [session_logging] enabled = false setting.
Mistral model selection is injected as VIBE_ACTIVE_MODEL because Vibe has no
model CLI flag.

SQLite and Postgres persistence store jobs durably. Memory persistence is
process-lifetime only and requires explicit acknowledgement. With
persistence.backend = "none", sync calls run to completion and async/job tools
are not registered. Do not cancel a mandatory review because it is slow.

Personal Agent Config Kit supports Claude and Codex only, requires durable job
admission, and disables route_request and normal cross-provider validation
workflows. A required seven-provider review in Kit mode is a blocker unless the
user explicitly changes scope.
The ordinary Claude `workingDir` targeting rule does not apply to a Claude Kit
request: it rejects caller-supplied `workingDir` before context compilation.
Use `explain_effective_config({workingDir:"<repo>"})` to inspect a candidate
scope, then execute Claude Kit work through an already configured registered
`workspace` alias or the configured default workspace. It never inherits the
gateway process cwd.
