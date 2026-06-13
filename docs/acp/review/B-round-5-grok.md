# Phase B — Round 5 review (lens: grok)

- Reviewer: grok (adversarial release reviewer, lens: grok)
- Dispatch: `mcp__gtwy__grok_request_async`, job `8361a459-12a0-41eb-9243-a29aa8b79603`, correlationId `b8bf8c00-5fce-4eec-b1e0-6785d5f18f4a`
- Settings: `alwaysApprove=true`, `permissionMode=bypassPermissions`, broad allowedTools, `mcpServers=[sqry, ref_tools]`, `idleTimeoutMs=1800000`. Repo absolute path embedded in prompt so the read-only shell runs `git -C <abs>` and absolute-path reads against `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway` (gateway spawns the CLI under its default workspace).
- Dispatch note: a first attempt (job `b81c1785-732e-4c5f-9b07-7bce358f01c5`) with `effort=high` failed at the provider API (`grok-composer-2.5-fast does not support parameter reasoningEffort`, HTTP 400). Re-dispatched without `effort`; the second job completed exit 0.
- Outcome: **APPROVED**

## Reviewer reply (verbatim)

I'll review Phase B as an adversarial gate: read the verification report and cited files, then run build, tests, and contract checks myself.
Running gates and reading the implementation files to verify claims independently.
## Verdict: **APPROVED**

Independent adversarial re-review of Phase B at `3e791ae` (source surface `34f3ea7`; `34f3ea7..3e791ae` is `docs/acp/**` only). The verification report was treated as claims, not evidence.

---

### Gates (executed locally)

| Gate | Result | Evidence |
|---|---|---|
| `npm run build` | PASS | exit 0 |
| Four ACP suites | PASS | 4 files, **94/94** (transport 22, types 41, client 11, process-manager 20) |
| `npm test` | PASS | **1382/1382**, 85 files (`env -u FORCE_COLOR`) |
| `npm run upstream:contracts` | PASS | 5 providers, offline OK |
| `git diff --check 7d06af1..3e791ae` + worktree | PASS | clean |

---

### CLI transport path unchanged

`git diff --name-only 7d06af1..3e791ae -- 'src/' ':!src/acp/' ':!src/__tests__/acp-*'` returned empty. Phase B is additive under `src/acp/` and `src/__tests__/acp-*` only.

---

### DAG validation + applicable `[test_matrix]` rows

**`build-json-rpc-stdio-transport`** (`dag.toml:575-579`, `[test_matrix.unit.json_rpc_transport]`): All six matrix rows are covered by non-vacuous transport tests — fragmented frames (`acp-json-rpc-stdio.test.ts:152`), correlation (`:136`), notifications (`:200`), JSON-RPC errors (`:235`, `:252`), timeout (`:297`), reject-after-exit (`:351`). Invalid JSON asserts no raw line in logs (`:276-294`). Stdout spy asserts zero gateway stdout writes (`:468-489`).

**`define-acp-protocol-types`** (`dag.toml:581-606`, `[test_matrix.unit.schemas]`): Mistral/Grok fixtures, missing fields, passthrough extras, unknown notification variants, and Round-3 strict-known-type fix (`types.ts:118-128`, test `:192-208`) all verified in `acp-types.test.ts`.

**`implement-acp-client-core`** (`dag.toml:608-630`): Real transport + `AcpClient` over `PassThrough` streams. Initialize idempotency, fail-closed before init, session/new, prompt + `session/update`, cancel, redacted JSON-RPC errors (`acp-client.test.ts:298-322`), timeout, `fs/read_text_file` dispatch, deny-by-default write (`:398-423`).

**`add-acp-process-manager`** (`dag.toml:632-649`): argv without shell parsing (`acp-process-manager.test.ts:184-195`), cwd control (`:215-221`), Grok socket isolation (`:225-233`), idle kill + activity reset (`:332-406`), channel-loss quarantine (`:408-471`), crash reporting (`:473-538`). Spawn uses `shell: false` at `process-manager.ts:283`.

**`[test_matrix.unit.host_services]`** rows (workspace resolution, path traversal, ApprovalManager routing): owner is `src/acp/host-services.ts` per `dag.toml:224-225`; file does not exist; steps `define-host-services-boundary` / `implement-permission-bridge` are downstream. Not applicable to Phase B.

---

### Security invariants (applicable to Phase B surface)

| Invariant | Status | Evidence |
|---|---|---|
| No gateway stdout / `console.log` | HOLD | Zero executable `console.*` / `process.stdout` in `src/acp/*.ts` (comments only); spy test at `acp-json-rpc-stdio.test.ts:468-489` |
| `provider_stdout_is_protocol_only` | HOLD | stdout consumed as NDJSON frames only (`json-rpc-stdio.ts:188-228`) |
| `provider_stderr_logged_through_gateway_logger` | HOLD | `logger.debug("acp.provider.stderr", …)` at `json-rpc-stdio.ts:249` |
| `no_prompt_payloads_in_default_logs` | HOLD | stderr redacted via `redactAcpMessage` (`:251`); test `:444-466`; gateway `debug` gated on `DEBUG=1` (`index.ts:216-219`) |
| `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder` | HOLD | Provider `error.message` excluded from `userMessage` (`json-rpc-stdio.ts:363-375`); test `:252-273`; no flight-recorder inserts in Phase B |
| `no_shell_eval_for_entrypoints` | HOLD | `assertSafeExecutable` + `shell: false` (`process-manager.ts:180-187`, `:283`) |
| Deny-by-default HostServices | HOLD | Missing handlers → `requireHandler` throws → JSON-RPC `-32000` (`client.ts:497-508`, test `:398-423`) |
| `approval_manager_required_for_provider_permissions` | HOLD (deferred to host slice) | Client dispatches only (`client.ts:450-457`); no handler → fail-closed; ApprovalManager wiring assigned to `implement-permission-bridge` (`dag.toml:701-715`). Mock approve test (`acp-client.test.ts:454`) is a dispatch contract test, not production policy. |

---

### Round-3 / Round-4 dispositions (independently confirmed)

- **Provider error message leak**: Fixed at `34f3ea7` — `userMessage` carries method + code only; prose absent from client-facing surface.
- **Content-block tolerant fallback**: Fixed — known types without required fields rejected (`types.ts:124-128`).
- **Stderr prose under DEBUG**: `acp.provider.stderr` is `logger.debug`; default logs exclude it. Structured JSON/paths/tokens redacted (`errors.ts:47-67`, test `:444-466`).
- **Round-4 permission-mediation**: Rebuttal holds — invariant + matrix row belong to `host-services.ts`, not `client.ts`. Client-level deny would violate DAG layering for the permission bridge step.

---

### Non-blocking carry-over (not a Phase B gate)

`npm run format:check` fails on the eight new ACP files (noted in `phase-B.md:317-322`). Required gates above all pass; formatting commit needed before `npm run check` at release.

---

**Phase B transport core is approved for merge from this lens.**

## Driver structured verdict

- verdict: **APPROVED**
- findings: one non-blocking carry-over (minor) — `npm run format:check` fails on the eight new ACP files; required gates unaffected; formatting commit needed before `npm run check` at release.
- inspected (reviewer executed/opened): `npm run build`, `npm test` (1382/1382), four ACP suites (94/94), `npm run upstream:contracts`, `git diff --check 7d06af1..3e791ae`, `git diff --name-only 7d06af1..3e791ae -- 'src/' ':!src/acp/' ':!src/__tests__/acp-*'` (empty), `src/acp/json-rpc-stdio.ts`, `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/process-manager.ts`, `src/acp/errors.ts`, `src/__tests__/acp-json-rpc-stdio.test.ts`, `src/__tests__/acp-types.test.ts`, `src/__tests__/acp-client.test.ts`, `src/__tests__/acp-process-manager.test.ts`, `dag.toml` (cited line ranges), `docs/acp/verification/phase-B.md`.
