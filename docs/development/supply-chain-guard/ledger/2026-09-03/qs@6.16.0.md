# contract: qs@6.16.0

- class: tag-along-unaccepted-version
- resolved move: `qs` 6.15.2 -> 6.16.0
- resolved location: `node_modules/qs`
- measured implementation: commit `d64ba20`

## identity and artifact

- npm source: `registry.npmjs.org`
- tarball: `qs-6.16.0.tgz`
- integrity: `sha512-h6fhOIaRrID2CbEY2fqs+7t+UXZo+MLAnU5gRIq85uFtdiUPCdsApMlHhXogKVM4HM2DVbIjGNTTYH2OcmP1vA==`
- gitHead: `bb9379e01fad04c601478acd6152143cb20c984b`
- publisher and maintainers: unchanged from 6.15.2
- license: BSD-3-Clause
- runtime dependencies: `es-define-property ^1.0.1` and
  `side-channel ^1.1.1`
- consumer install hooks: none

The added dependency edge and updated side-channel edge resolve to exact
versions separately accepted in this production closure. Package scripts are
development, test, build and release tasks only. None is a preinstall, install
or postinstall hook for consumers.

## advisory research and upgrade decision

Version 6.16.0 clears `GHSA-4mjr-xmp4-gh2g` and
`GHSA-x5fp-wj9c-mxmx`. Its runtime changes add parser and serializer hardening
without adding filesystem, network or process capabilities.

- safe-to-upgrade: YES
- rationale: The release clears the known findings, stays on the established
  package line, preserves publisher and license identity, and resolves every
  runtime edge to a separately accepted exact closure version.

## verification

The resolved tree and implementation were measured against commit `d64ba20`.
The ledger append and refreshed baseline were candidate changes over that
commit.

- frozen supply-chain gate before acceptance: exit 3, with 90 clean instances
  and exactly four `tag-along-unaccepted-version` findings
- frozen supply-chain gate after acceptance and baseline refresh: PASS, exit 0,
  with 94 clean instances
- `npm run security:audit`: PASS
- `npm run check`: PASS, including 327 Vitest files and 4,881 tests

The full check does not run the Postgres suite or the CI-only gitleaks and typos
jobs. Those remain release-candidate gates after branch integration.

## cross-LLM validation

- Codex: `APPROVED_UNCONDITIONALLY`, job
  `e9667d48-7ed8-4438-97ae-3f42580f99ea`
- Grok: `APPROVED_UNCONDITIONALLY`, job
  `b0efa0e3-eea6-49a7-882b-3c4d9ecd904f`
- Mistral: `APPROVED_UNCONDITIONALLY`, job
  `6f6ff239-83e3-4fd7-91c9-279922549140`

The accepted review outputs reported no truncation.
