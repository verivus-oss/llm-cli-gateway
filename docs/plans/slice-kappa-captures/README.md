# slice κ — captured artefacts (2026-05-27)

Raw research artefacts from the κ baseline + live smoke-test session.
Preserved verbatim so the implementation phase (and any future audit)
can re-derive the findings without re-burning API credit.

These are reference data, not production code. Not loaded by any
build. Safe to delete after κ ships if disk pressure becomes an issue
— but until then, keep them as the evidentiary base.

## Files

### `flight-recorder-rows.jsonl`

10 rows from `~/.llm-cli-gateway/logs.db` keyed on `kappa-baseline-*`
and `kappa-baseline-sanity-*`. Each row is one JSON object per line
combining the `requests` and `gateway_metadata` tables. The `response`
column contains the full NDJSON stdout from claude (init event,
assistant event, rate_limit_event, result event), so each row can be
re-inspected as raw stream-json output.

Notable subset:

- `kappa-baseline-A-01..A-08` — 8 calls with identical `promptParts`
  + varying task suffix, all `outputFormat: "stream-json"`, all fresh
  sessions. Every row shows identical `input_tokens: 3,
  output_tokens: 9, cache_read_tokens: 12928, cache_creation_tokens:
  11055`. The baseline finding: implicit cache reuse of user-side
  prefix across new sessions = effectively zero, because Claude
  Code's per-session wrapping becomes part of the cache key.
- `kappa-baseline-sanity-002` — trivial "Reply with: OK" prompt
  through the gateway, used to confirm the v1.13.2 verbose fix
  unblocked the token-capture pipeline end-to-end. Different
  `cache_creation_tokens: 10297` (vs 11055 for Arm A) — the delta
  matches roughly the size of the user-side prompt difference, ruling
  out dedup as the source of identical Arm A numbers.
- `kappa-baseline-sanity-001` — the FIRST sanity call, which stalled
  (loaded the full sqry MCP config and hit concurrent gateway load
  from the parallel sqry session). 182516ms duration, NULL tokens,
  94622-byte response (likely truncated/incomplete NDJSON on cancel).
  Kept as a counter-example: do NOT load MCPs into baseline calls;
  pass `mcpServers: []` and `strictMcpConfig: true` to isolate.

Inspect with `jq`:

```bash
jq -c '{id, cli, datetime_utc, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, stable_prefix_hash, resp_bytes: (.response | length)}' flight-recorder-rows.jsonl
```

Extract one row's raw stream-json:

```bash
jq -r 'select(.id == "kappa-baseline-A-01") | .response' flight-recorder-rows.jsonl | head -200
```

### `smoke-test-results.json`

Parsed call-1 / call-2 summaries from
`docs/plans/slice-kappa-smoke-test.mjs`. The script shells `claude`
directly (bypasses the gateway, so these calls are NOT in the FR).

Key numbers (also in
`memory/project_provider_modernisation_phases.md`):

| Metric | Call 1 | Call 2 | Delta |
|---|---|---|---|
| `cache_read_input_tokens` | 12,928 | 28,439 | **+15,511** |
| `cache_creation_input_tokens` | 15,523 | **12** | **−15,511** |
| Cost USD | $0.0659 | $0.0124 | **−82%** |
| Duration | 2.83 s | 1.80 s | **−36%** |

The 15,511-token symmetric shift is the cleanest possible demonstration
that Anthropic honoured the `cache_control: {type: "ephemeral", ttl:
"1h"}` block forwarded via Claude Code's stream-json input.

Raw NDJSON from claude was NOT preserved by the script (it only kept
the parsed `result` event). To re-capture raw NDJSON, re-run
`node docs/plans/slice-kappa-smoke-test.mjs` (~$0.08 of Sonnet on a
1h-cache-enabled account).

### `anthropic-400-ttl-ordering-error.json`

The first failed smoke-test attempt that revealed Anthropic's TTL
ordering rule. Verbatim 400 error preserved. This is the
single most-cited finding from the session — the constraint that
forces the implementation to hardcode `ttl: "1h"` on caller-supplied
cache_control blocks.

The error message is self-documenting:

> "API Error: 400 messages.0.content.6.cache_control.ttl: a ttl='1h'
> cache_control block must not come after a ttl='5m' cache_control
> block. Note that blocks are processed in the following order:
> `tools`, `system`, `messages`."

Two things the error reveals:

1. Default `cache_control: {type: "ephemeral"}` resolves to
   `ttl="5m"` server-side.
2. Claude Code injects ~6 content blocks before caller user content
   (the `.content.6` index) and marks them with `ttl="1h"`.

Both facts MUST inform the κ implementation. See
`~/llm-cli-gateway-kappa-resume.md` for how they shape the gateway
surface.

## Reproducing

```bash
# κ smoke test (creates two API calls, ~$0.08 on Sonnet)
node docs/plans/slice-kappa-smoke-test.mjs

# TTL ordering probe (creates one API call that fails 400, ~$0.0005)
echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"Hello","cache_control":{"type":"ephemeral"}},{"type":"text","text":"Reply OK"}]}}' \
  | claude -p --input-format stream-json --output-format stream-json --verbose --model sonnet \
  | jq -c 'select(.type == "result") | {is_error, api_error_status, result}'

# Re-extract FR rows
node -e "
const Database = require('better-sqlite3');
const db = new Database(process.env.HOME + '/.llm-cli-gateway/logs.db', { readonly: true });
console.log(JSON.stringify(
  db.prepare(\"SELECT * FROM requests r LEFT JOIN gateway_metadata m ON r.id = m.request_id WHERE r.id LIKE 'kappa-baseline-%' ORDER BY r.datetime_utc\").all(),
  null, 2
));
"
```
