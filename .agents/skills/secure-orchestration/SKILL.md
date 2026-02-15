---
name: secure-orchestration
description: Security-conscious LLM orchestration with the llm-cli-gateway approval system. Use when executing high-risk operations, managing permissions, auditing LLM requests, or when the user requires approval gates.
metadata:
  author: verivusai-labs
  version: "1.2"
---

# Secure Orchestration

The gateway includes an approval gate that scores request risk and enforces policy thresholds. Use this skill when security matters — production codebases, sensitive data, or autonomous operations.

## Approval System Overview

Every request can be evaluated by the approval engine before execution. The engine assigns a risk score based on the request parameters and compares it to a policy threshold.

### Risk Scoring

| Factor | Points | Trigger |
|--------|--------|---------|
| Permission bypass requested | +3 | `dangerouslySkipPermissions: true`, `dangerouslyBypassApprovalsAndSandbox: true`, or Gemini `approvalMode: "yolo"` under mcp_managed |
| Sensitive keywords in prompt | +3 | Regex match: `delete`, `destroy`, `wipe`, `exfiltrate`, `credential`, `token`, `password`, `secret` |
| Full auto mode | +2 | `fullAuto: true` (Codex) |
| Bypass + full-auto combo | +2 | Both bypass AND full-auto requested together |
| Exa MCP server requested | +2 | Web search access via `mcpServers: ["exa"]` |
| Ref tools MCP requested | +1 | Reference tools access |
| Empty allowedTools | -1 | `allowedTools: []` (no tools permitted — reduces risk) |
| Explicit disallowedTools | -1 | Non-empty `disallowedTools` array (restricts capabilities) |

### Policy Thresholds

| Policy | Max Score | Use When |
|--------|-----------|----------|
| `strict` | 2 | Production, security-sensitive, untrusted prompts |
| `balanced` | 5 | Normal development, trusted prompts |
| `permissive` | 7 | Experimentation, sandboxed environments |

Requests with score > threshold are **denied**. Default policy is `balanced`, overridable via `LLM_GATEWAY_APPROVAL_POLICY` env var.

## Enabling Approval Gates

### Per-request approval

```
claude_request({
  prompt: "Refactor the authentication module",
  approvalStrategy: "mcp_managed",
  approvalPolicy: "strict"
})
```

The response includes the approval decision:
```json
{
  "approval": {
    "id": "appr-...",
    "status": "approved",
    "score": 0,
    "policy": "strict",
    "reasons": []
  }
}
```

### Denied request example

```
codex_request({
  prompt: "Delete all test fixtures",
  fullAuto: true,
  dangerouslyBypassApprovalsAndSandbox: true,
  approvalStrategy: "mcp_managed",
  approvalPolicy: "strict"
})
```

Score breakdown: bypass (+3) + full-auto (+2) + bypass+full-auto combo (+2) + sensitive keyword "delete" (+3) + default exa (+2) + default ref_tools (+1) = **13**, exceeds strict threshold of 2.

The request is NOT executed when denied.

### Async requests with approval gates

Approval gates work identically for async requests. The approval check happens before the job is spawned:

```
gemini_request_async({
  prompt: "Audit the authentication module for vulnerabilities",
  model: "gemini-2.5-pro",
  approvalStrategy: "mcp_managed",
  approvalPolicy: "strict"
})
```

If approved, the async job starts and you get a `job.id` to poll. If denied, no job is created and the denial is returned immediately.

### Important: mcp_managed forces permissive CLI modes

When `approvalStrategy: "mcp_managed"` is set, the gateway takes over approval enforcement and forces permissive CLI modes:
- Claude: `--permission-mode bypassPermissions`
- Gemini: `--approval-mode yolo`

This means the gateway's approval engine is the sole gatekeeper — the CLIs themselves will not prompt for approval.

## Audit Trail

All approval decisions are logged to a JSONL audit file. Review the trail with:

```
approval_list({ limit: 50 })
```

Returns:
```json
{
  "approvals": [
    {
      "id": "appr-...",
      "ts": "2026-02-15T...",
      "status": "approved",
      "policy": "balanced",
      "cli": "claude",
      "operation": "claude_request",
      "score": 0,
      "reasons": [],
      "promptPreview": "Refactor the authentication...",
      "promptSha256": "a1b2c3...",
      "requestedMcpServers": ["sqry", "exa"]
    }
  ]
}
```

Filter by CLI:
```
approval_list({ limit: 50, cli: "codex" })
```

Key fields:
- `promptPreview` — First 280 characters of the prompt (stored in audit log)
- `promptSha256` — SHA-256 hash of the full prompt (for correlation)
- `reasons` — Human-readable list of why points were scored
- `bypassRequested` — Whether dangerous bypass flags were set
- `fullAuto` — Whether full-auto mode was requested

## Security Guidelines

### For production code

Always use strict approval:
```
claude_request({
  prompt: "...",
  approvalStrategy: "mcp_managed",
  approvalPolicy: "strict"
})
```

### For development

Balanced is appropriate for trusted prompts:
```
codex_request({
  prompt: "...",
  approvalStrategy: "mcp_managed",
  approvalPolicy: "balanced",
  fullAuto: true
})
```

### Avoid bypass flags

Never use these in production:
- `dangerouslySkipPermissions: true` (Claude)
- `dangerouslyBypassApprovalsAndSandbox: true` (Codex)
- `approvalMode: "yolo"` (Gemini)

These exist for local development only and will trigger high risk scores.

## Permission Management

### Claude MCP servers

Control which MCP servers Claude can access:
```
claude_request({
  prompt: "...",
  mcpServers: ["sqry"],
  strictMcpConfig: true
})
```

- `mcpServers` — Which servers to enable (sqry, exa, ref_tools)
- `strictMcpConfig: true` — Fail if requested servers aren't available

### Codex sandboxing

Codex runs in a sandbox by default. `fullAuto: true` enables automated file changes but stays sandboxed:
```
codex_request({
  prompt: "...",
  fullAuto: true
})
```

### Gemini approval modes

```
gemini_request({
  prompt: "...",
  approvalMode: "default"
})
```

Options: `default` (ask for approval), `auto_edit` (auto-approve edits), `yolo` (approve everything — development only)

The same `approvalMode` parameter is available on `gemini_request_async`:

```
gemini_request_async({
  prompt: "...",
  approvalMode: "default",
  approvalStrategy: "mcp_managed",
  approvalPolicy: "strict"
})
```

### Tool restrictions

**Claude** supports both allowlists and blocklists:
```
claude_request({
  prompt: "...",
  allowedTools: ["Read", "Grep", "Glob"],
  disallowedTools: ["Bash", "Write"]
})
```

**Gemini** supports allowlists only (no `disallowedTools`):
```
gemini_request({
  prompt: "...",
  allowedTools: ["Read", "Grep"]
})
```

## Idle Timeout as a Security Control

The `idleTimeoutMs` parameter can serve as a security guardrail. A tight idle timeout ensures that stuck or misbehaving CLI processes are killed promptly, limiting the window for unintended operations.

For security-sensitive contexts, set a shorter timeout than the default 10 minutes:

```
claude_request({
  prompt: "Audit the secrets management module",
  approvalStrategy: "mcp_managed",
  approvalPolicy: "strict",
  idleTimeoutMs: 120_000
})
```

This kills the process after 2 minutes of inactivity. When idle timeout fires, the job fails with exit code 125 (non-transient — no retry).

**Guideline:** Use 60-120 seconds for security audits and sensitive operations. Use the full 10-minute default (or longer) only for large analysis tasks where long silent periods are expected.

## Tips

- Start with `strict` policy and relax only when needed
- Review the audit trail regularly with `approval_list`
- Use `correlationId` on every request for end-to-end tracing
- The approval system is opt-in via `approvalStrategy: "mcp_managed"` — the default `"legacy"` skips it
- Audit logs include a `promptPreview` (first 280 chars) and `promptSha256` hash
- Denied requests return immediately without executing — check `approval.status` in the response
- Default policy is `balanced` unless overridden by `LLM_GATEWAY_APPROVAL_POLICY` env var
- Approval gates apply equally to sync and async requests — `gemini_request_async` supports `approvalStrategy` and `approvalPolicy` just like the sync variant
- Set a tight `idleTimeoutMs` (60-120s) for security-sensitive operations to limit the window for unintended behavior
- Use `gemini_request_async` with `approvalStrategy: "mcp_managed"` for long-running Gemini security audits that need approval gates
