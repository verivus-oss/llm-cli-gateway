# Phase B — Round 6 — Grok adversarial release review

- **Reviewer lens:** grok
- **Verdict:** APPROVED
- **Job:** `63a7e812-5658-4f39-b094-1ce2e50caf31` (correlationId `b2587da5-dfc9-445c-8984-9d0c7f778c9a`)
- **Change set reviewed:** `7d06af1..5c90024`
- **Date:** 2026-06-13

> Note: an earlier attempt (`1f1aa3a4-7754-4e75-af76-5cdb56e33bc0`) failed because the default
> Grok model `grok-composer-2.5-fast` rejects the `reasoningEffort` parameter (HTTP 400). The
> review was re-run without `effort` and completed successfully.

---

## Reviewer reply (verbatim)

I'll perform an adversarial release review: read the verification report and changed files, then run the cited tests and build commands myself.
Running gates and inspecting the Phase B source, tests, and DAG requirements.
Full suite failed due to `FORCE_COLOR` in the environment; re-running tests without it and continuing the security audit.
## Verdict: **APPROVED**

Independent adversarial review of Phase B at `5c90024` (`7d06af1..5c90024`). The verification report was treated as a claim only; everything below is from code/docs/tests I opened and commands I ran.

---

### Gates (executed locally)

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | exit 0 | Ran at `5c90024` |
| Four ACP suites | **96/96** | `npx vitest run` on the four `acp-*` files — transport 22, types 40, client 11, process-manager 22 |
| `npm test` | **1384/1384** | Passes with `FORCE_COLOR` unset; fails 1382/1384 here only because `FORCE_COLOR` set in this shell makes Node emit stderr warnings into `cli-entrypoint.test.ts` — environmental, not Phase B |
| `npm run upstream:contracts` | OK | `contracts-check OK: 5 providers` |
| `git diff --check` (`src/`) | clean | No whitespace errors on source surface |

---

### Scope / CLI path unchanged

`git diff 7d06af1..5c90024 --name-only -- 'src/' ':!src/acp/' ':!src/__tests__/acp-*'` returned **empty**. Phase B is additive under `src/acp/` plus four test files; existing CLI transport modules are untouched.

---

### DAG validation clauses (four Phase B steps)

**`build-json-rpc-stdio-transport`** — validation at `dag.toml:575-579` satisfied by non-vacuous transport tests:

- Fragmented/batched messages, notifications, inbound requests, JSON-RPC errors, invalid JSON (error class + bytes only), timeouts, process exit, stdout close/error termination
- `process.stdout.write` spy asserted `toEqual([])` in `never writes to the gateway process stdout across a full request lifecycle`
- `grep` on `src/acp/`: **zero** `process.stdout` / `console.*` call sites (only doc comments in `errors.ts`)

**`define-acp-protocol-types`** — validation at `dag.toml:602-606` satisfied:

- Mistral nested `agentInfo` and Grok flat `agentVersion` fixtures parse with `.passthrough()`
- Strict required fields, unknown `session/update` variants preserved, Round-3 content-block fix: known type missing required field **rejects** (`rejects a known content block type that omits its required fields`)

**`implement-acp-client-core`** — validation at `dag.toml:626-630` satisfied:

- Real `JsonRpcStdioTransport` + real `AcpClient` over `PassThrough` mock agent
- initialize (idempotent), fail-closed before init, session/new, session/prompt + streamed updates, session/cancel, JSON-RPC → `AcpProtocolError` with redacted `userMessage`, timeout → `AcpTimeoutError`, `fs/read_text_file` dispatch, deny-by-default for `fs/write_text_file`

**`add-acp-process-manager`** — validation at `dag.toml:649-653` satisfied:

- argv array + `assertSafeExecutable` metacharacter rejection; `shell: false` at `process-manager.ts:302`
- cwd caller-supplied or `${tmpdir()}/llm-gateway-acp-<provider>`; Round-5 `mkdirSync` before spawn with **real** `defaultSpawn` tests
- Grok `GROK_LEADER_SOCKET` isolation; idle kill; idle reset on `onActivity`; channel-loss quarantine; crash/exit `terminalError` + `onProcessExit`

---

### Applicable `[test_matrix]` rows

| Section | Applicable to Phase B? | Status |
|---|---|---|
| `json_rpc_transport` (6 rows) | Yes — transport step | All six have named tests |
| `schemas` (6 rows) | Yes — types step | Covered in `acp-types.test.ts` |
| `host_services` (5 rows) | **No** — owner is `src/acp/host-services.ts` (`dag.toml:224-225`), file does not exist; assigned to `define-host-services-boundary` / `implement-permission-bridge` downstream | Correctly deferred |
| `mock_acp_agent` (partial) | Client step owns dispatch tests | Core flows proven; full integration matrix completes in later phases |

---

### Security invariants (Phase B surface)

| Invariant | Holds? | Inspected evidence |
|---|---|---|
| No gateway stdout / `console.log` | Yes | No `process.stdout` in `src/acp/`; stdout spy tests in transport + client + process-manager suites |
| `no_prompt_payloads_in_default_logs` | Yes | Stderr → `logger.debug("acp.provider.stderr", { line: redactAcpMessage(line) })` at `json-rpc-stdio.ts:249`; test redacts path/token/JSON; invalid JSON logs `errorClass` + `bytes` only (`:271-275`) |
| `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder` | Yes (boundary) | JSON-RPC `error.message` **not** interpolated into `userMessage` (`json-rpc-stdio.ts:363-365`); tests assert `CONFIDENTIAL_TEXT` absent from `userMessage`; Phase B does not write to flight recorder |
| `no_shell_eval_for_entrypoints` | Yes | `shell: false` + argv array at `process-manager.ts:295-302`; metacharacter rejection at `:181-188` |
| Deny-by-default HostServices | Yes | `requireHandler` throws when handler missing (`client.ts:497-508`); `fs/write_text_file` with `{}` host → JSON-RPC `-32000` |
| `approval_manager_required_for_provider_permissions` | Deferred correctly | DAG places ApprovalManager wiring in `define-host-services-boundary` (`:689`) + `implement-permission-bridge` (`:701-715`); client is dispatch-only (`client.ts:35-39, 110-118`); no auto-approve; fails closed without `requestPermission` handler |
| Fail-closed liveness (Round-2/5) | Yes | stdout error → `handleStreamClose` (`:199`); `onClose`/`onActivity` wired in manager (`process-manager.ts:488-492`); tests for channel loss, idle reset, default-cwd ENOENT |

**Round-3 stderr prose rebuttal confirmed:** structured payloads (paths, tokens, JSON bodies) are redacted in stderr logs; surviving benign prose is on `logger.debug`, which is not default-log output per gateway logger semantics.

---

### Round-5 default-cwd fix — verified in code + real spawner

```280:307:src/acp/process-manager.ts
export const defaultSpawn: AcpSpawnFn = (resolved): AcpChildProcess => {
  // ...
  mkdirSync(resolved.cwd, { recursive: true });
  const child = nodeSpawn(resolved.command, [...resolved.args], {
    cwd: resolved.cwd,
    env: resolved.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
```

Real-spawner tests `creates a missing default working directory and spawns successfully` and `tolerates an already-existing working directory` exercise this path with `process.execPath`, not an injected fake.

---

### Non-blocking carry-overs (not approval blockers)

- `npm run format:check` fails on the eight new ACP files (not in this packet's required gates)
- `git diff --check` docs-only trailing blank line in `B-round-5-codex.md` (source `src/` clean)
- `npm test` is sensitive to `FORCE_COLOR` in the runner environment

---

**Phase B transport core at `5c90024` is approved for release from this review lens.** All in-scope DAG validation clauses, applicable test-matrix rows, security invariants, and required gates hold with inspected code and executed tests.

---

## Driver structured verdict

- **reviewer:** grok
- **verdict:** APPROVED
- **findings:** none (three non-blocking carry-overs noted by reviewer: format:check fails on new ACP files, docs-only trailing blank line in B-round-5-codex.md, npm test FORCE_COLOR sensitivity — all explicitly classified by the reviewer as non-approval-blockers and outside this packet's required gates)
- **inspected (reviewer-executed):**
  - `npm run build` (exit 0)
  - `npx vitest run` on the four `acp-*` suites (96/96)
  - `npm test` (1384/1384 with FORCE_COLOR unset)
  - `npm run upstream:contracts` (OK, 5 providers)
  - `git diff 7d06af1..5c90024 --name-only` scope check (CLI path unchanged)
  - `git diff --check` on `src/`
  - `grep` for `process.stdout` / `console.*` in `src/acp/`
  - `src/acp/json-rpc-stdio.ts`, `src/acp/process-manager.ts`, `src/acp/client.ts`, `src/acp/types.ts`
  - four ACP test files, `dag.toml` validation clauses + `[test_matrix]` + `[security_invariants]`, verification report
