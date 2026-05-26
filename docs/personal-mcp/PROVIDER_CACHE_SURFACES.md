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
| codex   | `cache_read_input_tokens`, `cache_creation_input_tokens` (Anthropic-style names emitted by Codex CLI; underlying OpenAI API uses `usage.prompt_tokens_details.cached_tokens`) | Prefix discipline only (no CLI cache-control flag) | OpenAI implicit cache; CLI threshold is set server-side                |
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
chunks out of the cached prefix without needing explicit cache_control. The
slice 1 wiring (system part → `--system-prompt`, task → final user message)
gives prefix-discipline benefits without needing JSON injection.

(c) **Environment variable activation** — No documented `ENABLE_PROMPT_CACHING_*`
env var in Claude Code (it's enabled by default at the provider level when
`cache_control` is present). The 1-hour TTL is selected per-block via
`cache_control.ttl="1h"`, not via env var.

**Decision for slice 1**: ship Branch B (prefix-discipline-only) by default.
Wire system/tools/context into `--system-prompt` and `--append-system-prompt`
so the stable bytes land before the volatile task, and rely on Anthropic's
automatic caching to place a breakpoint on the last cacheable block. Re-evaluate
explicit `cache_control` injection via stream-json in a follow-up slice with a
live smoke test.

`--exclude-dynamic-system-prompt-sections` is recommended in cache-aware mode
when no custom `--system-prompt` is set — it moves the per-machine sections
(cwd, env info, memory paths, git status) out of the cached system prefix into
the first user message, improving cache reuse across users/machines.

## Codex — field name divergence

- **Codex CLI emits**: `cache_read_input_tokens` and `cache_creation_input_tokens`
  in its turn.completed events (Anthropic-style naming, regardless of the
  underlying provider). Confirmed in `src/codex-json-parser.ts:69-77`.
- **Underlying OpenAI API surfaces**: `usage.prompt_tokens_details.cached_tokens`
  (and no `cache_creation_*` field — OpenAI does not distinguish write from read
  in the way Anthropic does; only reads are counted).

Practical consequence: the flight-recorder column `cache_read_tokens` (already
populated for codex via `cache_read_input_tokens`) is accurate for cache reads
across both CLIs. `cache_creation_tokens` for codex will be `0`/`null` because
OpenAI does not report it — only Anthropic writes are recorded there.

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
  benefit (byte-identical stable prefix → higher implicit hit rate). For Claude
  specifically, wires system/tools/context into `--system-prompt` and emits the
  cache_control breakpoint via that surface (Branch B; see above).
- **Slice 2** (cache observability): reads `cache_read_tokens` /
  `cache_creation_tokens` from the flight recorder. Already populated for
  claude and codex; will read as NULL/0 for gemini/grok/mistral and aggregation
  queries must tolerate this without dividing by zero.
- **Slice 3** (TTL tracking): only meaningful for Claude (5min default, 1h
  optional). For other CLIs, `ttlRemainingMs` is null.
