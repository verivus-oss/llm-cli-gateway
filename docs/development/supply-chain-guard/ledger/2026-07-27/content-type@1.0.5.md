# contract: content-type@1.0.5

- class: roll-forward (ledgered name `content-type`, already-accepted version 1.0.5 re-entering the closure at two new paths)
- paths:
  - `node_modules/@modelcontextprotocol/sdk/node_modules/content-type`
  - `node_modules/express/node_modules/content-type`
- trigger: removal of the redundant `content-type: "2.0.0"` entry from `package.json#overrides`.

## what changed and why

`content-type 2.0.0` was added to `overrides` on 2026-07-21 (commit 048eec6) for a
single reason: `body-parser` was pinned to 2.3.0 to clear
GHSA-v422-hmwv-36x6 / CVE-2026-12590, and body-parser 2.3.0 hard-requires
`content-type ^2.0.0` and `type-is ^2.1.0`, both of which were on the deliberate
release-audit blocklist at the time. Un-blocking them was correct.

The **override** was not needed to achieve that. `body-parser@2.3.0` declares
`content-type ^2.0.0` itself, so npm satisfies it natively: it hoists 2.0.0 to
the root for body-parser/type-is and nests 1.0.5 under the two dependents that
declare `^1.0.5`. Verified by removing the override and re-resolving:

```
node_modules/content-type                                    -> 2.0.0   (body-parser, type-is)
node_modules/@modelcontextprotocol/sdk/node_modules/...      -> 1.0.5   (declares ^1.0.5)
node_modules/express/node_modules/content-type               -> 1.0.5   (declares ^1.0.5)
```

As a **global** override it additionally forced 2.0.0 onto
`@modelcontextprotocol/sdk@1.29.0` and `express@5.2.1`, which both declare
`^1.0.5`. That is a major-version substitution neither package declares support
for, and it is what produced the `invalid: content-type@2.0.0` marker in
consumer `npm ls` trees (consumers do not inherit a dependency's `overrides`).

### the substitution was not behaviour-neutral

content-type 2.0.0 is a documented behavioural rewrite, not a compatible bump.
Upstream release note: *"Rewrite package to be 3x faster and support lenient
parsing. No longer errors during `parse`, so you must validate things like
`type` after parsing before using it blindly."* Measured directly against both
installed copies:

| input | 1.0.5 | 2.0.0 |
|---|---|---|
| `"garbage"` | throws `invalid media type` | returns `{type:"garbage"}` |
| `""` | throws `argument string is required` | returns `{type:""}` |
| `"!!!not a type!!!"` | throws `invalid media type` | returns `{type:"!!!not a type!!!"}` |
| `"application/json; charset=utf-8; charset=iso-8859-1"` | `charset=iso-8859-1` (last wins) | `charset=utf-8` (first wins) |

Two distinct changes: throw-on-invalid became lenient-accept, and
duplicate-parameter precedence inverted.

Reachability, stated precisely rather than maximally:

- The throw/lenient change is **defended** at the SDK's call site
  (`dist/esm/server/sse.js:106`): it parses `req.headers['content-type'] ?? ''`
  inside a `try`, then explicitly rejects `ct.type !== 'application/json'`, so
  the outcome is a 400 under either major.
- The **precedence inversion is undefended**. The same call site passes
  `ct.parameters.charset` to `getRawBody` as the request-body decode encoding,
  so one duplicated-parameter header decodes the body as `iso-8859-1` under
  1.0.5 and `utf-8` under 2.0.0. That is a parser-differential in
  attacker-influenced input.
- `express@5.2.1` uses it in `lib/utils.js:231` (`setCharset`), which takes the
  application's own content type rather than request input, so the exposure
  there is low.

This gateway does not use the SDK's SSE transport (`src/http-transport.ts` uses
`StreamableHTTPServerTransport`), so no live exploitation path against this
package is claimed. The point is narrower and sufficient: the override imposed
untested major-version semantics on two HTTP-parsing dependencies for no benefit,
and removing it restores each to the major it declares and was tested against.

## advisory research (exa + deps.dev + npm registry + upstream releases)

- latest npm version: `content-type@2.0.0` is latest overall; `1.0.5` is the
  latest of the 1.x line (published 2023-01-29). Both remain published and
  installable.
- GHSA/OSV advisory: **none for either version.** deps.dev for
  `npm/content-type/1.0.5` reports "No advisories detected"; `npm audit
  --omit=dev --audit-level=moderate` on the resolved tree reports 0
  vulnerabilities. 1.0.5 is not a downgrade past any advisory, because no
  advisory exists on this package in either major.
- provenance/maintainer: MIT, jshttp org, **zero runtime dependencies** in both
  majors (so admitting 1.0.5 adds no transitive surface). 1.0.5 published by
  `dougwilson`, the long-standing jshttp maintainer; 2.0.0 published by
  `blakeembrey`. No maintainer anomaly: 1.0.5 is the older, more conservative
  artifact by the established maintainer, unchanged on the registry since 2023.
- install-time behaviour: 1.0.5 declares no lifecycle scripts at all. (2.0.0's
  only script is `prepare`, which npm does not run for a registry dependency
  install; noted in the 2026-07-21 contract and unchanged.)
- integrity: both instances resolve from `registry.npmjs.org` with matching
  integrity in the committed lock; no source anomaly, no integrity mismatch.

## upgrade decision

- safe-to-upgrade: **YES** (admit `content-type@1.0.5` at the two nested paths)
- rationale: 1.0.5 is already in `acceptedVersions` for this name, carries no
  advisory, has zero dependencies and no install scripts, and is precisely the
  range `@modelcontextprotocol/sdk` and `express` declare and were tested
  against. `content-type@2.0.0` is retained where it is genuinely required
  (`body-parser@2.3.0`, `type-is@2.1.0`), so the advisory fix that motivated the
  original pin is fully preserved. Net effect is strictly a reduction in
  unreviewed behavioural substitution. No `acceptedVersions` change is needed;
  this is a baseline refresh only.

## commands (resolved tree, recorded separately from reviewer verdicts)

- `npm run build`: PASS (tsc clean)
- `npm test` (full suite): PASS (3876 tests, 253 files; master baseline 3864,
  +12 from the new `check-consumer-tree.test.mjs`)
- `npm audit --omit=dev --audit-level=moderate`: PASS (0 vulnerabilities)
- `npm run supply-chain:scan:check` (--frozen gate): exit 2 pre-refresh, listing
  exactly the two `content-type@1.0.5` roll-forward instances and nothing else
  (92 clean, 0 tag-along, 0 source-anomaly, 0 integrity-mismatch, 0 dropped);
  PASS exit 0 after the baseline refresh.
- `npm run check` (full release gate): PASS
- `bash scripts/verify-registry-install.sh` (verdaccio registry fidelity): the
  `invalid: content-type@2.0.0` consumer marker is gone; confirmed against a
  real registry consumer install.

## cross-LLM validation (gtwy; independent sessions)

Four rounds. The dependency decision itself (this contract) was never contested;
every round-over-round change was to the release-gate code that shipped
alongside it, so each round invalidated the previous verdicts.

- **codex**: r1 did not converge (>310 KB output on a broad prompt, cancelled,
  no verdict; re-scoped narrowly thereafter). r2 `CHANGES_REQUIRED` (job
  2e0c73be, correlationId hono-override-codex-r2): found a fail-open where
  `pathToFileURL(argv[1])` preserves symlinks while node canonicalizes
  `import.meta.url`, so `node /proc/self/cwd/scripts/check-consumer-tree.mjs`
  exited 0 having classified nothing. Reproduced by the author and fixed in
  abc7789. r3 `CHANGES_REQUIRED` (correlationId hono-override-codex-r3): found
  the `NODE_OPTIONS=--import` preload forgery. Reproduced and fixed in a74e9d4.
  **Codex dissented twice and was right both times.**
- **grok**: r1 `APPROVED_UNCONDITIONALLY` (job c3ac5008) with genuinely
  independent verification: it re-ran the override-removal experiment, queried
  OSV, diffed the published tarballs, and independently confirmed the stale-GHSA
  finding. Its reasoning trace also raised the entry-point comparison but it did
  not file that as a finding and approved anyway. r3 `CHANGES_REQUIRED`
  (correlationId hono-override-grok-r3): independently reproduced the
  NODE_OPTIONS forgery with `--require`, and additionally found that the shell
  marker test was a substring glob accepting `CONSUMER_TREE_CHECK_OKAY`. Both
  fixed in 64cfe1a. It also re-confirmed C1 to C7 by experiment.
- **mistral**: r1 and r2 `APPROVED_UNCONDITIONALLY`, r3 `APPROVED_UNCONDITIONALLY`.
  Treated as **incomplete, not as approval**, per the runbook's rule that an
  unavailable research path leaves validation incomplete. In r2 and r3 it
  asserted "No other fail-open paths remain" while codex was reproducing one in
  the same round, and in r3 it reported that it could not execute `node`, `git`
  or `vitest` at all ("Tool execution not permitted"), so its verdict rests on
  static reading rather than the verification commands it was asked to run.

Author-side verification, recorded because it is what actually settled the
disputes rather than the vote count: every reviewer finding above was
reproduced locally before being accepted, and every fix was confirmed by
reverting it and watching the tests fail. Two defects were found by the release
gate itself rather than by any reviewer (the nesting-sensitive `invalid` string,
and the original blocker).
