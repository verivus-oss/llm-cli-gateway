# Verification report — step `build-json-rpc-stdio-transport`

Independent verifier. The implementer's claims were NOT trusted; every behavioral
claim below is backed by a `file:line` citation, the exact test name proving it,
and a command-output digest. A mutation-probe (test-veracity) audit was run in a
throwaway git worktree to prove each new test fails when the code path it claims
to cover is broken.

- Plan: `docs/plans/first-class-acp-gateway-extension.dag.toml` `[[steps]]` `id = "build-json-rpc-stdio-transport"` (lines 556-579).
- Implementation under test: `src/acp/json-rpc-stdio.ts` (committed in `3cf062f feat(acp): add newline-delimited JSON-RPC stdio transport`).
- Tests under test: `src/__tests__/acp-json-rpc-stdio.test.ts` (16 tests).
- Result: **PASS** — validation clause satisfied, all 6 `test_matrix.unit.json_rpc_transport` rows proven, no vacuous tests.

---

## 1. Validation-clause coverage

DAG validation clause (lines 575-579):

> Focused unit tests simulate fragmented messages, batched pending requests,
> notifications, JSON-RPC errors, invalid JSON, timeout, and process exit. Tests
> prove no gateway stdout writes occur.

| Validation requirement | Code (`src/acp/json-rpc-stdio.ts`) | Proving test (`src/__tests__/acp-json-rpc-stdio.test.ts`) |
|---|---|---|
| fragmented messages | `onStdoutData` buffer/split loop, lines 190-200 | `parses fragmented newline-delimited messages split across chunks` (L128) |
| batched pending requests | `pending` map + `resolveResponse` L298-331; `nextId` L352 | `handles multiple newline-delimited frames arriving in one chunk` (L142); `resolves batched pending requests out of order` (L159) |
| notifications | `dispatchNotification` L254/267-278; `onNotification?.()` L270 | `dispatches notifications to the notification handler` (L176) |
| JSON-RPC errors | error branch L310-328, `pending.reject(new AcpProtocolError…)` L312 | `surfaces JSON-RPC errors as AcpProtocolError with the code` (L211) |
| invalid JSON | `JSON.parse` try/catch L225-236, log error-class only L230-235 | `ignores invalid JSON without crashing and logs an error class only` (L228) |
| timeout | `setTimeout` arm L359-377, `new AcpTimeoutError` L369 | `times out a pending request and rejects with AcpTimeoutError` (L249); `honours a per-request timeout override` (L264) |
| process exit | `handleProcessExit` L466-483; `failPending` L481/502-510; fail-closed guard L341-343 | `propagates process exit to all pending requests` (L287); `rejects new requests after process exit` (L303); `fails pending requests when stdout closes without an explicit exit` (L310) |
| no gateway stdout writes | module has zero `process.stdout`/`console.*` refs; stderr routed via injected logger L211 | `forwards provider stderr through the gateway logger, never stdout` (L320); `never writes to the gateway process stdout across a full request lifecycle` (L331) |

The no-stdout invariant is enforced at the test level by a `process.stdout.write`
spy installed in `beforeEach` (test L95-105) and asserted `toEqual([])` (test
L352). Static confirmation: `grep -nE 'process\.stdout|console\.' src/acp/json-rpc-stdio.ts`
returns **0 matches**.

---

## 2. `test_matrix.unit.json_rpc_transport` rows (lines 325-332)

| Matrix row | Proving test | Status |
|---|---|---|
| `parses fragmented newline-delimited messages` | `parses fragmented newline-delimited messages split across chunks` (L128) | PASS |
| `correlates responses by id` | `correlates responses by id and resolves the matching request` (L112) | PASS |
| `dispatches notifications` | `dispatches notifications to the notification handler` (L176) | PASS |
| `surfaces JSON-RPC errors` | `surfaces JSON-RPC errors as AcpProtocolError with the code` (L211) | PASS |
| `times out pending requests` | `times out a pending request and rejects with AcpTimeoutError` (L249) | PASS |
| `rejects writes after process exit` | `rejects new requests after process exit` (L303) | PASS |

All 6 matrix rows have a dedicated test. The `installed_provider_smoke`,
`gateway_tools`, `resources`, and `integration` rows belong to later steps
(`define-acp-protocol-types` onward) and are out of scope here.

---

## 3. Command-output digests

`npx vitest run src/__tests__/acp-json-rpc-stdio.test.ts` (clean tree):

```
 Test Files  1 passed (1)
      Tests  16 passed (16)
```

`npm run build` (`tsc -p tsconfig.build.json`):

```
> llm-cli-gateway@2.7.0 build
> tsc -p tsconfig.build.json
EXIT:0
```

Production build is green. Note: a bare `tsc --noEmit` reports pre-existing
type errors in UNRELATED, working-tree-modified test files
(`grok-api-provider.test.ts`, `mcp-surface-usability.test.ts`,
`async-job-manager-flight-recorder.test.ts`, `provider-tool-capabilities.test.ts`,
etc.). These are excluded from the build (`tsconfig.build.json` excludes
`src/__tests__`), predate this step, and do not involve `src/acp/`. They are not
introduced by this step and do not affect the transport.

Static no-stdout-logging check:

```
grep -nE 'console\.(log|info|warn|error)|process\.stdout' src/acp/json-rpc-stdio.ts
=> NONE FOUND
```

---

## 4. Mutation-probe (test-veracity) audit

A detached throwaway worktree was created at HEAD (`git worktree add -d
/tmp/acp-mutprobe HEAD`), `node_modules` symlinked, each key code path mutated in
isolation, tests run, then the worktree was discarded
(`git worktree remove --force`). Between every mutation the source was restored
from a backup; the final restored tree was re-run green (16/16) before removal.

The task's three named example mutations were adapted to this layer:
- "make HostServices allow writes by default" — HostServices is a SIBLING step
  (`define-host-services-boundary`), not this file. The equivalent fail-closed
  branch here is the **process-exit guard** (Probe 5).
- "let a raw JSON-RPC body reach the flight recorder" — this transport has zero
  flight-recorder coupling by design (no import; `grep` confirms 0 matches). The
  equivalent "no raw body reaches a log sink" redaction guard is the
  **invalid-JSON log** (Probe 7) and the stderr/stdout routing (Probe 6).
- "drop a fail-closed branch" — Probes 3 (error surfacing), 5 (post-exit
  rejection), and 9 (exit fails pending) each drop a distinct fail-closed branch.

| # | Mutation (code path) | Expected test to fail | Observed |
|---|---|---|---|
| 1 | `resolveResponse` looks up a fixed wrong id (`pending.get(999999)`) — breaks response/id correlation | `correlates responses by id…` | FAILED (8 tests failed: correlation + all response-dependent) |
| 2 | `onStdoutData` treats each raw chunk as a whole frame; no newline reassembly | `parses fragmented…`, `handles multiple…frames in one chunk` | FAILED (2 tests failed) |
| 3 | drop the JSON-RPC error branch (`if (false)` at L310) — error responses resolve instead of reject | `surfaces JSON-RPC errors…` | FAILED (1 test) |
| 4 | never arm the timeout timer (`if (false)` at the `effectiveTimeout > 0` guard) | `times out a pending request…`, `honours a per-request timeout override` | FAILED (2 tests, real timeout) |
| 5 | drop the post-exit fail-closed guard in `request()` (L341-343) | `rejects new requests after process exit` | FAILED (1 test) |
| 6 | leak provider stderr to `process.stdout.write` instead of the logger | `forwards provider stderr…never stdout`, `never writes to the gateway process stdout…` | FAILED (2 tests; stdout spy caught `"a stderr diagnostic\n"`) |
| 7 | leak the raw invalid line into the `invalid_json` log payload (`raw: trimmed`) | `ignores invalid JSON…logs an error class only` | FAILED (1 test; redaction assertion tripped) |
| 8 | never invoke `onNotification` handler | `dispatches notifications…` | FAILED (1 test) |
| 9 | `handleProcessExit` skips `failPending` | `propagates process exit to all pending requests` | FAILED (1 test) |

Every mutation produced at least one corresponding FAILED test. **No test stayed
green under its mutation — `vacuousTests` is empty.** The throwaway worktree was
removed; `git worktree list` confirms no residual `/tmp/acp-mutprobe`.

---

## 5. Verdict

- Validation clause: satisfied (all 7 simulated conditions + no-stdout proof).
- `test_matrix.unit.json_rpc_transport`: all 6 rows proven by named tests.
- Production build: green.
- Mutation-probe audit: 9/9 probes correctly failed their tests; 0 vacuous tests.

**validationPassed = true.**
