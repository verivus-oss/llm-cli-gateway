---
name: multi-llm-orchestration
description: Guide for orchestrating multiple LLMs via the llm-gateway — use when delegating tasks to Codex, Gemini, Grok, or Mistral, running parallel reviews, or managing cross-LLM workflows. Covers cache-aware `promptParts` dispatch and the `cache-state://` MCP resources.
---

# Multi-LLM Orchestration

Use the llm-gateway MCP server tools to orchestrate work across Claude, Codex, Gemini, Grok (xAI), and Mistral Vibe.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution, then sets each provider to a safe accept-edits-level mode (auto-accept file edits; Bash and other dangerous tools stay gated): Claude and Grok `--permission-mode acceptEdits`, Mistral `--agent accept-edits`, and Gemini prompted `default` (the `agy` CLI has no accept-edits rung, so Gemini cannot auto-approve mutating tools under `mcp_managed`). Codex still needs `fullAuto:true` for autonomous file/shell work (its sandboxed `workspace-write` mode is unchanged). Full unattended execution requires the operator opt-in `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`, which restores each provider's full auto-approve mode (Claude `bypassPermissions`, Grok `--always-approve`, Mistral `auto-approve`, Gemini `--dangerously-skip-permissions`).
3. **No wallclock timeout; poll every 60 s** — `idleTimeoutMs` is a separate no-output safeguard.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch → parse verdict → on `NOT APPROVED` or conditional, fix + re-review → repeat. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Available Tools

- `claude_request` / `claude_request_async` — Send prompts to Claude Code CLI
- `codex_request` / `codex_request_async` — Delegate tasks to Codex CLI (pass `sessionId:<UUID>` or `resumeLatest:true` to use `codex exec resume`)
- `gemini_request` / `gemini_request_async` — Delegate tasks to Gemini CLI
- `grok_request` / `grok_request_async` — Delegate tasks to Grok CLI (xAI). Auth via prior `grok login` (OAuth) or local `XAI_API_KEY`
- `mistral_request` / `mistral_request_async` — Delegate tasks to Mistral Vibe CLI. Model selection is via `VIBE_ACTIVE_MODEL` env var (no `--model` flag); `permissionMode` is the `--agent` enum and defaults to `auto-approve` for programmatic callers. Session continuity (`sessionId`/`resumeLatest`) requires `[session_logging] enabled = true` in `~/.vibe/config.toml`.
- `llm_job_status` — Check async job progress (in-memory + durable store fallback)
- `llm_job_result` — Fetch completed job output (durable: default 30-day retention, `LLM_GATEWAY_JOB_RETENTION_DAYS`)
- `llm_job_cancel` — Cancel a running async job (only on explicit instruction or hard failure)
- `llm_process_health` — Inspect in-memory process/job health
- `list_models`, `cli_versions`, `cli_upgrade` — Inspect model/CLI registry and manage CLI upgrades (Grok self-updates via `grok update`)
- `session_*` — Manage conversation sessions

## Cache-Aware Prompts (`promptParts`)

Every `*_request` / `*_request_async` tool accepts a structured `promptParts` object as an alternative to the flat `prompt` string. The two are **mutually exclusive** — supplying both returns `provide exactly one of \`prompt\` or \`promptParts\``; supplying neither returns `one of \`prompt\` or \`promptParts\` is required`.

```json
{
  "promptParts": {
    "system":  "long stable system instruction (optional)",
    "tools":   "long stable tool description (optional)",
    "context": "long stable file dump / spec / repo summary (optional)",
    "task":    "the volatile per-turn question (required)"
  }
}
```

The gateway concatenates in canonical order — `system → tools → context → task` — so the stable prefix bytes precede the volatile task tail **unchanged across calls**. That raises implicit cache hit rate at the provider with no API contortions, and the gateway hashes the stable prefix into the flight recorder so cache effectiveness is observable.

When to reach for `promptParts` over `prompt`:
- Multi-turn workflows where the system/tools/context blocks are long and repeated.
- Parallel dispatch across CLIs where each reviewer sees the same stable prefix.
- Any review loop (`implement → review → fix → re-review`) on the same file set — the context block is identical round-to-round; only the `task` mutates.

For one-off questions or short prompts, plain `prompt` is fine — `promptParts` only earns its keep when the stable prefix is large enough to matter.

### Cache observability (read-only MCP resources)

- `cache-state://global` — last-24h aggregate hit rate, total hits, estimated savings, with per-CLI breakdown.
- `cache-state://session/{sessionId}` — per-session aggregates, including `ttlRemainingMs` for Claude.
- `cache-state://prefix/{hash}` — per-stable-prefix-hash aggregates with CLI × model breakdown.

All three return tokens / hashes / aggregates only — no prompt or response text. Read via the MCP `resources/read` flow. `session_get` also projects a compact `cacheState` block when the session has prior requests in the flight recorder; the field is omitted for fresh sessions.

### TTL warning (Claude only, opt-in)

With `[cache_awareness] warn_on_ttl_expiry = true` in `~/.llm-cli-gateway/config.toml`, `claude_request` / `claude_request_async` responses on resumed Claude sessions carry a structured warning when the session's prior `lastRequestAt` is within 30 s of Anthropic's cache TTL (5 min default, 1 h when `anthropic_ttl_seconds = 3600`):

```json
{ "warnings": [{ "code": "cache_ttl_expiring_soon", "ttlRemainingMs": 12000, "message": "..." }] }
```

Treat it as a hint to coalesce the next turn or accept the upcoming cache miss.

## Patterns

### Parallel Review
Send the same review request to multiple LLMs simultaneously using async tools, then compare results:
1. `codex_request_async` with review prompt (`fullAuto:true`, `approvalStrategy:"mcp_managed"`)
2. `gemini_request_async` with same review prompt (`approvalStrategy:"mcp_managed"`)
3. `grok_request_async` with same review prompt (`approvalStrategy:"mcp_managed"`) — optional 4th reviewer for diversity / consensus tie-breaks
4. Poll each with `llm_job_status` every 60 s
5. Fetch results with `llm_job_result`
6. Synthesize findings; on any `NOT APPROVED` verdict, fix and re-review — loop until all APPROVED

If polling times out, re-issue the same call (auto-dedup snaps onto the live job) or fetch by `jobId` later — results are durable.

### Implement-Review-Fix
1. `codex_request` to implement (`fullAuto:true`, `approvalStrategy:"mcp_managed"`)
2. `gemini_request` to review (`approvalStrategy:"mcp_managed"`, verdict clause in prompt)
3. `codex_request` to apply fixes; re-dispatch step 2 to same reviewer — loop until unconditional APPROVED

### Session Continuity
All four CLIs carry real session continuity through the gateway:
- **Claude** — `--session-id` / `--continue`. `createNewSession:true` for fresh, otherwise active session auto-continues.
- **Codex** — `codex exec resume <UUID>` via `sessionId:<real Codex UUID>`, or `codex exec resume --last` via `resumeLatest:true`. Gateway-generated `gw-*` IDs are rejected for Codex. `--full-auto` is silently dropped on resume; the original session's approval policy is inherited.
- **Gemini** — `--resume` via `sessionId` (or `resumeLatest:true`). Gateway-generated `gw-*` IDs are bookkeeping-only and rejected if replayed.
- **Grok** — `--resume <id>` via `sessionId` or `--continue` via `resumeLatest:true`.

Use `session_create` before a multi-turn workflow, then pass `sessionId` to subsequent requests.

## Rules
- Explicit async tools return `job.id`; sync auto-deferral returns top-level `jobId`. Poll with `llm_job_status` every 60 s, fetch with `llm_job_result`.
- Sync requests that exceed 45s auto-defer to async — check the response for `jobId`. Results are durable (30-day default retention via `LLM_GATEWAY_JOB_RETENTION_DAYS`), so you can fetch by `jobId` after a polling timeout or across gateway restarts.
- Identical replays within `LLM_GATEWAY_DEDUP_WINDOW_MS` (default 1 h) auto-dedup onto the existing job. Pass `forceRefresh:true` to force a fresh CLI run.
- `mcpServers` defaults to `["sqry"]`. Add `exa`, `ref_tools`, or `trstr` explicitly when needed.
- Prefer `promptParts` over `prompt` for any workflow with a large stable prefix (system/tools/context) — the gateway maintains canonical-order concatenation so the prefix bytes are identical across calls, raising implicit cache hit rate. The two fields are mutually exclusive.
- Claude: `mcpServers` builds a Claude MCP config. Gemini: gateway passes `--allowed-mcp-server-names`, but Gemini CLI must already have those servers configured. Codex and Grok: `mcpServers` is approval tracking only; the CLIs manage their own MCP config.
- Check `cli_versions` when a CLI behaves unexpectedly; call `cli_upgrade` with `dryRun:true` before running an actual upgrade (Grok self-updates via `grok update`).
