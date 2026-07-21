# contract: body-parser@2.3.0

- class: tag-along-unaccepted-version (ledgered name body-parser moving 2.2.2 -> 2.3.0; roll-forward-in-intent to clear a live advisory)
- path: node_modules/body-parser

## advisory research (exa + GitHub advisory + release notes)
- latest npm version: 2.3.0 (current 2.x latest; dist.integrity sha512-2cGmJupaNgg+...). 1.20.6 is the parallel 1.x patched line.
- GHSA/OSV advisory: FIXES GHSA-v422-hmwv-36x6 / CVE-2026-12590 (published 2026-07-09). "body-parser vulnerable to denial of service when invalid limit value silently disables size enforcement." Affected: <1.20.6; >=2.0.0,<2.3.0. Patched: 1.20.6, 2.3.0. When limit is an unparseable string or NaN, bytes.parse() returned null and the size check was silently skipped. No advisory outstanding against 2.3.0 (it is the patched version). (CVE note: the canonical CVE for GHSA-v422-hmwv-36x6 is CVE-2026-12590 per the GHSA/OSV/NVD mapping; the upstream v2.3.0 release note mislinks it to a CVE-2025-13466 URL, which is actually the older GHSA-wqch-xfxh-vrr4 fixed in 2.2.1. Corrected per Grok cross-LLM finding.)
- changelog baseline -> resolved (v2.2.2 -> v2.3.0, expressjs/body-parser): the security fix is PR #698 "improve limit option validation" (throws a clear error at parser construction for invalid limit; null/undefined still fall back to the 100kb default, unchanged). Remainder is CI/dependabot bumps, ESM-compat (#697), payload-limit docs (#699), explicit "type":"commonjs" (#711), deps-to-latest (#733). No new network/FS/proc capability; maintainer/org unchanged (expressjs; released by UlisesGascon).
- pulled in by: @modelcontextprotocol/sdk@1.29.0 -> express@5.2.1 -> body-parser; also root direct pin (dependencies + overrides). Prod.

## upgrade decision
- safe-to-upgrade: YES
- rationale: Patch that clears a live DoS advisory affecting our pinned 2.2.2; behavior-preserving for all valid/absent limit values and fail-closed (throws) for invalid limit rather than silently disabling enforcement. Same trusted maintainer/registry source; body-parser already ledgered trusted since 2026-07-10. Applied via existing exact pin (dependencies + overrides 2.2.2 -> 2.3.0).

## commands (resolved tree, recorded separately from reviewer verdicts)
- npm run build: PASS (tsc clean)
- npm test: PASS (233 files, 3696 tests)
- npm run supply-chain:scan:check (--frozen gate): PASS exit 0 after ledger append (2.3.0) + baseline refresh
- npm run build + npm run security:audit: PASS (see PR CI)

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)
- Round 1: all three returned CHANGES_REQUIRED on ONE defect: advisory CVE mislabeled as CVE-2025-13466. Corrected to CVE-2026-12590 (GHSA-v422-hmwv-36x6; CVE-2025-13466 is the distinct GHSA-wqch-xfxh-vrr4 fixed in 2.2.1). Substance validated in round 1.
- codex: APPROVED_UNCONDITIONALLY (round 2; correlationId sc-val-codex-r2b, job 5c890869; cited GHSA/OSV/NVD + npm registry + PR #698)
- grok: APPROVED_UNCONDITIONALLY (round 2; correlationId sc-val-grok-r2, job f0f495b5)
- mistral: APPROVED_UNCONDITIONALLY (round 2; correlationId sc-val-mistral-r2b, job bf04dd12)
