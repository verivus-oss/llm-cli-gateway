# contract: hono@4.12.31

- class: tag-along-unaccepted-version (ledgered name hono moving 4.12.25 -> 4.12.31; roll-forward-in-intent to clear three live advisories)
- path: node_modules/hono

## advisory research (exa + GitHub advisory + release notes)
- latest npm version: 4.12.31 (current 4.12.x latest at review; dist.integrity sha512-zJIHFrl6bq3RDd2YusFNCDlM8qUprxKswyi/OPzPyzKDdyBXDqWx8bZlZ7R+saTdSTatUmb3O7K4SspGPaEOQg==). Same 4.12.x minor line as the ledgered 4.12.25.
- GHSA/OSV advisory: FIXES three advisories, all published 2026-06-23, all "Affected >= (4.3.3|4.11.8), < 4.12.27; Patched: 4.12.27":
  - GHSA-hvrm-45r6-mjfj - hono/jsx & hono/jsx-renderer: SSR context stored process-wide instead of per request, so `useContext()`/`useRequestContext()` read after an `await` in an async component could return another concurrent request's value (cross-request data disclosure / auth-check-against-wrong-request).
  - GHSA-w62v-xxxg-mg59 - hono/css `cx()`: marked its composed class name as already-escaped without escaping input, so untrusted input passed as a class name could break out of the JSX `class` attribute during SSR and inject markup (server-side XSS).
  - GHSA-xgm2-5f3f-mvvc / CVE-2026-59897 - hono/aws-lambda: API Gateway v1 (and VPC Lattice) adapter de-duplicated repeated header values by substring instead of exact match, dropping a value that is a substring of another (e.g. `203.0.113.1` dropped when `203.0.113.10` present) - affecting `X-Forwarded-For`-based logic.
  - Applicability to THIS gateway: none of the three affected surfaces are used here. The gateway imports no `hono/jsx`, `hono/jsx-renderer`, `hono/css`, or `hono/aws-lambda`; its only hono consumption is transitive via the MCP SDK's `server/streamableHttp.js`, which uses `@hono/node-server`'s `getRequestListener` (Node HTTP <-> Web-standard conversion), not the JSX/CSS/Lambda subpaths. Not exploitable in our deployment; the bump clears the audit finding regardless. No advisory outstanding against 4.12.31.
- changelog baseline -> resolved (v4.12.25 -> v4.12.31, honojs/hono): 4.12.27 = the three security fixes above (JSX now uses AsyncLocalStorage-based per-request isolation; `cx()` escapes input; API-GW-v1 adapter uses exact-match header dedup). 4.12.28-4.12.31 = further non-security patches (bug/perf). No new network/FS/proc capability surface; maintainer/org unchanged (honojs, released by yusukebe).
- pulled in by: `@modelcontextprotocol/sdk@1.29.0` (declares `hono ^4.11.4`) plus `@hono/node-server`'s peer (`hono ^4`); floor held by the root `package.json#overrides` pin `hono ^4.12.27`. Prod.

## upgrade decision
- safe-to-upgrade: YES
- rationale: In-minor patch roll-forward (4.12.25 -> 4.12.31) that clears three live advisories, none of which touches this gateway's usage surface (getRequestListener path only). Behavior-preserving for that path; same trusted maintainer/registry; hono already ledgered trusted since 2026-07-10. Applied by raising the existing overrides pin `hono ^4.12.25 -> ^4.12.27`, and the `release-security-audit.sh` hono floor is raised in lock-step `[4,12,25] -> [4,12,27]` (the new advisory fix line). NOTE (by design, not an inconsistency): the override `^4.12.27` is a security FLOOR; npm then resolves the latest 4.12.x satisfying it, which is `4.12.31`, so `package-lock.json`, the baseline, and the ledger `acceptedVersions` all pin the exact resolved `4.12.31` (>= the 4.12.27 floor).

## commands (resolved tree, recorded separately from reviewer verdicts)
- npm run build: PASS (tsc clean)
- npm audit --omit=dev --audit-level=moderate: PASS (0 vulnerabilities)
- HTTP/OAuth/transport suites - http-transport.test.ts (50) + oauth + http-job-runner + async-job-manager-http-limiter, real 127.0.0.1 binds through the SDK: PASS (68/68 across the 4 files)
- npm test (full suite): PASS (233 files, 3696 tests)
- npm run supply-chain:scan:check (--frozen gate): PASS exit 0 after ledger append (4.12.31) + baseline refresh

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)
- codex: APPROVED_UNCONDITIONALLY (r3 on the updated tree; correlationId sc-hono-codex-r3, job 41d33cd9-d498-4dbd-bc1d-b26c56cc71fd). r2 (job 8d51fe0c-f6df-4be2-ad2c-fb0b09c03a47) technical assessment was all-PASS (red-team: override/SDK compat, lock<->baseline<->ledger integrity match, exact advisory fix lines, no vulnerable hono/jsx|css|aws-lambda surfaces imported, getRequestListener retained, floor satisfied, no prod-source changes; 2 info-only notes) but its FORMAL r2 verdict was CHANGES_REQUIRED on a single PROCESS point: the contracts still showed 'codex: <pending>'. Resolved by recording all three verdicts here, then re-reviewing per Codex's own instruction. r2 env-limited items (build/audit/scan blocked by read-only sandbox; npm/OSV/Exa network unreachable) were independently covered by Grok's live run + GitHub GHSA records.
- grok: APPROVED_UNCONDITIONALLY (r1; correlationId sc-hono-grok-r1, job c514c583-d82b-4b4f-8eed-2da6f3dc71ad; full-access review - ran git diff + rg src/ + npm build + vitest http-transport + npm audit + osv-scanner + live npm view; verified all 5 claims against GHSA/OSV pages and the registry; only non-blocking nits)
- mistral: APPROVED_UNCONDITIONALLY (r2; correlationId sc-hono-mistral-r2, job 4644e2f8-f72d-42f0-9a6d-2dacc1577b3f; local-tree verification of overrides, src imports, installed versions/engines, getRequestListener export + SDK import, EXACT acceptedVersions, baseline<->lock integrity match, real-bind tests, registry/maintainer. Advisory version-ranges + npm-audit-clean marked UNVERIFIED, no web/npm access - independently confirmed live by Grok. r1 was BLOCKED_EXTERNAL - neutral-workspace sandbox denied repo access; re-run with workingDir scoped to repo.)
