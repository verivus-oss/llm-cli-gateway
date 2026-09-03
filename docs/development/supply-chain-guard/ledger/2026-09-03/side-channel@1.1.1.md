# contract: side-channel@1.1.1

- class: tag-along-unaccepted-version
- resolved move: `side-channel` 1.1.0 -> 1.1.1
- resolved location: `node_modules/side-channel`
- measured implementation: commit `d64ba20`

## identity and artifact

- npm source: `registry.npmjs.org`
- tarball: `side-channel-1.1.1.tgz`
- integrity: `sha512-6x6dK6zJdpTzF4sQeNYxwtvBzf6Eg4GtlesS94HOvTudUeyK2WXAaIfmDgsyslYrRBeFIlsi54AYsFGUuhmvrQ==`
- gitHead: `3d260956bc92a85f140352bd814dc5c9d31fc65a`
- publisher and maintainer: unchanged from 1.1.0
- license: MIT
- runtime dependencies: `es-errors ^1.3.0`, `object-inspect ^1.13.4`,
  `side-channel-list ^1.0.1`, `side-channel-map ^1.0.1` and
  `side-channel-weakmap ^1.0.2`
- consumer install hooks: none

The runtime change prevents `assert()` from observably inspecting object keys.
Dependency range changes resolve to accepted exact versions already present in
the production closure. Package scripts contain development and release tasks,
but no preinstall, install or postinstall hook for consumers.

## advisory research and upgrade decision

- current advisories: none found across the registry, vendor and local audit
  evidence examined by the reviewers
- safe-to-upgrade: YES
- rationale: The release removes an observable inspection side effect and
  retains the established publisher, license, dependencies and runtime
  capability surface.

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
