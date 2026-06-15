# API-Endpoint Routing — Implementation Plan

Status: DRAFT (for cross-LLM review). Companion to
`api-endpoint-routing-scoping.md`. Not in any release plan.
Date: 2026-06-15

Locked decisions (from scoping): (1) reviewer + code-generator roles only, never
applier — a CLI applies generated work; (2) OpenAI-compatible is the primary
adapter; (3) real `HttpJobRunner` integration into `AsyncJobManager`; (4) all CLI
providers stay, additive; (5) single-shot for stateless API providers (xAI keeps
`previous_response_id`).

Verified anchor points (read 2026-06-15):
- `src/xai-api-provider.ts` — `createXaiResponse(params, logger)`, `postJson`,
  `isHttpTransient`, `parseResponsesResult`, `XaiApiError`, `responsesUrl`
  (https-or-loopback guard).
- `src/config.ts:496-596` — `XaiProviderSchema` (strict), `XaiProviderConfig`,
  `ProvidersConfig { xai: … | null; sources }`, `loadProvidersConfig`,
  `isXaiProviderEnabled`, `DEFAULT_XAI_*`.
- `src/async-job-manager.ts:24` `LlmCli` union; `:111` `AsyncJobRecord`
  (`process: ChildProcess | null`); `:220` `StartJobOptions`; `:782` `startJob`;
  `:819` `startJobWithDedup` (spawn at `:882`, dedup key at `:837`); `:1124`
  `cancelJob` (refuses when `!job.process`).
- `src/validation-orchestrator.ts:203` `startJob` call; `:228` `buildProviderArgs`
  (CLI-argv only); `validation-tools.ts:16` frozen provider enum.

---

## Guiding principle

Keep the API surface **identical** to CLI providers wherever the existing code is
provider-agnostic (sessions, job snapshots, flight recorder, MCP resources), and
add a **transport branch** only at the points that are genuinely subprocess-
specific: job execution (`AsyncJobManager`), request preparation, and deferral.
Do **not** build a parallel inline path like the current `grok-api` sidesteps —
fold it into `HttpJobRunner` so async/cancel/dedup/flight-recorder work uniformly.

> Round 2 corrected the parenthetical above: `review-integrity` is NOT
> automatically inherited (see Slice 3), and "sessions/metrics/resources are
> provider-agnostic" is only true for the existing closed set — see the
> cross-cutting widening below.

---

## Slice 0.5 (cross-cutting) — provider-identity widening

**Codex's headline Round-2 finding.** `ProviderType` is a CLOSED enum
(`session-manager.ts:22-27`, defaults `:35-42` = five CLIs + `"grok-api"`) baked
into many subsystems. Arbitrary `[providers.<name>]` ids do not have a type-level
or schema-level home today. Before API providers can flow through jobs/sessions/
metrics, decide and execute ONE of:

- **(A) Fixed small set** — ship a known list of API provider ids (e.g.
  `"ollama"`, `"openai"`, `"anthropic"`, keep `"grok-api"`) added to the enum.
  Lowest risk; `[providers.<name>]` keys must map onto this set.
- **(B) Arbitrary names** — widen `ProviderType`/`PROVIDER_TYPES`/
  `SESSION_PROVIDER_ENUM` to admit any string with a `kind:"api"` tag.

> **LOCKED (2026-06-15): (B) arbitrary names.** Any `[providers.<name>]` key is a
> valid provider id. This puts the **Postgres migration in scope** (a new
> migration relaxing the `migrations/001`/`003` session-provider `CHECK`
> constraint — e.g. drop the enum CHECK for `kind:"api"` rows, or move provider
> validation to the application layer) and requires the closed-enum touchpoints
> below to accept open strings rather than a widened literal union. Treat the
> open-string typing + the Postgres constraint change as the first, highest-risk
> tasks of Slice 0.5.

Either way, the touchpoints Round 2 enumerated must change in lockstep:
`session-manager.ts:22-42`, `metrics.ts:1-40` (`Record<ProviderType,…>`),
`flight-recorder.ts:30-35` (start-row `cli: ProviderType`), `resources.ts:105-273,
417-461` (`models://`/`sessions://` parsers + catalogs — note `grok-api` itself is
incomplete here), `cache-stats.ts:148-156`, `provider-tool-capabilities.ts:24,427,
459+` (`ProviderCapabilityId`, `TOOL_CONTROLS`, `ACP_CONTRACT.providers`,
`providerCapabilityIds()`, `GrokApiModelInfo`), and — **a hard blocker for (B)** —
the **Postgres CHECK constraints** in `migrations/001_initial_schema.sql:5-18` and
`migrations/003_provider_type_sessions.sql:6-16`, which reject any session
`provider` outside the enum. Arbitrary names require a new migration relaxing/
extending that constraint.

> Decision: **(B) arbitrary names** chosen by the user (2026-06-15) — the
> Postgres `CHECK`-constraint migration is therefore part of Slice 0.5, not
> deferred.

---

## Slice 0 — `ApiProvider` interface, OpenAI-compatible adapter, generic config

New file `src/api-provider.ts`:

```ts
export type ApiProviderKind = "openai-compatible" | "anthropic" | "xai-responses";

export interface ApiChatMessage { role: "system" | "user" | "assistant"; content: string; }

export interface ApiRequest {
  baseUrl: string; apiKey: string; model: string;
  messages: ApiChatMessage[];          // single-shot: full prompt each call
  maxOutputTokens?: number; temperature?: number; topP?: number;
  reasoningEffort?: "none" | "low" | "medium" | "high";
  timeoutMs?: number;
}
export interface ApiResult {
  model: string; text: string;
  usage: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; costUsd?: number; raw?: unknown };
  raw: unknown; httpStatus: number;
}

export interface ApiProvider {
  readonly name: string;            // config key, e.g. "ollama", "openai", "xai"
  readonly kind: ApiProviderKind;
  endpointUrl(baseUrl: string): URL;            // path + https-or-loopback guard
  buildBody(req: ApiRequest): Record<string, unknown>;
  parseResult(httpStatus: number, body: string): ApiResult;
  isTransient(err: unknown): boolean;
  authHeaders(apiKey: string): Record<string, string>;
}
```

- Extract the generic `postJson` (the 50MB cap + timeout + loopback guard already
  in `xai-api-provider.ts:168` and `responsesUrl`) into a shared
  `src/api-http.ts` used by all adapters. Reuse `withRetry` + `createCircuitBreaker`
  (one breaker per provider name).
- `OpenAiCompatibleProvider`: `endpointUrl` → `${base}/chat/completions`; body
  `{ model, messages, max_tokens, temperature, top_p }`; parse
  `choices[0].message.content`, `usage.{prompt,completion}_tokens`. Degrade
  gracefully when `usage` missing (local servers often omit it).
- `AnthropicProvider`: `${base}/messages`; `x-api-key` + `anthropic-version`
  headers; split `system` out of `messages`; parse `content[].text`.
- Refactor xai onto `ApiProvider` as `XaiResponsesProvider`
  (`previous_response_id` handled at the session layer, not the adapter — adapter
  stays single-shot; see Slice 4). Keep `createXaiResponse` as a thin shim during
  migration to avoid churning its callers in one slice.

Config (`src/config.ts`): generalise `[providers.xai]` → `[providers.<name>]`:

```toml
[providers.ollama]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"   # loopback exception already supported
api_key_env = "OLLAMA_API_KEY"           # may resolve to empty for keyless local
default_model = "qwen2.5-coder:32b"
models = ["qwen2.5-coder:32b", "llama3.3:70b"]   # optional allowlist
```

- New `ApiProviderSchema` (strict) with `kind` discriminator; reuse
  `isHttpsOrLoopbackUrl`. `ProvidersConfig.providers: Record<string, ApiProviderConfig>`
  (keep `xai` getter for back-comat, or migrate xai into the map + a deprecation
  shim). **Keyless local exception:** allow `api_key_env` to resolve empty when
  `kind === "openai-compatible"` AND `base_url` is loopback (Ollama needs no key);
  otherwise empty key ⇒ provider disabled (current `isXaiProviderEnabled` rule).
- `loadProvidersConfig` stays failure-isolated: a malformed single provider
  disables only that provider (warn), never the whole map, never persistence.
- New `enabledApiProviders(config, env): ApiProviderRuntime[]`.

Tests: adapter body/parse round-trips per kind; loopback-vs-https guard;
keyless-local acceptance; malformed-provider isolation; usage-missing parse;
xai-refactor parity (same wire body as today).

---

## Slice 1 — `HttpJobRunner` (the hard slice)

Goal: an HTTP request becomes a first-class `AsyncJobRecord` so async, dedup,
cancel, orphan, and flight-recorder all work without a parallel path.

> Revised after TWO cross-LLM review rounds (Codex + Grok + Mistral). Round 1
> (excerpt-only, gateway sandbox blocked repo access) confirmed the strategy and
> flagged areas as `[verify-on-impl]`. Round 2 ran the reviewers with **full
> filesystem access + sqry MCP**, so they read the real bodies (close handler,
> `ProcessMonitor`, `markOrphanedOnStartup`, `hydrateFromStore`, flight-recorder,
> session-manager, validation path). Round 2 verdicts below are authoritative.
>
> **Round-2 headline corrections to the earlier draft:**
> - No hidden unconditional `job.process`/`.pid` crash path exists — the `?.` /
>   `&&` guards plus `ProcessMonitor.checkJobHealth` (`process-monitor.ts:162`,
>   handles `pid:null`) are already safe. §1c is about *explicit enumerated*
>   guards, not a latent crash.
> - `computeRequestKey` is **NOT** an independent runtime path — it is only
>   reached via `AsyncJobManager.buildRequestKey` (`job-store.ts:68` ←
>   `async-job-manager.ts:517-550`). Keep it aligned for tests/seeding; the real
>   dedup entry point is `buildRequestKey`.
> - The biggest missing piece is **provider-identity widening** across a closed
>   `ProviderType` enum baked into many subsystems incl. Postgres CHECK
>   constraints — see the new cross-cutting section before Slice 0/1.

### 1a. AsyncJobRecord identity + transport
- Add to `AsyncJobRecord`: `transport: "process" | "http"`,
  `httpStatus: number | null`, `abort: AbortController | null` (for http jobs
  `process` stays `null`; for process jobs `abort` stays `null`).
- **`AsyncJobRecord.cli` is typed `LlmCli` (`:24`) but http jobs carry an
  arbitrary `[providers.<name>]` key.** Widen the *record/manager-facing* `cli`
  field to `string` (a discriminated `JobProvider = LlmCli | string`), leaving the
  `LlmCli` type itself untouched so `providerCommandName`/`spawnCliProcess`/
  `buildProviderArgs` stay narrow. Every LlmCli-specific use of a job's `cli` must
  be guarded by `transport === "process"` first. **[verify-on-impl]** audit
  `snapshot.cli`, flight-recorder record consumers, and `normalizeJobResult` to
  tolerate non-CLI names / skip CLI-specific output parsing for http (stdout is
  already `ApiResult.text`).

### 1b. Branch the start path (not just the spawn line)
- Branch **before** `providerCommandName`/`spawnCliProcess` (`:880-882`), via a
  new `startHttpJob(...)` + `HttpJobRunner`. The http path must populate the
  common record fields that the spawn block sets today: `id`, `cli=providerName`,
  `requestKey`, `correlationId`, **`ownerPrincipal` via
  `resolveOwnerPrincipal(getRequestContext())`** (currently captured only inside
  the spawn block, `:906`), `startedAt`, `transport='http'`, `pid=null`,
  `abort=new AbortController()`, and must NOT register a process group
  (`unregisterProcessGroup`/`cleanupGroup` are pid-based) or arm idle/stall/output
  timers.
- `StartJobOptions` gains `transport?`, `apiRequest?: ApiRequest`,
  `provider?: ApiProvider`.

### 1c. Shared finalize, not a copied terminal path
- **Extract the finalize/complete logic** (field assignments + `onComplete` +
  flight-recorder + metrics + `exited=true`) into one helper called by BOTH the
  process `close` handler AND http settlement. On settlement set
  `stdout=result.text`, `httpStatus`, `exitCode = 0`/`1`, `finishedAt`.
- **Enumerated guard sites** (Round 2, verified line refs — `?.`-safe today but
  must be `transport === "process"`-gated so intent is explicit and future edits
  stay correct):
  - `error` handler `clearIdleTimer?.()` / `cleanupGroup?.()` (`~:1019-1022`)
  - `close` handler `clearIdleTimer?.()` / `cleanupGroup?.()` (`~:1038-1043`)
  - `appendOutput`: `resetIdleTimer?.()` (`~:1255`) and the else-branch
    `cleanupGroup?.()` (`~:1249-1250`) — move under the `if (job.process)` guard
  - idle timer arm site (`~:1005`) and overflow-kill path (`~:1225`)
  - `evictCompletedJobs` dead-process checks (`~:441-470`) already gate on
    `job.process && job.process.pid` — but must treat a post-restart http
    `running` row as immediately orphanable.
- `ProcessMonitor.checkJobHealth` (`process-monitor.ts:162`) already returns safe
  defaults for `pid:null` — no change, http jobs pass `pid:null`.

### 1d. Cancel + orphan
- `cancelJob` (`:1124`, refuses `!job.process`): add an http branch →
  `job.abort?.abort()` + mark canceled; do NOT refuse when an abort handle exists.
- `markOrphanedOnStartup` (`:297` / `job-store.ts:146`): http rows reconstituted
  from the store have no live `abort` handle and no pid → force-orphan; update
  `selectRunningOrphans` handling accordingly. **[verify-on-impl]** (body not
  visible to reviewers).
- `exitCode` is ONLY 0/1; the real HTTP status lives in the new `httpStatus`
  column — never overload `exitCode`.
- Flight recorder: http completions report the provider's real breaker state and
  `costUsd` from `ApiResult.usage`.

### 1e. Dedup — one runtime path, full canonical material
- **Corrected (Round 2):** `buildRequestKey` (`async-job-manager.ts:517-550`) is
  the single production entry point; it delegates to `computeRequestKey`
  (`job-store.ts:68`). `computeRequestKey` is not an independent path — keep it
  aligned so test/seed fixtures match, but the live work is in `buildRequestKey`.
- Namespace the http key with `transport` AND hash the **fully canonicalized API
  request**, not a partial field list: `hash({ transport:"http", provider,
  baseUrl, model, instructions/system, input/messages, temperature, topP,
  reasoningEffort, maxOutputTokens, previousResponseId })`. Round 2 flagged that
  the earlier list **omitted `topP`** (live in `xai-api-provider.ts:221-233`) and
  the `instructions` vs `input` split — derive the key from the same canonical
  object the adapter sends, so no field can drift out.
- `previousResponseId` MUST be in the material: two xAI turns with identical
  `messages` but different continuation must not dedup to one job. The `transport`
  discriminator keeps http keys disjoint from argv keys on any name collision.

### 1f. Job-store migration — more than `ALTER TABLE`
Precedent: `ensureJobsOwnerColumn` (`job-store.ts:100-106`) does idempotent
`PRAGMA table_info(jobs)` → `ALTER TABLE jobs ADD COLUMN`. Mirror it, but the full
change set is:
- Update `CREATE TABLE jobs(...)` (`:198-217`) for fresh DBs to include
  `transport TEXT NOT NULL DEFAULT 'process'` and `http_status INTEGER NULL`.
- Add the two idempotent `ADD COLUMN` migrations and **run them before any
  prepared statement is compiled** (`insertStmt`/`updateCompleteStmt`/… at
  `:177-184` bind to the column list at prepare time).
- Extend `JobRecord` (`:13-32`), update `rowToRecord` (`:73`) and every
  select/`getById`/`findByRequestKey` deserialization to surface `transport` +
  `httpStatus` so loaded http jobs are cancel/complete/orphan-correct.
- Change `recordStart`/`recordComplete` signatures (`:112-152`) — or add an
  http-specific recording path — to accept `transport`, `http_status`, `pid=null`,
  and a canonical request payload. The process path keeps the `DEFAULT` or passes
  explicit values if the INSERT column list widens.
- **`hydrateFromStore` (`async-job-manager.ts:730-761`) is a Round-2-discovered
  blocker:** it parses `row.argsJson` as a `string[]` and casts `row.cli as
  LlmCli`. If http rows persist canonical request JSON (not argv) under arbitrary
  provider names, hydrated rows silently lose payload (`args=[]`) and masquerade as
  CLI jobs. Define a **transport-aware persisted payload format** (e.g. a separate
  `payload_json` column, or a tagged union in `args_json`) and branch
  `hydrateFromStore` on `transport` instead of assuming argv.
- `OrphanedJobSnapshot` (`job-store.ts:159-166`) and `selectRunningOrphansStmt`
  (`:279-282`) must carry `transport` + `http_status` so a force-orphaned http row
  produces a faithful flight-recorder `logComplete`. http rows on restart are
  always force-orphaned (no live abort handle).
- **`FlightLogResult` (`flight-recorder.ts:62-78`) has no `httpStatus` field**
  (Round 2); `writeFlightComplete` (`async-job-manager.ts:603`) coerces `exitCode`
  to 0/1. Add `httpStatus?: number` to `FlightLogResult`, set it for
  `transport==="http"`, and have `logComplete` persist it — otherwise the real
  429/503 is unobservable.
- Widen the `onJobComplete` callback (`async-job-manager.ts:287`, called `:431`;
  registered `index.ts:445-449`) and `getJobCli` (`:1202`) / `AsyncJobSnapshot.cli`
  (`:173`, `snapshot()` `:1206-1220`) consistently with §1a; guard the codex-only
  branches `writeFlightComplete:597` (`job.cli==="codex"`) and the codex `fmt`
  extra in `buildRequestKey` with `transport==="process"`.
- Update `MemoryJobStore` (and the Postgres interface stub) to match the new
  `JobStore` surface. Legacy-schema seed tests + cross-engine WAL fixtures updated.

### 1g. Tests
http job lifecycle (start→complete), failure→exitCode 1 + httpStatus set, cancel
via AbortController, dedup hit across two identical http requests + miss when
model OR `previousResponseId` differs, orphan-on-restart for in-flight http,
migration round-trip on a legacy DB (backfills `transport='process'`),
flight-recorder cost/breaker assertions, and a guard test that an http job never
touches process-group/idle machinery.

---

## Slice 2 — generic request tools

- For each enabled API provider register `api_<name>_request` (+ `_async`) — or a
  single `api_request` tool taking `provider` (decide in review; per-provider
  tools match the existing `<cli>_request` ergonomics and let capability metadata
  be static). Gate registration on `enabledApiProviders(...)` (mirrors
  `isXaiProviderEnabled` gating of `grok_api_request`).
- Handler: `prepareApiRequest(params)` → assemble `messages` (system +
  prompt/promptParts), resolve model against the provider allowlist (tool-local,
  NOT `model-registry.ts`), then defer via a transport-aware helper. Sync
  auto-defers at 45s like CLI tools; async variant requires persistence.
- **`awaitJobOrDefer` is CLI-only (Round 2)** — `index.ts:712-820` types `cli` as
  the five-CLI union, asserts CLI args/env, calls `providerCommandName()` +
  `executeCli()` + `startJobWithDedup(cli,args,…)`. It cannot take
  `transport:"http"` as-is. Either generalize it to accept an `ApiRequest`/http
  branch, or add a sibling `awaitApiJobOrDefer(...)` that calls `startHttpJob`.
  The plan's earlier "`awaitJobOrDefer` with `transport:http`" shorthand is wrong.
- Provider-tool-capabilities: extend `ProviderKind="api"` entries (already modelled
  for `grok_api`) for each provider; ACP classification `absent` (HTTP has no ACP
  surface).
- **`ProviderCapabilityId = CliType | "grok_api"` is a hardcoded choke point**
  (Codex/Grok): a generic `[providers.<name>]` cannot be represented in that union.
  Widen it to admit arbitrary api provider ids (or a `\`api:${string}\`` template)
  and update every map keyed by `ProviderCapabilityId`, else new API providers have
  no type-level home in the capability/catalog/request-tool surfaces.

Tests: tool registration gated by config/env; sync→defer boundary; model
allowlist rejection; promptParts assembly.

---

## Slice 3 — reviewer wiring

- `validation-tools.ts:16`: replace frozen `z.enum([...5 CLIs])` with a schema
  derived from the live enabled set (CLI types + enabled API provider names).
  Keep a stable validation against unknown names.
- **`ValidationProvider` is a SECOND hardcoded enum (Round 2):**
  `validation-normalizer.ts:3` (`"claude"|"codex"|"gemini"|"grok"|"mistral"`) is
  used by `normalizeJobResult`/`normalizeStartedJob`/`collectValidationJobResult`.
  Widening only `validation-tools.ts:16` is insufficient — widen `ValidationProvider`
  too, plus the `provider` field on the `job_result`/`job_status` tool inputs.
- `validation-orchestrator.ts:203/228`: `buildProviderArgs` stays for CLI; add a
  transport check so API providers route through `startHttpJob` with an
  `ApiRequest` (the prompt as a single user message) instead of argv. Best shape:
  a `dispatchProviderJob(provider, prompt)` that branches CLI-vs-API once, used by
  `startProviderJob`.
- `getProviderRuntimeStatus` lives in `provider-status.ts:33,59` as
  `PROVIDERS: CliType[]` + `getProviderRuntimeStatus(provider: CliType)` (spawnSync
  version/login), and is also consumed by `health.ts:40` and `doctor.ts:562`. API
  providers report `installed = config-present && (key-present || keyless-local
  exception)` (no version probe); displayName from config. The **enabled reviewer
  set** = CLI-installed ∪ enabled API providers, computed once and reused by the
  validation schema, the Slice 5 catalog, health, and doctor — generalised beyond
  the xai-only `isXaiProviderEnabled` / `[providers.xai]` gate.
- Make `prepareApiRequest` the **shared assembly point** (messages + model
  allowlist) used by BOTH the direct `api_<name>_request` tools (Slice 2) and this
  orchestrator path, so reviewer and direct calls build identical requests.
- **`review-integrity` is NOT inherited — earlier "no change" claim was wrong
  (Round 2, Codex + Grok).** `checkReviewIntegrity` (`review-integrity.ts:18-84`)
  is transport-agnostic, but it is invoked only inside the per-CLI `*_request`
  handlers in `index.ts` — NOT in `validation-orchestrator.ts`/`validation-tools.ts`
  (the path that hosts reviewers), and NOT in the xAI API prep path
  (`index.ts:3529-3595`). So an API reviewer is NOT automatically subject to it;
  neither is the current CLI validation path. Decide explicitly: either (a) call
  `checkReviewIntegrity` from the shared `prepareApiRequest`/`dispatchProviderJob`
  review path (adapted — validation prompts carry no allowed/disallowed tools), or
  (b) document that validation reviewers (CLI and API alike) are out of scope for
  the direct-request integrity gate. Add a test asserting whichever is chosen.

Tests: `validate_with_models` / `second_opinion` / `red_team_review` /
`consensus_check` accept an enabled API provider and produce normalized results;
disabled API provider rejected; mixed CLI+API run.

---

## Slice 4 — code-generator role + apply handoff

- No new gateway primitive. Document the pattern in `BEST_PRACTICES.md`:
  `api_<name>_request` (generate patch/code) → `codex_request`/`claude_request`
  (apply in worktree) → tests. This is orchestration Pattern 3; the parent
  coordinates.
- Output-contract helper (optional): a documented prompt convention asking the API
  model to emit a unified diff or fenced code block, plus a small parser the
  orchestrator MAY use. Keep it advisory, not enforced.
- Confirm API providers are **absent** from `workspace-registry.ts` provider lists
  (they must never receive a worktree). Add a negative test.
- xAI single-shot exception: `previous_response_id` continuity stays available for
  the `xai-responses` adapter via session metadata (existing behaviour preserved),
  but stateless adapters store nothing.

---

## Slice 5 — discovery / catalog

- `list_models` / `list_available_models` and `resources.ts` (`models://*`) include
  enabled API providers (name, kind, default_model, allowlist) sourced from
  `ProvidersConfig`, clearly tagged `providerKind:"api"`.
- `llm_process_health` gains an outbound-providers block (breaker state per
  provider) per the draft's D3.

Tests: catalog includes/excludes per config; health block shape.

---

## Slice 6 — gates

- Mutation-probe test-veracity audit on every slice's new tests (standing
  protocol): spec on disk + 4–5 LLMs + ≥90s polling.
- `grep -riE 'fetch' dist/` empty (all adapters on `node:http`/`node:https`).
- Cross-LLM review gate (Codex read-only + Gemini + Grok + Mistral), inspected
  evidence against the actual code, iterate to unconditional approval or a
  concrete blocker. No same-repo write-access reviewer.

---

## Sequencing / risk notes

- Slice 1 is the schedule risk: it mutates the durable job schema and the
  cancel/orphan/dedup paths shared with subprocess jobs. Land it early, behind the
  fact that no API tool is registered until Slice 2 — so a half-built runner ships
  dormant.
- Slices 0–2 are the minimum for a usable **reviewer** (Slice 3 exposes it in the
  validation tools). Code-generator (Slice 4) is mostly docs once tools exist.
- Open sub-decision for review: one `api_request(provider=…)` tool vs per-provider
  `api_<name>_request`. Recommendation: per-provider, matching `<cli>_request`.

---

## Cross-LLM review outcome (2026-06-15)

Two rounds, Codex (gpt-5.4) + Grok (grok-build) + Mistral.
- **Round 1** — reviewers had no repo access (gateway sandbox blocked absolute
  paths); verified against pasted excerpts. Confirmed the strategy, left bodies as
  `[verify-on-impl]`.
- **Round 2** — reviewers run with **full filesystem access + sqry MCP** and read
  the real files. **This is the authoritative round** and resolved every
  `[verify-on-impl]` item.

**Verdict (both rounds): not unconditional approval; no unresolvable blocker.** The
strategy is sound; all findings are concrete under-specifications, now folded in.
Reviewers explicitly confirmed: single-shot sessions sound (`session-manager.ts`
has no multi-turn assumption); `ProcessMonitor` already null-pid-safe; no hidden
unconditional `job.process` crash path; workspace-registry stays CLI-only; the
`node:https` audit (`grep fetch dist/`) will still pass.

**Round-2 findings folded in:**
1. **Provider-identity is a closed `ProviderType` enum** across session-manager,
   metrics, flight-recorder, resources, cache-stats, capabilities, AND **Postgres
   CHECK constraints** (`migrations/001`,`003`). Biggest gap; needs scope decision
   (fixed set vs arbitrary names). (Codex) → new **Slice 0.5**
2. `hydrateFromStore` (`async:730-761`) parses `args_json` as argv + casts
   `cli as LlmCli` → needs transport-aware payload format. (Codex) → §1f
3. `awaitJobOrDefer` (`index.ts:712-820`) is CLI-only — can't take
   `transport:http`; needs a sibling/generalization. (Codex) → Slice 2
4. **`review-integrity` is inherited by NEITHER the validation path NOR the API
   path** — earlier "no change" was wrong. (Codex + Grok) → §3
5. Dedup: `computeRequestKey` is not a second runtime path (corrected); http key
   must hash full canonical material incl. **`topP`** + continuation. (Codex) → §1e
6. `FlightLogResult` lacks `httpStatus`; `writeFlightComplete` coerces exitCode.
   (Mistral) → §1f
7. `onJobComplete` callback + `AsyncJobSnapshot.cli` + `getJobCli` typed `LlmCli`.
   (Mistral + Grok) → §1f
8. `ValidationProvider` (`validation-normalizer.ts:3`) is a second hardcoded enum.
   (Mistral + Grok) → §3
9. `OrphanedJobSnapshot` + `selectRunningOrphansStmt` need transport/http_status.
   (Mistral + Grok) → §1f
10. Enumerated guard sites in close/error/appendOutput handlers (`:1019-1043`,
    `:1249-1255`). (Mistral) → §1c
11. `provider-status.ts`/`health.ts`/`doctor.ts` + `resources.ts` +
    `provider-tool-capabilities` choke points. (Grok) → §0.5/§3/Slice 5

**Decision (2026-06-15):** Slice 0.5 scoped to **arbitrary provider names** — the
Postgres `CHECK`-constraint migration + open-string provider typing are in scope
as the first tasks of Slice 0.5. Plan is review-hardened and parked here; next
session picks up at Slice 0.5/0.
