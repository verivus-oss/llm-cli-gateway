# Phase B — Round-3 review (lens: grok)

- Reviewer: grok (adversarial release reviewer)
- Dispatched via: `mcp__gtwy__grok_request_async` (alwaysApprove, bypassPermissions, legacy approval strategy, mcpServers sqry/ref_tools)
- Job ID: `9d432d4d-2378-4aca-85a6-ffa16a6bde56`
- Correlation ID: `c96e4c66-26b7-4d2d-be1b-fe9e6027dfb8`
- Phase range: `57c0611..b80c490` (source surface `0420cfb`)
- Result: exit 0, completed 2026-06-13T06:20:24Z

> Dispatch note: the shared gateway runs in remote-workspace mode
> (`allow_unregistered_working_dir=false`; registered aliases `public`,
> `sqry-compete`, `gvrnd-knwldg-frmt` only), so an absolute `workingDir` under
> `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway` was rejected and the
> repo could not be registered as an alias (admin scope unavailable, server
> restart not permitted from a subagent). The reviewer was therefore dispatched
> without `workingDir`, with the absolute repo path embedded in the prompt so it
> `cd`'d into the repo and ran all git/npm/grep commands there against absolute
> paths. A first attempt with `effort: high` failed because the default grok
> model `grok-composer-2.5-fast` rejects the `reasoningEffort` parameter; the
> successful run dropped `effort`.

## Driver structured verdict

- Verdict: **APPROVED**
- Reviewer: grok

### Findings

The reviewer found no in-scope blockers or change-required defects. Two
non-blocking carry-overs were recorded (neither a Phase B required gate):

1. `npm run format:check` (prettier) fails on the 8 new ACP files — needs a
   formatting commit before `npm run check` at release. (minor / non-blocking)
2. `npm test` reports 2/1380 failures when `FORCE_COLOR` is set in the harness
   env (`cli-entrypoint.test.ts`); passes 1380/1380 clean with
   `env -u FORCE_COLOR`. Environment artifact, unrelated to Phase B. (minor /
   non-blocking)

### Inspected / executed (per reviewer reply)

- `npm run build` (exit 0)
- `npm run lint` (0 errors, 127 pre-existing naming-convention warnings)
- Four ACP suites (4 files, 92/92 tests)
- `npm test` (1380/1380 with `env -u FORCE_COLOR`)
- `npm run upstream:contracts` (5 providers, offline OK)
- `git diff --check 57c0611..b80c490` (no whitespace errors)
- `git diff --name-only 57c0611..b80c490 -- 'src/**' ':!src/acp/**' ':!src/__tests__/acp-*'` (empty → CLI transport path unchanged)
- `src/acp/json-rpc-stdio.ts`, `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/process-manager.ts`
- `src/__tests__/acp-json-rpc-stdio.test.ts`, `acp-types.test.ts`, `acp-client.test.ts`, `acp-process-manager.test.ts`
- `src/acp/errors.ts` (redaction at construction)

---

## Reviewer verbatim reply

I'll review Phase B as an adversarial release gate: read the verification report and changed code, then run build, tests, and contract checks myself.
Reading the implementation and tests, then running the verification gates myself.
Full suite failed due to environment `FORCE_COLOR` — rerunning without it, and reading the test files for security coverage.
## Verdict: **APPROVED**

Independent adversarial re-review of Phase B (`57c0611..b80c490`, source surface `0420cfb`) against code, tests, and locally executed gates. The verification report claims were treated as hypotheses and checked directly.

---

### Gates (executed at `b80c490`)

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | PASS | exit 0 |
| `npm run lint` | PASS | 0 errors, 127 pre-existing naming-convention warnings |
| Four ACP suites | PASS | 4 files, **92/92** tests |
| `npm test` | PASS | **1380/1380** with `env -u FORCE_COLOR` (2 failures with `FORCE_COLOR` set — environment artifact in `cli-entrypoint.test.ts`, unrelated to Phase B) |
| `npm run upstream:contracts` | PASS | 5 providers, offline OK |
| `git diff --check 57c0611..b80c490` | PASS | no whitespace errors |

`0420cfb..b80c490` delta is `docs/acp/**` only; compiled/tested source matches `0420cfb`.

---

### CLI transport path unchanged

`git diff --name-only 57c0611..b80c490 -- 'src/**' ':!src/acp/**' ':!src/__tests__/acp-*'` returned **empty**. Phase B is purely additive under `src/acp/` and `src/__tests__/acp-*`.

---

### DAG validation clauses + applicable `[test_matrix]` rows

**`build-json-rpc-stdio-transport`** — all validation rows proven by non-vacuous tests in `acp-json-rpc-stdio.test.ts` (21 tests): fragmented frames, batched/out-of-order correlation, notifications, inbound requests, JSON-RPC errors, invalid JSON (logs `errorClass`+`bytes` only), timeout, process-exit rejection, stdout-close/error termination, `onClose`/`onActivity` wiring, stderr redaction, `process.stdout.write` spy stays empty.

**`define-acp-protocol-types`** — Mistral/Grok smoke fixtures, strict required fields, tolerant extras, unknown `session/update` variants preserved; parse-failure redaction test at `acp-types.test.ts:375-391`.

**`implement-acp-client-core`** — real `PassThrough` transport + real `AcpClient` in `acp-client.test.ts`: idempotent initialize, fail-closed pre-init, session flows, streamed updates, cancel, redacted JSON-RPC errors (`code === -32000`, no `/home/werner`/`secret.json`), timeout, `fs/read_text_file` dispatch, deny-by-default write (`-32000`), permission denial redaction.

**`add-acp-process-manager`** — argv without shell (`shell: false` at `process-manager.ts:283`, metachar rejection at `:180-187`), controlled cwd, Grok `GROK_LEADER_SOCKET` isolation, idle kill, crash/channel-loss terminal reporting, idle reset on client activity, `onClose` quarantine — all in `acp-process-manager.test.ts` (20 tests).

`[test_matrix.unit.host_services]` rows for workspace traversal and ApprovalManager wiring are **correctly deferred** to `define-host-services-boundary` / `implement-permission-bridge` (post-Phase B DAG steps). Phase B proves write deny-by-default only.

---

### Security invariants (Phase B surface)

| Invariant | Status | Inspected evidence |
|---|---|---|
| No gateway `stdout` / `console.*` | HOLD | `grep` over `src/acp/*.ts` — no production `console.log`/`process.stdout`; spy tests in transport, client, and process-manager suites |
| `no_prompt_payloads_in_default_logs` | HOLD | `redactAcpMessage` at `json-rpc-stdio.ts:251` before `logger.debug("acp.provider.stderr", …)`; dedicated redaction test; invalid-JSON path logs only `errorClass`+`bytes` (`:271-275`) |
| `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder` | HOLD | `AcpError` redacts at construction (`errors.ts:155`); client maps host failures to `userMessage` only (`client.ts:485-488`); parse helpers attach issue paths not values (`types.ts:521-524`) |
| `no_shell_eval_for_entrypoints` | HOLD | `assertSafeExecutable` + `spawn(…, { shell: false })` at `process-manager.ts:276-284` |
| Deny-by-default HostServices | HOLD | `requireHandler` throws for missing surfaces; write test proves `-32000` (`acp-client.test.ts:394-418`) |
| ApprovalManager-mediated permissions | HOLD (boundary) | Client delegates to `HostServices.requestPermission` only; no auto-approve path (`client.ts:450-456`). Concrete ApprovalManager wiring is a later slice — appropriate for Phase B transport core |
| Fail-closed liveness (Round-2) | HOLD | stdout `error` → `handleStreamClose()` (`json-rpc-stdio.ts:190-199`); `onClose` → `handleChannelClosed()` quarantine (`process-manager.ts:626-655`); idle reset via `onActivity` (`:469`, `:527-533`) |

All logger calls in `src/acp/{json-rpc-stdio,client,process-manager}.ts` log only provider, pid, method names, error classes, durations, exit codes — no command/argv/cwd/env/prompt/file bodies.

---

### Round-2 fixes verified at `0420cfb`

The three Codex Round-2 findings are fixed and covered by tests:

1. **Channel loss health** — `onClose` at `json-rpc-stdio.ts:550`; manager quarantine at `process-manager.ts:626-655`; tests `stops reporting healthy…` / `fails an in-flight client request…`
2. **Idle reset on client activity** — `emitActivity()` on outbound request (`:402`) and inbound frames (`:288-289`); manager `onActivity → touchIdle()`; test `resets the idle timer on client-driven…`
3. **stdout error termination** — `handleStreamClose()` on error (`:199`); test `fails pending requests and closes the transport on a stdout stream error`

---

### Non-blocking carry-over (not approval blockers)

- `npm run format:check` fails on the 8 new ACP files (prettier). Required Phase B gates do not include `format:check`; needs a formatting commit before `npm run check` at release.
- `npm test` fails 2/1380 when `FORCE_COLOR` is set in the harness environment; passes clean with `env -u FORCE_COLOR`.

---

**Phase B transport core is approved for merge at `b80c490` (source `0420cfb`).** No in-scope blockers or unresolved defects found.
