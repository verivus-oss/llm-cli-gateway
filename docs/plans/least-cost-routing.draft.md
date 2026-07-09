# Least-Cost Routing (LCR) specification (draft)

Status: Reviewed draft. Cross-LLM review gate passed (Codex, Grok, Gemini
unconditional approval over three rounds); not yet frozen, not implemented.
Predecessor
substrate is the existing per-provider request tools, `src/pricing.ts`,
`src/flight-recorder.ts`, `src/provider-status.ts`, and the backpressure work
(issue #130). Companion machine plan (once accepted):
`docs/plans/least-cost-routing.dag.toml`; frozen contract:
`docs/least-cost-routing-contract.md`.

## Terminology (read first)

- **LCR (Least-Cost Routing)**: given a request and a set of eligible
  candidates, dispatch to the candidate with the lowest *estimated* cost that
  still satisfies the caller's capability and quality constraints. LCR is
  cost-minimization *subject to constraints*, not "always the cheapest thing".
- **Candidate**: a `(provider, model)` pair, where `provider` is a member of
  `CLI_TYPES` or an enabled API provider name, and `model` is a concrete model
  id/alias that provider can serve. Cost varies far more across *models* (haiku
  vs opus, flash vs pro, devstral vs medium, and OpenRouter's hundreds of
  models) than across providers, so the routing unit is the candidate, never the
  bare provider.
- **Estimated cost**: a pre-flight USD figure computed from a price table and a
  token estimate. It is used for *ranking* candidates, not for billing.
- **Actual cost**: the provider-reported `costUsd` recorded post-hoc in the
  flight recorder. Reliable today only for claude, mistral (when the Vibe
  meta.json is found), OpenRouter (with usage accounting on), and xAI Responses.

This document uses "ACP" only where it references the existing Agent Client
Protocol work; LCR is unrelated to ACP.

## 1. Goals

1. Add an opt-in, provider-agnostic entry point that selects the cheapest
   eligible `(provider, model)` candidate for a request and dispatches it
   through the existing execution path.
2. Make the cost basis explicit, single-sourced, and auditable: one price table,
   one estimator, a recorded decision with estimated-vs-actual reconciliation.
3. Respect caller constraints (required capabilities, a minimum quality tier, a
   per-request budget cap) and gateway health (auth, circuit breakers,
   backpressure) so routing never silently downgrades quality or hammers an
   unhealthy provider.
4. Be dormant by default and fully backwards compatible: existing per-provider
   tools are unchanged; nothing routes automatically until configured on.

## 2. Non-goals

- **Not a load balancer.** LCR optimizes cost, not throughput or latency
  distribution. Latency and saturation are *eligibility* inputs, not the
  objective.
- **Not billing-accurate.** Pre-flight estimates are approximate (no real
  tokenizer exists in the tree; see 4.2). Estimates rank candidates; they are
  never presented as invoices.
- **Not automatic quality arbitration.** LCR will not route a request to a model
  below the caller's declared minimum tier to save money.
- **Does not override an explicit provider choice.** Calling `claude_request`
  directly always goes to claude. LCR is only reached through its own tool (or,
  in a later phase, an explicit `provider: "auto"` selector).
- **No new hand-maintained provider or model lists.** All enumeration derives
  from `CLI_TYPES` + `enabledApiProviders()` and `provider-definitions.ts`
  (enforced by `npm run provider:surfaces:check`).
- **Not a cross-instance scheduler.** Routing decisions are local to one gateway
  instance.

## 3. Background: what exists today (grounding)

- **No provider-agnostic dispatch chokepoint.** Each provider has its own
  hand-registered `<cli>_request` / `<cli>_request_async` tool in
  `src/index.ts`; the caller picks the provider by picking the tool.
  `src/request-helpers.ts` is a library of per-provider arg builders, not a
  router. The only existing fan-out over a provider *list* is
  `src/validation-orchestrator.ts`, and its targets are a caller-supplied
  `providers[]` array; it applies exactly one eligibility filter today
  (`resolveReviewerStatus`: skip when not installed, warn when not
  authenticated). That filter is the seed for LCR eligibility.
- **Pricing already exists but is not wired to routing.** `src/pricing.ts`
  exposes `getPricing(cli, model): { inputUsd, outputUsd, cacheReadMultiplier }`
  in USD per 1,000,000 tokens, as a static per-model-family table
  (`PRICING_AS_OF` timestamp). Its only consumer today is `src/cache-stats.ts`
  for cache-savings; `outputUsd` is defined but never used to compute a cost,
  there is no cache-*creation* price, and unknown models return the `ZERO`
  family (claude falls back to Sonnet). This is the DRY anchor to extend, not
  duplicate.
- **Provider-reported cost is patchy.** `costUsd` is extracted from provider
  output (`extractUsageAndCost`, `src/index.ts`), persisted to
  `gateway_metadata.cost_usd`. It is reliable only for claude; present sometimes
  for mistral (off-disk meta.json) and for OpenRouter/xAI API providers; and
  absent for gemini (text-only), grok CLI (no usage on the `-p` wire),
  devin/cursor (no usage branch), and usually codex (JSONL rarely emits
  `cost_usd`).
- **No pre-flight token or cost estimation.** The only token heuristics are
  `estimateTokens` (word count times 1.3, `src/optimizer.ts`) and the
  stable-prefix `bytes/4`. There is no tokenizer (no tiktoken/BPE) in the tree.
- **Telemetry to build priors on.** The flight recorder persists per-request
  `input_tokens/output_tokens/cache_read_tokens/cache_creation_tokens`
  (`requests`) and `cost_usd/duration_ms/model/cli/status`
  (`gateway_metadata`), queryable per correlationId via `llm_request_result`.
  `src/metrics.ts` tracks per-provider mean latency and success rate only (no
  per-model, no cost, no percentiles).
- **Eligibility facts (single sources).** `src/provider-definitions.ts` holds
  `requestSurface` (sync/async/transport), `capabilityScope`
  (`full`/`maintain-only`), `discovery.modelDiscovery.facts.effortLevels`,
  `outputFormats`, `safetyModes`, `sessionContinuity`, `acp`. It has **no**
  cost, image, or tool-call boolean. `src/provider-status.ts`
  (`getProviderRuntimeStatus`, `getApiProviderStatus`) gives
  `{installed, loginStatus}`.
- **Health accessors.** Per-CLI circuit breakers exist
  (`src/retry.ts`, `CLOSED/OPEN/HALF_OPEN`, threshold 5) but are stored in a
  module-private Map in `executor.ts` with **no exported accessor** (a gap LCR
  must close, see 9). API-provider breakers *do* have an accessor
  (`apiProviderBreakerState`, `src/api-provider.ts`). Backpressure is exposed via
  `AsyncJobManager.getLimiterSnapshot()`: global `running`/`queued`, per-provider
  `runningByProvider`/`queuedByProvider` maps, and a single **global**
  `saturated` boolean. There is no per-provider `saturated` field, so
  per-provider saturation must be derived from `runningByProvider` vs
  `maxRunningPerProvider`. `llm_process_health` already aggregates the API
  breakers and the limiter snapshot.
- **API providers are multi-model with opaque local pricing.** One
  `[providers.<name>]` config serves arbitrary model ids; cost is known only if
  the response reports it (OpenRouter usage accounting, xAI). For LCR these are
  the highest-value candidates *when* their prices are known.
- **Config/gating convention.** New optional subsystems follow the `[acp]`
  pattern: a dormant-by-default block with a global `enabled` flag, a per-entry
  sub-table, a dedicated Zod schema + loader that throws on schema-invalid TOML
  and falls back to all-off on a missing/syntactically-broken block, with
  env-var overrides emitting one-time deprecation warnings.

## 4. Design

### 4.1 Cost model (extend `src/pricing.ts`)

The candidate cost model is a single source derived from the existing table.
Extend `PricePerMillion` to a complete per-candidate cost with explicit
provenance:

```ts
interface ModelCost {
  inputUsdPerMTok: number;         // existing inputUsd
  outputUsdPerMTok: number;        // promote existing outputUsd to first-class
  cacheReadMultiplier: number;     // existing; cache-read discount factor
  cacheWriteUsdPerMTok: number;    // NEW: cache-creation rate (default = inputUsd; Anthropic ~1.25x)
  source: "table" | "api-catalog" | "unknown";
  asOf: string;                    // PRICING_AS_OF or per-catalog refresh time
}
```

Rules:
- `getModelCost(provider, model)` is a NEW router-only accessor built beside
  `getPricing`. For CLI providers it resolves per-token rates from the family
  table. For API providers (OpenRouter, xAI, ...) it resolves per-token rates
  from the provider's **published pricing catalog** (for example OpenRouter's
  `/models` prompt/completion prices), recorded with `source: "api-catalog"`
  and a refresh `asOf`. It NEVER derives per-token rates by decomposing a
  provider-reported total `costUsd`: a single scalar total cannot be split into
  input and output rates (see 4.6). When neither a table nor a catalog price is
  available, `source: "unknown"`.
- **`source: "unknown"` is a hard eligibility signal, not a silent zero.** A
  candidate whose price is unknown is *excluded* from cost ranking (it can never
  be the argmin) unless the caller sets `allow_unpriced`; even then it is ranked
  last and cannot satisfy a budget gate (see 5 and 7). This deliberately does
  NOT inherit `getPricing`'s current `ZERO`-for-unknown behavior, which would
  make every unpriced model look free and win every route.
- **`getPricing` is left unchanged.** Its `ZERO`-for-unknown semantics stay for
  the existing cache-savings path (`estimateCacheSavingsUsd` / `cache-stats.ts`);
  only the new `getModelCost` applies the exclude-unknown rule. No second price
  map is introduced; the family table stays the DRY source. A
  `pricing-freshness` doctor/health field surfaces each `asOf` so stale table or
  catalog prices are visible (today `PRICING_AS_OF` has no consumer).

### 4.2 Pre-flight cost estimation

LCR computes TWO estimates per request, for two different purposes.

**Ranking estimate** (orders candidates):

```
estCost = estInputTokens      * inputUsdPerMTok      / 1e6
        + estCacheWriteTokens * cacheWriteUsdPerMTok / 1e6
        + estOutputTokens     * outputUsdPerMTok     / 1e6
        - estCacheReadTokens  * inputUsdPerMTok * (1 - cacheReadMultiplier) / 1e6
```

- `estInputTokens` / `estCacheReadTokens` / `estCacheWriteTokens`: from the
  existing heuristics (`estimateTokens`, or `bytes/4` for structured prompts)
  plus the caller's cache-control markers. The cache-write term is included
  explicitly (Anthropic charges roughly 1.25x input for cache creation), so the
  formula no longer under-prices cache-creation requests.
- The same per-request input and output estimates are applied to *every*
  candidate, so for **ordering** the shared error largely cancels. It does NOT
  fully cancel near ties or across models with different tokenization,
  reasoning-token behavior, or cache economics; near-tie decisions are therefore
  inherently uncertain, are settled by the deterministic tie-break (4.5), and are
  never presented as precise.
- `estOutputTokens` for ranking: output length is driven by the *prompt*, not the
  model, so a single shared prior (caller `expectedOutputTokens` if given, else a
  config default, else a weak per-model fallback) is applied identically to all
  candidates. A prompt-agnostic per-model median is a last-resort fallback only,
  never the sole basis for the budget gate.

**Budget estimate** (enforces `maxCostUsd`, 4.5) must fail SAFE, so it uses a
CONSERVATIVE UPPER bound on output, not the median: the caller's explicit output
cap (e.g. `maxTokens` / `maxOutputTokens`) when set, else a high-percentile
(e.g. p90) per-candidate prior, else `default_expected_output_tokens` times a
configured safety factor. If no output bound can be established for a candidate,
the budget gate treats its cost as unbounded and the candidate fails the gate
rather than being silently admitted. This closes the median footgun (a short
median silently blowing the budget on a large-output request, or a large median
blocking a genuinely short one).

**Honesty requirement.** With no real tokenizer, both estimates are
approximations. The response reports the ranking estimate with its inputs (token
estimate, the output prior and its source, price `asOf`, price `source`), never
as a guaranteed or billed price.

### 4.3 Candidate pool and eligibility

The candidate pool is derived, never hand-listed:
`new Set([...CLI_TYPES, ...enabledApiProviders(providers).map(p => p.name)])`
crossed with each provider's model ids (from `model-registry` /
`provider-definitions` for CLI providers; from the caller-provided or
config-provided model set for API providers).

A candidate is **eligible** only if all hold:

1. **Installed and authenticated**: `getProviderRuntimeStatus(provider)` reports
   `installed && loginStatus === "authenticated"` (CLI), or
   `isApiProviderEnabled` + `apiProviderKeyPresent` (API). Reuses the
   validation-orchestrator eligibility idiom.
2. **Healthy**: the provider's circuit breaker is not `OPEN`
   (`apiProviderBreakerState` for API; a newly-exported per-CLI breaker accessor
   for CLI, see 9), and the provider is not at capacity. Per-provider capacity is
   derived from `getLimiterSnapshot().runningByProvider` vs
   `maxRunningPerProvider` (the global `saturated` flag is only a coarse
   secondary gate; there is no per-provider `saturated` field).
3. **Capability-eligible** for the request, derived from
   `provider-definitions.ts`:
   - required `outputFormat` is in the provider's `outputFormats`;
   - if the request needs images/attachments, the provider is known to accept
     them (today inferred, e.g. `findMissingImagePath`; LCR should promote this
     to an explicit `ProviderRequestSurface` capability flag rather than infer
     ad hoc, see 9);
   - if the request carries a `sessionId`/resume, the provider's
     `sessionContinuity` supports it;
   - if a specific `effort` is requested, it is within `facts.effortLevels`;
   - `capabilityScope !== "maintain-only"` unless explicitly allowed (cursor is
     maintain-only).
4. **Meets the minimum quality tier** (4.4).
5. **Priced**, or `allow_unpriced` set (4.1).

### 4.4 Quality tiering (the "subject-to" constraint)

`provider-definitions.ts` has no cross-model quality ranking, so LCR introduces a
minimal, config-driven **capability tier** per candidate rather than inventing a
benchmark. Tiers are coarse and explicit:

- `tier ∈ { economy, standard, frontier }` assigned per `(provider,
  modelFamily)` in the `[least_cost]` config, matched by exact-family pattern.
  **A tier default ships for every family the price table knows** (e.g.
  haiku/flash/devstral = economy; sonnet/gpt-5/gemini-pro/grok = standard;
  opus/gpt-5-high = frontier), so no priced CLI model is silently untiered.
- A candidate whose model matches no tier pattern is **untiered**: it cannot
  prove it meets `minTier`, so it is excluded from tier-gated routing unless the
  caller lists it explicitly in `candidates`. Untiered models (common for
  arbitrary API-provider aliases) are surfaced in a doctor/health view so the
  gap is visible and tunable, never silently defaulted to a tier.
- The caller passes `minTier` (default `standard`). LCR only considers
  candidates at or above `minTier`, then picks the cheapest among them.
- Rationale: this keeps LCR honest (no silent downgrade) without pretending the
  gateway can rank model *quality* numerically. Tiers live in config so they are
  auditable and tunable, and default to conservative assignments.

### 4.5 Selection policy

Among eligible candidates at or above `minTier`:

1. Compute `estCost` (4.2) for each.
2. Choose `argmin(estCost)`.
3. **Tie-break deterministically** (never `Math.random`): lower `estCost`, then
   higher historical success rate (`metrics.ts`), then lower historical mean
   latency, then a stable config-defined `preferenceOrder`, then lexical
   provider/model. Determinism is a security invariant (7).
4. Enforce the **budget cap** using the *conservative budget estimate* (4.2),
   not the ranking estimate: if the chosen candidate's budget estimate exceeds
   the caller/config `maxCostUsd`, fail closed with a structured
   `BudgetExceededError` listing the cheapest candidate and its estimate rather
   than silently sending an over-budget request. An unpriced candidate
   (`source: "unknown"`) has no cost upper bound and can therefore NEVER pass the
   budget gate; it is admissible only when the caller both sets `allow_unpriced`
   and explicitly waives the budget for it.

### 4.6 Dispatch, and the closed feedback loop

- **Dispatch** reuses the existing path: the chosen `(provider, model)` is
  handed to the same handler logic the per-provider tools use
  (`AsyncJobManager.startJob` for CLI, `startHttpJob` /
  `api-provider.runApiRequest` for API). LCR does not fork the execution path;
  it selects inputs to it. This keeps retries, circuit breakers, principal
  isolation, and flight recording identical to a direct call.
- **Feedback loop**: after completion, the flight recorder already holds actual
  `output_tokens` and (when available) `cost_usd`. A read-only aggregator (same
  pattern as `cache-stats.ts`) maintains **model-level economics only**, per
  `(provider, model)`: a rolling median and p90 of `output_tokens` that feed the
  ranking and budget output priors (4.2). It does NOT learn per-token prices from
  `cost_usd` (a single total cannot be decomposed into input and output rates);
  API prices come from the published catalog (4.1), and the recorded `cost_usd`
  is used only for estimate-vs-actual RECONCILIATION and accuracy tracking (8),
  never to derive rates.
- These priors are properties of the *model*, not of any principal (see 7):
  they carry no caller-identifying content. The aggregator reads the flight
  recorder's `owner_principal`-stamped rows but emits only anonymized model-level
  aggregates. For strict deployments a config flag
  (`priors_scope = "global" | "principal" | "off"`) scopes learning to the
  caller's own `owner_principal` rows or disables it. The loop is advisory only:
  it refines priors; it never changes an in-flight request.

### 4.7 Fallback and escalation

- On a **transient failure** (per `retry.ts` classification) or a newly-`OPEN`
  breaker mid-attempt, LCR re-runs selection over the *remaining* eligible
  candidates (next cheapest) up to `max_reroutes` (config, default small). This
  is re-selection, not blind retry; the failed candidate is excluded.
- On **non-transient failure** (e.g. `ENOENT`), the candidate is dropped and
  routing continues; if the pool empties, LCR returns a structured
  `NoEligibleCandidateError` naming why each candidate was excluded (auth,
  breaker, capability, price, tier, budget).
- A caller may pin an explicit `fallback: (provider, model)` used when the pool
  empties, bypassing cost *ranking*. The fallback still passes the eligibility
  and budget gates unless the caller explicitly waives the budget for it; an
  unpriced or over-budget fallback is used only under that explicit waiver,
  never silently.

## 5. Surface / API

A new provider-agnostic tool pair, dormant until configured:

- `route_request` (sync) and `route_request_async` (async), snake_case per house
  rule, Zod-validated. Inputs: `prompt` (or `promptParts`), optional
  `candidates` (explicit `(provider, model)[]` to restrict the pool), `minTier`,
  `maxCostUsd`, `expectedOutputTokens`, `requiredCapabilities`
  (images/tools/json-schema/session), `allowUnpriced`, `fallback`,
  `optimizePrompt`, plus the common passthroughs (`correlationId`,
  `outputFormat`, session controls). Output: the normal provider response **plus**
  a `routing` block: `{ chosen: {provider, model}, tier, estCostUsd,
  estInputTokens, estOutputTokens, priceAsOf, priceSource, consideredCount,
  rejected: [{candidate, reason}], reroutes }`.
- The existing per-provider tools are untouched. A later phase may add a
  `provider: "auto"` sentinel to selected tools, but only behind a new plan
  (mirrors the ACP `default_transport` deferral).
- Validation tools (`validate_with_models`, `second_opinion`, `ask_model`) MAY
  gain an opt-in `select: "cheapest" | "cheapest_per_tier"` mode that reuses the
  LCR selector to fill their target list, but their default behavior (explicit
  provider list) is unchanged.

## 6. Configuration and gating

A dormant-by-default `[least_cost]` block, mirroring `[acp]`, with its own Zod
schema + loader (throws on schema-invalid, falls back to all-off on missing or
syntactically-broken TOML), audit `sources`, and one-time deprecation warnings
for any env override.

```toml
[least_cost]
enabled = false                        # global gate; nothing routes until true
min_tier = "standard"                  # default floor
max_cost_usd = 0.50                    # default per-request budget cap
default_expected_output_tokens = 800   # estimator prior when no history
budget_output_safety_factor = 1.5      # multiplier for the conservative budget bound (4.2)
priors_scope = "global"                # global | principal | off (4.6, 7)
allow_unpriced = false                 # exclude unpriced candidates by default
max_reroutes = 2
prefer_catalog_price = true            # published catalog price over table when both exist

[least_cost.tiers]                     # (provider, family) -> tier; ships with defaults
"claude:haiku" = "economy"
"claude:sonnet" = "standard"
"claude:opus" = "frontier"
# ... derived defaults for every known family; caller can override

[least_cost.candidates]                # optional allow/deny to bound the pool
allow = []                             # empty = all eligible providers/models
deny = []
```

Precedence: request-level parameters (`minTier`, `maxCostUsd`, `candidates`)
override config; config overrides shipped defaults. All enumeration derives from
`CLI_TYPES` + `enabledApiProviders()`; no provider name is spelled in a new
array (surfaces check).

## 7. Security and correctness invariants

- **Deterministic selection.** Given the same inputs, prices, and health
  snapshot, LCR picks the same candidate. No `Math.random`/`Date.now` in the
  ranker (both are already banned in workflow-style code; here it is a
  correctness invariant so decisions are reproducible and auditable).
- **Principal isolation preserved.** "Cost history" here means per-principal and
  per-session *attribution* (who spent what, whose sessions and workspaces
  exist): that stays isolated, and LCR never routes using another principal's
  session, workspace, or attributed spend. The routing priors of 4.6 are a
  distinct thing: anonymized, model-level economics (a model's typical output
  length and its published price) that carry no caller-identifying content, so
  sharing them across principals leaks nothing. Strict deployments may still set
  `priors_scope = "principal" | "off"` (4.6). The dispatched request carries the
  caller's principal exactly as the per-provider tools do.
- **No silent quality downgrade.** Routing below `minTier` is impossible by
  construction.
- **Fail closed on budget and on empty pool.** Over-budget or no-eligible
  returns a structured error; it never falls through to an arbitrary provider.
- **Honest cost reporting.** `estCostUsd` is always labeled an estimate with its
  inputs and price `asOf`; it is never conflated with billed cost.
- **Redaction.** The `routing` block and any decision log follow existing
  flight-recorder redaction (no secrets, no base_url userinfo, no raw prompts in
  health surfaces).
- **Unpriced never wins.** `source: "unknown"` candidates are excluded or ranked
  last, never first (guards the current ZERO-cost footgun).

## 8. Observability

- **Flight recorder**: add nullable columns to `gateway_metadata` (migration,
  matching the existing additive-migration pattern): `routed BOOLEAN`,
  `route_est_cost_usd REAL`, `route_reason TEXT` (why this candidate won),
  `route_considered INTEGER`, `route_reroutes INTEGER`. Actual `cost_usd`,
  `output_tokens`, and `model` are already recorded, enabling
  estimated-vs-actual reconciliation with no new write path.
- **Metrics**: extend `metrics.ts` (or a sibling read-only aggregator) with a
  per-`(provider, model)` view: estimate accuracy (est vs actual cost ratio),
  win counts, reroute rate, the rolling output-token priors, and catalog-price
  freshness (`asOf`).
- **Resource**: a `routing://decisions` (recent decisions, redacted) and
  `routing://priors` (current per-candidate priors + price `asOf`) MCP resource,
  read-only, gated behind `enabled`.
- **Doctor/health**: surface `pricing.asOf` staleness and, per candidate,
  eligibility (`priced? authed? breaker? tier?`) so operators can see why a
  candidate is or is not being routed to.

## 9. Required code changes (module plan)

1. `src/pricing.ts`: extend to `getModelCost` with output + cache-write pricing,
   `source`/`asOf`, and `unknown` semantics (no more silent ZERO win).
2. `src/executor.ts` / `src/retry.ts`: **export a per-CLI circuit-breaker state
   accessor** (parity with `apiProviderBreakerState`). Prerequisite gap: today
   the breaker Map is module-private and the `_request` handlers hardcode
   `"closed"`. Note the breakers are keyed by resolved **command/executable**
   (e.g. `cursor` uses `cursor-agent`), not by `CliType`, so the accessor must
   map `CliType` to its executable before lookup. Also add a per-provider
   capacity helper over `getLimiterSnapshot().runningByProvider` vs
   `maxRunningPerProvider` (there is no per-provider `saturated` field).
3. `src/provider-definitions.ts`: promote implicit capabilities
   (image/attachment acceptance, tool-calling, json-schema) to explicit
   `requestSurface` flags so eligibility (4.3) reads them from the SoT rather
   than inferring. Additive, DRY, guarded by `provider:surfaces:check`.
4. New `src/least-cost-router.ts`: the pure selector (pool build, eligibility
   filter, estimator, ranker, tie-break), depending only on the SoT modules.
   Pure and unit-testable without spawning CLIs (mirror `computeFlagDrift`).
5. New read-only aggregator (sibling of `cache-stats.ts`) for the feedback-loop
   priors.
6. `src/config.ts`: `[least_cost]` Zod schema + `loadLeastCostConfig` (throw on
   schema-invalid, all-off default), threaded through the runtime.
7. `src/index.ts`: register `route_request` / `route_request_async` behind the
   config gate; dispatch through the existing handler path; add the `routing`
   block; add the `routing://` resources; extend `llm_process_health`.
8. `src/flight-recorder.ts`: additive migration for the route columns.
9. Tests: unit tests for the ranker/estimator/eligibility (deterministic,
   mocked), a fixture-driven price/tier table test, and an integration test
   behind `enabled`.

## 10. Failure policy

- Missing/broken `[least_cost]` config: all-off, log once, tools not registered
  (no partial routing).
- Every candidate is unpriced (`source: "unknown"`): `NoEligibleCandidate` by
  default. Even with `allow_unpriced`, an unpriced candidate cannot satisfy the
  budget gate (4.5, 4.7), so it is routed ONLY when the caller also explicitly
  waives the budget for it; that route carries a loud "unpriced route" flag in
  `routing`. Absent an explicit budget waiver, LCR fails closed rather than
  silently sending an unpriced (and therefore unbounded-cost) request.
- Health accessor unavailable (e.g. per-CLI breaker not yet exported): treat as
  `CLOSED` but log a degraded-health warning; do not crash routing.

## 11. Open questions

- **Output-token priors cold start**: ship per-family defaults, or require a
  warm-up window before LCR trusts a candidate? (Proposed: config default, then
  online median once N samples exist.)
- **Tier authority**: are the shipped tier assignments sufficient, or should
  tiers be derivable from a public benchmark reference kept in
  `provider-definitions`? (Proposed: config defaults now; benchmark-derived
  later.)
- **API-provider model discovery**: for OpenRouter's large model space, does the
  pool come from a caller/config allow-list only, or from a periodic
  `models` catalog fetch? (Proposed: allow-list first; catalog fetch is a later
  phase.)
- **Unpriced CLI providers** (devin, cursor): they have neither a table price nor
  usage telemetry, so they are excluded from LCR by default (usable only via
  explicit `candidates` + `allow_unpriced`). Note **grok is priced** (a table
  family exists in `src/pricing.ts`) and is therefore phase-1 eligible; it merely
  lacks `-p` usage telemetry, which affects the est-vs-actual feedback loop, not
  price-based eligibility. Open question: confirm the devin/cursor exclusion, and
  whether grok's missing usage telemetry should downweight its ranking confidence.
- **Estimate vs actual drift**: what accuracy threshold should trigger a
  price/prior refresh or an operator warning?

## 12. Rollout (phased, each its own gate)

- **phase_0**: `getModelCost` + per-CLI breaker accessor + explicit capability
  flags + the pure `least-cost-router.ts` selector + unit tests. No tool yet.
- **phase_1**: `route_request` / `route_request_async` behind
  `[least_cost].enabled=false`; CLI providers with table prices only
  (claude/codex/gemini/grok/mistral families); `routing` block + flight-recorder
  columns.
- **phase_2**: API-provider candidates (OpenRouter/xAI) priced from their
  published catalogs + the output-prior feedback aggregator + estimate-vs-actual
  reconciliation + `routing://` resources.
- **phase_3**: validation-tool `select: "cheapest"` opt-in; doctor/health
  eligibility surfacing; estimate-vs-actual reconciliation reporting.
- **phase_4 (deferred, needs a new plan)**: a `provider: "auto"` selector on the
  per-provider tools and/or a `default_route` mode. Mirrors the ACP
  `default_transport` deferral: not enabled without an explicit follow-up plan.

## 13. Authoritative references (code SoT this spec builds on)

- `src/pricing.ts` (`getPricing`, `PricePerMillion`, `PRICING_AS_OF`) - cost
  table to extend.
- `src/provider-definitions.ts` (`ProviderDefinition`, `requestSurface`,
  `capabilityScope`, `effortLevels`, `outputFormats`, `sessionContinuity`) -
  capability SoT.
- `src/provider-status.ts` (`getProviderRuntimeStatus`, `getApiProviderStatus`)
  - auth/install eligibility SoT.
- `src/retry.ts` + `src/executor.ts` (circuit breakers) and
  `src/api-provider.ts` (`apiProviderBreakerState`) - health SoT (per-CLI
  accessor to be added).
- `src/async-job-manager.ts` (`getLimiterSnapshot`, JobLimiter) - backpressure
  SoT.
- `src/flight-recorder.ts` + `src/cache-stats.ts` - telemetry + aggregation
  pattern for priors and reconciliation.
- `src/validation-orchestrator.ts` - existing multi-provider fan-out +
  eligibility filter to generalize.
- `src/provider-types.ts` (`CLI_TYPES`) + `enabledApiProviders()` - the only
  sanctioned provider enumeration; `npm run provider:surfaces:check` gate.
