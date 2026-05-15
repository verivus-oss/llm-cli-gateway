---
name: session-workflow
description: Manage conversation sessions across Claude, Codex, Gemini, and Grok. Use for multi-turn conversations, session switching, workspace management.
metadata:
  author: verivusai-labs
  version: "1.5"
---

# Session Workflow

Sessions track conversation context across requests. One active session per CLI.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). For Codex, also pass `fullAuto:true` when the task needs file/shell access.
3. **No wallclock timeout; poll every 60 s** — `idleTimeoutMs` is a separate no-output safeguard.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch review → poll if deferred → parse verdict → on `NOT APPROVED` or conditional approval, dispatch fixes + re-review → repeat. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches. Sessions make the loop cheap (Claude and Gemini preserve conversation continuity).

## Key Concepts

- **Active session** — default when no `sessionId` specified
- **Session ID** — string identifier (UUID or arbitrary)
- **`gw-*` prefix** — gateway-generated Gemini bookkeeping IDs; rejected if passed back to Gemini as `sessionId`
- **`resumable`** — Gemini response field: `true`=user-provided ID, `false`=gateway `gw-*` ID
- **Session TTL** — 30 days inactivity (configurable: `SESSION_TTL` env var, seconds)
- Stores metadata only (id, cli, timestamps, description) — not conversation content

## Session Continuity Per CLI

| CLI | Effect | Mechanism |
|-----|--------|-----------|
| **Claude** | Real continuity | `--session-id` or `--continue` to CLI |
| **Codex** | Real continuity | `codex exec resume <UUID>` (`sessionId`) or `codex exec resume --last` (`resumeLatest:true`). `sessionId` must be a real Codex UUID from `~/.codex/sessions/`; gateway-generated `gw-*` IDs are rejected. `--full-auto` silently dropped on resume (approval policy inherits from the original session) |
| **Gemini** | Real continuity | `--resume` to CLI |
| **Grok** | Real continuity | `--resume` / `--continue` to CLI |

All four CLIs now carry true multi-turn continuity. For Codex, you must either pass `resumeLatest:true` or supply a real Codex session UUID — the gateway no longer treats Codex sessions as bookkeeping-only.

## Creating Sessions

### Explicit

```
session_create({cli:"claude",description:"Refactoring auth module",setAsActive:true})
```

Returns: `{success:true,session:{id,cli,description,createdAt,isActive}}`

### Via request

```
claude_request({prompt:"...",createNewSession:true,approvalStrategy:"mcp_managed"})
```

### Implicit active session

- **Claude** — auto-continues active session via `--continue`
- **Codex** — no auto-lookup; pass `resumeLatest:true` (→ `codex exec resume --last`) or `sessionId:<UUID>` (→ `codex exec resume <UUID>`) explicitly
- **Gemini** — no auto-lookup; use `sessionId` or `resumeLatest:true` explicitly
- **Grok** — pass `sessionId` (or `resumeLatest:true`) to resume via `--resume`/`--continue`

```
claude_request({prompt:"Continue where we left off",approvalStrategy:"mcp_managed"})           // auto-continues
codex_request({prompt:"Continue",resumeLatest:true,fullAuto:true,approvalStrategy:"mcp_managed"}) // codex exec resume --last
gemini_request({prompt:"Continue analysis",resumeLatest:true,approvalStrategy:"mcp_managed"}) // explicit resume
grok_request({prompt:"Continue",sessionId:"my-grok-session",approvalStrategy:"mcp_managed"})  // explicit resume
```

## Multi-Turn Patterns

### Claude (real continuity)

```
claude_request({prompt:"Implement rate limiter in src/rate-limiter.ts",createNewSession:true,approvalStrategy:"mcp_managed"})
// Save returned sessionId

claude_request({prompt:"Add unit tests for rate limiter",sessionId:"[saved id]",approvalStrategy:"mcp_managed"})
```

### Codex (real continuity via `codex exec resume`)

Pass `resumeLatest:true` to continue the most recent Codex session in cwd, or `sessionId:<UUID>` to target a specific session (UUID visible in `~/.codex/sessions/` or via `codex resume`):

```
codex_request({prompt:"Implement rate limiter with sliding window",fullAuto:true,approvalStrategy:"mcp_managed"})
// Subsequent turn — resume the same Codex session:
codex_request({prompt:"Add tests: basic limiting, burst traffic, window expiry.",resumeLatest:true,approvalStrategy:"mcp_managed"})
// Or target a known UUID:
codex_request({prompt:"Now add metrics.",sessionId:"7f9f9a2e-1b3c-4c7a-9b0e-deadbeefcafe",approvalStrategy:"mcp_managed"})
```

Note: `fullAuto:true` is silently dropped on resume — the original session's approval policy is inherited. If you need a fresh approval posture, pass `createNewSession:true` and re-state the context.

### Gemini (resumable)

```
gemini_request({prompt:"Continue analysis",resumeLatest:true,approvalStrategy:"mcp_managed"})
gemini_request({prompt:"Continue",sessionId:"latest",approvalStrategy:"mcp_managed"})
gemini_request_async({prompt:"Deep analysis...",sessionId:"my-gemini-session",approvalStrategy:"mcp_managed"})
// Response: resumable:true
```

### Grok (real continuity)

Grok carries real CLI continuity via `--resume` / `--continue`. Auth must already be set up (`grok login` OAuth, or `GROK_CODE_XAI_API_KEY`):

```
grok_request({prompt:"Implement rate limiter in src/rate-limiter.ts",createNewSession:true,approvalStrategy:"mcp_managed"})
// Save returned sessionId

grok_request({prompt:"Add unit tests for the rate limiter",sessionId:"[saved id]",approvalStrategy:"mcp_managed"})
```

## Switching Sessions

```
session_list()                                    // all sessions
session_list({cli:"claude"})                      // filter by CLI
session_set_active({cli:"claude",sessionId:"..."}) // switch active
session_set_active({cli:"claude",sessionId:null})  // clear active
```

## Parallel Workflows

Separate sessions for independent workstreams:

```
session_create({cli:"claude",description:"Feature: user auth"})   // → authSessionId
session_create({cli:"claude",description:"Bugfix: rate limit"})   // → bugfixSessionId

claude_request({prompt:"...",sessionId:authSessionId,approvalStrategy:"mcp_managed"})    // auth context
claude_request({prompt:"...",sessionId:bugfixSessionId,approvalStrategy:"mcp_managed"})  // bugfix context
```

## Session TTL

Default: 30 days. Expired sessions silently evicted on next operation.

```bash
SESSION_TTL=604800  # 7 days
SESSION_TTL=7776000 # 90 days
```

- Based on `lastUsedAt`, not `createdAt`
- Active sessions stay alive with use
- If active session expires, active pointer cleared
- File-based and PostgreSQL backends both enforce TTL

## Gateway Prefix (`gw-`)

Gemini requests without explicit `sessionId` → gateway generates `gw-*` ID.

Passing `gw-*` as `sessionId` → rejected:
> Session ID "gw-..." uses reserved prefix "gw-".

Check `resumable` field: `true`=safe to reuse, `false`=gateway-generated.

## Cleanup

```
session_delete({sessionId:"..."})   // single
session_clear_all({cli:"codex"})    // per CLI
session_clear_all()                 // everything
```

## Inspect

```
session_get({sessionId:"..."})
```

Returns: timestamps, description, CLI type, active status.

## Tips

- Descriptive names: "Refactoring auth module" > "Session 1"
- Use `createNewSession:true` for quick one-offs
- Clean up completed workflow sessions
- Each CLI tracks active session independently
- For Codex: real `codex exec resume <UUID>` / `--last` continuity. The gateway-tracked session ID is independent of the Codex CLI's session UUID — for resume, supply a real Codex UUID or use `resumeLatest:true`. `--full-auto` is dropped on resume (approval policy inherits from the original session)
- For Grok: real `--resume`/`--continue` continuity, same model as Claude — but auth must be set up first (`grok login` or `GROK_CODE_XAI_API_KEY`)
- Expired sessions (past TTL) silently evicted
- Never pass Gemini `gw-*` IDs as `sessionId` — use own IDs for resumable Gemini workflows
- Check Gemini's `resumable` field to know if that session can continue
- Sync tools may auto-defer at 45s — deferred response preserves `sessionId`. Deferred jobs and their results are now durable (default 30-day retention via `LLM_GATEWAY_JOB_RETENTION_DAYS`), so a session that auto-defers can be picked up across gateway restarts
