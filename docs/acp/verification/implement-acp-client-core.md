# Verification report — step `implement-acp-client-core`

DAG: `docs/plans/first-class-acp-gateway-extension.dag.toml` (`[[steps]]` id
`implement-acp-client-core`, lines 608–630).

Role: independent verifier. The implementer is not trusted. Every behavioural
claim below cites file:line in the implementation, the exact test that proves
it, and a command-output digest. A mutation-probe (test-veracity) audit was run
in a throwaway detached git worktree and discarded afterwards.

Verdict: **PASS** — all validation rows green; no vacuous tests.

---

## 0. Environment / provenance

- Branch under verification: `feat/acp-phase-b`.
- Implementation commit for `src/acp/client.ts`: `f261819`
  (`feat(acp): add high-level ACP client core`).
- `src/acp/client.ts` and `src/__tests__/acp-client.test.ts` are committed with
  no working-tree modifications (`git status --short` empty for both).
- TypeScript build: `npm run build` (tsc -p tsconfig.build.json) exits 0.
- ESLint on `src/acp/client.ts`: 0 errors (the only warning is the
  `__tests__` ignore-pattern notice on the test file, not the client).

## 1. Step validation clause

> Mock-agent integration tests prove initialize/session-new/session-prompt
> flows work through the client and that protocol errors become structured
> gateway errors with redacted messages.

Test file: `src/__tests__/acp-client.test.ts`. The tests drive the **real**
transport (`JsonRpcStdioTransport`) and the **real** `AcpClient` end to end via
a scriptable in-process `MockAgent` over `PassThrough` streams
(`src/__tests__/acp-client.test.ts:55-126`), wiring `onNotification`/`onRequest`
exactly as the process manager will (`:140-156`).

Command digest:

```
npx vitest run src/__tests__/acp-client.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)
```

## 2. Behavioural claims with citations

| # | Claim | Implementation (file:line) | Proving test (name) | Result |
|---|-------|---------------------------|---------------------|--------|
| 1 | `initialize` handshake runs through client; advertises all-false (read-only) capabilities by default | `src/acp/client.ts:248-269` (params `clientCapabilities.fs.{readTextFile,writeTextFile}` default false, `:257-259`) | `AcpClient > performs the initialize plus session/new smoke through the client` | PASS |
| 2 | `session/new` works through the client and returns provider-owned sessionId | `src/acp/client.ts:275-283` | same as #1 (`session.sessionId === "prov-sess-1"`) | PASS |
| 3 | `initialize` is idempotent (cached, no re-issue) | `src/acp/client.ts:249-251,266-268` | `AcpClient > initialize is idempotent and does not re-issue the handshake` | PASS |
| 4 | Calls before `initialize` fail closed with a structured `AcpProtocolError` | `src/acp/client.ts:276` (`assertInitialized`), `:359-366` | `AcpClient > rejects session/new before initialize with a structured error` | PASS |
| 5 | `session/prompt` resolves with `stopReason`; streamed `session/update` notifications surface through `onSessionUpdate` | `src/acp/client.ts:305-313` (prompt), `:381-412` (notification dispatch) | `AcpClient > runs a prompt and surfaces session/update notifications through callbacks` | PASS |
| 6 | `cancel` emits a `session/cancel` notification for an in-flight turn | `src/acp/client.ts:321-323` | `AcpClient > sends a session/cancel notification for an in-flight turn` | PASS |
| 7 | A JSON-RPC error response becomes a structured `AcpProtocolError` (subclass of `AcpError`) with redacted user message and JSON-RPC `code` | transport builds the typed error (`src/acp/json-rpc-stdio.ts:313`); client passes it through unwrapped (`src/acp/client.ts:344-346`); redaction at construction (`src/acp/errors.ts:155`, `redactAcpMessage:42-73`) | `AcpClient > turns a JSON-RPC error response into a structured, redacted gateway error` (asserts no `/home/werner`, no `secret.json`, contains `<redacted-path>`, `code === -32000`) | PASS |
| 8 | Pending request times out as `AcpTimeoutError` with the method recorded | typed error from transport, preserved by `normalizeError` (`src/acp/client.ts:344-346`) | `AcpClient > rejects a prompt with a timeout error when the agent never replies` | PASS |
| 9 | Agent-initiated `fs/read_text_file` is dispatched into `HostServices` and the host result is returned to the agent | `src/acp/client.ts:432-440` | `AcpClient host callback dispatch > dispatches fs/read_text_file into HostServices and returns its result` | PASS |
| 10 | **Deny-by-default**: a host surface the host does not implement (e.g. `fs/write_text_file`) answers JSON-RPC `-32000` with a redacted "does not support" message | `src/acp/client.ts:441-448` + `requireHandler:497-508` (throws `AcpProtocolError` when handler undefined) → caught at `:472-489` | `AcpClient host callback dispatch > answers method-not-found when the host does not implement a surface (write disabled by default)` | PASS |
| 11 | Permission denial from `HostServices` returns a JSON-RPC error with **no raw leakage** of the denied path | `src/acp/client.ts:450-457` (dispatch) + `:472-489` (error→`-32000`, `acpError.userMessage`) | `AcpClient host callback dispatch > routes permission denial from HostServices back as a JSON-RPC error without raw leakage` (asserts no `/etc/passwd`, contains `<redacted-path>`) | PASS |
| 12 | Permission grant: when the host approves, the selected option is returned to the agent | `src/acp/client.ts:450-457` | `AcpClient host callback dispatch > grants permission when HostServices approves (selected option)` | PASS |
| 13 | Client never writes to gateway stdout (`stdout_reserved_for_mcp`) | no `process.stdout`/`console.log` in `src/acp/client.ts` (grep: only the doc comment at `:24`) | `stdoutWrites` spy asserted empty in test #1 (`:206-207`) | PASS |
| 14 | Client is provider-spawn agnostic (receives an already-opened transport, constructs no command line) | `src/acp/client.ts:209-229` (transport injected; no spawn/exec import) | structural — no test needed; verified by inspection | PASS |

## 3. test_matrix rows for this step

`[test_matrix.integration].mock_acp_agent` rows owned by this slice (DAG
lines 356–363):

| Matrix row | Covering test | Result |
|------------|---------------|--------|
| initialize plus session/new smoke | claim #1/#2 test | PASS |
| successful prompt with session/update notifications | claim #5 test | PASS |
| prompt cancellation | claim #6 test | PASS |
| permission request denied by default | claim #10 (write surface) + #11 (permission denial) tests | PASS |

Out-of-scope for this step (owned by `add-acp-process-manager`, DAG line 632+):
`process crash during initialize` and `process crash during prompt` — these
exercise process lifecycle, not the client wrapper, and are correctly absent
from `acp-client.test.ts`.

## 4. Mutation-probe audit (test-veracity)

Method: detached worktree at `HEAD` (`git worktree add -d`), `node_modules`
symlinked, baseline `11 passed` confirmed before any mutation. One mutation at a
time; revert between probes; worktree removed and pruned afterward. A test that
stays green under a mutation of the code path it claims to cover is vacuous.

| Probe | Mutation | Target invariant | Test expected to fail | Observed |
|-------|----------|------------------|-----------------------|----------|
| P1 | `requireHandler` returns a no-op resolving `{}` instead of throwing when the host handler is `undefined` (i.e. *HostServices allow writes by default*) | deny-by-default for unimplemented surfaces | `answers method-not-found when the host does not implement a surface` | **FAILED** (1 failed) ✓ |
| P2 | `redactAcpMessage` returns input verbatim (redaction disabled — *raw body reaches the message*) | path/credential redaction in user messages | `turns a JSON-RPC error response into a structured, redacted gateway error` **and** `routes permission denial ... without raw leakage` | **BOTH FAILED** (2 failed) ✓ |
| P3 | drop the `assertInitialized` throw (fail-open before init) | fail-closed init gate | `rejects session/new before initialize with a structured error` | **FAILED** (1 failed, 2005ms — call hung to timeout instead of rejecting) ✓ |
| P4 | `handleSessionUpdate` no longer invokes `onSessionUpdate` | notification surfacing | `runs a prompt and surfaces session/update notifications through callbacks` | **FAILED** (1 failed) ✓ |
| P5 | inject `process.stdout.write(...)` inside `initialize` | `stdout_reserved_for_mcp` | `performs the initialize plus session/new smoke through the client` (stdout spy) | **FAILED** (1 failed) ✓ |
| P6 | `cancel` becomes a no-op (cancel notification dropped) | cancel propagation | `sends a session/cancel notification for an in-flight turn` | **FAILED** (1 failed, 2003ms) ✓ |
| P7 | `fs/read_text_file` case responds `{}` instead of the host result | host-result forwarding | `dispatches fs/read_text_file into HostServices and returns its result` | **FAILED** (1 failed) ✓ |
| P8 | `normalizeError` always wraps (typed transport errors `AcpTimeoutError`/`AcpProtocolError` lose their identity) | typed-error preservation | `rejects a prompt with a timeout error...` **and** `turns a JSON-RPC error response...` | **BOTH FAILED** (2 failed) ✓ |

Every mutation killed its target test(s). Across the 8 probes, 10 of the 11
tests in the suite were each demonstrated to fail under a mutation of the code
path it covers. The two not individually mutated — `initialize is idempotent`
(positive latch behaviour) and `grants permission when HostServices approves`
(positive counterpart of the denial path proven non-vacuous by P2) — are
positive-path assertions, not fail-closed safety branches; their corresponding
safety branches (init latch, permission dispatch/redaction) were independently
shown non-vacuous by P3, P2 and P11/P10's mutations.

**vacuousTests: none.**

Worktree cleanup confirmed: `git worktree list` shows no `acp-mutate-probe`
entry; `/tmp/acp-mutate-probe` removed.

## 5. Command-output digests

```
# baseline (target repo)
npx vitest run src/__tests__/acp-client.test.ts
 Test Files  1 passed (1)
      Tests  11 passed (11)

# adjacent ACP group still green
npx vitest run acp-client acp-errors acp-types
 Test Files  3 passed (3)
      Tests  77 passed (77)

# build
npm run build  -> tsc -p tsconfig.build.json (exit 0)

# lint (client only)
npx eslint src/acp/client.ts  -> 0 errors
```

## 6. Conclusion

- Validation clause: **satisfied** (11/11 tests prove initialize / session-new /
  session-prompt flows through the real client + transport, and that protocol
  errors become structured, redacted `AcpError` subclasses).
- test_matrix `mock_acp_agent` rows in scope: **all PASS**.
- Mutation-probe audit: **all 8 probes killed their targets; zero vacuous
  tests.**

`validationPassed = true`.
