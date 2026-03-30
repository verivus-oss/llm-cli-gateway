---
description: Manage LLM gateway sessions (list, create, delete, switch)
argument-hint: '[list|create|delete|set-active] [options]'
allowed-tools: Bash
---

Manage sessions through the llm-gateway MCP server.

Raw arguments: `$ARGUMENTS`

Parse the arguments to determine which session tool to use:
- `list` or no args: use `session_list`
- `create [description]`: use `session_create`
- `delete <id>`: use `session_delete`
- `set-active <id>`: use `session_set_active`

Show the results in a readable format.
