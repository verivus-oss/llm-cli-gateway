---
name: secure-orchestration
description: Security-conscious LLM orchestration with approval gates across Claude, Codex, Gemini, and Grok. Use for high-risk operations, permissions, auditing.
metadata:
  author: verivusai-labs
  version: "1.5"
---

# Secure Orchestration

Approval gate scores request risk, enforces policy thresholds. Applies uniformly to Claude, Codex, Gemini, and Grok (xAI) dispatches. Use when security matters — production codebases, sensitive data, autonomous operations.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It runs the scored gateway gate first; Claude then uses `bypassPermissions`, Gemini uses `yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work. **The `mcp_managed` auto-flip itself is not scored as raw bypass; only caller-supplied raw bypass flags incur the +3 permission-bypass penalty below.** Raw `dangerouslySkipPermissions` / `dangerouslyBypassApprovalsAndSandbox` / caller-set `approvalMode:"yolo"` remain prohibited in production because they bypass the gateway gate entirely.
3. **No wallclock timeout; poll every 60 s** — good security reviews take minutes to tens of minutes. `idleTimeoutMs` (no-output safeguard) remains a valid security control and is separate from wallclock timeout.
4. **Iterate until unconditional APPROVED** (review dispatches only) — end every review prompt with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch → parse verdict → on `NOT APPROVED` or conditional approval, dispatch fixes + re-review → repeat until unconditional APPROVED. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Risk Scoring

| Factor | Points | Trigger |
|--------|--------|---------|
| Permission bypass | +3 | Raw caller-supplied bypass: `dangerouslySkipPermissions:true`, `dangerouslyBypassApprovalsAndSandbox:true`, or caller-set Gemini `approvalMode:"yolo"`. The `approvalStrategy:"mcp_managed"` auto-flip is **not** scored here. |
| Sensitive keywords | +3 | `delete`, `destroy`, `wipe`, `exfiltrate`, `credential`, `token`, `password`, `secret` |
| Full auto | +2 | `fullAuto:true` (Codex) |
| Bypass + full-auto | +2 | Both requested together |
| Exa MCP server | +2 | Web search via `mcpServers:["exa"]` |
| Review tool suppression | +4 | Tool-suppression language detected in review context (e.g., "do not run tools") |
| Empty allowedTools (review) | +6 | `allowedTools:[]` in review context — reviewers need tool access |
| Critical tools disallowed (review) | +6 | Review context with `Read`, `Grep`, `Glob`, or `Bash` in `disallowedTools` |
| Ref tools MCP | +1 | Reference tools access |
| Empty allowedTools (non-review) | +0 | Recorded as "No tool permissions requested"; does not lower score |
| Explicit disallowedTools (non-critical/non-review) | +0 | Recorded as a restriction; does not lower score |

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

Score: bypass(+3) + full-auto(+2) + combo(+2) + "delete"(+3) = **10** > strict threshold 2. Request NOT executed.

### Async requests

Approval check happens before job spawn:

```
gemini_request_async({prompt:"Audit auth module for vulnerabilities. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",approvalPolicy:"strict"})
```

Approved → job starts, get `job.id` to poll (every 60s per dispatch defaults). Denied → no job created, denial returned.

### mcp_managed CLI effects

When `approvalStrategy:"mcp_managed"`:
- Claude: `--permission-mode bypassPermissions`
- Gemini: `--approval-mode yolo`
- Codex: no automatic bypass flag; use `fullAuto:true` for sandboxed autonomous execution. `dangerouslyBypassApprovalsAndSandbox:true` is still raw bypass. On `codex exec resume` (when `sessionId` or `resumeLatest` is set), `fullAuto` is silently dropped — the original session's approval policy is inherited, so audit the source session's approval posture before resuming.
- Grok: equivalent permissive flag handled by the Grok provider; raw `alwaysApprove` / `permissionMode` overrides are scored the same way as Claude/Gemini raw bypass.

Gateway approval engine becomes the gatekeeper before permissive CLI modes are applied.

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

**Never in production (raw CLI bypass flags — bypass the gateway gate entirely):**
- `dangerouslySkipPermissions:true` (Claude)
- `dangerouslyBypassApprovalsAndSandbox:true` (Codex)
- `approvalMode:"yolo"` (Gemini)
- Raw permissive flags on `grok_request` (e.g., caller-supplied `alwaysApprove` or permissive `permissionMode`)

Use `approvalStrategy:"mcp_managed"` instead so the gateway scores and gates the request before permissive CLI modes are applied. For Codex, include `fullAuto:true` when the task needs file or shell access (note: not honored on `codex exec resume` — the resumed session inherits its original approval policy).

## Permission Management

### Claude MCP servers

```
claude_request({prompt:"...",mcpServers:["sqry"],strictMcpConfig:true})
```

- `mcpServers` — which to enable (`sqry`, `exa`, `ref_tools`, `trstr`); default is `["sqry"]`
- `strictMcpConfig:true` — fail if unavailable

For Codex, `mcpServers` is approval tracking only; Codex uses its own MCP configuration. For Gemini, the gateway passes `--allowed-mcp-server-names`, but the servers must already exist in Gemini CLI configuration.

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
The gateway passes Gemini tool names through to the Gemini CLI; use names supported by the installed Gemini version.

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
- `approvalStrategy:"mcp_managed"` is the skill default dispatch path — the gateway schema default is `"legacy"`, which skips the gate unless explicitly selected
- Denied requests return immediately without executing
- Gates apply equally to sync and async requests
- `idleTimeoutMs` is a security control (tight 60–120 s for security audits kills silent processes quickly) — this is **not** a wallclock timeout, so it does not conflict with the "no wallclock timeout, poll every 60 s" dispatch default
- Approval checks run before auto-deferral — denied requests reject instantly
- Review dispatches loop until unconditional APPROVED — the approval gate is separate from the reviewer's verdict, and both must pass
- **Durable audit trail**: approvals and job state are persisted (default 30 days, `LLM_GATEWAY_JOB_RETENTION_DAYS`). Combine `approval_list` with `llm_job_status/result` by `correlationId` to reconstruct any past dispatch, even across gateway restarts
- **Auto-dedup interacts with approvals**: an identical replayed request within the dedup window (`LLM_GATEWAY_DEDUP_WINDOW_MS`, default 1 h) reuses the original job. The **original** approval decision is the one of record; the dedup hit does not re-run the gate. Use `forceRefresh:true` to force a fresh approval evaluation when the security-relevant context (caller, prompt, flags) has actually changed
