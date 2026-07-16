---
name: session-workflow
description: Manage gateway bookkeeping and provider-native conversation continuity across Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor. Use for multi-turn work, session inspection, and safe resume decisions.
metadata:
  author: verivus-oss
  version: "1.8"
---

# Session Workflow

Separate gateway bookkeeping from native provider continuity. `session_create`,
`session_list`, `session_set_active`, and `session_get` manage gateway metadata;
they do not create or prove a provider-native conversation. Never pass a
gateway-generated ID to a provider as though it were a native handle.

For a review session, dispatch requests through the local stdio gateway MCP
surface. A session does not authorize a direct provider CLI, connector/shadow
gateway, or shell fallback.

## Discover before resuming

Before using a provider-specific session field, query:

```text
provider_tool_capabilities({cli:"claude"})
provider_tool_capabilities({cli:"codex"})
provider_tool_capabilities({cli:"gemini"})
provider_tool_capabilities({cli:"grok"})
provider_tool_capabilities({cli:"mistral"})
provider_tool_capabilities({cli:"devin"})
provider_tool_capabilities({cli:"cursor"})
```

Use a native `sessionId` only when it came from that provider or was supplied by
the caller as a verified native handle. A fresh gateway session often uses a
`gw-*` bookkeeping ID. It is not resumable for Codex, Grok, Mistral, Devin, or
Cursor, and must never be replayed to Gemini either.

## Native continuity matrix

| Provider | Native resume                                                                                                                 | Important boundary                                                                                                                                                                      |
| -------- | ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude   | `sessionId` maps to `--session-id`; continuation maps to `--continue`.                                                        | Managed native continuation is a high-risk posture input requiring an approval decision and `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`.                                                      |
| Codex    | Real Codex UUID maps to `codex exec resume <UUID>`; `resumeLatest:true` selects the globally latest session through `--last`. | The selected session inherits its original cwd; `workingDir` cannot target `--last`. Use a real UUID for a specific Codex session. Resume drops sandbox settings, including `fullAuto`. |
| Gemini   | A caller-owned Antigravity conversation ID maps to `--conversation`; `resumeLatest:true` maps to `--continue`.                | Fresh launches do not produce a reusable native ID. Check `resumable:true`; never replay `gw-*`.                                                                                        |
| Grok     | Native ID maps to `--resume`; `resumeLatest:true` maps to `--continue`.                                                       | A fresh `gw-*` ID is bookkeeping only. Cwd affects `--continue` context.                                                                                                                |
| Mistral  | Native ID maps to `--resume`; `resumeLatest:true` maps to `--continue`.                                                       | A fresh `gw-*` ID is bookkeeping only. Vibe session logging defaults on; `doctor --json` flags only explicit `[session_logging] enabled = false`.                                       |
| Devin    | Native ID maps to `--resume`; `resumeLatest:true` maps to `--continue`.                                                       | A fresh `gw-*` ID is bookkeeping only. Use `workingDir` or `workspace` to bind the selected cwd.                                                                                        |
| Cursor   | Native chat/session ID maps to `--resume`; `resumeLatest:true` maps to `--continue`.                                          | A fresh `gw-*` ID is bookkeeping only. Use a verified `workspace` for its checkout.                                                                                                     |

All non-Claude providers use `approvalStrategy:"legacy"`; they reject
Claude-only `mcp_managed` and ignore `approvalPolicy`. `mcp_managed` is usable
only with Claude and its request-scoped gateway-owned MCP configuration.

## Explicit full-access review sessions

When a user explicitly authorizes full provider permissions and native MCP
access for review, follow `multi-llm-review`'s full-access protocol instead of
the safe examples below. Build and launch a fresh target-checkout stdio gateway
with `node dist/index.js --transport=stdio`; do not use a globally installed
gateway whose revision is unknown. Reapply the provider-native full-access
mapping on every new job and verify it through the live capability surface.

Do not rely on continuity for the grant. In particular, Codex resume inherits
its old sandbox and cannot take a new one, so a full-access Codex review needs
a fresh native session. Keep ambient provider MCP configuration available, do
not turn request tool/MCP lists into an asserted allowlist, and record the
exact base, diff or changed-file list, verification report, and durable job
evidence with every review iteration. If the user requests 90-second progress
checks, do not poll earlier than that cadence.

## Gateway bookkeeping sessions

Create a gateway record when you need description, active-pointer, cache
projection, or local workflow organization:

```text
session_create({cli:"claude",description:"Refactor auth module",setAsActive:true})
session_list({cli:"claude"})
session_get({sessionId:"<gateway-session-id>"})
session_set_active({cli:"claude",sessionId:"<gateway-session-id>"})
```

Treat the returned ID as gateway metadata. Pair it with a separately verified
native handle if you want provider continuation. Do not assume an active gateway
session causes Codex, Gemini, Grok, Mistral, Devin, or Cursor to resume a
provider conversation.

## Safe request examples

Gateway tool calls:

```text
claude_request({
  prompt:"Continue the approved task.",
  sessionId:"<verified-claude-id>",
  approvalStrategy:"legacy"
})

codex_request({
  prompt:"Continue the approved task.",
  resumeLatest:true,
  approvalStrategy:"legacy"
})

gemini_request({
  prompt:"Continue the approved task.",
  sessionId:"<caller-owned-antigravity-conversation>",
  workspace:"<registered-repo>",
  approvalStrategy:"legacy"
})

grok_request({prompt:"Continue.",resumeLatest:true,workingDir:"<repo>",approvalStrategy:"legacy"})
mistral_request({prompt:"Continue.",resumeLatest:true,workingDir:"<repo>",approvalStrategy:"legacy"})
devin_request({prompt:"Continue.",resumeLatest:true,workingDir:"<repo>",approvalStrategy:"legacy"})
cursor_request({prompt:"Continue.",resumeLatest:true,workspace:"<repo>",approvalStrategy:"legacy"})
```

Codex `resumeLatest` is global, not cwd-scoped. It inherits the selected
session's original cwd. To target a specific native session, pass its verified
real Codex UUID as `sessionId`; `workingDir` cannot select that session.

For Codex, start source inspection with `sandboxMode:"read-only"`; use
`workspace-write` only if the work needs write-producing commands. Do not use
new `fullAuto:true` examples. On a Codex resume, sandbox selection is not
emitted, so start a fresh native session if you must alter it.

## Target and concurrency discipline

Native session state is contextual. Verify the repository/workspace and cwd
before every resume, especially when multiple workstations or repositories run
simultaneously:

- Use explicit `workingDir` for Claude, Grok, Mistral, and Devin.
- Use `workingDir` for a fresh Codex session. It does not scope Codex
  `resumeLatest`; use a verified real Codex UUID to target a specific session.
- Gemini has no `workingDir`; `includeDirs` does not select cwd. Use a verified
  configured/registered target workspace.
- Use Cursor `workspace` for its target checkout.

For providers whose latest-session selection is cwd-scoped, an unscoped local
CLI child runs in a fresh neutral temporary directory, not the gateway
repository. Their cwd-scoped `resumeLatest` therefore fails closed unless
`workingDir`, `workspace`, or a configured default workspace supplies a stable
target. Codex is the exception: `resumeLatest` selects its globally latest
session and inherits that session's original cwd.

The gateway's cache/session metadata does not prove that a provider resumed the
intended repository. Record the native handle, selected target, provider, and
commit/diff evidence together.

## Cache-aware turns

Claude, Codex, Gemini, Grok, and Mistral accept either `prompt` or structured
`promptParts`. Devin and Cursor accept only flat `prompt`. Keep the stable
system/tools/context prefix byte-identical only where `promptParts` is
supported, and retain a canonical flat equivalent for the other two providers.

```text
claude_request({
  promptParts:{system:"<stable>",context:"<stable spec>",task:"Follow-up task"},
  sessionId:"<verified-claude-id>",
  approvalStrategy:"legacy"
})
```

`prompt` and `promptParts` are mutually exclusive. `cache-state://global`,
`cache-state://session/{sessionId}`, and `cache-state://prefix/{hash}` contain
token/hash aggregates, not prompt/response text. A shared prefix hash is not
evidence that every provider hit an equivalent cache.

## Async and review continuity

When async tools are registered, a sync call may return a deferred job. Poll
with `llm_job_status` and read `llm_job_result` once terminal. SQLite/PostgreSQL
job results survive restarts; acknowledged memory is ephemeral; backend `none`
does not register async/job tools.

Do not impose a review deadline or arbitrary review round count because a
session is involved. A mandatory review remains incomplete until every required
reviewer returns an evidence-backed unconditional approval. A provider failure
must be repaired/retried or reported `INCOMPLETE`/`BLOCKED`, never skipped.

## Personal Agent Config Kit

Kit mode is local-only, supports only Claude/Codex, requires healthy
SQLite/PostgreSQL durable admission, and retires native continuation after a
gateway restart. It disables validation and least-cost routing. Use
`explain_effective_config` before consequential Kit work. If effective Kit caps
constrain an exhaustive review, do not claim an unconditional/complete review
without an approved uncapped profile or explicit user direction.

`explain_effective_config({workingDir:"<repo>"})` can inspect a candidate Kit
scope. Do not pass that `workingDir` to a Claude Kit request: Kit rejects it
before compiling context. Select a Claude Kit target through an already
configured registered `workspace` alias or the configured default workspace. It
never inherits the gateway process cwd.

## Cleanup

Use `session_delete({sessionId:"..."})` for an obsolete bookkeeping record and
`session_clear_all({cli:"..."})` only when the caller wants to clear that
gateway metadata. Neither command deletes a provider-native conversation.
