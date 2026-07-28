---
description: Delegate a task to Codex via the LLM gateway
argument-hint: '<prompt>'
allowed-tools: Bash
---

Send a request through the llm-gateway MCP server's codex_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `codex_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt.

Do not pass `fullAuto`. It is deprecated compatibility shorthand that expands to `--sandbox workspace-write`, so defaulting to it silently grants write access. Use `sandboxMode` instead: omit it for read-only inspection, which is Codex exec's own default, and pass `workspace-write` only when the task must edit files.

Do not pass `model` unless the caller named one; the gateway resolves the configured Codex default.
