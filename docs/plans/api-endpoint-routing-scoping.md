# API-Endpoint Routing — Scoping Study

Status: DRAFT (scoping). Not in any release plan.
Date: 2026-06-15

Goal: route requests to direct model API endpoints — **local** (Ollama, vLLM,
LM Studio, llama.cpp) and **hosted** (OpenAI, Anthropic, xAI, Groq, OpenRouter,
…) — as first-class providers alongside the existing CLI providers, usable as
**reviewers** and **code generators**.

## Locked decisions (2026-06-15)

1. **Roles = reviewer + code generator, NOT applier.** API models emit text
   only — a review, or generated code / a patch. An existing **CLI** provider
   (claude/codex/…) applies the work in a worktree. ⇒ API providers never touch
   the filesystem, never get write access, never get a worktree. The agentic
   tool-execution loop is **out of scope**.
2. **OpenAI-compatible (`/v1/chat/completions`) is the primary adapter.** One
   adapter covers Ollama, vLLM, LM Studio, llama.cpp, OpenAI, Groq, Together,
   OpenRouter. Anthropic Messages and the existing xAI Responses adapters are
   secondary.
3. **Use `HttpJobRunner`** — real integration into `AsyncJobManager` (the draft's
   "hard slice"), not inline-only. Code generation can be slow / large, so async
   + durable jobs are wanted.
4. **All existing CLI providers stay** and are broadened. This is purely
   additive; no migration off CLIs.

## What already exists (do not re-scope)

- `src/xai-api-provider.ts` — full `node:https` HTTP client: `createXaiResponse()`,
  `isHttpTransient()`, 50MB cap, circuit breaker + `withRetry`, cost
  normalisation. The proof that HTTP routing clears the Socket/`fetch`-token audit.
- `src/config.ts:496-596` — `[providers.xai]` loader, https-or-loopback `base_url`
  rule (the loopback exception is what local models need), `isXaiProviderEnabled()`,
  failure-isolated from persistence config.
- `src/session-manager.ts:22-27` — `ProviderType = CliType | ApiProviderType`
  union; sessions already provider-agnostic.
- `src/provider-tool-capabilities.ts:24` — `ProviderKind = "cli" | "api"` is
  already a first-class concept; `grok_api` already modelled.
- `docs/plans/grok-api-provider-design.draft.md` v3 — sketches the `ApiProvider`
  interface and the 7 `HttpJobRunner` integration gaps. **We are now at the
  "provider #2" moment that draft deferred to.**

## Architecture constraints

- No generic Provider interface today — providers are `if (cli === "x")`
  conditionals across `prepare<X>Request` (index.ts), session-resume helpers
  (request-helpers.ts), and output parsers.
- `AsyncJobManager.startJob()` → `spawnCliProcess()` is **subprocess-only**
  (`async-job-manager.ts:438`). The `grok-api` path sidesteps it entirely via a
  parallel inline code path. HttpJobRunner replaces that sidestep with a real
  transport branch.
- Reviewer entry points (`validation-tools.ts:16`) gate on a frozen
  `z.enum(["claude","codex","gemini","grok","mistral"])`; orchestrator dispatch
  (`validation-orchestrator.ts:228` `buildProviderArgs`) is CLI-argv-only.
- `review-integrity.ts`, session-manager, MCP resources are provider-agnostic —
  free wins.

## Stateless-session design point (needs a call)

OpenAI-compatible and Anthropic endpoints are **stateless** — multi-turn means
resending the full message array. xAI uses server-side `previous_response_id`.
`CLAUDE.md` forbids storing conversation content in sessions.

**LOCKED (2026-06-15): single-shot for stateless API providers** (no
continuity) — reviewers and code generators are overwhelmingly one-shot. xAI
keeps `previous_response_id`. Revisit stored-history continuity only if a real
multi-turn API workflow appears.

## Slice plan

- **Slice 0 — `ApiProvider` interface + OpenAI-compatible adapter + generic
  config.** Extract `{ name, kind, baseUrl, buildRequest, parseResponse,
  isTransient, authHeader }` from `xai-api-provider.ts`. New adapter for
  `/v1/chat/completions`. Generalise config to `[providers.<name>]` with
  `kind = "openai-compatible" | "anthropic" | "xai-responses"`, `base_url`,
  `api_key_env`, `default_model`, model allowlist. Keep loopback `base_url`
  exception for local. Refactor xai onto the interface (proves genericity).
- **Slice 1 — `HttpJobRunner` (hard slice).** `AsyncJobManager` transport branch
  (process vs http); job-store migration adds `transport` + `http_status`
  columns; dedup key gets `transport` discriminator + payload-hash namespace;
  `cancelJob` via `AbortController.abort()`; orphan handling for http jobs with
  no abort handle; exit-code/`http_status` separation; flight-recorder breaker
  state + cost. (The 7 named gaps from the draft.)
- **Slice 2 — generic request tool(s).** Per-enabled-provider registration of
  `<provider>_request` (+ `_async`), gated like `isXaiProviderEnabled`. Sessions
  per Slice-0 stateless decision.
- **Slice 3 — reviewer wiring.** Derive `validation-tools.ts` provider enum from
  the live enabled set (CLI + enabled API); add API dispatch branch to
  `validation-orchestrator` so API providers appear in `validate_with_models`,
  `second_opinion`, `red_team_review`, `consensus_check`, `ask_model`,
  `synthesize_validation`. `review-integrity` applies automatically.
- **Slice 4 — code-generator role + apply handoff.** Output contract for
  generated code / unified-diff patches. The generate→apply pipeline is an
  **orchestration pattern** (API generates → CLI applies), documented per
  Pattern 3; minimal/no gateway primitive. API providers stay OUT of
  `workspace-registry.ts` (no worktree).
- **Slice 5 — discovery/catalog.** `list_models` / `list_available_models` /
  `resources.ts` include enabled API providers.
- **Slice 6 — test-veracity (mutation-probe) audit + cross-LLM review gate**
  (Codex + Gemini + Grok + Mistral, inspected evidence, per standing protocol).

## Risks

- Release audit: every adapter stays on `node:https` — no `fetch`/axios, or
  `grep -riE 'fetch' dist/` fails. grok-api already clears this.
- HttpJobRunner is the genuine risk: it mutates the durable job schema and the
  dedup/cancel/orphan paths shared with subprocess jobs. Migration + the 7 gaps
  need their own focused review.
- Local-model variance: OpenAI-compat servers differ (missing `usage`, no
  `tool_calls`, odd stop reasons). Adapter must degrade gracefully.
- A local model routed as a *security* reviewer may inherit refusal behaviour —
  validate before trusting (cf. Antigravity/Gemini refusals).
