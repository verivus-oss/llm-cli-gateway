# Provider cache surfaces (gateway → upstream)

**Last reviewed: 2026-06-13.** Anthropic's per-model threshold table below was
last fetched on 2026-05-26; re-verify that table before changing threshold
defaults because Anthropic has revised it across model generations.

Scope: what each upstream CLI exposes that the gateway can use to influence or
observe prompt caching. Distinguishes CLI-surfaced field names from the
underlying API field names — they diverge meaningfully for Codex.

## Summary matrix

| CLI     | Cache reporting (observed in CLI output)          | Gateway lever for influencing cache             | Notes                                                                  |
|---------|---------------------------------------------------|-------------------------------------------------|------------------------------------------------------------------------|
| claude  | `cache_read_input_tokens`, `cache_creation_input_tokens` (via JSON output) | Prefix discipline + `--exclude-dynamic-system-prompt-sections`; verified caller-content `cache_control` injection via `--input-format stream-json` for `promptParts` | Anthropic native caching. Per-model min-token thresholds (see table).  |
| codex   | `cached_input_tokens` (Codex CLI ≥ 0.133.0 emits this in `turn.completed.usage`); underlying OpenAI API uses `usage.prompt_tokens_details.cached_tokens` | Prefix discipline only (no CLI cache-control flag) | OpenAI implicit cache; CLI threshold is set server-side                |
| gemini  | Not surfaced in CLI output                        | Prefix discipline only                          | Implicit prefix caching server-side; explicit `cachedContents` only via SDK |
| grok    | Headless `-p`: none (verified 2026-06-13). ACP `agent stdio`: full per-request usage incl. cache reads (see below) | Prefix discipline + opt-in compaction controls | Gateway invokes the `-p` surface, which emits no usage. Compaction changes context shape; the ACP surface and the opt-in grok-api HTTP path both DO report cached-read tokens — see below. |
| mistral | Not surfaced in CLI output                        | Prefix discipline only                          | Vibe CLI does not surface cache stats                                  |

"Prefix discipline only" means: the gateway can improve cache hit rate by
ensuring the assembled prompt's stable prefix is byte-identical across calls,
but cannot directly mark a cache breakpoint or read back hit/miss telemetry
from CLI output.

## Anthropic — per-model minimum cacheable tokens

Source: <https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching>
(fetched 2026-05-26). Prompts shorter than the per-model minimum are NOT cached
even if `cache_control` is set; no error is returned.

| Model family / version              | Minimum cacheable tokens |
|-------------------------------------|--------------------------|
| Claude Mythos Preview               | 4,096                    |
| Claude Opus 4.7                     | 4,096                    |
| Claude Opus 4.6                     | 4,096                    |
| Claude Opus 4.5                     | 4,096                    |
| Claude Opus 4.1                     | 1,024                    |
| Claude Opus 4 (deprecated)          | 1,024                    |
| Claude Sonnet 4.6                   | 1,024                    |
| Claude Sonnet 4.5                   | 1,024                    |
| Claude Sonnet 4 (deprecated)        | 1,024                    |
| Claude Sonnet 3.5 (legacy)          | 1,024                    |
| Claude Opus 3 (legacy)              | 1,024                    |
| Claude Haiku 4.5                    | 4,096                    |
| Claude Haiku 3.5 (Vertex only)      | 2,048                    |

Gateway model-family alias defaults (used by
`[cache_awareness.min_stable_tokens_for_cache_control]`):

- `sonnet` → 1024 (covers 3.5, 4, 4.5, 4.6)
- `opus`   → 4096 (covers 4.5+, conservative for older Opus 4.x)
- `haiku`  → 4096 (covers Haiku 4.5; conservative for older Haiku 3.x)
- `default` → 4096 (conservative fallback for unknown family)

## Anthropic — observable hit fields

Response `usage` object exposes:

- `cache_creation_input_tokens` — tokens written to cache on this request
  (1.25× base for 5-min TTL, 2× base for 1-hour TTL).
- `cache_read_input_tokens` — tokens served from cache on this request
  (10% of base).
- `input_tokens` — fresh tokens after the last cache breakpoint.

Total input = `cache_read + cache_creation + input_tokens`.

1-hour cache TTL is GA (no beta header needed). Activated by setting
`cache_control.ttl = "1h"` on a cacheable block. Pricing differs (see above).

## Anthropic — gateway injection mechanism (claude CLI)

Three candidates evaluated for emitting explicit `cache_control` breakpoints
from the gateway:

(a) **stdin JSON via `--input-format stream-json`** — Verified for caller
`promptParts` content blocks in slice κ. The gateway sends `claude -p
--input-format stream-json --output-format stream-json
--include-partial-messages --verbose` and writes an `SDKUserMessage` whose
text blocks may include `cache_control: {type:"ephemeral", ttl:"1h"}`. The
live smoke test in `docs/plans/slice-kappa-captures/README.md` observed
`cache_read_input_tokens` rise from 12,928 to 28,439, `cache_creation_input_tokens`
fall from 15,523 to 12, and cost fall by roughly 82%, confirming Claude Code
forwarded the caller block marker to Anthropic.

(b) **`--system-prompt <path>` + appended user message** — Viable as a partial
mechanism. The system prompt is the natural cacheable boundary. Combined with
`--exclude-dynamic-system-prompt-sections`, this moves volatile per-machine
chunks out of the cached prefix without needing explicit cache_control. This
slice does NOT take this approach — see "Decision for slice 1" below for what
shipped. Branch A (or this option) is gated on a follow-up live smoke test.

(c) **Environment variable activation** — Claude Code documents several
prompt-caching env vars (per <https://code.claude.com/docs/en/env-vars>,
fetched 2026-05-26):

- `DISABLE_PROMPT_CACHING` — global kill switch.
- `DISABLE_PROMPT_CACHING_SONNET` / `DISABLE_PROMPT_CACHING_OPUS` /
  `DISABLE_PROMPT_CACHING_HAIKU` — per-model-family kill switches.
- `ENABLE_PROMPT_CACHING_1H` — opt into the 1-hour cache TTL (5-minute is
  the default).
- `ENABLE_PROMPT_CACHING_1H_BEDROCK` — Bedrock-specific 1-hour TTL opt-in
  (deprecated; `ENABLE_PROMPT_CACHING_1H` covers Bedrock too).
- `FORCE_PROMPT_CACHING_5M` — pin the 5-minute TTL even when the request
  body would otherwise select 1h.

The gateway does NOT inject any of these by default. Operators can set them
in their shell or via the gateway's launcher script if they want global
behaviour. The 1-hour TTL is also selectable per-block via
`cache_control.ttl="1h"` when caller code is constructing the API request
body directly.

**Decision history**: slice 1 shipped Branch B (prefix-discipline-only). Slice
κ subsequently verified and shipped Branch A for Claude caller content only:
explicit `promptParts.cacheControl` markers and opt-in automatic markers are
encoded in stream-json stdin. This does not give the gateway control over
Claude Code's hidden system prompt, tool schema array, session wrapper, or
other upstream request internals; those remain outside the normal CLI-wrapper
surface and would require a separate proxy/trust-model design.

`--exclude-dynamic-system-prompt-sections` is recommended in cache-aware mode
when no custom `--system-prompt` is set — it moves the per-machine sections
(cwd, env info, memory paths, git status) out of the cached system prefix into
the first user message, improving cache reuse across users/machines.

## Codex — field name divergence

- **Codex CLI emits**: `cached_input_tokens` (NOT `cache_read_input_tokens`) in
  its `turn.completed.usage` payload. Verified by live smoke test against
  Codex CLI 0.133.0 on 2026-05-26:
  ```
  echo "Reply with OK." | codex exec --json --skip-git-repo-check
  ...
  {"type":"turn.completed","usage":{"input_tokens":13420,"cached_input_tokens":4992,...}}
  ```
- **Underlying OpenAI API surfaces**: `usage.prompt_tokens_details.cached_tokens`
  (and no `cache_creation_*` field — OpenAI does not distinguish write from read
  in the way Anthropic does; only reads are counted).
- **Gateway parser**: `src/codex-json-parser.ts` accepts `cached_input_tokens`
  as the preferred source for the FR's `cache_read_tokens` column, falling
  back to the legacy `cache_read_input_tokens` and finally to a bare
  `cache_read_tokens` field. The dual-name compatibility means codex rows now
  populate `cache_read_tokens` on cache hits without depending on a Codex
  CLI version detection. Shipped in v1.7.0 (cache-awareness slice 1.5;
  see `docs/plans/async-flight-recorder.dag.toml`).

Practical consequence for slice 2 (v1.7.0+): both claude and codex rows
populate `cache_read_tokens` on cache hits. Gemini/grok/mistral still leave
the column NULL because the CLIs don't surface usage data. Slice 2
cache-stats queries continue to tolerate NULL/0 across the board for the
remaining three CLIs.

Gateway has no CLI flag to influence Codex's caching behaviour. Prefix
discipline (stable system+tools+context prefix, volatile task suffix) is the
only lever.

## Gemini, Grok, Mistral

Gemini's implicit prefix caching is server-side and not surfaced in CLI output.
Explicit `cachedContents` resources are available via the Vertex SDK but not
via the `gemini` CLI's `-p`/`--prompt` flow. Future cache-resource API work is
gated on this slice's data.

Grok has two distinct surfaces, and they differ. The gateway's `grok_request`
uses the **headless `-p` surface** (`prepareGrokRequest` builds
`["-p", <prompt>, … --output-format <plain|json|streaming-json>]`).

**Headless `-p`: no per-request usage.** Verified against the live Grok Build CLI
on 2026-06-13:

- `grok -p --output-format json "…"` → `{text, stopReason, sessionId, requestId,
  thought}`. No token fields.
- `grok -p --output-format streaming-json` → `{"type":"thought"|"text"}` deltas
  plus a terminal `{"type":"end", stopReason, sessionId, requestId}`. No usage
  event, even under multi-tool-call prompts.
- On disk (`~/.grok/sessions/<cwd>/<id>/`) `signals.json` carries a context-window
  gauge (`contextTokensUsed` / `contextWindowTokens`) — a session-cumulative
  figure, not a per-request input/output/cache breakdown.

Consequently `extractUsageAndCost("grok", …)`, which parses the `-p` stdout,
intentionally returns `{}` (no parser branch — see the documented comment in
`src/index.ts`), pinned by the falsifiable Eθ regressions in
`src/__tests__/test-veracity-regressions-slice-epsilon.test.ts`. grok-CLI
flight-recorder rows leave the cache columns NULL on the `-p` path rather than
inventing guessed field names.

**ACP `agent stdio`: full per-request usage, incl. cache reads.** The
`grok agent stdio` transport (JSON-RPC over stdio) DOES expose usage. A live ACP
`session/prompt` round-trip on 2026-06-13 returned, in the response
`result._meta`:

```json
{
  "stopReason": "end_turn",
  "_meta": {
    "sessionId": "019ec082-…", "requestId": "13f4812f-…", "promptId": "13f4812f-…",
    "modelId": "grok-composer-2.5-fast",
    "inputTokens": 11954, "outputTokens": 36,
    "cachedReadTokens": 7639, "reasoningTokens": 0, "totalTokens": 11990
  }
}
```

So grok-CLI telemetry is not impossible — it is gated on the **ACP transport
migration**. The Phase A/B ACP transport core (`src/acp/*`) is built and tested
in this repo, but it is not yet wired into the request handlers (no production
module imports the ACP client; `grok_request` still runs the `-p` executor), so
no provider is routed over ACP today. When grok is routed over ACP, extract usage
from this `_meta`:
`cachedReadTokens → cache_read_tokens`, `inputTokens`/`outputTokens` direct;
there is no cache-write field. `_meta.totalTokens` is the per-turn
input+output total — NOT the `signals.json` context-window gauge; do not use it
as a per-request input count. Until then the `-p` path stays usage-less.

### grok-api HTTP path (distinct from the CLI)

The opt-in `grok-api` provider (the xAI Responses adapter in `src/api-provider.ts`,
bucketed under cli `grok` per #42) calls the xAI Responses API directly and DOES surface usage. Its
`usage` object exposes `input_tokens`, `output_tokens`, `total_tokens`,
`input_tokens_details.cached_tokens` (cache **reads**), and `cost_in_usd_ticks`
(source: <https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing>,
fetched 2026-06-13). The provider already extracts `cacheReadTokens` from
`input_tokens_details.cached_tokens` / `prompt_tokens_details.cached_tokens` and
threads it to the flight recorder via `usageFromXaiResult` — never through
`extractUsageAndCost`. Cache hits are reachable because the gateway chains via
`previous_response_id` + `store:true`, a documented xAI sticky-routing mechanism.

There is **no `cache_creation` token to extract** for grok-api: the xAI Responses
usage object has no cache-write field. xAI prompt caching is automatic and cache
writes are unbilled and unreported — only the cache-**read** `cached_tokens`
appears (unlike Anthropic, which distinguishes `cache_creation_input_tokens` from
`cache_read_input_tokens`). This matches the OpenAI/Codex model documented above.

Mistral / vibe CLI: no cache reporting.

## Implications for slice 1 / 2 / 3

- **Slice 1** (prompt-parts discipline): ships for all 5 CLIs as a structural
  benefit (byte-identical stable prefix → higher implicit hit rate). The
  gateway assembles `system → tools → context → task` and passes the
  concatenation as the CLI's positional `-p` / prompt argument; the stable
  prefix bytes precede the volatile `task` tail unchanged across calls,
  which is enough for Anthropic's automatic-caching breakpoint to land on
  the same content hash across requests. The gateway does NOT emit explicit
  `cache_control` JSON in this slice and does NOT route promptParts.system
  into `--system-prompt`/`--append-system-prompt` — that injection
  mechanism (Branch A) is gated on a live smoke-test follow-up. Branch B
  here is "prefix discipline only".
- **Slice 2** (cache observability): reads `cache_read_tokens` /
  `cache_creation_tokens` from the flight recorder. From v1.7.0 onwards
  both **claude AND codex** rows populate `cache_read_tokens` on cache hits
  (the codex parser now accepts `cached_input_tokens` — see the "Codex —
  field name divergence" section above). For gemini/grok/mistral the
  columns remain NULL because those CLIs don't surface usage data.
  Aggregation queries must tolerate NULL without dividing by zero.
- **Slice 1.5** (v1.7.0): closes the async-path telemetry gap.
  `AsyncJobManager` now writes `logStart` (with `asyncJobId` set) and
  `logComplete` for `*_request_async` calls, AND covers the sync-deferred
  completion case where the sync handler returns a deferred response
  before the underlying job terminates. cache-state://* aggregates
  therefore include both sync and async row populations.
- **Slice 3** (TTL tracking): only meaningful for Claude (5min default, 1h
  optional). For other CLIs, `ttlRemainingMs` is null.
- **Slice κ** (Claude explicit `cache_control`): verified
  `promptParts.cacheControl` emission through Claude Code stream-json stdin.
  The gateway marks only non-empty stable `system` / `tools` / `context`
  blocks, never `task`, and uses `ttl:"1h"` on emitted blocks. The 1h TTL is
  forced because a failed smoke-test attempt showed Anthropic rejects a 5m
  caller block after Claude Code's own 1h-marked session-wrap content. The
  flight recorder records both `cache_control_blocks` and
  `cache_control_ttl_seconds` so cache-state TTL reporting is based on the row
  actually written, not only current config.

## Using the cache levers from the gateway (Grok compaction + Claude cacheControl)

The gateway exposes the provider levers directly so callers (and internal code) can direct cache behaviour where supported. These are **not** unified under one abstraction (per cross-LLM reviews: Claude's explicit breakpoint is semantically different from Grok's lossy context compaction). Use the provider-specific fields.

### Grok compaction (context management)
Available on `grok_request` / `grok_request_async`.

```ts
grok_request({
  promptParts: { system: "...", context: "...", task: "..." },
  compactionMode: "segments",     // summary | transcript | segments
  compactionDetail: "balanced",   // none | minimal | balanced | verbose (only for segments)
  // ...
})
```

Emitted: `--compaction-mode segments --compaction-detail balanced`

- `segments`: persists per-segment markdown (grep-friendly).
- Only useful on headless paths. Main `-p` path often has no usage telemetry; ACP / grok-api paths do.
- Not an explicit cache breakpoint; do not expect it to appear in `cache_read_tokens` on the CLI `-p` surface.

### Claude cacheControl (explicit Anthropic prefix cache)
Available on `claude_request` / `claude_request_async`. Requires `outputFormat: "stream-json"`.

```ts
claude_request({
  promptParts: {
    system: "You are ...",
    tools: "You can ...",
    context: "Full file dump here...",
    task: "Now refactor the auth module.",
    cacheControl: { system: true, context: true }  // task is never marked
  },
  outputFormat: "stream-json",
  // ...
})
```

Gateway emits:
- `["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--verbose", ...]`
- Stdin payload (one NDJSON line):

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"text","text":"You are ...","cache_control":{"type":"ephemeral","ttl":"1h"}},
  {"type":"text","text":"\n\nYou can ..."},
  {"type":"text","text":"\n\nFull file dump here...","cache_control":{"type":"ephemeral","ttl":"1h"}},
  {"type":"text","text":"\n\nNow refactor the auth module."}
]}}
```

`task` is never given `cache_control`. Empty parts with `true` are skipped (no-op warning).

Auto-emit (when `[cache_awareness].emit_anthropic_cache_control=true` and prefix >= per-model threshold) marks the rightmost stable block automatically.

See exact shape and tests in `src/prompt-parts.ts:135` (`assembleClaudeCacheBlocks`) and `src/__tests__/test-veracity-regressions-slice-kappa.test.ts`.

### Prefix discipline (all providers)
Use `promptParts` (without `cacheControl`) for byte-identical stable prefixes on any CLI. The gateway hashes the prefix and records it for `cache-state://prefix/{hash}` observability. This is the only reliable lever for Codex/Gemini/Mistral today.

```ts
claude_request({ promptParts: { system: S, context: C, task: T } })  // stable S+C
```

### Recommendations from cross-LLM review
- Keep levers provider-specific; do not force a single `CacheDirective` abstraction that conflates breakpoint vs. compaction.
- Measure reuse before auto-applying directives (write cost vs. read savings).
- Prefer docs + examples over new public surface until data shows demand.
- Grok compaction telemetry is currently weak on the primary CLI path.

For full observability use `cache-state://*` and `session_get(...).cacheState`.
