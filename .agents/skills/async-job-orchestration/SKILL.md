---
name: async-job-orchestration
description: Manage long-running async LLM jobs across Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor. Use for parallel or non-blocking execution. Covers backend-qualified durability, cache-aware `promptParts`, `cache-state://` MCP resources, and the Claude `cache_ttl_expiring_soon` warning.
metadata:
  author: verivus-oss
  version: "1.6"
---

# Async Job Orchestration

Async execution is available for Claude, Codex, Gemini, Grok, Mistral, Devin,
and Cursor when the gateway registers async tools. SQLite and PostgreSQL stores
preserve jobs across gateway restarts; acknowledged `memory` storage lasts only
for the process lifetime; `persistence.backend = "none"` registers no async or
job tools. See [Durability & Dedup](#durability--dedup).

> **Mistral Vibe**: the gateway always emits `--agent <mode>` and defaults to
> `accept-edits` for programmatic callers. Mistral uses
> `approvalStrategy:"legacy"`: `mcp_managed` is rejected before launch and
> `approvalPolicy` has no effect. Current Vibe defaults session logging on;
> `doctor --json` flags an explicit `[session_logging] enabled = false` before
> session-continuity use.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`:** let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches.
2. **Managed approval is Claude-only.** Use
   `approvalStrategy:"mcp_managed"` only with `claude_request` or
   `claude_request_async`. The gateway makes a request-scoped
   `--strict-mcp-config` from only provisioned gateway-owned local MCP
   definitions; dynamic `npx`, ambient `PATH`, and Codex-config overrides are
   excluded. Use `approvalStrategy:"legacy"` for Codex, Gemini, Grok, Mistral,
   Devin, and Cursor. They reject `mcp_managed` before launch because their
   ambient MCP configuration cannot be isolated. `approvalPolicy` is valid only
   for Claude managed requests and has no effect with legacy.
3. **No wallclock timeout; poll every 60 s by default:** see [Polling Strategy](#polling-strategy) below. When the user requests a 90-second progress cadence, do not poll earlier. Do **not** cancel jobs for taking too long; cancel only on explicit instruction or hard failure. `idleTimeoutMs` (no-output safeguard) is separate.
4. **Complete mandatory reviews without a cap.** Dispatch review work only through
   the current local stdio gateway MCP surface. Require the terminal JSON verdict
   `APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED`, or `BLOCKED_EXTERNAL`. On
   `CHANGES_REQUIRED`, a qualified result, incomplete evidence, or malformed
   output, fix or rebut findings with evidence and re-review the same required
   reviewer. Do not set a review round, turn, token, price, budget, or wallclock
   limit. A failed or unavailable required reviewer must be retained as
   `BLOCKED_EXTERNAL` with its exact error, never treated as approved. Repair
   and retry it until it returns `APPROVED_UNCONDITIONALLY`, or stop only for
   explicit user cancellation or a terminal external blocker.

## Explicit user-authorized full-access review jobs

The normal examples in this skill retain safe defaults. When the user explicitly
requires full provider permissions and native MCP access for a review, use the
complete `multi-llm-review` full-access protocol. Build the exact target
checkout and launch `node dist/index.js --transport=stdio` from it; never send
that review to a globally installed or stale gateway process.

Use the provider-native mapping from that protocol on every new async job. Do
not add tool/MCP allowlists, deny lists, or user caps, and do not assume a
previous job or resume retained its full-access posture. Preserve the provider's
ambient native MCP configuration and ask the reviewer to use its available MCP
tools when useful. A missing required native MCP capability is a finding or
concrete blocker, not a reason to fabricate an allowlist.

Each job prompt must carry the verification report as a corrective-program
specification, the exact base and diff or exhaustive changed-file list,
product-relevant untracked files, and persistent evidence locations. Require
independent inspection of code, docs, tests, and commands. When the user asks
for 90-second progress checks, wait non-blockingly and do not call
`llm_job_status` earlier than 90 seconds after the prior check. Retrieve enough
raw output to preserve the terminal evidence; never set `maxChars` merely to
shorten a mandatory review result.

## Auto-Async Deferral

Sync tools auto-defer when execution exceeds sync deadline. No manual sync/async choice needed.

### Flow

1. Call a sync tool (`claude_request`, `codex_request`, `gemini_request`,
   `grok_request`, `mistral_request`, `devin_request`, or `cursor_request`)
2. Gateway starts CLI as background job, polls internally
3. Job completes within deadline (default **45s**) → result returned directly
4. Deadline exceeded → **deferred response** with `jobId` for polling

### Deferred Response

```json
{
  "status": "deferred",
  "jobId": "uuid",
  "cli": "claude",
  "correlationId": "...",
  "message": "Execution exceeded sync deadline (45000ms). Poll with llm_job_status, collect with llm_job_result.",
  "sessionId": "...",
  "pollWith": "llm_job_status",
  "collectWith": "llm_job_result",
  "cancelWith": "llm_job_cancel"
}
```

### Handling

1. Parse response as JSON
2. If `status==="deferred"` → extract `jobId`
3. Poll `llm_job_status({jobId})` until `job.status` is terminal (`completed`, `failed`, `canceled`, or `orphaned`)
4. Collect `llm_job_result({jobId})`

Non-deferred responses: process as normal. SQLite and PostgreSQL results are
retained for the configured period (30 days by default), so they can be fetched
after a restart. Memory-backed results disappear when the gateway exits.

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

| Tool                    | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `claude_request_async`  | Start async Claude job                                   |
| `codex_request_async`   | Start async Codex job                                    |
| `gemini_request_async`  | Start async Gemini job                                   |
| `grok_request_async`    | Start async Grok (xAI) job                               |
| `mistral_request_async` | Start async Mistral Vibe job                             |
| `devin_request_async`   | Start async Devin job                                    |
| `cursor_request_async`  | Start async Cursor Agent job                             |
| `llm_job_status`        | Poll job status (in-memory + durable store fallback)     |
| `llm_job_watch`         | Wait briefly for new privacy-safe normalized progress    |
| `llm_job_result`        | Retrieve job output (in-memory + durable store fallback) |
| `llm_job_cancel`        | Cancel running job                                       |
| `llm_process_health`    | Inspect in-memory job/process health                     |

## Single Job

### Start

```
claude_request_async({prompt:"Analyze src/ for type safety...",approvalStrategy:"mcp_managed",optimizePrompt:true})
```

Response:

```json
{
  "success": true,
  "job": { "id": "job-abc123", "cli": "claude", "status": "running", "startedAt": "..." },
  "sessionId": "...",
  "approval": null,
  "mcpServers": { "requested": [] }
}
```

- Gemini async responses also include `resumable:true|false`; only user-provided Gemini `sessionId` values are resumable
- Gateway-generated Gemini `gw-*` IDs are bookkeeping IDs and are rejected if passed back as `sessionId`

### Poll

```
llm_job_status({jobId:"job-abc123"})
```

Statuses: `queued` | `running` | `completed` | `failed` | `canceled` |
`orphaned`. The last four are terminal except `queued` and `running`.

Pass `afterProgressSeq` to receive only newer normalized progress and
`progressLimit` to request up to 64 events in forward sequence order. Preserve
`progress.nextAfterSeq` as the next cursor. `progress.highWaterSeq` and its
compatibility alias `lastSeq` report the highest emitted sequence;
`progress.hasMore` reports retained events after the page. Capability is
`structured`, `activity_only`, or `lifecycle_only`; messages never include raw
reasoning, provider-supplied tool names, tool arguments, paths, provider IDs, or
provider output text. Tool-start activity uses the fixed message
`Using a provider tool`. Claude stream-JSON, Codex JSONL, and Grok streaming-JSON
can report structured phases.
Codex validation/review calls without JSONL report `activity_only`; HTTP/API
jobs report `lifecycle_only`; other process modes report activity only.

Use `llm_job_watch({jobId,afterProgressSeq,waitMs})` to wait up to 30 seconds for
new events. MCP progress notifications are emitted only when that active request
carries a progress token. A watch call does not relax a user-required 90-second
orchestration check cadence.

### Retrieve

```
llm_job_result({jobId:"job-abc123",maxChars:200000})
```

- `maxChars`: 1,000 to 2,000,000 (default 200,000), applied independently to
  stdout and stderr. The default offsets return the head page of each captured
  stream, not the tail.
- `stdoutTruncated`/`stderrTruncated` indicate that more captured characters
  exist after that page. `stdoutTotalChars`/`stderrTotalChars` state the full
  captured lengths.
- Default display output is for ordinary inspection only. It can be parsed,
  reconstructed, or compressed, so it rejects non-zero stream offsets.

### Retrieve a complete stale result

For a durable result fetched after a wrapper timeout or gateway restart, use
`rawOutput:true` to retrieve a deterministic head-to-tail page sequence. Start
both stream offsets at zero, then keep each offset independent:

```
page = llm_job_result({
  jobId:"job-abc123",
  rawOutput:true,
  maxChars:200000,
  stdoutOffsetChars:0,
  stderrOffsetChars:0
})

// Append page.result.stdout and page.result.stderr to their matching streams.
// On the next call, use each non-null *NextOffsetChars value.
// If one stream is already complete while the other still has pages, pass that
// completed stream's *TotalChars as its offset. Do not omit it: omission resets
// the request offset to zero and returns its head page again.
next = llm_job_result({
  jobId:"job-abc123",
  rawOutput:true,
  maxChars:200000,
  stdoutOffsetChars: page.result.stdoutNextOffsetChars ?? page.result.stdoutTotalChars,
  stderrOffsetChars: page.result.stderrNextOffsetChars ?? page.result.stderrTotalChars
})
```

Stop when both `stdoutNextOffsetChars` and `stderrNextOffsetChars` are `null`.
On the local stdio surface, raw pages concatenate to the captured stdout and
stderr streams. Remote callers use the same offset protocol but receive
provider-session-ID-redacted, sanitized pages, not byte-for-byte provider
output.

### Cancel

```
llm_job_cancel({jobId:"job-abc123"})
```

Sends SIGTERM, then SIGKILL after 5s.

## Idle Timeout

Kills process if no stdout/stderr for configurable duration. Detects stuck processes.

| CLI          | Default   | Notes                                                                                    |
| ------------ | --------- | ---------------------------------------------------------------------------------------- |
| Claude       | 600,000ms | **stream-json mode only.** text/json produce no output until done (would false-positive) |
| Codex        | 600,000ms | Streams stderr progress: works all modes                                                 |
| Gemini       | 600,000ms | Streams stdout: works all modes                                                          |
| Grok         | 600,000ms | Streams stdout: works all modes                                                          |
| Mistral Vibe | 600,000ms | Streams stdout/stderr: works all modes                                                   |
| Devin        | none      | No gateway default; set an explicit no-output safeguard only when warranted              |
| Cursor Agent | 600,000ms | Can stream stdout in print mode                                                          |

Override: `idleTimeoutMs:int (30,000 to 3,600,000)`

When idle timeout fires: exit code **125** (non-transient, no retry).

## Parallel Jobs

Start all, then collect:

```
claude_request_async({prompt:"Review architecture in <repo>. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workingDir:"<repo>",approvalStrategy:"legacy",correlationId:"review-arch"})
codex_request_async({prompt:"Check <repo> for bugs. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workingDir:"<repo>",sandboxMode:"read-only",approvalStrategy:"legacy",correlationId:"review-impl"})
gemini_request_async({prompt:"Security audit the configured target checkout. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workspace:"<verified-gemini-workspace>",approvalStrategy:"legacy",correlationId:"review-sec"})
grok_request_async({prompt:"Independently review <repo>. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workingDir:"<repo>",approvalStrategy:"legacy",correlationId:"review-grok"})
mistral_request_async({prompt:"Independently review <repo>. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workingDir:"<repo>",approvalStrategy:"legacy",correlationId:"review-mistral"})
devin_request_async({prompt:"Independently review <repo>. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workingDir:"<repo>",approvalStrategy:"legacy",correlationId:"review-devin"})
cursor_request_async({prompt:"Independently review <repo>. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence.",workspace:"<repo>",approvalStrategy:"legacy",correlationId:"review-cursor"})
```

Poll each with `llm_job_status` every 60s by default, or every 90s when the user
explicitly requires that cadence. Retrieve with `llm_job_result` when terminal.

Before a review fan-out, verify the target checkout. `workingDir` selects the
local checkout for Claude, Codex, Grok, Mistral, and Devin. Gemini has no
`workingDir`; `includeDirs` is an extra read path, not a cwd selector, so use a
correctly configured registered `workspace`. Cursor's local `workspace` selects
its checkout. Never let a reviewer silently inspect an unrelated configured
default workspace. An unscoped local child runs in a fresh neutral temporary
directory, not the gateway process repository.

## Polling Strategy

- Poll `llm_job_status` **every 60 seconds by default**. When the user requires
  a 90-second cadence, do not check earlier than 90 seconds after the prior
  status call.
- No wallclock timeout: good reviews take minutes to tens of minutes
- Do **not** cancel jobs for "taking too long"; cancel only on explicit user instruction or hard failure (process dead, non-transient error such as exit 125/126)
- `idleTimeoutMs` remains a no-output safeguard where configured (10 minutes for the listed CLIs except Devin, which has no gateway default). It is separate from wallclock timeout and does not need tightening for normal reviews.
- When using `ScheduleWakeup` or sleep loops, use the requested cadence. The
  default is 60 s; a user-required 90 s cadence wins. The 5-minute prompt-cache
  window also favors intervals ≤ 270 s or ≥ 20 min.

### Wait-between-polls mechanism (orchestrator-specific)

Between `llm_job_status` calls, use a **non-blocking** wait. Standalone `sleep` commands are blocked in some orchestrators (e.g. the Claude Code harness rejects `Bash({command: "sleep 60"})` as a standalone call).

- **Claude Code harness:** use `Bash` with `run_in_background: true` for a one-shot wait:
  ```
  Bash({command: "sleep 60 && echo done", run_in_background: true})
  // Returns a task ID. Harness emits a completion notification when the 60s elapses.
  // On notification, call llm_job_status.
  ```
  The `Monitor` tool is for **streaming** progress (one event per stdout line), not for one-shot waits. Do not chain multiple short sleeps to work around the standalone-sleep block; the harness detects and blocks that too.
- **`ScheduleWakeup`** (if available in your orchestrator): schedule a wakeup with `delaySeconds: 60` and a prompt that resumes the polling loop. The runtime fires you back on schedule.
- **Codex CLI / other orchestrators**: use the orchestrator's native non-blocking wait primitive (e.g. async/await on a timer). Avoid synchronous blocking sleeps that freeze the agent loop.

Treat the wait as "yield control for ~60 s, then poll once," not "block the shell for 60 s."

## Error Handling

| Status      | Exit Code | Meaning             | Action                                     |
| ----------- | --------- | ------------------- | ------------------------------------------ |
| `completed` | 0         | Success             | Retrieve result                            |
| `failed`    | 124       | CLI timeout         | Check stderr                               |
| `failed`    | 125       | Idle timeout        | Increase `idleTimeoutMs` or check CLI      |
| `failed`    | 126       | Bounded I/O failure | Inspect `error`; reduce input/output scope |
| `failed`    | non-zero  | CLI error           | Check stderr                               |
| `failed`    | null      | Process error       | Check `job.error`                          |
| `canceled`  | any       | Canceled            | Result still retrievable                   |

Only `exitCode===0` → `completed`. All non-zero → `failed`. Results retrievable for ALL terminal states.

Exit codes 125/126 are non-transient; the retry engine skips them. An
argv-bound prompt that exceeds the platform-safe UTF-8 byte ceiling returns
`errorCategory:"input_too_large"` and is never truncated. Codex new and resume
prompts use stdin and do not consume the single-argv prompt allowance.
`codex_fork_session` remains argv-bound and applies the size rejection. Adjust
the scope or choose a verified stdin, ACP, or HTTP transport. All other
caller-controlled argv values are admitted in their final encoded form before
spawn, including serialized JSON and joined lists. The resolved command line
also has a conservative platform-specific aggregate byte budget and a
2,048-element cap. That byte budget excludes environment bytes but reserves
headroom for them. Windows preflight assumes the smaller npm `.cmd`/`.bat`
wrapper limit until resolution proves a native executable, and handler-added
native session flags are admitted before workspace, session, provider-artifact
handoff, or durable-job effects on non-Kit requests. Claude Kit projects its
eventual argv before compiled-context artifact materialization or durable
Kit-session allocation. Native `E2BIG` remains a redacted fallback. The
gateway never silently truncates input. An embedded NUL byte in command or argv
returns non-retryable `invalid_input` before spawn. Public results, long-lived
job memory, durable args, and async flight rows use a fixed invalid-argv marker,
while the optional duplicate durable payload is suppressed. None retains Node's
value-echoing native error or the rejected vector.
For stdin-backed jobs, a clean provider exit completes only after the entire
payload write callback succeeds. Closed or pending delivery becomes a fixed,
non-sensitive failure; timeout, cancellation, and provider nonzero exits keep
their normal precedence.

## Job Lifecycle

- **SQLite/PostgreSQL:** state transitions are durable. `llm_job_status` and
  `llm_job_result` read the store after an in-memory eviction or restart.
  Normalized progress is persisted with lifecycle state, refreshed across
  gateway instances, and fenced so stale owners cannot overwrite an orphaned
  terminal projection.
- **Memory:** async registration requires
  `[persistence].acknowledgeEphemeral = true`; results vanish on gateway exit.
- **None:** async request and job tools are not registered.
- Configure retention and dedup with `[persistence].retentionDays` and
  `[persistence].dedupWindowMs`. The old `LLM_GATEWAY_JOB_RETENTION_DAYS` and
  `LLM_GATEWAY_DEDUP_WINDOW_MS` overrides remain deprecated compatibility paths.
- Jobs still running when the gateway stopped can become `orphaned`; captured
  partial output remains readable when the store is durable.
- The default combined stdout/stderr cap is 50 MiB, controlled by
  `[limits].max_job_output_bytes`; overflow terminates the process with exit 126.
- The completed in-memory cache has its own configured TTL. It is not the
  durable-retention policy.

## Durability & Dedup

The gateway is a durable result collection layer. Two behaviors directly address the "agent polls, times out, re-issues, the whole CLI run starts over" failure mode:

### Auto-dedup

Identical `*_request` / `*_request_async` calls within the dedup window (default **1 hour**, `LLM_GATEWAY_DEDUP_WINDOW_MS` in ms) short-circuit onto the existing running or completed job. You get back the same `jobId` instead of spawning a duplicate run.

- Set `LLM_GATEWAY_DEDUP_WINDOW_MS=0` to disable dedup gateway-wide.
- Pass `forceRefresh: true` on a single call to bypass dedup for that request:

```
codex_request_async({prompt:"...",sandboxMode:"workspace-write",approvalStrategy:"legacy",forceRefresh:true})
```

Use `forceRefresh` when you genuinely need a fresh CLI run (e.g., file contents changed since the last dispatch, retry after manual fix). For normal "I crashed and restarted, let me re-issue" recovery, **omit `forceRefresh`**; dedup is exactly what you want.

### Durable retrieval

- Polling timeouts no longer destroy results. If your wrapper agent gives up at 5 minutes, `llm_job_status({jobId})` and `llm_job_result({jobId})` still return the completed result hours/days later.
- Gateway restarts no longer destroy results. Persisted rows survive process restarts.
- An `orphaned` job was `running` when the gateway last stopped; partial output is still readable. Treat it as a non-recoverable terminal state for the active CLI invocation (re-dispatch with `forceRefresh:true` if you need fresh work).

### Recovery pattern

```
// 1. Wrapper agent died after dispatching; you have no jobId in memory.
// 2. Re-issue the identical *_request_async call. The gateway dedups onto
//    the existing in-flight or completed job and returns its jobId.
result = codex_request_async({prompt:"<same prompt as before>",sandboxMode:"workspace-write",approvalStrategy:"legacy",correlationId:"<same correlationId>"})
// result.job.id is the original job
// 3. Poll/fetch as normal; works whether the job is running, completed, or completed days ago.
```

## Cache-Aware Prompts (`promptParts`)

Claude, Codex, Gemini, Grok, and Mistral async tools accept structured
`promptParts` instead of a flat `prompt`. Devin and Cursor accept only `prompt`.
The two fields are mutually exclusive where `promptParts` exists: supplying both
returns `provide exactly one of \`prompt\` or \`promptParts\``; supplying neither
returns `one of \`prompt\` or \`promptParts\` is required`. Keep a canonical flat
brief when fanning out to Devin or Cursor so every required reviewer receives
the same substantive evidence packet.

```
codex_request_async({
  promptParts: {
    system:  "<long stable system instruction>",
    tools:   "<long stable tool description>",
    context: "<long stable spec or file dump>",
    task:    "Implement X per the above."
  },
  sandboxMode: "workspace-write",
  approvalStrategy: "legacy",
  correlationId: "impl-r1"
})
```

The gateway concatenates in canonical order `system → tools → context → task`.
For providers that accept `promptParts`, that preserves stable-prefix hashing
across re-issues. It does not prove equal provider-side cache behavior or a hit.

For parallel async fan-out, only the five providers that accept `promptParts`
can share the structured stable prefix. Devin and Cursor receive the canonical
flat packet instead. `cache-state://prefix/{hash}` exposes gateway flight
recorder aggregates; it is observability, not proof that a provider hit its
cache or that providers shared equivalent cache behavior.

### Cache observability resources

Three MCP resources expose cache effectiveness from the flight recorder (tokens / hashes / aggregates only, no prompt or response text):

- `cache-state://global`: last-24h aggregate hit rate, total hits, estimated savings, per-CLI breakdown
- `cache-state://session/{sessionId}`: per-session aggregates including `ttlRemainingMs` for Claude
- `cache-state://prefix/{hash}`: per-stable-prefix-hash aggregates with CLI × model breakdown

`session_get({sessionId})` also projects a compact `cacheState` block when the session has prior requests (omitted entirely for fresh sessions).

### TTL warning on Claude async jobs (opt-in)

With `[cache_awareness] warn_on_ttl_expiry = true` in `~/.llm-cli-gateway/config.toml`, both `claude_request` and `claude_request_async` responses include a structured warning when the resumed session's prior `lastRequestAt` is within 30 s of Anthropic's cache TTL (default 5 min; 1 h when `[cache_awareness] anthropic_ttl_seconds = 3600`):

```json
{
  "warnings": [
    {
      "code": "cache_ttl_expiring_soon",
      "ttlRemainingMs": 12000,
      "message": "Anthropic cache breakpoint for session <id> expires in 12000ms (< 30000ms). Subsequent requests may miss the cache."
    }
  ]
}
```

For long-running async loops on a Claude session, treat the warning as a hint to dispatch the next turn promptly (or accept the upcoming cache miss). The warning is gated on the config flag and appears only for Claude sessions with prior cache writes.

## Tips

- Use `correlationId` on every job for log tracing
- Async jobs do NOT support `optimizeResponse`; optimize after retrieval
- Sessions work with async only when the provider-specific request surface and
  returned native handle permit it. Gateway session bookkeeping is not itself a
  provider-native resume handle.
- **When durable async jobs are enabled, sync tools can auto-defer at the 45 s deadline:** check for `status:"deferred"` in sync responses, then poll every 60 s by default or at a user-required 90-second cadence. With `persistence.backend = "none"`, async and job tools are absent and sync requests run to completion.
- `SYNC_DEADLINE_MS=0` disables auto-deferral
- For Gemini, check `resumable`: only `true` for a user-provided `sessionId`
- Set higher `idleTimeoutMs` for tasks with long silent periods
- Review jobs: every required healthy reviewer must return an evidence-backed
  `APPROVED_UNCONDITIONALLY`. Do not downgrade, skip, vote around, or impose a
  budget/round/turn/wallclock cap. A provider failure is incomplete review work,
  recorded as `BLOCKED_EXTERNAL`, not an approval.
- If jobs fail because a CLI is missing or stale, check `cli_versions` and run `cli_upgrade` as a dry run before any real upgrade. Grok self-updates via `grok update`; `cli_upgrade` routes that for you.
- **Don't burn re-runs after a polling timeout:** re-issue the same call; auto-dedup snaps you back onto the live job. Reserve `forceRefresh:true` for cases where the underlying inputs actually changed.
- **Durable results outlive in-memory caches** only on SQLite/PostgreSQL. Do not
  hold polling open merely to avoid losing a durable result; memory-backed
  results still disappear on a process exit.
- When Personal Agent Config Kit is enabled, only Claude/Codex Kit requests are
  admitted, and they require healthy SQLite/PostgreSQL durable admission.
  Cross-provider validation and least-cost routing are unavailable in Kit mode.
  The normal Claude `workingDir` targeting rule does not apply to a Claude Kit
  request: it rejects caller-supplied `workingDir` before context compilation.
  Inspect a candidate folder with `explain_effective_config`, then target Claude
  through an already configured registered `workspace` alias or the configured
  default workspace. It never inherits the gateway process cwd.
