---
description: Delegate a task to Codex via the LLM gateway
argument-hint: '<prompt>'
allowed-tools: Bash
---

Send a request through the llm-gateway MCP server's codex_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `codex_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt. Default to fullAuto mode.
