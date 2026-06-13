# Phase B — Round 4 review (grok)

- Reviewer: grok (adversarial release reviewer)
- Lens: grok
- Phase: B — Transport core
- Diff range: `57c0611..6621a6be802f454435f50f32de20e21d85f1b2fe`
- Job: `0c4d0e99-a484-44a9-8a2b-8110152bfb74` (correlationId `31a22ca0-db63-4bb1-8f18-d2334f68ef85`), completed exit 0
- Date: 2026-06-13

## Driver structured verdict

- **Verdict: APPROVED**
- Findings: none blocking. One non-blocking carry-over noted by the reviewer: `npm run format:check` would fail (prettier) on the 8 new `src/acp/**` files; not part of the Phase B required gate set, but needs a formatting commit before `npm run check` at release.
- Inspected / executed by the reviewer:
  - `npm run build` (exit 0)
  - `npx vitest run` on the 4 ACP suites — 94/94 (transport 22, types 41, client 11, process-manager 20)
  - `env -u FORCE_COLOR npm test` — 1382/1382, 85 files
  - `npm run upstream:contracts` — OK, 5 providers, offline
  - `git diff --check 57c0611..6621a6b` — clean
  - `git diff 57c0611..34f3ea7 --name-only -- 'src/**' ':!src/acp/**' ':!src/__tests__/acp-*'` — empty (no existing transport modules touched)
  - DAG clauses for all four Phase B steps verified against `dag.toml` and the named tests
  - `[test_matrix]` rows in Phase B scope verified; deferred rows confirmed owned by later steps
  - Security invariants verified at file:line (json-rpc-stdio.ts redaction, process-manager.ts shell:false + assertSafeExecutable, client.ts deny-by-default)
  - `grep` for `process.stdout` / `console.` in `src/acp/*.ts` — only doc-comment mentions

---

## Reviewer verbatim reply

Acting as adversarial release reviewer: I'll read the verification report and inspect the actual code and tests—not trusting claims without evidence.
Reading source files, DAG requirements, and running the verification gates.
## Verdict: **APPROVED**

Independent adversarial review of `57c0611..6621a6be802f454435f50f32de20e21d85f1b2fe` (source head `34f3ea7`; tip docs-only delta confirmed). The verification report was treated as a claim, not evidence. Findings below are backed by direct inspection and executed gates.

---

### Gates (re-run personally)

| Gate | Command | Observed |
|---|---|---|
| Build | `npm run build` | exit 0 |
| ACP suites | `npx vitest run` on 4 ACP files | **94/94** (transport 22, types 41, client 11, process-manager 20) |
| Full suite | `env -u FORCE_COLOR npm test` | **1382/1382**, 85 files |
| Upstream contracts | `npm run upstream:contracts` | OK — 5 providers, offline |
| Diff hygiene | `git diff --check 57c0611..6621a6b` | clean |
| CLI path isolation | `git diff 57c0611..34f3ea7 --name-only -- 'src/**' ':!src/acp/**' ':!src/__tests__/acp-*'` | **empty** — no existing transport modules touched |

---

### DAG validation clauses — verified

**`build-json-rpc-stdio-transport`** (`dag.toml:575-579`): All eight behaviours have named, behaviour-asserting tests in `acp-json-rpc-stdio.test.ts` — fragmented frames (`:152`), batched out-of-order correlation (`:183`), notifications (`:200`), JSON-RPC errors (`:235`, `:252`), invalid JSON (`:276`), timeout (`:297`), process exit (`:335`, `:351`), no gateway stdout (`:468` + `stdoutWrites` spy). Round-2/3 fixes proven: stdout `error` terminates (`:368`), `onClose`/`onActivity` (`:388`, `:412`), provider error prose excluded from `userMessage` (`:252`).

**`define-acp-protocol-types`** (`dag.toml:581-606`): Mistral/Grok smoke fixtures, missing-field rejection, passthrough extras, unknown `session/update` preservation, and Round-3 strict known-content-block rejection (`acp-types.test.ts:192`) all present and non-trivial.

**`implement-acp-client-core`** (`dag.toml:608-630`): Real transport + real `AcpClient` over `PassThrough` streams; initialize/idempotency/fail-closed, session/new, prompt + `session/update`, cancel, redacted JSON-RPC errors, timeout, `fs/read_text_file` dispatch, write deny-by-default (`acp-client.test.ts:398`).

**`add-acp-process-manager`** (`dag.toml:632-653`): argv-without-shell (`:184`), metacharacter rejection (`:203`), cwd control (`:215`), Grok socket isolation (`:225`), idle kill (`:332`), idle reset on activity (`:361`), channel-loss quarantine (`:409`, `:449`), crash reporting (`:474`).

---

### Applicable `[test_matrix]` rows — satisfied

| Section | Rows in Phase B scope | Evidence |
|---|---|---|
| `unit.json_rpc_transport` | all 6 | Named tests map 1:1 in `acp-json-rpc-stdio.test.ts` |
| `unit.schemas` | all 6 | `acp-types.test.ts` initialize/session-new/load/prompt/update/permission blocks |
| `unit.host_services` | write deny-by-default only | `acp-client.test.ts:398` via shared `requireHandler` (`client.ts:497-508`) |
| `unit.host_services` | workspace traversal, ApprovalManager routing | **Correctly deferred** — owned by `define-host-services-boundary` / `implement-permission-bridge` (`dag.toml:679-715`) |
| `integration.mock_acp_agent` | client-owned 4 rows | initialize+new, prompt+updates, cancel, deny paths (`implement-acp-client-core.md:72-75`) |
| `integration.mock_acp_agent` | crash rows | process-manager tests (`:310`, `:474`, `:504`) |

Tests are non-vacuous: each asserts observable behaviour (reject types, state transitions, spy emptiness, redaction placeholders), not mere existence.

---

### Security invariants — verified

| Invariant | Status | Evidence |
|---|---|---|
| No gateway stdout / `console.log` from ACP code | **Holds** | `grep -nE 'process\.stdout\|console\.' src/acp/*.ts` — only doc-comment mentions; `acp-json-rpc-stdio.test.ts:468` asserts `stdoutWrites === []` |
| `no_prompt_payloads_in_default_logs` | **Holds** | Stderr redacted at `json-rpc-stdio.ts:249-252` via `redactAcpMessage`; test `:444` strips paths/tokens/JSON; invalid JSON logs `errorClass`+`bytes` only (`:271-275`); gateway `logger.debug` gated by `process.env.DEBUG` (`index.ts:216-219`) — not default logs |
| `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder` (user-facing boundary) | **Holds** | Provider `error.message` excluded from `userMessage` at `json-rpc-stdio.ts:363-365`; tests `:252`, `acp-client.test.ts:298` |
| `no_shell_eval_for_entrypoints` | **Holds** | `shell: false` hardcoded `process-manager.ts:283`; `assertSafeExecutable` at `:180-188`; metachar test `acp-process-manager.test.ts:203` |
| Deny-by-default HostServices | **Holds** | Missing handlers throw → JSON-RPC `-32000` (`client.ts:441-448`, `:472-489`); write test proves pattern |
| ApprovalManager-mediated permissions | **N/A at Phase B** | Client delegates to optional `HostServices.requestPermission` (`client.ts:35-39`, `:110-118`); no auto-approve path; wiring scheduled in `implement-permission-bridge` |
| CLI transport path unchanged | **Holds** | Phase source diff confined to 8 additive `src/acp/**` + test files |

**Round-3 Codex finding 1 (stderr prose) — rebuttal confirmed:** structured payloads (JSON, paths, tokens) are stripped; free-form diagnostic prose in `logger.debug` is DEBUG-gated and is not a gateway-emitted prompt payload in default logs.

**Round-3 finding 2 (provider error in `userMessage`) — fix confirmed at `34f3ea7`.**

**Round-3 finding 3 (content-block fallback) — fix confirmed at `34f3ea7`** (`types.ts:72-130`, test `acp-types.test.ts:192`).

---

### Non-blocking carry-over (not required for Phase B approval)

- `npm run format:check` would fail on the 8 new ACP files (prettier). Not in the Phase B required gate set; needs a formatting commit before `npm run check` at release.

---

### Summary

Phase B transport core at `6621a6b` (source `34f3ea7`) satisfies all in-scope DAG validation clauses, applicable `[test_matrix]` rows, and Phase B security invariants. Round-1 stderr redaction, Round-2 transport liveness, and Round-3 error-boundary/schema fixes are present in code and proven by tests. All required gates pass under independent re-execution.
