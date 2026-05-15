---
name: multi-llm-orchestration
description: Guide for orchestrating multiple LLMs via the llm-gateway — use when delegating tasks to Codex, Gemini, or Grok, running parallel reviews, or managing cross-LLM workflows
---

# Multi-LLM Orchestration

Use the llm-gateway MCP server tools to orchestrate work across Claude, Codex, Gemini, and Grok (xAI).

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution; Claude then uses `bypassPermissions`, Gemini uses `yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work.
3. **No wallclock timeout; poll every 60 s** — `idleTimeoutMs` is a separate no-output safeguard.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch → parse verdict → on `NOT APPROVED` or conditional, fix + re-review → repeat. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Available Tools

- `claude_request` / `claude_request_async` — Send prompts to Claude Code CLI
- `codex_request` / `codex_request_async` — Delegate tasks to Codex CLI (pass `sessionId:<UUID>` or `resumeLatest:true` to use `codex exec resume`)
- `gemini_request` / `gemini_request_async` — Delegate tasks to Gemini CLI
- `grok_request` / `grok_request_async` — Delegate tasks to Grok CLI (xAI). Auth via prior `grok login` (OAuth) or `GROK_CODE_XAI_API_KEY`
- `llm_job_status` — Check async job progress (in-memory + durable store fallback)
- `llm_job_result` — Fetch completed job output (durable: default 30-day retention, `LLM_GATEWAY_JOB_RETENTION_DAYS`)
- `llm_job_cancel` — Cancel a running async job (only on explicit instruction or hard failure)
- `llm_process_health` — Inspect in-memory process/job health
- `list_models`, `cli_versions`, `cli_upgrade` — Inspect model/CLI registry and manage CLI upgrades (Grok self-updates via `grok update`)
- `session_*` — Manage conversation sessions

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
- Claude: `mcpServers` builds a Claude MCP config. Gemini: gateway passes `--allowed-mcp-server-names`, but Gemini CLI must already have those servers configured. Codex and Grok: `mcpServers` is approval tracking only; the CLIs manage their own MCP config.
- Check `cli_versions` when a CLI behaves unexpectedly; call `cli_upgrade` with `dryRun:true` before running an actual upgrade (Grok self-updates via `grok update`).
