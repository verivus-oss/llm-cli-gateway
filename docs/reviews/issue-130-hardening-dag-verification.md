# Issue #130 hardening DAG verification packet

Date: 2026-07-01

## Scope under review

This packet is the corrective-program spec and persistent review evidence for:

- `docs/plans/http-session-async-backpressure-hardening.dag.toml`

The exact diff under review is the current uncommitted worktree diff for:

```bash
git diff -- docs/plans/http-session-async-backpressure-hardening.dag.toml docs/reviews/issue-130-hardening-dag-verification.md
```

The changed-file list under review is:

```text
docs/plans/http-session-async-backpressure-hardening.dag.toml
docs/reviews/issue-130-hardening-dag-verification.md
```

Reviewers must inspect the files directly and verify claims against source code
and docs. Do not approve based on this packet's assertions alone.

## Corrective-program input

Issue #130: `https://github.com/verivusai-labs/llm-cli-gateway/issues/130`

Prior triage found:

- HTTP MCP sessions are retained in an unbounded `Map`.
- Async process jobs and HTTP API jobs start immediately with no global or
  per-provider limiter.
- Direct sync execution can bypass async backpressure when deferral is disabled
  or unavailable.
- Completed in-memory job retention and output buffering need configurable
  host-protection controls separate from durable store retention.
- Observability is missing session caps/age, queued jobs, limiter saturation,
  and parent process memory.

Cross-LLM review of the triage required these corrections before using it as an
implementation plan:

- Complete the truncated HTTP-session finding.
- Correct sync direct execution from `src/index.ts:896` to
  `src/index.ts:909-915`.
- Distinguish output cap definition (`src/async-job-manager.ts:74`) from
  enforcement (`src/async-job-manager.ts:1603-1645`).
- Clarify that `JOB_TTL_MS` is in-memory retention and durable store retention
  is separate.
- Add explicit DoS framing for HTTP sessions and unbounded provider execution.
- Include the cross-principal dedup risk as a required security review/fix.
- Define failure modes for session caps, limiter saturation, output overflow,
  queue timeout, and memory pressure.
- Require tests for HTTP session lifecycle, async/process/API limiters, sync
  direct execution, principal-safe dedup, retention/output caps, and
  observability.

## Local evidence checked before writing the DAG

Commands:

```bash
nl -ba src/http-transport.ts | sed -n '120,190p'
nl -ba src/async-job-manager.ts | sed -n '68,78p;672,704p;820,850p;1218,1234p;1598,1648p'
nl -ba src/index.ts | sed -n '888,920p'
rg -n "llm_process_health|healthz|runningJobs|process.memoryUsage|dedup|requestKey|ownerPrincipal" src/index.ts src/async-job-manager.ts src/http-transport.ts
```

Verified current references:

- `src/http-transport.ts:124` creates `sessions = new Map<string, SessionEntry>()`.
- `src/http-transport.ts:165` inserts initialized sessions into the map.
- `src/http-transport.ts:150-158` deletes sessions only through explicit
  `closeSession`; `src/http-transport.ts:168-172` deletes on transport close.
- `src/http-transport.ts:187-190` returns `/healthz` with only `ok` and
  `sessions`.
- `src/async-job-manager.ts:74` defines `MAX_OUTPUT_SIZE`.
- `src/async-job-manager.ts:75` defines `JOB_TTL_MS`.
- `src/async-job-manager.ts:680-714` handles dedup reuse by request key.
- `src/async-job-manager.ts:839` starts `runApiRequest` immediately.
- `src/async-job-manager.ts:1227` starts `spawnCliProcess` immediately.
- `src/async-job-manager.ts:1603-1645` enforces the output cap.
- `src/index.ts:909-915` directly calls `executeCli` when deferral is disabled
  or unavailable.

## Verification run on the DAG artifact

Commands:

```bash
node -e "const fs=require('fs'); const toml=require('smol-toml'); toml.parse(fs.readFileSync('docs/plans/http-session-async-backpressure-hardening.dag.toml','utf8')); console.log('DAG TOML parse ok')"
LC_ALL=C rg -n "[^\x00-\x7F]" docs/plans/http-session-async-backpressure-hardening.dag.toml || true
git diff --check -- docs/plans/http-session-async-backpressure-hardening.dag.toml
```

Results:

- TOML parse: passed.
- ASCII-only check: passed.
- `git diff --check`: passed.

## Required review standard

Reviewers must return unconditional `APPROVED` only if they inspected the DAG,
the verification packet, and the relevant source/docs enough to conclude that
the DAG is a sufficient implementation-and-test plan for issue #130.

If a reviewer returns `NOT APPROVED`, each finding must cite concrete evidence:
file paths, line numbers, missing DAG rows, missing test requirements, or
conflicts with existing implementation/docs.

If the implementer disagrees with a finding, the response must cite code or doc
evidence. Assertion-only rebuttals are not acceptable.

## Implementation record (2026-07-01)

The DAG was implemented on branch `fix/issue-130-backpressure-hardening` in
grouped slices (one commit per coherent step):

1. `feat(config)` : `[http]` + `[limits]` config surface (`src/config.ts`,
   `loadLimitsConfig`), conservative defaults, strict validation.
2. `feat(jobs)` : in-process `JobLimiter` + FIFO queue owned by
   `AsyncJobManager` (global + per-provider running limits, bounded queue,
   queue-wait timeout, cancel-while-queued, `JobSaturationError`), a new
   in-memory `queued` job status, and configurable
   `completed_job_memory_ttl_ms` / `max_job_output_bytes` replacing the
   hardcoded 1h TTL / 50MB cap. Permits release exactly once on every terminal
   transition via `fireOnComplete` (`releaseJobPermit`).
3. `feat(jobs)` : route process, HTTP API, direct-sync, and inline-API
   execution through the limiter (`acquireProcessSlot` for the sync bypass);
   saturation renders as a retryable `saturated` error in `createErrorResponse`.
4. `fix(jobs)` : principal-safe dedup (non-local principal folded into the
   request key + `principalCanAccess` backstop in `tryReuseDedupedJob`).
5. `feat(http)` : bounded HTTP session lifecycle (`max_sessions` 429, idle
   reaper independent of client DELETE, in-flight guard, exactly-once close,
   reaper cancelled on shutdown) + enriched `/healthz`.
6. `feat(observability)` : `backpressure` block in `llm_process_health`
   (limiter counts/saturation, HTTP session caps/ages, parent memory), redacted.
7. `docs` : README `[http]`/`[limits]` keys + failure modes, ENDPOINT_EXPOSURE
   and PRODUCT_CONTRACT host-protection sections.

### Verification results

- DAG TOML parse: pass.
- `npx vitest run` focused gate set (http-transport, async-job-manager,
  api-request-tools, mcp-surface-usability, workspace-registry, plus the new
  limiter / http-limiter / dedup-isolation / config / persistence-config /
  quality-pass suites): pass (198 in the combined focused run).
- `npm run build`: pass. `npm run lint`: 0 errors. `npm run format:check`: pass.
- `npm test` (full suite): 1861 pass, 1 fail. The single failure is
  `ttl-warning.test.ts > "SYNC path: claude_request with TTL ~= 5s emits
  warning"`. Root cause is environment-dependent, NOT a code regression: the
  test assumes the `claude` CLI is unavailable (fails fast) so the pre-spawn
  cache-TTL warning is attached to the inline response. On this dev host the
  real `claude` CLI is installed and authenticated, so the request makes a live
  model call; when that call exceeds `SYNC_DEADLINE_MS` (45s) the handler
  correctly returns a deferred job reference (no inline warning) and the
  assertion fails. Proof of non-regression: with a deterministic fast fake
  `claude` on PATH (`HOME` pointed at a temp home containing a stub `claude`
  that exits 0 immediately), the same test passes in ~1.6s on this branch, and
  all AsyncJobManager job-completion unit tests pass. The base commit passes the
  test only because the live `claude` call happened to return under 45s.
