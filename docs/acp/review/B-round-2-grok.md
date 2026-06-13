# Phase B — Transport core: Round 2 adversarial review (lens: grok)

- Reviewer: grok (via `mcp__gtwy__grok_request_async`)
- Job ID: `e4750465-1a6e-4c6a-ab78-ed5f16de5e36` (correlationId `40d7735c-8fd6-4dd4-bff7-93b83199e369`)
- Change set: commits `57c0611..3b89fd3` (diff range `57c0611..3b89fd3`)
- Phase head: `3b89fd3`
- Date: 2026-06-13
- Verdict: **APPROVED**

> Note on first attempt: an earlier job (`d7d94aa9-1be7-4ffc-b57c-f8d27a6644fa`) failed
> with HTTP 400 because the default Grok model `grok-composer-2.5-fast` rejects the
> `reasoningEffort` parameter (mapped from `effort: high`). Re-run without `effort`
> completed cleanly.

---

## Reviewer reply (verbatim)

Acting as an adversarial release reviewer: I'll read the verification report and changed files, then run the cited tests and build myself — not trusting the report alone.
Reading the DAG plan and changed source files, then running build, tests, and contract checks myself.
Reviewing test files and scanning for security violations and CLI transport regressions.
## Verdict: **APPROVED**

Independent adversarial review of `57c0611..3b89fd3` at HEAD `3b89fd3`. I read all eight implementation files, the DAG step blocks, `[security_invariants]`, and in-scope `[test_matrix]` rows, and ran the gates myself. The verification report was treated as a claim, not evidence.

---

### Gates executed (personally)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Lint | `npm run lint` | exit 0 (0 errors, 127 naming-convention warnings in `types.ts` + 1 `detect-object-injection` in `process-manager.ts`) |
| ACP suites | `npx vitest run` on 4 ACP test files | 4 files, **85 tests passed** |
| Full test | `unset FORCE_COLOR && npm test` | **1373/1373 passed** |
| Upstream contracts | `npm run upstream:contracts` | exit 0 — "contracts-check OK: 5 providers…" |
| Diff hygiene | `git diff --check 57c0611..3b89fd3` | exit 0 |
| CLI path unchanged | `git diff 57c0611..3b89fd3 --name-only` (excl. ACP) | **empty** — only additive ACP files + docs |

Note: `npm test` without unsetting `FORCE_COLOR` fails 2 tests in `cli-entrypoint.test.ts` due to Node `NO_COLOR`/`FORCE_COLOR` warnings on stderr — an environment artifact, unrelated to the Phase B diff. With `FORCE_COLOR` unset, the full suite passes.

---

### Round-1 blocker — verified fixed at `3b89fd3`

Round-1 finding (unredacted provider stderr) is closed:

```223:226:src/acp/json-rpc-stdio.ts
        this.logger.debug("acp.provider.stderr", {
          provider: this.provider,
          line: redactAcpMessage(line),
        });
```

Evidence:
- `redactAcpMessage` imported from `errors.ts` and applied on every stderr line
- `acp-json-rpc-stdio.test.ts` splits benign-line vs redaction tests (`:320-354`); credential path, `sk-` token, and JSON body are absent from log payload; `<redacted-path>` / `<redacted-json>` present
- Invalid-JSON path still logs only `errorClass` + `bytes` (`json-rpc-stdio.ts:245-248`), consistent with redaction discipline

---

### DAG validation clauses (Phase B steps)

| Step | Clause | Evidence |
|---|---|---|
| `build-json-rpc-stdio-transport` | fragmented/batched/notifications/errors/invalid JSON/timeout/exit/no stdout | 17 tests in `acp-json-rpc-stdio.test.ts`; stdout spy `:99-104`, asserted empty at `:377` |
| `define-acp-protocol-types` | Mistral/Grok smoke, missing fields, extras, unknown variants | `acp-types.test.ts` fixtures + unknown-variant test at `:240-252`; parse-failure redaction at `:375-391` |
| `implement-acp-client-core` | mock-agent init/session/prompt/cancel + redacted errors + host dispatch | 11 tests in `acp-client.test.ts`; real transport+client over `PassThrough`; redaction at `:298-317` |
| `add-acp-process-manager` | argv/cwd/env/idle-timeout/crash reporting | 17 tests in `acp-process-manager.test.ts`; `shell: false` at `process-manager.ts:283`; `assertSafeExecutable` at `:180-187` |

---

### `[test_matrix]` rows applicable to Phase B

| Row group | Rows | Covering tests |
|---|---|---|
| `json_rpc_transport` (6/6) | all | `acp-json-rpc-stdio.test.ts` (annotated `:22-28`) |
| `schemas` (6/6) | all | `acp-types.test.ts` (annotated `:33-39`) |
| `host_services` (partial) | denies filesystem writes by default | `acp-client.test.ts:394-418` — missing `writeTextFile` → JSON-RPC `-32000` |

Rows owned by later steps (`resolves read paths under workspace root`, `rejects path traversal`, `routes permission decisions through ApprovalManager`, `denies terminal by default` as a host-callback test) are **not** in any Phase B step `validation` clause; they belong to `define-host-services-boundary` / `implement-permission-bridge` per `dag.toml:679-715`. Phase B correctly scopes to transport + dispatch boundary.

---

### Security invariants (Phase B surface)

| Invariant | Status | Evidence |
|---|---|---|
| `stdout_reserved_for_mcp` / no `console.log` / no `process.stdout` writes | **PASS** | grep: no runtime `console.*`/`process.stdout` in the 4 implementation files (only doc comments); spy tests in transport/client/process-manager suites |
| `provider_stdout_is_protocol_only` | **PASS** | Provider stdout consumed only as JSON-RPC frames; never forwarded to gateway stdout |
| `provider_stderr_logged_through_gateway_logger` | **PASS** | Stderr routed through injected `Logger`, not gateway stdout |
| `no_prompt_payloads_in_default_logs` | **PASS** | Stderr redacted (`json-rpc-stdio.ts:225`); invalid JSON logs class+bytes only; parse failures omit payload values (`types.ts:521-529`); client logs method/errorClass only |
| `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder` | **PASS** (N/A wiring) | Phase B modules do not write to flight recorder; error boundary uses `redactAcpMessage`/`redactAcpDebug` at construction |
| `no_shell_eval_for_entrypoints` | **PASS** | `shell: false` (`process-manager.ts:283`); metachar rejection (`:180-187`); argv-array tests (`acp-process-manager.test.ts:184-208`) |
| `no_arbitrary_subcommand_execution` | **PASS** | Spawn params resolved only from config + registry (`resolveProviderSpawn`) |
| Deny-by-default HostServices | **PASS** | Missing handlers → JSON-RPC `-32000` (`client.ts:441-488`); initialize advertises read/write/terminal all-false (`client.ts:256-260`, tested `acp-client.test.ts:200-205`) |
| Error-boundary redaction | **PASS** | `AcpError` redacts `userMessage` at construction (`errors.ts:155`); test `acp-client.test.ts:298-317` |
| `approval_manager_required_for_provider_permissions` | **PASS** at delegation boundary | Client routes to `HostServices.requestPermission`; no auto-approve path in client (`client.ts:450-457`). Concrete ApprovalManager wiring deferred to `implement-permission-bridge` |
| `workspace_required_for_filesystem_host_services` | **Deferred** | Enforcement assigned to `host-services.ts` slice; client marshals only (`client.ts:97-100`) |
| `resources_redact_local_paths_and_auth_state` | **N/A** | No doctor/resources integration in Phase B |
| `adapter_support_requires_separate_threat_model` | **N/A** | No adapter surface in Phase B |

---

### CLI transport path

Phase range touches **only** the nine additive files (eight source + aggregated report). No existing CLI transport, handler, or executor modules modified — unchanged by construction.

---

### Non-blocking carry-over (not gating Phase B)

`npm run format:check` would fail on the 8 new ACP files (not in the Phase B required gate set per the DAG packet). A formatting commit is needed before the broader `npm run check` release gate.

---

### Summary

Phase B transport core at `3b89fd3` satisfies all in-scope DAG validation clauses, applicable `[test_matrix]` rows, and Phase B security invariants. The Round-1 stderr-redaction blocker is fixed and proven by code + test. **Approved for Phase B release.**

---

## Driver structured verdict

- reviewer: grok
- verdict: APPROVED
- findings:
  - (minor, non-blocking, out of required gate set) `docs/acp/verification/phase-B.md:163` —
    `npm run format:check` (`prettier --check 'src/**/*.ts'`) fails on the 8 new ACP files;
    breaks the composite `npm run check` release gate. A `prettier --write` formatting
    commit is required before the Phase B PR can pass `npm run check`. Carried over from
    Round 1; not in the Phase B required gate set.
- inspected (reviewer + driver):
  - docs/acp/verification/phase-B.md
  - src/acp/json-rpc-stdio.ts
  - src/acp/types.ts
  - src/acp/client.ts
  - src/acp/process-manager.ts
  - src/acp/errors.ts
  - src/__tests__/acp-json-rpc-stdio.test.ts
  - src/__tests__/acp-types.test.ts
  - src/__tests__/acp-client.test.ts
  - src/__tests__/acp-process-manager.test.ts
  - `npm run build` (exit 0)
  - `npx vitest run` on 4 ACP suites (4 files / 85 tests passed)
  - `npm test` (1373/1373 with FORCE_COLOR unset)
  - `npm run upstream:contracts` (exit 0)
  - `git diff --check 57c0611..3b89fd3` (exit 0)
  - `git diff 57c0611..3b89fd3 --name-only` excl. ACP (empty)
  - `grep -rnE 'process\.stdout|console\.' src/acp/` (only doc comments)
