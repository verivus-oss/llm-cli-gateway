# Native Compressor: Spec for First PR

Status: revised spec, pre-implementation. `src/compressor/` does not exist yet
(verified: no `src/compressor/` directory and no `compressDisplayText` symbol
anywhere in `src/` at the citation base below).
Author: design pass, revised after (a) a three-model cross-LLM code review
(Codex, Grok, Gemini) of the draft, (b) a cited web-research sweep and a
four-model independent analysis (Codex, Gemini, Grok, Mistral, 2026-07-08;
see `docs/plans/native-compressor.research-annex.md`, "the annex"), and (c) a
fresh anchor-verification pass over the gateway source.

## 0. Citation convention (resolves review finding F1)

Every gateway code reference in this spec was re-verified against
**master@dec94cc** (the `src/` tree of spec-branch commits is identical to it).
References name the symbol first and the line second, in the form
`symbol (file:line)`. If a line number has drifted when you read this, the
symbol governs; re-resolve before implementing. References to external
repositories (headroom) are as inspected on 2026-07-08 and are labeled as such.

## 1. Goal

Add a native, in-process context-compression layer to the gateway that reduces
the token cost of the text the gateway *returns to its MCP caller*, without a
separate proxy process, without changing provider execution, and without
touching any byte that the gateway itself parses for correctness or accounting.

The gateway is uniquely positioned for this: it is the in-process chokepoint
for every provider CLI spawn and for every result that becomes an MCP tool
response. The compression opportunity that no external proxy can reach cleanly
is the *outbound* direction (shrinking provider output before it re-enters the
orchestrator's context).

This spec scopes a deliberately small, safe First PR and stages the riskier
pieces (inbound prompt compaction, lossy compaction with retrieval, an ML/AST
backend) as explicit follow-ups.

## 2. Why native rather than the headroom proxy

Verified during the draft review (headroom repo, inspected 2026-07-08):

- headroom's TypeScript SDK does not compress locally. `compress()` is a thin
  client that POSTs to a running headroom proxy
  (`sdk/typescript/src/compress.ts`, `sdk/typescript/src/client.ts`). The real
  engine is Rust (`crates/headroom-core`) plus a Python ASGI proxy. Depending
  on headroom means running and supervising that process.
- headroom's reversibility (CCR) requires headroom to run its own MCP server
  and inject a `headroom_retrieve` tool (`crates/headroom-core/src/ccr/`,
  `headroom/ccr/mcp_server.py`, `headroom/ccr/tool_injection.py`).
- The gateway already has the relevant seams: a wired response optimizer
  (`optimizeResponse` in `src/optimizer.ts:37`, called as
  `optimizeResponseText` inside `buildCliResponse` at `src/index.ts:3983-3987`),
  per-provider parsers, a cache-hot-zone guard (the slice-kappa
  `optimizePrompt` + `cacheControl` refusal, `src/index.ts:2655-2690`), and a
  flight recorder with an optimization flag
  (`FlightLogResult.optimizationApplied`, `src/flight-recorder.ts:73`).

Native keeps this in one process and one MCP surface. It does not eliminate
the option of a headroom backend for the two hard transforms; see the
interface in Section 6 and follow-up PR-4.

## 3. Non-goals (First PR)

Explicitly out of scope for PR-1, each deferred to a named follow-up:

- Inbound prompt compaction of any kind (follow-up PR-2).
- Any lossy transform, any dropped bytes irrecoverable from the output, any
  retrieval store (follow-up PR-3). The PR-1 sentinels (Section 6.4) encode
  fold counts; they do not reference stored originals.
- A content-addressed store or a `gateway_retrieve` tool (follow-up PR-3).
- The ML-prose (ONNX) or AST-code (tree-sitter) transforms, and the headroom
  proxy backend (follow-up PR-4).
- Compressing the API-provider response surfaces
  (`buildGrokApiToolResponse`, `src/index.ts:4313`, and
  `handleApiProviderRequest`, `src/index.ts:4922-4925`): a small named
  follow-up after PR-1, with one hard requirement recorded now, see
  Section 5.3.
- Format conversion of any kind (JSON to YAML/CSV/TOON etc.). The annex
  evidence says format changes move task accuracy by 10-16+ points; whitespace
  compaction within the original format is the evidence-safe zone.
- Compressing provider-owned resumed history (see Constraint C6; this is a
  permanent limitation, not a deferral).

## 4. Hard constraints (invariants)

Seven invariants. Every one is a gate: a PR that cannot demonstrate all
applicable invariants does not merge.

### C1. Compress only post-parse, caller-facing display text. Never raw stdout.

Raw provider stdout feeds the per-provider parsers, the Codex display
reconstruction (`codexDisplayText`, swap at `src/index.ts:3979-3981`), and
`extractUsageAndCost` (definition `src/index.ts:1781`; the sync call site
passes raw `stdout`, not the display string: `src/index.ts:4065`, and the
async path extracts from raw `job.stdout` via the closure built in
`buildAsyncFlightRecorderHandoff`, `src/index.ts:1936-1937`, invoked at
`src/async-job-manager.ts:1335`).

Compression must run strictly after all parsing and accounting, on the
already-extracted display string (`finalStdout` in `buildCliResponse`,
`src/index.ts:3957`, the same value the existing `optimizeResponse` step
already operates on at `src/index.ts:3983-3987`).

Bypass guard (three independent conditions, any one skips compression):

1. `outputFormat === "json"`: exactly the existing optimizer guard
   (`src/index.ts:3983`). Note `stream-json` is deliberately NOT bypassed:
   for Claude, `stream-json` is the default `outputFormat`
   (`src/index.ts:7728-7733`) and the display string handed to
   `buildCliResponse` on that path is the parsed prose reply
   (`parsed.text`, `src/index.ts:8192-8194`), which the regex optimizer
   already processes today.
2. A declared output schema exists. Today that means the Codex-only
   `outputSchema` request param (`codex_request` schema,
   `src/index.ts:8372-8377`; async variant `src/index.ts:10351`; materialized
   by `prepareCodexOutputSchema`, `src/request-helpers.ts:806-836`). The
   guard is written against "a declared output schema", not against Codex,
   so future providers gaining schema params inherit it.
3. Content sniff at the compressor layer: the router only routes to the JSON
   transform on structural evidence, and prose that merely parses as JSON is
   not data (Section 6.2). On any doubt, identity.

Verification requirement: a byte-identity test that `extractUsageAndCost` and
every per-provider parser receive byte-identical input with the compressor on
and off, one fixture per provider.

### C2. No claim of in-turn reversibility.

In one-shot request/response, the caller receives the compressed text as the
tool result and can only act on it in a subsequent turn. Unlike headroom, the
gateway cannot inject a retrieval tool into the provider's own generation.
Therefore PR-1 ships lossless-only (C3), and any future lossy mode (PR-3) must
document that expansion costs one extra caller turn and must never be
described as mid-turn recovery.

PR-1 does, however, get a **documented lossless escape hatch for free**
(resolves review finding F2): the flight recorder persists pre-compression
response text on every path PR-1 touches, and `llm_request_result` returns
that stored text verbatim (Section 5.3). A caller that needs the original
bytes reads them back by correlationId in a later turn.

### C3. Lossless by default (First PR is lossless-only).

PR-1 transforms must be information-preserving for the reader: reformatting
and de-duplication that a competent reader can reconstruct, not deletion.
Concretely (all detailed in Section 6):

- token-preserving JSON minification (whitespace-only lexer, never
  parse/re-serialize),
- exact-adjacent run-length de-duplication of byte-identical repeated lines
  with a full-line versioned sentinel (never a bare `(xN)` suffix),
- conservative ANSI/control-sequence stripping with carriage-return overwrite
  collapsing,
- whitespace normalization outside fenced code blocks only.

No row dropping, no truncation, no summarization in PR-1. Because nothing is
unrecoverable, no store and no retrieval are needed, which sidesteps C2 and
the store question entirely for the First PR.

### C4. Never mutate the cached prefix; never desync the flight recorder.

The existing slice-kappa guard (`src/index.ts:2655-2690`) refuses
`optimizePrompt` combined with explicit `cacheControl` precisely because
prompt mutation after resolution would diverge from the raw parts used to
build cache blocks (`assembleClaudeCacheBlocks`, `src/prompt-parts.ts:135`)
and from what the flight recorder logs. PR-1 does no inbound work, so it
inherits this for free. Any future inbound compaction (PR-2) must operate on
`PromptParts.task` (`src/prompt-parts.ts:14`) before both `assemble()`
(`src/prompt-parts.ts:55`) and `assembleClaudeCacheBlocks()`, before the
flight-recorder handoff, and must leave the stable prefix untouched. Reusing
the guard is not sufficient on its own; it only refuses, it does not make
compaction safe.

Outbound-side corollary (new, from the four-model analysis): even lossless
outbound compression changes the bytes the *orchestrator* later replays into
its own context. Mixing compressed and uncompressed runs of the same logical
conversation therefore changes the orchestrator-side prompt-cache bytes. This
is inherent to any outbound rewrite, is caller-visible only as cache economics
(never correctness), and is documented in user-facing docs together with C6.

### C5. Telemetry is exact and truthful.

Extend, do not repurpose (all four analysis models independently insisted):

- The existing `optimizationApplied` flag (`FlightLogResult`,
  `src/flight-recorder.ts:73`, persisted into `gateway_metadata` at
  `src/flight-recorder.ts:466`) keeps its current meaning (the regex
  optimizer / prompt optimizer) and is never overloaded.
- New **additive** flight-recorder fields carry the compressor's facts
  (Section 8): the route/transform list actually applied, exact before/after
  character counts, and an estimated-token delta.
- The token delta uses a content-aware chars-per-token divisor table keyed by
  the router's content class, and the field is labeled "estimated". The
  existing `estimateTokens` (`src/optimizer.ts:26`, words x 1.3) is
  **banned** for compressor telemetry: the annex evidence shows word-based
  and flat chars/4 heuristics under-count code/JSON by 30-58%. A
  dev-flag-only real-tokenizer path exists for fixture benchmarking and is
  never a production dependency.
- Billed usage and cost stay derived from raw stdout (C1), never from
  compressed text.
- Sync/async telemetry parity: the async terminal writer currently hardcodes
  `optimizationApplied: false` (`AsyncJobManager.writeFlightComplete`,
  `src/async-job-manager.ts:1309`; also both branches of
  `buildOrphanFlightResult`, `src/async-job-manager.ts:700` and `:711`).
  PR-1 fixes this while wiring: the actual optimize/compress state is
  threaded through the async completion path so compressor telemetry (and the
  existing flag) have sync/async parity. Orphaned jobs, which never produced
  a caller-facing response, record their true (absent) state.

### C6. The resumed-history blind spot is documented, not worked around.

On `--resume` / `--continue` / provider-equivalents, the provider CLI reloads
prior turns from its own on-disk state; the gateway never sees them (session
resume args are produced by `resolveSessionResumeArgs`,
`src/request-helpers.ts:53-77`; Codex has its own resume planner,
`src/request-helpers.ts:80` onward). Neither inbound nor outbound compaction
can touch that context. This is a stated limitation in the spec and in
user-facing docs, not something the compressor pretends to solve.

Dual-reality addendum (for the future lossy mode, documented now): with PR-3
lossy compaction plus provider-side resume, the provider CLI resumes from its
own raw history while the orchestrator saw compressed text. The two sides of
the conversation then disagree about what was said. Any PR-3 design must
document this as a hard property of provider-owned sessions, and user-facing
docs must warn that lossy compression plus resume yields divergent context.
Lossless PR-1 does not create this split (the compressed text is a faithful
reformatting), but the orchestrator-cache note in C4 applies.

### C7. Compression applies only at the MCP tool-response boundary.

(New invariant, resolves review finding F5.) The single conceptual operation
is: the final caller-facing display string is compressed once, immediately
before it is placed into the MCP result. Everything upstream of that point
sees pre-compression text. Enumerated internal consumers that MUST NOT see
compressed text, with the anchor proving each reads pre-compression material
today:

1. Per-provider parsers and display reconstruction: `codexDisplayText`
   consumes raw stdout (`src/index.ts:3979-3981` sync,
   `src/index.ts:11583-11589` async read-back), `parseStreamJson` consumes
   raw stdout (`src/index.ts:8168`, and `src/index.ts:4013` for the
   is_error health check).
2. Usage/cost extraction: `extractUsageAndCost` on raw `stdout`
   (`src/index.ts:4065` sync; `src/async-job-manager.ts:1335` async).
3. Session-id handling: session ids are threaded as resolved values, never
   parsed from display text (`resolveSessionResumeArgs`,
   `src/request-helpers.ts:53-77`; the async flight-recorder handoff captures
   the session id at `src/index.ts:1924`).
4. Flight-recorder response persistence: `safeFlightComplete`
   (`src/index.ts:1952`) call sites log raw stdout (or pre-optimize parsed
   display text) on every CLI path, and
   `AsyncJobManager.writeFlightComplete` logs raw `job.stdout`
   (`src/async-job-manager.ts:1288-1297`). Section 5.3 makes this an
   explicit invariant with a test.
5. Validation scoring and receipt minting: `normalizeJobResult` scores raw
   `result.stdout` (`src/validation-normalizer.ts:77-82`, fed from
   `getJobResult` at `src/validation-receipt.ts:142`), and
   `computeCanonicalSha256` hashes the canonical structured report built from
   that raw material (`src/validation-receipt.ts:104-105`, minted at
   `:220`). Receipts must stay byte-stable whether or not the caller enabled
   compression.
6. Review-integrity scoring and warnings: violations are computed during
   request prep (from `src/review-integrity.ts`, carried on
   `prep.reviewIntegrity`) and the warning block is appended to the response
   AFTER compression (Section 5.1), so callers receive integrity warnings
   verbatim.
7. `llm_request_result` read-back: returns the stored flight-recorder
   `response` column verbatim, only length-sliced (`readPersistedRequest`,
   `src/cache-stats.ts:594-643`; tool handler `src/index.ts:11735`).

The test matrix (Section 9) pins each of these.

## 5. First PR scope (what actually ships)

A new `src/compressor/` module plus three narrow wiring points, all behind a
default-off config flag and a per-request boolean.

### 5.1 Sync path: one shared `compressDisplayText()` call site

(Resolves review finding F3.) In `buildCliResponse` (`src/index.ts:3957`) the
current order is: Codex display swap (`:3979-3981`), regex optimizer
(`:3983-3987`), review-integrity warning append (`:3990-3999`), then result
construction, where the SAME `finalStdout` value is placed into both
`content[0].text` (`:4046`) and the `structuredContent.response` mirror
(`:4056`). MCP hosts may feed either or both surfaces to the model, so
compressing only one would either double cost or produce divergent copies.

PR-1 inserts exactly one call:

```
display swap  ->  optimizeResponse (existing, flagged)
              ->  compressDisplayText(finalStdout, ctx)     <- NEW, flagged
              ->  review-integrity warning append           <- stays verbatim
              ->  finalStdout lands in content[0].text AND structuredContent.response
```

Compression runs after provider display extraction and after the existing
`optimizeResponse` step (they compose; neither requires the other), and
BEFORE the review-integrity append, so integrity warnings reach the caller
uncompressed and cannot be folded, deduped, or reformatted. Because both
response surfaces are populated from the single post-compression
`finalStdout`, one call site covers both mirrors by construction. There is no
redaction step on this path today (verified; `redactSecrets` is applied only
to log/error formatting, e.g. `src/index.ts:254-292`); if one is ever added
it belongs upstream of compression, and the C7 enumeration gains an entry.
The worktree banner some handlers prepend after response construction
(`formatWorktreePrefix`, e.g. `src/index.ts:8204-8208`) is a gateway
annotation added to `content[0].text` only, outside the compressor, and is
unaffected.

### 5.2 Async path: same function at the `llm_job_result` conversion

The `llm_job_result` handler (`src/index.ts:11542` onward) already converts
stored stdout to caller-facing text: Claude stream-json parse (`:11569-11571`)
and the Codex display swap (`:11583-11589`) on a fresh copy of the job record
(mutation cannot alias the store). PR-1 applies the SAME
`compressDisplayText()` to the display text there (after the display swap,
before envelope construction), so sync and async return the same compressed
display text. Stored raw stdout is never overwritten.

Flag parity: jobs already persist `output_format`
(`src/job-store.ts:335`, written at `:503`/`:846`, read back at `:92`, and
surfaced via `getJobOutputFormat`, used at `src/index.ts:11567`). PR-1
persists the request's effective compression choice the same way: an additive
nullable `compress_response` column on the jobs table, mirrored across all
three `JobStore` implementations (SQLite CREATE + idempotent ALTER migration,
memory, Postgres + worker), so read-back applies the identical transform the
sync path would have. Older rows read back as NULL and are treated as
"not requested".

### 5.3 The lossless escape hatch, stated as an invariant

(Resolves review finding F2.) Verified per flight-recorder call site: every
CLI success path logs pre-compression text as the `response` column. Most log
raw provider stdout (representative: gemini, `response: stdout` at
`src/index.ts:5409-5412`, plus the parallel provider handlers at `:5875`,
`:6274`, `:6727`, `:7146`); the Claude stream-json success path logs the
post-parse, pre-optimize display text (`response: parsed.text`,
`src/index.ts:8174-8177`, logged BEFORE `buildCliResponse` runs at `:8192`);
the async writer logs raw `job.stdout` with only the Codex JSONL
reconstruction (`codexFrResponse`, `src/async-job-manager.ts:1292-1294`).

Therefore: the flight recorder stores PRE-compression text, and
`llm_request_result` (which returns the stored `response` verbatim,
`src/cache-stats.ts:617-643`) is the documented lossless escape hatch: full
original text, one read-back call, by correlationId. PR-1 adds a test for
this surface (Section 9) and documents it in user-facing docs.

Two consequences worth stating:

- This weakens the case for PR-3's dedicated content-addressed store: for
  everything PR-1 (and any lossless mode) touches, read-back already exists.
  PR-3's store is only justified by lossy transforms whose originals exceed
  what the flight recorder retains, and its design must argue against this
  baseline.
- One known pre-existing deviation, NOT introduced or extended by PR-1: the
  generic API-provider sync success path logs POST-optimize text
  (`optimizeResponseText` at `src/index.ts:4922-4925` runs before the
  `safeFlightComplete` at `:4927`). PR-1 does not wire compression into any
  API-provider path (Section 3); the follow-up that does MUST log
  pre-compression text there, restoring the invariant rather than extending
  the deviation.

### 5.4 Gateway-owned envelope compaction (adopted into PR-1)

Verified: the `llm_job_result` success envelope is gateway-owned
pretty-printed JSON, `JSON.stringify({ success: true, result, ...parsed },
null, 2)` (`src/index.ts:11595-11613`). Two-space indentation on an envelope
that wraps potentially large stdout makes this the highest-yield, lowest-risk
item found in review: the gateway owns every byte of the wrapper, and
embedded string values (the stdout itself) are preserved byte-for-byte by the
serializer regardless of indentation.

In scope for PR-1: when compression is enabled for the request, serialize
this envelope compactly (no indentation) instead of `null, 2`. This is not a
transform over foreign text (no lexer needed, no risk class); it composes
with 5.2 (the embedded display text is compressed first, then the envelope is
serialized compactly). The error envelope (`:11551-11559`) may compact the
same way. Scope stays tight: `llm_job_result` only; other
`JSON.stringify(..., null, 2)` introspection surfaces are untouched in PR-1.

### 5.5 Module layout

1. `src/compressor/index.ts`: the `Compressor` interface (Section 6) and the
   `NativeCompressor` implementing it, plus the exported
   `compressDisplayText()` helper the two wiring points call.
2. `src/compressor/router.ts`: content classification into
   {json, log, ansi-text, plain} and dispatch. Unknown or risky content falls
   through to identity.
3. `src/compressor/transforms/json.ts`, `log.ts`, `ansi.ts`,
   `whitespace.ts`: the lossless transforms (Section 6).
4. `src/compressor/estimate.ts`: the content-aware divisor table and the
   dev-flagged tokenizer hook (C5).
5. Wiring per 5.1/5.2/5.4; config + telemetry per Sections 7 and 8.

Out of scope: everything in Section 3.

## 6. Architecture

### 6.1 Interface

```ts
// src/compressor/index.ts
export interface CompressCtx {
  provider: string;            // member of CLI_TYPES ("claude" | "codex" | ...)
  direction: "outbound";       // "inbound" arrives in PR-2
  outputFormat?: string;       // gate: skip when "json"
  outputSchemaDeclared: boolean; // gate: skip when a schema param was passed
  lossless: true;              // PR-1 is lossless-only
}

export interface CompressResult {
  text: string;                // compressed display text
  originalChars: number;
  compressedChars: number;
  route: string;               // content class routed to, or "identity"
  transforms: string[];        // transforms that actually changed bytes
  estimatedTokensSaved: number; // divisor-table estimate, labeled estimated
}

export interface Compressor {
  compact(text: string, ctx: CompressCtx): CompressResult;
}
```

`NativeCompressor` is the PR-1 implementation. The interface exists now so a
later `HeadroomCompressor` (PR-4) can back the heavy transforms without
touching call sites. Native stays the default; headroom is opt-in and only
for content classes native declines to handle.

### 6.2 Router policy

Detect, dispatch to one content class, and on any doubt return identity.
Correctness beats savings. The router never sees or mutates raw stdout (C1);
it only ever receives the post-parse display string.

- `json`: only on structural evidence: after trimming, the text begins with
  `{` or `[`, ends with the matching close, and lexes cleanly end-to-end
  (Section 6.3). A prose reply that merely *contains* or *quotes* JSON stays
  `plain`; a fenced code block never triggers the json route. This is the C1
  content sniff: prose that parses as JSON is not data.
- `ansi-text`: contains ECMA-48 escape sequences or bare carriage returns.
  If cursor-movement or alternate-screen sequences are present, the whole
  transform is skipped (identity): that output is a terminal UI recording,
  not a log, and cannot be safely linearized.
- `log`: line-oriented text with repeated-line runs (the dedup transform's
  own precondition). The whitespace transform also runs here.
- `plain`: everything else; only the whitespace transform (outside fences)
  applies, so this route is near-identity.

### 6.3 JSON transform: whitespace-only lexer, never parse/re-serialize

(Supersedes the draft's parse-and-recompact; annex Part 2, verdict 1.)
`JSON.parse` + `JSON.stringify` is NOT lossless: `-0` becomes `0`, big
integers lose precision, exponent spelling changes, integer-like keys
reorder, escape spellings normalize. A round-trip deep-equality test cannot
catch the first two because both sides parse to the same lossy value.

PR-1 instead implements a token-preserving minifier: a minimal JSON lexer
that copies every token byte-for-byte (numbers, strings including their
escape spelling, literals) and drops only inter-token whitespace. No key
sorting (annex Part 2, verdict 5: byte churn for zero token gain, harmful to
caching and diffs). Identity on any lex error: if the text does not lex as
JSON from first byte to last, the transform returns the input unchanged.

Expected yield from the evidence base: 17-42% on pretty-printed JSON, with
equivalent or slightly better downstream accuracy.

### 6.4 Sentinel grammar (versioned, full-line, greppable)

(Resolves review finding F4; bare `(xN)` is rejected: 3 of 4 analysis models
found it collides with plausible real output, and the evidence shows models
ignore subtle trailing markers.)

All compressor markers share one grammar, designed now so PR-3
elision/retrieval markers extend it rather than inventing a second dialect:

```
[[gateway-<kind>:v1 key=value key=value ...]]
```

- Always a full line of its own (never appended to a content line).
- `<kind>` in PR-1: `repeat` (run-length fold), `cr` (carriage-return
  overwrite fold), `note` (leading notice), `lit` (escape marker).
  Reserved for PR-3: `elide`, `ref`.
- PR-1 markers:
  - `[[gateway-repeat:v1 lines=1 count=47]]` placed immediately after the
    single kept exemplar line (for multi-line blocks, `lines=N` after the
    kept block, if block dedup ships; see Section 6.5).
  - `[[gateway-cr:v1 frames=12]]` after a line whose intermediate
    carriage-return frames were collapsed to the final visible frame.
- Escaping rule: any INPUT line that begins with `[[gateway-` (after
  optional leading whitespace) is emitted prefixed with
  `[[gateway-lit:v1]] ` (marker, one space, then the original line
  byte-for-byte). Consumers strip the prefix to recover the exact line. This
  keeps the sentinel namespace unambiguous even against adversarial or
  echoed-back input.
- Leading note: whenever ANY folding fired in a response, the compressed text
  begins with one line, e.g.
  `[[gateway-note:v1 folded=3]] Repeated output folded; markers below look like [[gateway-repeat:v1 ...]].`
  Evidence (annex Part 1, section 6): models treat the visible prefix as
  complete and ignore subtle trailing markers, so the notice leads.

### 6.5 Log dedup transform

Exact-adjacent-only, byte-identical lines, minimum run length 3 (runs of 2
are left alone: the sentinel line would erase most of the saving and adds
reader overhead). Replaces the run with one exemplar plus the `repeat`
sentinel. No value masking, no timestamp/UUID normalization, no windowed or
fuzzy matching in PR-1 (those stop being lossless).

Stretch item, explicitly optional in PR-1 and dropped without ceremony if it
misses the fixture bar (Section 9): exact-match multi-line block dedup for
byte-identical repeated blocks (the repeated-stack-trace case), same
sentinel with `lines=N`. Ships only if its median fixture savings beat its
overhead.

### 6.6 ANSI transform

Scoped to the log/terminal content class only (color and OSC 8 hyperlinks
can carry meaning in prose-class output; annex Part 2, verdict 2):

- Full ECMA-48 coverage: CSI sequences, OSC with BEL or ST terminators,
  DCS/APC/PM/SOS with ST terminators, two-byte ESC forms; a second pass for
  stray C0 controls (preserving `\n` and `\t`).
- Carriage-return overwrite collapsing: for a line containing `\r`, keep the
  final visible frame (the segment after the last `\r`), with the `cr`
  sentinel recording the folded frame count. A lexical strip that preserved
  raw `\r` would concatenate overwritten progress-bar frames into garbage.
- Skip entirely (identity for the whole text) when cursor-movement or
  alternate-screen sequences are present (CUP/CUU/CUD/ED-class CSI,
  `?1049h`-style private modes): stripping those yields a scrambled
  interleaving, not a log.

### 6.7 Whitespace transform

Trailing-whitespace strip and collapse of 3+ consecutive blank lines to 1,
OUTSIDE fenced code blocks only. Bytes inside fences and inline code spans
are untouchable in every transform (this is a global rule the router
enforces, not a per-transform courtesy). PR-1 hardens and reuses the
fence-handling approach already in the optimizer (fence regex at
`src/optimizer.ts:44`, inline-code split at `:58`) as a shared helper in
`src/compressor/transforms/whitespace.ts` rather than inventing a second
dialect; hardening means at minimum: tilde fences, unclosed-fence safety
(treat everything after an unclosed opener as fenced), and fence-info
strings. The optimizer keeps its own behavior unchanged in PR-1.

## 7. Configuration

- New `[compression]` table in `~/.llm-cli-gateway/config.toml`, following
  the existing per-table loader pattern in `src/config.ts` (a strict Zod
  schema + defaults + a `loadCompressionConfig()` and its interface, sitting
  beside `PersistenceSchema` at `src/config.ts:107-116` and
  `JobLimitsSchema` at `:391-408`), threaded through `GatewayServerRuntime`
  (`src/index.ts:740-754`, resolved in `resolveGatewayServerRuntime`,
  `:756` onward) the same way `persistence` and `providers` are.
  PR-1 key: `enabled` (boolean, default false).
- Request-level boolean `compressResponse` on the CLI request tools (sync
  and async variants), default unset. Effective value:
  `request param ?? config.enabled`. Naming mirrors the existing
  `optimizeResponse` param (e.g. `src/index.ts:5086`).
- PR-1 default is off at both levels. The feature turns on only by explicit
  opt-in, so no existing caller's returned text changes on upgrade.
- Interaction with the existing `optimizeResponse` regex optimizer: the
  native compressor runs after it, on the same display string, and is
  independently flagged. They compose; neither is required for the other.

## 8. Data model and telemetry

No content store in PR-1 (C3: nothing is unrecoverable; Section 5.3 gives the
read-back path). Two schema touches, both additive:

1. Jobs table: nullable `compress_response` column (Section 5.2), mirroring
   `output_format` across the three `JobStore` implementations, with the same
   idempotent ALTER-migration idiom the store already uses
   (`src/job-store.ts:139-140` pattern).
2. Flight recorder: new additive columns on `gateway_metadata` (the table
   that already carries `optimization_applied`, CREATE at
   `src/flight-recorder.ts:302-315`), added via the existing idempotent
   ALTER idiom (`ensureStablePrefixColumns` pattern,
   `src/flight-recorder.ts:135-147`):
   - `compression_route` TEXT (e.g. `"log"`, `"json"`, `"identity"`),
   - `compression_transforms` TEXT (comma-joined list that changed bytes),
   - `compression_original_chars` INTEGER,
   - `compression_compressed_chars` INTEGER,
   - `compression_tokens_saved_est` INTEGER (divisor-table estimate; the
     `_est` suffix is deliberate).
   All NULL when compression did not run. `optimizationApplied` is never
   repurposed (C5). The async writer threads real values (the C5 parity
   fix). Character counts are exact; the token field is the only estimate
   and is named as one.

Estimator (`src/compressor/estimate.ts`): divisor table keyed by the
router's content class, from the annex evidence (approximate chars/token:
prose 3.6, log text 3.4, minified JSON 3.0, code 2.3; values recorded as
constants with the source noted). `words x 1.3` and flat chars/4 are banned
here (C5). A dev flag (env-gated, test/bench only) swaps in a real tokenizer
for fixture benchmarking so the PR description can report measured, not
estimated, savings; it is never loaded in production.

## 9. Testing and verification (merge gate)

Fixture corpus first: `src/__tests__/fixtures/` (new directory; today only
`src/__tests__/__snapshots__/` exists) with real CLI output shapes per
provider: Claude markdown prose, Codex JSONL-derived display text, Gemini,
Grok, Mistral, plus ANSI/progress-bar captures and pretty-printed JSON.
Promotion rule: a transform ships enabled only if its median fixture savings
beat its sentinel overhead; measured numbers go in the PR description.

1. C1 byte-identity anchor test: every per-provider parser and
   `extractUsageAndCost` receive byte-identical input with the compressor on
   and off, one fixture per provider.
2. Off-by-default byte-identity: flag unset (config and request), returned
   text byte-identical to pre-change behavior, sync and async.
3. Bypass guards: `outputFormat === "json"` verbatim; Codex `outputSchema`
   declared verbatim; content sniff (prose containing/quoting JSON, fenced
   JSON) stays on the plain route.
4. JSON lexer: token preservation on the hostile corpus (`-0`, big integers
   beyond 2^53, exponent spellings, duplicate keys, integer-like keys,
   escape spellings); identity on lex error; no key reordering (byte-level
   assertions, not deep-equality, per Section 6.3).
5. Sentinel round-trip: dedup folds expand to the original line multiset via
   the counts; escaping round-trip for input that already contains
   `[[gateway-` lines (including a line that is itself a valid sentinel);
   leading note appears iff folding fired.
6. ANSI: ECMA-48 corpus (CSI/OSC/DCS with both terminators) strips cleanly;
   `\r` progress-bar fixture collapses to final frame + `cr` sentinel;
   alt-screen/cursor-movement fixture returns identity.
7. Fenced-code preservation: bytes inside backtick and tilde fences and
   inline code untouched by every transform; unclosed-fence input is treated
   as fenced from the opener on.
8. Ordering (F3): review-integrity warnings appear uncompressed, appended
   after compression (a fixture whose warnings would be folded by dedup must
   come through verbatim); `content[0].text` and `structuredContent.response`
   carry the identical compressed string.
9. Sync/async parity: same stored stdout yields the same compressed display
   text through `*_request` and `llm_job_result` (including the persisted
   `compress_response` flag read-back and NULL back-compat), and the 5.4
   envelope is compact iff compression is on, with embedded strings
   byte-identical.
10. Escape hatch (F2): with compression on, the flight-recorder `response`
    row is pre-compression text and `llm_request_result` returns it; the
    Claude stream-json path asserts `parsed.text` (pre-optimize display), the
    generic CLI path asserts raw stdout.
11. Receipts/validation: validation normalizer input and
    `canonicalSha256` are byte-identical with compression on and off.
12. Telemetry: the new fields carry exact char counts and the actual
    route/transform list, sync AND async (the `optimizationApplied` async
    hardcode is gone); cost/usage unchanged; fields NULL when compression is
    off.
13. Estimator sanity bounds: divisor-table estimates for each fixture class
    within a stated tolerance of the dev-tokenizer ground truth (tolerance
    recorded in the test, e.g. 25%), and never produced from word counts.
14. Run the repo's standard gates (`npm run check`; `npm run test:pg` if the
    jobs-table migration is touched, which it is, per Section 5.2), the
    verify skill against a locally built gateway (real request, flag on and
    off, flight-recorder rows inspected), the test-veracity audit, and the
    multi-LLM review gate before merge.

## 10. Follow-ups (named, not part of PR-1)

- PR-2: inbound compaction of `PromptParts.task` only, under C4, lossless,
  cache-safe, with a dedicated byte-stability test on assembled cache blocks
  and flight-recorder entries (golden-file byte snapshots).
- PR-3: optional lossy transforms plus retrieval. Must justify a dedicated
  store against the Section 5.3 baseline (flight-recorder read-back already
  covers lossless originals), must extend the Section 6.4 sentinel grammar
  (`elide`, `ref` kinds, leading markers naming what was dropped and how to
  retrieve), must preserve log/stack-trace tails, and must document C2
  (expansion costs one extra caller turn) and the C6 dual-reality addendum.
- PR-4: `HeadroomCompressor` backend behind the `Compressor` interface for
  ML-prose and AST-code content classes.
- API-provider wiring follow-up: extend `compressDisplayText()` to
  `buildGrokApiToolResponse` and `handleApiProviderRequest`, and fix that
  path's flight-recorder ordering so the logged response is pre-compression
  (Section 5.3's known deviation).

## 11. Open questions from the draft: now decided

1. Config key naming and precedence: DECIDED (Section 7): `[compression]`
   table with `enabled`, request-level `compressResponse`, request wins,
   both default off, independent of `optimizeResponse`.
2. Dedup window: DECIDED (Section 6.5): exact-adjacent only, byte-identical,
   minimum run 3; block dedup is an explicit stretch item behind the fixture
   bar; windowed/fuzzy dedup rejected for PR-1 (not lossless).
3. Token estimation: DECIDED (Section 8): content-aware divisor table keyed
   by route, labeled estimated; exact char counts always; dev-flag real
   tokenizer for fixtures only; `estimateTokens` (words x 1.3) banned for
   compressor telemetry.

No open questions remain for PR-1.

## 12. Review disposition

This revision incorporates, in addition to the draft review's six blockers
(no store-reuse claim, no cache-guard-makes-it-safe claim, no in-turn
reversibility claim, no raw-stdout compression, no pretense of seeing
resumed history, lossless-only First PR):

- F1: all gateway citations re-verified against master@dec94cc,
  symbol-first (Section 0). Draft anchors that had drifted (optimizer call
  site, cache guard, `assembleClaudeCacheBlocks`, `assemble`, session
  resolution) are corrected; two draft-review claims that do not hold on
  this base are dropped (there is no Grok streaming display swap or
  thought-delta exclusion in the current tree, and no display-text redaction
  step).
- F2: the flight recorder's pre-compression persistence is now an invariant
  with per-call-site verification, `llm_request_result` is the documented
  lossless escape hatch, the API-path deviation is recorded, and the PR-3
  store must justify itself against this baseline (Sections 5.3, 9.10).
- F3: exactly one `compressDisplayText()` call site per path, ordered after
  extraction and `optimizeResponse`, before the review-integrity append,
  covering both `content[0].text` and `structuredContent.response` from a
  single value (Section 5.1).
- F4: bare `(xN)` replaced by the versioned full-line sentinel grammar with
  escaping and a leading note, designed to extend to PR-3 (Section 6.4).
- F5: the boundary invariant C7 with the enumerated pre-compression
  consumers, each anchored and each pinned by a test (Sections 4.C7, 9).
- The four-model research consolidation (annex Part 2): whitespace-only JSON
  lexer, no key sorting, ECMA-48 + CR-collapse + alt-screen skip, sentinel
  shape, telemetry rules, exact-adjacent dedup, envelope compaction, output
  schema guard, async telemetry parity fix, and the C6 dual-reality and
  orchestrator-cache addenda.
