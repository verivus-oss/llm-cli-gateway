---
description: Delegate a task to Codex via the LLM gateway
argument-hint: '<prompt>'
---

Send a request through the llm-gateway MCP server's codex_request tool.

Raw arguments: `$ARGUMENTS`

Use the llm-gateway's `codex_request` MCP tool to execute this prompt. Pass the raw arguments as the prompt.

Do not pass `fullAuto`. It is deprecated compatibility shorthand that expands to `--sandbox workspace-write`, so defaulting to it silently grants write access.

Pass `sandboxMode` explicitly on a new session. For inspection use `sandboxMode: "read-only"`; do not rely on omitting the field, because the gateway then emits no `--sandbox` flag and Codex resolves the policy from configuration, project trust, and its own fallback, so a trusted project can resolve to `workspace-write`. Pass `workspace-write` only when the task must edit files.

The gateway filters `--sandbox` out of a resume argv, so `sandboxMode` has no effect on a resumed request. That is not a guarantee that the resumed session keeps its original posture: `configOverrides` still passes through and can set `sandbox_mode`, and Codex re-resolves configuration on a cold resume. Establish the posture on the first request and verify it when it matters.

Do not pass `model` unless the caller named one; the gateway resolves the configured Codex default.
