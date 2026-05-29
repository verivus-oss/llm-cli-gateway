# Test-veracity audit — slice ζ (working-dir + add-dir cross-provider)

## Scope

You are auditing the **veracity of the tests** added across the commits on
branch `feat/phase-4-slice-zeta` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits at
v1.11.0 (`2f097b9`).

The branch ships as v1.12.0. This audit answers: **do the new tests prove
what they claim, and would they go red if the feature broke?**

Slice ζ wires working-directory and additional-directory flags through the
gateway for four CLIs (Gemini's `--include-directories` is already wired in
master and is exercised by a regression guard, not new wiring):

- **Claude**: `--add-dir <dirs...>` (variadic; Claude has no `--cwd`).
- **Codex**: `-C/--cd <DIR>` (working root) + `--add-dir <DIR>` (repeatable).
  Both flags are in `CODEX_RESUME_FILTERED_FLAGS` and ARE stripped on resume
  argv (verified by an explicit test); they're emitted on new sessions only.
- **Grok**: `--cwd <CWD>` (working dir). Grok has no `--add-dir` analogue.
- **Vibe (Mistral)**: `--workdir DIR` (working dir) + `--add-dir DIR`
  (repeatable per `vibe --help`).

All flags are surfaced on both `*_request` AND `*_request_async`.

**Out of scope (explicitly deferred — not in slice ζ):**

- Worktree flags (`-w/--worktree` on Claude/Gemini/Grok) create new git
  worktree directories on disk with lifecycle implications. Deferred to a
  later slice with explicit cleanup semantics.

## Files under review

```
src/request-helpers.ts                                    # MODIFIED: PrepareMistralRequestInput + emitter
src/index.ts                                              # MODIFIED: prepare*Request signatures + sync/async Zod + handler threading
src/upstream-contracts.ts                                 # MODIFIED: 4 CLI contracts.flags + mcpParameters + 6 conformance fixtures
src/__tests__/test-veracity-regressions-slice-zeta.test.ts  # NEW: REGRESSIONS Zα–Zε (mutation-probe-friendly)
docs/plans/test-veracity-audit-slice-zeta.spec.md         # NEW: this spec
```

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD --stat
git diff master..HEAD -- src/upstream-contracts.ts src/request-helpers.ts src/index.ts

# What every reviewer must replicate:
npm run build
npm test
npm run format:check
```

## Implementation surface to verify

Each CLI's surface is mechanically identical: Zod (sync + async) → prepare
function → contract `flags` + `mcpParameters` + conformance fixture.

### Claude
1. **Zod fields** in both `claude_request` and `claude_request_async`:
   `addDir: z.array(z.string()).optional()`.
2. **`prepareClaudeRequest` signature** accepts `addDir?: string[]` and
   threads it into `prepareClaudeHighImpactFlags`.
3. **`prepareClaudeHighImpactFlags`** emits `--add-dir <each>` per element
   (Claude's variadic flag accepts space-separated dirs after the flag, but
   the safest argv shape that survives `spawn` is one `--add-dir` per dir;
   Claude treats subsequent `--add-dir` as additive, per `claude --help`).
4. **`UPSTREAM_CLI_CONTRACTS.claude`**:
   - `mcpParameters` includes `"addDir"`.
   - `flags["--add-dir"]` exists with `arity: "one"` (consumes one dir per
     instance; multiple `--add-dir` instances allowed).
   - New conformance fixture `claude-add-dir`.

### Codex
1. **Zod fields** in both `codex_request` and `codex_request_async`:
   `workingDir: z.string().min(1).optional()`,
   `addDir: z.array(z.string()).optional()`.
2. **`prepareCodexRequest` signature** accepts `workingDir?: string` and
   `addDir?: string[]`. Both are emitted in the NEW-session branch ONLY —
   resume strips them via `CODEX_RESUME_FILTERED_FLAGS` (already in master).
   Verified by a test that builds a resume-mode prep with both fields set
   and asserts neither `-C` nor `--add-dir` appears in argv.
3. **Emission**: `-C <dir>` (one) + `--add-dir <each>` (one flag per dir).
4. **`UPSTREAM_CLI_CONTRACTS.codex`**:
   - `mcpParameters` includes `"workingDir"` and `"addDir"`.
   - `flags["-C"]` exists with `arity: "one"`.
   - `flags["--add-dir"]` exists with `arity: "one"`.
   - New conformance fixtures `codex-working-dir` and `codex-add-dir`.

### Grok
1. **Zod field** in both `grok_request` and `grok_request_async`:
   `workingDir: z.string().min(1).optional()`.
2. **`prepareGrokRequest` signature** accepts `workingDir?: string`; emits
   `--cwd <dir>`.
3. **`UPSTREAM_CLI_CONTRACTS.grok`**:
   - `mcpParameters` includes `"workingDir"`.
   - `flags["--cwd"]` exists with `arity: "one"`.
   - New conformance fixture `grok-working-dir`.

### Vibe (Mistral)
1. **Zod fields** in both `mistral_request` and `mistral_request_async`:
   `workingDir: z.string().min(1).optional()`,
   `addDir: z.array(z.string()).optional()`.
2. **`PrepareMistralRequestInput`** in `request-helpers.ts` gains both
   fields; `prepareMistralRequest` emits `--workdir <dir>` (one) and
   `--add-dir <each>` (repeatable per `vibe --help`).
3. **`MistralRequestParams`** in `index.ts` AND **`buildMistralRetryPrep`**
   thread both fields (retry-path invariant from slice δ post-mortem).
4. **`UPSTREAM_CLI_CONTRACTS.mistral`**:
   - `mcpParameters` includes `"workingDir"` and `"addDir"`.
   - `flags["--workdir"]` exists with `arity: "one"`.
   - `flags["--add-dir"]` exists with `arity: "one"`.
   - New conformance fixtures `mistral-working-dir` and `mistral-add-dir`.

### Gemini (regression-only, no new wiring)
Existing `includeDirs` → `--include-directories` from master is exercised
by a regression-guard test that builds prep + threads through
`validateUpstreamCliArgs` end-to-end. This catches any inadvertent
regression while we're touching adjacent code paths.

## What each test CLAIMS to prove

For each test, you must independently confirm or deny:
(a) **the implementation surface it exercises** — what code path actually runs?
(b) **the falsifiability** — if the feature were broken, would this test go red?
(c) **a counterexample probe** — try to construct a code change that breaks the feature but leaves this test green.

### Test set Zα — Registered tool inputSchema (Zod, sync + async)

Inspects the *registered* tool's Zod shape via the same
`getRegisteredToolSchema` helper pattern slices ε and η used. Sync and
async are asserted independently for every flag — the same gap that hit
slice δ (handler/argv tested but registered-tool schema not asserted)
cannot recur.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Zα-1 | `claude_request.addDir` accepts `string[]` | registered schema | `safeParse(["/tmp"])` | None |
| Zα-2 | `claude_request_async.addDir` accepts independently | async tool wired independently | same on async | catches forgetting to add field on async-only |
| Zα-3 | `codex_request.workingDir` accepts non-empty string | bounded via `.min(1)` | `safeParse("/tmp")` | catches drop of `.min(1)` |
| Zα-4 | `codex_request.workingDir` rejects empty string | bounded via `.min(1)` | `safeParse("")` → fail | catches drop of `.min(1)` |
| Zα-5 | `codex_request.addDir` accepts `string[]` | registered schema | `safeParse(["/tmp"])` | None |
| Zα-6 | `codex_request_async.{workingDir,addDir}` accept independently | async tool wired independently | same | catches sync-only wiring |
| Zα-7 | `grok_request.workingDir` accepts non-empty string + rejects "" | bounded via `.min(1)` | both branches | None |
| Zα-8 | `grok_request_async.workingDir` accepts independently | async tool wired independently | same | catches sync-only wiring |
| Zα-9 | `mistral_request.workingDir` accepts non-empty + rejects "" | bounded via `.min(1)` | both branches | None |
| Zα-10 | `mistral_request.addDir` accepts `string[]` | registered schema | `safeParse(["/tmp"])` | None |
| Zα-11 | `mistral_request_async.{workingDir,addDir}` accept independently | async tool wired independently | same | catches sync-only wiring |

**Counterexample probes you must run:**
- **P-Zα-1**: Revert `addDir` Zod on `claude_request` (sync) to absent. Zα-1 must go red; Zα-2 (async) stays green — proves the two tools are pinned independently.
- **P-Zα-2**: Drop `.min(1)` on `codex_request.workingDir`. Zα-4 must go red.
- **P-Zα-3**: Revert `workingDir` Zod on `mistral_request_async` only. Zα-11 must go red; Zα-9 stays green — async pinned independently.

### Test set Zβ — `prepare*Request` argv emission (end-to-end)

These tests thread through the actual `prepare*Request` (not just the
helper) so the wiring is verified end-to-end — same pattern as slice
δ's `buildMistralRetryPrep` extraction.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Zβ-1 | `prepareClaudeRequest({addDir:["/a","/b"]})` emits two `--add-dir` flag instances with adjacent values | argv emission, repeatable | `prepareClaudeRequest(...).args` | None — direct argv inspection |
| Zβ-2 | `prepareClaudeRequest({})` (no addDir) emits no `--add-dir` | absence | same | catches accidental always-emit |
| Zβ-3 | `prepareCodexRequest({workingDir:"/w",addDir:["/a"]})` in NEW-session mode emits `-C /w` and `--add-dir /a` (each pair as adjacent tokens) | argv emission, new-session branch | new-session branch of prep | None |
| Zβ-4 | `prepareCodexRequest({workingDir:"/w",addDir:["/a"],resumeLatest:true})` in RESUME mode emits NEITHER `-C` nor `--add-dir` | resume strips them via `CODEX_RESUME_FILTERED_FLAGS` | resume branch + filter | catches accidental emission on resume |
| Zβ-5 | `prepareGrokRequest({workingDir:"/w"})` emits `--cwd /w` as adjacent tokens | argv emission | `prepareGrokRequest(...).args` | None |
| Zβ-6 | `prepareMistralRequest` (the index.ts wrapper) with `{workingDir:"/w",addDir:["/a","/b"]}` emits `--workdir /w` and two `--add-dir` instances | argv emission, repeatable | wrapper + helper | None |
| Zβ-7 | `buildMistralRetryPrep` threads both `workingDir` and `addDir` from `MistralRequestParams` through to the retry argv | retry-path invariant (slice δ post-mortem) | `buildMistralRetryPrep` | catches drop on retry (the bug class slice δ found) |
| Zβ-8 | argv from each CLI prep passes `validateUpstreamCliArgs(cli, args)` end-to-end | prepare → contract consistency (REGRESSIONS D pattern) | `validateUpstreamCliArgs("…", prep.args)` | Closes the contract-table gap that bit slices α/γ/δ |

**Counterexample probes you must run:**
- **P-Zβ-1**: In Claude's emitter, change `args.push("--add-dir", dir)` (per element) to a single `args.push("--add-dir", input.addDir.join(","))`. Zβ-1 must go red (one flag instance instead of two; tokens won't match the adjacency assertion).
- **P-Zβ-2**: In `prepareCodexRequest` new-session branch, remove the `-C` emission. Zβ-3 must go red AND Zβ-8 stays green (because the contract still permits the optional `-C` to be absent) → confirms falsifiability surface is argv inspection, not just the contract.
- **P-Zβ-3**: Move Codex `-C` emission OUT of the `if (sessionPlan.mode === "new")` branch (i.e., emit unconditionally). Zβ-4 must go red (now `-C` appears on resume argv too).
- **P-Zβ-4**: In `buildMistralRetryPrep`, drop the `workingDir` forwarding. Zβ-7 must go red. This is the exact slice δ retry-path bug class.
- **P-Zβ-5**: Add `--workdir` to Vibe's Zod WITHOUT registering it in `UPSTREAM_CLI_CONTRACTS.mistral.flags`. Zβ-8 must go red (contract-violation message). The slice α/γ/δ regression class.

### Test set Zε — UPSTREAM_CLI_CONTRACTS introspection + mechanical fixture validation

Mirrors slice η's Hε pattern. Each new fixture must mechanically validate
against the contract inside the same `it()` block — closes the gap
Codex/Mistral independently flagged on slice ε round 1.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Zε-1 | `validateUpstreamCliArgs("claude", ["-p","x","--add-dir","/a","--add-dir","/b"])` ok=true | contract accepts repeated flag | `validateUpstreamCliArgs` | None |
| Zε-2 | `validateUpstreamCliArgs("claude", ["-p","x","--add-dir"])` ok=false (missing value — arity:one) | bounded arity | same | catches accidental `arity:"none"` |
| Zε-3 | `validateUpstreamCliArgs("codex", ["exec","--skip-git-repo-check","-C","/w","--add-dir","/a","hello"])` ok=true | contract accepts both flags on new session | same | None |
| Zε-4 | `validateUpstreamCliArgs("grok", ["-p","x","--cwd","/w"])` ok=true | contract accepts new flag | same | None |
| Zε-5 | `validateUpstreamCliArgs("mistral", ["-p","x","--agent","auto-approve","--workdir","/w","--add-dir","/a","--add-dir","/b"])` ok=true | contract accepts both flags, repeated `--add-dir` | same | None |
| Zε-6 | Direct introspection: all 6 new flag entries exist with `arity:"one"` (`claude.--add-dir`, `codex.-C`, `codex.--add-dir`, `grok.--cwd`, `mistral.--workdir`, `mistral.--add-dir`) | direct read | direct read | None |
| Zε-7 | Direct introspection: `mcpParameters` arrays contain new param names (`claude.addDir`, `codex.workingDir`, `codex.addDir`, `grok.workingDir`, `mistral.workingDir`, `mistral.addDir`) | direct read | direct read | None |
| Zε-8 | All 6 new fixtures (`claude-add-dir`, `codex-working-dir`, `codex-add-dir`, `grok-working-dir`, `mistral-working-dir`, `mistral-add-dir`) exist AND mechanically validate against their CLI's contract | REGRESSIONS F-style + mechanical (close slice-ε round-1 gap) | iterate `contract.conformanceFixtures` + `validateUpstreamCliArgs(fixture.args, fixture.env)` for `expect:"pass"` ones | None |
| Zε-9 | **Regression guard**: Gemini `includeDirs` round-trip is preserved — `validateUpstreamCliArgs("gemini", ["-p","x","--include-directories","/a"])` ok=true | already-wired flag (master), no regression while touching adjacent code | same | catches an accidental break of pre-existing wiring during the slice |

**Counterexample probes you must run:**
- **P-Zε-1**: Remove `--cwd` from `UPSTREAM_CLI_CONTRACTS.grok.flags`. Zε-4 AND Zε-6 AND Zε-8 (for `grok-working-dir`) must go red.
- **P-Zε-2**: Change Vibe `--workdir` arity from `"one"` to `"none"`. Zε-5 (the `/w` becomes an unknown positional) AND Zε-6 AND Zε-8 must go red.
- **P-Zε-3**: Delete the `codex-add-dir` fixture from the array. Zε-8 must go red for that fixture id.
- **P-Zε-4**: Drop `"workingDir"` from `mistral.mcpParameters`. Zε-7 must go red.
- **P-Zε-5**: Remove `--include-directories` from `UPSTREAM_CLI_CONTRACTS.gemini.flags`. Zε-9 must go red — this is the regression-guard probe.

## Round expectations

- **Round 1**: 5 LLMs (Codex, Gemini, Grok, Mistral, Claude) launched async
  via `gtwy` MCP with the permission flags + MCP-server lists documented
  in `feedback_test_veracity_audit_protocol.md`. Per the slice-η lesson —
  run all 5 from the start so a single stall/quota-exhaust does not
  undermine the gate. Each reviewer MUST:
  - Read the spec AND the actual commit diff (`git diff master..HEAD`).
  - Run each P-Zα/β/ε probe (mutate → re-run
    `npx vitest run src/__tests__/test-veracity-regressions-slice-zeta.test.ts`
    → observe colour → `git checkout -- src/` to restore → report).
  - Cite file:line for any disagreement; assertion-style verdicts are
    inadmissible.

- **Approval criterion**: Each probe produces a red test as predicted.
  No probe leaves the suite green when the feature is broken.

## Your output format

Per test (Zα-1 .. Zε-9): `[VERIFIED / FAIL / SKIP]` + one-sentence why, with file:line.
Per probe (P-Zα-1 .. P-Zε-5): `[as predicted / surprising — explain]`.
Gaps section: any remaining gap with the smallest test that would close it.
Overall: **UNCONDITIONAL APPROVE** or **REJECT (concrete blocker: file:line)**.

Be terse. Cite, don't summarize. Trust your own inspection of the repo, not this spec.
