# Provider cache surfaces (gateway → upstream)

**Last reviewed: 2026-05-26.** Re-verify the per-model Anthropic threshold table
before any release that ships cache_control emission — Anthropic has revised
these thresholds across model generations and the table moves.

Scope: what each upstream CLI exposes that the gateway can use to influence or
observe prompt caching. Distinguishes CLI-surfaced field names from the
underlying API field names — they diverge meaningfully for Codex.

## Summary matrix

| CLI     | Cache reporting (observed in CLI output)          | Gateway lever for influencing cache             | Notes                                                                  |
|---------|---------------------------------------------------|-------------------------------------------------|------------------------------------------------------------------------|
| claude  | `cache_read_input_tokens`, `cache_creation_input_tokens` (via JSON output) | Prefix discipline + `--exclude-dynamic-system-prompt-sections`; `cache_control` injection via stream-json is **probable but unverified** | Anthropic native caching. Per-model min-token thresholds (see table).  |
| codex   | `cached_input_tokens` (Codex CLI ≥ 0.133.0 emits this in `turn.completed.usage`); underlying OpenAI API uses `usage.prompt_tokens_details.cached_tokens` | Prefix discipline only (no CLI cache-control flag) | OpenAI implicit cache; CLI threshold is set server-side                |
| gemini  | Not surfaced in CLI output                        | Prefix discipline only                          | Implicit prefix caching server-side; explicit `cachedContents` only via SDK |
| grok    | Not surfaced in CLI output                        | Prefix discipline only                          | xAI caching, if any, is opaque to the CLI                              |
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

(a) **stdin JSON via `--input-format stream-json`** — Probably viable but
unverified. The stream-json `SDKUserMessage` shape accepts a `content` array
of typed blocks (text, image), which on the underlying Anthropic Messages API
support a per-block `cache_control` field. The CLI documentation does not
explicitly confirm `cache_control` passes through unchanged. Verifying requires
a live smoke test against the Anthropic API with an account that has caching
enabled.

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

**Decision for slice 1**: ship Branch B (prefix-discipline-only). The gateway
concatenates `system → tools → context → task` and passes the result as the
single positional prompt to `claude -p`. The stable prefix bytes precede the
volatile `task` tail unchanged across calls, so Anthropic's automatic-caching
breakpoint lands on the same content hash each time. The gateway does NOT
emit explicit `cache_control` JSON and does NOT route `promptParts.system`
into `--system-prompt`/`--append-system-prompt` in this slice — the
injection mechanism is unverified and is gated on a follow-up live smoke
test against the Anthropic API. The
`[cache_awareness].emit_anthropic_cache_control` flag stays in config for
that future slice.

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
- **Gateway parser today**: `src/codex-json-parser.ts:69-77` reads
  `cache_read_input_tokens` / `cache_creation_input_tokens` (Anthropic-style),
  which the current Codex CLI does NOT emit. The codex parser's
  `cache_read_tokens` column is therefore NULL for current codex output until
  the parser is updated to also accept `cached_input_tokens`. **Out of scope
  for this slice** — fixing the codex parser is a separate follow-up
  (`docs/plans/codex-parser-cache-tokens.dag.toml`, TBD).

Practical consequence for slice 1: claude is the only CLI whose
`cache_read_tokens` column actually gets populated by current parsers. Slice 2
cache-stats queries therefore tolerate NULL/0 across the board and the per-CLI
breakdown will show claude-only data until the codex parser is fixed.

Gateway has no CLI flag to influence Codex's caching behaviour. Prefix
discipline (stable system+tools+context prefix, volatile task suffix) is the
only lever.

Gateway has no CLI flag to influence Codex's caching behaviour. Prefix
discipline (stable system+tools+context prefix, volatile task suffix) is the
only lever.

## Gemini, Grok, Mistral

Gemini's implicit prefix caching is server-side and not surfaced in CLI output.
Explicit `cachedContents` resources are available via the Vertex SDK but not
via the `gemini` CLI's `-p`/`--prompt` flow. Future cache-resource API work is
gated on this slice's data.

Grok CLI: no `cache_*` field appears in its stream-json output as of `grok` v
shipped at writing. Implicit caching, if any, is opaque.

Mistral / vibe CLI: same. No cache reporting.

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
  `cache_creation_tokens` from the flight recorder. Populated for **claude
  only** today — the Codex parser still looks for `cache_read_input_tokens`
  rather than the actual `cached_input_tokens` Codex CLI emits, so
  cache_read_tokens stays NULL for codex rows until that parser is updated
  (separate follow-up — see the "Codex — field name divergence" section
  above). For gemini/grok/mistral the columns are also NULL/0. Aggregation
  queries must tolerate NULL without dividing by zero.
- **Slice 3** (TTL tracking): only meaningful for Claude (5min default, 1h
  optional). For other CLIs, `ttlRemainingMs` is null.
