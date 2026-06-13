# Phase B — Transport core: Adversarial release review (Round 1, lens: codex)

- Reviewer model: codex (via `mcp__gtwy__codex_request_async`)
- Job ID: `1642debc-abc6-48f1-83d6-278878c7d660`
- Correlation ID: `d27aa0e3-615c-4870-ad0c-6e5eee7def81`
- Sandbox: `read-only` (READ + verify + MCP only; no repo write/commit/release granted)
- MCP servers granted: `sqry`, `ref_tools`
- Date: 2026-06-13
- Change set: commits 3cf062f, be98e60, f261819, 9a84770 (range 57c0611..9a84770)
- Verdict: **CHANGES_REQUIRED**

---

## Reviewer reply (verbatim)

```
VERDICT: CHANGES_REQUIRED

Findings:

1. `src/acp/json-rpc-stdio.ts:202-211` leaks raw provider stderr into gateway logs.
   Evidence: `onStderrData()` forwards `{ line }` verbatim via `logger.debug("acp.provider.stderr", ...)`. The test at `src/__tests__/acp-json-rpc-stdio.test.ts:320-328` explicitly asserts the raw stderr line is logged. This violates the required invariant that prompt text, file contents, credential paths, and raw ACP material must not reach logs. The existing redactor in `src/acp/errors.ts:42-73` is not used here.

2. `src/acp/client.ts:91-119` and `src/acp/client.ts:450-456` do not enforce ApprovalManager-mediated permissions.
   Evidence: `HostServices.requestPermission` is just an optional injected callback; `AcpClient` imports no `ApprovalManager` and delegates directly to that callback. The test at `src/__tests__/acp-client.test.ts:450-479` proves a permission can be approved by a mock HostServices callback with no ApprovalManager path. That does not satisfy `approval_manager_required_for_provider_permissions`.

3. `src/acp/client.ts:432-447` does not implement the DAG `[test_matrix.unit.host_services]` workspace/file-service invariants.
   Evidence: read and write host callbacks are parsed then delegated directly to injected HostServices. There is no concrete host-services implementation, no workspace-root resolution, and no path traversal rejection in Phase B. The tests only prove a mock `fs/read_text_file` can return content (`src/__tests__/acp-client.test.ts:362-391`) and a missing write handler errors (`src/__tests__/acp-client.test.ts:394-419`); they do not prove "resolves read paths under workspace root" or "rejects path traversal outside workspace."

4. `package.json:58` / `package.json:65` required gates could not be verified in this environment.
   Evidence: `npm run build` failed because `tsc` could not write `dist/*` on the read-only filesystem (`EROFS`). `npx vitest run ...` and `npm test -- ...` failed before running tests because Vitest could not write Vite temp files. `npx vitest run --configLoader runner ...` also failed before tests with temp-dir creation errors. I did run `npx tsc -p tsconfig.build.json --noEmit --pretty false`, which passed, but that is not the requested build gate.

Inspected/opened files:
`docs/acp/verification/phase-B.md`; `docs/plans/first-class-acp-gateway-extension.dag.toml`; `package.json`; `src/acp/json-rpc-stdio.ts`; `src/acp/types.ts`; `src/acp/client.ts`; `src/acp/process-manager.ts`; `src/acp/errors.ts`; `src/acp/provider-registry.ts`; `src/config.ts`; `src/__tests__/acp-json-rpc-stdio.test.ts`; `src/__tests__/acp-types.test.ts`; `src/__tests__/acp-client.test.ts`; `src/__tests__/acp-process-manager.test.ts`; `src/__tests__/acp-config.test.ts`.

Commands/tests actually run:
`git status --short`; `git log --oneline 57c0611..9a84770`; `git diff --stat 57c0611..9a84770`; `git diff --name-only 57c0611..9a84770`; `git diff --check 57c0611..9a84770`; `npm run build` (failed EROFS); `npx vitest run ...four ACP suites...` (failed startup EROFS); `npm test -- ...four ACP suites...` (failed startup EROFS); `npx vitest run --configLoader runner ...four ACP suites...` (failed startup temp dir); `npx tsc -p tsconfig.build.json --noEmit --pretty false` (passed); `npm run upstream:contracts` (passed); `rg`/`grep` static searches for stdout/console/logging/ApprovalManager/flight-recorder/resource references. Used sqry MCP: `get_index_status`, `list_files`, `get_definition`; sqry index was stale for new ACP files.
```

---

## Driver structured verdict

- **reviewer**: codex
- **verdict**: CHANGES_REQUIRED

### Findings

1. **[major]** `src/acp/json-rpc-stdio.ts:202-211` — `onStderrData()` forwards raw provider stderr `{ line }` verbatim to `logger.debug("acp.provider.stderr", ...)` instead of routing it through the redactor at `src/acp/errors.ts:42-73`. Test `src/__tests__/acp-json-rpc-stdio.test.ts:320-328` asserts the raw line IS logged, locking in the leak. Violates the no-raw-ACP/prompt/path-to-logs security invariant.

2. **[major]** `src/acp/client.ts:91-119` and `:450-456` — permission requests are dispatched to an optional injected `HostServices.requestPermission` callback with no `ApprovalManager` import or path. Test `src/__tests__/acp-client.test.ts:450-479` approves via a mock callback, not ApprovalManager. Fails `approval_manager_required_for_provider_permissions`.

3. **[major]** `src/acp/client.ts:432-447` — host file-service callbacks delegate directly to injected HostServices with no workspace-root resolution and no path-traversal rejection. The `[test_matrix.unit.host_services]` rows ("resolves read paths under workspace root", "rejects path traversal outside workspace") are not proven by the existing tests (`acp-client.test.ts:362-391`, `:394-419`).

4. **[minor]** `package.json:58/:65` — required `npm run build` and `npm test` gates could not be executed under the read-only sandbox (EROFS / Vitest temp-dir failures). Only `tsc --noEmit` and `npm run upstream:contracts` passed. The build/test gates remain UNVERIFIED by the reviewer and must be re-run in a writable environment.

### Inspected (reviewer)

docs/acp/verification/phase-B.md; docs/plans/first-class-acp-gateway-extension.dag.toml; package.json; src/acp/json-rpc-stdio.ts; src/acp/types.ts; src/acp/client.ts; src/acp/process-manager.ts; src/acp/errors.ts; src/acp/provider-registry.ts; src/config.ts; src/__tests__/acp-json-rpc-stdio.test.ts; src/__tests__/acp-types.test.ts; src/__tests__/acp-client.test.ts; src/__tests__/acp-process-manager.test.ts; src/__tests__/acp-config.test.ts; git status/log/diff(--stat,--name-only,--check) 57c0611..9a84770; npm run build (EROFS); npx vitest run x4 suites (EROFS); npm test (EROFS); npx tsc -p tsconfig.build.json --noEmit (passed); npm run upstream:contracts (passed); rg/grep static searches; sqry MCP get_index_status/list_files/get_definition.
