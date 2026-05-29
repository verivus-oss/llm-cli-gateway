# Test-veracity audit — slice θ (Grok HIGH parity)

## Scope

You are auditing the **veracity of the tests** added across the commits
on branch `feat/phase-4-slice-theta` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits at
v1.12.0 (`cbb3bb2`).

The branch ships as v1.13.0. This audit answers: **do the new tests
prove what they claim, and would they go red if the feature broke?**

Slice θ wires five HIGH-impact Grok CLI flags through `grok_request` AND
`grok_request_async`. Grok is the most under-wired provider per the
2026-05-27 audit. Single CLI, well-bounded.

Target flags (verified against `grok --help` on Grok 0.1.210, 2026-05-27):

- `--sandbox <PROFILE>` — sandbox profile for filesystem and network
  access. Env: `GROK_SANDBOX`. **FREEFORM string** (no "possible values"
  list in --help, unlike `--effort` / `--permission-mode` /
  `--output-format` which all show `[possible values: …]` explicitly).
  Registered as `z.string().min(1).optional()`; contract entry
  `arity: "one"` with no `values` constraint. Passthrough — no
  approval-manager integration (Grok already has `permissionMode`,
  `alwaysApprove`, `approvalStrategy` covering approval semantics).
- `--rules <RULES>` — extra rules to append to the system prompt.
  Supports `@file` prefix per --help; gateway passes the value verbatim
  and lets Grok parse the prefix. Registered as `z.string().min(1).optional()`.
- `--system-prompt-override <PROMPT>` — overrides the agent's system
  prompt. Distinct from Claude's `--system-prompt` /
  `--append-system-prompt` (Grok has only one override flag, not a
  pair). Registered as `z.string().min(1).optional()`.
- `--allow <RULE>` — repeatable permission allow rule per --help
  ("Repeat to add multiple rules"). Each array entry → its own `--allow`
  argv instance.
- `--deny <RULE>` — repeatable permission deny rule per --help.
  Each array entry → its own `--deny` argv instance.

All five flags are surfaced on both `grok_request` and
`grok_request_async`.

## Files under review

```
src/index.ts                                                # MODIFIED: prepareGrokRequest signature + emission + sync/async Zod + handler threading
src/upstream-contracts.ts                                   # MODIFIED: grok.flags + grok.mcpParameters + 5 new conformance fixtures
src/__tests__/test-veracity-regressions-slice-theta.test.ts # NEW: REGRESSIONS Tα/Tβ/Tε (mutation-probe-friendly)
docs/plans/test-veracity-audit-slice-theta.spec.md          # NEW: this spec
```

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD --stat
git diff master..HEAD -- src/upstream-contracts.ts src/index.ts

# What every reviewer must replicate:
npm run build
npm test
npm run format:check
```

## Implementation surface to verify

1. **Zod fields** in both `grok_request` and `grok_request_async`
   registrations in `src/index.ts`:
   - `sandbox: z.string().min(1).optional()`
   - `rules: z.string().min(1).optional()`
   - `systemPromptOverride: z.string().min(1).optional()`
   - `allow: z.array(z.string()).optional()`
   - `deny: z.array(z.string()).optional()`
2. **`prepareGrokRequest` signature** in `src/index.ts:1950` accepts
   the five new params and emits:
   - `--sandbox <value>` when `sandbox` set
   - `--rules <value>` when `rules` set
   - `--system-prompt-override <value>` when `systemPromptOverride` set
   - `--allow <each>` per entry of `allow`
   - `--deny <each>` per entry of `deny`
3. **`GrokRequestParams` interface** + `handleGrokRequest` +
   `handleGrokRequestAsync` thread all five params from MCP-side
   destructure through to `prepareGrokRequest`.
4. **`UPSTREAM_CLI_CONTRACTS.grok`**:
   - `mcpParameters` includes `"sandbox"`, `"rules"`,
     `"systemPromptOverride"`, `"allow"`, `"deny"`.
   - `flags["--sandbox"]` exists with `arity: "one"` (NO `values`
     constraint — freeform per live --help).
   - `flags["--rules"]` exists with `arity: "one"`.
   - `flags["--system-prompt-override"]` exists with `arity: "one"`.
   - `flags["--allow"]` exists with `arity: "one"`.
   - `flags["--deny"]` exists with `arity: "one"`.
   - Five new passing conformance fixtures:
     `grok-sandbox`, `grok-rules`, `grok-system-prompt-override`,
     `grok-allow-repeated`, `grok-deny-repeated`.

## What each test CLAIMS to prove

For each test, you must independently confirm or deny:
(a) **the implementation surface it exercises** — what code path actually runs?
(b) **the falsifiability** — if the feature were broken, would this test go red?
(c) **a counterexample probe** — try to construct a code change that breaks the feature but leaves this test green.

### Test set Tα — Registered tool inputSchema (Zod, sync + async)

Inspects the *registered* tool's Zod shape via the
`getRegisteredToolSchema` helper used by slices ε/η/ζ. Sync and async
are asserted independently for every new field — the same gap that hit
slice δ (handler/argv tested but registered-tool schema not asserted)
cannot recur.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Tα-1 | `grok_request.sandbox` accepts non-empty string + rejects empty | bounded via `.min(1)` | `safeParse("workspace-write")` / `safeParse("")` | catches drop of `.min(1)` |
| Tα-2 | `grok_request_async.sandbox` accepts independently | async tool wired independently | same | catches sync-only wiring |
| Tα-3 | `grok_request.rules` accepts non-empty string + rejects empty | bounded via `.min(1)` | `safeParse("@./rules.md")` / `safeParse("")` | catches drop of `.min(1)` |
| Tα-4 | `grok_request_async.rules` accepts independently | async tool wired independently | same | catches sync-only wiring |
| Tα-5 | `grok_request.systemPromptOverride` accepts non-empty string + rejects empty | bounded via `.min(1)` | both branches | catches drop of `.min(1)` |
| Tα-6 | `grok_request_async.systemPromptOverride` accepts independently | async tool wired independently | same | catches sync-only wiring |
| Tα-7 | `grok_request.allow` accepts `string[]` | registered schema | `safeParse(["bash"])` | None |
| Tα-8 | `grok_request_async.allow` accepts independently | async tool wired independently | same | catches sync-only wiring |
| Tα-9 | `grok_request.deny` accepts `string[]` | registered schema | `safeParse(["edit"])` | None |
| Tα-10 | `grok_request_async.deny` accepts independently | async tool wired independently | same | catches sync-only wiring |

**Counterexample probes you must run:**
- **P-Tα-1**: Revert `sandbox` Zod on `grok_request` (sync) only. Tα-1 must go red; Tα-2 (async) stays green — proves the two tools are pinned independently.
- **P-Tα-2**: Drop `.min(1)` on `grok_request.rules`. Tα-3 must go red (empty-string rejection case).
- **P-Tα-3**: Revert `deny` Zod on `grok_request_async` only. Tα-10 must go red; Tα-9 (sync) stays green.

### Test set Tβ — `prepareGrokRequest` argv emission (end-to-end)

These tests thread through the actual `prepareGrokRequest` (not just a
helper) so the wiring is verified end-to-end — the same pattern as
slices δ/ζ.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Tβ-1 | `prepareGrokRequest({sandbox:"workspace-write"})` emits `--sandbox workspace-write` as adjacent tokens | argv emission | `prepareGrokRequest(...).args` | None — direct argv inspection |
| Tβ-2 | `prepareGrokRequest({rules:"@./rules.md"})` emits `--rules @./rules.md` as adjacent tokens (verbatim, gateway does NOT process the @ prefix) | argv emission | same | catches accidental @-prefix preprocessing |
| Tβ-3 | `prepareGrokRequest({systemPromptOverride:"You are a tester"})` emits `--system-prompt-override 'You are a tester'` as adjacent tokens | argv emission | same | None |
| Tβ-4 | `prepareGrokRequest({allow:["bash","edit"]})` emits two `--allow` instances with adjacent values | argv emission, repeatable | same | catches accidental comma-joining like `--tools` |
| Tβ-5 | `prepareGrokRequest({deny:["write","kill"]})` emits two `--deny` instances with adjacent values | argv emission, repeatable | same | catches accidental comma-joining |
| Tβ-6 | `prepareGrokRequest({})` (none set) emits none of the five flags | absence | same | catches accidental always-emit |
| Tβ-7 | argv from `prepareGrokRequest({sandbox,rules,systemPromptOverride,allow,deny})` passes `validateUpstreamCliArgs("grok", args)` end-to-end | prepare → contract consistency (REGRESSIONS D pattern) | `validateUpstreamCliArgs` | Closes the contract-table gap that bit slices α/γ/δ |

**Counterexample probes you must run:**
- **P-Tβ-1**: In `prepareGrokRequest`, change `args.push("--allow", rule)` (per element) to `args.push("--allow", input.allow.join(","))`. Tβ-4 must go red (one flag instance with comma-joined value instead of two adjacent pairs).
- **P-Tβ-2**: Remove the `--sandbox` emission entirely. Tβ-1 must go red AND Tβ-6 stays green (because contract permits absence) → confirms falsifiability surface is argv inspection, not just the contract.
- **P-Tβ-3**: Add `--allow` to the Zod schema WITHOUT registering it in `UPSTREAM_CLI_CONTRACTS.grok.flags`. Tβ-7 must go red (contract-violation message). The slice α/γ/δ regression class.
- **P-Tβ-4**: Change `args.push("--rules", input.rules)` to `args.push("--rules", input.rules.replace(/^@/, ""))` (pretend to "helpfully" strip the @ prefix). Tβ-2 must go red — gateway must pass value verbatim.

### Test set Tε — UPSTREAM_CLI_CONTRACTS introspection + mechanical fixture validation

Mirrors slice η's Hε / ζ's Zε pattern. Each new fixture must
mechanically validate against the contract inside the same `it()`
block — closes the gap Codex/Mistral independently flagged on slice ε
round 1.

| # | Test | Claim | Code path | Suspected weakness |
|---|------|-------|-----------|---------------------|
| Tε-1 | `validateUpstreamCliArgs("grok", ["-p","x","--sandbox","workspace-write"])` ok=true | contract accepts new flag, freeform value | `validateUpstreamCliArgs` | None |
| Tε-2 | `validateUpstreamCliArgs("grok", ["-p","x","--sandbox"])` ok=false (missing value — arity:one) | bounded arity | same | catches accidental `arity:"none"` |
| Tε-3 | `validateUpstreamCliArgs("grok", ["-p","x","--rules","@./r.md"])` ok=true | contract accepts new flag | same | None |
| Tε-4 | `validateUpstreamCliArgs("grok", ["-p","x","--system-prompt-override","You are a tester"])` ok=true | contract accepts new flag | same | None |
| Tε-5 | `validateUpstreamCliArgs("grok", ["-p","x","--allow","bash","--allow","edit"])` ok=true | contract accepts repeated flag instances | same | catches `arity:"one"` failing on repeats (it should not — `arity:"one"` means "consumes one value", not "max one instance") |
| Tε-6 | `validateUpstreamCliArgs("grok", ["-p","x","--deny","write","--deny","kill"])` ok=true | contract accepts repeated flag instances | same | None |
| Tε-7 | Direct introspection: all 5 new flag entries exist with `arity:"one"` and no `values` constraint on `--sandbox` (freeform) | direct read | direct read of `UPSTREAM_CLI_CONTRACTS.grok.flags` | catches accidental enum constraint |
| Tε-8 | Direct introspection: `mcpParameters` contains all 5 new param names | direct read | direct read | None |
| Tε-9 | All 5 new fixtures exist AND mechanically validate against the contract | REGRESSIONS F-style + mechanical (close slice-ε round-1 gap) | iterate fixtures + `validateUpstreamCliArgs` | None |

**Counterexample probes you must run:**
- **P-Tε-1**: Remove `--sandbox` from `UPSTREAM_CLI_CONTRACTS.grok.flags`. Tε-1, Tε-7, Tε-9 (for `grok-sandbox`) must go red.
- **P-Tε-2**: Add `values: ["read-only", "workspace-write"]` to `--sandbox` (pretend to mistake it for an enum). Tε-1 stays green (workspace-write is valid) BUT a probe with an unlisted value like "test-profile" would fail — add a probe-side assertion to catch this: an additional probe at the prepare level that emits `--sandbox custom-profile` must pass `validateUpstreamCliArgs`. *Reviewers: please verify by adding `values: ["read-only"]` to the contract and observing that the `grok-sandbox` fixture passing `"workspace-write"` goes red.*
- **P-Tε-3**: Change `--allow` arity from `"one"` to `"none"`. Tε-5 must go red (repeated values become unknown positionals).
- **P-Tε-4**: Delete the `grok-allow-repeated` fixture. Tε-9 (for that fixture id) must go red.
- **P-Tε-5**: Drop `"systemPromptOverride"` from `mcpParameters`. Tε-8 must go red.

## Round expectations

- **Round 1**: 5 LLMs (Codex, Gemini, Grok, Mistral, Claude) launched
  async via `gtwy` MCP with the permission flags + MCP-server lists
  documented in `feedback_test_veracity_audit_protocol.md`. Per the
  slice-η + ζ lessons — run all 5 from the start so a single
  stall/quota-exhaust does not undermine the gate.

  Each reviewer MUST:
  - Read the spec AND the actual commit diff (`git diff master..HEAD`).
  - Run each P-Tα/β/ε probe (mutate → re-run
    `npx vitest run src/__tests__/test-veracity-regressions-slice-theta.test.ts`
    → observe colour → `git checkout -- src/` to restore → report).
  - Cite file:line for any disagreement; assertion-style verdicts are
    inadmissible.

- **Approval criterion**: Each probe produces a red test as predicted.
  No probe leaves the suite green when the feature is broken.

## Your output format

Per test (Tα-1 .. Tε-9): `[VERIFIED / FAIL / SKIP]` + one-sentence why, with file:line.
Per probe (P-Tα-1 .. P-Tε-5): `[as predicted / surprising — explain]`.
Gaps section: any remaining gap with the smallest test that would close it.
Overall: **UNCONDITIONAL APPROVE** or **REJECT (concrete blocker: file:line)**.

Be terse. Cite, don't summarize. Trust your own inspection of the repo, not this spec.
