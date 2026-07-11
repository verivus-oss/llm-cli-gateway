---
name: least-cost-routing
description: Route a model-agnostic request to the cheapest capable (provider, model) via route_request, subject to a quality-tier floor and a hard budget cap. Use when you do not care WHICH model runs a task, only that it is cheap enough and good enough.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Least-cost routing (route_request)

`route_request` (sync) and `route_request_async` (async) pick the **cheapest
eligible `(provider, model)`** candidate that meets your constraints, then
dispatch it through the normal provider path. They are **dormant by default**:
registered only when `[least_cost].enabled = true` in
`~/.llm-cli-gateway/config.toml`. If the tools are absent, routing is off; use a
specific provider tool instead.

## When to use this vs a named provider tool

- Use `route_request` when the task is model-agnostic (summarize, answer,
  classify, rewrite) and you want the cheapest model that clears a quality floor.
- Use `claude_request` / `codex_request` / etc. when you need a SPECIFIC model or
  provider, a provider-specific flag, session resume, or a worktree. In phase_1
  `route_request` is fresh one-shot only (no `sessionId` / `workspace` /
  `worktree`).

## Inputs

- `prompt` (or `promptParts`): the request. Exactly one.
- `minTier`: `economy | standard | frontier` (default `standard`). A hard floor,
  never downgraded to save money.
- `maxCostUsd`: per-request budget cap. Over-budget fails closed.
- `expectedOutputTokens` / `maxOutputTokens`: tune the ranking and the
  conservative budget bound.
- `requiredCapabilities`: `{ images?, attachments?, toolCalling?, jsonSchema?,
  outputFormat?, effort? }`. A candidate missing a required capability is
  excluded.
- `candidates`: an explicit `(provider, model)[]` to restrict the pool (also
  whitelists otherwise-untiered / maintain-only candidates like cursor/devin).
- `allowUnpriced` + `budgetWaiver`: BOTH are required to admit an unpriced
  (`source: "unknown"`) candidate. An unpriced candidate always ranks strictly
  last and cannot win over any priced candidate.
- `fallback`: a `(provider, model)` used ONLY when the eligible pool is empty;
  bypasses cost ranking but still passes eligibility and (unless `budgetWaiver`)
  the budget gate.

## Reading the result

Every routed response carries a `routing` block in `structuredContent.routing`,
and a one-line `[routing] chosen=... est=$... (basis, confidence) considered=N
reroutes=M` banner prepended to the text. Fields: `chosen`, `tier`,
`estCostUsd`, `costBasis` (`provider-reported | derived-from-tokens |
pre-flight-estimate`), `confidence`, `nearTie`, `estInputTokens`,
`estOutputTokens`, `priceAsOf`, `priceSource`, `consideredCount`,
`rejected: [{candidate, reason}]`, `reroutes`, and (on failure) `error`.

`estCostUsd` is always an ESTIMATE labelled with its inputs, never a billed cost.

## Failure semantics (fail closed)

- Over budget: `routing.error = "BudgetExceeded"`, `isError: true`. Raise
  `maxCostUsd` rather than expecting a silent downgrade.
- No eligible candidate: `routing.error = "NoEligibleCandidate"` with the
  per-candidate rejection reasons (auth / breaker / capacity / capability / tier
  / price / budget). Loosen `minTier`, add `candidates`, or set
  `allowUnpriced` + `budgetWaiver`.
- Transient dispatch failure (breaker trip, timeout): LCR re-selects over the
  remaining pool up to `[least_cost].max_reroutes`. Non-transient failures drop
  the candidate and continue.

## Observability (phase_2)

When routing is enabled, three read-only surfaces expose how it is behaving
(all economics-only, no prompts/secrets/principal):

- `routing://decisions` (MCP resource): the recent routed decisions, each with
  `provider`/`model`, `estCostUsd`, `costBasis`, `confidence`, `reason`,
  `considered`, `reroutes`, `at`.
- `routing://priors` (MCP resource): the learned per-`(provider,model)`
  output-token priors (median/p90/samples), the per-`(content-type,family)`
  input calibration `k` + sample count + confidence, and `priceAsOf`. Priors are
  anonymized model-level economics; `priors_scope` (`global | principal | off`)
  scopes the learning (or disables it).
- `llm_process_health` gains a `leastCost` block: per-provider telemetry tier
  (T1..T4) and per-candidate eligibility (priced? / authed? / breaker? / tier?).

API-provider models are priced from a published catalog (`prefer_catalog_price`
picks catalog over the CLI table when both resolve).

## Config (operator, `~/.llm-cli-gateway/config.toml`)

```toml
[least_cost]
enabled = true                 # nothing routes until this is true
min_tier = "standard"
max_cost_usd = 0.50
allow_unpriced = false
max_reroutes = 2

[least_cost.tiers]             # (provider:family) -> tier; ships with defaults
"claude:claude-opus" = "frontier"

[least_cost.candidates]
allow = []                     # empty = all eligible
deny = []
```

See `docs/least-cost-routing-contract.md` for the frozen decisions and
invariants.
