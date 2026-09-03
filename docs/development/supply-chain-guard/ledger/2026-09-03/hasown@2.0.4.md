# contract: hasown@2.0.4

- class: tag-along-unaccepted-version
- resolved move: `hasown` 2.0.3 -> 2.0.4
- resolved location: `node_modules/hasown`
- measured implementation: commit `d64ba20`

## identity and artifact

- npm source: `registry.npmjs.org`
- tarball: `hasown-2.0.4.tgz`
- integrity: `sha512-T2UbfbBEF32wiepXIsMlTW9+dDYC6wMh/t/vYA4tuOMKqWz/n3vr1NFSxQiyP+zk2mXsoMA/i/7qV6LKut1t1A==`
- gitHead: `97f3a857d30d06e4081626ea6e5e3c00023627ff`
- publisher and maintainers: unchanged from 2.0.3
- license: MIT
- runtime dependencies: `function-bind ^1.1.2`
- consumer install hooks: none

The runtime `index.js` is byte-identical to 2.0.3. The release removes a dead
TypeScript overload and updates development metadata. The publisher,
maintainers, license and sole runtime dependency are unchanged. Its package
scripts include development and release tasks, but no preinstall, install or
postinstall hook for consumers.

## advisory research and upgrade decision

- current advisories: none found across the registry, vendor and local audit
  evidence examined by the reviewers
- safe-to-upgrade: YES
- rationale: The shipped runtime is unchanged, the type cleanup narrows no live
  overload used by this gateway, and the established identity and capability
  surface are unchanged.

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
