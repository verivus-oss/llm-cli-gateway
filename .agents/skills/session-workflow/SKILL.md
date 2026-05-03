---
name: session-workflow
description: Manage conversation sessions across Claude, Codex, Gemini. Use for multi-turn conversations, session switching, workspace management.
metadata:
  author: verivusai-labs
  version: "1.4"
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
| **Codex** | Bookkeeping only | Tracked, NOT passed to CLI. Each call fresh |
| **Gemini** | Real continuity | `--resume` to CLI |

Claude/Gemini: true multi-turn. Codex: organizational metadata only — include all context in every prompt.

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
- **Codex** — active session for bookkeeping only (no CLI resume)
- **Gemini** — no auto-lookup; use `sessionId` or `resumeLatest:true` explicitly

```
claude_request({prompt:"Continue where we left off",approvalStrategy:"mcp_managed"})          // auto-continues
gemini_request({prompt:"Continue analysis",resumeLatest:true,approvalStrategy:"mcp_managed"}) // explicit resume
```

## Multi-Turn Patterns

### Claude (real continuity)

```
claude_request({prompt:"Implement rate limiter in src/rate-limiter.ts",createNewSession:true,approvalStrategy:"mcp_managed"})
// Save returned sessionId

claude_request({prompt:"Add unit tests for rate limiter",sessionId:"[saved id]",approvalStrategy:"mcp_managed"})
```

### Codex (no CLI continuity)

Include full context each call:

```
codex_request({prompt:"Implement rate limiter with sliding window",fullAuto:true,approvalStrategy:"mcp_managed"})
codex_request({prompt:"Rate limiter in src/rate-limiter.ts uses sliding window. Add tests: basic limiting, burst traffic, window expiry.",fullAuto:true,approvalStrategy:"mcp_managed"})
```

### Gemini (resumable)

```
gemini_request({prompt:"Continue analysis",resumeLatest:true,approvalStrategy:"mcp_managed"})
gemini_request({prompt:"Continue",sessionId:"latest",approvalStrategy:"mcp_managed"})
gemini_request_async({prompt:"Deep analysis...",sessionId:"my-gemini-session",approvalStrategy:"mcp_managed"})
// Response: resumable:true
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
- For Codex: sessions are organizational only — no conversation continuity
- Expired sessions (past TTL) silently evicted
- Never pass Gemini `gw-*` IDs as `sessionId` — use own IDs for resumable Gemini workflows
- Check Gemini's `resumable` field to know if that session can continue
- Sync tools may auto-defer at 45s — deferred response preserves `sessionId`
