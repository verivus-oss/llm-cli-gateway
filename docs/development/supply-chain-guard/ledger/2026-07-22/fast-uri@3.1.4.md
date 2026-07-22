# contract: fast-uri@3.1.4

- class: tag-along-unaccepted-version (ledgered name fast-uri, in-3.x roll-forward 3.1.3 -> 3.1.4 to clear a live advisory)
- path: node_modules/fast-uri

## advisory research (exa + GitHub advisory)
- latest npm version: 4.1.1 (latest overall); we DELIBERATELY stay on the 3.x line at 3.1.4 (the 3.x patched version) to avoid the 4.x major. dist.integrity sha512-8JnbkQ4juDyvYs4mgFGQqg4yCYtFDtUtmp2QIQq11ZZe5CFQ5wcqm1rqDgAh/QdMySuBnPzMUiJUNZG5N/AiQw==.
- GHSA/OSV advisory: FIXES GHSA-v2hh-gcrm-f6hx (published 2026-07-19, CVSS 7.5 High). "fast-uri vulnerable to host confusion via literal backslash authority delimiter." fast-uri does not treat a literal backslash (U+005C) as an authority delimiter, while Node's WHATWG URL (used by fetch/undici/http) normalizes `\` to `/` for special schemes, so the two parsers extract different hosts from the same input (e.g. `http://evil.com\@allowed.com` -> fast-uri host `allowed.com`, WHATWG host `evil.com`). Affected `>= 3.0.0, <= 3.1.3` (also 2.x and 4.x lines); Patched `3.1.4` (and `2.4.3`, `4.1.1`).
  - Applicability to THIS gateway: not applicable. fast-uri is transitive via `ajv` (JSON-schema `$id`/`$ref` URI parsing), NOT used here to enforce host-based policy (allowlists, SSRF/redirect/proxy-routing filters) before handing the URL to Node/fetch. The parser-desync attack requires that host-policy-enforcement usage. The bump clears the audit finding regardless. No advisory outstanding against 3.1.4.
- changelog baseline -> resolved (3.1.3 -> 3.1.4, fastify/fast-uri): a single security patch treating `\` as an authority delimiter to match WHATWG URL host extraction. No new capability surface; maintainer/org unchanged (fastify).
- pulled in by: `ajv` (JSON schema validator) -> fast-uri; ajv reaches the prod closure transitively. `npm ls fast-uri` resolves the single overridden instance. Prod.

## upgrade decision
- safe-to-upgrade: YES
- rationale: In-3.x single-patch roll-forward clearing a live High host-confusion advisory whose exploit surface (using fast-uri for host-policy enforcement) is not present in this closure (ajv uses it for schema `$id`/`$ref` only). Behaviour-preserving for that usage. Stayed on 3.x (avoids the 4.1.1 major). Same trusted maintainer/registry; already ledgered trusted. Applied by raising the existing `package.json#overrides` exact pin `fast-uri 3.1.3 -> 3.1.4`.

## commands (resolved tree, recorded separately from reviewer verdicts)
- npm run build: PASS (tsc clean)
- npm audit --omit=dev --audit-level=moderate: PASS (0 vulnerabilities)
- npm test (full suite): PASS (234 files, 3706 tests)
- npm run supply-chain:scan:check (--frozen gate): PASS exit 0 after ledger append (3.1.4) + baseline refresh

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)
- codex: APPROVED_UNCONDITIONALLY (r1; correlationId osv2-codex-r1, job 4e05da10-e976-457a-8cf8-611500f706f3; verified GHSA fix lines, getRequestListener retained + SDK import, ajv->fast-uri wiring, baseline<->lock<->registry integrity match, exact acceptedVersions, maintainer continuity, scope. Exa/live-registry unreachable so registry provenance via committed lock/baseline/report; GHSA advisory pages verified.)
- grok: APPROVED_UNCONDITIONALLY (r1; correlationId osv2-grok-r1, job f3b82683-12a3-4ed5-a509-49c5543a9cd6; full-access: ran npm audit + supply-chain:scan:check + build + npm ls + live npm view + OSV/GHSA; OSV empty for pinned 2.0.11/3.1.4, integrity triples match, maintainers continuous, scope limited to the 2 packages; zero findings.)
- mistral: APPROVED_UNCONDITIONALLY (r3; correlationId osv2-mistral-r3, job 3fe00c92-b0f7-4fed-8f15-73493d128f2c; local-tree: git diff scope, installed 2.0.11/3.1.4, no upgradeWebSocket in src, baseline<->lock match, exact acceptedVersions. scan/audit exit codes marked unverified - independently run green by Grok + author. r1/r2 hung on a transient Vibe environmental stall; r3 lean-prompt completed.)
