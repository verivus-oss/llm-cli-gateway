# contract: @hono/node-server@2.0.5

- class: tag-along-unaccepted-version (ledgered name @hono/node-server moving 1.19.14 -> 2.0.5; a MAJOR bump, forced above the MCP SDK's declared `^1.19.9`, because the advisory has no 1.x patched line)
- path: node_modules/@hono/node-server

## advisory research (exa + GitHub advisory + release notes)
- latest npm version: 2.0.x line (2.0.11 latest at review); we pin the exact patched floor 2.0.5 (dist.integrity sha512-yQFvDmyDo3y6rEOJZDUYPJ49DIKTPpIk4kGvm40xx4Ejne0Pu9a1+exxPN+C1UppWK/WGZX9F++/Xs231tE86g==).
- GHSA/OSV advisory: FIXES GHSA-frvp-7c67-39w9 (published 2026-06-15, CWE-22). "Path traversal in `serve-static` on Windows via encoded backslash (`%5C`)." Affected: `< 2.0.5`; Patched: `2.0.5`. On Windows hosts, `%5C` decodes to `\`, which the Windows path resolver treats as a separator; `serve-static` resolves a single URL segment like `admin\secret.txt` into a nested file under the root, bypassing prefix-mounted middleware (`..` escape stays blocked; read stays within the configured root).
  - IMPORTANT: there is NO patched 1.x line. The only patched version is 2.0.5, so clearing the advisory requires the major bump; a 1.x pin cannot be made non-vulnerable.
  - Applicability to THIS gateway: not applicable. (a) The advisory is Windows-only; this gateway runs on Node >= 24.4.0 on Linux. (b) It affects `serve-static`; the gateway never mounts `serve-static` - it consumes `@hono/node-server` only through the MCP SDK's `server/streamableHttp.js`, which imports `getRequestListener` (Node <-> Web-standard request/response conversion). The bump clears the audit finding regardless.
- changelog baseline -> resolved (v1.19.14 -> v2.0.5, honojs/node-server): the v2.0.0 major has exactly TWO breaking changes, both non-impacting here:
  - Dropped Node.js v18 (now requires Node >= 20). This repo requires Node >= 24.4.0, so satisfied with margin.
  - Removed the Vercel adapter (`@hono/node-server/vercel`). Unused here (gateway imports only the default entry via the SDK).
  - Remainder of 2.0.0 = request/response perf and Web-standard compatibility refactors. 2.0.1-2.0.5 = fixes (websocket ErrorEvent polyfill, serve-static Range parsing, complete-body recovery after client disconnect, and the security fix). The `getRequestListener` export the SDK depends on is retained in 2.0.5 (verified present in installed `dist/index.mjs` + `dist/index.d.mts`). No new network/FS/proc capability beyond the existing HTTP-listener role; maintainer/org unchanged (honojs, released by yusukebe).
- pulled in by: `@modelcontextprotocol/sdk@1.29.0` (declares dep `@hono/node-server ^1.19.9`, overridden to `2.0.5`); consumed by the SDK's `server/streamableHttp.js` (`getRequestListener`); reaches this gateway via `src/http-transport.ts` (`StreamableHTTPServerTransport`). Prod.

## upgrade decision
- safe-to-upgrade: YES
- rationale: The single advisory (Windows-only serve-static path traversal) has no 1.x patch, so the fix is only reachable via the 2.x major; both of v2's breaking changes are non-impacting for this gateway (Node-18 drop is below our >=24.4 floor; Vercel adapter is unused). The `getRequestListener` API the SDK relies on is unchanged and present in 2.0.5. Runtime-verified end-to-end: the HTTP transport binds a real listener (127.0.0.1) through the SDK and serves requests - 68/68 HTTP/OAuth/transport tests pass and the full 3696-test suite passes. Forcing 2.0.5 above the SDK's declared `^1.19.9` is deliberate and unavoidable to obtain a patched line; same trusted maintainer/registry. Applied via a new `package.json#overrides` exact pin `@hono/node-server: 2.0.5`.

## commands (resolved tree, recorded separately from reviewer verdicts)
- npm run build: PASS (tsc clean)
- npm audit --omit=dev --audit-level=moderate: PASS (0 vulnerabilities)
- HTTP/OAuth/transport suites - http-transport.test.ts (50) + oauth + http-job-runner + async-job-manager-http-limiter, real 127.0.0.1 binds through the SDK's getRequestListener: PASS (68/68 across the 4 files)
- npm test (full suite): PASS (233 files, 3696 tests)
- npm run supply-chain:scan:check (--frozen gate): PASS exit 0 after ledger append (2.0.5) + baseline refresh

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)
- codex: APPROVED_UNCONDITIONALLY (r3 on the updated tree; correlationId sc-hono-codex-r3, job 41d33cd9-d498-4dbd-bc1d-b26c56cc71fd). r2 (job 8d51fe0c-f6df-4be2-ad2c-fb0b09c03a47) technical assessment was all-PASS (red-team: override/SDK compat, lock<->baseline<->ledger integrity match, exact advisory fix lines, no vulnerable hono/jsx|css|aws-lambda surfaces imported, getRequestListener retained, floor satisfied, no prod-source changes; 2 info-only notes) but its FORMAL r2 verdict was CHANGES_REQUIRED on a single PROCESS point: the contracts still showed 'codex: <pending>'. Resolved by recording all three verdicts here, then re-reviewing per Codex's own instruction. r2 env-limited items (build/audit/scan blocked by read-only sandbox; npm/OSV/Exa network unreachable) were independently covered by Grok's live run + GitHub GHSA records.
- grok: APPROVED_UNCONDITIONALLY (r1; correlationId sc-hono-grok-r1, job c514c583-d82b-4b4f-8eed-2da6f3dc71ad; full-access review - ran git diff + rg src/ + npm build + vitest http-transport + npm audit + osv-scanner + live npm view; verified all 5 claims against GHSA/OSV pages and the registry; only non-blocking nits)
- mistral: APPROVED_UNCONDITIONALLY (r2; correlationId sc-hono-mistral-r2, job 4644e2f8-f72d-42f0-9a6d-2dacc1577b3f; local-tree verification of overrides, src imports, installed versions/engines, getRequestListener export + SDK import, EXACT acceptedVersions, baseline<->lock integrity match, real-bind tests, registry/maintainer. Advisory version-ranges + npm-audit-clean marked UNVERIFIED, no web/npm access - independently confirmed live by Grok. r1 was BLOCKED_EXTERNAL - neutral-workspace sandbox denied repo access; re-run with workingDir scoped to repo.)
