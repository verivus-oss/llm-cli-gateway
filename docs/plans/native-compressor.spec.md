# Native Compressor: Spec for First PR

Status: draft spec, pre-implementation. `src/compressor/` does not exist yet.
Author: design pass, revised after a three-model cross-LLM code review (Codex,
Grok, Gemini) that inspected the gateway, headroom, and rtk source directly.

## 1. Goal

Add a native, in-process context-compression layer to the gateway that reduces
the token cost of the text the gateway *returns to its MCP caller*, without a
separate proxy process, without changing provider execution, and without
touching any byte that the gateway itself parses for correctness or accounting.

The gateway is uniquely positioned for this: it is the in-process chokepoint for
every provider CLI spawn and for every result that becomes an MCP tool response.
The compression opportunity that no external proxy can reach cleanly is the
*outbound* direction (shrinking provider output before it re-enters the
orchestrator's context).

This spec scopes a deliberately small, safe First PR and stages the riskier
pieces (inbound prompt compaction, lossy compaction with retrieval, an ML/AST
backend) as explicit follow-ups.

## 2. Why native rather than the headroom proxy

Verified during review:

- headroom's TypeScript SDK does not compress locally. `compress()` is a thin
  client that POSTs to a running headroom proxy (`sdk/typescript/src/compress.ts:13,58`;
  `sdk/typescript/src/client.ts:614`). The real engine is Rust
  (`crates/headroom-core`) plus a Python ASGI proxy. Depending on headroom means
  running and supervising that process.
- headroom's reversibility (CCR) requires headroom to run its own MCP server and
  inject a `headroom_retrieve` tool (`crates/headroom-core/src/ccr/mod.rs:1`;
  `headroom/ccr/mcp_server.py:1,525`; `headroom/ccr/tool_injection.py:288`).
- The gateway already has the relevant seams: a wired response optimizer
  (`src/optimizer.ts`, called at `src/index.ts:4331`), per-provider parsers, a
  cache-hot-zone guard (`src/index.ts:2906,2931,2938`), and a flight recorder
  with an optimization flag.

Native keeps this in one process and one MCP surface. It does not eliminate the
option of a headroom backend for the two hard transforms; see the interface in
Section 6 and follow-up PR-4.

## 3. Non-goals (First PR)

Explicitly out of scope for PR-1, each deferred to a named follow-up:

- Inbound prompt compaction of any kind (follow-up PR-2).
- Any lossy transform, any dropped bytes, any sentinel, any retrieval
  (follow-up PR-3).
- A content-addressed store or a `gateway_retrieve` tool (follow-up PR-3).
- The ML-prose (ONNX) or AST-code (tree-sitter) transforms, and the headroom
  proxy backend (follow-up PR-4).
- Compressing provider-owned resumed history (see Constraint C6; this is a
  permanent limitation, not a deferral).

## 4. Hard constraints (invariants)

These six invariants come straight from the review. Every one is a gate: a PR
that cannot demonstrate all applicable invariants does not merge.

### C1. Compress only post-parse, caller-facing display text. Never raw stdout.

Raw provider stdout feeds the per-provider parsers, session-id extraction, and
`extractUsageAndCost` (`src/index.ts:4443`). Compaction must run strictly after
all parsing and accounting, on the already-extracted display string
(`finalStdout` in `buildCliResponse`, the same value `optimizeResponse` already
operates on at `src/index.ts:4331`), and must be skipped whenever
`outputFormat === "json"` (or any structured mode), exactly as the existing
response optimizer is skipped.

Verification requirement: a test that asserts `extractUsageAndCost` and every
per-provider parser receive byte-identical input with the compressor on and off.

### C2. No claim of in-turn reversibility.

In one-shot request/response, the caller receives the compressed text as the tool
result and can only act on it in a subsequent turn. Unlike headroom, the gateway
cannot inject a retrieval tool into the provider's own generation. Therefore
PR-1 ships lossless-only (C3), and any future lossy mode (PR-3) must document
that expansion costs one extra caller turn and must never be described as
mid-turn recovery.

### C3. Lossless by default (First PR is lossless-only).

PR-1 transforms must be information-preserving for the reader: reformatting and
de-duplication that a competent reader can reconstruct, not deletion. Concretely,
whitespace and ANSI normalization, JSON re-serialization to compact form, and
run-length de-duplication of byte-identical repeated log lines with an explicit
`(xN)` count. No row dropping, no truncation, no summarization in PR-1. Because
nothing is lost, no store and no retrieval are needed, which sidesteps C2 and
the store question entirely for the First PR.

### C4. Never mutate the cached prefix; never desync the flight recorder.

The existing slice-kappa guard (`src/index.ts:2906,2931,2938`) refuses
`optimizePrompt` combined with `cacheControl` precisely because prompt mutation
after resolution would diverge from the raw parts used to build cache blocks
(`assembleClaudeCacheBlocks`, `src/index.ts:3106`) and from what the flight
recorder logs. PR-1 does no inbound work, so it inherits this for free. Any
future inbound compaction (PR-2) must operate on `PromptParts.task` before both
`assemble()` (`src/prompt-parts.ts:80`) and `assembleClaudeCacheBlocks()`, before
the flight-recorder handoff, and must leave the stable prefix untouched. Reusing
the guard is not sufficient on its own; it only refuses, it does not make
compaction safe.

### C5. Telemetry is exact and truthful.

Extend, do not repurpose. The flight recorder already carries an
`optimizationApplied` flag (`src/flight-recorder.ts:73,516`). PR-1 records real
before/after character and estimated-token counts for the compaction stage as
new fields, keyed separately from the existing regex optimizer, so savings are
measurable and attributable. Cost and usage numbers continue to derive from raw
stdout (C1), never from compressed text.

### C6. The resumed-history blind spot is documented, not worked around.

On `--continue` / `--resume` / `--conversation`, the provider CLI reloads prior
turns from its own on-disk state; the gateway never sees them
(session resolution around `src/index.ts:1520` and provider resume args). Neither
inbound nor outbound compaction can touch that context. This is a stated
limitation in the spec and in user-facing docs, not something the compressor
pretends to solve.

## 5. First PR scope (what actually ships)

A new `src/compressor/` module plus a single wiring point, all behind a
default-off config flag.

In scope:

1. `src/compressor/index.ts`: the `Compressor` interface (Section 6) and a
   `NativeCompressor` implementing it.
2. `src/compressor/router.ts`: content detection that classifies the display
   string into one of {json, log, ansi-text, plain} and dispatches. Unknown or
   risky content falls through to identity (return input unchanged).
3. `src/compressor/transforms/`: the lossless transforms only:
   - `json.ts`: parse-and-recompact valid JSON to minimal separators; identity
     on parse failure.
   - `log.ts`: collapse runs of byte-identical lines to `line (xN)`; strip
     trailing whitespace; collapse 3+ blank lines to 1. Reversible in meaning.
   - `ansi.ts`: strip ANSI escape sequences.
   - `whitespace.ts`: shared helpers.
4. Wiring: invoke the compressor in `buildCliResponse`, at the same layer as the
   existing `optimizeResponse` call (`src/index.ts:4331`), after
   `extractUsageAndCost` (`src/index.ts:4443`), guarded by
   `outputFormat !== "json"` and by the new flag. The MCP result shape
   (`content: [{ type: "text", text }]`, `src/index.ts:4423`) is unchanged.
5. The async path: apply the identical transform where a deferred job's stored
   stdout is turned into caller-facing text on `llm_job_result`, so sync and
   async return the same compressed display text. Stored raw stdout is not
   overwritten.
6. Config + telemetry per C5.

Out of scope: everything in Section 3.

## 6. Architecture

```ts
// src/compressor/index.ts
export interface CompressCtx {
  provider: string;            // "claude" | "codex" | ...
  direction: "outbound";       // "inbound" arrives in PR-2
  outputFormat: string;        // gate: skip when "json"/structured
  lossless: true;              // PR-1 is lossless-only
}

export interface CompressResult {
  text: string;                // compressed display text
  originalChars: number;
  compressedChars: number;
  transform: string;           // which route ran, or "identity"
}

export interface Compressor {
  compact(text: string, ctx: CompressCtx): CompressResult;
}
```

`NativeCompressor` is the PR-1 implementation. The interface exists now so a
later `HeadroomCompressor` (PR-4) can back the heavy transforms without touching
call sites. Native stays the default; headroom is opt-in and only for content
classes native declines to handle.

Router policy: detect, dispatch to one lossless transform, and on any doubt
return identity. Correctness beats savings. The router never sees or mutates raw
stdout (C1); it only ever receives the post-parse display string.

## 7. Configuration

- Add a provider-config key (mirroring how existing options are expressed in
  `src/config.ts`) and a request-level boolean, both defaulting to off.
- PR-1 default is off. The feature turns on only by explicit opt-in, so no
  existing caller's returned text changes on upgrade.
- Interaction with the existing `optimizeResponse` regex optimizer: the native
  compressor runs after it, on the same display string, and is independently
  flagged. They compose; neither is required for the other.

## 8. Data model

None in PR-1. Lossless-only (C3) means no dropped originals, so no store. The
content-addressed store and `gateway_retrieve` tool are specified in PR-3 only,
where the review's blocker stands: the gateway has no existing hash-keyed put/get
store to reuse. The job-store and flight-recorder have different schemas,
lifetimes, and ownership and must not be repurposed. PR-3 will add a dedicated
table with TTL and access control.

## 9. Testing and verification (merge gate)

1. Byte-identity test for C1: parsers and `extractUsageAndCost` receive identical
   input with the compressor on and off, across a fixture per provider.
2. `outputFormat === "json"` bypass test: structured responses are returned
   verbatim.
3. Round-trip meaning tests per transform: compact JSON parses to the same value
   as the original; de-duplicated logs expand to the original line multiset via
   the `(xN)` counts; ANSI stripping changes only escape sequences.
4. Sync/async parity: the same request returns the same display text through both
   `*_request` and `llm_job_result`.
5. Telemetry test: before/after counts recorded, cost/usage unchanged.
6. Off-by-default test: with the flag unset, returned text is byte-identical to
   pre-change behavior.
7. Run the repo's existing verification and the multi-LLM review gate before
   merge.

## 10. Follow-ups (named, not part of PR-1)

- PR-2: inbound compaction of `PromptParts.task` only, under C4, lossless,
  cache-safe, with a dedicated test that cache blocks and flight-recorder entries
  are byte-stable.
- PR-3: optional lossy transforms plus a dedicated content-addressed store and a
  `gateway_retrieve` MCP tool, with C2 documented (expansion costs one extra
  caller turn).
- PR-4: `HeadroomCompressor` backend behind the `Compressor` interface for
  ML-prose and AST-code content classes.

## 11. Open questions

1. Config key naming and precedence relative to the existing `optimizeResponse`
   flag.
2. Whether log de-duplication should be conservative (only exact-identical
   adjacent lines) or windowed; PR-1 proposes exact-adjacent only, for safety.
3. Estimated-token accounting: reuse `estimateTokens` (`src/optimizer.ts:26`,
   words times 1.3) for the telemetry delta, or a provider-aware estimator.

## 12. Review disposition

This spec incorporates the six blockers raised by the cross-LLM review. It does
not claim reuse of a store that does not exist, does not claim the cache guard
makes compaction safe, does not claim in-turn reversibility, does not compress
raw stdout, and does not pretend to see provider-owned resumed history. The
First PR is scoped to the one surface all three reviewers agreed is both safe and
valuable: lossless, post-parse, display-text-only outbound compaction, off by
default.
