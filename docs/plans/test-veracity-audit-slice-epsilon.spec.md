# Test-veracity audit — slice ε (Gemini `-o stream-json` enum widening)

## Scope

You are auditing the **veracity of the tests** added across the commits on
branch `feat/phase-4-slice-e-gemini-stream-json` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits at
v1.9.0 (`b27dd64`).

The branch ships as v1.10.0. This audit answers: **do the new tests prove
what they claim, and would they go red if the feature broke?**

Slice ε is small (one enum value extended through Zod, prepare-function
argv, NDJSON parser path, contract enum, two fixtures). Test count is
small too — the protocol applies anyway per the standing test-veracity
rule (`feedback_test_veracity_audit_protocol.md`).

## Files under review

```
src/gemini-json-parser.ts                                   # MODIFIED: parseGeminiStreamJson NDJSON parser added
src/index.ts                                                # MODIFIED: outputFormat enum widening (3 sites), argv emission branch, extractUsageAndCost branch
src/upstream-contracts.ts                                   # MODIFIED: gemini `-o` enum widened to include "stream-json"; 2 new conformance fixtures
src/__tests__/gemini-json-parser.test.ts                    # MODIFIED: parseGeminiStreamJson coverage
src/__tests__/test-veracity-regressions-slice-epsilon.test.ts  # NEW: REGRESSIONS Eα–Eζ (mutation-probe-friendly)
```

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD --stat
git diff master..HEAD -- src/gemini-json-parser.ts src/upstream-contracts.ts

# What every reviewer must replicate:
npm run build
npm test
npm run format:check
```

## Implementation surface to verify

1. **Zod enum** at `src/index.ts` `gemini_request` (~line 4533) and
   `gemini_request_async` (~line 5436) — both now accept
   `"text" | "json" | "stream-json"`. Pre-slice value was `"text" | "json"`.
2. **`prepareGeminiRequest` argv emission** (~line 1890): now branches
   on `outputFormat === "stream-json"` and pushes `["-o", "stream-json"]`.
   No `--include-partial-messages` analogue is needed (per inline comment
   citing `CLI_IDLE_TIMEOUTS.gemini` at line 475 — Gemini already
   streams stdout in real-time across all output modes).
3. **`extractUsageAndCost`** at `src/index.ts:765` now routes to
   `parseGeminiStreamJson` when `cli === "gemini" && outputFormat === "stream-json"`.
4. **`parseGeminiStreamJson`** in `src/gemini-json-parser.ts`: NDJSON
   reader that picks up assistant `delta`-message text into `response`
   and reads the terminal `result.stats` event for usage tokens
   (`input_tokens`, `output_tokens`, `cached` → `cache_read_tokens`).
5. **`UPSTREAM_CLI_CONTRACTS.gemini.flags["-o"].values`** in
   `src/upstream-contracts.ts:304`: widened from `["json"]` to
   `["json", "stream-json"]`.
6. **Conformance fixtures** added at the bottom of the gemini contract
   block: a passing `gemini-stream-json` fixture exercising `-o stream-json`,
   and a failing `gemini-output-format-invalid` fixture for `-o ndjson`.

## What each test CLAIMS to prove

For each test under review, you must independently confirm or deny:
(a) **the implementation surface it exercises** — what code path actually runs?
(b) **the falsifiability** — if the feature were broken in plausible ways, would this test go red?
(c) **the durability** — does the test depend on implementation details that could change without breaking the feature?
(d) **a counterexample probe** — try to construct a code change that breaks the feature but leaves this test green.

### Test set Eα — Zod enum widening (registered tool inputSchema)

Mirrors the REGRESSIONS A/E pattern from `test-veracity-regressions.test.ts`:
inspect the *registered* tool's Zod schema, not a bare schema constant.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Eα-1 | `gemini_request.outputFormat accepts "stream-json"` | registered schema field returns success=true on the new enum value | `getRegisteredToolSchema("gemini_request").shape.outputFormat.safeParse("stream-json")` | None — tests the actual MCP surface |
| Eα-2 | `gemini_request_async.outputFormat accepts "stream-json"` | same for async tool | same with `gemini_request_async` | same |
| Eα-3 | both registrations still reject `"ndjson"` and `"event-stream"` | regression guard against accidental widening | `safeParse("ndjson")` → success=false | catches over-broad `z.string()` |

**Counterexample probes you must run:**
- **P-Eα-1**: Revert the sync tool's Zod schema to `z.enum(["text","json"])`. Eα-1 must go red.
- **P-Eα-2**: Revert the async tool's Zod schema to `z.enum(["text","json"])`. Eα-2 must go red, Eα-1 stays green (proves sync-vs-async are independently pinned).
- **P-Eα-3**: Loosen ONE of the registrations to `z.string()`. Eα-3 must go red on that variant.

### Test set Eβ — `prepareGeminiRequest` argv emission

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Eβ-1 | `prepareGeminiRequest({outputFormat:"stream-json"})` emits `-o stream-json` | adjacent token pair in args | `prepareGeminiRequest(...).args` | None — direct argv inspection |
| Eβ-2 | `outputFormat:"json"` still emits `-o json` (regression pin) | same code path, prior behaviour intact | same | None |
| Eβ-3 | `outputFormat:"text"` (default) emits no `-o` token at all | absence | same | None |
| Eβ-4 | argv passed to `validateUpstreamCliArgs` returns ok=true (REGRESSIONS D-style) | prepare → contract end-to-end consistency | `validateUpstreamCliArgs("gemini", prep.args)` | Closes the contract-table gap that bit slices α/γ/δ |

**Counterexample probes you must run:**
- **P-Eβ-1**: Remove the `else if (params.outputFormat === "stream-json")` branch in
  `prepareGeminiRequest`. Eβ-1 must go red; Eβ-2 stays green.
- **P-Eβ-2**: Change emission to `args.push("-o", "ndjson")`. Eβ-1 must go red
  with a "stream-json not found" message, AND Eβ-4 must go red with a
  contract-violation message.
- **P-Eβ-3**: Add `"stream-json"` to the Zod enum but FORGET to widen
  `UPSTREAM_CLI_CONTRACTS.gemini.flags["-o"].values`. Eβ-4 must go red.
  (This is the exact slice α/γ/δ regression class — the falsifiability
  probe Werner mandated after slice δ.)

### Test set Eγ — `parseGeminiStreamJson` NDJSON parser

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Eγ-1 | parses NDJSON with init + assistant deltas + result.stats → usage + response | happy path | direct call | None |
| Eγ-2 | extracts `cached` → `cache_read_tokens` when present | cache token capture | direct call | None |
| Eγ-3 | omits `cache_read_tokens` when `stats.cached` is missing | regression pin | direct call | None |
| Eγ-4 | concatenates multiple assistant `delta` messages into single `response` | streaming text assembly | direct call | None |
| Eγ-5 | ignores non-JSON banner lines (`"Warning: True color..."`, `"Ripgrep..."`) | observed real-CLI noise | direct call with mixed input | None |
| Eγ-6 | returns null on empty / all-blank input | edge case | direct call | None |
| Eγ-7 | returns null when NO line parses as JSON | edge case | direct call | None |

**Counterexample probes you must run:**
- **P-Eγ-1**: In `parseGeminiStreamJson`, change `event.type === "result"` to
  `event.type === "complete"`. Eγ-1, Eγ-2, Eγ-3, Eγ-4 lose usage data → red.
- **P-Eγ-2**: Drop the `event.role === "assistant"` guard so user-echo messages
  also get appended. Eγ-4 catches the regression (response would contain
  both user input and assistant output).
- **P-Eγ-3**: Change `stats.cached` to `stats.cache_read_tokens` (the WRONG
  Gemini field name). Eγ-2 must go red (cache value not extracted).
- **P-Eγ-4**: Remove the `try/catch` around `JSON.parse(trimmed)`. Eγ-5 must
  throw / fail.
- **P-Eγ-5**: Change `if (!sawAnyLine) return null` to `return result`. Eγ-6
  and Eγ-7 must go red (now returns `{}` instead of `null`).

### Test set Eδ — `extractUsageAndCost` routing

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Eδ-1 | `extractUsageAndCost("gemini", ndjson, "stream-json")` returns input/output/cache tokens | router branches correctly | `extractUsageAndCost(...)` | None |
| Eδ-2 | `extractUsageAndCost("gemini", json_obj, "json")` still returns usage (regression pin) | pre-slice behaviour | same | catches accidental refactor breakage |
| Eδ-3 | `extractUsageAndCost("gemini", ndjson, "json")` → returns {} (wrong parser; protects mis-routing) | regression guard | same | catches a swap of the two parsers |

**Counterexample probes you must run:**
- **P-Eδ-1**: Swap the parser calls (route `"json"` to `parseGeminiStreamJson`
  and `"stream-json"` to `parseGeminiJson`). Eδ-1, Eδ-2, Eδ-3 all go red in
  different ways → confirms routing is pinned.
- **P-Eδ-2**: Remove `outputFormat === "stream-json"` from the branch
  condition. Eδ-1 must go red (returns {} instead of usage).

### Test set Eε — UPSTREAM_CLI_CONTRACTS gemini -o enum + fixtures

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Eε-1 | `validateUpstreamCliArgs("gemini", ["-p","x","-o","stream-json"])` ok=true | contract accepts widened enum | `validateUpstreamCliArgs` | None |
| Eε-2 | `validateUpstreamCliArgs("gemini", ["-p","x","-o","ndjson"])` ok=false | contract still rejects unknown enum members | same | catches accidental enum widening to `z.string()` |
| Eε-3 | `UPSTREAM_CLI_CONTRACTS.gemini.flags["-o"].values` includes `"stream-json"` | direct contract introspection | direct read | None |
| Eε-4 | `gemini-stream-json` conformance fixture is reached by the bundled fixture-iteration test | REGRESSIONS F-style coverage | iterate `gemini.conformanceFixtures` | None |

**Counterexample probes you must run:**
- **P-Eε-1**: Remove `"stream-json"` from the `values` array in
  `src/upstream-contracts.ts`. Eε-1, Eε-3, Eε-4 must all go red.
- **P-Eε-2**: Widen `values` to omit the enum entirely (`values: undefined`,
  arity stays "one"). Eε-2 must go red — the contract now accepts arbitrary
  string tokens.
- **P-Eε-3**: Delete the `gemini-stream-json` fixture from the
  `conformanceFixtures` array. Eε-4 must go red.

### Test set Eζ — REGRESSIONS F gemini coverage map (extends test-veracity-regressions.test.ts)

The existing REGRESSIONS F test in `src/__tests__/test-veracity-regressions.test.ts`
has a PREAUDIT_BASELINE entry for `gemini` that contains `"-o"`. That
baseline was the grandfathered list from slice δ — it ENFORCES that
NEWLY-added flags must come with a fixture, but pre-existing flags are
tolerated. `-o` is grandfathered.

For slice ε we are not adding a new flag — we are widening the enum on
an existing flag. So REGRESSIONS F continues to pass without
modification. **Verify that this is the case** (i.e., no flag we added
needs to be added to PREAUDIT_BASELINE).

If the audit finds that REGRESSIONS F's grandfathered baseline must
change for slice ε, that is a separate finding worth flagging.

## What this audit does NOT cover

Explicitly NOT in scope (raise as findings if you disagree):

1. **No live-CLI integration test** of `-o stream-json` against a real
   `gemini` binary. The audit verifies unit-level behaviour of the parser,
   argv, and contract layer. Live integration is gated on `integration.test.ts`,
   which is run separately.
2. **No test of the runtime path** that calls `gemini_request` end-to-end
   with `outputFormat:"stream-json"` and asserts the flight recorder row
   has non-null `input_tokens` etc. The handler-test surface is
   `src/__tests__/gemini-handler.test.ts`; we are not adding a stream-json
   integration there because the existing handler tests stub the executor.
3. **No bench-fairness probe** for stream-json idle-timeout behaviour
   (Gemini's `CLI_IDLE_TIMEOUTS.gemini = 600_000` already covers it; no
   new constant was added).

## Round expectations

- **Round 1**: 4 LLMs (Codex, Gemini, Grok, Mistral; Claude as substitute
  if any are quota-exhausted or stall) launched async via gtwy MCP with
  the permission flags + MCP-server lists documented in
  `feedback_test_veracity_audit_protocol.md`. Each MUST:
  - Read the spec and the actual commit diff (`git diff master..HEAD`).
  - Run each P-Eα/β/γ/δ/ε probe (mutate → re-run `npm test --
    src/__tests__/test-veracity-regressions-slice-epsilon.test.ts
    src/__tests__/gemini-json-parser.test.ts` → observe colour →
    `git checkout -- src/` to restore → report).
  - Cite file:line for any disagreement; assertion-style verdicts are
    inadmissible.

- **Approval criterion**: Each probe produces a red test as predicted.
  No probe leaves the suite green when the feature is broken.

## Your output format

Per test (Eα-1 .. Eζ): `[VERIFIED / FAIL / SKIP]` + one-sentence why, with file:line.
Per probe (P-Eα-1 .. P-Eε-3): `[as predicted / surprising — explain]`.
Gaps section: any remaining gap with the smallest test that would close it.
Overall: **UNCONDITIONAL APPROVE** or **REJECT (concrete blocker: file:line)**.

Be terse. Cite, don't summarize. Trust your own inspection of the repo, not this spec.
