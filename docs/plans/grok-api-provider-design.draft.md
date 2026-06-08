# Design draft: direct xAI Grok API provider for llm-cli-gateway

Status: DRAFT v3 — pre-implementation, under cross-LLM review (round 3). Not committed to any
release plan yet.
Date: 2026-06-05

## Revision log

v3 incorporates round-2 findings (Codex, Grok, Mistral; Gemini round 2 pending at time of writing):
- R7 (Codex STILL WRONG): model-registry citation corrected — the Grok CLI fallback model entry is
  src/model-registry.ts:70-77; lines 521-522 are env/global alias plumbing only.
- R8 (Codex STILL WRONG, Grok IMPRECISE): D3's "mirrors how CLI sync tools degrade" analogy was
  unsupported — CLI sync tools still defer at the default 45s deadline (index.ts:227) even when
  persistence is "none"; only the poll tools are unregistered. Replaced with an explicit new rule:
  when no job store exists, the API sync path executes inline and never returns deferred.
- R9 (Codex): TOML isolation qualified — schema-invalid `[providers]` is isolable, but both
  existing loaders whole-file-parse first (config.ts:151, :399), so syntactically invalid TOML
  degrades every loader. Policy stated in D3.
- R10 (Grok typo): `CliCliType` → `SpawnableCliType` (working name).
- R11 (Grok+Codex recommendation adopted): D6 open question resolved — introduce
  `ProviderType = CliType | "grok-api"`; `CliType` stays spawnable-only.
- R12 (Grok+Codex+Mistral): D2a expanded with the seven named integration gaps (cancelJob guard,
  runner branch placement, persisted row shape, http_status column, orphan semantics, poll
  exitCode contract, pure-async startHttpJob) and dedup-key namespace partitioning.
- R13 (Codex non-confirmation noted): reasoning-effort exclusivity provenance documented in
  Motivation — two independent confirmations (Grok seat round 1 with quote; direct fetch of
  docs.x.ai/docs/api-reference on 2026-06-05 containing verbatim "Only supported by `grok-4.3`");
  Codex's fetch did not surface the wording. Claim retained with this provenance.
- R14 (Codex round 3): the stale model-registry.ts:521-522 citation survived in D1 after the D6
  fix; D1 corrected to cite :70-77 (fallback block) + :521-522 (alias plumbing).

v2 history:

v2 incorporates round-1 findings from Codex, Gemini, and Grok seats:
- R1 (Codex+Grok REFUTED): v1 claimed the normal request path "ultimately reaches executeCli".
  Wrong. Corrected call-chain in D2; new D2a addresses the AsyncJobManager process coupling.
- R2 (Codex+Grok REFUTED): v1 claimed src/config.ts "models only the persistence backend".
  Overstated; it also models `[cache_awareness]` (src/config.ts:322-442) and a base `Config`
  (database/sessionTtl, src/config.ts:29-77). D3 corrected; loader now follows the
  independent-table pattern.
- R3 (Codex REFUTED): v1 claimed "zero HTTP-client code in production src/". Wrong:
  src/endpoint-exposure.ts:253-258 requires node:http/node:https and issues a HEAD request.
  D7 corrected — this is now *supporting* evidence: node:https client code already ships and
  passes the fetch audit.
- R4 (Grok+Codex wording): "Chat Completions deprecated platform-wide" softened — the comparison
  doc marks it Deprecated and recommends Responses; /v1/chat/completions remains documented as an
  active legacy endpoint.
- R5: type-ripple inventory (D6) expanded with the touchpoints the seats found beyond v1's list.
- R6: slice order revised — async-runner abstraction is now the explicit hard part, slice 2.

## Motivation

The gateway currently reaches Grok only by spawning the `grok` CLI as a child process. A direct
HTTP path to the xAI API (`POST https://api.x.ai/v1/responses`) would add:

- No dependency on the installed CLI. Operational observation (this session, 2026-06-05, not a
  repo artifact): the grok CLI emitted repeated startup failures
  `worker quit with fatal: unexpected server response: expect initialized, accepted, when process
  initialize response`; one occurrence killed a request outright (gateway error, exit code 1).
- Access to API-only parameters. Per https://docs.x.ai/docs/api-reference, `reasoning.effort`
  (`none|low|medium|high`) is "Only supported by `grok-4.3`". Provenance (round-2): two
  independent confirmations of the verbatim wording — the Grok review seat (round 1, with quote)
  and a direct page fetch on 2026-06-05 whose text reads "Constrains how hard a reasoning model
  thinks before responding. Only supported by `grok-4.3`." Codex's round-2 fetch did not surface
  the sentence; claim retained on the two positive confirmations, to be re-checked against the
  live page during slice-3 implementation (capability table). Operational observation (this
  session): the CLI default model rejected the gateway's `effort` passthrough with HTTP 400
  "Model grok-composer-2.5-fast does not support parameter reasoningEffort".
- Cost visibility: `usage.cost_in_usd_ticks` / `cost_in_nano_usd` in API responses.
- `grok-build-0.1` early-access model: 256k context, $1.00/$2.00 per 1M tokens, cached input $0.20,
  1800 RPM / 10M TPM. Aliases: grok-code-fast-1, grok-code-fast, grok-code-fast-1-0825.

xAI API facts sourced from (fetched 2026-06-05; verified by Codex/Gemini/Grok seats round 1):
- https://docs.x.ai/build/overview#getting-started
- https://docs.x.ai/docs/api-reference
- https://docs.x.ai/docs/models
- https://docs.x.ai/developers/models/grok-build-0.1

The comparison doc (https://docs.x.ai/developers/model-capabilities/text/comparison) marks the
Chat Completions API "Deprecated" and the Responses API "recommended"; /v1/chat/completions is
still documented as an active legacy endpoint. Responses are stored server-side for 30 days and
chainable via `previous_response_id`.

## Design

### D1. New tool `grok_api_request` (not a transport flag on `grok_request`)

Most of `grok_request`'s schema (permissionMode, sandbox, worktree, allowedTools, alwaysApprove,
approval strategy) is meaningless for a stateless HTTP call. A separate tool keeps both schemas
honest. Zod schema sketch:

- `model` (string, default from config; e.g. `grok-build-0.1`, `grok-4.3`) — validated against a
  tool-local model capability table (NOT model-registry.ts, whose grok entry is the CLI fallback
  block at src/model-registry.ts:70-77 plus env alias plumbing at :521-522)
- `input` (string) or `promptParts` — promptParts→Responses mapping must be specified: `system` →
  `instructions`, `task`(+`context`/`tools`) → `input`; cacheControl flags recorded for
  cache_state hashing but NOT sent (xAI has no client cache-control surface)
- `reasoningEffort` (`none|low|medium|high`) — sent as `reasoning: { effort }`; rejected
  client-side unless the capability table marks the model as supporting it (currently grok-4.3
  only), so we fail fast instead of relaying a 400
- `maxOutputTokens` (→ `max_output_tokens`), `temperature`
- `maxTurns` (→ `max_turns`) — documented as agentic-only; capability table gates it
- `sessionId`, `correlationId`, `forceRefresh` (same semantics as existing tools)

Session namespace rule: `grok_api_request` sessions live under the new provider type (working name
`grok-api`), fully disjoint from `grok` CLI sessions. Passing a `grok` CLI sessionId to
`grok_api_request` is an error; no cross-transport continuity in v1.

### D2. Call chain — corrected, and the real integration point

Actual current call chain (verified round 1):
- Sync handlers call `awaitJobOrDefer(cli, args, corrId, ...)` (src/index.ts:566; call sites
  gemini 3117, grok 3535, mistral 3921/3954, claude 4795, codex 5219).
- `awaitJobOrDefer` first runs `assertUpstreamCliArgs(cli, args)` (src/index.ts:620) — a CLI
  contract gate an HTTP provider cannot pass through.
- Normal path: `runtime.asyncJobManager.startJobWithDedup(...)` (src/index.ts:648) →
  `spawnCliProcess` (src/async-job-manager.ts:739). `executeCli` (src/executor.ts:460) is reached
  ONLY in the `SYNC_DEADLINE_MS === 0` fallback (src/index.ts:627-638).
- Async handlers call `startJob` directly (e.g. grok_request_async, src/index.ts:3766).

So "HTTP provider returns ExecuteResult and everything works unchanged" (v1) is FALSE.
AsyncJobManager is process-shaped: job records hold `process: ChildProcess | null`
(src/async-job-manager.ts:105), persist `pid` (805), cancel via process-group kills (997), and
hardcode `circuitBreakerState: "closed"` in flight-completion paths (281, 480).

### D2a. The actual proposal: a job-runner abstraction in AsyncJobManager

Introduce a second runner alongside the process runner:

- `HttpJobRunner`: drives the request via `src/api-executor.ts`; job record carries
  `process: null`, `pid: null`, and an `AbortController` handle; cancel = abort + mark cancelled;
  idle/timeout = abort on timer. Persistence shape gains nullable `transport: "process"|"http"`
  AND `http_status` columns (additive migration — current `JobRecord` has `exitCode` but no HTTP
  field, src/job-store.ts:13, and `recordComplete` accepts none, :108).
- `startJobWithDedup` branches on transport. Dedup key for HTTP jobs is a canonical payload
  serialization — `hash({transport:"http", provider, base_url, model, input/promptParts,
  reasoningEffort, previous_response_id, maxOutputTokens, temperature})` — the `transport`
  discriminator partitions the namespace so HTTP keys can never collide with argv-hash keys
  (current key is `JSON.stringify({cli,args,extra})` → SHA-256, src/job-store.ts:66).
- `awaitJobOrDefer` gains a transport-aware entry (or a thin `awaitApiJobOrDefer` sibling) that
  skips BOTH CLI gates — `assertUpstreamCliArgs` AND `assertUpstreamCliEnv` (src/index.ts:620-621)
  — and validates against the provider capability table instead.
- Retry + circuit breaker for HTTP jobs are implemented in the runner (NOT inherited from
  executeCli, which async jobs bypass today): breaker keyed `"xai-api"` via the existing
  `createCircuitBreaker`/`withRetry` from src/retry.ts, with a new HTTP transient classifier.

Named integration gaps slice 2 MUST cover (round-2 findings, each with the code that forces it):
1. `cancelJob` refuses running jobs with `!job.process` (src/async-job-manager.ts:985-991) — HTTP
   cancel needs an explicit branch: `AbortController.abort()` + the same terminal persistence path.
2. The runner branch must sit before the unconditional spawn at src/async-job-manager.ts:739 and
   must not attach process stream listeners for HTTP jobs.
3. Persisted row shape for HTTP jobs: `args_json` stores the canonical payload JSON (redacted of
   key material), not a placeholder — dedup replay and debugging depend on it.
4. `markOrphanedOnStartup`: in-flight HTTP jobs at gateway restart have no abort handle after
   rehydration → mark orphaned, same as process jobs with dead PIDs.
5. Poll contract: `awaitJobOrDefer` returns `{ code: result.exitCode ?? 1 }` (src/index.ts:690-693)
   — the HTTP runner maps success→exitCode 0 / failure→1 for that contract, while the real HTTP
   status lives in the new `http_status` field (never in exitCode; avoids retry.ts's special-cased
   codes like 124).
6. Pure async path: `grok_request_async` calls `startJob` directly (src/index.ts:3766), not
   `awaitJobOrDefer` — the async variant needs a parallel `startHttpJob` entry, not only the defer
   sibling.
7. Flight recorder: HTTP completions report breaker state from the runner's actual breaker instead
   of the hardcoded `"closed"` (src/async-job-manager.ts:281, 480) where feasible; `usage` mapping
   defines `costUsd = cost_in_usd_ticks / 1e10` (ticks are 1e10 per dollar per xAI docs).

Response handling: xAI Responses returns a typed `output[]` array, not text. Extraction rules:
concatenate `output[].content[].text` for `type: "message"` items → result text; capture `id`
(for previous_response_id chaining), `usage` (tokens + cost ticks) → flight recorder; error body →
stderr-equivalent field. HTTP status is recorded in a dedicated field — NOT mapped onto the
process exit-code field (avoids colliding with retry.ts's special-cased codes like 124).

Streaming: v1 is buffered only (`stream` not sent). Revisit after v1; the executor's 50MB output
cap concept carries over as a response-size guard.

### D3. Config: `[providers.xai]` in config.toml

Corrected claim: src/config.ts models the base `Config` (database/sessionTtl, :29-77),
`[persistence]` (:96-317), and `[cache_awareness]` (:322-442). There is no provider-secret or
base-URL schema (verified round 1).

Add a third independent table loader following the cache_awareness pattern (malformed
`[providers]` must never break persistence loading — same isolation the file already documents):

```toml
[providers.xai]
api_key_env = "XAI_API_KEY"   # name of env var; the key itself never goes in the file
base_url = "https://api.x.ai/v1"
default_model = "grok-build-0.1"
```

Zod-validated `ProvidersConfig`; `loadProvidersConfig()` independent of `loadPersistenceConfig()`.
Redaction rule: the resolved config object never carries the key material, only the env var name;
the key is read from the environment at request time and never logged.

Isolation qualification (round-2, Codex): "independent" holds at the schema level only — both
existing loaders whole-file-parse the TOML first (config.ts:151, :399), so a syntactically invalid
file already degrades every loader to defaults. Policy: schema-invalid `[providers.xai]` →
provider disabled with a startup warning, persistence/cache unaffected; syntax-invalid TOML →
existing whole-file fallback behaviour, unchanged by this design. Tests must cover both cases
separately.

Registration gating: `grok_api_request` (and its async variant) are registered only when
`[providers.xai]` is present AND the named env var is non-empty at startup. API sync does NOT
depend on `persistence.backend`, but the no-store behaviour is an explicit NEW rule (round-2
correction — CLI sync is not a precedent: it still defers at the default 45s deadline,
index.ts:227/715, even when the poll tools are unregistered): when `!hasStore()`, the API sync
path executes inline via the runner and NEVER returns a deferred response, because `llm_job_*`
would not be registered to collect it. Async variant requires persistence, same as existing
`*_request_async` (src/index.ts:4437-4438 gating). `llm_process_health` (src/index.ts:7596-7617)
gains an outbound-providers block reporting configured providers and whether each is in
sync-only or sync+async mode (round-2, Gemini+Grok).

### D4. Sessions via `previous_response_id`

`Session` (src/session-manager.ts:35-41) has `metadata?: Record<string, any>`. Store
`{ xaiPreviousResponseId, xaiResponseCreatedAt }` in metadata; update after each successful
response; on invalid/expired ID (xAI 404 — responses expire after 30 days) fall back to fresh
context, clear the stale ID, log a warning with correlationId.

Staleness guard: gateway `DEFAULT_SESSION_TTL_SECONDS` is also 30 days (src/config.ts:27) but file
sessions are not auto-pruned, so the 404 fallback is the load-bearing path, not the TTL.

Surfacing: `session_get` / `sessions://` resources must include the new provider's sessions —
covered by the D6 touchpoint inventory (resources.ts hardcodes per-CLI URIs).

### D5. Retry / circuit breaker

Verified: breakers key on command string (src/executor.ts:35-42); `isDefaultTransient`
(src/retry.ts:65-88) is exit-code/errno based (124, ENOENT, ECONNRESET/ETIMEDOUT/
ECONNREFUSED/EPIPE). `withRetry` computes backoff internally (src/retry.ts:218-223) with no hook
for server-specified delay.

Plan:
- New `isHttpTransient(status, errno)`: 429, 5xx, socket errnos (reusing the errno list — note
  ECONNREFUSED etc. are already classified, don't duplicate) → transient; 400/401/403/404 →
  non-transient.
- Extend `withRetry` options with `retryDelayOverrideMs` (or a `getDelay` hook) so the HTTP runner
  can honour `Retry-After`. Additive, CLI paths unaffected.
- Breaker key `"xai-api"` created through the existing factory.

### D6. Type ripple — full touchpoint inventory (expanded per round-1 findings)

Adding provider value `"grok-api"` touches at least:
- `CLI_TYPES` (src/session-manager.ts:21) — but see open question below
- flight-recorder union literal (src/flight-recorder.ts:29)
- `LlmCli` (src/async-job-manager.ts:16)
- doctor's provider list (src/doctor.ts:23)
- `SESSION_PROVIDER_VALUES` (src/index.ts:457)
- resources.ts hardcoded URIs (`sessions://grok` :140, `models://grok` :195) — user-visible
- `UPSTREAM_CLI_CONTRACTS: Record<CliType, CliContract>` (src/upstream-contracts.ts:113) — an HTTP
  provider cannot satisfy `CliContract` (executable/helpArgs/flags/maxPositionals, :60-80).
- metrics absorbs via CLI_TYPES iteration (src/metrics.ts:1,29,58)
- `sessions://grok` is ALSO registered in src/index.ts:1225 (round-2, Grok — resources.ts is not
  the only URI site)
- `llm_process_health` (src/index.ts:7596-7617) — currently reports persistence + process jobs
  only; needs the outbound-providers block (see D3)
- model listing: tool-local capability table, NOT model-registry.ts. Corrected citation (round-2,
  Codex): the Grok CLI fallback model entry is src/model-registry.ts:70-77; lines 521-522 are
  env/global alias plumbing. `list_models`/`models://` behaviour for the API provider defined in
  slice 3.

DECISION (round-2; recommended independently by Grok and Codex, feasibility HIGH per Gemini):
introduce `ProviderType = CliType | "grok-api"` as a distinct union. `CliType` stays
spawnable-only, so `UPSTREAM_CLI_CONTRACTS`, `assertUpstreamCliArgs`, `LlmCli`, and the spawn
paths keep their narrow type and exhaustiveness; `Session.cli`, flight-recorder, metrics, and
`SESSION_PROVIDER_VALUES` widen to `ProviderType`. The compiler then finds every site that must
choose. (v2's `Record<CliCliType, ...>` was a typo for this narrowing; superseded by the
ProviderType decision.) The slice-1 artifact is the exhaustive type diff.

### D7. HTTP client: `node:https`, NOT `fetch` (audit constraint)

Verified: scripts/release-security-audit.sh:221-263 hard-fails on `/\bfetch\b/i` in dist/*.js.
Corrected claim: production src/ already contains node:http/node:https *client* usage —
src/endpoint-exposure.ts:253-258 (`require("node:https")`, HEAD request) — and the audit passes
today. This confirms node:https request() is audit-safe precedent, not a novel pattern.

Audit-scope clarification (Mistral seat, round 1): the `\bfetch\b` grep is a *token* check aimed
at the Socket networkAccess alert signature, not a general outbound-HTTP ban — `https.request`
calls are invisible to it, and endpoint-exposure.ts shows outbound HTTP is already an accepted,
deliberate capability. The invariant this design preserves is "no fetch token in dist/", not "no
network".

Decision: implement the client over `node:https` `request()` in a single new module
(src/api-executor.ts), one module, builtin only, no new dependency. Zero `fetch` anywhere remains
the rule (only test files reference fetch today). Socket will still likely flag `networkAccess`
shifts on publish; release-checklist/Socket expectations to be updated when this ships, and
doctor/llm_process_health should surface "outbound API providers configured: xai" so the
capability is visible, not silent.

### D8. Genericity

Lean "generic-lite", now with a concrete commitment instead of naming-only: slice 2 defines a
minimal `ApiProvider` interface — `{ name, baseUrl, buildRequest(payload), parseResponse(body),
isTransient(status), authHeader(env) }` — implemented once for xAI. An ADR records what breaks on
provider #2 (dedup key namespace, config table, capability tables) so the cost is explicit rather
than discovered.

## Proposed slice order (revised)

1. Config: `ProvidersConfig` loader + registration gating + redaction tests + syntax-vs-schema
   isolation tests (R9) + `ProviderType` exhaustive type diff (D6 artifact)
2. Runner: `src/api-executor.ts` (node:https, ApiProvider interface, HTTP retry/breaker,
   Retry-After hook in withRetry) + AsyncJobManager `HttpJobRunner` branch covering the seven
   named gaps in D2a + job-store `transport`/`http_status` migration with tests — **the hard
   slice, done early**
3. Tool: `grok_api_request` Zod schema + capability table + resources/doctor/llm_process_health
   surfacing + session-namespace validation (reject non-`grok-api` sessionIds in the handler)
4. Sessions: `previous_response_id` chaining + 404 fallback tests
5. Async variant (`startHttpJob` path) + audit-script note + Socket expectation update + docs
6. Gates: mutation-probe test audit + cross-LLM review per standing protocol

Slice-dependency matrix (which slice proves which invariant — round-2 Codex artifact ask):
| Invariant | Proven by |
|---|---|
| Unconfigured ⇒ tool absent | 1 (registration tests) |
| Malformed provider config never breaks persistence | 1 (isolation tests) |
| HTTP jobs cancel/orphan/dedup correctly, no key collisions | 2 (runner + store tests) |
| exitCode contract + http_status separation | 2 |
| Capability gating (reasoningEffort per model) fails fast client-side | 3 |
| Session namespace disjointness | 3 (handler validation) + 4 (chaining tests) |
| Stale previous_response_id recovers | 4 |
| No-store ⇒ never deferred | 2 (runner) + 5 (registration) |
| fetch-token audit stays green | 5 (audit run) |

Each slice ends green (build+tests); slice 2 lands with the runner exercised via unit tests
(mocked node:https) before any tool is user-visible.

## Inventory for reviewers (final, post round 3)

VERIFIABLE (inspect the repo / the cited docs):
- All file:line claims above, including the corrected D2 call chain, D3 config surface, D7
  endpoint-exposure precedent, and the D6 touchpoint inventory.
- xAI API facts against the four URLs in Motivation (round 1: verified by Grok seat with quotes;
  Codex verified all but the reasoning-effort exclusivity; the api-reference page states
  "Only supported by `grok-4.3`" for reasoning effort).

OPERATIONAL OBSERVATIONS (this session, not repo artifacts — treat as anecdote):
- grok CLI `worker quit` startup failures; `grok-composer-2.5-fast` 400 on reasoningEffort.

UNASSESSABLE — no artifact yet:
- D1 schema sketch, D2a runner design, D3 TOML schema, D4 metadata shape, D5 classifier/hook,
  D6 exhaustive type diff (ProviderType DECIDED; the slice-1 diff artifact is what remains),
  D8 ApiProvider interface.
- Slice order and effort estimates.

## Review record (cross-LLM gate, 2026-06-05)

Three full rounds + closure, seats: Codex (gpt-5.5, read-only sandbox), Gemini, Grok, Mistral
(Vibe), all via the gateway with repo access; evidence-based protocol (file:line / doc-quote
verification, no plan-compliance approvals).

- Round 1 (v1): 3 claims REFUTED (executeCli call chain; config-surface scope; zero-HTTP-client),
  all confirmed against source and corrected in v2 (R1-R6).
- Round 2 (v2): corrections confirmed; 4 further inaccuracies/qualifications (R7-R13) + seven
  named D2a integration gaps; D2a/ProviderType judged FEASIBLE by Codex, Grok, Gemini.
- Round 3 (v3): Gemini "claims accurate"; Mistral "claims accurate" (round-2 risks CLOSED);
  Codex one residual citation (fixed, R14); Grok confirmed all deltas.
- Closure: Codex "claims accurate" (unconditional); Grok "claims accurate" (unconditional).

FINAL STATUS: all four seats unconditional on the VERIFIABLE claims. Per pre-artifact review
rules, the design itself (D1-D8 UNASSESSABLE items) is NOT approved — the deliverables are the
hardened risk inventory, the D2a gap list, and the slice-dependency matrix above. Next artifact:
slice 1 (config loader + ProviderType diff).
