---
name: async-job-orchestration
description: Manage long-running async LLM jobs. Use for tasks >2min, parallel jobs, or non-blocking execution.
metadata:
  author: verivusai-labs
  version: "1.5"
---

# Async Job Orchestration

Async execution for Claude, Codex, Gemini, and Grok. Non-blocking jobs with polling lifecycle. Job state is **durable** — results survive gateway restarts and polling timeouts (see [Durability & Dedup](#durability--dedup)).

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution; Claude then runs with `bypassPermissions`, Gemini with `yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work. Prefer this over raw bypass flags.
3. **No wallclock timeout; poll every 60 s** — see [Polling Strategy](#polling-strategy) below. Do **not** cancel jobs for taking too long; cancel only on explicit instruction or hard failure. `idleTimeoutMs` (no-output safeguard) is separate.
4. **Iterate until unconditional APPROVED** (review dispatches only) — end every review prompt with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch → poll → parse verdict → on `NOT APPROVED` or conditional approval, dispatch fixes + re-review → repeat. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Auto-Async Deferral

Sync tools auto-defer when execution exceeds sync deadline. No manual sync/async choice needed.

### Flow

1. Call sync tool (`claude_request`, `codex_request`, `gemini_request`, `grok_request`)
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
3. Poll `llm_job_status({jobId})` until `job.status` is terminal (`completed`, `failed`, `canceled`, or `orphaned`)
4. Fetch `llm_job_result({jobId})`

Non-deferred responses: process as normal. Results are durable (default 30 days) — you can fetch them long after the deferred response was returned, even across gateway restarts.

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
| `grok_request_async` | Start async Grok (xAI) job |
| `llm_job_status` | Poll job status (in-memory + durable store fallback) |
| `llm_job_result` | Retrieve job output (in-memory + durable store fallback) |
| `llm_job_cancel` | Cancel running job |
| `llm_process_health` | Inspect in-memory job/process health |

## Single Job

### Start

```
claude_request_async({prompt:"Analyze src/ for type safety...",approvalStrategy:"mcp_managed",optimizePrompt:true})
```

Response:
```json
{"success":true,"job":{"id":"job-abc123","cli":"claude","status":"running","startedAt":"..."},"sessionId":"...","approval":null,"mcpServers":{"requested":["sqry"]}}
```

- Gemini async responses also include `resumable:true|false`; only user-provided Gemini `sessionId` values are resumable
- Gateway-generated Gemini `gw-*` IDs are bookkeeping IDs and are rejected if passed back as `sessionId`

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
| Grok | 600,000ms | Streams stdout — works all modes |

Override: `idleTimeoutMs:int (30,000–3,600,000)`

When idle timeout fires: exit code **125** (non-transient, no retry).

## Parallel Jobs

Start all, then collect:

```
claude_request_async({prompt:"Review architecture... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-arch"})
codex_request_async({prompt:"Check for bugs... End with APPROVED or NOT APPROVED with findings.",fullAuto:true,approvalStrategy:"mcp_managed",correlationId:"review-impl"})
gemini_request_async({prompt:"Security audit... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-sec"})
grok_request_async({prompt:"Independent diversity review... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-grok"})
```

Poll each with `llm_job_status` every 60s. Retrieve with `llm_job_result` when terminal.

## Polling Strategy

- Poll `llm_job_status` **every 60 seconds** (not faster — wastes tokens/time)
- No wallclock timeout — good reviews take minutes to tens of minutes
- Do **not** cancel jobs for "taking too long"; cancel only on explicit user instruction or hard failure (process dead, non-transient error such as exit 125/126)
- `idleTimeoutMs` (no-output safeguard, default 10 min per CLI) remains active and will kill genuinely hung processes — this is separate from wallclock timeout and does not need tightening for normal reviews
- When using `ScheduleWakeup` or sleep loops, use 60 s cadence; the 5-minute prompt-cache window also favors intervals ≤ 270 s or ≥ 20 min — 60 s is safely inside cache

### Wait-between-polls mechanism (orchestrator-specific)

Between `llm_job_status` calls, use a **non-blocking** wait. Standalone `sleep` commands are blocked in some orchestrators (e.g. the Claude Code harness rejects `Bash({command: "sleep 60"})` as a standalone call).

- **Claude Code harness** — use `Bash` with `run_in_background: true` for a one-shot wait:
  ```
  Bash({command: "sleep 60 && echo done", run_in_background: true})
  // Returns a task ID. Harness emits a completion notification when the 60s elapses.
  // On notification, call llm_job_status.
  ```
  The `Monitor` tool is for **streaming** progress (one event per stdout line) — not for one-shot waits. Do not chain multiple short sleeps to work around the standalone-sleep block; the harness detects and blocks that too.
- **`ScheduleWakeup`** (if available in your orchestrator): schedule a wakeup with `delaySeconds: 60` and a prompt that resumes the polling loop. The runtime fires you back on schedule.
- **Codex CLI / other orchestrators**: use the orchestrator's native non-blocking wait primitive (e.g. async/await on a timer). Avoid synchronous blocking sleeps that freeze the agent loop.

Treat the wait as "yield control for ~60 s, then poll once" — not "block the shell for 60 s."

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

- **Durable**. Every state transition (start, throttled output flush, completion) is persisted to a `jobs` table in `~/.llm-cli-gateway/logs.db`. `llm_job_status` / `llm_job_result` transparently fall back to the durable store when the job is no longer in memory.
- **Default retention 30 days** — override with `LLM_GATEWAY_JOB_RETENTION_DAYS`. Override the sqlite path with `LLM_GATEWAY_JOBS_DB` (defaults to `LLM_GATEWAY_LOGS_DB`, then `~/.llm-cli-gateway/logs.db`). Set `LLM_GATEWAY_JOBS_DB=none` to disable durability (in-memory only — legacy behavior, not recommended).
- **Jobs still running when the gateway stopped** are flipped to `orphaned` on next boot (the detached child cannot be reattached). Their captured partial output remains readable via `llm_job_result`.
- 50 MB max output (stdout+stderr) — exceeding kills process (exit 126).
- In-memory cache eviction has 1-hour TTL after completion; this no longer means the result is gone — durable store backs every read.

## Durability & Dedup

The gateway is a durable result collection layer. Two behaviors directly address the "agent polls, times out, re-issues, the whole CLI run starts over" failure mode:

### Auto-dedup

Identical `*_request` / `*_request_async` calls within the dedup window (default **1 hour**, `LLM_GATEWAY_DEDUP_WINDOW_MS` in ms) short-circuit onto the existing running or completed job. You get back the same `jobId` instead of spawning a duplicate run.

- Set `LLM_GATEWAY_DEDUP_WINDOW_MS=0` to disable dedup gateway-wide.
- Pass `forceRefresh: true` on a single call to bypass dedup for that request:

```
codex_request_async({prompt:"...",fullAuto:true,approvalStrategy:"mcp_managed",forceRefresh:true})
```

Use `forceRefresh` when you genuinely need a fresh CLI run (e.g., file contents changed since the last dispatch, retry after manual fix). For normal "I crashed and restarted, let me re-issue" recovery, **omit `forceRefresh`** — dedup is exactly what you want.

### Durable retrieval

- Polling timeouts no longer destroy results. If your wrapper agent gives up at 5 minutes, `llm_job_status({jobId})` and `llm_job_result({jobId})` still return the completed result hours/days later.
- Gateway restarts no longer destroy results. Persisted rows survive process restarts.
- An `orphaned` job is one that was `running` when the gateway last stopped — partial output is still readable; treat it as a non-recoverable terminal state for the active CLI invocation (re-dispatch with `forceRefresh:true` if you need fresh work).

### Recovery pattern

```
// 1. Wrapper agent died after dispatching — you have no jobId in memory.
// 2. Re-issue the identical *_request_async call. The gateway dedups onto
//    the existing in-flight or completed job and returns its jobId.
result = codex_request_async({prompt:"<same prompt as before>",fullAuto:true,approvalStrategy:"mcp_managed",correlationId:"<same correlationId>"})
// result.job.id is the original job
// 3. Poll/fetch as normal — works whether the job is running, completed, or completed days ago.
```

## Tips

- Use `correlationId` on every job for log tracing
- Async jobs do NOT support `optimizeResponse` — optimize after retrieval
- Sessions work with async — pass `sessionId` or `createNewSession` (Claude, Gemini, and Grok carry real CLI continuity; Codex is bookkeeping only)
- **Sync tools auto-defer at 45s** — check for `status:"deferred"` in sync responses, then poll every 60s
- `SYNC_DEADLINE_MS=0` disables auto-deferral
- For Gemini, check `resumable` — only `true` for user-provided `sessionId`
- Set higher `idleTimeoutMs` for tasks with long silent periods
- Review jobs: the verdict from the CLI is the gate — loop until unconditional APPROVED, do not settle early
- If jobs fail because a CLI is missing or stale, check `cli_versions` and run `cli_upgrade` as a dry run before any real upgrade. Grok self-updates via `grok update`; `cli_upgrade` routes that for you.
- **Don't burn re-runs after a polling timeout** — re-issue the same call; auto-dedup snaps you back onto the live job. Reserve `forceRefresh:true` for cases where the underlying inputs actually changed.
- **Durable results outlive in-memory caches** — `llm_job_result({jobId})` returns the same output 30 days later by default. Don't hold polling open just because you fear losing the result.
