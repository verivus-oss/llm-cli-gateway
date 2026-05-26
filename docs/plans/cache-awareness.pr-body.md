# Cache-awareness — phase 1 (slices 1+2+3)

## Scope

Make the gateway operate intelligently inside each provider's native prompt-caching mechanism, **without** adding any new conversation content to gateway storage. Preserves the "No conversation content in session storage" invariant defined in `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` and reinforced in `BEST_PRACTICES.md`.

Three slices shipped together so cache observability data (slice 2) is in place when the prompt-discipline change (slice 1) goes live:

- **Slice 1** — prompt-parts discipline across all 5 CLIs (claude, codex, gemini, grok, mistral; sync + async = 10 tools).
- **Slice 2** — cache observability MCP resources, session_get cacheState projection, doctor cache_awareness block.
- **Slice 3** — Anthropic TTL tracking + `cache_ttl_expiring_soon` warning on resume.

## Files touched

(`git diff --stat 039f6fb..feat/cache-awareness-phase-1`)

- [x] `src/index.ts` — Zod tool schemas updated for every `*_request` and `*_request_async` (10 tools).
- [x] `src/index.ts` — runtime mutex check at top of every `*_request` / `*_request_async` handler (10 total). NOT Zod `.refine()` — the SDK rejects top-level refines. Uses `resolvePromptOrPartsForPrep()` which returns `createErrorResponse(...)` with the dag-mandated strings.
- [x] `src/index.ts` — `prepare*Request` functions (Claude, Codex, Gemini, Grok, Mistral) call `resolvePromptInput()`.
- [x] `src/index.ts` — `safeFlightStart` call sites thread `stablePrefixHash` + `stablePrefixTokens` and use `prep.effectivePrompt`. SYNC path only (async-path FR integration is out of scope per dag step 7 point 5).
- [x] `src/index.ts` — new MCP resource registrations (`server.registerResource`, with `ResourceTemplate` for templated URIs) for `cache_state://global`, `cache_state://session/{id}`, `cache_state://prefix/{hash}`.
- [x] `src/index.ts` — `session_get` handler returns `cacheState` when the session has prior requests (omitted entirely for fresh sessions).
- [x] `src/index.ts` — `claude_request` / `claude_request_async` emit a `warnings[]` entry when TTL < 30s and `[cache_awareness].warn_on_ttl_expiry = true`. Session resolution moved BEFORE `safeFlightStart` so the warning reads PRIOR rows, not the just-inserted row.
- [x] `src/prompt-parts.ts` — NEW. Pure `assemble()` + `resolvePromptInput()`.
- [x] `src/request-helpers.ts` — UNCHANGED for promptParts wiring. Only Mistral-specific Prepare* types live here; the core `prepare*Request` functions are in `src/index.ts`.
- [x] `src/async-job-manager.ts` — UNCHANGED. Async-path flight-recorder integration is out of scope.
- [x] `src/flight-recorder.ts` — migration v3 (stable_prefix_hash, stable_prefix_tokens, index) + FlightLogStart extension + read-only `queryRequests()` with `stmt.readonly` guard.
- [x] `src/resources.ts` — `ResourceProvider` constructor + cache_state read methods. Slice 3 also threads `CacheAwarenessConfig` so `ttlRemainingMs` is populated on `cache_state://session/{id}`.
- [x] `src/config.ts` — `CacheAwarenessSchema` + `loadCacheAwarenessConfig` + `minStableTokensForModel` + threaded through `GatewayServerRuntime`.
- [x] `src/doctor.ts` — `DoctorReport` extended with required `cache_awareness` block (always present, zeroed when deps absent). `printDoctorJson` lazy-loads config + flight recorder best-effort.
- [x] `setup/status.schema.json` — `cache_awareness` added to root `required` with nested schema (each sub-block `additionalProperties:false`; root unchanged).
- [x] `src/__tests__/doctor.test.ts` — 3 new cache_awareness shape tests (empty, both flags on, both flags off).
- [x] `src/pricing.ts` — NEW. Per-model pricing with `PRICING_AS_OF` date; unknown models return ZERO (codex-r1 F1 fix).
- [x] `src/cache-stats.ts` — NEW. `computeSession/Prefix/GlobalCacheStats` + `computeTtlRemaining` + `TtlPolicy`.
- [x] `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` — research output with per-model Anthropic threshold table, Claude env-vars list, Codex CLI `cached_input_tokens` field-name divergence, Branch B decision.
- [x] `README.md` — "Cache-aware operation" section + per-CLI capability matrix.
- [x] `BEST_PRACTICES.md` — "Cache hygiene" section + Session State Design call-out re: hash-only flight recorder + read-time cacheState projection. "No conversation content in state" rule UNCHANGED.
- [x] `CHANGELOG.md` — unreleased "feat/cache-awareness-phase-1" entry covers slice 1+2+3 + config block + every opt-in flag + the intentionally-deferred items.
- [x] `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` — UNCHANGED.

## Test count delta

| Snapshot              | Total tests |
|-----------------------|-------------|
| Base (pre-slice 1)    | 606         |
| After foundation r1+2 | 633         |
| After slice 1         | 633         |
| After slice 2         | 652         |
| After slice 3 r1+r2   | 681         |
| **Delta**             | **+75**     |

No existing test was modified to make a failing test pass — added new tests for new behaviour throughout. Verified by reviewing each commit's diff for `__tests__/` changes.

## Opt-in flag matrix

All flags live under `[cache_awareness]` in `~/.llm-cli-gateway/config.toml`. **All default OFF.** No env-var overrides.

| Flag                                                                | Default | What it does                                                                                  |
|---------------------------------------------------------------------|---------|-----------------------------------------------------------------------------------------------|
| `emit_anthropic_cache_control`                                      | `false` | Reserved for a future slice (Branch A live-smoke-test follow-up). NOT active in this slice.   |
| `anthropic_ttl_seconds`                                             | `300`   | Enum `300 | 3600`. Drives `computeTtlRemaining` and the TTL warning's expiry window.         |
| `warn_on_ttl_expiry`                                                | `false` | When true, claude_request[_async] attach a `cache_ttl_expiring_soon` warning if TTL < 30s.    |
| `[cache_awareness.min_stable_tokens_for_cache_control]` per-family  | sonnet=1024, opus=4096, haiku=4096, default=4096 | Per-model min-token thresholds for the future cache_control emission. Sourced from PROVIDER_CACHE_SURFACES.md. |

## Per-CLI cache_control emission table

| CLI     | Prefix discipline (via `promptParts`) | Explicit `cache_control` emission |
|---------|---------------------------------------|------------------------------------|
| claude  | yes                                   | not yet (Branch B; gated on `[cache_awareness].emit_anthropic_cache_control` for a future slice) |
| codex   | yes                                   | n/a (OpenAI implicit cache, no CLI lever) |
| gemini  | yes                                   | n/a (implicit prefix cache server-side) |
| grok    | yes                                   | n/a (no surfaced cache lever) |
| mistral | yes                                   | n/a (no surfaced cache lever) |

## Intentionally NOT shipped

- **Slice 4** (cache-aware multi-LLM routing) — gated on this slice's observability data.
- **Slice 5** (explicit cache-resource APIs — Gemini Context Caching, Anthropic 1h beta) — gated on this slice's observability data.
- **Claude `cache_control` JSON injection** (Branch A): the `claude -p` injection mechanism is unverified. A future slice will land a live smoke test against the Anthropic API and flip Branch A on when verified.
- **Async-path `stable_prefix_hash` recording**: `src/async-job-manager.ts` has zero flight-recorder integration today. The v3 columns are NOT populated for async-job rows. Tracked separately (`docs/plans/async-flight-recorder.dag.toml`, TBD).
- **Codex parser cache-tokens fix**: `src/codex-json-parser.ts` reads Anthropic-style `cache_read_input_tokens` but Codex CLI 0.133.0+ emits `cached_input_tokens`. `cache_read_tokens` therefore stays NULL for codex rows today. Separate follow-up.

## Invariant statement

"No conversation content in session storage" holds. The session manager (`~/.llm-cli-gateway/sessions.json`) is UNTOUCHED by this slice. The new columns added by migration v3 (`stable_prefix_hash`, `stable_prefix_tokens`) live on the existing flight recorder (`~/.llm-cli-gateway/logs.db`), which is a separate audit-focused store that already records prompts/responses for diagnostics (and is not subject to the session-storage invariant). `session_get.cacheState` is a READ-TIME projection from the flight recorder, NOT a field on the Session interface.

## Verifying the project-root CLAUDE.md is unchanged

The file at `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` lives **outside** the gateway git repo (which begins at `…/rvwr/llm-cli-gateway`). It is not under version control via this repo's history, so `git diff master..feat/cache-awareness-phase-1 -- ../CLAUDE.md` cannot resolve it. Reviewers should verify the file is unchanged by:

- `cat /srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` and confirming the "Session State Design" section still contains the "No conversation content in session storage" rule unchanged.
- Or `git status` in the parent workspace's VCS (if one exists outside the gateway repo's scope).

This branch has touched no file outside `…/rvwr/llm-cli-gateway/`.

## Multi-LLM review log

Each slice was reviewed by Codex, Gemini, Grok, and Mistral concurrently in independent rounds. Findings were addressed per-round and re-verified.

| Unit             | Round | Codex             | Gemini  | Grok    | Mistral | Resolution                                        |
|------------------|-------|-------------------|---------|---------|---------|---------------------------------------------------|
| Foundation       | r1    | request_changes (F1-F4) | approve | approve | approve | Docs, queryRequests safety, session_get wiring fixed in c9dd187 |
| Foundation       | r2    | request_changes (docs)  | approve | (skipped) | (skipped) | Docs fix in 7cb0f2f                              |
| Slice 1          | r1    | request_changes (Branch B docs) | approve | approve | approve | Docs fix in 7cb0f2f                       |
| Slice 2          | r1    | request_changes (pricing fallback) | approve | approve | approve | pricing.ts ZERO fallback in 13a702f             |
| Slice 3          | r1    | request_changes (sync TTL + ttl surface) | approve | request_changes (B1+B2+B3) | approve | All fixed in b7456b5 |
| Cross-cutting    | r1    | (running)         | (running) | (running) | (running) | —                                              |

## Rollback

Every behavioural change is gated behind an opt-in flag in `[cache_awareness]`, all default false. Three options:

1. **Soft rollback**: set all `[cache_awareness]` flags to false. Gateway reverts to current behaviour. Flight-recorder columns stay populated (harmless).
2. **Hard rollback**: revert the feature branch. Migration v3 columns remain on existing `logs.db` files but are NULL for new rows — non-destructive, no re-migration needed.
3. **Config corruption**: delete the `[cache_awareness]` block from config.toml; defaults apply (everything off).

Do NOT roll back by dropping the v3 columns — SQLite ALTER TABLE DROP COLUMN exists but rewrites the table internally and is unsafe on a live WAL DB with concurrent readers.

## Acceptance gate

`cache_state://global` returns non-zero `total_hits` within 24h of dogfooding. The block ships dormant; operators flip `warn_on_ttl_expiry = true` and observe behaviour over a few days before any production rollout decision.
