---
name: model-routing
description: Select and dispatch llm-cli-gateway providers by live capability, target access, and task requirements. Use when choosing among Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor, or when selecting an explicit model through the local stdio gateway.
---

# Model Routing

Choose providers from live gateway capability data, not a static claim that one
model is universally best. Send every request, including reviews, through the
local gtwy stdio MCP server. Do not invoke a provider CLI directly to bypass
the gateway's request, session, and audit surfaces.

## Discover Before Selecting

1. Call provider_tool_capabilities through gtwy for current request surfaces,
   transports, local configuration, and provider-owned tool availability.
2. Call cli_versions when a provider behaves differently from its recorded
   contract.
3. Omit model unless the user explicitly named a model. If an explicit model is
   needed, use list_models for the target provider first.
4. Record why a provider is selected: task scope, required capabilities, target
   repository access, and safety posture.

The gateway's CLI provider roster is:

| Provider | Gateway request surface                   | Selection notes                                                                                                                                    |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | claude_request and claude_request_async   | The only provider that can use mcp_managed.                                                                                                        |
| Codex    | codex_request and codex_request_async     | Use current sandboxMode values, not fullAuto.                                                                                                      |
| Gemini   | gemini_request and gemini_request_async   | Antigravity owns its native tool configuration and does not accept workingDir.                                                                     |
| Grok     | grok_request and grok_request_async       | CLI request surface plus native ACP capability.                                                                                                    |
| Mistral  | mistral_request and mistral_request_async | CLI request surface plus native ACP capability; explicit model selection is injected through VIBE_ACTIVE_MODEL because Vibe has no CLI model flag. |
| Devin    | devin_request and devin_request_async     | CLI request surface plus native ACP capability; it accepts flat prompt, not promptParts.                                                           |
| Cursor   | cursor_request and cursor_request_async   | CLI request surface plus native ACP capability; it accepts flat prompt, not promptParts.                                                           |

The exact installed or usable set comes from provider_tool_capabilities. Do not
turn an unavailable provider into a fictional successful review.

Configured API providers are discovered through `list_models` and their runtime
capability data. They are not members of the canonical CLI roster: do not assume
local workspace/worktree targeting or native ACP, and do not substitute one for
a required source-inspecting CLI review without explicit scope approval.

If persistence.backend = "none", the async request and llm_job_* surfaces are
not registered. Use the corresponding sync request for the same required
provider roster; it runs to completion without auto-deferral.

## Approval and Sandbox Selection

- Claude alone can use approvalStrategy: "mcp_managed" and approvalPolicy.
  Use it only with its generated strict allowlist and its configured approval
  path.
- Codex, Gemini, Grok, Mistral, Devin, and Cursor use
  approvalStrategy: "legacy". Their approvalPolicy values have no effect and
  mcp_managed is rejected before launch.
- For Codex, use sandboxMode: "read-only" for inspection and
  sandboxMode: "workspace-write" when an implementation or test must create
  artifacts. fullAuto is a deprecated workspace-write shorthand.
- ACP transport has its own configuration-gated permission bridge. Do not claim
  mcp_managed or approvalPolicy applies to an ACP request.

For a managed Claude request, custom tool selectors, expanded workspace,
workingDir, native continuation, and other posture changes require a gateway
approval decision and the operator bypass setting. Do not add them casually to
a routing example.

## Explicit user-authorized full-access review routing

Do not use model routing, cheapest selection, or ordinary safe-review examples
when a user explicitly requires full provider permissions and native MCP access.
Follow `multi-llm-review`'s full-access protocol instead. Build the exact target
checkout and launch `node dist/index.js --transport=stdio` there, rather than
using a globally installed or stale gateway process. Apply the native
full-access mapping to each fresh provider job, do not assume a resume retained
it, and do not add tool/MCP allowlists, deny lists, or caller caps.

The verification report is a corrective-program specification, not proof. Send
it with the exact base, diff or exhaustive changed-file list including relevant
untracked files, and durable evidence locations. Require independent inspection
of code, docs, tests, commands, and available native MCP tools. Accept only
`APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED` with evidence, or a concrete
`BLOCKED_EXTERNAL` result. On a user-required 90-second cadence, do not check
job progress earlier than 90 seconds.

## Route by Task Needs

Use these as starting lenses, then verify the provider's live capability and
the reviewer evidence:

| Need                                         | Starting selection                                                                                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Local code inspection or implementation      | Codex with an appropriate sandbox mode, or another provider whose target access has been verified. |
| Strict gateway-managed Claude tool isolation | Claude mcp_managed, only when its approval conditions are satisfied.                               |
| Independent vendor-family review             | Add Grok, Mistral, Devin, or Cursor as a required reviewer when the review scope calls for it.     |
| Native ACP integration                       | Grok, Mistral, Devin, or Cursor, after checking provider_tool_capabilities and ACP configuration.  |
| Workspace-aware Cursor task                  | Cursor with workspace set to the intended local directory or registered alias.                     |
| Cost-constrained non-review task             | Use route_request only when the user explicitly asks for cost-constrained model-agnostic routing.  |

Do not use route_request, select: "cheapest", maxCostUsd, maxPrice,
maxTokens, or any equivalent to reduce a mandatory review. route_request and
route_request_async are not registered in Personal Agent Config Kit mode, even
when `[least_cost].enabled = true`.

## Repository Targeting

Never let providers review different default repositories.

| Provider                     | Correct local target method                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude, Codex, Grok, Mistral | Pass workingDir on a new session, or select a registered workspace explicitly or by configured default.                                    |
| Gemini                       | No workingDir exists. includeDirs is auxiliary and does not select cwd. Select a registered workspace explicitly or by configured default. |
| Devin                        | Pass workingDir on a new CLI session, or select a registered workspace explicitly or by configured default.                                |
| Cursor                       | Set workspace to the local directory or registered alias.                                                                                  |

Do not use workspace_* administration tools merely to repair a local stdio
path. They are remote HTTP/OAuth administration surfaces.

## Model and Prompt Selection

Omit model by default:

```
codex_request({
  prompt: "Inspect [path] and explain the defect.",
  sandboxMode: "read-only",
  approvalStrategy: "legacy"
})

mistral_request({
  prompt: "Independently inspect [path].",
  approvalStrategy: "legacy"
})
```

Only use an explicit model when the caller named it or live capability data
requires it. For Mistral, the gateway maps the model input to VIBE_ACTIVE_MODEL
rather than emitting a Vibe model flag.

Claude, Codex, Gemini, Grok, and Mistral accept promptParts as an alternative
to prompt. Devin and Cursor accept flat prompt only. When fan-out requires all
seven, keep a canonical exact flat prompt, use it directly for Devin and Cursor,
and derive identical structured stable context for the other five.

```
codex_request({
  promptParts: {
    system: "Stable task contract",
    context: "Stable repository facts and acceptance criteria",
    task: "Inspect the current implementation."
  },
  sandboxMode: "read-only",
  approvalStrategy: "legacy"
})
```

Use exactly one of prompt or promptParts. Cache-state resources expose hashes
and aggregates, not prompt text or proof of task correctness.

## Mandatory Review Routing

For a full cross-LLM review, first define the required provider roster and send
each request through gtwy. Every prompt must require this terminal JSON verdict:

```
APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL
```

Do not apply round, turn, token, price, cost, or wallclock caps. Continue until
every required reviewer gives `APPROVED_UNCONDITIONALLY`. A condition, residual
finding, inability to verify, malformed response, cancellation, timeout, or
provider error is not approval. Correct the issue and re-dispatch. Stop only on
explicit user cancellation or a terminal external provider failure, which must
be reported as `BLOCKED_EXTERNAL` without shrinking the roster.

## Sessions, Jobs, and Kit Mode

All seven CLI providers have native continuity support, but each has its own
native handle rules. Codex requires a real Codex UUID and inherits its original
sandbox and target on resume. Gateway-generated gw-* identifiers must not be
used as Codex native session IDs. Current Mistral Vibe defaults session logging
to enabled; run doctor and correct an explicit [session_logging] enabled =
false before relying on Vibe resume.

If async tools are available, poll deferred jobs with llm_job_status and fetch
llm_job_result through gtwy. SQLite and Postgres jobs are durable; memory is
process-lifetime only, and persistence.backend = "none" exposes no async or job
tools. Do not cancel a mandatory review simply because it is long-running.

Personal Agent Config Kit supports Claude and Codex only and needs durable job
admission. Treat a requested multi-provider review while Kit is enabled as a
scope blocker, not an opportunity to silently downgrade the review.
