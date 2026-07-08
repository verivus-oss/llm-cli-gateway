# Native Compressor: Research Annex

Status: evidence base for revising `docs/plans/native-compressor.spec.md`
(branch `docs/native-compressor-spec`). Part 1 is a web-research sweep (exa,
2026-07-08). Part 2 (cross-LLM independent analysis consolidation) is appended
separately.

## Part 1: Web research sweep

### 1. Formatting effects on token counts and accuracy

- https://jangwook.net/en/blog/en/llm-token-cost-data-format-experiment/ - Measured 50 flat records across 9 formats on o200k_base and cl100k: pretty JSON 4,128 tokens baseline; compact JSON -37.5%; TSV -62%; CSV -60%; Markdown table -54%; YAML -23.5%; TOML -23.1%; XML +15.7%. For nested data, tabular formats drop out and compact JSON wins at -45.7% vs pretty.
- https://curiouslychase.com/posts/yaml-vs-json-for-llm-token-efficiency-the-minification-truth/ and https://news.curiouslychase.com/p/what-if-we-actually-measured-token - Across 21 datasets, pretty JSON uses 60-90% more tokens than minified JSON; YAML is consistently 15-25% MORE tokens than minified JSON (the "YAML saves tokens" folklore comes from comparing pretty JSON to YAML).
- https://github.com/thoeltig/file-format-token-accuracy-benchmark - Compacting JSON reduces tokens ~17.6% with equivalent accuracy; JSON pretty is 1.88x the tokens of compact with similar accuracy ("formatting only adds tokens but does not increase accuracy"). XML compaction saves 11-19%.
- https://www.lockllm.com/blog/toon-vs-json - On a 500-row dataset, minified JSON scored slightly higher extraction accuracy than pretty (70.7% vs 69.7%) at ~32% fewer tokens.
- https://www.improvingagents.com/blog/best-input-data-format-for-llms/ - Counterpoint: format changes affect accuracy materially (Markdown-KV 60.7% vs CSV 44.3% on table QA); token-cheapest formats can be accuracy-worst. Argues against format conversion, not against whitespace removal within a format.
- https://arxiv.org/html/2508.13666v1 ("The Hidden Cost of Readability") - Removing non-essential whitespace from input code cuts input code tokens ~24.6% on average while Pass@1 remains stable; output tokens drop only 2.9% without prompting.

### 2. Prompt/context compression (for PR-3/PR-4)

- https://arxiv.org/html/2310.05736v2 (LLMLingua) - Perplexity-based token pruning reaches 5x compression on GSM8K with slightly higher than full-prompt EM; at 14x-20x EM drops only 1.4-1.5 points; but on BBH, 5x-7x compression costs 8.5-13.2 EM points. Quality loss is task dependent.
- https://aclanthology.org/2024.acl-long.91.pdf (LongLLMLingua) - Question-aware compression at ~4x fewer tokens improved NaturalQuestions accuracy up to 21.4% (mitigates lost-in-the-middle), cut LooGLE cost 94%; 2x-6x compression on ~10k-token prompts gave 1.4x-2.6x end-to-end latency gain.
- https://aclanthology.org/2024.findings-acl.57/ (LLMLingua-2) - Task-agnostic BERT-encoder token classification: 2x-5x compression, 3x-6x faster than prior compressors, matches or beats original prompts on MeetingBank, generalizes out-of-domain; small (mBERT-size) variant nearly matches the large one.
- https://arxiv.org/abs/2310.04408 (RECOMP) - Trained extractive/abstractive compressors for RAG compress to as low as 6% of tokens with minimal loss; extractive gets ~25% ratio at minimal drop; naive heuristic token/phrase pruning (BoW, named entities) was WORSE than no compression due to disfluency.
- Node/ONNX feasibility: https://github.com/atjsh/llmlingua-2-js (pure TS port on transformers.js, ONNX models from 57 MB TinyBERT) and https://github.com/axiomantic/llmlingua-2 (Node >= 20 TS port, int8/fp32 ONNX, lazy model download, returns a reverseMap). LLMLingua-2 in-process in Node is proven feasible.

### 3. Log-output compression practice

- https://gitauto.ai/docs/how-it-works/token-cost-management/ci-log-dedup - Production case: 39 identical Jest TypeErrors inflated a CI log to 390K chars (~100K tokens); dedup by (error message + stack content) with a kept exemplar and count brought it under 10K chars. Pipeline order: strip ANSI, strip node_modules stack frames, extract summary, then dedup.
- https://github.com/logpare/logpare - Drain template-mining: 50 unique templates repeated thousands of times compress 60-90% (one 10.8K-line example: 99.8%) via `[4,521x] INFO Connection from <*> established` template+count output; keeps sample values, first/last seen line numbers.
- https://github.com/launch-it-labs/log-reducer and https://mrwogu.github.io/logstrip/ - Convergent rule set across agent log tools: `[xN]` folding of repeated lines, stack traces folded to app frames plus `[... N framework frames omitted ...]`, caret-line removal, path shortening; transform ordering matters (mask IDs/timestamps BEFORE dedup so near-identical lines become identical). Typical claimed savings 70-95%.
- https://github.com/P156HAM/logslim - Key convention: every elision is marked in place (`(+47 similar lines omitted by logslim)`) so the agent knows data was removed and can re-run raw; measured example: 25 identical failures, ~4,300 to ~1,500 tokens (64%).
- ANSI pitfalls: https://github.com/vinhnx/VTCode/blob/e6eb807d/docs/reference/ansi-in-vtcode.md - a lexical strip_ansi is not a terminal emulator: progress bars/spinners use `\r` + `ESC[2K` + rewrite, so stripping escapes but preserving `\r` leaves overwritten frames concatenated as garbage; VTCode strips control sequences but preserves `\r\n\t`, and counts tokens only on stripped text. https://ansicode.eversources.app/en/strip covers full ECMA-48 stripping (CSI, OSC, DCS/APC/PM/SOS with BEL/ST terminators, two-byte ESC forms); lone C0 controls need a second pass. https://github.com/belt/distill-strip-ansi treats stripping as a security surface (echoback vectors OSC 52, DECRQSS, CSI 6n).

### 4. Existing compression proxies and reversibility

- https://github.com/headroomlabs-ai/headroom + https://headroomlabs-ai.github.io/headroom/ccr/ - Headroom claims 60-95% reduction; reversibility via CCR: originals cached hash-keyed locally, a `headroom_retrieve(hash)` tool injected into the model's tool list, retrieval markers in compressed output, ~1ms retrieval, TTL + max-entries store. Confirms spec C2: mid-turn recovery requires controlling the provider's tool list, which the gateway cannot do.
- https://headroomlabs-ai.github.io/headroom/ - Headroom compresses only the "live zone" (newest tool results and user message) and never mutates system prompt/tool definitions/older turns, explicitly to preserve the provider KV-cache hot zone. Directly validates spec C4.
- https://github.com/Dave-London/Pare (via openai/codex#6544) - Alternative approach: MCP servers returning lean structured JSON instead of raw CLI text, "60-92% smaller than raw output" (shrink at the source).

### 5. Token counting without a tokenizer

- https://github.com/johannschopplich/tokenx - 2 kB zero-dependency heuristic (language-aware chars/token divisors, CJK handling): ~95-98% accuracy vs real tokenizers on prose, ~4.7% deviation on 4,000 LOC of TypeScript.
- https://bulkmd.app/blog/estimating-llm-token-cost-in-the-browser - Content-aware divisors vs cl100k: prose ~3.6 chars/token, Markdown tables ~3.2, minified JSON ~3.0, Python ~2.4, TypeScript ~2.2, URLs/hashes ~2.0; a flat divisor of 4 under-counts technical content by ~40%.
- https://claudeguide.io/claude-token-counting-accurate - chars/4 is -6% on English prose but under-counts Python by 29%, JSON by 58%, HTML by 74%, Korean by 150%; structured text tokenizes at roughly 1 token per 2.5-3 chars.
- https://blog.gopenai.com/counting-claude-tokens-without-a-tokenizer-e767f2b6e632 - For Claude, Anthropic's 3.5-chars/token heuristic showed up to ~20% MAPE, tiktoken up to ~12%; simple multi-feature linear models (bytes+words+lines) hit ~0.8-2% error. The current `estimateTokens` (words x 1.3) is the weakest estimator class per https://theneuralbase.com/context-window/learn/beginner/code-file-characters-divided-by-4/ .

### 6. Evidence of risk from "lossless" reformatting

- https://arxiv.org/pdf/2411.10541 - Semantically identical prompts in different formats produce large performance variance (dramatic swings on HumanEval; up to ~40 points in related work); GPT-4-class models more robust, but format is not neutral.
- https://doi.org/10.18653/v1/2025.findings-emnlp.143 - Spacing/capitalization-only perturbations that preserve wording verbatim cause semantic inconsistency in predictions, persisting in GPT-4o.
- https://arxiv.org/html/2508.13666v1 - Gemini-1.5 asked to emit unformatted code deleted required spaces (`staticbool`), producing syntax errors; whitespace removal must be grammar-aware, never inside code semantics.
- https://ssimplifi.com/blog/prompt-cache-fingerprinting-pitfalls and https://www.waylandz.com/blog/byte-stability-prompt-cache/ - Prompt caches are byte-fragile: JSON key-reorder, a trailing newline, or serializer whitespace differences silently invalidate cached prefixes; the risk concentrates on code-generation and structured-output content.
- https://github.com/openai/codex/issues/6544 and #14206 - Codex's 10 KiB/256-line mid-content truncation caused "massive quality degradation" reports and a request to replace lossy in-place mutation with spill-to-artifact plus structured reference; issue #6426: tails must always be preserved (logs and exceptions end with the crucial stack trace).
- https://agentpatterns.ai/tool-engineering/graceful-tool-output-truncation/ - Trailing `[PARTIAL]`-style markers get ignored by models (Claude Code bug #28783: agent treated a preview as the complete file); elision markers must be structurally prominent, preferably leading.

### Actionable for PR-1

1. JSON re-compaction is the highest-value, best-evidenced transform (17.6%-42% savings on pretty JSON with equivalent or slightly better accuracy). Parse-and-reserialize with minimal separators, preserving key order and value identity; identity on parse failure. Do NOT sort keys.
2. Handle `\r` before, or together with, ANSI stripping. For log-class content, when a line contains `\r`, keep only the final segment after the last `\r` (the visually surviving frame), then strip escapes. Use a full ECMA-48 regex (CSI + OSC/DCS/APC with BEL/ST terminators), not just SGR `\x1b\[[0-9;]*m`.
3. Run-length dedup with explicit `(xN)` markers matches industry-converged practice (60-99% savings on repetitive logs). Exact-adjacent-only is the right PR-1 answer; windowed/template dedup requires value masking, which is no longer lossless.
4. Make the dedup marker unmissable and self-describing: consider a one-line leading note when any dedup fired ("N repeated lines collapsed, counts shown as (xN)") so the caller model knows the convention. Evidence says models ignore subtle trailing markers.
5. Never touch whitespace inside fenced code blocks or indented content. Safe whitespace ops (trailing-whitespace strip, collapse 3+ blank lines) outside code fences only, or restrict to the log/ansi routes and leave the plain route near-identity.
6. Replace words x 1.3 with a chars-based, content-aware estimator for telemetry (tokenx-style divisor table: prose /3.6, JSON /3.0, code /2.3, CJK ~1/char). The router already classifies content, so the divisor comes for free. Label the field "estimated".
7. Record before/after chars AND estimated tokens per transform route so savings are attributable per content class.

### Actionable for PR-2/3/4

1. PR-2: byte-stable-prefix design validated by headroom's live-zone-only architecture and cache-fingerprinting failure catalogs. Add a golden-file byte-snapshot test of assembled cache blocks; compress only `PromptParts.task`, never anything ahead of a cache breakpoint.
2. PR-3: leading, structurally distinct elision markers naming the retrieval tool, the hash, what was dropped (head/tail/middle), and original size; always preserve tails of logs/stack traces; spill-to-store with a structured reference beats inline head+tail mutation. Hash-keyed store with TTL and max entries mirrors headroom CCR. Retrieval costs one extra caller turn (C2).
3. PR-3 lossy transform choice: prefer extractive over abstractive first (RECOMP: heuristic pruning was worse than nothing; trained extractive safe at ~25% ratio). For logs, Drain-style template mining (logpare, MIT, JS) gets 60-90% and is nearly deterministic; consider before any ML.
4. PR-4: LLMLingua-2 is the right ONNX target (task-agnostic, 2x-5x compression at minimal loss, two existing Node ports with int8 ONNX models down to 57 MB). Expect task-dependent quality loss; keep the rate conservative (0.5-0.7) by default.

### Do NOT do

- Do not convert between formats (JSON to CSV/TSV/YAML/TOON) even where it saves 50-60%: format changes measurably move accuracy by 10-16+ points, task-dependently. Whitespace-only compaction within the original format is the evidence-safe zone.
- Do not sort or reorder JSON keys: no token or accuracy benefit; breaks byte-stable caching and diff/fingerprint expectations.
- Do not touch whitespace inside code blocks or apply remove-all-spaces compaction to code (staticbool failure mode; Python indentation is semantics).
- Do not use words x 1.3 or flat chars/4 for anything user-visible: 30-58% under-count on code/JSON, up to 150% on CJK, and under-counting is the harmful direction.
- Do not strip ANSI with a naive SGR-only regex, and do not preserve raw `\r` in cleaned output.
- Do not do naive heuristic token dropping (stopword/BoW pruning) in PR-3: measured worse than no compression.
- Do not rely on trailing elision markers for anything dropped in later PRs; models treat the visible prefix as complete.
- Do not truncate middles of logs/stack traces if truncation is ever added: tails carry the diagnosis.

## Part 2: Cross-LLM independent analysis (Codex, Gemini, Grok, Mistral, 2026-07-08)

Four independent research/analysis jobs ran via the gateway (correlationIds:
codex 77c5b1d5-2a36-462a-8320-0408e2c750d4, gemini
79021e06-c2b7-4096-9ed7-ba83a6054daf, grok
57522c65-f98e-418d-ab79-9c45b57c0b9d, mistral
4254638f-87ef-4428-b60c-aed98abe9194). Full texts are persisted in the flight
recorder; read back with `llm_request_result` by correlationId. All four left
the spec's architecture and constraints C1-C6 intact; nobody challenged the
off-by-default posture.

### Consensus (3+ models)

1. The `words x 1.3` estimateTokens heuristic is untrustworthy for JSON/logs/code and must not be the basis of savings claims. Record exact chars/bytes always; add real tokenizer counts where feasible; billed usage derives from raw stdout only. (All 4; agrees with Part 1 section 5.)
2. Code-block and inline-literal protection is mandatory in every transform; bytes inside fences untouched; identity on any classification doubt. (All 4; agrees with Part 1.)
3. The bare `(xN)` suffix sentinel is too ambiguous: it collides with plausible real output and breaks exact-match/line-count logic downstream. Use a distinctive bracketed or versioned sentinel. (Codex, Gemini, Mistral; Grok dissents.)
4. Do not overload the existing `optimizationApplied` boolean; record the compressor's route/transform list as separate additive telemetry, independently flagged from the regex optimizer. (All 4.)
5. Keep compression strictly out of validation/receipt hashing paths; hashes are computed on canonical raw material, never compressed read-back. Gemini located `ValidationReceiptRecord.canonicalSha256`; Codex verified the receipt path hashes structured reports, not inline raw responses. (Codex, Gemini, Grok.)
6. Exact-adjacent-only dedup is right for PR-1 (Mistral adds a run-length cap; Codex additionally wants exact-match block-level dedup for repeated stack traces).
7. Sync/async parity via a single shared compression function applied at display-construction time in both paths; stored raw stdout never overwritten. (All 4.)
8. PR-2 inbound compaction must be proven with a byte-stability test on cache blocks and stable prefix hashes before implementation; the slice-kappa guard alone is not sufficient. (Codex, Grok, Mistral.)

### Resolved disagreements (consolidation verdicts)

1. JSON re-compaction mechanism. Codex: `JSON.parse` + `JSON.stringify` is NOT lossless (`-0` becomes `0`, big-integer precision loss, exponent respelling, integer-like key reordering, escape respelling) and called it the biggest correctness issue in the draft; Gemini/Mistral accepted parse+stringify; Grok in between. VERDICT: Codex is right, and this supersedes Part 1's "parse-and-reserialize" wording. Use a whitespace-only JSON lexer (token-preserving minifier): nearly all the savings, none of the semantic risk. A round-trip deep-equality gate cannot catch `-0` or big-int loss because both sides parse to the same lossy value.
2. ANSI stripping. VERDICT: strip conservatively with full ECMA-48 coverage, add CR-overwrite collapsing (keep the final visible frame of `\r`-rewritten lines plus a count), and skip entirely on cursor-movement/alt-screen sequences. Color can encode meaning (pass/fail, diff polarity) and OSC 8 hyperlinks carry URLs; scope the transform to the log/terminal content class. (Aligns with Part 1 section 3.)
3. Sentinel shape. VERDICT: full-line, versioned, greppable ASCII sentinel (Codex's shape, e.g. `[[gateway-repeat:v1 lines=18 count=4]]`) with an escaping rule for input lines that already match the prefix, plus a one-line leading note when any folding fired. Reject XML-ish tags (collide with real XML/HTML output) and bare `(xN)`. One sentinel grammar should be designed now to also cover PR-3 elision/retrieval markers.
4. Tokenizers in PR-1. VERDICT: exact chars/bytes in prod telemetry, a content-aware divisor estimate labeled "estimated" (Part 1 section 5), and a dev-flagged real-tokenizer path for fixture benchmarking. No new prod dependencies; never publish heuristic numbers as savings.
5. JSON key sorting (Gemini suggestion). VERDICT: rejected. Byte churn for zero token gain; conflicts with the lexer approach; cache-fingerprinting literature says reorder is harmful.

### Repo-inspection finds (verify during implementation)

- Codex: `llm_job_result` pretty-prints a large gateway-owned JSON envelope (src/index.ts:12299 area). Compacting that wrapper while preserving embedded stdout strings is possibly the single highest-yield, lowest-risk PR-1 item, since the gateway owns that JSON.
- Codex: MCP hosts may include BOTH `content[0].text` and `structuredContent.response` in model context; compressing only one doubles cost. Compress once in a shared `compressDisplayText()` before both are constructed, after provider display extraction and redaction.
- Grok: the async flight-recorder `logComplete` path hardcodes `optimizationApplied: false` in places; compressor telemetry must be explicitly threaded through the async path (fix while wiring).
- Grok: display swaps happen before the optimize step (Codex JSONL and Grok streaming-JSON to final text around src/index.ts:4316-4328); Grok thought deltas are excluded from display text by the parser and compression must not re-expose them.
- Mistral: skip compression whenever a declared outputSchema exists, not just `outputFormat === "json"`. Also proposed six additive `compression_*` flight-recorder columns and a sanity alert when token and char savings diverge >20%.
- Gemini: lossy PR-3 plus provider-side resume creates a "dual reality" (provider CLI sees raw history, orchestrator saw compressed); belongs in the C6 documentation. Timestamp/UUID masking as a PR-3 pre-pass so dedup fires on real logs.
