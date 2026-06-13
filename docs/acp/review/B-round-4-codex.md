# Phase B — Round-4 adversarial release review (Codex)

- Reviewer lens: **codex** (gpt-5.x, `mcp__gtwy__codex_request_async`, sandbox `read-only`, MCP `sqry`+`ref`)
- Job: `3c56bf4a-473b-4460-bb6e-74058c7a8542` (correlation `c4a2fc47-09f5-4a94-b36f-4a5f1418eeea`), exit 0
- Dispatch technique: embedded-absolute-path (no `workingDir`; repo path
  `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway` carried in the prompt so the
  reviewer's read-only shell runs `git -C <abs>` / absolute-path reads directly — same
  route used in Round-3, the remote-workspace gateway still rejects absolute `workingDir`)
- Diff range reviewed: `57c0611..6621a6be802f454435f50f32de20e21d85f1b2fe`
- Verification report under review: `docs/acp/verification/phase-B.md`

## Verdict: CHANGES_REQUIRED

## Verbatim reviewer reply

```
VERDICT: CHANGES_REQUIRED

**Findings**

- [src/acp/client.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/client.ts:450): `session/request_permission` is not ApprovalManager-mediated. The client parses the provider request, calls any injected `hostServices.requestPermission`, and returns that result directly to the provider. The DAG requires `approval_manager_required_for_provider_permissions = true` and the test matrix row “routes permission decisions through ApprovalManager” in [first-class-acp-gateway-extension.dag.toml](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/first-class-acp-gateway-extension.dag.toml:274). The current test explicitly locks in a permissive path: [acp-client.test.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/__tests__/acp-client.test.ts:454) returns `{ outcome: "selected" }` from a mock callback and expects the provider to receive approval. That is an ApprovalManager bypass, not mediation. Until the permission bridge exists, this path should deny by default or require a concrete ApprovalManager-backed implementation.

**Gate Evidence I Ran**

- `npx tsc -p tsconfig.build.json --noEmit`: passed.
- `npm run lint`: passed with 127 warnings.
- `npm run upstream:contracts`: passed.
- `git diff --check 57c0611..6621a6be802f454435f50f32de20e21d85f1b2fe` and worktree diff check: passed.
- `npm run build`: could not verify; failed with `TS5033 EROFS` writing `dist/**` in the read-only sandbox.
- Focused ACP Vitest suites and `npm test`: could not verify; Vitest failed before running tests because the sandbox is read-only, including `/tmp` and `node_modules/.vite-temp`.

**Other Inspected Evidence**

- The Phase B source diff under `src/` is additive only: the four ACP source files and four ACP test files were added; existing CLI transport files were not changed in `57c0611..6621a6be802f454435f50f32de20e21d85f1b2fe`.
- Static scan of the changed ACP implementation files found no executable `console.*` or `process.stdout` writes. Provider stdout is consumed as protocol in [json-rpc-stdio.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/json-rpc-stdio.ts:188), stderr is redacted before logging at [json-rpc-stdio.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/json-rpc-stdio.ts:231), and spawn uses `shell: false` at [process-manager.ts](/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/src/acp/process-manager.ts:274).
```

## Driver structured verdict

**verdict:** CHANGES_REQUIRED

### Findings

1. **major — `src/acp/client.ts:450` (`session/request_permission` not ApprovalManager-mediated).**
   The client delegates `session/request_permission` straight to the injected
   `hostServices.requestPermission` and returns the result to the provider verbatim
   (client.ts:450-457), with no ApprovalManager in the path. `acp-client.test.ts:454`
   ("grants permission when HostServices approves (selected option)") locks in a
   permissive `{ outcome: "selected", optionId: "allow" }` outcome. The reviewer reads
   the DAG `approval_manager_required_for_provider_permissions = true` invariant and the
   "routes permission decisions through ApprovalManager" matrix row as binding here and
   rejects the report's Round-1/Round-2 out-of-scope rebuttal: until the permission
   bridge ships, this path should deny-by-default rather than honour an arbitrary
   injected callback. Driver-verified against the cited lines.

### Inspected / executed (per reviewer + driver)

- Read: `src/acp/client.ts` (430-469), `src/__tests__/acp-client.test.ts` (440-468),
  `docs/acp/verification/phase-B.md` (full).
- Reviewer ran: `npx tsc -p tsconfig.build.json --noEmit` (pass), `npm run lint`
  (pass, 127 warnings), `npm run upstream:contracts` (pass),
  `git diff --check 57c0611..6621a6b` + worktree (pass).
- Reviewer could NOT run (read-only sandbox EROFS): `npm run build` (TS5033 writing
  `dist/**`), focused ACP Vitest suites + `npm test` (Vitest needs writable `/tmp` /
  `node_modules/.vite-temp`). These dynamic gates remain unverified by this lens; the
  writable-env aggregator report claims build 0 / ACP suites 94/94 / full suite
  1382/1382, but the adversarial lens did not independently confirm them.
- Reviewer static checks: ACP `src/` diff additive only (existing CLI transport
  unchanged); no `console.*` / `process.stdout` writes; stderr redacted before logging
  (`json-rpc-stdio.ts:231`); `shell: false` spawn (`process-manager.ts:274`).
