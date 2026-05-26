# Cache-Aware Spawning: What Changed in llm-cli-gateway, a Week On

*Published 2026-05-26 by VerivusAI Labs*

If your multi-LLM workload sends the same long system prompt or file dump to Claude / Codex / Gemini ten times an hour, you are paying for the same input tokens ten times. Each provider has a cache for exactly this case, and each one expresses the cache differently. This post is about how llm-cli-gateway now uses those caches for you, across all five providers, without you having to re-implement the per-provider cache APIs yourself. I covered [the previous round of changes](https://dev.to/wernerk_au/whats-new-in-llm-cli-gateway-58b8) last week, and I closed that piece with a teaser, that Mistral Vibe was next on the list. A week later, Mistral is in, and a much larger change has landed alongside it, which is what most of this follow-up is about.

The new shape of the gateway: it now understands prompt caching as a first-class concern, across all five providers. That is `claude`, `codex`, `gemini`, `grok`, and `mistral` (Vibe). v1.6.0 shipped today and contains the lot.

**Short version:** every `*_request` and `*_request_async` tool now accepts a structured `promptParts` shape, the gateway concatenates the parts in a canonical order so the stable bytes precede the volatile tail unchanged across calls, three new `cache_state://` MCP resources expose hit-rate / hit-count / estimated-savings aggregates back to the orchestrating agent, `session_get` projects a compact `cacheState` view at read time, and a `cache_ttl_expiring_soon` warning fires on Claude resumes when the Anthropic cache breakpoint is within 30 seconds of expiry. All of it is opt-in (every flag defaults off in 1.x), all of it observes the per-provider cache mechanism rather than fighting it, and none of it adds conversation content to gateway storage.

**Long version** is below, organised the same way I organised last week's post, problem - what changed - what it now does, with the caveats named up front rather than buried.

## Mistral Vibe makes five (closing last week's loop)

Mistral shipped [Vibe](https://docs.mistral.ai/mistral-vibe/overview), their open-source CLI coding agent powered by Devstral 2. The gateway now wires `mistral_request` and `mistral_request_async` alongside the other four providers. Same shape as the rest, sessions through `--resume` / `--continue` (which requires `[session_logging] enabled = true` in `~/.vibe/config.toml`, the doctor surfaces this so you do not get an opaque failure), model registry entries, self-update via the `vibe` binary itself, the same circuit-breaker, approval-gate, flight recorder, metrics, dedup, and durable-job-store plumbing as the others.

The model alias resolution is slightly different. Vibe has no `--model` flag, so the gateway injects the resolved alias via `VIBE_ACTIVE_MODEL` instead. That is the only material divergence from the Claude / Codex / Gemini / Grok pattern, and it is documented inline at the call site.

Now five providers, five model families, five vendor lineages (Anthropic, OpenAI, Google, xAI, Mistral). What I noticed running parallel reviews these past few weeks is that the three OpenAI / Anthropic / Google adjacent triangle agreeing on something is not as informative as it looks, because the three model lineages share a lot of training data and a lot of post-training tendencies. I am not pretending this is statistics, it is just how I use these tools in review work, but adding an xAI voice and a Mistral voice means a five-way agreement is sampled from a meaningfully wider distribution than a three-way agreement, and a one-out-of-five dissent (especially from the vendor-outside-the-triangle) is a data point I read rather than a vote I discard.

## promptParts: structured prompts, prefix discipline, no API contortions

The change that took most of the engineering is `promptParts`. The shape is small:

```json
{
  "promptParts": {
    "system": "You are a careful reviewer of TypeScript diffs.",
    "tools":  "<long, stable description of the tools you can call>",
    "context": "<long, stable file dump or repo summary>",
    "task":    "What did the last patch change?"
  }
}
```

`prompt` and `promptParts` are mutually exclusive, you pass exactly one, the runtime check at the top of every handler returns the exact error message ``provide exactly one of `prompt` or `promptParts` `` if you pass both (the backticks belong to the error string itself; the messages are part of the public contract and the tests assert them verbatim). The gateway then concatenates the parts in canonical order, `system` → `tools` → `context` → `task`, with a stable separator, and hands the resulting string to the CLI's positional `-p` (or equivalent) argument. The stable prefix bytes precede the volatile `task` tail unchanged across calls, which is enough for each provider's automatic prompt-caching to land on the same content hash each time.

Two specific points worth naming.

First, this is **not** a request-body translation layer. The gateway does not construct Anthropic / OpenAI / Mistral JSON request bodies; it spawns the CLI binary the same way it always has. The "cache awareness" sits one layer above, in how the input string is composed before the CLI sees it. That keeps the architectural thesis intact (CLI wrapping, not API proxying) while still giving you cache hygiene for free.

Second, for Claude specifically, the gateway does not yet emit explicit `cache_control` JSON breakpoints. The Claude Code CLI documents `--exclude-dynamic-system-prompt-sections` and several `ENABLE_PROMPT_CACHING_*` / `DISABLE_PROMPT_CACHING_*` environment variables (all listed in [PROVIDER_CACHE_SURFACES.md](../personal-mcp/PROVIDER_CACHE_SURFACES.md) with citations to [the upstream env-vars page](https://code.claude.com/docs/en/env-vars)), but the path for injecting per-block `cache_control` markers via stream-json input is probable rather than verified. The `[cache_awareness].emit_anthropic_cache_control` flag is reserved in config for the follow-up slice that lands a live smoke test, so the present 1.6.0 release ships "Branch B" (prefix discipline only). That is honest about what works and what is gated on verification.

Third (because I said two and meant three), per-model minimum cacheable token thresholds matter. Anthropic Sonnet 3.5–4.6 caches at 1024 tokens minimum; Opus 4.5+ and Haiku 4.5 require 4096; Haiku 3.5 on Vertex needs 2048. The gateway has a `[cache_awareness.min_stable_tokens_for_cache_control]` per-family table populated from the [Anthropic prompt-caching docs](https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching) and surfaces the lookup via a `minStableTokensForModel(config, modelName)` helper. The in-code alias table is conservative (it collapses all Haiku variants to 4096 rather than exposing the Vertex-only 2048 distinction); a single-family override can be added when a workload needs it. Slice 1 does not yet act on this (we are not emitting cache_control), but the data is in place for the slice that will.

## cache_state://: observability without bleeding prompt text

The supporting piece, and frankly the one that makes the rest defensible, is the observability surface. Three new MCP resources sit alongside the existing `sessions://` and `models://` resources:

- **`cache_state://global`** - aggregates across the last 24h, with `total_requests`, `total_hits`, `hit_rate`, `total_cache_read_tokens`, `total_cache_creation_tokens`, `estimated_savings_usd` (best-effort, using a per-model pricing table dated `2026-05-26`), and a per-CLI breakdown.
- **`cache_state://session/{sessionId}`** - per-session aggregates, plus distinct prefix count and (for Claude only) the `ttlRemainingMs` derived from the configured Anthropic TTL policy.
- **`cache_state://prefix/{hash}`** - per-stable-prefix-hash aggregates, with a CLI x model breakdown so you can see which providers / models hashed to the same stable prefix.

The structural guarantee: none of these shapes have a `prompt` / `response` / `system` / `task` field. The session-storage invariant from the project's `CLAUDE.md` ("no conversation content in session storage") holds, and the new bits add only hash + token-count metadata to the existing flight recorder (which already stored prompts and responses for audit, separate from the session manager). I would not have shipped the observability surface without that constraint, frankly.

The `session_get` tool now includes a compact `cacheState` block when the session has prior requests, with `cli`, `prefixDistinct`, `totalCacheReadTokens`, `totalCacheCreationTokens`, `requestCount`, `hitCount`, `hitRate`, `estimatedSavingsUsd`, and `ttlRemainingMs`. The field is **omitted entirely** for fresh sessions (not null, not empty object), keeping the payload compact when there is nothing to report.

## cache_ttl_expiring_soon: warning, not error

Slice 3 is the bit that uses the observability data for actionable warnings. When `claude_request` (or `claude_request_async`) is invoked with a `sessionId`, and `[cache_awareness].warn_on_ttl_expiry = true`, and the prior session row's `lastRequestAt` is within 30 seconds of Anthropic's documented TTL (5 minutes by default, 1 hour when `[cache_awareness].anthropic_ttl_seconds = 3600`), the response payload carries a structured warning:

```json
{
  "warnings": [{
    "code": "cache_ttl_expiring_soon",
    "ttlRemainingMs": 12000,
    "message": "Anthropic cache breakpoint for session ... expires in 12000ms (< 30000ms). Subsequent requests may miss the cache."
  }]
}
```

It is a warning, not a hard error. The request still runs. The flag defaults to false in 1.x; flip it on once you have observed your traffic for a few days. Two caveats. First, `ttlRemainingMs` is best-effort, computed locally from our flight recorder's `lastRequestAt` rather than from Anthropic's actual cache state, so a cache eviction inside Anthropic's window will not be visible to us, the warning may be optimistic. Second, it only fires for Claude. For the other four CLIs, we do not observe the provider's cache state (or, in some cases, the provider does not expose one at all), so the warning would be a guess.

The Codex CLI, however, deserves a specific note. As of 0.133.0, Codex emits `cached_input_tokens` in its `turn.completed.usage` payload, verified by a live smoke test on 2026-05-26 (the test invocation, the raw JSONL response, and the field-name divergence from the Anthropic-style `cache_read_input_tokens` are all captured in [`docs/personal-mcp/PROVIDER_CACHE_SURFACES.md`](../personal-mcp/PROVIDER_CACHE_SURFACES.md) under the "Codex field name divergence" section). The gateway's `src/codex-json-parser.ts` was originally written against the Anthropic-style name, so under v1.6.0 the `cache_read_tokens` column stays null for Codex rows. A follow-up parser fix is landing as v1.7.0 (see the slice 1.5 update below) — the parser then prefers `cached_input_tokens` with the legacy names retained as fallbacks, so codex cache hits will populate the column on every gateway version from 1.7.0 onwards.

## The plumbing layer (which is not a feature, but is a habit change)

v1.6.0 also brings a much larger contributor-facing change that does not show up in any tool surface, but is worth naming. The gateway now ships with the same security and validation posture as our [agent-assurance](https://github.com/verivus-oss/agent-assurance) spec repository. A new `.github/workflows/security.yml` runs actionlint, zizmor, shellcheck, typos, osv-scanner, gitleaks, ruff, bandit, and lychee on every push and pull request; `eslint-plugin-security` is wired into the existing eslint config and runs as part of the standard CI lint step. All third-party actions are SHA-pinned; the Python and Go tools are version-pinned (`zizmor==1.25.2`, `ruff==0.14.5`, `bandit==1.9.4`, `actionlint@v1.7.12`); the gitleaks binary is downloaded and SHA256-verified before execution. Workflows now use least-privilege permissions, defaulting to `contents: read` and escalating only on the publish jobs that need OIDC for npm provenance / PyPI trusted publishing or `gh release upload`; every `actions/checkout` sets `persist-credentials: false` except the single job that needs the token for the release upload; the `release-installer.yml` top-level write was narrowed to that one job. Dependabot expanded from github-actions only to also cover npm and pip, with non-security npm bumps grouped so security updates never get delayed behind a batch.

In flight, osv-scanner flagged 26 Go stdlib CVEs in `installer/go.mod` (pinned to Go 1.22, when the fixes were in 1.23–1.25.x); that has been bumped to 1.25 in lock-step with the `release-installer.yml` setup-go pin, and re-verified clean. Two test fixtures and one `npmjs.com` URL needed allowlisting (a deliberate fake bearer token, an npmjs page that Cloudflare bot-protects, and a similar OpenAI help-centre page), each annotated with the specific reason. There are no real findings outstanding.

This is not the kind of work that ships in a marketing line. It is the work that means the next contributor (or me, six months from now) does not accidentally land a workflow with `contents: write` and a published-to-cache `setup-node` step on a release-triggered workflow, which is precisely the kind of supply-chain footgun the [Solorigate](https://en.wikipedia.org/wiki/SolarWinds), [Codecov](https://about.codecov.io/security-update/), and [xz](https://en.wikipedia.org/wiki/XZ_Utils_backdoor) class of incidents has trained the industry to take seriously. It is the work that means a Dependabot PR with a real CVE fix gets reviewed against an automated gate, not a human's best guess. It is the work that makes claims about supply-chain hygiene auditable rather than aspirational.

## Where you can call it from

The cache-awareness story above frames the gateway as something `claude-code` or `codex` spawns when an MCP request lands, but that is only one of three inbound surfaces, and it is worth being explicit about the other two because they are how a lot of people actually use the gateway day to day. The gateway is itself an MCP server, so anything that speaks MCP can reach it, and the cache-awareness, observability, and TTL warnings described above apply identically regardless of which surface called in.

- **stdio MCP from another CLI** (the path most of the post has been describing). `claude-code`, `codex`, `gemini`, `grok`, and `vibe` each have their own MCP config (`~/.claude.json`, `~/.codex/config.toml`, `~/.gemini/settings.json`, and so on); the gateway gets a single entry that wires `llm-cli-gateway` as the command, and the inbound CLI then sees all of `claude_request` / `codex_request` / `gemini_request` / `grok_request` / `mistral_request` plus the session and `cache_state://` resources as if they were its own tools.
- **Claude Desktop** through either the local stdio MCP path (same shape as the CLI case, just installed via Claude Desktop's MCP configuration UI) or, where available, the remote MCP connector path against the gateway's HTTP transport. Per-platform setup snippets live in [`setup/providers/claude-desktop.md`](../../setup/providers/claude-desktop.md); the doctor's `client_config.claude_desktop_config_present` field tells the install agent which path applies.
- **ChatGPT custom connectors / developer mode** against the gateway's HTTP transport behind a public HTTPS URL. The gateway ships `llm-cli-gateway tunnel start` and `llm-cli-gateway chatgpt-url` for the connector wiring; the doctor's `endpoint_exposure.web_clients_supported` field is the gating boolean. The wrinkle worth knowing about is that ChatGPT requires `Authentication: No Authentication` on the connector path, so the gateway's `LLM_GATEWAY_NO_AUTH_PATHS` env var carves out exactly that path while keeping `/mcp` bearer-token-gated. The walk-through is in [`setup/providers/chatgpt.md`](../../setup/providers/chatgpt.md).

`llm-cli-gateway doctor --json` is the authoritative source for which of these surfaces are wired today, and the install-agent contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) is the canonical walk-through, with per-target snippets under [`setup/providers/`](../../setup/providers/). If you want to try the cache-aware flow from inside ChatGPT's developer-mode connector or from Claude Desktop without first installing five upstream CLIs, the stdio MCP path needs only `node` + the gateway binary and an upstream CLI of your choice; the other four providers go in as and when you add them.

## What this changes about the original argument

Nothing, again. The thesis from [the original piece](./blog-cli-vs-api.md) was that CLI wrapping gives you capabilities (real file access, real test execution, real session state) that API proxying cannot reach without re-implementing each provider's tool surface. Cache hygiene now joins that list. Each provider's CLI is the right surface to ask "what does this cost?", because each provider's CLI is the only surface that returns telemetry the same way the operator's billing console returns it. The gateway's job is to compose the stable bytes before the volatile bytes so the cache lands on the same content hash, then to read back the resulting `cache_read_input_tokens` (or `cached_input_tokens`, depending on the CLI version) from the flight recorder and surface it as an MCP resource the orchestrating agent can act on.

What an API-proxy approach would have to do for the same outcome: construct provider-specific request bodies with per-block `cache_control` markers, then handle the per-provider divergence in cache field names (`cache_read_input_tokens` for Anthropic, `prompt_tokens_details.cached_tokens` for OpenAI, `usageMetadata.cachedContentTokenCount` for Gemini), then handle the per-provider divergence in TTL policy (5min/1h for Anthropic, implicit-only for OpenAI, separate `cachedContents` SDK for Gemini), and own the resulting compatibility surface forever. We instead let each CLI own its own provider integration and stand back, sampling the telemetry as it comes out.

If you are evaluating llm-cli-gateway against an API proxy and your workload is heavy on long stable context (file dumps, repo summaries, large system prompts), the question to ask now is not just "does this give me cache hits?", it is "does this give me cache hits I can measure, without me having to re-implement per-provider cache APIs?". That seemed worth writing down.

## What's next

The Branch A live smoke test for explicit Claude `cache_control` injection via `--input-format stream-json`. And, once we have 24h of dogfooding data from `cache_state://global`, the cache-aware multi-LLM routing slice, which is the actual end goal: route a request to the provider whose session has the warmest cache for the requested prefix, rather than the round-robin default.

### Update — slice 1.5 landing as v1.7.0

The Codex parser fix and the async-path flight-recorder integration both ship together as v1.7.0. The parser now accepts `cached_input_tokens` (the field the current Codex CLI actually emits) alongside the legacy Anthropic-style names, so cache hits on codex rows finally populate `cache_read_tokens` in the flight recorder. `AsyncJobManager` writes `logStart` (with `asyncJobId` set) and `logComplete` for `*_request_async` calls, and also takes over the `logComplete` write when a sync request defers — so `cache_state://*` aggregates now include both sync and async-tool activity. No new opt-in flags, no schema migration; the behaviour kicks in for new rows on the next gateway restart after v1.7.0 install. The fuller story is in `docs/plans/async-flight-recorder.dag.toml` and `docs/personal-mcp/ASYNC_FLIGHT_RECORDER_SURFACES.md` in the repo.

v1.6.0 is the original feature release described above; a docs-only follow-up v1.6.1 went out the same day with the install-agent guidance for Mistral and the post-release doc audit fixes (no source changes). v1.7.0 is the telemetry-completeness follow-up. Once published, v1.7.0 will appear on [npm](https://npmjs.com/package/llm-cli-gateway) (with sigstore provenance via the OIDC publish path) and [PyPI](https://pypi.org/project/llm-cli-gateway/), and the [GitHub release at v1.7.0](https://github.com/verivus-oss/llm-cli-gateway/releases/tag/v1.7.0) will carry SHA256-verifiable installer artefacts for macOS / Linux / Windows.

Thanks for reading this far. As always, MIT licensed.

---

*llm-cli-gateway is MIT licensed. npm: `llm-cli-gateway` | GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)*
