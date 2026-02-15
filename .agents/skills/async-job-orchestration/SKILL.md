---
name: async-job-orchestration
description: Manage long-running async LLM jobs through the llm-cli-gateway. Use when tasks may exceed 2 minutes, when running parallel jobs, or when you need non-blocking LLM execution.
metadata:
  author: verivusai-labs
  version: "1.1"
---

# Async Job Orchestration

The gateway supports async execution for Claude and Codex. Use this for long-running tasks, parallel execution, or when you need to do other work while waiting.

## When to Use Async

- Task may take longer than 2 minutes (large codebases, complex analysis)
- You want to run multiple LLM tasks in parallel
- You need to monitor progress or cancel jobs

## Core Tools

| Tool | Purpose |
|------|---------|
| `claude_request_async` | Start async Claude job |
| `codex_request_async` | Start async Codex job |
| `llm_job_status` | Poll job status (no output) |
| `llm_job_result` | Retrieve job output |
| `llm_job_cancel` | Cancel a running job |

## Single Async Job

### Start

```
claude_request_async({
  prompt: "Analyze all files in src/ for type safety issues...",
  optimizePrompt: true
})
```

Response:
```json
{
  "job": {
    "id": "job-abc123",
    "cli": "claude",
    "status": "running",
    "startedAt": "2026-02-15T..."
  }
}
```

Save the `job.id` for subsequent calls.

### Poll

Check status without fetching output:

```
llm_job_status({ jobId: "job-abc123" })
```

Possible statuses: `running`, `completed`, `failed`, `canceled`

### Retrieve

Once status is not `running`, retrieve the output:

```
llm_job_result({
  jobId: "job-abc123",
  maxChars: 200000
})
```

`maxChars` controls the maximum characters returned per stream (stdout/stderr). Range: 1,000-2,000,000. Default: 200,000. When output exceeds `maxChars`, the **tail** (most recent) portion is returned with `stdoutTruncated: true` or `stderrTruncated: true`.

Note: `maxChars` is not paginated — it always returns the last N characters.

### Cancel

If the job is taking too long or is no longer needed:

```
llm_job_cancel({ jobId: "job-abc123" })
```

The gateway sends SIGTERM first, then SIGKILL after 5 seconds.

## Parallel Jobs

Run multiple LLM tasks concurrently by starting them all, then collecting results.

### Start all jobs

```
// Job 1: Claude reviews architecture
claude_request_async({
  prompt: "Review src/ architecture...",
  correlationId: "review-arch"
})

// Job 2: Codex checks implementation
codex_request_async({
  prompt: "Check src/ for bugs...",
  correlationId: "review-impl"
})

// Job 3: Gemini (sync only — no async variant)
// Run gemini_request synchronously or skip
```

### Poll all jobs

Check each job's status. Wait until all are `completed`, `failed`, or `canceled`:

```
llm_job_status({ jobId: "job-1-id" })
llm_job_status({ jobId: "job-2-id" })
```

### Collect results

Retrieve output from each finished job (works for completed, failed, AND canceled jobs):

```
llm_job_result({ jobId: "job-1-id" })
llm_job_result({ jobId: "job-2-id" })
```

## Polling Strategy

Use exponential backoff to avoid excessive polling:

1. Wait 5 seconds after starting
2. Poll every 10 seconds for the first minute
3. Poll every 30 seconds after that
4. Time out after 10 minutes and cancel the job

## Error Handling

| Status | Exit Code | Meaning | Action |
|--------|-----------|---------|--------|
| `completed` | 0 | Success | Retrieve result |
| `failed` | 124 | CLI timeout | Check stderr in result |
| `failed` | non-zero | CLI error | Check stderr in result |
| `failed` | null | Process error | Check `job.error` field |
| `canceled` | any | Job was canceled | Result still retrievable |

Important: Only `exitCode === 0` produces `completed` status. All non-zero exit codes produce `failed` status. Results are retrievable for ALL terminal states (completed, failed, canceled).

When a job fails, retrieve the result — `stderr` often contains useful diagnostics:

```
llm_job_result({ jobId: "failed-job-id" })
```

## Job Lifecycle

- Jobs are stored **in memory only** — they are lost on process restart
- Jobs have a 1-hour TTL after completion, then are evicted
- Maximum output: 50MB (stdout + stderr combined)
- Truncated output is indicated by `outputTruncated: true` in the job status
- Always retrieve results promptly — before the 1-hour TTL expires and before any restart

## Tips

- Use `correlationId` on every async job for log tracing
- Gemini does not have an async variant — use `gemini_request` synchronously
- Async jobs do NOT support `optimizeResponse` — optimize the result yourself after retrieval
- Sessions work with async jobs — pass `sessionId` or `createNewSession` as usual
- For parallel reviews, start all jobs first, then poll in a loop
- Sync request tools have a default 120s timeout via `executeCli` — use async for anything longer
