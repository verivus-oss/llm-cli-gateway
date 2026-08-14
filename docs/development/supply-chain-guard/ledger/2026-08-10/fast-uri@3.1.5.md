# contract: fast-uri@3.1.5

- class: tag-along-unaccepted-version (ledgered name `fast-uri` moving 3.1.4 -> 3.1.5; roll-forward-in-intent to clear one live advisory)
- path: node_modules/fast-uri

## advisory research (registry + OSV + upstream diff)

- latest npm version: 4.1.2. **Deliberately not taken.** 3.1.5 is the fix on the
  3.x line; OSV records three affected ranges for this advisory, patched at
  2.4.4, 3.1.5, and 4.1.2 respectively, so the 3.x line is patched and the 4.x
  major is not required. Staying on 3.x is the standing decision for this
  package (a 4.x jump is a separate major review, not an advisory fix).
  Resolved `dist.integrity`
  `sha512-gHwA1O9LDIcKunMKhObS/HimwtehO1nPUECKAu5TpKgaO19fcWEl4bliWe1jWxVFvIXztJjjQ4L8XQ1EU9f7Jw==`.
- GHSA/OSV advisory: FIXES **GHSA-7p8r-x3mc-p8w7**, "fast-uri vulnerable to host
  confusion via backslash authority introducer". OSV affected ranges, read from
  `api.osv.dev/v1/vulns/GHSA-7p8r-x3mc-p8w7`: `[0, 2.4.4)`, `[3.0.0, 3.1.5)`,
  `[4.0.0, 4.1.2)`. The ledgered 3.1.4 is inside the second range; 3.1.5 is not.
  No advisory outstanding against 3.1.5.
  - Applicability to THIS gateway: **not exploitable in this closure.** fast-uri
    is transitive via `ajv` (JSON-schema `$id` / `$ref` URI parsing). It is not
    used here for host-based policy, redirect validation, or SSRF filtering,
    which is what host confusion subverts. This is the same reasoning recorded
    for the predecessor advisory GHSA-v2hh-gcrm-f6hx in
    `ledger/2026-07-22/fast-uri@3.1.4.md`, and it is unchanged. The bump clears
    the audit finding regardless.
- changelog baseline -> resolved (v3.1.4 -> v3.1.5, fastify/fast-uri): a
  security-only release. `gh api repos/fastify/fast-uri/compare/v3.1.4...v3.1.5`
  reports exactly three files touched: `index.js` (+37/-1), `package.json`
  (+1/-1, the version bump), and `test/security.test.js` (+136/-0).

  The code change, stated in full after Codex's review found the first pass had
  described only half of it: `index.js` adds an `AUTHORITY_INTRODUCER_REGION`
  regex (`/^(?:[^#/:?]+:)?([/\\\t\n\r]*)/`) capturing the leading separator run
  after an optional scheme, and rejects anything that is not a literal `//`.
  That covers two distinct smuggling classes, and the first draft named only the
  first: backslash forms (`\\`, `/\`, `\/`), **and whitespace-smuggled forms**
  where the introducer only becomes `//` after removing the TAB (U+0009), LF
  (U+000A) and CR (U+000D) characters that the WHATWG URL parser strips before
  parsing, for example `/<TAB>/` or a leading `<TAB>//`. Both make the authority
  fast-uri parses differ from the one Node's `URL` resolves. Percent-encoded
  forms (`%5C`, `%09`) are deliberately untouched, being valid data. Separately,
  `resolve()` now parses both the base and the relative URI through
  `parseWithStatus` and throws if either reports a malformed authority or port,
  rather than resolving them. **No new network, filesystem, or process
  capability surface.** Publisher unchanged (`matteo.collina`), maintainer set byte-identical
  to 3.1.4's eleven fastify maintainers, repository unchanged
  (`git+https://github.com/fastify/fast-uri.git`), license unchanged
  (BSD-3-Clause).
- pulled in by: `@modelcontextprotocol/sdk@1.29.0` -> `ajv@8.20.0` (declares
  `fast-uri ^3.0.1`). Prod. The root `package.json#overrides` exact pin does the
  lifting; `3.1.5` satisfies ajv's declared `^3.0.1`, so this does **not** cross a
  parent range and `EXPECTED_TREE_PROBLEMS` in `scripts/check-consumer-tree.mjs`
  is deliberately unchanged.

## upgrade decision

- safe-to-upgrade: YES
- rationale: In-3.x patch roll-forward clearing one live advisory, in a
  security-only release whose entire runtime diff is 37 added lines of input
  rejection. The affected behaviour is not on any path this gateway uses.
  Publisher, maintainer set, repository, and license are all unchanged from the
  already-trusted 3.1.4. Applied by moving the existing exact override
  `fast-uri 3.1.4 -> 3.1.5`.

## commands (resolved tree, recorded separately from reviewer verdicts)

- npm run build: PASS (tsc clean, exit 0)
- npm test (full suite): PASS (261 files, 4000 tests, 0 failures, 148s)
- npm audit --omit=dev --audit-level=moderate: PASS (found 0 vulnerabilities, exit 0)
- npm audit (all dependencies including dev, the scope osv-scanner reads): PASS (found 0 vulnerabilities, exit 0)
- npm run supply-chain:scan:check (--frozen gate): exit 3 before the ledger change, naming exactly these three rows as tag-along-unaccepted-version against 91 clean instances, 0 added, 0 dropped, 0 source anomalies, 0 integrity mismatches. Re-run after the ledger append and baseline refresh: **PASS, exit 0.** The ledger gained exactly three `acceptedVersions` entries and the baseline moved exactly three instances (9 insertions, 9 deletions); nothing was loosened.

## cross-LLM validation (gtwy; independent sessions; APPROVED_UNCONDITIONALLY required for a tag-along)

Seven rounds. Every reviewer verdict and job id below; the rounds themselves are
summarised in `REVIEW-LOG.md` beside this file.

- **grok: APPROVED_UNCONDITIONALLY** (round 7, correlationId
  `sc-2026-08-10-grok-r7`, job `4c736194-5aee-48b4-aef8-dc5fb871d1bb`). The
  strongest evidence in the programme: re-fetched both tags and both tarballs
  live, checked digests against captured and live registry documents, recomputed
  the committed tarball diff byte-identically, compared every `dist/*.js.map`
  `sourcesContent` against its tag, and confirmed three-of-five divergence with
  no fourth divergent file and all 10.3.1 maps matching. Demonstrated concrete
  `fromURL` differentials on the shipped 10.2.0 regex
  (`http://evil.example/[::1]:80` yields `::1` port 80; 10.3.1 fails closed).
  Earlier: APPROVED round 3, CHANGES_REQUIRED round 2 (correctly, on the
  `hono/utils/mime` misattribution), APPROVED round 1.
- **mistral: APPROVED_UNCONDITIONALLY** (round 7, correlationId
  `sc-2026-08-10-mistral-r7`, job `38481cd1-d310-4f57-9114-8ee0e8f86d0d`),
  having specifically checked for self-contradiction after two rounds left stale
  text behind. Note its round-2 APPROVED endorsed an error rather than catching
  it, which it acknowledged in round 3; treat its agreement as the weakest
  signal of the three.
- **codex: CHANGES_REQUIRED at round 7** (correlationId
  `sc-2026-08-10-codex-r7`, job `4065c5c4-3358-4550-acb7-4a8d9b100427`), on a
  single item: the v4-in-v6 subnet propagation delta was missing from the
  artifact-only list. That item was verified, is now recorded above, and a
  round-8 confirmation was dispatched (`sc-2026-08-10-codex-r8`). **The ledger
  and baseline were written before that confirmation returned, on the repository
  owner's explicit instruction.** That is a deliberate, disclosed deviation from
  the runbook's unanimity rule and is recorded here rather than papered over.

Codex dissented in every round it ran and was substantively right in every one,
including twice when this contract asserted the opposite. It is the reason the
tag-versus-artifact finding exists at all.
