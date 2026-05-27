# Final review — slice κ + 7 recommendations (`feat/phase-4-slice-kappa`)

## Scope

You are reviewing the **entire** `feat/phase-4-slice-kappa` branch
(three commits on top of `master` @ `5f1b50d`):

| SHA       | Subject                                                              |
|-----------|----------------------------------------------------------------------|
| `a81aa5f` | feat(claude): slice κ — emit cache_control via --input-format stream-json |
| `1bda5fc` | feat(claude): rec #1/#5/#7 + post-review test strengthening          |
| `001def3` | feat(claude): rec #2/#3/#4/#6 — auto cache_control + warnings + stats + smoke script |

Head of branch: `001def3`.

The branch ships as **v1.14.0**. This review answers:

> **Does the code, on disk, match every claim made in the commit
> messages and the prior spec — and would the regression suite go red
> if any of those claims broke?**

Do NOT accept the author's summary, commit message, or earlier spec
text as evidence. Open the files yourself. Run the tests yourself.
Run the mutation probes yourself. Cite **file:line** for every verdict.

---

## Reproducibility commands (run these first)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git fetch
git log --oneline 5f1b50d..001def3
git diff --stat 5f1b50d..001def3
git diff 5f1b50d..001def3 -- src/ docs/plans/ package.json
npm run build
npm test
npm run lint
npm run format:check
```

Baseline expectation: build clean, **926 tests pass**, format clean,
lint emits warnings only on `*.test.ts` files (pre-existing ignore
pattern noise, not new errors).

---

## Files changed (master..HEAD)

```
docs/plans/slice-kappa-captures/                            # NEW: live smoke evidence (anthropic 400, FR rows, smoke results, README)
docs/plans/slice-kappa-smoke-test.mjs                       # NEW + MODIFIED (rec #6): SMOKE_CACHE_CONTROL gate
docs/plans/slice-kappa.spec.md                              # NEW: original audit spec for slice κ
docs/plans/slice-kappa-final-review.spec.md                 # NEW: this spec (review of review)
package.json                                                # MODIFIED (rec #6): smoke:cache-control script
src/__tests__/test-veracity-regressions-slice-kappa.test.ts # NEW: Kα/Kβ/Kγ/Kδ/Kε + Kβ-9 + Kζ-1..8 = 40 tests
src/async-job-manager.ts                                    # MODIFIED: stdin?+dedup-key + cacheControlBlocks plumbing
src/config.ts                                               # NO change in this branch (rec #2 reads existing emit_anthropic_cache_control)
src/cache-stats.ts                                          # MODIFIED (rec #3): GlobalCacheStats gains 5 derived metrics
src/executor.ts                                             # MODIFIED: ExecuteOptions.stdin? threading
src/flight-recorder.ts                                      # MODIFIED: migration v4 + cache_control_blocks column
src/index.ts                                                # MODIFIED: rec #1/#2/#4/#5/#7 + κ branch + handler threading
src/prompt-parts.ts                                         # MODIFIED: PromptPartsCacheControl + assembleClaudeCacheBlocks
src/upstream-contracts.ts                                   # MODIFIED: arity "optional", --input-format, claude-input-format-stream-json fixture
```

---

## Per-claim verification matrix

For each claim below, **open the file at the cited line**, confirm or
refute, and cite `file:line` in your report.

### A. Slice κ feature (commit `a81aa5f`)

**A1. PromptParts.cacheControl schema** at `src/prompt-parts.ts:32-46`
- `PromptPartsCacheControl` exposes only `system?`, `tools?`,
  `context?` (NOT `task`).
- `PromptPartsSchema.cacheControl` is `.strict()` and `.optional()`.
- Boolean-typed; non-boolean values rejected.

**A2. assembleClaudeCacheBlocks helper** at `src/prompt-parts.ts:133-167`
- Emits content blocks in `system → tools → context → task` order.
- Empty parts are skipped via `if (value === undefined || value.length === 0) continue`.
- Each marker is exactly `{type:"ephemeral", ttl:"1h"}`.
- The `task` block is appended last and is NEVER marked.
- `markedBlockCount` increments only on non-empty marked stable parts.

**A3. prepareClaudeRequest κ branch** at `src/index.ts`
(post-1bda5fc + 001def3, look for `cacheControlRequestedEarly` and the
`cacheControlRequested` const further down).
- Detection: explicit caller opt-in via `cacheControlRequestedEarly`.
- When activated, argv is exactly
  `["-p", "--input-format", "stream-json", "--output-format",
  "stream-json", "--include-partial-messages", "--verbose", ...]`
  with NO positional prompt.
- `stdinPayload` is `JSON.stringify(payload) + "\n"`.
- `cacheControlBlocks` is the marker count.
- When `params.outputFormat !== "stream-json"` AND cacheControl
  requested, an `ExtendedToolResponse` error is returned (regex:
  `/outputFormat.*stream-json/i`).

**A4. Upstream contract changes** at `src/upstream-contracts.ts`
- `CliFlagArity` includes `"optional"` (line ~12).
- `flags["-p"].arity === "optional"` (~line 109).
- `flags["--input-format"]` exists, `arity:"one"`,
  `values:["text","stream-json"]` (~line 115).
- `validateUpstreamCliArgs` handles `optional` arity at ~line 876:
  consumes the next token as a value iff it does not start with `-`.
- Conformance fixture `claude-input-format-stream-json` exists with
  pinned args (~line 245).

**A5. Executor stdin** at `src/executor.ts`
- `ExecuteOptions.stdin?: string` documented as κ-only optional payload.
- `executeCli`: when `stdin` is set, `stdio[0]` switches from
  `"ignore"` to `"pipe"` and the payload is written to `proc.stdin`.
- When `stdin` is undefined, legacy `stdio:["ignore","pipe","pipe"]`
  is preserved.

**A6. AsyncJobManager stdin + dedup-key** at `src/async-job-manager.ts`
- `StartJobOptions.stdin?` field.
- `buildRequestKey(cli, args, env?, stdin?)` includes stdin in the
  key via `extra = env|stdin:<value>`.
- `startJobWithDedup`'s `spawnCliProcess` call uses
  `stdio: stdin === undefined ? ["ignore","pipe","pipe"] : ["pipe","pipe","pipe"]`.
- Two requests with identical argv but different stdin produce
  distinct jobs; identical stdin still dedups.

**A7. FlightRecorder migration v4** at `src/flight-recorder.ts`
- `ensureCacheControlBlocksColumn` ALTER TABLE ADD COLUMN is
  idempotent (PRAGMA check).
- `_migrations` v4 row inserted via `INSERT OR IGNORE`.
- `FlightLogStart.cacheControlBlocks?: number` exists.
- INSERT into `requests` binds `@cache_control_blocks`.
- Pre-κ rows keep NULL.

### B. Rec #1 — outputFormat default (commit `1bda5fc`)

**B1.** `claude_request` `.default("stream-json")` at ~`src/index.ts:3809-3811`.
**B2.** `claude_request_async` `.default("stream-json")` at ~`src/index.ts:5304-5306`.
**B3.** Descriptions explain the trade-off (loses observability when
overridden to "text").

### C. Rec #5 — optimizePrompt + κ mutex (commit `1bda5fc`)

**C1.** Early `cacheControlRequestedEarly` declaration computed BEFORE
the optimizePrompt block.
**C2.** When `params.optimizePrompt && cacheControlRequestedEarly`,
`createErrorResponse(...)` is returned with a message matching
`/optimizePrompt.*incompatible/i`.
**C3.** Later `cacheControlRequested = cacheControlRequestedEarly`
(plus auto-emit OR), so the same flag drives the κ branch.

### D. Rec #7 — promptParts descriptions (commit `1bda5fc`)

**D1.** `claude_request` `promptParts.describe(...)` mentions
`cacheControl`, `--input-format stream-json`, `ttl='1h'`, and "task
is the volatile tail" (`src/index.ts` ~line 3800).
**D2.** `claude_request_async` description mirrors the same content.

### E. Test hardening (commit `1bda5fc`)

**E1. Kβ-8** at `src/__tests__/test-veracity-regressions-slice-kappa.test.ts`
- Asserts `validation.violations === []` (exact empty array).
- Pins `args[0]==="-p"`, `args[1]==="--input-format"`,
  `args[2]==="stream-json"`.
- Requires `--verbose` and `--include-partial-messages` to be present.
- Asserts `args[1].startsWith("--")` (no positional after `-p`).

**E2. Kβ-9** new test for rec #5 mutex.

**E3. Kδ-2** has a 5-second per-test timeout passed to `it(...)`.

### F. Rec #2 — auto cache_control (commit `001def3`)

**F1. Detection** in `src/index.ts`:
- `runtime.cacheAwareness.emitAnthropicCacheControl === true` AND
- `!cacheControlRequestedEarly` AND
- `!params.optimizePrompt` AND
- `params.outputFormat === "stream-json"` AND
- `params.promptParts` AND
- `stablePrefixTokens !== null` AND
- `stablePrefixTokens >= minStableTokensForModel(runtime.cacheAwareness, resolvedModel ?? "default")`.

**F2. Target selection.** Rightmost non-empty stable block in
`context → tools → system` priority:
```
if (pp.context && pp.context.length > 0) → "context"
else if (pp.tools && pp.tools.length > 0) → "tools"
else if (pp.system && pp.system.length > 0) → "system"
```

**F3. ttl forced to 1h** regardless of `anthropic_ttl_seconds`.
- Warning emitted if config says 300 (cite the `runtime.logger.warn`
  call).

**F4. Synthesis.** When auto-emitting, a shallow-copied
`effectivePromptParts` is built (NOT mutating `params.promptParts`)
and passed to `assembleClaudeCacheBlocks`. Verify the spread + nested
spread:
```
{
  ...params.promptParts!,
  cacheControl: {
    ...(params.promptParts!.cacheControl ?? {}),
    [autoEmittedCacheControlBlock]: true,
  },
}
```

### G. Rec #4 — cacheable-but-uncached warning (commit `001def3`)

**G1.** `WarningEntry` extended? — confirm the existing
`WarningEntry` shape at `src/index.ts:111-119` accepts the new
`code: "cacheable_prefix_uncached"` + payload fields
(`stablePrefixTokens`, `threshold`, `reason`).

**G2.** Warning emission in `prepareClaudeRequest`:
- Fires when `!cacheControlRequestedEarly` AND
  `autoEmittedCacheControlBlock === null` AND `params.promptParts`
  AND `stablePrefixTokens !== null` AND `stablePrefixTokens >= threshold`.
- Reason is one of: outputFormat-not-streamjson / config-off /
  no-eligible-block.

**G3. CliRequestPrep.warnings?: WarningEntry[]** added at the prep
return path.

**G4. Sync handler merges** `prep.warnings` with `ttlWarning` at
`src/index.ts` ~line 4178.

**G5. Async handler merges** `prep.warnings` with `ttlWarning` at
~line 5687-5696.

### H. Rec #3 — cache stats split (commit `001def3`)

**H1. `GlobalCacheStats`** at `src/cache-stats.ts:63-107` gains:
- `explicitCacheControlRows: number`
- `explicitCacheControlHits: number`
- `explicitCacheControlHitRate: number`
- `stablePrefixReuseCount: number`
- `avgCacheCreationAfterFirstCall: number | null`

**H2. SQL** in `computeGlobalCacheStats` SELECTs
`cache_control_blocks` column.

**H3. Computation** in the loop:
- `ccBlocks = safeNum(row.cache_control_blocks)`
- `if (ccBlocks > 0)` → bumps explicitRows + explicitHits (if
  cache_read > 0).
- `perPrefix` map collects rows by `stable_prefix_hash` with
  datetime and cache_creation_tokens.

**H4. Post-loop**: groups with `length > 1` increment
`stablePrefixReuseCount`; rows after the first contribute to
`avgCacheCreationAfterFirstCall`.

### I. Rec #6 — smoke script (commit `001def3`)

**I1. `package.json`** has `"smoke:cache-control": "node docs/plans/slice-kappa-smoke-test.mjs"`.

**I2. `docs/plans/slice-kappa-smoke-test.mjs`** prints a BILLABLE TEST
banner and exits with code 0 when `SMOKE_CACHE_CONTROL` env var is
unset; only proceeds when set to a truthy value.

### J. Kζ regression tests (commit `001def3`)

In `src/__tests__/test-veracity-regressions-slice-kappa.test.ts`, the
`describe("REGRESSIONS Kζ — auto-emit (rec #2) + cacheable-uncached warning (rec #4)")`
block contains 8 tests, each exercising a distinct surface:

- **Kζ-1**: auto-emit on rightmost non-empty stable block (context).
- **Kζ-2**: auto-emit OFF when `emit_anthropic_cache_control:false`.
- **Kζ-3**: auto-emit OFF when stable prefix < threshold.
- **Kζ-4**: auto-emit OFF when optimizePrompt=true.
- **Kζ-5**: warning with reason=config-off.
- **Kζ-6**: warning with reason=outputFormat-not-streamjson.
- **Kζ-7**: no warning when prefix < threshold.
- **Kζ-8**: no warning when caller explicitly opted in.

`resolveGatewayServerRuntime` and `GatewayServerRuntime` must be
exported from `src/index.ts` so the test can build runtimes with
custom `CacheAwarenessConfig`.

---

## Mutation probes (mandatory)

You MUST run each probe yourself (mutate → `npx vitest run src/__tests__/test-veracity-regressions-slice-kappa.test.ts` → observe → `git checkout -- src/` → restore). Report `[as predicted / surprising — explain]` per probe.

### Slice κ feature
- **P-Kα-1** (ttl drift): `src/prompt-parts.ts:147` swap `"1h"` → `"5m"`. Expect Kα-3/5/6 + Kβ-2 red.
- **P-Kα-3** (mark task): in the loop body of `assembleClaudeCacheBlocks`, conditionally mark the task block too. Expect Kα-5 red.
- **P-Kβ-1** (drop --verbose): remove `--verbose` from the κ argv. Expect Kβ-1 + **Kβ-8** red (the strengthened Kβ-8 must now catch this).
- **P-Kβ-2** (put positional back): in the κ branch, re-insert `effectivePrompt` after `-p`. Expect Kβ-1 + **Kβ-8** red.
- **P-Kγ-1** (revert arity): change `-p` arity back to `"one"`. Expect Kγ-2/3/4 + Kγ-7 + Kβ-8 red.
- **P-Kδ-1** (drop stdin write): false-guard `proc.stdin.write` in executor. Expect Kδ-1 red.
- **P-Kδ-2** (always pipe stdin): force `stdio[0]:"pipe"` unconditionally — Kδ-2 **must time out cleanly within 5s** (not hang the suite).
- **P-Kε-1** (non-idempotent v4): change `INSERT OR IGNORE` to `INSERT`. Expect Kε-5 red on second open.

### Recommendations
- **P-Rec1-1**: revert `.default("stream-json")` → `.default("text")` on `claude_request`. The MCP-wire-layer test (search for any test that exercises the registered tool default) must catch it; if no test catches it, that's a gap to report.
- **P-Rec5-1**: remove the `optimizePrompt + cacheControl` early-return. **Kβ-9 must go red.**
- **P-Rec2-1**: skip auto-emit (return early before computing `autoEmittedCacheControlBlock`). **Kζ-1 must go red** (stdinPayload becomes undefined).
- **P-Rec2-2**: change priority to system-first (mark `system` before `context`). **Kζ-1 must go red** (asserts marker lands on `context`).
- **P-Rec2-3**: drop the `!params.optimizePrompt` guard from auto-emit. **Kζ-4 must go red**.
- **P-Rec4-1**: skip pushing the `cacheable_prefix_uncached` warning. **Kζ-5 and Kζ-6 must go red.**
- **P-Rec4-2**: emit the warning even when prefix is below threshold (move the `if (stablePrefixTokens >= threshold)` guard). **Kζ-7 must go red.**
- **P-Rec3-1**: drop `cache_control_blocks` column from the SQL SELECT in `computeGlobalCacheStats`. Add a test or report a gap if `cache-stats.test.ts` doesn't catch this.
- **P-Rec6-1**: remove `SMOKE_CACHE_CONTROL` gate from the smoke script. Running `npm run smoke:cache-control` in a non-SMOKE env should produce a non-zero exit / BILLABLE invocation — if no test asserts the gate, report a gap.

---

## Output format

Per claim (A1 … J): `[VERIFIED / FAIL — file:line + 1-sentence why]`.

Per probe (P-Kα-1 … P-Rec6-1): `[as predicted / surprising — explain]`.

Gaps section: any claim that lacks a test which would catch its
regression. Cite the smallest test that would close the gap.

Overall verdict line: one of
- `UNCONDITIONAL APPROVE`
- `REJECT (concrete blocker: file:line — one-sentence why)`.

Approval bar (Werner's standing rule):
- Approval must be grounded in **inspected code, tests, docs, and
  the persistent review evidence on disk** (this spec, the commits,
  the test file).
- Approval may NOT be based on the author's commit message, intent,
  plan-compliance language, or "should be fixed" claims about future
  work.
- If you find a defect, name it with `file:line` and propose the
  smallest concrete fix (a diff hunk, a missing test, a renamed
  field). Do not say "consider doing X".

If your verdict is REJECT, the author will either (a) apply your
proposed fix and re-submit for review, or (b) refute your finding
with code/doc evidence (not assertion). Iterate at 90-second poll
cadence until you issue UNCONDITIONAL APPROVE or the blocker cannot
be resolved.
