---
description: Delegate a task to Codex via the LLM gateway
argument-hint: '<prompt>'
---

Send a request through the llm-gateway MCP server's codex_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `codex_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt.

Do not pass `fullAuto`. It is deprecated compatibility shorthand that expands to `--sandbox workspace-write`, so defaulting to it silently grants write access.

Pass `sandboxMode` explicitly. For inspection use `sandboxMode: "read-only"`; do not rely on omitting the field, because the gateway then emits no `--sandbox` flag and Codex resolves the policy from its own configuration. Pass `workspace-write` only when the task must edit files.

Do not pass `model` unless the caller named one; the gateway resolves the configured Codex default.
