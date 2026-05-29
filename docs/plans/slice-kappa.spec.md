# Test-veracity audit — slice κ (Claude `cache_control` via `--input-format stream-json`)

## Scope

You are auditing the **veracity of the tests** added across the commits
on branch `feat/phase-4-slice-kappa` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits
at v1.13.2 (`5f1b50d`).

The branch ships as v1.14.0. This audit answers: **do the new tests
prove what they claim, and would they go red if the feature broke?**

Slice κ teaches the Claude path how to mark caller-supplied prompt
parts with Anthropic `cache_control` breakpoints, by switching from
positional `-p <prompt>` to `claude -p --input-format stream-json` with
a JSON content-block payload on stdin. Anthropic's prefix cache then
honours the breakpoints across calls (verified live in `docs/plans/
slice-kappa-smoke-test.mjs`: 15,511-token shift, 82 % cost drop on
call 2). Non-κ callers retain the positional path bit-for-bit.

Pre-κ baseline (`docs/plans/slice-kappa-captures/`) plus the smoke
test pin three Anthropic constraints that the spec MUST encode:

1. `cache_control.ttl` must be `"1h"` — `"5m"` (the server default) is
   rejected by Anthropic because Claude Code injects its own
   1h-marked system blocks ahead of the caller content. The gateway
   hard-codes `ttl: "1h"`; `ttl` is NOT exposed to callers in this
   slice.
2. Caller content lands at `messages.0.content.6+` — Claude Code
   injects ~6 system blocks ahead. Relevant only to debugging.
3. Each fresh `--print` session has a ~10–12K cache_creation floor
   that κ cannot eliminate. κ adds caller-side reuse ON TOP. The
   tool description must document this.

## Files under review

```
src/prompt-parts.ts                                       # MODIFIED: PromptParts gains optional cacheControl flags + assembleClaudeBlocks helper
src/upstream-contracts.ts                                 # MODIFIED: -p arity widened, --input-format added, claude-input-format-stream-json fixture
src/index.ts                                              # MODIFIED: prepareClaudeRequest κ branch + stdinPayload threading; claude_request + claude_request_async Zod docs; handler threading
src/executor.ts                                           # MODIFIED: executeCli accepts optional stdin
src/async-job-manager.ts                                  # MODIFIED: startJobWithDedup accepts optional stdin and feeds the child process
src/flight-recorder.ts                                    # MODIFIED: migration v4 adds cache_control_blocks column; logStart writes it
src/__tests__/claude-handler.test.ts                      # MODIFIED: κ argv + stdin + ttl + regression assertions
src/__tests__/upstream-contracts.test.ts                  # MODIFIED: optional-arity + --input-format coverage
src/__tests__/flight-recorder.test.ts                     # MODIFIED: v4 migration column + write coverage
src/__tests__/test-veracity-regressions-slice-kappa.test.ts # NEW: REGRESSIONS Kα/Kβ/Kγ/Kδ/Kε (mutation-probe-friendly)
docs/plans/slice-kappa.spec.md                            # NEW: this spec
```

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD --stat
git diff master..HEAD -- src/prompt-parts.ts src/index.ts src/upstream-contracts.ts src/executor.ts src/async-job-manager.ts src/flight-recorder.ts

# What every reviewer must replicate:
npm run build
npm test
npm run format:check
```

## Implementation surface to verify

1. **`PromptParts` extension** in `src/prompt-parts.ts`:
   - Optional `cacheControl?: { system?: boolean; tools?: boolean; context?: boolean }`.
   - `PromptPartsSchema` validates the new shape; absent / empty `cacheControl`
     means non-κ.
   - New exported helper `assembleClaudeCacheBlocks(parts)` returns
     `{ payload, markedBlockCount }`:
       * `payload` is the JSON object `{type:"user",message:{role:"user",content:[…]}}`.
       * Each non-empty part becomes one `{type:"text",text:<value>}` content
         block, in `system → tools → context → task` order.
       * For each block whose part name is true in `cacheControl`, the
         block carries `cache_control: { type:"ephemeral", ttl:"1h" }`.
       * `markedBlockCount` equals the number of blocks that carry
         `cache_control` (used for FR + caller-honest counting).

2. **`prepareClaudeRequest`** in `src/index.ts`:
   - Detects κ mode by `cacheControlRequested = (promptParts?.cacheControl
     && (cacheControl.system || cacheControl.tools || cacheControl.context))`.
   - If κ is requested:
       * Validate `outputFormat === "stream-json"`. If not, return a
         `createErrorResponse` with a clear actionable message
         ("cacheControl requires outputFormat: 'stream-json'").
       * Build argv as: `["-p", "--input-format", "stream-json",
         "--output-format", "stream-json", "--include-partial-messages",
         "--verbose", …model, …allowedTools, …permissions, …MCP, …high-impact]`.
         **No positional prompt** is emitted because the prompt is on stdin.
       * Set the prep result's `stdinPayload` field to
         `JSON.stringify(assembleClaudeCacheBlocks(promptParts).payload) + "\n"`.
       * Set `cacheControlBlocks` (number) on the prep result so the
         handler can pass it to the flight recorder.
   - If κ is NOT requested: identical argv emission to v1.13.2; no
     `stdinPayload`; `cacheControlBlocks` is undefined / 0.
   - The signature gains:
       * `stdinPayload?: string` on the `CliRequestPrep` returned shape.
       * `cacheControlBlocks?: number` on the `CliRequestPrep`.

3. **`UPSTREAM_CLI_CONTRACTS.claude`** in `src/upstream-contracts.ts`:
   - `flags["-p"].arity === "optional"` (new arity: consumes the next
     token as a value ONLY if that token does not start with `-`).
   - `flags["--input-format"]` exists with
     `arity:"one", values:["text","stream-json"]`.
   - New conformance fixture `claude-input-format-stream-json` with args
     `["-p", "--input-format", "stream-json", "--output-format",
     "stream-json", "--include-partial-messages", "--verbose"]`,
     `expect: "pass"`.

4. **`validateUpstreamCliArgs`** in `src/upstream-contracts.ts`:
   - Handles the new `"optional"` arity: consumes one value iff
     `args[i+1]` exists AND does not start with `-`.
   - Existing `arity:"one"` paths unchanged.

5. **`executeCli` / `spawnCliProcess` / `startJobWithDedup`**:
   - `ExecuteOptions` and `StartJobOptions` gain `stdin?: string`.
   - When `stdin` is provided, `stdio` for the spawned child is
     `["pipe","pipe","pipe"]`, payload is written, stdin is ended.
     The dedup key INCLUDES the stdin string (canonicalised).
   - When `stdin` is undefined: existing `stdio: ["ignore","pipe","pipe"]`
     unchanged.

6. **Claude handler threading** in `src/index.ts` (both `claude_request`
   sync and `claude_request_async`):
   - `prep.stdinPayload` flows into `awaitJobOrDefer(..., stdin)`.
   - `prep.cacheControlBlocks` flows into `safeFlightStart` so the FR
     row has `cache_control_blocks` set.

7. **Flight recorder migration v4** in `src/flight-recorder.ts`:
   - Idempotent ALTER TABLE adds `cache_control_blocks INTEGER`.
   - `_migrations` gets version 4 inserted (idempotent).
   - `logStart` accepts optional `cacheControlBlocks` and persists it.
   - Pre-κ rows keep NULL by design.

8. **`claude_request` + `claude_request_async` Zod docs** in `src/index.ts`:
   - `PromptPartsSchema` description gains a one-line κ pointer (no
     schema change required — it's already `PromptPartsSchema.optional()`
     and `PromptPartsSchema` itself is updated in `src/prompt-parts.ts`).
   - The tool description (top-level `claude_request` description string)
     gains a κ caveat block: "cacheControl on promptParts requires
     outputFormat='stream-json' and hardcodes ttl='1h'; each fresh
     --print session has a ~10–12K cache_creation floor outside the
     caller's control."

## What each test CLAIMS to prove

For each test, you must independently confirm or deny:
(a) **the implementation surface it exercises** — what code path actually runs?
(b) **the falsifiability** — if the feature were broken, would this test go red?
(c) **a counterexample probe** — try to construct a code change that breaks the feature but leaves this test green.

### Test set Kα — `PromptParts` Zod + assembleClaudeCacheBlocks (unit)

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Kα-1 | `PromptPartsSchema.safeParse({task:"x", cacheControl:{system:true}})` succeeds | Zod accepts new field | direct `safeParse` | catches accidental schema strictness |
| Kα-2 | `PromptPartsSchema.safeParse({task:"x", cacheControl:{system:"yes"}})` fails | new field is boolean-typed | direct `safeParse` | catches accidental `z.unknown()` |
| Kα-3 | `assembleClaudeCacheBlocks({system:"S",tools:"T",context:"C",task:"K",cacheControl:{system:true}})` emits 4 content blocks; only the `system` block carries `cache_control:{type:"ephemeral",ttl:"1h"}`; `markedBlockCount===1` | block ordering, ttl correctness | direct call | None |
| Kα-4 | `assembleClaudeCacheBlocks({task:"K",cacheControl:{system:true}})` does NOT emit a system block (system is empty) — `markedBlockCount===0` because system was never present | empty parts are skipped, marker without content is a no-op | direct call | catches accidental zero-byte block emission |
| Kα-5 | `assembleClaudeCacheBlocks({system:"S",tools:"T",context:"C",task:"K",cacheControl:{system:true,tools:true,context:true}})` emits 4 blocks with `cache_control` on system + tools + context (NOT on task) | task is never marked | direct call | catches accidental task marker |
| Kα-6 | Every `cache_control` emitted by `assembleClaudeCacheBlocks` has `ttl:"1h"` exactly — string equality | TTL hard-coding | direct call | catches accidental `5m` default or absence |
| Kα-7 | `assembleClaudeCacheBlocks({task:"K"})` returns payload with one content block (task) and zero `cache_control` markers | default path | direct call | None |

**Counterexample probes you must run:**
- **P-Kα-1**: Change `ttl:"1h"` to `ttl:"5m"` in `assembleClaudeCacheBlocks`. Kα-3, Kα-5, Kα-6 must go red.
- **P-Kα-2**: Drop `cacheControl` from `PromptPartsSchema`. Kα-1 stays green (Zod's default is passthrough on additional keys), so the regression test MUST assert success of the `safeParse` AND that the parsed value retains `cacheControl` (`.data.cacheControl?.system === true`). Verify this assertion exists.
- **P-Kα-3**: In `assembleClaudeCacheBlocks`, accidentally mark the task block too (e.g. iterate over all blocks). Kα-5 must go red.
- **P-Kα-4**: Skip empty parts before applying cacheControl. Kα-4 must verify the `system` part is absent from blocks AND `markedBlockCount===0`.

### Test set Kβ — `prepareClaudeRequest` argv + stdin (end-to-end)

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Kβ-1 | `prepareClaudeRequest({promptParts:{system:"S",task:"K",cacheControl:{system:true}}, outputFormat:"stream-json"})` returns args containing `["-p","--input-format","stream-json","--output-format","stream-json","--include-partial-messages","--verbose"]` and NO positional prompt string | κ argv | argv inspection | None |
| Kβ-2 | Same call returns `stdinPayload` parseable as JSON with `message.content[0].text === "S"` AND `message.content[0].cache_control.ttl === "1h"` AND `message.content[1].text === "K"` AND `message.content[1].cache_control === undefined` | stdin payload correctness | JSON.parse on result | None |
| Kβ-3 | `prepareClaudeRequest({promptParts:{...,cacheControl:{system:true}}, outputFormat:"text"})` returns an `ExtendedToolResponse` with a clear actionable error message (regex `/outputFormat.*stream-json/i`) | mismatch guard | result inspection | catches accidental silent format coercion |
| Kβ-4 | `prepareClaudeRequest({promptParts:{system:"S",task:"K"}, outputFormat:"text"})` (NO cacheControl) returns argv `["-p","S\n\nK", …]` and no `stdinPayload` | regression: non-κ path untouched | argv inspection + stdinPayload === undefined | None — explicit regression |
| Kβ-5 | `prepareClaudeRequest({prompt:"hi", outputFormat:"stream-json"})` (NO promptParts) returns positional `-p "hi"` path with no stdin | regression: prompt-only flow | argv inspection | catches accidental κ activation on plain string prompt |
| Kβ-6 | `prepareClaudeRequest({promptParts:{task:"K", cacheControl:{system:true}}, outputFormat:"stream-json"})` returns `cacheControlBlocks === 0` (system part empty so marker is a no-op) | caller-honest counting | result inspection | None |
| Kβ-7 | `prepareClaudeRequest({promptParts:{system:"S",task:"K",cacheControl:{system:true}}, outputFormat:"stream-json"})` returns `cacheControlBlocks === 1` | counter equals true markers | result inspection | catches off-by-one |
| Kβ-8 | argv from Kβ-1 passes `validateUpstreamCliArgs("claude", args)` end-to-end | prepare → contract consistency | `validateUpstreamCliArgs` | closes slices α/γ/δ contract-gap class |

**Counterexample probes you must run:**
- **P-Kβ-1**: In `prepareClaudeRequest`, remove `--verbose` from the κ branch. Kβ-1 + Kβ-8 must go red (Kβ-8 because the conformance contract fixture pins the combo).
- **P-Kβ-2**: Change κ branch to keep emitting `effectivePrompt` positionally as the value of `-p`. Kβ-1 must go red (positional present); Kβ-8 must go red (positional rejected by `maxPositionals:0`).
- **P-Kβ-3**: Drop the `outputFormat==="stream-json"` guard. Kβ-3 must go red (call returns args, not an error response).
- **P-Kβ-4**: Set `ttl:"5m"` in the κ payload assembler. Kβ-2 must go red.
- **P-Kβ-5**: Emit `stdinPayload` even when no cacheControl. Kβ-4 must go red (stdinPayload becomes defined).

### Test set Kγ — `UPSTREAM_CLI_CONTRACTS` introspection + arity:"optional"

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Kγ-1 | `validateUpstreamCliArgs("claude", ["-p","hello"])` ok=true (legacy positional form) | optional arity preserves old form | `validateUpstreamCliArgs` | None |
| Kγ-2 | `validateUpstreamCliArgs("claude", ["-p","--input-format","stream-json","--output-format","stream-json","--include-partial-messages","--verbose"])` ok=true | κ combination | same | None |
| Kγ-3 | `validateUpstreamCliArgs("claude", ["-p"])` ok=true (zero-value usage) | optional arity, last position | same | catches strict `arity:"one"` rejection |
| Kγ-4 | Direct introspection: `UPSTREAM_CLI_CONTRACTS.claude.flags["-p"].arity === "optional"` | type widened | direct read | catches accidental revert |
| Kγ-5 | Direct introspection: `UPSTREAM_CLI_CONTRACTS.claude.flags["--input-format"]` exists, `arity:"one"`, `values:["text","stream-json"]` | new flag, bounded | direct read | catches accidental freeform |
| Kγ-6 | `validateUpstreamCliArgs("claude", ["-p","x","--input-format","yaml"])` ok=false | values constraint enforced | same | catches values drop |
| Kγ-7 | New conformance fixture `claude-input-format-stream-json` exists AND mechanically validates against the contract (pass) | REGRESSIONS F-style + mechanical | iterate fixtures + `validateUpstreamCliArgs` | None |

**Counterexample probes you must run:**
- **P-Kγ-1**: Revert `-p` arity to `"one"`. Kγ-2 and Kγ-3 must go red (Kγ-2 because `--input-format` is consumed as the value of `-p` and then `stream-json` becomes a positional; Kγ-3 because missing value).
- **P-Kγ-2**: Remove `--input-format` from claude flags. Kγ-2, Kγ-5, Kγ-7 must go red.
- **P-Kγ-3**: Change `--input-format` values to `["text"]` only. Kγ-2 must go red (stream-json now rejected).
- **P-Kγ-4**: Delete the `claude-input-format-stream-json` fixture. Kγ-7 must go red.

### Test set Kδ — executor + async-job-manager stdin wiring

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Kδ-1 | `executeCli` with `stdin:"payload\n"` spawns child with `stdio:["pipe","pipe","pipe"]` and writes the payload to its stdin | stdin threading | spy on `spawnCliProcess` / fake child | catches accidental drop |
| Kδ-2 | `executeCli` without `stdin` spawns child with `stdio:["ignore","pipe","pipe"]` (regression) | non-κ unchanged | same | None |
| Kδ-3 | `startJobWithDedup` with `stdin:"X"` and `stdin:"Y"` (same args, different stdin) does NOT dedup — two distinct jobs | dedup key includes stdin | dedup behaviour | catches stdin missing from buildRequestKey |
| Kδ-4 | `startJobWithDedup` with no `stdin` and a second call with no `stdin` (same args) dedups (regression) | absent stdin still dedups | same | None |

**Counterexample probes you must run:**
- **P-Kδ-1**: In `executeCli`, ignore `options.stdin`. Kδ-1 must go red (payload never reaches child).
- **P-Kδ-2**: In `startJobWithDedup`, leave `stdin` out of `buildRequestKey`. Kδ-3 must go red (the second call returns the deduped snapshot of the first).
- **P-Kδ-3**: In `executeCli`, always use `stdio:["pipe","pipe","pipe"]`. Kδ-2 must go red (regression catches the broadening).

### Test set Kε — Flight recorder migration v4 + cache_control_blocks write

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Kε-1 | Fresh FR opens; `PRAGMA table_info(requests)` includes `cache_control_blocks` column | migration applies on fresh DB | direct PRAGMA | None |
| Kε-2 | Pre-existing FR (v3 schema simulated by deleting the column then re-opening) gets `cache_control_blocks` added idempotently AND `_migrations` row v4 inserted | migration is idempotent + upgrades | open twice + PRAGMA | catches `IF NOT EXISTS` regression |
| Kε-3 | `logStart({…, cacheControlBlocks: 3})` followed by `logComplete(...)` produces a row with `cache_control_blocks === 3` | write path | `queryRequests` | None |
| Kε-4 | `logStart({…})` (no cacheControlBlocks) produces a row with `cache_control_blocks === null` | regression: legacy callers | `queryRequests` | catches accidental NOT NULL DEFAULT 0 |
| Kε-5 | Opening the FR twice in the same process does not re-apply migrations (count of v4 rows in `_migrations` stays at 1) | INSERT OR IGNORE works | direct query | None |

**Counterexample probes you must run:**
- **P-Kε-1**: Change `INSERT OR IGNORE` to `INSERT` for the v4 row. Kε-5 must go red (PK violation on second open).
- **P-Kε-2**: Drop the column-add ALTER. Kε-1 must go red.
- **P-Kε-3**: In `logStart`'s INSERT, omit the `cache_control_blocks` column binding. Kε-3 must go red.
- **P-Kε-4**: Default `cache_control_blocks` to 0 instead of nullable. Kε-4 must go red.

## Round expectations

- **Round 1**: 5 LLMs (Codex, Gemini, Grok, Mistral, Claude) launched
  async via `gtwy` MCP per `feedback_test_veracity_audit_protocol.md`.
  Each reviewer MUST:
  - Read the spec AND the actual commit diff (`git diff master..HEAD`).
  - Run each P-Kα/β/γ/δ/ε probe (mutate → re-run
    `npx vitest run src/__tests__/test-veracity-regressions-slice-kappa.test.ts`
    → observe colour → `git checkout -- src/` to restore → report).
  - Cite file:line for any disagreement; assertion-style verdicts are
    inadmissible.

- **Approval criterion**: Each probe produces a red test as predicted.
  No probe leaves the suite green when the feature is broken.

## Your output format

Per test (Kα-1 .. Kε-5): `[VERIFIED / FAIL / SKIP]` + one-sentence why, with file:line.
Per probe (P-Kα-1 .. P-Kε-4): `[as predicted / surprising — explain]`.
Gaps section: any remaining gap with the smallest test that would close it.
Overall: **UNCONDITIONAL APPROVE** or **REJECT (concrete blocker: file:line)**.

Be terse. Cite, don't summarize. Trust your own inspection of the repo, not this spec.
