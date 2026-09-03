# contract: fast-uri@3.1.7

- class: tag-along-unaccepted-version
- resolved move: `fast-uri` 3.1.5 -> 3.1.7
- resolved location: `node_modules/fast-uri`
- measured implementation: commit `d64ba20`

## identity and artifact

- npm source: `registry.npmjs.org`
- tarball: `fast-uri-3.1.7.tgz`
- integrity: `sha512-dOvZVzjdZdz7phd9v6jCbwxrBW3fK6n8Rc0CtdmM4bumzMnxywBYhuph6J819RRw/ku+rLbelwfMunktuzVVHg==`
- gitHead: `412e40abd4eb8beabfb952d80abf949a2baf27a3`
- publisher and maintainer set: the established Fastify maintainers
- license: BSD-3-Clause
- runtime dependencies: none
- consumer install hooks: none

Registry signatures, SRI, gitHead, publisher, repository, license, dependency
shape and published tarball contents were independently checked. Package scripts
are development and release scripts only. None is a preinstall, install or
postinstall hook for consumers.

## advisory research

The first candidate was 3.1.6. Codex and Grok rejected it after finding two
newer high-severity vendor advisories that had not yet reached the npm audit and
OSV feeds used by the local gates:

- `GHSA-qw65-cvwx-89v3`, affecting the 3.x line below 3.1.7
- `GHSA-58mr-gqgx-xq4g`, a regression affecting exactly 3.1.6

Version 3.1.7 clears those findings as well as the four advisories addressed by
3.1.6. Independent reproductions confirmed that 3.1.7 rejects nondigit
object-form ports and malformed IP-literal brackets. The exact artifact was
then reviewed again by all three required providers.

The host's package release-age default was explicitly overridden for this exact
version. Every older eligible 3.x version remained vulnerable, while the
3.1.7 artifact had passed identity, contents, signature and behavior review.

## upgrade decision

- safe-to-upgrade: YES
- rationale: This is the first reviewed 3.x version that clears all known
  findings. It retains the established publisher, repository, license and
  dependency-free runtime shape. The root override is exact and remains within
  AJV's declared `^3.0.1` range.

## verification

The resolved tree and implementation were measured against commit `d64ba20`.
The ledger append and refreshed baseline were candidate changes over that
commit. Immediately before the full check, the only other working-tree entry
was the pre-existing untracked design draft.

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
  `9dce7ffa-fa50-4fe3-84ce-bb9ad4872257`

The corrective trail is intentional. Codex job
`1e91d558-c69f-4a4f-bdc4-92b19a8f73dd` and Grok job
`0d7d9356-cbf8-4115-8cec-41b307364955` both returned `CHANGES_REQUIRED` for
3.1.6. Acceptance occurred only after moving to 3.1.7 and obtaining fresh,
unconditional approval. The accepted review outputs reported no truncation.
