# Devin integration — scoping study

Status: DRAFT (scoping). Not in any release plan.
Date: 2026-06-16

Goal: evaluate adding **Devin** (Cognition's AI software engineer) to the
llm-cli-gateway as a provider, via two distinct surfaces Devin exposes — the
**Devin CLI** (`devin`, a local agentic coding CLI) and the **Devin API**
(`api.devin.ai/v3`, a cloud session/agent REST API).

The two surfaces map onto the gateway's two existing provider models — CLI
providers (claude/codex/gemini/grok/mistral) and API providers
(`[providers.<name>]`, the just-shipped API-endpoint routing) — but with very
different fit. This study recommends a sequencing and flags one locked-decision
conflict that needs the user's call before the API path can proceed.

## What Devin offers (verified 2026-06-16 against docs.devin.ai / cli.devin.ai)

- **Devin CLI** — local agentic coding CLI, Rust, multi-model. Headless surface
  `devin -p "<prompt>"` (print-and-exit), `--model`, `-c`/`--continue` and
  `-r/--resume <id>` (session continuity), `--permission-mode normal|dangerous|
  bypass`, `--prompt-file`, `--config`, `--export`. Subcommands incl.
  `devin auth`, `devin mcp …`, `devin list --format json`, `devin version`, and
  **`devin acp`** — runs Devin as an **Agent Client Protocol server over stdio**.
  Install via `curl -fsSL https://cli.devin.ai/install.sh | bash`.
- **Devin API (v3)** — REST. Base `https://api.devin.ai/v3/organizations/*`
  (+ `/v3/enterprise/*`). Bearer auth, `cog_`-prefixed Service-User keys (PATs in
  beta), RBAC. Core flow: `POST …/sessions {prompt, create_as_user_id?,
  devin_mode?}` → session runs async in a cloud VM → poll session → collect
  status / PR URL / output. NOT a chat-completions endpoint.

---

## Path A — Devin as a 6th CLI provider (`devin_request` + native ACP)

**Fit: clean.** Devin CLI behaves like the existing agentic CLIs (claude code /
codex / grok): a headless `-p` prompt surface, model selection, session
resume, permission modes, and a native ACP entrypoint. The work is widening the
**closed CLI set** — the exact inverse of Slice 0.5, which deliberately kept API
providers OUT of `LlmCli`/`CLI_TYPES`.

Touchpoints to add `"devin"` as a `CliType` (≈10 src files enumerate the five
today, plus the registries):
- `session-manager.ts` `CLI_TYPES` (the root literal; everything else derives).
- `model-registry.ts` — `CliInfo`/`getCliInfo` entry (models, default, aliases).
- `executor.ts` — `providerCommandName("devin")` → `devin`.
- `index.ts` — register `devin_request` / `devin_request_async`; a
  `prepareDevinRequest` argv builder (`devin -p <prompt>`, `--model`,
  `-r <id>`/`-c`, `--permission-mode`, `--prompt-file`); session-resume wiring
  (mirror grok's `--resume`/`--continue`).
- `provider-status.ts` / `health.ts` / `doctor.ts` — install + login probes
  (`devin version`, `devin auth status`).
- `cli-updater.ts` — `devin update` self-update path.
- `pricing.ts` / `cache-stats.ts` / `metrics.ts` — per-CLI buckets. Nuance:
  `metrics.ts` keys on the OPEN `ProviderType` (post-Slice-0.5) so it *tolerates*
  a new `"devin"` name without a code change, whereas `cache-stats.ts` has its own
  closed `CacheStatsCli` 5-CLI union that would need `"devin"` added. Either way
  Devin pricing is session/ACU-based, not per-token — likely an "unknown/not
  tracked" bucket rather than a real per-token mapping.
- `provider-tool-capabilities.ts` — `ProviderCapabilityId` gains `"devin"`;
  `TOOL_CONTROLS`/`ACP_CAPABILITIES`/`ACP_CONTRACT.providers` entries.
- `upstream-contracts.ts` — Devin CLI argv/subcommand contract for drift probes.
- `acp/provider-registry.ts` — **native ACP entry** for `devin acp` (status
  `native_candidate` → `native_smoke_passed` after a manual initialize +
  session/new smoke), entrypoint `{ command: "devin", args: ["acp"] }`. Note the
  ACP server reads `WINDSURF_API_KEY` or `devin auth login` creds.
- `workspace-registry.ts` — add `"devin"` to the default `providers` allowlist so
  Devin CLI sessions can run in a registered workspace/worktree (it IS an applier
  — see below — so a worktree is appropriate, unlike API providers).
- session-provider Postgres `CHECK` already admits any identifier-format name
  post-Slice-0.5, so no migration needed for the *session* row; but adding a CLI
  is about the `CliType` union, not the open api-string type.

Risk: broad but mechanical — follow the five-CLI pattern exactly. The main design
question is **session model**: Devin CLI `-r <id>` resumes a *local* session;
that maps to the gateway's existing session-resume contract. ACU/credit
accounting and the lack of per-token usage are the awkward parts for
metrics/pricing/cache-stats (likely "not tracked").

---

## Path B — Devin as an API provider (`devin-sessions` adapter)

**Fit: poor against the current `ApiProvider` model; needs a deliberate decision.**

Two hard mismatches with the just-shipped API-endpoint routing:

1. **Not single-shot, not request/response.** The `ApiProvider` interface is
   `buildBody(req) → postJson → parseResult(status, body) → { text, usage }` —
   one request, one synchronous text answer (the LOCKED "single-shot for stateless
   API providers" decision). Devin's API is a **long-running async agent session**:
   `POST sessions` → `session_id` → poll until terminal → collect a PR/diff. That
   is a *create + poll + collect* lifecycle, not a `postJson`. It cannot be an
   `openai-compatible`/`anthropic`/`xai-responses` adapter.
2. **Devin is an APPLIER.** The api-endpoint-routing scoping LOCKED: "Roles =
   reviewer + code generator, NOT applier … API providers never touch the
   filesystem, never get write access, never get a worktree." Devin's entire value
   is that it *applies* — it writes code and opens a PR. It does so in **its own
   cloud VM** (so it never touches the gateway's filesystem, which preserves the
   *gateway*-side invariant), but it is functionally an applier, which the current
   API-provider role model explicitly excluded.

Implications — pick one:
- **(B1) New `AgentSessionProvider` abstraction** distinct from `ApiProvider`: a
  `createSession → pollStatus → collectResult` lifecycle.
  **Precise on the HttpJobRunner fit (do not over-assume):** the Slice-1
  HttpJobRunner (`startHttpJob`/`finalizeHttpJob`) wraps a job around a
  **single** `runApiRequest` call — the job settles on that one HTTP
  response/error, `cancelJob` only `abort()`s that in-flight request, and the
  poll/orphan it offers are over the *job record* (the caller polls the gateway
  job; orphan-on-restart), NOT over a remote agent session. It has **no remote
  create→poll→collect loop**. So B1 reuses the HttpJobRunner's *durable-job
  scaffolding* (record/snapshot/dedup/cancel/orphan/flight-recorder) but must add
  a **new remote-session state machine** on top: an initial `POST sessions`, a
  repeated `GET session` poll until a terminal status, a `collect` step (PR
  URL/diff/output), and `cancel → terminate-session` (a real remote call, not
  just an abort). That is a meaningful new design (its own slice plan), not a
  drop-in adapter and not "mostly wiring".
- **(B2) Defer the API path.** Ship Path A (CLI) first; Devin-via-API is mostly
  redundant with Devin-via-CLI for local use, and the cloud-session value is
  already reachable from the CLI through `/handoff` and (insiders) `/cloud-attach`.
  Revisit B1 only if a headless/CI cloud-Devin workflow is actually needed.

Either way, B revisits the "no applier" locked decision — that is a **user call**,
not something to assume.

---

## Locked decisions needed (from the user)

1. **Scope:** Path A (CLI) only, or A then B (API)? (Recommendation: A first.)
2. **Applier role (gates B):** is an *applier* API provider (Devin opening PRs in
   its own VM) acceptable, or does the "reviewers/generators only" rule stand?
3. **Auth/keys:** Devin CLI uses `devin auth login` (OAuth) — same as the other
   CLIs (no gateway-managed key). The API needs a `cog_` Service-User key in the
   vault; only fetch if B is in scope.
4. **Pricing/metrics:** accept "not tracked" for Devin (session/ACU billing, no
   per-token usage) rather than forcing it into the per-token buckets.

## Recommended sequencing

- **Slice D0 — Devin CLI provider (`devin_request`/`_async`).** Widen `CliType`,
  argv builder, session resume, status/doctor/updater, capabilities. The bulk of
  the value, lowest risk, follows the existing five-CLI pattern.
- **Slice D1 — native ACP for `devin acp`.** Register in the ACP provider
  registry; manual initialize + session/new smoke; dormant runtime by default
  (matches the vibe/grok ACP rollout).
- **Slice D2 (optional, gated on decision #2) — `AgentSessionProvider` + Devin
  sessions API.** New create/poll/collect lifecycle over the HttpJobRunner. Its
  own scoping round.

## Risks

- Widening the closed `CliType` set re-touches ~10 subsystems (the thing Slice 0.5
  was designed to avoid for *API* providers — but a real 6th CLI legitimately
  belongs in the union). Mechanical, but every per-CLI surface must be updated in
  lockstep or `Record<CliType, …>` maps break.
- Devin's non-token billing doesn't fit the cache/pricing/metrics model.
- The API path's applier role + async-session shape is a genuine architecture
  decision, not a drop-in adapter.
- ACP: `devin acp` credential handling (`WINDSURF_API_KEY` vs stored creds) and
  protocol-version compatibility need a smoke test before any runtime pilot.
