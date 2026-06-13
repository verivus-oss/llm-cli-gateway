# Phase B — Transport core: adversarial release review (round 1, lens: grok)

- Reviewer: grok (`grok_request_async`, gateway)
- Job id: `520a7ac0-b192-419a-a224-7cd348598583` (correlationId `beb441a6-6058-42ae-9b83-4d0ec7985eb2`)
- Range: `57c0611..9a84770` (commits 3cf062f, be98e60, f261819, 9a84770)
- Verification report under review: `docs/acp/verification/phase-B.md`
- Date: 2026-06-13
- Verdict: **CHANGES_REQUIRED**

> Note (driver): an earlier dispatch (`47235f29-1d3a-4c4e-a348-5593cd812f8a`) failed at the
> provider transport — default model `grok-composer-2.5-fast` rejects the `reasoningEffort`
> parameter (HTTP 400). Re-dispatched without `effort`; the review below is from the
> successful run. Driver independently re-verified the blocking finding against the live
> code (see "Driver verification" at the end).

---

## Reviewer reply (verbatim)

Acting as adversarial release reviewer: I'll read the verification report and changed files, then run the cited tests and build myself — not trusting the report alone.
Reading the DAG plan and all changed source files, then running the build and test gates.
Checking security-sensitive logging paths and whether all in-scope test_matrix rows are covered.
Verifying whether provider stderr logging is the only security gap and checking for other sensitive data paths.
## Verdict: **CHANGES_REQUIRED**

Independent review of commit `9a84770` (range `57c0611..9a84770`). I read all eight changed files, the DAG step blocks and `[security_invariants]` / `[test_matrix.unit]` rows, and ran the gates myself. The verification report is not treated as evidence.

---

### Gates executed (personally)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` | exit 0 |
| Lint | `npm run lint` | exit 0 (0 errors, 127 naming-convention warnings in `types.ts`) |
| ACP suites | `npx vitest run` on 4 ACP test files | 4 files, **84 tests passed** |
| Upstream contracts | `npm run upstream:contracts` | exit 0 |
| Diff hygiene | `git diff --check 57c0611..9a84770` | exit 0 |
| CLI path unchanged | `git diff 57c0611..9a84770 --name-only` | **only** the 8 additive ACP files; no existing transport/handler modules touched |

`npm test` (full suite): 1370/1372 passed; 2 failures in `cli-entrypoint.test.ts` from `FORCE_COLOR`/`NO_COLOR` Node warnings on stderr — environment artifact, unrelated to Phase B diff.

---

### Finding 1 (security — blocking)

**`src/acp/json-rpc-stdio.ts:211` — provider stderr logged verbatim, violating `no_prompt_payloads_in_default_logs`**

**What is wrong:** `onStderrData` forwards each provider stderr line to the gateway logger as a raw `line` field with no redaction:

```211:211:src/acp/json-rpc-stdio.ts
        this.logger.debug("acp.provider.stderr", { provider: this.provider, line });
```

**Evidence inspected:**
- DAG `[security_invariants]`: `no_prompt_payloads_in_default_logs = true`
- DAG `[observability].redaction`: *"Do not log prompt text, file contents, tokens, credential paths, or full JSON-RPC payloads by default."*
- The module header (lines 22–24) says logging is restricted to method names, ids, and error classes — stderr logging contradicts that.
- `redactAcpMessage` exists in `src/acp/errors.ts` but is **not** applied here (grep: zero `redact` refs in `json-rpc-stdio.ts`).
- Provider CLIs commonly emit credential paths, file paths, and debug payload snippets on stderr; those would reach gateway log sinks (and any downstream flight-recorder/doctor wiring) unredacted.
- The test **codifies** the leak: `src/__tests__/acp-json-rpc-stdio.test.ts:325-328` asserts the raw string `"provider warning line"` appears in the log payload.

**Required fix:** Run stderr lines through `redactAcpMessage` (or log only `line.length` + error class, matching the invalid-JSON path at `:230-234`). Update the test to prove paths/tokens are redacted, not preserved.

---

### What passes (verified, not from report)

**DAG validation clauses (Phase B steps)**

| Step | Clause | Evidence |
|---|---|---|
| `build-json-rpc-stdio-transport` | fragmented/batched/notifications/errors/invalid JSON/timeout/exit/no stdout | 16 tests in `acp-json-rpc-stdio.test.ts`; stdout spy at `:99-104`, asserted empty at `:352` |
| `define-acp-protocol-types` | Mistral/Grok smoke, missing fields, extras, unknown variants | `acp-types.test.ts` fixtures `MISTRAL_INITIALIZE_RESPONSE` / `GROK_INITIALIZE_RESPONSE`; unknown variant test at `:240-252` |
| `implement-acp-client-core` | mock-agent init/session/prompt + redacted errors | 11 tests in `acp-client.test.ts`; real transport+client over `PassThrough`; redaction test at `:298-317` |
| `add-acp-process-manager` | argv/cwd/env/idle-timeout/crash reporting | 17 tests in `acp-process-manager.test.ts`; `shell:false` at `process-manager.ts:283`; `assertSafeExecutable` at `:180-187` |

**`[test_matrix.unit]` rows in scope for Phase B**

| Row group | Rows | Covering tests |
|---|---|---|
| `json_rpc_transport` (6) | all 6 | `acp-json-rpc-stdio.test.ts` (annotated at `:22-28`) |
| `schemas` (6) | all 6 | `acp-types.test.ts` (annotated at `:33-39`) |

`[test_matrix.integration].mock_acp_agent` crash rows are **not** in any Phase B step `validation` clause; `implement-acp-client-core` correctly scopes 4 client-owned rows. Process-manager covers crash-after-init (`acp-process-manager.test.ts:363-406`), not claimed as `mock_acp_agent` rows.

**Other security invariants (Phase B surface)**

| Invariant | Status |
|---|---|
| `stdout_reserved_for_mcp` / no `console.log` / no `process.stdout` writes | PASS — grep: no runtime `console.*`/`process.stdout` in the 4 implementation files; spy tests in transport/client/process-manager suites |
| `no_shell_eval_for_entrypoints` | PASS — `shell: false` at `process-manager.ts:283`; metachar rejection at `:180-187`; tests at `acp-process-manager.test.ts:184-208` |
| Deny-by-default HostServices | PASS — missing `writeTextFile` → JSON-RPC `-32000` at `client.ts:441-488`; test at `acp-client.test.ts:394-418` |
| Error-boundary redaction (JSON-RPC → `AcpProtocolError`) | PASS — `errors.ts:155` redacts `userMessage`; test at `acp-client.test.ts:298-317` |
| `approval_manager_required_for_provider_permissions` | PASS at delegation boundary — client routes to `HostServices.requestPermission` (`client.ts:450-457`); no auto-approve path; concrete ApprovalManager wiring is a later slice |

**Non-blocking (report-aligned):** `npm run format:check` would fail on the 8 new files (not in Phase B required gate set per report).

---

### Summary

Phase B transport logic, test coverage for in-scope DAG clauses, and CLI-path isolation are solid. **Approval is blocked** by one in-scope security defect: unredacted provider stderr logging at `json-rpc-stdio.ts:211`, with a test that asserts the unsafe behavior. Fix redaction there (and the corresponding test) before release.

---

## Driver verification (independent re-check of the blocking finding)

- `src/acp/json-rpc-stdio.ts:211` confirmed: `this.logger.debug("acp.provider.stderr", { provider: this.provider, line });` — raw `line` logged, no redaction.
- Contrast at `:228-234`: the invalid-JSON path deliberately logs only `errorClass` + `bytes` with the comment *"never log the raw line (it may carry prompt or payload text)"* — proving the stderr path is inconsistent with the module's own stated redaction discipline.
- `grep -c redact src/acp/json-rpc-stdio.ts` → `0`; `redactAcpMessage` is defined at `src/acp/errors.ts:42` and applied across the error boundary (`errors.ts:155`, `:88`, `:124`) but never imported into the transport.
- Test `src/__tests__/acp-json-rpc-stdio.test.ts:325-328` asserts the raw string `"provider warning line"` is present in the log payload — codifying the leak rather than guarding against it.

Finding 1 is a real, in-scope defect. Verdict upheld: **CHANGES_REQUIRED**.

---

## Structured verdict

- reviewer: grok
- verdict: CHANGES_REQUIRED
- findings:
  - `src/acp/json-rpc-stdio.ts:211` — provider stderr logged verbatim (raw `line`) with no redaction; violates DAG `[security_invariants].no_prompt_payloads_in_default_logs` and `[observability].redaction`; test at `acp-json-rpc-stdio.test.ts:325-328` codifies the leak. Severity: blocker.
- inspected:
  - `docs/acp/verification/phase-B.md`
  - `docs/plans/first-class-acp-gateway-extension.dag.toml`
  - `src/acp/json-rpc-stdio.ts`
  - `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/process-manager.ts`, `src/acp/errors.ts`
  - `src/__tests__/acp-json-rpc-stdio.test.ts` (+ the 3 other ACP suites)
  - `git diff 57c0611..9a84770 --name-only`
  - `npm run build`, `npx vitest run` (4 ACP suites), `npm test`, `npm run upstream:contracts`, `git diff --check`
  - driver re-check: `grep -c redact src/acp/json-rpc-stdio.ts`, `src/acp/errors.ts:42`
