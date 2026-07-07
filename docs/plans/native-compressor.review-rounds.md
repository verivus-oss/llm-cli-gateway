# Native Compressor spec: cross-LLM review round log

Gate: four-model adversarial review (Codex, Gemini, Grok, Mistral) of
`docs/plans/native-compressor.spec.md` + `docs/plans/native-compressor.research-annex.md`.
Rule: iterate to unconditional approval or a named unresolvable blocker.
Reviewers verify against the source tree in
`/srv/repos/internal/verivusai-labs/rvwr/.sqry-worktrees/native-compressor`
(src/ identical to master@dec94cc).

## Round 1 (2026-07-08, spec commit eb24a4c)

Correlation ids: codex 39fb4575-6bd2-4d4e-9678-5ba9d69723e7, gemini
4bf84bfb-f9b8-47fa-b50b-1e437083378a, grok
bc4c5c27-bc69-409e-8fab-af2c6b173110, mistral
37513f1a-94b0-4a80-be0e-2d881c42c7b2 (full texts in the flight recorder via
`llm_request_result`).

Verdicts: Codex BLOCKERS (5 blockers, 2 majors); Gemini BLOCKERS (2
blockers, 1 major); Grok BLOCKERS (2 majors, 1 minor, citations verified
clean); Mistral BLOCKERS (1 blocker, 3 majors, 2 minors).

Findings and dispositions (spec sections cite the round-2 revision):

| # | Raised by | Finding | Disposition |
|---|-----------|---------|-------------|
| R1-1 | Codex B1, Grok m3 | "Lossless" claim contradicted by ANSI strip / CR collapse / whitespace ops (not reconstructible from output) | ADOPTED: C3 reframed as content-preserving with three named tiers (B byte-preserving, F counted folds, P presentation-discarding) and read-back recovery; all "lossless" absolutes rewritten |
| R1-2 | Codex B2, Gemini B1, Grok M2 | Claude stream-json async: raw NDJSON stays in `result.stdout`; compressing `parsed.text` alone defeats the feature | ADOPTED: 5.2 specifies the Codex-precedent display swap (`result.stdout` := `parsed.text`) under the compression flag, then compression; matrix 9 covers it |
| R1-3 | Codex B3 | `outputSchema` bypass unenforceable at read-back (param not persisted) | ADOPTED: 5.2 persists the EFFECTIVE enqueue-time decision in `compress_response`; read-back honors it without reconstructing params |
| R1-4 | Codex B4 | Async dedup can pair compressed and uncompressed requests onto one job | ADOPTED: 5.2 folds the effective decision into `buildRequestKey` per the Codex `outputFormat` precedent; matrix 9 asserts both collision directions |
| R1-5 | Codex B5, Gemini B2 | Compression telemetry cannot travel through `logComplete` (completion already finalized on the Claude stream-json sync path and on the async path) | ADOPTED: Section 8 adds `recordCompressionTelemetry` (additive, compression_* columns only, write-once); 5.1 threads `CompressResult` out of `buildCliResponse` on `ExtendedToolResponse` |
| R1-6 | Codex M6, Mistral note | C7 "logs raw job.stdout" imprecise (codexFrResponse reconstruction; codex sync site too) | ADOPTED: C7 item 4 and 5.3 rewritten; codex sync site (index.ts:8663) cited |
| R1-7 | Codex M7, Grok note | "Three JobStore implementations" false on this base (Postgres stub throws, job-store.ts:944-955) | ADOPTED: 5.2 and Section 8 state SQLite + memory real, stub gets interface types, re-verify at implementation |
| R1-8 | Gemini M3 | C1 "extractUsageAndCost consumes raw stdout" false for Claude stream-json sync (receives parsed.text) | ADOPTED: C1 restated as byte-identity framing with the pre-existing nuance documented; C7 item 2 updated |
| R1-9 | Grok M1 | Matrix item 8 mirror-equality absolute is false under the worktree banner (content[0].text only) | ADOPTED: 5.1 and matrix 8 qualified (equal modulo documented banner; banner outside compressor) |
| R1-10 | Mistral B1 | 5.1 diagram conflates `finalStdout` variable with its role | ADOPTED: diagram rewritten as explicit reassignments |
| R1-11 | Mistral M2 | 5.3 flight-recorder site enumeration incomplete | ADOPTED: complete per-provider list (gemini/grok/devin/cursor/mistral/claude x2/codex/async) with verified lines |
| R1-12 | Mistral M3 | Lit-escaping "not invertible for multi-line input" | REBUTTED: per-line encode/decode (strip exactly one prefix) is a bijection; multi-line blocks decode to the exact original byte sequence; no block-level information exists to lose. Spec now states the decode rule explicitly (6.4) and matrix 5 tests the multi-line case, so the property is checkable rather than asserted |
| R1-13 | Mistral M4 | Router-vs-ANSI-skip layering ambiguous (dangerous sequences should divert at classification) | ADOPTED: 6.2 makes the dangerous-sequence check part of classification (identity route directly); transform-side check kept as defense in depth |
| R1-14 | Mistral m5 | No test for fenced blocks containing sentinel-like text | ADOPTED: matrix 7; 6.4 states escaping never applies inside fences |
| R1-15 | Mistral m6 | API-provider deviation absent from C7 | ADOPTED: C7 scope note added |
| R1-16 | Gemini note | Lit escape without any fold leaves an unexplained marker | ADOPTED: leading note fires on ANY marker incl. lit-only (6.4, matrix 5) |
| R1-17 | Gemini note | PR-3 lossy mode desyncs offset-referencing annotations | ADOPTED: Section 10 PR-3 bullet |
| R1-18 | Grok note | "Three narrow wiring points" undersells the surface | ADOPTED: 5.5 replaced with an honest wiring inventory |
| R1-19 | Mistral note | Divisor table should cite the annex section | ADOPTED: Section 8 cites annex Part 1 section 5 |

## Round 2 (2026-07-08, pending)

Packet: revised spec (this commit), diff vs eb24a4c, this round log.
Question to reviewers: verify the round-1 dispositions against the revised
text and the source, including the R1-12 rebuttal; unconditional approval or
new concrete blockers.
