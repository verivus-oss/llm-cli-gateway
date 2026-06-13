# Verification report: `define-acp-provider-registry-and-errors`

- **Plan**: `docs/plans/first-class-acp-gateway-extension.dag.toml`
- **Step id**: `define-acp-provider-registry-and-errors` (DAG lines 531-554)
- **Verifier role**: independent (did not trust implementer; re-read source + tests and re-ran them)
- **Implementation under review**: worktree `.claude/worktrees/wf_a414fd6a-a3f-6` at HEAD `f6769ce` ("feat(acp): add provider registry and typed error taxonomy"), parent `662bfdc`.
- **Verdict**: PASS. All validation rows pass; no vacuous tests.

## Files this step's commit adds (and nothing else)

`git show --stat f6769ce` — only 4 new files, no modifications to existing modules:

- `src/acp/provider-registry.ts` (+212)
- `src/acp/errors.ts` (+262)
- `src/__tests__/acp-provider-registry.test.ts` (+121)
- `src/__tests__/acp-errors.test.ts` (+184)

(Absolute paths under `.claude/worktrees/wf_a414fd6a-a3f-6/`.)

## DAG validation clause (lines 550-554)

> Provider-registry tests assert exact status for Mistral, Grok, Codex, Claude,
> and Antigravity agy. Error tests assert raw JSON-RPC payloads and credential
> paths do not appear in user-facing messages.

Two behavioral requirements, both proven below.

## Command-output digests

### Focused test run (the step's two test files)

`npx vitest run src/__tests__/acp-provider-registry.test.ts src/__tests__/acp-errors.test.ts`

```
Test Files  2 passed (2)
     Tests  33 passed (33)
```

Verbose reporter confirmed all 33 individual `✓` lines (19 in acp-errors, 14 in acp-provider-registry).

### Production build (the actual compile gate)

`npm run build` → `tsc -p tsconfig.build.json` (excludes `src/__tests__`, line confirmed in `tsconfig.build.json`): `BUILD_EXIT:0`. The two new source modules compile clean.

### Lint

`npx eslint src/acp/provider-registry.ts src/acp/errors.ts` → `LINT_EXIT:0` (0 errors; 4 `security/detect-object-injection` warnings only — non-blocking, consistent with the rest of the codebase). Test files are eslint-ignored by repo config (warning only).

### Pre-existing tsc note (not a regression)

`npx tsc --noEmit` (full project incl. tests) reports errors, but ALL are in unrelated pre-existing test files (`async-job-manager-flight-recorder.test.ts`, `grok-api-provider.test.ts`, `mcp-surface-usability.test.ts`, `provider-tool-capabilities.test.ts`, etc.). This step's commit touches none of those files, and the production build (`tsconfig.build.json`, which excludes `src/__tests__`) is the gate and exits 0. Not attributable to this step.

## Claim-by-claim verification (each cites file:line + test name + digest)

### Requirement 1 — exact ACP status for all five providers

| Provider | Expected status | Source proof | Test proof |
|---|---|---|---|
| mistral | `native_smoke_passed` | `src/acp/provider-registry.ts:106` | `acp-provider-registry.test.ts:39` "reports exact ACP status and support kind for mistral" (status map line 23) |
| grok | `native_smoke_passed` | `src/acp/provider-registry.ts:120` | same parametrised test (line 24) |
| codex | `adapter_mediated_deferred` | `src/acp/provider-registry.ts:134` | same test (line 25) + "labels no adapter-mediated provider as native" (line 58) |
| claude | `adapter_mediated_deferred` | `src/acp/provider-registry.ts:148` | same test (line 26) + line 58 |
| gemini (agy) | `absent_watchlist` | `src/acp/provider-registry.ts:162` | "targets Antigravity agy 1.0.7 ... watchlist with no entrypoint" (line 47) |

Supporting assertions all green:
- support-kind exactness (native/adapter_mediated/none) — `acp-provider-registry.test.ts:43`, map lines 30-36.
- gemini targets `agy 1.0.7`, `entrypoint === null`, not a pilot — test lines 50-55; source lines 161-168.
- no adapter labelled native; codex/claude `entrypoint === null`, `providerHasNativeAcp === false`, adapter candidates present — test lines 59-66; source lines 137/152/141/155, `providerHasNativeAcp` at line 196.
- registry covers exactly the five `CLI_TYPES` (`["claude","codex","gemini","grok","mistral"]`, `src/session-manager.ts:21`) — test lines 17-20.
- native entrypoints stored as `{command, args[]}`, no shell metachars — test lines 69-87; source lines 109 (`vibe-acp`, `[]`) and 123 (`grok`, `["agent","stdio"]`). This is the structural proof of the step's `no_shell_eval_for_entrypoints` constraint.
- every `runtimeEnabledDefault === false` — test lines 89-93; source (all five entries set `false`).
- pilot order `["mistral","grok"]` — test lines 95-97; source `getRuntimePilotProviders` lines 207-212 sorts by `runtimePriority` (mistral=1, grok=2).
- registry frozen (data-only, no mutation) — test lines 107-111; source `Object.freeze` at line 102 and per-entry.
- caveat strings carry no `/home/`, `~/`, or `sk|xai|gsk-` token — test lines 113-120.

### Requirement 2 — raw JSON-RPC payloads and credential paths absent from user-facing messages

Source: `src/acp/errors.ts`. `redactAcpMessage` (lines 42-62) collapses JSON bodies (`{...}`/`[...]` → `<redacted-json>`), strips bearer/api tokens, absolute + home-relative paths, and emails. `AcpError` constructor (line 117) applies `redactAcpMessage(userMessage)` to `super(...)`, so `message`/`userMessage` are redacted at construction.

| Claim | Source proof | Test proof |
|---|---|---|
| Raw JSON-RPC body removed from message | errors.ts:47-48, 117 | "redacts a JSON-RPC payload embedded in the message" (acp-errors.test.ts:89): asserts `userMessage` NOT contain `"leak this secret prompt text"` nor `"session/prompt"` (lines 94-95) |
| Credential path removed from message | errors.ts:55-56, 117 | "redacts credential paths embedded in the message" (acp-errors.test.ts:101): asserts `userMessage` NOT contain `/home/werner/.config/grok/credentials.json` nor `credentials.json` (lines 105-106) |
| `error.cause` preserved but not leaked into message | errors.ts:122-124 | "preserves a cause without leaking it into the message" (acp-errors.test.ts:109): cause retained, token + path absent from `userMessage` |
| `redactAcpMessage` strips JSON / paths / home-paths / tokens / emails | errors.ts:42-62 | acp-errors.test.ts:30,37,44,50,55 (5 tests, all green) |
| `redactAcpDebug` drops sensitive keys + recurses | errors.ts:72-94 | acp-errors.test.ts:63 "drops sensitive keys and redacts string values recursively" |
| Each typed subclass carries correct `kind` + provider, redacts embedded paths | errors.ts:135-257 | acp-errors.test.ts:118-183 (10 subclass tests incl. `ProviderUnavailableError` path-redaction at line 145) |

## Non-vacuity confirmation (no mutation probe required; read-confirmed)

Tests are real, not green-by-construction:

- Redaction tests pair a **negative** assertion (`not.toContain(<sentinel>)`) with a **positive** one (`toContain("<redacted-json>")` / `"<redacted-path>"` / `"<redacted-email>"`). A no-op redaction would leave the sentinel present (failing the negative) AND omit the placeholder (failing the positive) — a stub cannot satisfy both. Re-ran: all green.
- Registry status tests assert against an explicit `expectedStatus`/`expectedSupportKind` literal map (acp-provider-registry.test.ts:22-36), compared with `.toBe(...)` exact-equality — not existence checks. Wrong literals would fail.
- `getRuntimePilotProviders()` ordering asserted with `.toEqual(["mistral","grok"])` (exact array), not a set/length check.
- `entrypoint` shape asserted with `.toEqual({command, args})` deep-equality, and a regex negative-assert against shell metacharacters `[;&|\`$<>()]`.
- Tests import real symbols from `../acp/provider-registry.js` and `../acp/errors.js`; no internal mocking of the unit under test. The vitest run executed the actual module code (build exit 0 confirms the same source compiles).

## Validation rows summary

| Row | Result |
|---|---|
| Provider-registry tests assert exact status for Mistral/Grok/Codex/Claude/agy | PASS (33/33 tests green; exact-literal assertions) |
| Error tests assert raw JSON-RPC payloads + credential paths absent from user-facing messages | PASS (acp-errors.test.ts:89,101 green) |
| Production build compiles (`npm run build`) | PASS (exit 0) |
| Lint on new source | PASS (0 errors) |

vacuousTests: none. failures: none.
