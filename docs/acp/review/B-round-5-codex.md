# Phase B — Transport core: Review round 5 (codex)

- Reviewer: codex (gpt-5.4, OpenAI Codex v0.139.0)
- Lens: adversarial release reviewer
- Job id: 1c5fadc4-30c7-474c-919f-c3b0b582a490
- Correlation id: bf65ad75-8b15-4ff1-b4a2-798520f3cbd8
- Exit code: 0
- Diff range: 7d06af1..3e791ae
- Access granted: read-only sandbox + bash (cd into repo) + MCP (sqry, ref_tools). No write/commit/release (codex read-only by policy).
- Date: 2026-06-13

## Driver structured verdict

- verdict: CHANGES_REQUIRED
- findings:
  1. [major] src/acp/client.ts:111-118,450-456 (dist/acp/client.js:145-147) — ApprovalManager mediation for provider permission approvals not enforced; client forwards hostServices.requestPermission result verbatim. Test src/__tests__/acp-client.test.ts:454-482 locks in the pass-through. DAG requires approval_manager_required_for_provider_permissions=true (dag.toml:274), routing through ApprovalManager (:341-346), deny-until-bridge (:680-690), bridge deferred (:701-714). NOTE: same finding raised in round-4 and rebutted by the implementer (see commit 3e791ae / B-round-4); driver flags as disputed/scope question, not a confirmed new regression.
  2. [major] src/acp/process-manager.ts:133-137,266-286 (dist/acp/process-manager.js:56,64) — default no-cwd path returns ${tmpdir()}/llm-gateway-acp-<provider> and passes it to spawn without creating the directory; missing dir => spawn ENOENT on a clean host. Only test (acp-process-manager.test.ts:215-221) asserts the path string prefix, not directory existence or a real spawn. Reviewer reproduced: /tmp/llm-gateway-acp-mistral missing; node spawn with missing cwd => spawn true ENOENT.
- gate note: npm run build and npm test could not write under read-only sandbox (TS5033/EROFS, vite-temp EROFS) — environmental, not a code failure; npm run upstream:contracts passed.

## Reviewer verbatim reply

FINAL VERDICT: CHANGES_REQUIRED

**Findings**
1. `src/acp/client.ts:111-118,450-456`; shipped at `dist/acp/client.js:145-147`. ApprovalManager mediation for provider permission approvals is not actually enforced. The code only documents that `requestPermission` “MUST route through ApprovalManager”, then forwards whatever `hostServices.requestPermission` returns straight back to the provider. The tests lock that behavior in: `src/__tests__/acp-client.test.ts:454-482` injects a mock `requestPermission` and asserts that its approval is echoed verbatim. Inspected evidence: the DAG marks `approval_manager_required_for_provider_permissions = true` at `docs/plans/first-class-acp-gateway-extension.dag.toml:274`, requires `routes permission decisions through ApprovalManager` at `:341-346`, and says permission requests are denied until the ApprovalManager bridge exists at `:680-690`, with the bridge itself still deferred to `:701-714`. That explicit approval criterion is not met by the Phase B code under review.
2. `src/acp/process-manager.ts:133-137,266-286`; shipped at `dist/acp/process-manager.js:56,64`. The default no-`cwd` path can fail on a clean host because it is never created before spawn. `resolveProviderSpawn()` returns `${tmpdir()}/llm-gateway-acp-${provider}` when `cwd` is omitted, and `defaultSpawn` passes it directly to `child_process.spawn`. The only test for this path, `src/__tests__/acp-process-manager.test.ts:215-221`, checks only that the string starts with `tmpdir()`, not that the directory exists or that a real spawn succeeds. Inspected evidence: `/tmp/llm-gateway-acp-mistral` was `missing` in this environment, and a plain Node spawn against a missing `cwd` failed with `ENOENT` (`spawn true ENOENT`).

Gate note: I attempted the mandated commands. `npm run build` failed only because the read-only sandbox could not write `dist/**` (`TS5033 EROFS`); `npm test` failed only because Vitest could not write `node_modules/.vite-temp/**` (`EROFS`); `npm run upstream:contracts` completed successfully.

**INSPECTED**
- Files opened/read: `docs/acp/verification/phase-B.md`, `docs/acp/verification/build-json-rpc-stdio-transport.md`, `docs/acp/verification/define-acp-protocol-types.md`, `docs/acp/verification/implement-acp-client-core.md`, `docs/acp/verification/add-acp-process-manager.md`, `docs/acp/review/B-round-1-codex.md`, `docs/acp/review/B-round-1-grok.md`, `docs/acp/review/B-round-2-codex.md`, `docs/acp/review/B-round-2-grok.md`, `docs/acp/review/B-round-3-codex.md`, `docs/acp/review/B-round-3-grok.md`, `docs/plans/acp-implementation.workflow.js`, `docs/plans/first-class-acp-gateway-extension.dag.toml`, `package.json`, `src/acp/json-rpc-stdio.ts`, `src/acp/types.ts`, `src/acp/client.ts`, `src/acp/process-manager.ts`, `src/acp/errors.ts`, `src/__tests__/acp-json-rpc-stdio.test.ts`, `src/__tests__/acp-types.test.ts`, `src/__tests__/acp-client.test.ts`, `src/__tests__/acp-process-manager.test.ts`, `dist/acp/client.js`, `dist/acp/client.d.ts`, `dist/acp/process-manager.js`, `dist/acp/process-manager.d.ts`, `dist/doctor.js`, `dist/doctor.d.ts`, `dist/flight-recorder.js`, `dist/flight-recorder.d.ts`, `dist/resources.js`, `dist/resources.d.ts`.
- All shell commands were run as `cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway && ...`
- Commands run:
  1. `git status --short && git rev-parse --short HEAD && git diff --stat 7d06af1..3e791ae`
  2. `sed -n '1,260p' docs/acp/verification/phase-B.md`
  3. `git diff --unified=80 7d06af1..3e791ae -- src/acp/json-rpc-stdio.ts src/acp/types.ts src/acp/client.ts src/acp/process-manager.ts src/__tests__/acp-json-rpc-stdio.test.ts src/__tests__/acp-types.test.ts src/__tests__/acp-client.test.ts src/__tests__/acp-process-manager.test.ts`
  4. `sed -n '1,260p' src/acp/json-rpc-stdio.ts && printf '\n---FILE SPLIT---\n' && sed -n '261,520p' src/acp/json-rpc-stdio.ts && printf '\n---FILE SPLIT---\n' && sed -n '521,760p' src/acp/json-rpc-stdio.ts`
  5. `sed -n '1,260p' src/acp/client.ts && printf '\n---FILE SPLIT---\n' && sed -n '261,520p' src/acp/client.ts && printf '\n---FILE SPLIT---\n' && sed -n '521,760p' src/acp/client.ts`
  6. `sed -n '1,260p' src/acp/process-manager.ts && printf '\n---FILE SPLIT---\n' && sed -n '261,520p' src/acp/process-manager.ts && printf '\n---FILE SPLIT---\n' && sed -n '521,820p' src/acp/process-manager.ts`
  7. `nl -ba src/acp/types.ts | sed -n '1,260p' && printf '\n---FILE SPLIT---\n' && nl -ba src/acp/types.ts | sed -n '261,520p' && printf '\n---FILE SPLIT---\n' && nl -ba src/acp/types.ts | sed -n '521,760p'`
  8. `rg -n "process\.stdout|console\." src/acp src/__tests__/acp-*.test.ts && printf '\n---FILE SPLIT---\n' && rg -n "ApprovalManager|requestPermission|write_text_file|read_text_file|session/request_permission|GROK_LEADER_SOCKET|shell: false|stdout_closed|provider.stderr|redactAcpMessage|providerMessage|unknown content block|known content block|onActivity|onClose" src/acp src/__tests__/acp-*.test.ts docs/plans/acp-implementation.workflow.js`
  9. `npm run build`
  10. `npm test`
  11. Polled the running `npm run build` exec session, which returned `TS5033 EROFS` writes to `dist/**`
  12. `npm run upstream:contracts`
  13. `nl -ba src/__tests__/acp-json-rpc-stdio.test.ts | sed -n '1,260p' && printf '\n---FILE SPLIT---\n' && nl -ba src/__tests__/acp-json-rpc-stdio.test.ts | sed -n '261,540p'`
  14. `nl -ba src/__tests__/acp-client.test.ts | sed -n '1,260p' && printf '\n---FILE SPLIT---\n' && nl -ba src/__tests__/acp-client.test.ts | sed -n '261,540p'`
  15. `nl -ba src/__tests__/acp-process-manager.test.ts | sed -n '1,280p' && printf '\n---FILE SPLIT---\n' && nl -ba src/__tests__/acp-process-manager.test.ts | sed -n '281,620p'`
  16. `nl -ba src/__tests__/acp-types.test.ts | sed -n '1,260p' && printf '\n---FILE SPLIT---\n' && nl -ba src/__tests__/acp-types.test.ts | sed -n '261,520p'`
  17. `nl -ba src/acp/errors.ts | sed -n '1,260p' && printf '\n---FILE SPLIT---\n' && nl -ba src/acp/errors.ts | sed -n '261,420p'`
  18. `nl -ba docs/plans/acp-implementation.workflow.js | sed -n '150,240p'`
  19. `nl -ba src/acp/client.ts | sed -n '1,260p' && printf '\n---FILE SPLIT---\n' && nl -ba src/acp/client.ts | sed -n '261,560p'`
  20. `nl -ba src/acp/process-manager.ts | sed -n '1,340p' && printf '\n---FILE SPLIT---\n' && nl -ba src/acp/process-manager.ts | sed -n '341,760p'`
  21. `git diff --name-only 7d06af1..3e791ae && printf '\n---FILE SPLIT---\n' && rg --files dist | rg '^dist/(acp|doctor|flight-recorder|resources)' && printf '\n---FILE SPLIT---\n' && nl -ba package.json | sed -n '1,220p'`
  22. `nl -ba dist/acp/process-manager.js | sed -n '180,320p' && printf '\n---FILE SPLIT---\n' && nl -ba dist/acp/client.js | sed -n '180,340p'`
  23. `rg -n "acp|ACP|request_permission|read_text_file|write_text_file|redactAcp" src/doctor.ts src/flight-recorder.ts src/resources.ts dist/doctor.js dist/flight-recorder.js dist/resources.js`
  24. `for f in docs/acp/verification/build-json-rpc-stdio-transport.md docs/acp/verification/define-acp-protocol-types.md docs/acp/verification/implement-acp-client-core.md docs/acp/verification/add-acp-process-manager.md docs/acp/review/B-round-1-codex.md docs/acp/review/B-round-1-grok.md docs/acp/review/B-round-2-codex.md docs/acp/review/B-round-2-grok.md docs/acp/review/B-round-3-codex.md docs/acp/review/B-round-3-grok.md; do echo "===== $f ====="; sed -n '1,220p' "$f"; done`
  25. `node -e 'const {tmpdir}=require("node:os"); const p=\`${tmpdir()}/llm-gateway-acp-mistral\`; console.log(p); console.log(require("node:fs").existsSync(p)?"exists":"missing");'`
  26. `node -e 'const {spawn}=require("node:child_process"); const child=spawn(process.platform==="win32"?"cmd":"true", process.platform==="win32"?["/c","exit","0"]:[], {cwd:"/tmp/definitely-missing-llm-gateway-acp-review-path"}); child.on("error", e=>{console.log(e.code); console.log(e.message);}); child.on("exit", (c,s)=>{console.log("exit",c,s);});'`
  27. `rg -n "approval_manager_required_for_provider_permissions|routes permission decisions through ApprovalManager|define-host-services-boundary|implement-permission-bridge|host_services" docs/plans/first-class-acp-gateway-extension.dag.toml docs/acp/verification/phase-B.md docs/acp/review/B-round-3-codex.md src/acp/client.ts src/__tests__/acp-client.test.ts`
  28. `rg -n "requestPermission|session/request_permission|Host does not support ACP|unsupported_host_method" dist/acp/client.js dist/acp/client.d.ts && printf '\n---FILE SPLIT---\n' && rg -n "llm-gateway-acp-|cwd: cwd|shell: false|process\\.spawn|stdout_channel_closed" dist/acp/process-manager.js dist/acp/process-manager.d.ts`
  29. `nl -ba docs/plans/first-class-acp-gateway-extension.dag.toml | sed -n '264,278p' && printf '\n---FILE SPLIT---\n' && nl -ba docs/plans/first-class-acp-gateway-extension.dag.toml | sed -n '338,348p' && printf '\n---FILE SPLIT---\n' && nl -ba docs/plans/first-class-acp-gateway-extension.dag.toml | sed -n '680,715p'`

