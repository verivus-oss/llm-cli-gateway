# Phase B — Transport core: Review round 6 (codex)

- Reviewer: codex (gpt-5.5, `mcp__gtwy__codex_request_async`, sandbox `read-only`)
- Lens: adversarial release reviewer
- Job id: `93a2990b-2fa6-44d1-875f-871bc3b56fc2`
- Correlation id: `849921c1-043b-4b28-a4c4-facf093a1d9f`
- Exit code: 0 (status: completed)
- Started: 2026-06-13T07:12:36.836Z · Finished: 2026-06-13T07:15:59.916Z
- Diff range under review: `7d06af1..5c90024`
- Verification report under review: `docs/acp/verification/phase-B.md`
- Access granted: read-only sandbox + MCP (sqry, ref_tools). No write/commit/release (codex read-only by policy).
- Dispatch technique: embedded-absolute-path (no `workingDir`; repo path carried in the prompt so the reviewer's read-only shell runs `git -C <abs>` / absolute-path reads directly — the remote-workspace gateway rejects absolute `workingDir`).

## Driver structured verdict

- verdict: CHANGES_REQUIRED
- findings:
  1. [major] `src/acp/json-rpc-stdio.ts:249` — provider stderr reaches `logger.debug("acp.provider.stderr", …)` as raw prose after only pattern redaction (`redactAcpMessage` at `src/acp/errors.ts:42` scrubs JSON bodies/paths/tokens/email-like strings, not arbitrary prompt/file prose); the benign-line test at `src/__tests__/acp-json-rpc-stdio.test.ts:432` preserves a benign line unchanged. **Disposition: re-raise of Round-3 finding #1; disputed scope, not a confirmed new code defect.** Independently verified: `acp.provider.stderr` is a `logger.debug` call (gated out of default logs; emitted only under `DEBUG=1`) and structured JSON-RPC payloads ARE collapsed to `<redacted-json>` by `redactAcpMessage`. The `no_prompt_payloads_in_default_logs` invariant targets gateway-emitted prompt payloads in default logs, not the provider's own free-form diagnostic stderr at debug level. Rebutted with inspected evidence in Round-3 (`docs/acp/review/B-round-3-codex.md`, phase-B report row 1).
  2. [major] `src/acp/client.ts:450-456` — `session/request_permission` is forwarded to the injected `hostServices.requestPermission` and its result returned verbatim, with no ApprovalManager mediation in this code path, contradicting `approval_manager_required_for_provider_permissions = true` (`dag.toml:274`). **Disposition: re-raise of Round-1 row 2 / Round-4 / Round-5; disputed scope, DAG-grounded rebuttal holds.** Independently verified against the DAG: the matrix row "routes permission decisions through ApprovalManager" (`dag.toml:346`) is item 5 of the `host_services = [` array (`dag.toml:341`), owned by `src/acp/host-services.ts` (`dag.toml:225`), which does not yet exist; the deny-by-default posture is step `define-host-services-boundary` (`dag.toml:680`, `:689`) and the ApprovalManager wiring is step `implement-permission-bridge` (`dag.toml:702-715`), both downstream of all four Phase B steps (last is `implement-acp-client-core`, `dag.toml:609-630`, action = dispatch not decision). The client has no auto-approve path: `requireHandler` (`client.ts:497-508`) throws → JSON-RPC error when no host handler is supplied, i.e. fail-closed.
  3. [major] `src/__tests__/acp-client.test.ts:30` (test-file header) / `dag.toml:346` — no real non-vacuous test satisfies the host-services "routes permission decisions through ApprovalManager" matrix row; the inspected tests only cover approval/denial from an injected mock handler, and `src/acp/host-services.ts` does not exist. **Disposition: corollary of finding 2 — same out-of-Phase-B scope.** The matrix row is owned by the not-yet-built `src/acp/host-services.ts`; `acp-client.test.ts:454-482` is a client-dispatch contract test against a mock host (verified by inspection: it injects `requestPermission` and asserts the client marshals the host's decision onto the wire), not an approval-policy test, and asserts no client-level approval policy.

- gate note: `npm run upstream:contracts` passed; `npx tsc -p tsconfig.build.json --noEmit` passed (read-only compile check); `npm run build` failed only on EROFS writing `dist/**`; focused ACP Vitest suites + `npm test` failed only on EROFS writing `node_modules/.vite-temp/**` — environmental (read-only sandbox), not code failures. `git diff --check 7d06af1..5c90024 -- src/` clean; full range flags the known docs-only blank-line nit at `docs/acp/review/B-round-5-codex.md:63`. Reviewer independently confirmed the existing CLI transport path is unchanged (changed `src/` range limited to ACP source/tests) and `src/acp` has no `process.stdout`/`console.log` runtime writes (only test spies + comments matched).

## Driver assessment

All three findings are the recurring permission-mediation scope dispute (findings 2 + 3) plus the Round-3 stderr-prose point (finding 1), each previously rebutted with DAG-grounded, inspected evidence and each independently re-verified by the driver this round:

- The four Phase B steps under review are `build-json-rpc-stdio-transport`, `define-acp-protocol-types`, `implement-acp-client-core`, `add-acp-process-manager` (`dag.toml:557,582,609,633`). `define-host-services-boundary` (`dag.toml:680`) and `implement-permission-bridge` (`dag.toml:702`) are strictly downstream — confirmed by `grep -n 'id = "'` over the DAG.
- `src/acp/host-services.ts` does not exist (`ls src/acp/` → `client.ts errors.ts json-rpc-stdio.ts process-manager.ts provider-registry.ts types.ts`).
- The client fails closed in the absence of a host handler (`requireHandler` throws → JSON-RPC error, `client.ts:497-508`); there is no auto-approve path.
- The `acp.provider.stderr` log is `logger.debug` (default-gated), and structured JSON-RPC payloads are redacted to `<redacted-json>`.
- The driver independently re-confirmed: no real `console.*`/`process.stdout.write` calls in `src/acp/` (comment/docstring mentions only); doctor/flight-recorder/resources carry zero ACP references; the Round-3 content-block fix refines the tolerant fallback against `KNOWN_CONTENT_BLOCK_TYPES`; the Round-5 default-cwd fix (`mkdirSync` before spawn) is covered by two non-vacuous real-spawner tests asserting dir-absent-before / present-after / live child pid+pipes.

No finding in this round identifies a new in-scope code defect. Findings 2 + 3 are layering-bound to a downstream slice by the DAG's own dependency graph; finding 1 is a debug-gated provider-diagnostic channel with structured payloads already redacted. The same scoping was independently affirmed by Grok's full DAG/security-invariant audits in Rounds 2-5 (all APPROVED). The verdict is recorded as CHANGES_REQUIRED to preserve the reviewer's verbatim disposition; the surviving findings are disputed-scope re-raises, not unresolved blockers against the Phase B surface.

## Reviewer verbatim reply

```
CHANGES_REQUIRED

1. [src/acp/json-rpc-stdio.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/json-rpc-stdio.ts:249): provider stderr still reaches logs as raw prose after only pattern redaction.
   Evidence: `onStderrData` logs `line: redactAcpMessage(line)`. [src/acp/errors.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/errors.ts:42) only redacts JSON-looking bodies, paths, tokens, and email-like strings, not arbitrary prompt/file prose. The test at [acp-json-rpc-stdio.test.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/__tests__/acp-json-rpc-stdio.test.ts:432) explicitly preserves a benign stderr line unchanged. That does not satisfy the requested invariant: no raw ACP prompt text or file contents reaching logs.

2. [src/acp/client.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/client.ts:450): `session/request_permission` is passed directly to injected `hostServices.requestPermission` and its result is returned to the provider, with no ApprovalManager mediation in this code path.
   Evidence: the interface says permission callbacks “MUST route through ApprovalManager” at [client.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/client.ts:111), but the implementation just calls the host handler at lines 451-456. The test at [acp-client.test.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/__tests__/acp-client.test.ts:454) locks in approval pass-through. This conflicts with the DAG invariant `approval_manager_required_for_provider_permissions = true` at [dag.toml](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/first-class-acp-gateway-extension.dag.toml:274).

3. [src/__tests__/acp-client.test.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/__tests__/acp-client.test.ts:30): the test file claims it exercises “permission request denied by default,” but the inspected tests only cover denial from an injected handler and approval from an injected handler. There is no `src/acp/host-services.ts`, and the host-services matrix row “routes permission decisions through ApprovalManager” at [dag.toml](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/first-class-acp-gateway-extension.dag.toml:346) is not satisfied by a real non-vacuous test in this change set.

Gate execution:
- `npm run upstream:contracts`: passed.
- `npx tsc -p tsconfig.build.json --noEmit`: passed as a read-only compile check.
- `npm run build`: failed with EROFS writing `dist/**`.
- focused ACP Vitest suites: failed at startup with EROFS writing `node_modules/.vite-temp/**`.
- `npm test`: failed at startup with the same Vite temp-file EROFS.
- `git diff --check 7d06af1..5c90024 -- src/`: clean; full range reports `docs/acp/review/B-round-5-codex.md:63` blank line at EOF.

Other inspected evidence: the changed `src/` range is limited to ACP source/tests, so the existing CLI transport path was not changed by this range. `src/acp` has no `process.stdout` or `console.log` runtime writes; only test spies and comments matched.
```
