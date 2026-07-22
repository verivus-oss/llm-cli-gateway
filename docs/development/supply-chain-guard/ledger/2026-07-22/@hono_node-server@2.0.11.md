# contract: @hono/node-server@2.0.11

- class: tag-along-unaccepted-version (ledgered name @hono/node-server, in-2.0.x roll-forward 2.0.5 -> 2.0.11 to clear a live advisory)
- path: node_modules/@hono/node-server

## advisory research (exa + GitHub advisory + release notes)
- latest npm version: 2.0.11 (current 2.0.x latest; dist.integrity sha512-bjD221KPLoJTWUwso1J6fGKiTXEUFedG/s0visavY4zakFPkeGURMRNly+FhBHs7T8Dz4qHaZIMX9ZoJHSJtKA==).
- GHSA/OSV advisory: FIXES GHSA-9mqv-5hh9-4cgg (published 2026-07-15, CVSS 5.3 Medium). "Unauthenticated memory-leak DoS via aborted WebSocket handshake." Affects `upgradeWebSocket`: a WebSocket upgrade request with a missing/malformed `Sec-WebSocket-Key` header leaked the request's `IncomingMessage` and left a pending promise even though no connection was established; the route is reachable pre-handshake without auth, so an attacker could flood it to exhaust memory. Affected `>= 2.0.0, <= 2.0.9`; Patched `2.0.10`. We pin 2.0.11 (latest 2.0.x, >= the fix line).
  - Applicability to THIS gateway: not applicable. The advisory is in `upgradeWebSocket`; this gateway never uses `upgradeWebSocket` - it consumes `@hono/node-server` only through the MCP SDK's `server/streamableHttp.js`, which imports `getRequestListener` (Node <-> Web-standard request/response conversion). The bump clears the audit finding regardless. No advisory outstanding against 2.0.11.
- changelog baseline -> resolved (v2.0.5 -> v2.0.11, honojs/node-server): 2.0.6-2.0.9 = fixes (websocket ErrorEvent polyfill #371, serve-static Range parsing #372, complete-body recovery after client disconnect #375). 2.0.10 = the GHSA-9mqv security fix. 2.0.11 = latest patch. All within the 2.0.x line; `getRequestListener` export retained (verified present in installed `dist/index.mjs` + `dist/index.d.mts`). No new network/FS/proc capability beyond the existing HTTP-listener role; maintainer/org unchanged (honojs, released by yusukebe).
- pulled in by: `@modelcontextprotocol/sdk@1.29.0` (declares dep `@hono/node-server ^1.19.9`, overridden to `2.0.11`); consumed by the SDK's `server/streamableHttp.js` (`getRequestListener`); reaches this gateway via `src/http-transport.ts` (`StreamableHTTPServerTransport`). Prod.

## upgrade decision
- safe-to-upgrade: YES
- rationale: In-2.0.x patch roll-forward clearing a live Medium DoS advisory whose affected surface (`upgradeWebSocket`) is unused here. Behaviour-preserving for the `getRequestListener` path the SDK uses; runtime-verified (68/68 HTTP/OAuth/transport tests with real 127.0.0.1 binds through the SDK). Same trusted maintainer/registry; already ledgered trusted. Applied by raising the existing `package.json#overrides` exact pin `@hono/node-server 2.0.5 -> 2.0.11`.

## commands (resolved tree, recorded separately from reviewer verdicts)
- npm run build: PASS (tsc clean)
- npm audit --omit=dev --audit-level=moderate: PASS (0 vulnerabilities)
- HTTP/OAuth/transport suites - http-transport.test.ts + oauth + http-job-runner + async-job-manager-http-limiter, real 127.0.0.1 binds through the SDK's getRequestListener: PASS (68/68)
- npm test (full suite): PASS (234 files, 3706 tests)
- npm run supply-chain:scan:check (--frozen gate): PASS exit 0 after ledger append (2.0.11) + baseline refresh

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)
- codex: <pending>
- grok: <pending>
- mistral: <pending>
