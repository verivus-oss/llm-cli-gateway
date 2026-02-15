---
name: session-workflow
description: Manage conversation sessions across Claude, Codex, and Gemini via the llm-cli-gateway. Use when the user needs multi-turn conversations, session switching, or workspace management across LLM CLIs.
metadata:
  author: verivusai-labs
  version: "1.1"
---

# Session Workflow

Sessions track conversation context across requests. Each CLI (Claude, Codex, Gemini) can have one active session at a time.

## Key Concepts

- **Active session** — The default session used when no `sessionId` is specified
- **Session ID** — String identifier (typically UUID, but arbitrary strings accepted)
- **Session metadata** — Optional key-value data attached to a session (no MCP tool to update it; backend-only)
- One active session per CLI at a time
- Sessions store only metadata (id, cli, timestamps, description) — not conversation content

## Session Continuity Per CLI

**Critical:** Session behavior differs significantly between CLIs.

| CLI | Session Effect | Mechanism |
|-----|---------------|-----------|
| **Claude** | Real CLI continuity | Gateway passes `--session-id` or `--continue` to Claude CLI |
| **Codex** | Gateway bookkeeping only | `sessionId` is tracked but NOT passed to Codex CLI; each call is a fresh invocation |
| **Gemini** | Real CLI continuity | Gateway passes `--resume` to Gemini CLI |

For Claude and Gemini, sessions enable true multi-turn conversations. For Codex, sessions are organizational metadata only — include all necessary context in every prompt.

## Creating Sessions

### Explicit creation

```
session_create({
  cli: "claude",
  description: "Refactoring auth module",
  setAsActive: true
})
```

Returns `{ success: true, session: { id, cli, description, createdAt, isActive } }`

### Auto-creation via request

Requests auto-create gateway session records when needed:

```
claude_request({
  prompt: "...",
  createNewSession: true
})
```

Note: The response includes `sessionId` only when a session was effectively resolved or created. If no session logic was triggered, the field may be absent.

### Implicit active session usage

Active session behavior varies per CLI:

- **Claude**: If no `sessionId` or `createNewSession` is specified and an active session exists, Claude auto-continues it via `--continue`
- **Codex**: The active session is used for gateway bookkeeping (tracking which session to associate) but does NOT resume Codex CLI context
- **Gemini**: No automatic active-session lookup. Use `sessionId` or `resumeLatest: true` explicitly to resume

```
// Claude: auto-continues active session
claude_request({ prompt: "Continue from where we left off" })

// Gemini: must explicitly resume
gemini_request({ prompt: "Continue the analysis", resumeLatest: true })
```

## Multi-Turn Conversations

### Pattern: Claude iterative development (real continuity)

```
// Turn 1: Start
claude_request({
  prompt: "Implement a rate limiter in src/rate-limiter.ts",
  createNewSession: true
})
// Save the returned sessionId

// Turn 2: Continue (Claude CLI resumes context)
claude_request({
  prompt: "Add unit tests for the rate limiter",
  sessionId: "[saved session id]"
})
```

### Pattern: Codex multi-step (no CLI continuity)

Since Codex does not maintain CLI conversation context, include full context in each prompt:

```
// Step 1
codex_request({
  prompt: "Implement a rate limiter in src/rate-limiter.ts with sliding window algorithm",
  fullAuto: true
})

// Step 2: Include context since Codex doesn't resume
codex_request({
  prompt: "The rate limiter in src/rate-limiter.ts uses a sliding window algorithm. Add unit tests covering: basic rate limiting, burst traffic, window expiry edge cases.",
  fullAuto: true
})
```

### Pattern: Resuming Gemini sessions

Gemini supports session resumption natively:

```
gemini_request({
  prompt: "Continue the analysis",
  resumeLatest: true
})
```

Or resume a specific session:

```
gemini_request({
  prompt: "Continue",
  sessionId: "latest"
})
```

## Switching Between Sessions

### View all sessions

```
session_list()
// or filter by CLI:
session_list({ cli: "claude" })
```

### Switch active session

```
session_set_active({
  cli: "claude",
  sessionId: "[target session id]"
})
```

### Clear active session

```
session_set_active({
  cli: "claude",
  sessionId: null
})
```

## Parallel Workflows

Use separate sessions for independent Claude workstreams:

```
// Workstream A: Feature development
session_create({ cli: "claude", description: "Feature: user auth" })
// Save session ID as authSessionId

// Workstream B: Bug fixes
session_create({ cli: "claude", description: "Bugfix: rate limit crash" })
// Save session ID as bugfixSessionId

// Work on auth feature (Claude resumes context)
claude_request({ prompt: "...", sessionId: authSessionId })

// Switch to bug fix (Claude resumes different context)
claude_request({ prompt: "...", sessionId: bugfixSessionId })
```

## Cleanup

### Delete a single session

```
session_delete({ sessionId: "[session id]" })
```

### Clear all sessions for a CLI

```
session_clear_all({ cli: "codex" })
```

### Clear everything

```
session_clear_all()
```

## Inspecting Sessions

```
session_get({ sessionId: "[session id]" })
```

Returns timestamps (`createdAt`, `lastUsedAt`), description, CLI type, and whether it's currently active.

## Tips

- Name sessions descriptively — `"Refactoring auth module"` is better than `"Session 1"`
- Use `createNewSession: true` on request tools for quick one-off sessions
- Clean up sessions when workflows complete to avoid clutter
- Sessions work identically whether backed by file storage or PostgreSQL
- Each CLI tracks its active session independently — activating a Claude session doesn't affect Codex
- `lastUsedAt` updates are conditional — they occur when a session ID is explicitly passed (not on all auto-continue flows)
- For Codex workflows, sessions are purely organizational — do not rely on them for conversation continuity
