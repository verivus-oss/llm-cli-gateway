---
name: multi-llm-orchestration
description: Guide for orchestrating multiple LLMs via the llm-gateway — use when delegating tasks to Codex or Gemini, running parallel reviews, or managing cross-LLM workflows
---

# Multi-LLM Orchestration

Use the llm-gateway MCP server tools to orchestrate work across Claude, Codex, and Gemini.

## Available Tools

- `claude_request` / `claude_request_async` — Send prompts to Claude Code CLI
- `codex_request` / `codex_request_async` — Delegate tasks to Codex CLI
- `gemini_request` / `gemini_request_async` — Delegate tasks to Gemini CLI
- `llm_job_status` — Check async job progress
- `llm_job_result` — Fetch completed job output
- `llm_job_cancel` — Cancel a running async job
- `session_*` — Manage conversation sessions

## Patterns

### Parallel Review
Send the same review request to multiple LLMs simultaneously using async tools, then compare results:
1. `codex_request_async` with review prompt
2. `gemini_request_async` with same review prompt
3. Poll both with `llm_job_status`
4. Fetch results with `llm_job_result`
5. Synthesize findings

### Implement-Review-Fix
1. `codex_request` to implement
2. `gemini_request` to review the implementation
3. `codex_request` to apply fixes

### Session Continuity
Use `session_create` before a multi-turn workflow. Pass the `sessionId` to subsequent requests for conversation continuity.

## Rules
- Async tools return a `jobId` — poll with `llm_job_status`, fetch with `llm_job_result`
- Sync requests that exceed 45s auto-defer to async — check the response for `jobId`
- `mcpServers` on Codex/Gemini is for approval tracking only — those CLIs manage their own MCP config
- Default MCP server is `sqry` only. Add `exa` or `ref_tools` explicitly when you need web search or docs (requires API keys)
