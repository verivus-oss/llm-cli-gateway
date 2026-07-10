# Frozen least-cost-routing (LCR) contract

Status: frozen contract for
`docs/plans/least-cost-routing.dag.toml`, step `freeze-contract`.

This document freezes the LCR contract before implementation begins. It is the
authoritative, human-readable statement of what least-cost routing is and is
not. It is derived from the cross-LLM-approved spec
(`docs/plans/least-cost-routing.draft.md`, Grok + Mistral approved through the
cost-estimation revision) and its machine plan
(`docs/plans/least-cost-routing.dag.toml`). Implementation steps must not weaken
these decisions; they may only add detail underneath them.

## Scope (read first)

**LCR routes a request to the cheapest eligible `(provider, model)` candidate
that still satisfies the caller's capability and quality constraints, then
dispatches it through the existing execution path.** It is cost-minimization
*subject to constraints*, never "always the cheapest thing". LCR is unrelated to
ACP (Agent Client Protocol); the two only intersect where LCR reasons about
grok's transport (below).

The routing unit is a **candidate**: a `(provider, model)` pair, where
`provider` is a member of `CLI_TYPES` or an enabled API-provider name and
`model` is a concrete model id that provider can serve. Cost varies far more
across models than across providers, so LCR never routes a bare provider.

## Frozen decisions

1. **Dormant by default.** `[least_cost].enabled` defaults false. When off, the
   `route_request` / `route_request_async` tools are **not registered at all**
   (mirrors the async-jobs and `[acp]` gating): nothing routes until an operator
   opts in.

2. **A dedicated tool surface, existing tools unchanged.** LCR is reached only
   through `route_request` / `route_request_async`. `claude_request` still goes
   to claude. No `provider: "auto"` sentinel on the per-provider tools in this
   plan (deferred to a later plan, mirroring the ACP `default_transport`
   deferral).

3. **One price source of truth.** `src/pricing.ts` is extended, never forked. A
   new router-only `getModelCost(provider, model)` is added beside `getPricing`;
   `getPricing` and `estimateCacheSavingsUsd` keep their existing
   ZERO-for-unknown semantics for the cache-savings path. No second price table.

4. **`getModelCost` prices by resolved model family, not CLI brand.** A
   CLI-agnostic `modelIdToFamily(model)` maps the request's resolved model id to
   a pricing family. cursor and devin have no `src/pricing.ts` brand branch but
   run other families' models, so they are priced by the family they actually
   run, or `source: "unknown"` when no family resolves.

5. **Unknown price never wins.** `source: "unknown"` is a hard eligibility
   signal, not a silent zero. An unpriced candidate is excluded from cost
   ranking unless `allow_unpriced` is set, and even then it is ranked strictly
   last and cannot pass the budget gate without both `allow_unpriced` and an
   explicit budget waiver (see decision 13). This deliberately does not inherit
   `getPricing`'s ZERO-for-unknown behaviour.

6. **Cost basis is explicit on every figure.** Every recorded or returned cost
   carries `cost_basis: "provider-reported" | "derived-from-tokens" |
   "pre-flight-estimate"` (accuracy descending). A single pure
   `composeCost(counts | null, estimate, modelCost)` produces all three and is
   the only place cost is composed.

7. **Derived cost is composition, never decomposition.** For providers that
   report token counts but no dollar cost (T2), cost is *derived* as
   `counts x getModelCost rate`. LCR never decomposes a scalar total `costUsd`
   into per-token rates: a single total cannot be split into input and output
   rates. Composing a total from known rates times reported counts is the sound,
   opposite direction and is the only allowed direction.

8. **Cache accounting is per-family.** `getModelCost` carries an
   `accountingMode`. `inclusive` (OpenAI-style: codex, gemini, xAI, OpenRouter,
   grok-ACP) treats `inputTokens` as already including the cached-read subset, so
   cache read is a discount off the base. `disjoint` (Anthropic-style)
   treats `input_tokens` as fresh-only and bills cache read. `composeCost` is the
   single implementation of both formulas, called once with reported counts
   (derive) and once with estimated counts (ranking/budget), so the mode branch
   can never drift between the two paths.

9. **Two estimates, two purposes.** A shared **ranking** estimate orders
   candidates (the shared error largely cancels for ordering). A conservative
   **budget** estimate enforces `maxCostUsd` and must fail safe: it uses a
   high-percentile / caller-capped output bound, and if no output bound can be
   established the candidate's cost is treated as unbounded and it fails the
   gate rather than being silently admitted.

10. **Token estimation is layered and calibrated.** A new `src/token-estimator.ts`
    replaces `optimizer.estimateTokens` on the routing path only: a content-aware
    char base (prose / code / CJK), a per-tokenizer-family multiplier, and a
    self-calibration factor `k` learned from the flight recorder's real input
    counts, bucketed by `(content-type, resolved family)`. An optional real-BPE
    layer is an opt-in slice, never a default dependency.

11. **Deterministic selection.** Given the same inputs, prices, and health
    snapshot, LCR picks the same candidate. No `Math.random` / `Date.now` in the
    ranker. `argmin(estCost)` with a stable tie-break (success rate, then mean
    latency, then a config `preferenceOrder`, then lexical).

12. **Quality floor, no silent downgrade.** A coarse config-driven capability
    tier (`economy | standard | frontier`) is assigned per `(provider, family)`,
    with a shipped default for every priced family. The caller's `minTier`
    (default `standard`) is a hard floor; untiered models are excluded from
    tier-gated routing unless listed explicitly.

13. **Fail closed.** Over-budget, all-unpriced, or empty-eligible-pool returns a
    structured error (`BudgetExceededError` / `NoEligibleCandidateError` naming
    per-candidate exclusion reasons). Routing never falls through to an arbitrary
    provider. An unpriced candidate (unbounded cost) is admissible only when the
    caller sets **both** `allow_unpriced` and an explicit budget waiver (spec
    4.5). A priced over-budget candidate fails closed in normal selection (spec
    4.5); it is admissible only as an explicit `fallback` under an explicit
    budget waiver (spec 4.7). An unpriced candidate is always ranked strictly
    last (its unknown price can never win the argmin, invariant
    `unknown_price_never_wins`).

14. **Dispatch reuses the existing path.** The chosen `(provider, model)` is
    handed to the same handler logic the per-provider tools use
    (`AsyncJobManager.startJob` for CLI, `runApiRequest` for API). LCR selects
    inputs; it does not fork execution. Retries, circuit breakers, principal
    isolation, and flight recording are identical to a direct call.

15. **Grok is transport-scoped.** grok-ACP is T2 (its `_meta` token counts are
    already threaded on master; deriving cost only requires capturing the
    currently-dropped `reasoningTokens`), grok-`-p` is T4 (estimate-only), and
    the xAI API provider is T1. LCR reasons about a `(grok, transport)` candidate
    and never flips the ACP default transport on to chase cheaper telemetry.

16. **Priors are anonymized model-level economics.** The feedback aggregator
    (`src/lcr-priors.ts`, read-only sibling of `cache-stats.ts`) emits only
    anonymized per-`(provider, model)` aggregates (output median/p90,
    input-calibration `k`, residual spread, est-vs-actual accuracy split by
    `cost_basis`). It never learns per-token prices from a scalar `cost_usd`, and
    it honours `priors_scope = global | principal | off`.

## Non-goals

- **Not a load balancer.** LCR optimizes cost, not throughput or latency.
  Latency and saturation are eligibility inputs, not the objective.
- **Not billing-accurate.** Pre-flight estimates rank candidates; they are never
  invoices. No real tokenizer is shipped by default.
- **No automatic quality arbitration.** LCR never routes below the caller
  `minTier` to save money.
- **No override of an explicit provider.** The per-provider tools are untouched;
  LCR is reached only through its own tool.
- **No new provider lists.** All enumeration derives from `CLI_TYPES` +
  `enabledApiProviders()`; `npm run provider:surfaces:check` enforces it.
- **Not cross-instance.** Routing decisions are local to one gateway instance.
- **No scalar-costUsd rate decomposition.** A single total cannot be split into
  input/output rates; catalog/table prices are used instead.

## Security and correctness invariants

- Deterministic selection (no `Math.random` / `Date.now` in the ranker).
- Principal attribution stays isolated; LCR never routes using another
  principal's session, workspace, or attributed spend.
- Priors are anonymized model-level economics, carrying no caller-identifying
  content; calibration `k` is keyed by `(content-type, resolved family)`, never a
  principal.
- `source: "unknown"` never wins; unpriced candidates cannot pass the budget
  gate without an explicit waiver.
- Budget and empty-pool fail closed with structured errors.
- No silent quality downgrade below `minTier`.
- Honest cost labelling: `estCostUsd` is always labelled an estimate with its
  inputs (`cost_basis`, confidence, price `asOf`/`source`); never conflated with
  billed cost.
- The `routing` block and any decision log follow existing flight-recorder
  redaction (no secrets, no `base_url` userinfo, no raw prompts in health
  surfaces).
- Every cost figure carries a `cost_basis`; a recorded row is upgraded to the
  best basis its telemetry allows (T2 rows backfilled to `derived-from-tokens`).
- Confidence is advisory metadata and never re-orders candidates; `argmin` is
  over point estimates only.
- `getPricing` semantics are unchanged (ZERO-for-unknown stays for cache-stats).
- Dormant by default; the route tools are unregistered when `enabled` is false.

## References

- Spec: `docs/plans/least-cost-routing.draft.md`
- Machine plan: `docs/plans/least-cost-routing.dag.toml`
- Cache-accounting SoT: `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md`
- Provider registry SoT: `src/provider-definitions.ts`, `src/provider-types.ts`
