# First-Class API-Provider Request Plumbing & Tool Surface — Design

Status: draft (2026-06-22)
Scope: elevate HTTP API providers (OpenRouter, OpenAI-compatible, Anthropic Messages,
xAI Responses) to full parity with the CLI request tools, and collapse the divergent
`grok_api_request` legacy path into one unified surface.

---

## 0. Why this exists

The motivating goal: run a **cross-LLM review + implementation cascade** on cheap
hosted models (OpenRouter et al.) — cheap panel for first-pass review/draft, escalate to
premier only on disagreement. The gateway already orchestrates multi-model review; what's
missing is a *first-class, audited, schema-complete request surface* for HTTP providers so
they can drive **implementation**, not just sit on the review panel.

## 1. Current state (verified)

What already exists and works:

- **Generic tool family** — `registerApiProviderTools()` (`src/index.ts:4440`) auto-registers
  `api_<name>_request` + `api_<name>_request_async` for every enabled `[providers.<name>]`.
  Schema `ApiProviderToolParams` (`src/index.ts:4313`): `prompt, system, model, correlationId,
  maxOutputTokens, temperature, topP, reasoningEffort, timeoutMs`.
- **HTTP execution path** — `runApiRequest()` (`src/api-provider.ts:361`, sync, retry +
  per-provider circuit breaker) and `AsyncJobManager.startHttpJob()` (`src/async-job-manager.ts:675`,
  async, dedup + SQLite persistence + AbortController cancellation + orphan-marking).
- **Three adapters** — `OpenAiCompatibleProvider`, `AnthropicProvider`, `XaiResponsesProvider`
  (`src/api-provider.ts:100/157/251`), `createApiProvider(name, kind)` factory.
- **Sync→defer** — `awaitApiJobOrDefer()` (`src/index.ts:979`) mirrors the CLI 45s
  `SYNC_DEADLINE_MS` defer-to-async behaviour.
- **Validation panel** — the *one* place API providers are already first-class peers:
  `dispatchProviderJob()` (`src/validation-orchestrator.ts:80`) routes reviewers to
  `startHttpJob` vs `startJob` by `findApiReviewer()` name lookup.
- **Bespoke xAI** — `grok_api_request` (`src/index.ts:3896`/`6816`) has flight recording +
  server-side session continuity, but runs on the **legacy** `createXaiResponse()`
  (`src/xai-api-provider.ts`), *separate* from the `XaiResponsesProvider` adapter.

## 2. The gap (parity deficit)

| # | Gap | Today | Target |
|---|-----|-------|--------|
| G1 | Flight recording on generic sync handler | absent (`handleApiProviderRequest`) | `safeFlightStart`/`safeFlightComplete` like CLI/grok_api |
| G2 | Token/cost capture for HTTP jobs | `ApiResult.usage` parsed, never persisted | usage threaded to flight-recorder + cost report |
| ~~G3~~ | ~~Async HTTP metrics~~ | **ALREADY DONE** — `finalizeHttpJob→emitMetrics→onJobComplete→recordRequest` (`async-job-manager.ts:823`, `index.ts:473`); sync handler also records in `finally`. Dropped per round-1 review. | — |
| G4 | Session/continuity | xai-only (`xaiPreviousResponseId`) | capability-typed continuity for all kinds (incl. session-tool enum widening, §7) |
| G5 | Structured error propagation | error body **is** parsed into `ApiHttpError.message` (`api-http.ts:153`); generic tools surface it only as `stderr`/`message`, not structuredContent/job record | thread structured/raw error into generic responses + job records |
| G6 | Schema parity | 9 fields | + promptParts, sessionId, optimize*, outputFormat, forceRefresh, idleTimeout |
| G7 | Duplicate xAI implementations | legacy + adapter | one adapter; `grok_api_request` reimplemented on unified path |
| G8 | Model registry | API models absent from `list_models`/`getCliInfo` | API `defaultModel`+`models[]` surfaced |
| G9 | `provider-tool-capabilities` | grok_api only | per-kind capability entries |
| G10 | `doctor` health | CLI-only providers block | API key + endpoint-reachability check |
| G11 | `provider-status` / `login-guidance` | CLI-only | API key-presence status + key-acquisition guidance |
| G12 | `resources` (`models://`, `sessions://`) | CLI-only | API model resources; sessions only if continuity tracked |
| G13 | Naming/type drift | `api_<name>_request` vs `grok_api_request`; `"grok-api"` vs `"grok_api"` | normalized canonical naming |

## 3. Principles

1. **Parity, not a parallel universe.** The HTTP surface should feel identical to a CLI
   request tool (same schema shape, same defer behaviour, same audit trail, same job tools).
2. **Reuse the proven plumbing.** No new job lifecycle — extend `startHttpJob`/`awaitApiJobOrDefer`.
3. **Preserve invariants.** No conversation content in session storage; API key never in
   `payloadJson`/dedup-key/logs; `https`-or-loopback; 50 MB cap; principal ownership on jobs;
   `node:https` only (Socket audit). `RESERVED_CLI_PROVIDER_NAMES` collision guard stays.
4. **Capability-typed, not provider-special-cased.** Differences (continuity, reasoning,
   system-prompt placement) are declared on the adapter, not branched per provider name.
5. **Ship in independently-reviewable slices**, each through the multi-LLM review gate.

## 4. Target architecture

```
<name>_request / <name>_request_async   (tool surface — §5)
        │  ApiProviderRequestParams (full-parity schema)
        ▼
handleApiProviderRequest(_Async)         (§6 — telemetry-complete handlers)
        │  buildApiProviderCall → createApiProvider + prepareApiRequest
        ▼
awaitApiJobOrDefer / startHttpJob        (existing lifecycle + §6 usage capture)
        │  flightRecorderEntry + usage  ──► flight-recorder + metrics + cost report
        ▼
runApiRequest → adapter.buildBody/parseResult → api-http.postJson (node:https)
        │
        └─ continuity (§7): server-side-id | stateless-resend | none
```

## 5. Unified request-tool schema (`ApiProviderRequestParams`)

Replace the thin `ApiProviderToolParams` with a parity schema. Canonical fields:

| Field | Type | Notes |
|---|---|---|
| `prompt` | string 1..100k | XOR `promptParts` (reuse `PromptPartsSchema`) |
| `promptParts` | PromptPartsSchema | parity with CLI tools |
| `system` | string ≤100k | mapped per-adapter (top-level for Anthropic/xAI, system msg for OpenAI) |
| `model` | string | defaults to provider `defaultModel`; checked against `models[]` allowlist |
| `sessionId` | string | active-session resolution; continuity per §7 |
| `createNewSession` / `continueSession` | bool | continuity-capable providers only |
| `maxOutputTokens` `temperature` `topP` `reasoningEffort` | sampling | already present |
| `outputFormat` | `text`\|`json` | `json` = return raw provider JSON in structuredContent |
| `optimizePrompt` / `optimizeResponse` | bool | reuse `src/optimizer.ts` |
| `forceRefresh` | bool | bypass dedup |
| `timeoutMs` / `idleTimeoutMs` | int 30s..1h | wall vs idle |
| `correlationId` | string | auto `randomUUID()` if omitted |

The `prompt` XOR `promptParts` constraint is enforced **dynamically at the prep boundary**
(matching the CLI tools, e.g. `index.ts:2260`), *not* as a static JSON-Schema `oneOf` — static
XOR degrades MCP client-side tool discovery.

Fields with no HTTP analogue are intentionally absent: `allowedTools`/`disallowedTools`,
`permissionMode`, `approvalStrategy`/`approvalPolicy`, `mcpServers`, `agents`, sandbox modes,
worktree flags. (This is *why* API reviewers are exempt from `review-integrity` — no
tool-suppression surface. Keep that exemption; revisit only if an agentic HTTP adapter ever
gains an `allowedTools` surface.)

## 6. Request plumbing — telemetry parity (Slice 1, core)

Make `handleApiProviderRequest` / `handleApiProviderRequestAsync` match `grok_api_request`.
**Round-1 review made clear this is wider than the two handlers** — `ApiResult` is discarded
at *four* sites before any FR/response write, so all four must change together:

1. **Stop discarding `ApiResult`.** Today `awaitApiJobOrDefer` (`index.ts:979`) — both the
   inline no-defer path (`~1006`) and the deferred path — and `buildApiSuccessResponse`
   (`index.ts:4344`) keep only `result.text`; usage/httpStatus/responseId/raw are dropped.
   Thread the full `ApiResult` through to the response builder and FR write. Parity with
   `buildGrokApiToolResponse` (`index.ts:4059`) requires the richer structuredContent.
2. **Flight start** — build `FlightLogStart { correlationId, cli: provider.name, model, prompt,
   system, sessionId, asyncJobId, ownerPrincipal }`; call `safeFlightStart` before dispatch in
   **both** generic handlers **and** in the validation dispatch (`validation-orchestrator.ts:90`,
   which today passes no `flightRecorderEntry`) — else reviewer/async API jobs stay FR-less.
3. **Usage capture.** `ApiResult.usage` carries `inputTokens/outputTokens/cacheReadTokens/costUsd`.
   The `extractUsage:(stdout)=>usage` contract is CLI/JSONL-oriented and wrong for HTTP. **Add a
   direct usage field on the HTTP job:** `finalizeHttpJob` (`async-job-manager.ts:800`) stamps
   `result.usage` onto the in-memory job; `writeFlightComplete` reads it directly (no stdout
   re-parse). This is additive and does **not** touch the process/CLI extractor path.
   **Persistence decision (required):** the `jobs` table (`job-store.ts:244`) and `AsyncJobRecord`
   have no usage columns — a reconstituted/orphan-swept HTTP job loses usage. *Recommend:*
   accept in-memory-only usage for v1 (FR row is written before GC in the common path) and
   document the reconstitution-loss edge; defer a `jobs` usage-column migration to a later slice.
4. **OpenRouter usage opt-in is capability-typed, not name-branched.** OpenRouter needs
   `usage:{include:true}` in the body, but the adapter kinds are only
   `openai-compatible|anthropic|xai-responses` (`api-provider.ts:27`). Do **not** add it globally
   in `OpenAiCompatibleProvider.buildBody` (breaks strict OpenAI-compatible servers) nor branch on
   provider name. Add an adapter/config capability flag (e.g. `usageInclude: true` on the provider
   config) that the adapter honours.
5. **Cost lookup typing.** `getPricing` (`pricing.ts:172`) is typed to the closed CLI enum
   (`"claude"|...|"mistral"`) — passing an API provider name fails to compile. Widen its signature
   (or add an API-provider pricing table) before feeding the cost report (#42).
6. **Structured error** — on `ApiHttpError`, propagate the already-parsed `message` **plus** raw
   `responseText`/`status`/`code` into the generic tool's structuredContent and job record
   (`createErrorResponse`, `index.ts:1464`, is CLI-centric and drops these today).
7. **Flight complete** — `safeFlightComplete` with `httpStatus`, usage, cost, `status`,
   `optimizationApplied`.

Result: an `openrouter_request` is as auditable/cost-tracked as a `claude_request`.

## 7. Session & continuity model

Continuity is **capability-typed on the adapter** (`ApiProvider.continuity`):

- **`server-side-id`** (xAI Responses): thread `previousResponseId` from
  `session.metadata`; on 404 clear stale id and retry fresh (today's grok_api behaviour,
  now generalized).
- **`stateless-resend`** (OpenAI-compatible: OpenRouter, vLLM, Ollama, OpenAI): `/chat/completions`
  has no server continuation. Sessions still exist for **active-session tracking, worktree/
  workspace binding, and principal ownership**, but carry *no* continuation handle and *no*
  conversation content (invariant preserved). Multi-turn = caller resends history (or, future
  opt-in, a bounded transcript cache held **outside** the default session store, explicitly
  flagged). For the review/implementation cascade, calls are one-shot, so this is sufficient.
- **`none`**: continuity params rejected with a clear error.

`prepareApiRequest` consults the capability to decide whether to inject `previousResponseId`.

**Two structural changes round-1 review surfaced (this is *not* just "alias grok_api"):**
- **Session-tool enum is static.** `session_create`/`session_list`/`session_set_active` validate
  the provider against `SESSION_PROVIDER_ENUM`, built from static `PROVIDER_TYPES` (CLIs +
  `grok-api` only, `session-manager.ts:67`, `index.ts:630/11243`). Generic API provider names
  cannot reach the session tools until this enum is built dynamically. **Build from
  `[...PROVIDER_TYPES, ...enabledApiProviders.map(p=>p.name)]` deduped** — *not* from `CLI_TYPES`
  alone, which would drop the existing `grok-api` known API type (`PROVIDER_TYPES` already
  includes it, `session-manager.ts:67`). Note the name-mapping caveat: `[providers.xai]` registers
  under config name `xai` (`config.ts:617`) while the grok_api session path keys on id `grok-api`
  (`index.ts:4109/4126`) — the dynamic enum must preserve `grok-api` until that alias/session
  mapping is explicitly migrated in Slice 4.
- **Extract grok's private session logic.** Session resolution + metadata update + active-pointer
  handling live inside grok_api-only functions (`index.ts:4101ff`). Capability-typed continuity
  requires lifting these into shared helpers consumed by the generic handler — not a thin wrapper.

## 8. Adapter unification (Slice 4)

- Collapse `src/xai-api-provider.ts` `createXaiResponse()` into `XaiResponsesProvider`
  (single buildBody/parseResult/cost-normalization + shared `runApiRequest`/`api-http`).
- Reimplement `grok_api_request` on the unified path — but this means **deleting/replacing the
  grok-specific prepare (`index.ts:3972`), session/metadata (`4101ff`), reasoning guard, and
  response builder (`4059`)**, with their behaviour folded into the shared handler as the
  `xai` provider configured with `continuity: server-side-id`. Not a thin wrapper; behaviour-
  preserving but a real extraction. Note: while `[providers.xai]` is enabled, both the rich
  `grok_api_request` and a thin `api_xai_request` are live simultaneously today — unification
  must reconcile that overlap.
- **Naming normalization (G13) — corrected per round-1 review.** The earlier claim that
  `RESERVED_CLI_PROVIDER_NAMES` makes collisions "impossible" is **wrong**: it reserves only CLI
  names (`config.ts:500/642`), so a provider literally named `grok_api` is currently accepted and
  would collide with a retained `grok_api_request` alias. Also, **no alias machinery exists** —
  `grok_api_request` is hand-registered outside `registerApiProviderTools` (`index.ts:6816`).
  *Recommended default: KEEP `api_<name>_request`* (zero churn, no caller breakage). Treat the
  `api_`-prefix drop as an **optional, separately-gated** step that, if taken, must: (a) extend
  the reserved-name set to cover existing API aliases, (b) add real alias machinery + a
  deprecation window for current `api_*_request` callers, (c) normalize the provider-type token
  spelling (`grok-api` vs capability id `grok_api` vs config key `xai`) via one mapping helper.

## 9. Completeness — every enumeration surface (Slice 5–6)

Per the surface audit, a first-class HTTP provider must appear in:

- **Model registry** (`src/model-registry.ts`): fold enabled API providers into provider info
  so `list_models` includes `defaultModel` + `models[]`. (`list_available_models` already
  injects `apiProviderCatalogEntry`, `src/validation-tools.ts:302` — done.)
- **Doctor** (`src/doctor.ts`): add an API-provider health block — key-env present?
  endpoint reachable (cheap `GET /models` or `HEAD`, opt-in)? — alongside the auto-included
  `provider_capabilities`.
- **provider-status / login-guidance**: API "status" = key set + endpoint reachable (no
  spawnable binary); guidance = where to get the key, which env var, base_url. CLI-only
  `VERSION_ARGS`/`PROVIDER_COMMANDS`/`LOGIN_CHECKS` stay untouched.
- **provider-tool-capabilities** (`src/provider-tool-capabilities.ts`): add per-kind
  `TOOL_CONTROLS`/capability entries (supports model + sampling + reasoning; no
  allowedTools/permission/MCP/worktree). Auto-flows into `provider-tools://` resources + doctor.
- **resources** (`src/resources.ts`): add `models://<provider>` for API providers; add
  `sessions://<provider>` only for continuity-tracked kinds. Keep the `CLI_TYPES` guard on
  provider-subcommand resources (API providers correctly excluded).
- **session-manager**: no change — `ProviderType = CliType | ApiProviderType` and
  `Record<ProviderType, …>` already accommodate API names.

## 10. Security & invariants (must-hold checklist)

- [ ] API key never in `payloadJson`, dedup key, logs, or flight-recorder. (Verified excluded
      today, `async-job-manager.ts:710`/`607`.)
- [ ] **Plaintext-prompt disclosure (round-1 finding).** HTTP `payloadJson` stores the full
      `messages` (user prompt) in plaintext in `jobs.db` (`async-job-manager.ts:710-719`), and
      jobs.db is **not** redaction-covered (`secret-redaction.ts`). This matches CLI `argsJson`
      behaviour — decide it's acceptable and **document it** (the key stays excluded; only prompt
      content persists, same as CLI jobs).
- [ ] `https`-or-loopback enforced (`buildEndpointUrl`); 50 MB response cap.
- [ ] Principal ownership set on HTTP jobs; `llm_job_*` enforce owner (F3).
- [ ] `node:https` only — no `fetch`/axios token in `dist` (Socket audit).
- [ ] `RESERVED_CLI_PROVIDER_NAMES` collision guard intact.
- [ ] `review-integrity` exemption documented (no tool-suppression surface on HTTP tools).
- [ ] Dedup excludes `apiKey`; forceRefresh bypass works.

## 11. Testing

- Adapter unit: `buildBody`/`parseResult` for OpenAI-compatible incl. OpenRouter
  `usage`/`cost` shape, error-body extraction, Anthropic system placement, xAI continuity id.
- Plumbing: flight-recorder rows for HTTP (start+complete, httpStatus, usage, cost); async
  metrics; dedup hit/miss; cancellation aborts in-flight request; model-allowlist enforcement.
- Continuity: server-side-id resume + 404-reset; stateless single-shot stores no transcript.
- Surfaces: doctor health block; `list_models` includes API models; resources enumerate.
- Run the **test-veracity mutation-probe audit** (standing protocol) before release.

## 12. Phased delivery

| Slice | Content | Closes | Risk |
|---|---|---|---|
| 1 | Telemetry parity: thread full `ApiResult` through `awaitApiJobOrDefer` (inline+deferred) + response builders + both generic handlers **and validation dispatch**; direct usage field on HTTP job; OpenRouter `usageInclude` capability; widen `getPricing`; structured error propagation | G1,G2,G5 | **med** |
| 2 | Schema parity: `ApiProviderRequestParams` (promptParts XOR at prep, sessionId, optimize*, outputFormat, forceRefresh, idleTimeout) | G6 | low |
| 3 | Capability-typed continuity (server-side-id / stateless / none) **+ dynamic session-tool enum** + extract grok session helpers | G4 | **med-high** (couples with Slice 4) |
| 4 | Adapter unification + grok_api logic extraction onto unified path; naming decision (default: keep `api_` prefix) | G7,G13 | **high** |
| 5 | Model registry + `list_models` surfacing (+ pricing table if not done in S1) | G8 | low |
| 6 | Peripheral surfaces: doctor / status / login-guidance / capabilities / resources | G9–G12 | low |
| 7 | Hardening: mutation-probe audit, docs, CHANGELOG, README provider section | — | low |

Slices 3 and 4 are coupled (both touch grok session extraction) — sequence 3→4 or merge them.
G3 is already implemented (see §2). Each slice independently shippable; each gets Codex +
Gemini + Grok review (inspected evidence, no plan-compliance approvals) before merge.

## 14. Round-1 review log (2026-06-22)

Codex + Gemini + Grok verified §1 and G1/G2/G4/G6/G7 against source; none approved. Applied:
G3 dropped (metrics already wired, `async-job-manager.ts:823`/`index.ts:473`); G5 rescoped
(error body already parsed, gap is structured propagation); §6 expanded to the four
`ApiResult`-discard sites + validation-dispatch FR + `getPricing` typing + persistence decision;
OpenRouter `usage:{include:true}` made a capability, not a global/name-branch; §7 expanded with
the static session-tool enum + grok-helper extraction; §8 naming-collision claim corrected
(reserved-names guard is CLI-only; no alias machinery; default to keeping `api_` prefix);
§10 adds the plaintext-prompt-in-jobs.db disclosure; §5 notes dynamic XOR enforcement.
Round 2 pending re-dispatch to the same reviewers.

## 13. Open decisions (recommendations inline)

1. **Tool naming** — *recommend* **keep `api_<name>_request`** (current behaviour, zero churn,
   no caller breakage; consistent with §8). Dropping the `api_` prefix → `<name>_request` is an
   **optional, separately-gated** future step requiring real alias machinery (none exists today —
   `grok_api_request` is hand-registered, `index.ts:6818`), an extended reserved-name set, and a
   deprecation window for existing `api_*_request` callers. This is the only externally-visible
   break, so it is explicitly *deferred*, not bundled.
2. **Stateless multi-turn** — *recommend* caller-resend only (preserves the no-conversation
   invariant); defer any gateway-side transcript cache to a later opt-in slice.
3. **Cost source** — *recommend* prefer provider-returned `usage.cost` (OpenRouter
   `usage:{include:true}`), fall back to a model-pricing table wired into the existing cost
   report (#42).
4. **Endpoint reachability in doctor** — *recommend* opt-in (off by default) to avoid a
   network call + token spend on every `doctor` run.

---

### Cascade payoff

Once Slices 1–4 land, `openrouter_request` is a first-class, audited implementation leg, and
the existing validation tools (`validate_with_models`, `consensus_check`, `red_team_review`)
already route reviewers to the same providers. The full cascade — cheap-panel review + cheap
implementation + premier escalation on disagreement — is then expressible end-to-end inside
the gateway with complete cost/audit telemetry.
