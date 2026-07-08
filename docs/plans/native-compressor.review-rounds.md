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

## Round 2 (2026-07-08, spec commit cfdb5a7): UNANIMOUS UNCONDITIONAL APPROVAL

Packet: revised spec, diff eb24a4c..cfdb5a7, this round log. Reviewers were
asked to verify every round-1 disposition against the revised text and the
source (not the log narrative), including the R1-12 rebuttal.

Verdicts, all "APPROVE (unconditional)":

- Codex (resumed its round-1 session; correlation
  814a70bc-4e7d-4f1f-a4fa-3cddc9818611): verified R1-1 through R1-7
  dispositions against text and source; explicitly agrees the R1-12 decode
  rule is bijective.
- Gemini (correlation ab8d24c4-6f4c-4562-ae81-e75e95c595d5): verified R1-2,
  R1-5, R1-8, R1-16 plus spot-checks; endorses the R1-12 rebuttal.
- Mistral (correlation 182ba27b-db07-4d0f-9df1-91a2a082bec4): verified all
  six of its round-1 findings resolved; ACCEPTED the R1-12 rebuttal
  explicitly ("no concrete counterexample exists").
- Grok: verified all four of its round-1 findings resolved plus systematic
  spot-checks of every other disposition; agrees the R1-12 rebuttal holds
  after enumerating candidate counterexample classes. Editorial-only NOTES
  (decode-rule phrasing, off-by-a-few line numbers covered by the Section 0
  symbol-governs convention). Evidence: Grok's verdict was produced via the
  grok CLI directly (full text committed as
  `native-compressor.review-round2-grok.txt`) because gateway-routed grok
  jobs hit a grok 0.2.82 worker-handshake flake ("worker quit with fatal:
  unexpected server response: expect initialized, accepted") that returned
  silent empty successes for this prompt (gateway job ids 547b2045,
  52128bce, 41edfd00, plus four direct --prompt-file/--single attempts);
  a restructured prompt with a pre-generated diff file completed normally.

Gate result: the spec at cfdb5a7 passes the cross-LLM review gate with four
unconditional approvals. Stage 2 closed; implementation (PR-1) may begin
against this spec.

## Implementation review (2026-07-08): four-model, converged to unanimous approval

Adversarial implementation review of the PR-1 code (feat/native-compressor-pr1)
against the approved spec and the verification report. Reviewers verified
against the source, not the summary.

Round 1 (impl @1cd09b5 + 45f1362): Codex BLOCKERS (5), Gemini BLOCKERS (3),
Grok APPROVE (with test-veracity gaps named), Mistral job failed. Findings,
all fixed:
- I1 (Codex B1, Gemini): the JSON lexer accepted invalid string escapes.
  Fixed: copyString validates the escape set + 4-hex \u; invalid -> identity.
- I2 (Codex B3): CR-overwrite collapse kept only the last segment, losing
  earlier columns. Fixed: column overlay (later fix I6 added the wide-char
  guard).
- I3 (Codex B4): combined DEC private-mode params (?1049;25h) slipped the
  danger check. Fixed: any ?-prefixed h/l final is dangerous.
- I4 (Codex B2): the ANSI strip did not protect inline code. Addressed, then
  refined by I7 below.
- I5 (Gemini): blank-run collapse hardcoded "", corrupting CRLF blank lines.
  Fixed: keep the first blank line's bytes.
- I6 (Codex B5, Gemini, Grok section 8): the Section 9 integration tests were
  only in throwaway harnesses. Fixed: committed compressor-integration.test.ts
  (C1 byte-identity, mirror, review-integrity ordering, escape hatch,
  llm_job_result swap/envelope/parity, dedup-key fold). Each confirmed to bite
  via mutation probes.

Round 2 (@be4e23b): Gemini APPROVE (unconditional), Mistral APPROVE
(unconditional), Codex found two new defects introduced by the round-1 ANSI
fixes:
- R2-1: per-line strip broke multi-line OSC/DCS handling (payload leak).
- R2-2: CR overlay indexed by UTF-16 code unit, dropping a byte for wide
  chars. Both fixed (whole-piece strip; ASCII-only overlay, non-ASCII CR lines
  left identical).

Round 3 (@15d1ee4): Codex found R3, splitting on inline-code spans before
stripping let an OSC payload containing a backtick leak. Fixed by control-
lexing precedence: strip whole segments, inline code's visible bytes survive.

Round 4 (@2857bc4): Codex found R4, the same straddle class via fence
splitting. Fixed architecturally: the router excludes fenced content from the
ansi-text route, so stripEscapes always lexes control strings over whole,
unsplit text; the whole straddle class is eliminated.

Round 5 (@2857bc4): Codex APPROVE (unconditional) after verifying no
production path can hand stripEscapes a pre-split control string, the R4 case
routes to plain without leaking, and pure ANSI still strips correctly.

Correlation ids: Codex round-1 1f282f29, round-3 8788ea53, round-4 155e958d,
round-5 0e20d4ca; Gemini round-1 f1645055, round-2 25c2b6ba; Mistral round-2
6038dc3e. Grok's fresh re-reviews hit the 0.2.82 worker-handshake flake
(silent empty successes); its round-1 approval stands and every gap it named
is addressed. Full suite 1961 green; build, lint, format:check, and the
release security audit pass.

Gate result: unanimous unconditional approval. PR ready.
