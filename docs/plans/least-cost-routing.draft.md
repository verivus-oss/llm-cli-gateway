# Least-Cost Routing (LCR) specification (draft)

Status: Reviewed draft, cost-estimation revision (round 2). The base design
passed the cross-LLM review gate; not yet frozen, not implemented. This revision
folds in six cost-estimation enhancements aimed at making the cost figure as
accurate as possible for the providers that do NOT report a dollar cost, grounded
in a per-provider usage-telemetry inventory (4.1a): a derived-cost path (tokens
times rate), input-token self-calibration, a content-aware/tokenizer-family
estimator, transport-aware grok tiering, an explicit `cost_basis` + confidence
surface, and honest treatment of the zero-telemetry providers (cursor, devin).
Round-1 cross-LLM review (Grok BLOCKED, Mistral APPROVED) found three
code-verified corrections, folded in here: (1) grok ACP `_meta` token counts are
ALREADY threaded on master (`src/acp/runtime.ts:262-266`,
`src/acp/flight-redaction.ts`), so grok tiering is TRANSPORT-scoped (grok-ACP=T2,
grok-`-p`=T4, xAI-api=T1), not a "thread the meta" work item; (2) the
derived-cost formula must be per cache-ACCOUNTING-MODE (Anthropic disjoint
fresh/create/read per `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` vs OpenAI
inclusive), or it undercounts Anthropic-style counts; (3) `getModelCost` must
price by the RESOLVED underlying model family, not the CLI brand, because
cursor/devin have no `src/pricing.ts` branch and run other families' models.
Predecessor
substrate is the existing per-provider request tools, `src/pricing.ts`,
`src/optimizer.ts` (`estimateTokens`), `src/flight-recorder.ts`, the provider
output parsers, `src/provider-status.ts`, and the backpressure work
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
- **Estimated cost** (pre-flight): a USD figure computed from a price rate and a
  *token estimate*. Used for *ranking* candidates and the *budget* gate, never
  for billing. It is the least accurate basis and is the only basis available
  before dispatch.
- **Derived cost** (post-hoc, NEW): a USD figure computed from a provider's
  *actual reported token counts* times the price rate
  (`inputTokens*inputUsd + outputTokens*outputUsd + cache terms`), for providers
  that report token counts but not a dollar cost. It is a *measurement*, not an
  estimate: as accurate as the price rate is fresh. This is distinct from
  "estimated cost" (which guesses the tokens) and never involves decomposing a
  scalar total into rates (see 4.1a).
- **Actual cost** (post-hoc): the provider-reported `costUsd` recorded in the
  flight recorder. The most accurate basis. Reported today only by claude,
  mistral (when the Vibe meta.json is found), OpenRouter (with usage accounting
  on), and xAI Responses.
- **Cost basis**: which of the three above produced a given cost figure, carried
  explicitly on every recorded/returned cost as
  `cost_basis: "provider-reported" | "derived-from-tokens" | "pre-flight-estimate"`
  (accuracy descending), plus a confidence band (4.2, 8). Callers and operators
  always know how trustworthy a number is.
- **Telemetry tier** (per provider AND transport, grounds the whole cost model,
  inventory in 4.1a): T1 reports a dollar cost (claude, mistral, xAI-API); T2
  reports token counts but no dollar cost, so cost is *derived* (codex, gemini,
  OpenRouter when `usage.cost` is absent, and grok on the ACP transport, whose
  `_meta` counts are already threaded); T3 (transport-conditional) is a provider
  that yields counts on one transport but not another, so its tier depends on how
  LCR routes it, the sole case today is grok, which is T2 via ACP and T4 via the
  default `-p` wire; T4 reports no usage at all on any transport, so cost is
  *always* a pre-flight estimate (cursor, devin, grok-`-p`).

This document uses "ACP" only where it references the existing Agent Client
Protocol work; LCR is unrelated to ACP.

## 1. Goals

1. Add an opt-in, provider-agnostic entry point that selects the cheapest
   eligible `(provider, model)` candidate for a request and dispatches it
   through the existing execution path.
2. Make the cost basis explicit, single-sourced, auditable, and **as accurate as
   the available telemetry allows**: one price table, one calibrated estimator,
   and a `cost_basis` on every figure that reports whether it is
   provider-reported, derived from real token counts, or a pre-flight estimate.
   For the providers that report token counts but no dollar cost (codex, gemini,
   and others once wired), cost is a *measurement* (counts times rate), not a
   guess; the pre-flight estimator self-calibrates against recorded actuals; and
   the zero-telemetry providers are flagged low-confidence rather than silently
   trusted (see 4.1a, 4.2).
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
  cacheWriteUsdPerMTok: number;    // NEW: cache-creation rate (default = inputUsd; Anthropic ~1.25x/2x)
  accountingMode: "inclusive" | "disjoint"; // NEW (round-1): how input/cache counts split (4.1a)
  family: string;                  // NEW: resolved pricing family (from modelIdToFamily), CLI-agnostic
  source: "table" | "api-catalog" | "unknown";
  asOf: string;                    // PRICING_AS_OF or per-catalog refresh time
}
```

Rules:
- `getModelCost(provider, model)` is a NEW router-only accessor built beside
  `getPricing`. **It prices by the RESOLVED underlying model family, not the CLI
  brand** (round-1 blocker 3): `getPricing` today has branches only for claude /
  codex / gemini / grok / mistral (`src/pricing.ts:176-227`) and NO cursor / devin
  branch, so a brand-keyed lookup returns `ZERO` (then `unknown`) for them
  forever. But cursor-agent and devin run *other* families' models
  (cursor-agent `--model` selects claude/gpt/... ; devin runs claude), so
  `getModelCost` must map the request's resolved model id to a pricing family
  (a `modelIdToFamily(model)` step, CLI-agnostic) and price that family. For API
  providers (OpenRouter, xAI, ...) it resolves per-token rates from the
  provider's **published pricing catalog** (for example OpenRouter's `/models`
  prompt/completion prices), recorded with `source: "api-catalog"` and a refresh
  `asOf`. It NEVER derives per-token rates by decomposing a provider-reported
  total `costUsd`: a single scalar total cannot be split into input and output
  rates (see 4.6). When no family match and no catalog price exist,
  `source: "unknown"`.
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

### 4.1a Cost basis and the derived-cost path (enhancement 1)

`getModelCost` gives per-token *rates*; how those rates combine into a total, and
how trustworthy the total is, depends on what the provider reported. Every cost
figure LCR records or returns carries a `cost_basis` and is produced by exactly
one of three composers, in descending accuracy:

1. **`provider-reported`**: the parser captured a dollar `costUsd`. Use it
   verbatim. (claude `total_cost_usd`, mistral `session_cost`, xAI ticks/nanos,
   OpenRouter `usage.cost` when `usage.include`.)
2. **`derived-from-tokens`** (NEW, the key accuracy win): the parser captured
   token *counts* but no dollar cost. Compose the total from the counts and the
   `getModelCost` rates. **The formula is per cache-ACCOUNTING-MODE** (round-1
   blocker 2): providers report the input/cache split two incompatible ways, and
   a single formula undercounts one of them. `getModelCost` carries the model
   family's `accountingMode`:
   - **`inclusive`** (OpenAI-style: codex, gemini, xAI, OpenRouter, grok ACP):
     `inputTokens` already INCLUDES the cached-read subset, so the cache read is a
     discount off the base:
     ```
     costUsd = inputTokens        * inputUsdPerMTok      / 1e6
             + cacheCreationTokens * cacheWriteUsdPerMTok / 1e6
             + outputTokens        * outputUsdPerMTok     / 1e6
             - cacheReadTokens      * inputUsdPerMTok * (1 - cacheReadMultiplier) / 1e6
     ```
   - **`disjoint`** (Anthropic-style: `Total input = cache_read + cache_creation
     + input_tokens`, `input_tokens` is FRESH only, per
     `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md`):
     ```
     costUsd = inputTokens        * inputUsdPerMTok                     / 1e6   // fresh only
             + cacheCreationTokens * cacheWriteUsdPerMTok                / 1e6
             + cacheReadTokens     * inputUsdPerMTok * cacheReadMultiplier / 1e6 // read is BILLED, not subtracted
             + outputTokens        * outputUsdPerMTok                    / 1e6
     ```
   Applying the `inclusive` formula to `disjoint` counts never bills the cache-read
   base and only subtracts a phantom saving, so it undercounts. Note the only
   `disjoint` provider today (claude) is T1 (`provider-reported`), so the disjoint
   path bites the **Anthropic-API adapter** (`src/api-provider.ts:251-254`, which
   currently extracts `cache_read_input_tokens` but NOT `cache_creation_input_tokens`,
   a gap the derived path exposes) and any future Anthropic-family derived route.
   This is a *measurement* (real counts) at the table/catalog rate, accurate to the
   price's freshness, and the inverse-safe direction of the forbidden operation:
   composing a total from KNOWN rates times reported counts is sound; DECOMPOSING a
   scalar total into unknown rates is not (4.6). Requires
   `getModelCost(...).source != "unknown"`; if the rate is unknown the figure falls
   back to basis 3 with a loud low-confidence flag. **Reasoning tokens**: when a
   family bills hidden reasoning/thinking tokens as output and reports them
   separately (grok ACP `_meta` carries `reasoningTokens`, which
   `extractAcpPromptUsage` (`src/acp/runtime.ts:119`) currently DROPS), the derived
   total must add them at the output rate, or it undercounts reasoning-heavy runs;
   capturing that field is a prerequisite for accurate grok-ACP derivation.
3. **`pre-flight-estimate`**: no token counts were reported (T4 providers, or any
   request before dispatch). Compose from the *token estimate* (4.2) times the
   rate. Least accurate.

The composer is a single pure `composeCost(counts | null, estimate, modelCost)`
that returns `{ costUsd, cost_basis, confidence }`. Post-hoc, LCR always upgrades
a request's recorded cost to the best basis its telemetry allows: a T2 provider's
row is stored with `cost_basis: "derived-from-tokens"`, not left as the pre-flight
estimate. **No code derives cost from tokens today** (only `estimateCacheSavingsUsd`
computes a cache *savings*, not a total); this path is new.

**Per-provider telemetry inventory (SoT for the tiers; keyed by
provider+transport, not just provider, per round-1 blocker 1):**

| Provider (transport) | `costUsd`? | Token counts? | Acct mode | Basis used | Parser |
|---|---|---|---|---|---|
| claude (CLI) | yes | yes (+cache r/w) | disjoint | provider-reported | `stream-json-parser.ts` |
| mistral (CLI) | yes | yes (no cache) | inclusive | provider-reported | `mistral-meta-json-parser.ts` |
| xAI (API) | yes | yes (+cache read) | inclusive | provider-reported | `api-provider.ts` |
| **codex** (CLI) | field-only (rare) | **yes (+cache r/w)** | inclusive | reported if present, else **derived** | `codex-json-parser.ts` |
| **gemini** (CLI) | no | **yes (+cache read)** | inclusive | **derived-from-tokens** | `gemini-json-parser.ts` |
| OpenRouter/OAI (API) | conditional | yes | inclusive | reported or derived | `api-provider.ts` |
| Anthropic (API adapter) | no | partial (cache_creation MISSING) | disjoint | derived (incomplete until `cache_creation` extracted) | `api-provider.ts:251-254` |
| **grok (ACP)** | no | **yes (+cache read; reasoningTokens DROPPED)** | inclusive | **derived-from-tokens** (already threaded, `runtime.ts:262-266`) | `acp/runtime.ts` `extractAcpPromptUsage` |
| **grok (`-p` default)** | no | **no** (`usageAbsent`) | n/a | pre-flight-estimate only | `grok-json-parser.ts` |
| **cursor** (CLI) | no | no | per resolved model | pre-flight-estimate only (enh. 6) | none (`{}`) |
| **devin** (CLI) | no | no | per resolved model | pre-flight-estimate only (enh. 6) | none (`{}`) |

Grok is **transport-scoped**: routing grok via ACP (gated by `[acp].enabled` +
per-provider `runtime_enabled`; default transport stays `cli`) yields derived
cost from the already-threaded `_meta`; routing grok via the default `-p`
transport yields no counts and is estimate-only. LCR therefore reasons about a
`(provider, transport)` candidate for grok, not just `(provider, model)`, when
deciding whether a derived cost is achievable (see 4.6, phase_2b).

### 4.2 Pre-flight cost estimation

LCR computes TWO estimates per request, for two different purposes.

**Ranking estimate** (orders candidates). The ranking estimate applies the SAME
per-`accountingMode` composition as the derived path (4.1a), fed by *estimated*
token counts instead of reported ones (round-2 blocker: ranking must not be
mode-blind, or disjoint families mis-rank). `estInputTokens` is defined as the
WHOLE-PROMPT input estimate; the formula converts per mode. `inclusive` mode
(codex, gemini, xAI, OpenRouter, grok-ACP):

```
estCost = estInputTokens      * inputUsdPerMTok      / 1e6
        + estCacheWriteTokens * cacheWriteUsdPerMTok / 1e6
        + estOutputTokens     * outputUsdPerMTok     / 1e6
        - estCacheReadTokens  * inputUsdPerMTok * (1 - cacheReadMultiplier) / 1e6
```

`disjoint` mode (Anthropic-family): the whole-prompt input splits into fresh +
cache, and cache-read is BILLED (not subtracted), mirroring the 4.1a disjoint
derive:

```
estFresh = estInputTokens - estCacheReadTokens - estCacheWriteTokens
estCost  = estFresh          * inputUsdPerMTok                      / 1e6
         + estCacheWriteTokens * cacheWriteUsdPerMTok                / 1e6
         + estCacheReadTokens  * inputUsdPerMTok * cacheReadMultiplier / 1e6
         + estOutputTokens     * outputUsdPerMTok                     / 1e6
```

In practice `composeCost` (4.1a) is the single implementation of both formulas,
called once with reported counts (derive) and once with estimated counts
(ranking/budget), so the mode branch can never drift between the two paths. The
budget estimate (below) uses the same mode branch with its conservative output
bound.

- `estInputTokens` / `estCacheReadTokens` / `estCacheWriteTokens`: from the token
  estimator (below) plus the caller's cache-control markers. The cache-write term
  is included explicitly (Anthropic charges roughly 1.25x input for cache
  creation), so the formula no longer under-prices cache-creation requests.

**Token estimator (enhancements 2 + 3).** The base heuristic today is
`estimateTokens = ceil(words * 1.3)` (`src/optimizer.ts:27`), which is badly
biased for code/JSON (denser BPE), CJK, and punctuation-heavy text, exactly the
inputs a coding gateway sees. Replace it with a layered estimator in a new
`src/token-estimator.ts`, best available layer wins:

1. **Content-aware base (enh. 3).** A character-based estimator with a
   content-type classifier: prose approximately `chars/4`, code/JSON/markup
   denser (approximately `chars/3` and per-language tuned), CJK approximately
   `chars/1.5`. Applied to the whole prompt (system + tools + context + task for
   structured prompts). This alone beats `words * 1.3` with zero dependencies.
2. **Per-tokenizer-family multiplier (enh. 3).** The same text tokenizes to
   different counts across families (OpenAI `o200k`/`cl100k`, Claude, Gemini
   SentencePiece). A small per-family multiplier (keyed off the candidate's
   family in `provider-definitions`/`pricing`) adjusts the base so cross-model
   ranking near ties is less arbitrary. Multipliers are data-derived (layer 3),
   not guessed.
3. **Self-calibration from the flight recorder (enh. 2, the accuracy multiplier).**
   The recorder already holds *actual* `input_tokens` for a large share of past
   requests (all T1 + T2 rows: claude, mistral, codex, gemini, xAI, OpenRouter,
   grok-ACP). A read-only aggregator (4.6) fits a correction factor
   `k = median(actual_input_tokens / base_estimate)` bucketed by
   `(content-type, tokenizer-family)`, and the estimator applies `k` to the base.
   **The bucket key is the resolved MODEL family, never the CLI brand** (round-1
   note): cursor-agent and devin run models from several families, so a `k`
   learned for, say, the claude tokenizer is applied to a cursor/devin candidate
   *whose resolved model is claude-family*, matched via the same
   `modelIdToFamily` used for pricing (4.1). This is how the calibration transfers
   to the zero-telemetry providers without conflating a CLI with a tokenizer. Two
   accounting caveats the aggregator must respect so `k` is not poisoned: (a)
   `disjoint` families report `input_tokens` as FRESH-only, so their
   `actual_input` for the ratio must be reconstructed as
   `fresh + cache_read + cache_creation` to be comparable to the whole-prompt
   estimate (per-family buckets keep the two modes separate); (b) mistral's
   `session_*` counts can be cumulative across a multi-turn session, so
   session-continued rows are excluded from calibration (only fresh-session rows
   feed `k`). The correction is a property of the *content and tokenizer*, never
   of a principal (7), and honours `priors_scope`.

Layer 1 is the cold-start floor; 2 and 3 refine it as data accrues. A real BPE
tokenizer (`gpt-tokenizer`, pure-JS) would make layer 1 exact for the OpenAI
family, but it is a NEW production dependency the strict `npm-shrinkwrap` /
Socket / tarball gates would scrutinise (bundled token tables add weight), so the
calibrated heuristic is preferred; a real tokenizer is an OPTIONAL, opt-in layer
(open question 11, its own slice) rather than a default dependency.
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

**Confidence band (enhancement 5), with concrete thresholds (round-1 note).** The
aggregator (4.6) stores, per `(content-type, model-family)` bucket, the sample
count `n` and the p10 / p50 / p90 of the residual ratio `r = actual/estimate`. The
returned band is the point estimate scaled by the bucket ratios:
`[point * (p10/p50), point * (p90/p50)]`. The coarse label is a fixed mapping (a
config-tunable table, not implementer judgement):
- `high`: `n >= 30` AND `p90/p10 <= 1.5`.
- `medium`: `n >= 30` AND `p90/p10 <= 3`, OR `10 <= n < 30`.
- `low`: `n < 10` (cold start), OR `p90/p10 > 3`, OR a T4 candidate borrowing
  another family's `k` with no own samples.

Confidence composes with `cost_basis` (4.1a) by taking the MINIMUM of the two:
`provider-reported` is `high`; `derived-from-tokens` is `high` only when the price
`asOf` is fresh (a stale `asOf` beyond a configured age demotes it to `medium`,
since the counts are real but the rate may not be); `pre-flight-estimate` takes
the band label above. **Confidence is advisory metadata, it does NOT change the
ranking**: argmin is over the point estimates and ties are settled by the
deterministic tie-break (4.5); the band is reported so a caller/operator can see
that a near-tie is uncertain, but LCR never re-orders candidates by confidence
(that would make routing non-deterministic). Overlapping bands at a near-tie are
flagged in `routing` as `near_tie: true`.

**Honesty requirement.** With no real tokenizer, pre-flight figures are
approximations. The response reports the ranking estimate with its full inputs
(token estimate + confidence band, the output prior and its source, `cost_basis`,
price `asOf` and `source`), never as a guaranteed or billed price.

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
- **Cost upgrade on completion (enh. 1)**: when a request finishes, its recorded
  cost is written at the best basis its telemetry allows (4.1a). A T1 provider
  keeps its `provider-reported` `cost_usd`; a T2 provider (codex, gemini,
  OpenRouter-without-`usage.cost`) has its cost *derived* from the recorded token
  counts times `getModelCost` and stored with
  `cost_basis: "derived-from-tokens"`, replacing the pre-flight estimate. This is
  a new post-hoc write (a `cost_usd` + `cost_basis` backfill on `logComplete`),
  additive to the existing columns.
- **Feedback loop (enh. 2 + 5)**: a read-only aggregator (same pattern as
  `cache-stats.ts`) maintains **model-level economics only**, per
  `(provider, model)` and per `(content-type, tokenizer-family)`:
  - a rolling median and p90 of `output_tokens` (the existing output priors, 4.2);
  - **NEW** an input-token correction factor `k = median(actual_input_tokens /
    base_estimate)` per `(content-type, family)`, feeding the calibrated
    estimator (4.2 layer 3);
  - **NEW** the residual spread of `actual/estimate` per bucket, feeding the
    confidence band (4.2, enh. 5);
  - **NEW** per-`(provider, model)` estimate-vs-actual accuracy (est cost / actual
    or derived cost) for the reconciliation surface (8).
  It does NOT learn per-token *prices* from a scalar `cost_usd` (a single total
  cannot be decomposed into input and output rates); rates come only from the
  table/catalog (4.1). Composing a *total* from reported counts times known rates
  (the derived-cost path above) is the sound, opposite direction and is allowed.
- **Grok transport-aware derivation (enhancement 4, corrected in round 1)**: grok
  ACP `session/prompt` `_meta` token counts are ALREADY threaded on master
  (`extractAcpPromptUsage` -> `buildAcpFlightResult`, `src/acp/runtime.ts:119,262-266`;
  tests `src/__tests__/acp-runtime.test.ts`), so there is nothing to "thread". The
  real work is two-fold: (a) `extractAcpPromptUsage` currently DROPS the `_meta`
  `reasoningTokens` field, so grok-ACP derived cost undercounts reasoning; a small
  parser addition captures it and the derived formula adds it at the output rate
  (4.1a). (b) grok yields counts ONLY on the ACP transport, so LCR can derive
  grok's cost only when it routes grok via ACP, which is gated
  (`[acp].enabled` + per-provider `runtime_enabled`; default transport `cli`, see
  `docs/acp-contract.md`). A grok candidate is therefore `(grok, transport)`: on
  the `-p` default transport grok is estimate-only (T4-like); routing it via ACP
  makes it T2. LCR treats "can this candidate produce a derived cost" as a
  transport-dependent property, and does NOT flip the ACP default on to chase
  cheaper telemetry (that stays operator-gated). cursor and devin capture nothing
  on any transport and stay estimate-only (enh. 6).
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

- **Flight recorder**: add nullable columns (additive migration): `routed
  BOOLEAN`, `route_est_cost_usd REAL`, `route_est_confidence TEXT`
  (`high|medium|low`, enh. 5), `route_reason TEXT`, `route_considered INTEGER`,
  `route_reroutes INTEGER`, and a request-wide **`cost_basis TEXT`** (enh. 1,
  `provider-reported | derived-from-tokens | pre-flight-estimate`) so every row
  states how its `cost_usd` was obtained. `input_tokens`, `output_tokens`,
  `cost_usd`, and `model` already exist; the derived-cost path backfills
  `cost_usd` + `cost_basis` on `logComplete` for T2 rows.
- **Metrics**: extend `metrics.ts` (or a sibling read-only aggregator) with a
  per-`(provider, model)` view: estimate-vs-actual accuracy split BY `cost_basis`
  (so a T2 provider's `derived` accuracy is not mixed with a T4 provider's
  `estimate` accuracy), win counts, reroute rate, the output-token priors, the
  input-token calibration factor `k` and its sample count and residual spread
  (the **calibration quality**, enh. 2/5), and catalog-price freshness (`asOf`).
- **Resource**: `routing://decisions` (recent decisions, redacted, each with its
  `cost_basis` + confidence) and `routing://priors` (per-candidate output priors,
  input-calibration `k` + quality, price `asOf`) MCP resources, read-only, gated
  behind `enabled`.
- **Doctor/health**: surface `pricing.asOf` staleness; per provider its
  **telemetry tier** (T1-T4, 4.1a) so operators see which providers yield
  measured vs estimated costs; per candidate, eligibility (`priced? authed?
  breaker? tier?`); and per `(content-type, family)` the calibration quality
  (`k`, samples, confidence), so a low-confidence estimator surface is visible
  rather than silent.

## 9. Required code changes (module plan)

1. `src/pricing.ts`: extend to `getModelCost` with output + cache-write pricing,
   `source`/`asOf`, and `unknown` semantics (no more silent ZERO win). Add a pure
   `composeCost(counts | null, estimate, modelCost) -> { costUsd, cost_basis,
   confidence }` (enh. 1) that produces `provider-reported` (passthrough),
   `derived-from-tokens` (counts times rate, branching on
   `modelCost.accountingMode` = `inclusive|disjoint`, 4.1a), or
   `pre-flight-estimate`; forbidden scalar-decomposition never appears. Add a
   CLI-agnostic `modelIdToFamily(model)` used by `getModelCost` for pricing and by
   the calibrator for bucket keys, so cursor/devin (no brand branch) and any
   provider running another family's model are priced/calibrated by the resolved
   family, not the brand.
1a. New `src/token-estimator.ts` (enh. 2 + 3): the layered estimator, content-type
   classifier + char base, per-tokenizer-family multiplier, and application of the
   calibration factor `k` from the aggregator. Replaces the direct use of
   `optimizer.estimateTokens` on the routing path (the crude heuristic stays as
   the layer-1 floor / other callers). Pure and unit-testable over fixture text;
   the optional real-BPE layer (open question) is a separate, gated add-on.
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
   priors: output median/p90 (existing), plus (enh. 2/5) the input-token
   calibration factor `k`, its sample count, and residual spread per
   `(content-type, tokenizer-family)`, and per-`(provider, model)` accuracy split
   by `cost_basis`. Reads `owner_principal`-stamped rows, emits only anonymized
   model-level aggregates, honours `priors_scope`.
6. `src/config.ts`: `[least_cost]` Zod schema + `loadLeastCostConfig` (throw on
   schema-invalid, all-off default), threaded through the runtime.
7. `src/index.ts`: register `route_request` / `route_request_async` behind the
   config gate; dispatch through the existing handler path; add the `routing`
   block; add the `routing://` resources; extend `llm_process_health`.
8. `src/flight-recorder.ts`: additive migration for the route columns + the
   request-wide `cost_basis` / `route_est_confidence` columns (enh. 1/5), and the
   `logComplete` derived-cost backfill for T2 rows.
8a. Provider parsers (enh. 1 wiring + enh. 4): route T2 providers' captured token
   counts through `composeCost` at `extractUsageAndCost`
   (`src/index.ts:2045`). Grok ACP `_meta` counts are ALREADY threaded
   (`src/acp/runtime.ts:262-266`); the remaining work is capturing the dropped
   `reasoningTokens` there and making LCR route grok via the gated ACP transport
   to obtain counts (grok-`-p` stays estimate-only). cursor/devin have no parser
   and remain estimate-only (enh. 6). Also fix the stale "ACP usage not wired"
   comment at `src/index.ts:2138-2143` so future readers are not misled.
9. Tests: unit tests for the ranker/eligibility, the layered token-estimator
   (content-type buckets, family multipliers, calibration application), the
   `composeCost` basis matrix (reported/derived/estimate + unknown-rate fallback),
   the derived-cost backfill, and the calibration/confidence aggregator over a
   synthetic flight-recorder fixture; a fixture-driven price/tier table test; an
   integration test behind `enabled`. All deterministic and mocked.

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
- **Zero-telemetry providers (devin, cursor), enh. 6 + round-1 blocker 3**: they
  capture no token counts, so their cost is *always* a `pre-flight-estimate` (T4),
  even post-hoc, and always `confidence: low`. Because `src/pricing.ts` has NO
  cursor/devin branch, whether a candidate is priced at all hinges on the
  `modelIdToFamily(model)` resolution added to `getModelCost` (4.1): (a) if the
  resolved underlying model maps to a priced family (cursor-agent/devin running a
  claude/gpt/... model), cost is estimate times that family's rate, ranked with
  `confidence: low`; (b) if the model id does not map to any known family,
  `source: "unknown"`, excluded from ranking unless `allow_unpriced` + budget
  waiver (10). Open question: how complete must `modelIdToFamily` be, and what is
  the fallback when cursor/devin do not surface a resolvable model id at all
  (proposed: treat as `unknown`, i.e. excluded by default)? Confidence never
  re-orders candidates (4.2), so a low-confidence priced T4 competes on its point
  estimate.
- **RESOLVED in round 1 (kept for the record)**: enh. 5 confidence thresholds are
  now concrete (4.2, the `n`/`p90:p10` table, `asOf`-staleness demotion,
  advisory-not-ranking rule); the grok tier is transport-scoped (4.1a) and the
  ACP `_meta` is already threaded, so "thread the meta" is no longer open work
  (only `reasoningTokens` capture remains, enh. 4).
- **Real BPE tokenizer (enh. 3)**: ship the calibrated heuristic only, or add an
  OPTIONAL `gpt-tokenizer`-style exact layer for the OpenAI family? A real
  tokenizer is exact but a new prod dependency the shrinkwrap/Socket/tarball gates
  scrutinise (bundled token tables add weight). Proposed: heuristic + calibration
  by default; the exact layer is an opt-in slice, never a default dependency.
- **Calibration cold start (enh. 2)**: how many samples before the estimator
  trusts a learned `k` over the layer-1/2 default? (Proposed: a minimum sample
  count per bucket; below it, `confidence: low` and the base estimate stands.)
- **Estimate vs actual drift**: what accuracy threshold (now split by
  `cost_basis`) should trigger a price/prior refresh or an operator warning?

## 12. Rollout (phased, each its own gate)

- **phase_0**: `getModelCost` + `composeCost` (enh. 1) + the layered
  `token-estimator.ts` (enh. 3, content-aware base + family multipliers; no
  calibration yet) + per-CLI breaker accessor + explicit capability flags + the
  pure `least-cost-router.ts` selector + unit tests. No tool yet.
- **phase_1**: `route_request` / `route_request_async` behind
  `[least_cost].enabled=false`; CLI providers with table prices only
  (claude/codex/gemini/grok/mistral families); `routing` block + flight-recorder
  columns incl. `cost_basis` + `route_est_confidence` (enh. 1/5); the
  derived-cost backfill on `logComplete` for the T2 providers already emitting
  counts (codex, gemini) (enh. 1); the T4 `confidence: low` flag for cursor/devin
  (enh. 6).
- **phase_2**: API-provider candidates (OpenRouter/xAI) priced from published
  catalogs + the feedback aggregator: output priors AND the input-token
  calibration factor `k` + residual spread feeding the calibrated estimator and
  confidence band (enh. 2/5) + estimate-vs-actual reconciliation split by
  `cost_basis` + `routing://` resources.
- **phase_2b (enh. 4, corrected)**: grok ACP `_meta` counts are already threaded,
  so this slice (i) captures the dropped `reasoningTokens` in
  `extractAcpPromptUsage` and adds it to the derived formula, and (ii) makes LCR
  transport-aware for grok, deriving cost only when grok is routed via the
  operator-gated ACP transport, estimate-only on `-p`. It never flips the ACP
  default on. Small, isolated; own review gate. Also extract
  `cache_creation_input_tokens` in the Anthropic-API adapter
  (`src/api-provider.ts:251-254`) so its `disjoint` derived cost is complete.
- **phase_3**: validation-tool `select: "cheapest"` opt-in; doctor/health
  eligibility + telemetry-tier + calibration-quality surfacing (enh. 5);
  estimate-vs-actual reconciliation reporting. Optional real-BPE tokenizer layer
  (enh. 3, open question) is a candidate slice here if adopted.
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
  pattern for priors, calibration, and reconciliation (`input_tokens` /
  `output_tokens` / `cost_usd` columns are the calibration substrate).
- `src/optimizer.ts:27` (`estimateTokens`, `ceil(words*1.3)`) - the crude base
  heuristic the layered `token-estimator.ts` replaces on the routing path.
- `src/acp/runtime.ts:119,262-266` (`extractAcpPromptUsage`, `buildAcpFlightResult`)
  and `src/acp/flight-redaction.ts` - grok ACP `_meta` token counts are ALREADY
  threaded here (round-1 correction); `reasoningTokens` is the only dropped field.
- `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` - the Anthropic disjoint vs OpenAI
  inclusive cache-accounting SoT for the derived-cost formula (4.1a).
- Provider output parsers - the token-count / cost SoT per tier (4.1a table):
  `src/stream-json-parser.ts` (claude), `src/codex-json-parser.ts`,
  `src/gemini-json-parser.ts`, `src/mistral-meta-json-parser.ts`,
  `src/grok-json-parser.ts` (`usageAbsent`), `src/api-provider.ts`, dispatched by
  `extractUsageAndCost` (`src/index.ts:2045`).
- `src/validation-orchestrator.ts` - existing multi-provider fan-out +
  eligibility filter to generalize.
- `src/provider-types.ts` (`CLI_TYPES`) + `enabledApiProviders()` - the only
  sanctioned provider enumeration; `npm run provider:surfaces:check` gate.
