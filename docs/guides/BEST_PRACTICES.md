# Best Practices: LLM CLI Gateway

MCP server best practices (research-sourced, production-validated).

## Table of Contents

- [MCP Server Design](#mcp-server-design)
- [Multi-LLM Orchestration](#multi-llm-orchestration)
- [Repository Change Review](#repository-change-review)
- [Async Result Retrieval](#async-result-retrieval)
- [Provider Execution Scope](#provider-execution-scope)
- [Error Handling](#error-handling)
- [Retry & Circuit Breaker](#retry--circuit-breaker)
- [Session Management](#session-management)
- [Testing](#testing)
- [Code Organization](#code-organization)

---

## MCP Server Design

### Bounded Context

**Status:** ✅ Implemented

Single domain focus: CLI gateway orchestration

- Tools: `claude_request`, `codex_request`, `gemini_request`, session management
- Clear JSON schemas for inputs/outputs

**Guideline:** Maintain focused scope, reject unrelated features.

---

### Tools = Outcomes, Not Operations

**Status:** ⚠️ Partial

✅ Good: `session_create` combines creation + optional activation
⚠️ Consider: Higher-level tools for common patterns (e.g., `ask_claude_with_context`)

**Pattern:** Design tools for agent goals, not API mappings. Orchestrate internally.

**Action:** Add convenience tools for multi-step workflows.

---

### Flatten Arguments

**Status:** ✅ Good

Top-level primitives: `prompt:str`, `model:str`, `session_id:str`
Enums for constraints: `cli:enum(claude|codex|gemini|grok|mistral|devin|cursor)`

**Why:** Avoid nested dictionaries → prevents agent hallucination of keys.

---

### Instructions = Context

**Status:** ✅ Implemented

Tool descriptions: clear, specific
Error messages: actionable guidance

**Example:** "claude CLI not found. Ensure installed and in PATH"

**Pattern:** Docstrings and errors inform agent's next action.

---

### Tool Naming

**Status:** ✅ Compliant

snake_case: `claude_request`, `session_create`, `list_models`

**Why:** Consistent separators (\_) prevent LLM tokenization confusion.

---

### Logging

**Status:** ✅ Implemented

- stderr for logs (stdout = MCP protocol)
- Structured: timestamps, levels, CLI type, model, timing, session IDs
- The SQLite flight recorder provides durable request logging when enabled.

---

### Avoid "Not Found" Text

**Status:** ⚠️ Review needed

**Pattern:** Return relevant data on failure, not bare "not found".

---

## Multi-LLM Orchestration

### Pattern 1: Single-Level (Supported)

**Status:** ✅ Production-ready

Parent orchestrates children directly:

```typescript
codex_request({ prompt: "Implement X", sandboxMode: "workspace-write" });
gemini_request({ prompt: "Review X" });
```

**Use:**

- Codex: implementation, code generation
- Claude: code quality, architecture, orchestration
- Gemini: bug finding, edge cases

---

### Pattern 2: Multi-Level (Not Supported)

**Status:** ❌ Architectural limitation

Child cannot orchestrate grandchild:

```typescript
// ❌ FAILS: MCP error -32000
codex_request({
  prompt: "Implement X, then use claude_request for review",
  sandboxMode: "workspace-write",
});
```

**Why:** MCP server lifecycle is tied to the spawning context. Nested connections unsupported.

**Discovered:** 2026-01-24 (docs/archive/DOGFOODING_LESSONS.md #4)

---

### Pattern 3: Manual Multi-Level (Recommended)

**Status:** ✅ Production-proven

Parent coordinates all levels:

```typescript
// Step 1: Implementation
impl = codex_request({ prompt: "Implement X", sandboxMode: "workspace-write" });

// Step 2-3: Reviews (parallel)
review1 = claude_request({ prompt: "Review quality", model: "sonnet" });
review2 = gemini_request({ prompt: "Review bugs", model: "gemini-2.5-pro" });

// Step 4: Fixes
fixes = codex_request({ prompt: `Fix:${review1}${review2}`, sandboxMode: "workspace-write" });
```

**Benefits:**

- Full parent control
- Isolated steps
- Parallel reviews
- Clear audit trail

---

### Orchestration Workflow

**Proven pattern:**

```
1. Codex implements
2. Claude reviews (code quality)
3. Gemini reviews (bugs/edge cases)
4. Codex fixes
5. Tests verify
```

**Execution:**

- Parallel: independent reviews
- Sequential: implementation → reviews → fixes

**Error handling:**

- Handle failures per step
- Verify results, don't assume success
- Build/test after code changes

**Documentation:**

- Track which LLM per task
- Capture review findings
- Record metrics by LLM/task

---

### Review Gate Standard

**Status:** Production standard

Cross-LLM review is an evidence gate, not a summary check.

**Dispatch requirements:**

- Use the local stdio gateway MCP surface for gateway-orchestrated reviews.
- Launch reviewers with full non-interactive verification permissions and MCP
  tool access. Reviewers need to read files, inspect neighboring code, run or
  inspect tests/builds, and use code-search, docs lookup, and web/search tools
  where relevant.
- Poll async reviewer jobs no more than once every 90 seconds. Do not cancel
  reviewers for being slow; wait for terminal status unless the user explicitly
  asks to stop them.
- A partial-access or empty-output review is not approval. Treat it as a
  dispatch failure unless the user explicitly accepts the limitation.

**Evidence packet:**

- Provide the verification report used as the corrective-program spec.
- Provide the exact commit/diff range or uncommitted changed-file list.
- Provide the relevant plan/DAG step, issue/PR references, invariants, and local
  gate outputs.
- Tell reviewers that the report is a claim, not evidence. They must verify
  against actual code, tests, docs, and upstream documentation.

**Approval requirements:**

- Reviewers may approve only after inspecting code/tests/docs directly.
- Findings and rebuttals must cite `file:line`, command/test evidence, or doc
  URLs. Assertion, intent, or "should be fixed" language is not evidence.
- Iterate until every reviewer gives unconditional approval, or a concrete
  blocker remains after evidence-based rebuttal.

### Future Improvements

Potential autonomous multi-level:

1. Batch request tool (multi-sub-requests)
2. Session sharing (inherit parent MCP connection)
3. Async orchestration (fire-and-forget + callbacks)
4. Connection pooling (persistent nested connections)

**Current:** Use manual multi-level until nested supported.

---

## Repository Change Review

Use `review_changes` when the review target is a Git checkout and complete
change evidence must be identical for every reviewer. It is available only
when SQLite or PostgreSQL provides both durable async jobs and validation-run
storage, and it is absent while Personal Agent Config Kit is enabled.

Select an absolute local `workingDir` or a registered `workspace`, then choose
`scope: "auto" | "uncommitted" | "branch" | "commit"`. Optional `base` and
literal repository-relative `paths` narrow the scope. The gateway captures
committed, staged, unstaged, and regular non-ignored untracked content in separate fields,
forces tracked diffs to remain readable even when in-tree attributes mark them
as non-diffable, checks for repository changes during capture, and fails closed
instead of truncating. It refuses unsafe untracked file types. Each artifact and
the final collision-fenced prompt have an exact UTF-8 byte count and SHA-256 identity.
In `review-evidence.v2`, `committedPatch`, `stagedPatch`, and `unstagedPatch`
each include a sorted `paths` inventory plus `encoding`, `byteLength`, `sha256`,
and `content`. Never recombine the staged and unstaged segments before review:
an index change may be reversed only in the worktree.

Automatic scope first selects branch divergence from the merge base and
includes working-tree evidence. Without divergence, a dirty tree selects
uncommitted changes; a clean tree falls back to the last commit
(`HEAD^..HEAD`) without working-tree evidence.

`review_changes` starts read-only provider jobs. Use the returned validation
`job_status` and `job_result` references to collect them. Those tools are
separate from `llm_job_status` and `llm_job_result`. An optional judge is a
second step: after all reviewer results are terminal, call
`synthesize_validation` with the `validationId` and the same repository selector
used at kickoff. Keep collecting results for progress and human visibility, but
do not treat caller-supplied normalized results as judge evidence. For a
`review_changes` run, synthesis ignores caller `question` and `providerResults`,
reloads the exact owned durable linked terminal jobs, and reconstructs requested
but unavailable seats as skipped. General validation synthesis still requires
the caller's question and terminal normalized results.

CLI review jobs retain the exact fenced prompt in expiry-bound `payload_json`
and store only a hash marker in persisted argv. Repository review prompts are
not copied into the flight recorder. An HTTP/API reviewer requires explicit
`allowApiUpload:true`; remote HTTP/OAuth workspace review never permits that
upload. Treat the durable store as sensitive until job expiry.

An HTTP/API `judgeModel` uses the same explicit-consent boundary. At kickoff,
the gateway durably binds the consent, exact judge, resolved repository, and
caller identity to the returned `validationId`. Synthesis requires that id and
the same repository selector. The stored judge, repository, owner, and consent
are authoritative, and the planned judge is claimed atomically once. A later
`synthesize_validation` argument cannot replace those values, grant upload
permission, or start a second judge.

---

## Async Result Retrieval

Use `llm_job_status({jobId, afterProgressSeq, progressLimit})` for a bounded
normalized progress page. Pass the returned `nextAfterSeq` as the next
`afterProgressSeq`; request at most 64 events. `highWaterSeq` and its compatibility
alias `lastSeq` identify the highest observed sequence, while `hasMore` reports
whether another retained page is available. The snapshot reports a capability
of `structured`, `activity_only`, or `lifecycle_only`. Structured parsing is
available for Claude stream-JSON, Codex JSONL, and Grok streaming-JSON. Codex
validation/review calls without JSONL report `activity_only`, and HTTP/API jobs
report `lifecycle_only`. Other modes expose only activity/lifecycle signals.
Progress messages deliberately exclude raw reasoning, provider-supplied tool
names, tool arguments, paths, provider IDs, and output text. Tool-start activity
uses the fixed message `Using a provider tool`.

Use `llm_job_watch` to long-poll an owned job for up to 30 seconds. If the MCP
client supplied a progress token, notifications exist only during that active
watch call. Continue to use the user-requested orchestration cadence outside
the watch call; a progress stream is not permission to poll more frequently.

Use `llm_job_result` with its default display output for ordinary job
collection. For resumable retrieval of a large provider stream, set
`rawOutput:true`, select `maxChars` as the per-stream page size, and pass the
non-null `stdoutNextOffsetChars` and `stderrNextOffsetChars` values back as the
corresponding request offsets. The two streams page independently.

For a local stdio caller, those raw pages concatenate in stream order to the
captured stdout or stderr stream. A remote caller uses the same offsets, but
the gateway redacts provider-session-ID ranges before returning each page,
including a range that crosses a requested page boundary. Remote raw output is
therefore resumable sanitized output, not byte-for-byte captured provider
output.

Offsets require raw output because display output can be parsed, reconstructed,
or compressed after capture. Those transformations mean display pages cannot be
concatenated or resumed from captured-stream offsets. A non-zero offset without
`rawOutput:true` is rejected rather than returning an unreliable continuation.

---

## Provider Execution Scope

Always select the repository explicitly when concurrent workstations or
repositories are involved. A local CLI request with no resolved `workingDir`,
registered `workspace`, or gateway-managed `worktree` runs in a fresh private
`0o700` temporary cwd. The gateway removes it after the child exits, so the
provider does not inherit the gateway process repository or its instruction
files.

Claude, Codex, Grok, Mistral, and Devin accept local `workingDir`; all supported
CLI request paths can select a registered `workspace`, and their supported
paths can use gateway worktrees. A gateway worktree requires a registered
workspace selected explicitly, through caller-owned session metadata, or by the
configured default; it never falls back to process cwd or combines with
`workingDir`, `addDir`, or `includeDirs`. Gemini `includeDirs` adds read paths
but does not select cwd. Cursor's native `.code-workspace` argument is not used as a
process cwd. A provider-native `resumeLatest` that depends on `--continue`
requires a stable `workingDir`, `workspace`, or configured default workspace;
an unscoped call fails closed rather than continuing from a random neutral cwd.

Gateway-owned worktree materialization suppresses repository, system, and
global Git hooks and configured clean, smudge, and process checkout filters.
Filter-dependent content such as Git LFS remains in its repository
representation instead of executing host commands. If the provider needs
materialized filter output, prepare it through a separately trusted workflow
rather than relying on gateway worktree creation to execute host configuration.

Codex new and resume prompts use stdin. `codex_fork_session` remains argv-bound
and rejects oversized UTF-8 prompts as non-retryable `input_too_large`. Other
current argv-only provider contracts use the same exact UTF-8 byte admission.
The gateway also admits every caller-controlled argv value in its final form,
including serialized JSON and joined lists, before spawn. A final spawn-boundary
check covers every argv element and the aggregate resolved command line with a
platform-specific byte budget and a 2,048-element cap. The byte budget excludes
environment bytes but reserves headroom for them. Native `E2BIG` remains a
redacted fallback and is normalized to the same category. Windows preflight
assumes an npm `.cmd`/`.bat` shim until resolution proves a native executable,
and final native session flags are admitted before workspace, session,
provider-artifact handoff, or durable-job side effects on non-Kit requests.
Claude Kit projects its eventual argv before compiled-context artifact
materialization or durable Kit-session allocation. Do not split or truncate
instructions implicitly; narrow the request or choose a verified stdin, ACP,
or HTTP transport. An embedded NUL byte in the command or argv is rejected as
non-retryable `invalid_input` before spawn. Public results, long-lived job
memory, durable args, and async flight rows use a fixed invalid-argv marker; the
optional duplicate durable payload is suppressed. None retains the rejected
vector or Node's native value-echoing error. For
stdin-backed requests, accept a clean provider exit only after the complete
payload write callback succeeds. Closed or pending delivery becomes a fixed,
non-sensitive failure; timeout, cancellation, and provider nonzero exits retain
their normal precedence.

---

## Error Handling

### Pattern: Low-Level Throws, Top-Level Catches

**Status:** ✅ Implemented

- Low-level (`executeCli`): throws errors
- Top-level (tool handlers): catch, format via `createErrorResponse`

**Pattern:** Errors bubble to top-level for consistent formatting.

---

### Error Categorization

**Status:** ✅ Implemented

Transient (retry): 124 (timeout), ECONNRESET, ETIMEDOUT, ECONNREFUSED
Non-transient (fail-fast): ENOENT (CLI not found)

**Action:** Document retryable vs fail-fast per error.

---

### Context-Aware Messages

**Status:** ✅ Good

Exit code context: "Command timed out", "exit code 124"
Actionable: "Ensure claude CLI installed and in PATH"
CLI-specific details

**Pattern:** Human-readable + Actionable + Context-aware.

---

## Retry & Circuit Breaker

### Exponential Backoff

**Status:** ✅ Implemented

Formula: `delay = min(initial * factor^(attempt-1), max)`
Config: 1s initial, 2x factor, 30s max, 5 attempts

⚠️ **Missing:** Jitter to prevent synchronized retries

**Action:** Add jitter:

```typescript
jitter = Math.random() * 1000;
delay = Math.min(initial * factor ** (attempt - 1), max) + jitter;
```

---

### Circuit Breaker States

**Status:** ✅ Implemented

- CLOSED: normal
- OPEN: fail-fast after threshold
- HALF_OPEN: testing recovery

Config: 5 failures threshold, 60s reset timeout, per-CLI breakers

**Pattern:** Retry respects circuit breaker state, abandons if non-transient fault.

---

### Idempotency

**Status:** ⚠️ Consideration needed

Generally idempotent: read conversations, make requests
Session creation: unique IDs (safe retry)

**Action:** Document idempotency per tool.

---

### Monitoring

**Status:** ✅ Implemented

`cliBreakerState(cli)` exports the current CLI circuit-breaker state for
internal routing and health decisions.

**Enhancement:** Expose as MCP resource:

```typescript
// circuit-breakers://status
{claude:{state:"CLOSED",failures:0},codex:{state:"OPEN",failures:5}}
```

---

## Session Management

### Centralized Storage

**Status:** ✅ Implemented

The default file manager stores gateway session metadata in
`~/.llm-cli-gateway/sessions.json` with locked atomic writes and an in-memory
cache. Setting `DATABASE_URL` selects the PostgreSQL session manager instead.

⚠️ **Scope:** The session manager stores gateway metadata, not provider
transcripts or a generic provider-native resume handle. A gateway session ID
does not automatically resume a provider conversation.

**Pattern:** The file backend evicts ordinary expired sessions during session
operations. PostgreSQL session retention is explicit rather than controlled by
the file-backend TTL setting.

---

### Session State Design

**Status:** ✅ Efficient

Core record: `{ id, cli, description, createdAt, lastUsedAt, ownerPrincipal,
metadata }`; active pointers are stored separately. No conversation content is
stored in the session record.

**Pattern:** Persist only essential data.

The cache-awareness feature (slice 1–3) preserves this invariant by
adding ONLY hash + token-count metadata (`stable_prefix_hash`,
`stable_prefix_tokens`) to the existing flight recorder
(`~/.llm-cli-gateway/logs.db`, which already stores prompts/responses
for audit, separate from the session manager). Nothing is added to either
session backend. `session_get` projects a `cacheState` view at read time from
flight-recorder aggregates; it is not a field on
the Session interface in `src/session-manager.ts`.

---

### Cache hygiene

**Status:** ✅ Slice 1–3 shipped (default off; opt-in flags)

Claude, Codex, Gemini, Grok, and Mistral request tools accept a `promptParts`
structure: `{ system?, tools?, context?, task }`. Devin and Cursor accept only
flat `prompt`. The gateway concatenates supported structured parts in canonical
order so stable prefix bytes precede the volatile task tail unchanged across
calls. This raises implicit cache hit rate without calling provider-specific
cache APIs.

Per-model minimum cacheable token thresholds (Anthropic — see
`docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` for the full table and
dated source):

| Model family       | Minimum cacheable tokens |
| ------------------ | ------------------------ |
| Sonnet (3.5 → 4.6) | 1,024                    |
| Opus 4.5+ / Mythos | 4,096                    |
| Opus 4.x (legacy)  | 1,024                    |
| Haiku 4.5          | 4,096                    |
| Haiku 3.5 (Vertex) | 2,048                    |

Recommended client pattern:

```ts
// Put long stable context in `context`, volatile question in `task`.
mcp.callTool("claude_request", {
  promptParts: {
    system: "You are a careful reviewer.",
    tools: "<long allowed-tools description>",
    context: "<long file dump / spec / repo summary>",
    task: "What did the last patch change?",
  },
  approvalStrategy: "legacy",
});
```

Behaviour gated by `[cache_awareness]` in
`~/.llm-cli-gateway/config.toml` (all flags default OFF). Read the
slice-3 `cache_ttl_expiring_soon` warning off the response payload's
`warnings` array.

The same `structuredContent.warnings` array surfaces other non-fatal
signals worth inspecting: `claude_result_error` (Claude reported an
in-band error result) and `empty_output` (the CLI exited cleanly but
produced no content). Codex responses also echo `codexSessionId` in
`structuredContent` when a real Codex session UUID is available, which is
the value to pass back as `sessionId` (or via `resumeLatest`) to resume.
Per-CLI auth and timeout failures return actionable remediation in the
error message rather than a bare "not found".

---

### Security

**Status:** ✅ Baseline protections implemented

✅ Secure IDs: crypto.randomUUID()
✅ File-store and lock files: mode 0600
❌ No encryption at rest

**Actions:**

1. Protect the file-system or PostgreSQL storage backend according to its
   deployment environment.
2. Consider encryption at rest for sensitive deployments.
3. Use the `SESSION_TTL` environment variable to choose an appropriate
   file-backed ordinary-session lifetime.

---

### Lifecycle

**Status:** ✅ Implemented

✅ CRUD operations
✅ Update lastUsed
✅ File-backed ordinary-session TTL eviction during session operations, 30 days
by default
⚠️ PostgreSQL sessions retain until explicit removal, and active Personal Kit
state is lifecycle-pinned rather than TTL-evicted

**Configuration:** Set `SESSION_TTL` in seconds to adjust the file-backed
ordinary-session lifetime.

---

## Testing

### Organization

**Status:** ✅ Good

Unit: `executor.test.ts`, `session-manager.test.ts`
Integration: `integration.test.ts`
Co-located: `__tests__/` directory

**Pattern:** Separate unit/integration, `describe` blocks, AAA pattern.

---

### Unit vs Integration

**Status:** ✅ Well-separated

Unit: SessionManager and executor (mocked)
Integration: Full MCP and real CLI calls

**Pattern:** Unit = mock aggressively. Integration = spy, mock external only.

---

### Mocking

**Status:** ✅ Appropriate

Unit: `vi.mock("fs")` for complete replacement
Integration: Real MCP server, real CLI calls

**Pattern:** Complete mock for isolation, observe for integration.

---

### Coverage

**Status:** ✅ Comprehensive

- Executor: errors, timeouts, paths
- Sessions: CRUD, persistence, edge cases, concurrency
- Integration: all tools, cross-client, resources
- Metrics: aggregation, resource exposure

**Pattern:** All paths: happy, edge, error.

---

### Performance

**Status:** ⚠️ Integration cost varies by installed CLIs and enabled providers

Real CLI calls can dominate wall time. Use the repository test commands for
the current test inventory and timing rather than treating a historical count
as a release gate.

**Options:**

1. Faster models (haiku, flash)
2. Mock more in integration
3. Parallel execution (Vitest default)

---

### Isolation

**Status:** ✅ Good

Each test: own sessions, cleanup
No shared state
Session file cleanup after tests

**Pattern:** Consider `isolate:false` for speedup.

---

## Code Organization

### Single Responsibility

**Status:** ✅ Excellent

- `executor.ts`: CLI execution only
- `session-manager.ts`: persistence only
- `retry.ts`: retry/circuit breaker only
- `resources.ts`: MCP resources only
- `metrics.ts`: performance tracking only
- `index.ts`: MCP server orchestration only

**Pattern:** Bounded context per module.

---

### DRY

**Status:** ✅ Fixed

Previously: CLI_INFO in 2 places
Now: Single source (`model-registry.ts`, `getCliInfo`/`getAvailableCliInfo`), imported

**Lesson:** "Single constant in two places isn't good practice" - User

---

### Type Safety

**Status:** ✅ Strong

TypeScript strict mode
Zod runtime validation
Exported types

**Pattern:** Catch errors at build time.

---

### Separation of Concerns

**Status:** ✅ Good

Business: executor, session-manager, retry, metrics
Protocol: index (MCP server)
Data: resources (MCP resources)
Validation: Zod inline

**Enhancement:** Extract schemas to `schemas.ts`.

---

### Error Consistency

**Status:** ✅ Implemented

Centralized: `createErrorResponse()`
Consistent format across tools
Logging at error points

---

### Documentation

**Status:** ⚠️ Could improve

✅ Tool descriptions (MCP schema)
✅ Code comments (complex areas)
✅ README, BEST_PRACTICES, guides
❌ Missing JSDoc on exports
❌ Missing architecture docs

**Actions:**

1. JSDoc exported functions
2. Document architectural decisions
3. Add examples to README

---

## Priority Improvements

### High

1. **Jitter in retry delays** - Prevent synchronized storms
2. **Circuit breaker MCP resource** - Better observability
3. **Document idempotency** - Critical for retry safety

### Medium

4. **Extract Zod schemas** - Reusability
5. **Architecture docs** - Maintainability

### Low

6. **Session encryption** - Security (assess risk first)

---

## References

- 15 Best Practices for Building MCP Servers (The New Stack, 2025)
- MCP Server Best Practices 2026 (CData, 2025)
- Docker MCP Catalog Best Practices (2025)
- Model Context Protocol Spec (2025-03-26)
- Retry Pattern with Exponential Back-Off (DZone)
- Application Resiliency Patterns (Microsoft, 2023)
- Mastering Session State Persistence (SparkCo AI, 2025)
- Vitest Best Practices (CursorRules)
- Error Handling in CLI Tools (Medium, 2025)

---

## Configuring an API provider (`base_url` includes the version segment)

Each adapter appends only the **bare endpoint path** to `base_url` —
`chat/completions` (openai-compatible), `messages` (anthropic), `responses`
(xai-responses). So `base_url` **must include any version prefix** the vendor
requires; otherwise the request 404s. Verified live against each vendor:

```toml
[providers.anthropic]                          # Claude — kind "anthropic"
kind = "anthropic"
base_url = "https://api.anthropic.com/v1"       # -> /v1/messages  (NOT https://api.anthropic.com)
api_key_env = "ANTHROPIC_API_KEY"
default_model = "claude-haiku-4-5-20251001"

[providers.openai]                              # GPT/codex — kind "openai-compatible"
kind = "openai-compatible"
base_url = "https://api.openai.com/v1"          # -> /v1/chat/completions
api_key_env = "OPENAI_API_KEY"
default_model = "gpt-4o-mini"

[providers.xai]                                 # Grok — kind "xai-responses"
base_url = "https://api.x.ai/v1"                # -> /v1/responses
api_key_env = "XAI_API_KEY"
default_model = "grok-3"

[providers.mistralapi]                          # Mistral — kind "openai-compatible"
kind = "openai-compatible"
base_url = "https://api.mistral.ai/v1"          # -> /v1/chat/completions
api_key_env = "MISTRAL_API_KEY"
default_model = "mistral-small-latest"

[providers.ollama]                              # local, keyless (loopback exception)
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
default_model = "qwen2.5-coder:32b"
```

An API provider **cannot be named after a CLI** (`claude`, `codex`, `gemini`,
`grok`, `mistral`, `devin`, `cursor`): such a config block is rejected at load
to avoid shadowing the CLI on the reviewer path. Use a vendor name
(`anthropic`, `openai`, …).

## API providers as code generators (Slice 4)

API-endpoint providers (`[providers.<name>]`, with `kind` equal to
`"openai-compatible"`, `"anthropic"`, or `"xai-responses"`) are **reviewers and
code generators only, never appliers**. They emit text (a review, or generated
code / a unified diff); they never touch the filesystem, never get write access,
and never receive a git worktree (they are absent from `workspace-registry.ts`,
which is `CliType`-only by construction). The agentic tool-execution loop stays
out of scope for HTTP providers.

The generate→apply flow is **orchestration Pattern 3** (the parent coordinates
all levels), not a new gateway primitive:

1. `api_<name>_request` (or `_async`) — ask the API model to generate the code
   or a unified diff. A useful prompt convention is to ask for a single fenced
   code block or a `diff`-fenced unified diff so the output is easy to apply.
2. `codex_request` / `claude_request` — hand the generated patch to a **CLI**
   provider running in a worktree to apply it (the CLI owns filesystem writes).
3. Verify with tests.

Because API providers are stateless single-shot (the xAI Responses adapter keeps
`previous_response_id` via session metadata; OpenAI-compatible / Anthropic
adapters store nothing), resend the full context each call. Keep any
output-contract parsing on the orchestrator side, it is advisory, never enforced
by the gateway.

## Least-cost routing: `route_request` vs a specific provider tool

`route_request` / `route_request_async` (phase_1) pick the **cheapest eligible
`(provider, model)`** that still meets your quality tier, capability, and budget
constraints, then dispatch through the same path a direct call uses. They are
**dormant by default**: the tools are registered only when `[least_cost].enabled
= true` in `~/.llm-cli-gateway/config.toml` and Personal Agent Config Kit is
disabled, so nothing routes until an operator opts in.

**Reach for a specific provider tool (`claude_request`, `codex_request`, ...) when:**

- You need a _particular_ model or provider (a Claude review, a Codex
  implementation, a provider-specific flag like `--sandbox` or an mcp server).
- You are resuming a session or working in a worktree. `route_request` runs
  **fresh, one-shot** requests in phase_1; it does not thread a `sessionId` or
  `worktree`. It does accept a registered `workspace` for a selected CLI
  candidate without creating provider session continuity.
- Multi-LLM orchestration where each seat is a _named_ model (see Pattern 3).

**Reach for `route_request` when:**

- The task is model-agnostic and you want the cheapest capable model for it
  ("summarize this", "answer this question"), subject to a floor.
- You want a hard budget cap: pass `maxCostUsd`; an over-budget or all-unpriced
  pool **fails closed** with a structured `routing.error`
  (`BudgetExceeded` / `NoEligibleCandidate`) rather than silently picking
  something.
- You want a minimum quality tier: `minTier` (`economy | standard | frontier`,
  default `standard`). LCR never routes below it to save money.
- You want repository-dependent CLI work and can pass a registered `workspace`
  while restricting `candidates` to CLI providers authorized for it. A routed
  HTTP/API provider does not receive workspace files.

**Reading the result.** Every routed response carries a `routing` block (in
`structuredContent.routing`, plus a one-line `[routing] ...` banner in the text):
the `chosen` candidate, `estCostUsd` with its `costBasis`
(`provider-reported | derived-from-tokens | pre-flight-estimate`) and
`confidence`, `priceAsOf` / `priceSource`, `consideredCount`, the per-candidate
`rejected` reasons, and `reroutes`. `estCostUsd` is always an **estimate**
labelled with its inputs, never a billed cost.

**Knobs (config + per-request).** `candidates` restricts the pool to an explicit
`(provider, model)[]` (and whitelists otherwise-untiered / maintain-only
candidates); `allowUnpriced` + `budgetWaiver` are BOTH required to admit an
unpriced candidate, which still ranks strictly last; `fallback` is used only when
the eligible pool is empty. Unknown-priced candidates never win the argmin.
Transient failures (breaker trip / timeout) re-select over the remaining pool up
to `[least_cost].max_reroutes`; non-transient failures drop the candidate and
continue. See `docs/least-cost-routing-contract.md`.
