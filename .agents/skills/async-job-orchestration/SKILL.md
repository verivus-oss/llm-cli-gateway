---
name: async-job-orchestration
description: Manage long-running async LLM jobs. Use for tasks >2min, parallel jobs, or non-blocking execution.
metadata:
  author: verivusai-labs
  version: "1.3"
---

# Async Job Orchestration

Async execution for Claude, Codex, Gemini. Non-blocking jobs with polling lifecycle.

## Auto-Async Deferral

Sync tools auto-defer when execution exceeds sync deadline. No manual sync/async choice needed.

### Flow

1. Call sync tool (`claude_request`, `codex_request`, `gemini_request`)
2. Gateway starts CLI as background job, polls internally
3. Job completes within deadline (default **45s**) → result returned directly
4. Deadline exceeded → **deferred response** with `jobId` for polling

### Deferred Response

```json
{"status":"deferred","jobId":"uuid","cli":"claude","correlationId":"...","message":"Execution exceeded sync deadline (45000ms). Poll with llm_job_status, fetch with llm_job_result.","sessionId":"...","pollWith":"llm_job_status","fetchWith":"llm_job_result","cancelWith":"llm_job_cancel"}
```

### Handling

1. Parse response as JSON
2. If `status==="deferred"` → extract `jobId`
3. Poll `llm_job_status({jobId})` until status != `running`
4. Fetch `llm_job_result({jobId})`

Non-deferred responses: process as normal.

### Configuration

```bash
SYNC_DEADLINE_MS=45000  # Default: 45s (under 60s MCP client cap)
SYNC_DEADLINE_MS=0      # Disable auto-deferral (pure sync)
SYNC_DEADLINE_MS=20000  # Shorter deadline
```

### When to Use Explicit Async

Use `*_request_async` when:
- Fire-and-forget (start job, work on other tasks, check later)
- Launching multiple parallel jobs (need all job IDs upfront)
- Avoiding any sync wait (even 45s deadline)

## Core Tools

| Tool | Purpose |
|------|---------|
| `claude_request_async` | Start async Claude job |
| `codex_request_async` | Start async Codex job |
| `gemini_request_async` | Start async Gemini job |
| `llm_job_status` | Poll job status |
| `llm_job_result` | Retrieve job output |
| `llm_job_cancel` | Cancel running job |

## Single Job

### Start

```
claude_request_async({prompt:"Analyze src/ for type safety...",optimizePrompt:true})
```

Response:
```json
{"job":{"id":"job-abc123","cli":"claude","status":"running","startedAt":"..."},"sessionId":"gw-...","resumable":false}
```

- `resumable:true` — user-provided `sessionId`, session can resume
- `resumable:false` — gateway-generated `gw-*` ID, not resumable
- `gw-*` IDs rejected if passed as `sessionId` in future requests

### Poll

```
llm_job_status({jobId:"job-abc123"})
```

Statuses: `running` | `completed` | `failed` | `canceled`

### Retrieve

```
llm_job_result({jobId:"job-abc123",maxChars:200000})
```

- `maxChars`: 1,000–2,000,000 (default 200,000). Returns tail (most recent) when truncated
- `stdoutTruncated`/`stderrTruncated` flags indicate truncation

### Cancel

```
llm_job_cancel({jobId:"job-abc123"})
```

Sends SIGTERM, then SIGKILL after 5s.

## Idle Timeout

Kills process if no stdout/stderr for configurable duration. Detects stuck processes.

| CLI | Default | Notes |
|-----|---------|-------|
| Claude | 600,000ms | **stream-json mode only.** text/json produce no output until done (would false-positive) |
| Codex | 600,000ms | Streams stderr progress — works all modes |
| Gemini | 600,000ms | Streams stdout — works all modes |

Override: `idleTimeoutMs:int (30,000–3,600,000)`

When idle timeout fires: exit code **125** (non-transient, no retry).

## Parallel Jobs

Start all, then collect:

```
claude_request_async({prompt:"Review architecture...",correlationId:"review-arch"})
codex_request_async({prompt:"Check for bugs...",correlationId:"review-impl"})
gemini_request_async({prompt:"Security audit...",model:"gemini-2.5-pro",correlationId:"review-sec"})
```

Poll each with `llm_job_status`. Retrieve with `llm_job_result` when terminal.

## Polling Strategy

1. Wait 5s after start
2. Poll every 10s for first minute
3. Poll every 30s after that
4. Timeout after 10min → cancel job

## Error Handling

| Status | Exit Code | Meaning | Action |
|--------|-----------|---------|--------|
| `completed` | 0 | Success | Retrieve result |
| `failed` | 124 | CLI timeout | Check stderr |
| `failed` | 125 | Idle timeout | Increase `idleTimeoutMs` or check CLI |
| `failed` | 126 | Output overflow (>50MB) | Reduce scope |
| `failed` | non-zero | CLI error | Check stderr |
| `failed` | null | Process error | Check `job.error` |
| `canceled` | any | Canceled | Result still retrievable |

Only `exitCode===0` → `completed`. All non-zero → `failed`. Results retrievable for ALL terminal states.

Exit codes 125/126 are non-transient — retry engine skips them. Adjust parameters instead.

## Job Lifecycle

- In-memory only — lost on process restart
- 1-hour TTL after completion, then evicted
- 50MB max output (stdout+stderr) — exceeding kills process (exit 126)
- Retrieve results promptly (before TTL/restart)

## Tips

- Use `correlationId` on every job for log tracing
- Async jobs do NOT support `optimizeResponse` — optimize after retrieval
- Sessions work with async — pass `sessionId` or `createNewSession`
- **Sync tools auto-defer at 45s** — check for `status:"deferred"` in sync responses
- `SYNC_DEADLINE_MS=0` disables auto-deferral
- Check `resumable` field — only `true` for user-provided `sessionId`
- Set higher `idleTimeoutMs` for tasks with long silent periods
