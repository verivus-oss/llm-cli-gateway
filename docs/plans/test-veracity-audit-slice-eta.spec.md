# Test-veracity audit — slice η (Claude `--fallback-model` + `--json-schema`)

## Scope

You are auditing the **veracity of the tests** added across the commits on
branch `feat/phase-4-slice-eta-claude-fallback-jsonschema` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits at
v1.10.0 (`ff795d1`).

The branch ships as v1.11.0. This audit answers: **do the new tests prove
what they claim, and would they go red if the feature broke?**

Slice η wires two Claude CLI flags through the gateway:

- `--fallback-model <model>` — auto-fallback when the default model is
  overloaded (Claude CLI `--print`-only; the gateway always passes `-p`).
- `--json-schema <schema>` — JSON Schema *literal* (NOT a path; per
  `claude --help` the argument is the JSON content inline) constraining
  structured output. Object values are `JSON.stringify`-d; string values
  pass through verbatim. Codex parity (`--output-schema`) for
  structured-output validation in a single slice.

Both flags are surfaced on `claude_request` AND `claude_request_async`.

## Files under review

```
src/request-helpers.ts                                   # MODIFIED: ClaudeHighImpactFlagsInput + prepareClaudeHighImpactFlags extended
src/index.ts                                             # MODIFIED: prepareClaudeRequest signature + sync/async Zod + handler threading
src/upstream-contracts.ts                                # MODIFIED: claude.flags + claude.mcpParameters + 2 new conformance fixtures
src/__tests__/test-veracity-regressions-slice-eta.test.ts  # NEW: REGRESSIONS Hα–Hε (mutation-probe-friendly)
docs/plans/test-veracity-audit-slice-eta.spec.md         # NEW: this spec
```

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD --stat
git diff master..HEAD -- src/upstream-contracts.ts src/request-helpers.ts

# What every reviewer must replicate:
npm run build
npm test
npm run format:check
```

## Implementation surface to verify

1. **Zod fields** in `src/index.ts` for both `claude_request` (sync) and
   `claude_request_async` (async) registrations:
   - `fallbackModel: z.string().min(1).optional()`
   - `jsonSchema: z.union([z.string(), z.record(z.unknown())]).optional()`
   Both registrations must expose both fields independently.
2. **`prepareClaudeRequest` signature** in `src/index.ts` accepts the
   two new params and threads them into `prepareClaudeHighImpactFlags`.
3. **`prepareClaudeHighImpactFlags`** in `src/request-helpers.ts` emits:
   - `--fallback-model <model>` when `fallbackModel` set
   - `--json-schema <JSON-literal>` when `jsonSchema` set (object →
     `JSON.stringify`; string → verbatim)
4. **`UPSTREAM_CLI_CONTRACTS.claude`**:
   - `mcpParameters` includes `"fallbackModel"` and `"jsonSchema"`.
   - `flags["--fallback-model"]` exists with `arity: "one"`.
   - `flags["--json-schema"]` exists with `arity: "one"`.
   - Two new passing conformance fixtures: `claude-fallback-model` and
     `claude-json-schema`.

## What each test CLAIMS to prove

For each test, you must independently confirm or deny:
(a) **the implementation surface it exercises** — what code path actually runs?
(b) **the falsifiability** — if the feature were broken, would this test go red?
(c) **a counterexample probe** — try to construct a code change that breaks the feature but leaves this test green.

### Test set Hα — Zod schema (registered tool inputSchema)

Inspects the *registered* tool's Zod shape via the
`getRegisteredToolSchema` helper (the same helper pattern slice ε used).
Sync and async are asserted independently — the same gap that hit slice δ
(handler/argv tested but registered-tool schema not asserted) cannot recur.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Hα-1 | `claude_request.fallbackModel` accepts a non-empty string | registered schema field returns success=true | `safeParse("claude-haiku-4-5-20251001")` | None |
| Hα-2 | `claude_request.fallbackModel` rejects empty string | bounded via `.min(1)` | `safeParse("")` → success=false | catches accidental drop of `.min(1)` |
| Hα-3 | `claude_request_async.fallbackModel` accepts string (independent) | async tool wired independently | same | catches forgetting to add the field on async-only |
| Hα-4 | `claude_request.jsonSchema` accepts string | string branch | `safeParse('{"type":"object"}')` → success=true | None |
| Hα-5 | `claude_request.jsonSchema` accepts object | object branch | `safeParse({type:"object"})` → success=true | None |
| Hα-6 | `claude_request.jsonSchema` rejects number / array | bounded via `z.union([string, record])` | `safeParse(42)`, `safeParse([1,2])` → success=false | catches accidental widening to `z.unknown()` |
| Hα-7 | `claude_request_async.jsonSchema` accepts string AND object (independent) | async tool wired independently | same | catches forgetting to add the field on async-only |

**Counterexample probes you must run:**
- **P-Hα-1**: Revert `fallbackModel` Zod on the *sync* tool to absent (delete the Zod entry). Hα-1 and Hα-2 must go red on `claude_request`. Hα-3 (async) stays green — proves the two tools are pinned independently.
- **P-Hα-2**: Loosen sync `jsonSchema` to `z.unknown().optional()`. Hα-6 must go red (number and array now accepted).
- **P-Hα-3**: Drop `.min(1)` on sync `fallbackModel`. Hα-2 must go red.

### Test set Hβ — `prepareClaudeRequest` + helper argv emission (end-to-end)

These tests thread through the actual `prepareClaudeRequest` (not just
the helper) so the wiring is verified end-to-end — the same lesson from
slice δ's `buildMistralRetryPrep` extraction.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Hβ-1 | `prepareClaudeRequest({fallbackModel:"claude-haiku-4-5-20251001"})` emits `--fallback-model claude-haiku-4-5-20251001` as adjacent tokens | argv emission | `prepareClaudeRequest(...).args` | None — direct argv inspection |
| Hβ-2 | `prepareClaudeRequest({jsonSchema:'{"a":1}'})` emits `--json-schema {"a":1}` as adjacent tokens (string passes verbatim) | argv emission, string branch | same | None |
| Hβ-3 | `prepareClaudeRequest({jsonSchema:{a:1}})` emits `--json-schema {"a":1}` as adjacent tokens (object → JSON.stringify) | argv emission, object branch | same | None — catches a regression to JSON.stringify + extra wrapping |
| Hβ-4 | `prepareClaudeRequest({})` (no fallbackModel or jsonSchema) emits NEITHER flag | absence | same | catches accidental always-emit |
| Hβ-5 | argv from `prepareClaudeRequest({fallbackModel,jsonSchema})` passes `validateUpstreamCliArgs` end-to-end | prepare → contract consistency (REGRESSIONS D pattern) | `validateUpstreamCliArgs("claude", prep.args)` | Closes the contract-table gap that bit slices α/γ/δ |

**Counterexample probes you must run:**
- **P-Hβ-1**: In `prepareClaudeHighImpactFlags`, remove the `fallbackModel` branch. Hβ-1 must go red AND Hβ-5 stays green (because the contract still permits arbitrary subset of optional flags) → confirms the falsifiability surface is the argv inspection, not just the contract.
- **P-Hβ-2**: Change `JSON.stringify(input.jsonSchema)` to `String(input.jsonSchema)` for the object branch. Hβ-3 must go red because `String({a:1}) === "[object Object]"`, which is not `'{"a":1}'`.
- **P-Hβ-3**: Add `"--fallback-model"` to the Zod enum WITHOUT registering it in `UPSTREAM_CLI_CONTRACTS.claude.flags`. Hβ-5 must go red (contract-violation message). This is the exact slice α/γ/δ regression class.
- **P-Hβ-4**: Remove `jsonSchema` from the Zod on the sync tool but leave the prepare function threading it. Hα-4/5 must go red AND the handler-level cannot pass through (compile-time safety).

### Test set Hε — UPSTREAM_CLI_CONTRACTS introspection + mechanical fixture validation

Mirrors slice ε's Eε pattern — fixture presence is necessary but not
sufficient; each new fixture must mechanically validate against the
contract inside the same `it()` block. This closes the gap Codex/Mistral
independently flagged on slice ε round 1.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Hε-1 | `validateUpstreamCliArgs("claude", ["-p","x","--fallback-model","claude-haiku-4-5-20251001"])` ok=true | contract accepts new flag | `validateUpstreamCliArgs` | None |
| Hε-2 | `validateUpstreamCliArgs("claude", ["-p","x","--fallback-model"])` ok=false (missing value — arity:one) | bounded arity | same | catches accidental `arity:"none"` |
| Hε-3 | `validateUpstreamCliArgs("claude", ["-p","x","--json-schema",'{"type":"object"}'])` ok=true | contract accepts new flag with JSON literal value | same | None |
| Hε-4 | `UPSTREAM_CLI_CONTRACTS.claude.flags["--fallback-model"]` exists with `arity:"one"` | direct introspection | direct read | None |
| Hε-5 | `UPSTREAM_CLI_CONTRACTS.claude.flags["--json-schema"]` exists with `arity:"one"` | direct introspection | direct read | None |
| Hε-6 | `UPSTREAM_CLI_CONTRACTS.claude.mcpParameters` contains `"fallbackModel"` AND `"jsonSchema"` | direct introspection | direct read | None |
| Hε-7 | `claude-fallback-model` fixture exists AND mechanically validates against the contract | REGRESSIONS F-style + mechanical (close slice-ε round-1 gap) | iterate `claude.conformanceFixtures` + `validateUpstreamCliArgs(fixture.args)` | None |
| Hε-8 | `claude-json-schema` fixture exists AND mechanically validates against the contract | same | same | None |

**Counterexample probes you must run:**
- **P-Hε-1**: Remove `--fallback-model` from `UPSTREAM_CLI_CONTRACTS.claude.flags`. Hε-1, Hε-4, Hε-7 must go red.
- **P-Hε-2**: Change `--json-schema` arity from `"one"` to `"none"`. Hε-3, Hε-5, Hε-8 must go red (Hε-3 because the JSON literal value is now an unknown positional; Hε-5 because the arity assertion fails; Hε-8 because the fixture mechanically fails).
- **P-Hε-3**: Delete the `claude-fallback-model` fixture from the array. Hε-7 must go red.
- **P-Hε-4**: Drop `"fallbackModel"` from `mcpParameters`. Hε-6 must go red.

## Round expectations

- **Round 1**: 4 LLMs (Codex, Gemini, Grok, Mistral; Claude as substitute
  if any are quota-exhausted or stall) launched async via `gtwy` MCP
  with the permission flags + MCP-server lists documented in
  `feedback_test_veracity_audit_protocol.md`. Each MUST:
  - Read the spec and the actual commit diff (`git diff master..HEAD`).
  - Run each P-Hα/β/ε probe (mutate → re-run
    `npx vitest run src/__tests__/test-veracity-regressions-slice-eta.test.ts`
    → observe colour → `git checkout -- src/` to restore → report).
  - Cite file:line for any disagreement; assertion-style verdicts are
    inadmissible.

- **Approval criterion**: Each probe produces a red test as predicted.
  No probe leaves the suite green when the feature is broken.

## Your output format

Per test (Hα-1 .. Hε-8): `[VERIFIED / FAIL / SKIP]` + one-sentence why, with file:line.
Per probe (P-Hα-1 .. P-Hε-4): `[as predicted / surprising — explain]`.
Gaps section: any remaining gap with the smallest test that would close it.
Overall: **UNCONDITIONAL APPROVE** or **REJECT (concrete blocker: file:line)**.

Be terse. Cite, don't summarize. Trust your own inspection of the repo, not this spec.
