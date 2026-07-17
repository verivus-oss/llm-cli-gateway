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
`~/.llm-cli-gateway/config.toml` and Personal Agent Config Kit is disabled. If
the tools are absent, routing is off or Kit is active; use a specific provider
tool only when that tool is valid for the active boundary.

## Never use this for a mandatory exhaustive review

Least-cost routing is for a model-agnostic, cost-constrained task. It is not a
review-completion mechanism. Do not use `route_request`, `route_request_async`,
`select:"cheapest"`, `select:"cheapest_per_tier"`, `maxCostUsd`, a budget
waiver, or output/token caps to restrict a required cross-provider review. A
complete review must use the local stdio gateway MCP surface and its explicit
required reviewer roster until every reviewer returns an evidence-backed
unconditional approval. If a reviewer cannot run, repair/retry it or report the
review incomplete/blocked; do not replace it with the cheapest candidate.

When the user explicitly authorizes full provider permissions and native MCP
access for that mandatory review, use `multi-llm-review`'s full-access protocol:
build and launch the current target checkout's `node dist/index.js
--transport=stdio` server, not a global gateway; reapply each provider-native
grant per fresh job; provide the corrective-program report and exact diff/file
identity; and set no caller caps. A user-required 90-second progress cadence
also applies. Neither cost routing nor an LCR budget setting can implement or
shorten that protocol.

## When to use this vs a named provider tool

- Use `route_request` when the task is model-agnostic (summarize, answer,
  classify, rewrite) and you want the cheapest model that clears a quality floor.
- Use `claude_request` / `codex_request` / etc. when you need a SPECIFIC model or
  provider, a provider-specific flag, session resume, or a worktree. In phase_1
  `route_request` is fresh one-shot only: it accepts a registered `workspace`
  for CLI candidates, but no `sessionId` or `worktree`.
- Discover configured API and CLI candidates with `list_models()` and provider
  capabilities before forming an explicit candidate list. Do not assume a
  canonical CLI provider is installed, authenticated, priced, or eligible.

CLI candidates selected by `route_request` do not inherit the gateway process
repository. The unscoped execution boundary gives each child a fresh private
neutral cwd. For repository-dependent work, pass a registered `workspace` and
restrict `candidates` to CLI providers authorized for that workspace. A routed
HTTP/API provider does not receive workspace files, and `workspace` does not
turn it into a filesystem-capable provider. Use an explicitly targeted named
provider tool when the provider itself must be fixed.

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
- `workspace`: registered gateway workspace alias used as the cwd when the
  selected candidate is a CLI provider. It is not sent to HTTP/API providers.
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
- For synchronous routing, a transient dispatch failure can re-select over the
  remaining pool up to `[least_cost].max_reroutes`. Non-transient failures drop
  the candidate and continue. `route_request_async` makes one selection and
  does not perform reroutes after its job is admitted.

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
- `doctor --json` gains a `least_cost` block: pricing `asOf` + staleness,
  per-provider telemetry tier, per-candidate eligibility, untiered models, and
  per-`(content-type,family)` calibration quality (`k`/samples/confidence).

API-provider models are priced from a published catalog (`prefer_catalog_price`
picks catalog over the CLI table when both resolve).

## Cheapest-reviewer selection (phase_3)

`validate_with_models`, `red_team_review`, `consensus_check`, `second_opinion`,
and `ask_model` accept an OPT-IN `select: "cheapest" | "cheapest_per_tier"`. When
omitted, the explicit `models`/`model` list is used verbatim (default unchanged).
When set, the reviewer target list is filled via the LCR selector:
`cheapest` picks the single cheapest eligible provider; `cheapest_per_tier` picks
the cheapest provider in each quality tier (economy/standard/frontier). It fails
closed (no jobs started) when `[least_cost].enabled` is false or nothing is
eligible.

These opt-in selectors are appropriate only where the user deliberately wants a
cost-constrained sampling/review task. They are forbidden for a mandatory
complete review under this repository's no-limit review contract.

## Personal Agent Config Kit

`route_request`, `route_request_async`, validation tools, and least-cost
selection are not registered while Personal Agent Config Kit mode is enabled,
even if `[least_cost].enabled = true`. Kit is local-only, supports Claude/Codex
only, and requires durable
SQLite/PostgreSQL admission. Do not try to route around that boundary; either
use a normal non-Kit gateway only with the user's explicit approval of the
changed boundary, or report the requested routing unavailable.

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

`max_reroutes` limits only the router's transient dispatch retries for an
ordinary cost-routed request. It is never an approval/review-round limit.
