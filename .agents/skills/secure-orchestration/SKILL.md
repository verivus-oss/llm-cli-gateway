---
name: secure-orchestration
description: Security-conscious LLM orchestration with approval gates. Use for high-risk operations, permissions, auditing.
metadata:
  author: verivusai-labs
  version: "1.3"
---

# Secure Orchestration

Approval gate scores request risk, enforces policy thresholds. Use when security matters — production codebases, sensitive data, autonomous operations.

## Risk Scoring

| Factor | Points | Trigger |
|--------|--------|---------|
| Permission bypass | +3 | `dangerouslySkipPermissions:true`, `dangerouslyBypassApprovalsAndSandbox:true`, Gemini `approvalMode:"yolo"` |
| Sensitive keywords | +3 | `delete`, `destroy`, `wipe`, `exfiltrate`, `credential`, `token`, `password`, `secret` |
| Full auto | +2 | `fullAuto:true` (Codex) |
| Bypass + full-auto | +2 | Both requested together |
| Exa MCP server | +2 | Web search via `mcpServers:["exa"]` |
| Review tool suppression | +4 | Tool-suppression language detected in review context (e.g., "do not run tools") |
| Review inlined code | +2 | Large `<code>` blocks (200+ chars) inlined in review context instead of file paths |
| Empty allowedTools (review) | +3 | `allowedTools:[]` in review context — reviewers need tool access |
| Ref tools MCP | +1 | Reference tools access |
| Empty allowedTools (non-review) | -1 | `allowedTools:[]` outside review context (no tools — reduces risk) |
| Explicit disallowedTools | -1 | Non-empty `disallowedTools` (restricts capabilities) |

## Policy Thresholds

| Policy | Max Score | Use When |
|--------|-----------|----------|
| `strict` | 2 | Production, security-sensitive, untrusted prompts |
| `balanced` | 5 | Normal development, trusted prompts |
| `permissive` | 7 | Experimentation, sandboxed environments |

Score > threshold → **denied**. Default: `balanced` (override: `LLM_GATEWAY_APPROVAL_POLICY` env var).

## Enabling Approval Gates

### Per-request

```
claude_request({prompt:"Refactor auth module",approvalStrategy:"mcp_managed",approvalPolicy:"strict"})
```

Response includes:
```json
{"approval":{"id":"appr-...","status":"approved","score":0,"policy":"strict","reasons":[]}}
```

### Denied example

```
codex_request({prompt:"Delete all test fixtures",fullAuto:true,dangerouslyBypassApprovalsAndSandbox:true,approvalStrategy:"mcp_managed",approvalPolicy:"strict"})
```

Score: bypass(+3) + full-auto(+2) + combo(+2) + "delete"(+3) + exa(+2) + ref_tools(+1) = **13** > strict threshold 2. Request NOT executed.

### Async requests

Approval check happens before job spawn:

```
gemini_request_async({prompt:"Audit auth module for vulnerabilities",model:"gemini-2.5-pro",approvalStrategy:"mcp_managed",approvalPolicy:"strict"})
```

Approved → job starts, get `job.id` to poll. Denied → no job created, denial returned.

### mcp_managed forces permissive CLI modes

When `approvalStrategy:"mcp_managed"`:
- Claude: `--permission-mode bypassPermissions`
- Gemini: `--approval-mode yolo`

Gateway approval engine becomes sole gatekeeper — CLIs won't prompt.

## Audit Trail

```
approval_list({limit:50})
```

Returns:
```json
{"approvals":[{"id":"appr-...","ts":"...","status":"approved","policy":"balanced","cli":"claude","operation":"claude_request","score":0,"reasons":[],"promptPreview":"Refactor the auth...","promptSha256":"a1b2c3...","requestedMcpServers":["sqry","exa"]}]}
```

Filter: `approval_list({limit:50,cli:"codex"})`

Key fields: `promptPreview` (first 280 chars) | `promptSha256` (correlation) | `reasons` (score breakdown) | `bypassRequested` | `fullAuto`

## Security Guidelines

**Production:** Always strict approval:
```
claude_request({prompt:"...",approvalStrategy:"mcp_managed",approvalPolicy:"strict"})
```

**Development:** Balanced for trusted prompts:
```
codex_request({prompt:"...",approvalStrategy:"mcp_managed",approvalPolicy:"balanced",fullAuto:true})
```

**Never in production:**
- `dangerouslySkipPermissions:true` (Claude)
- `dangerouslyBypassApprovalsAndSandbox:true` (Codex)
- `approvalMode:"yolo"` (Gemini)

## Permission Management

### Claude MCP servers

```
claude_request({prompt:"...",mcpServers:["sqry"],strictMcpConfig:true})
```

- `mcpServers` — which to enable (sqry, exa, ref_tools)
- `strictMcpConfig:true` — fail if unavailable

### Codex sandboxing

`fullAuto:true` enables automated changes, stays sandboxed.

### Gemini approval modes

`approvalMode`: `default` (ask) | `auto_edit` (auto-approve edits) | `yolo` (dev only)

### Tool restrictions

**Claude** — allowlists + blocklists:
```
claude_request({prompt:"...",allowedTools:["Read","Grep","Glob"],disallowedTools:["Bash","Write"]})
```

**Gemini** — allowlists only:
```
gemini_request({prompt:"...",allowedTools:["Read","Grep"]})
```

## Idle Timeout as Security Control

Tight idle timeout limits window for unintended operations:

```
claude_request({prompt:"Audit secrets module",approvalStrategy:"mcp_managed",approvalPolicy:"strict",idleTimeoutMs:120000})
```

Kills process after 2min inactivity. Exit code 125 (non-transient, no retry).

**Guideline:** 60-120s for security audits. Full 10min default for large analysis only.

## Tips

- Start `strict`, relax only when needed
- Review audit trail regularly: `approval_list`
- Use `correlationId` on every request for tracing
- Approval is opt-in: `approvalStrategy:"mcp_managed"` (default `"legacy"` skips it)
- Denied requests return immediately without executing
- Gates apply equally to sync and async requests
- Set tight `idleTimeoutMs` (60-120s) for sensitive operations
- Approval checks run before auto-deferral — denied requests reject instantly
