# contract: @hono/node-server@2.0.11 (consumer-tree pin re-review)

- class: reviewed-pin re-review (not a prod-closure roll-forward). The pinned
  version does not change; what changed is upstream, and the consumer-tree gate
  that asserted the pin must be updated to match.
- path: node_modules/@hono/node-server (transitive, via @modelcontextprotocol/sdk)
- safe-to-keep-2.0.11: YES
- prod-closure ledger change: NONE (acceptedVersions for @hono/node-server keep 2.0.11).

## trigger

pre-release.sh registry-fidelity verification, assertion (d.1), failed:
`Reviewed security pin is NO LONGER reaching consumers: expected
@hono/node-server@2.0.11 pinned over "^1.19.9" from @modelcontextprotocol/sdk`.

## advisory research (registry + OSV + upstream)

- GHSA-frvp-7c67-39w9 (serve-static path traversal on Windows via encoded
  backslash `%5C`): affected `>= 2.0.0, < 2.0.5`, and a second range `< 1.19.15`;
  patched at 2.0.5 and 1.19.15. Sources: github.com/honojs/node-server security
  advisory, osv.dev/vulnerability/GHSA-frvp-7c67-39w9, the GitHub Advisory
  Database mirror. The pinned 2.0.11 is at or above the 2.0.5 patch line, so it
  is NOT affected.
- @hono/node-server published 2.x versions above the pin: 2.0.12, 2.1.0, 2.1.1
  (latest). All are >= 2.0.5, patched.

## what changed upstream

`@modelcontextprotocol/sdk@1.30.0` now declares `@hono/node-server` as
`^1.19.9 || ^2.0.5` (previously `^1.19.9` alone). The override pins exact 2.0.11,
which now SATISFIES the `^2.0.5` alternative, so npm resolves it as VALID and
emits no downstream `invalid` marker. The consumer-tree gate keyed on that
`invalid` marker, so with the marker gone the gate read the pin as `missing`.
This is precisely the EXIT CONDITION the checker's own header comment anticipated
("once ... the tree goes clean, both this override and this entry can be
deleted"), reached by the SDK widening its own range rather than by the advisory
mirror being corrected.

## decision

Keep the exact 2.0.11 override (the version this whole 3.2.1 cycle was tested
against; a patch release should not float @hono/node-server to an untested 2.1.x).
The shipped shrinkwrap pins 2.0.11 into consumers. The SDK's range does NOT on
its own guarantee safety (a claim an earlier draft of this contract and the
checker comment overstated, corrected after the codex cross-LLM review): the
`^1.19.9` alternative still admits vulnerable 1.19.x (< 1.19.15, GHSA-frvp) and
`^2.0.5` admits 2.0.5-2.0.9 (GHSA-9mqv, patched 2.0.10). The safety comes from
the override plus the positive consumer-tree assertion below, not the range.

Update `scripts/check-consumer-tree.mjs`:
- `EXPECTED_TREE_PROBLEMS` -> `[]` (the pin no longer surfaces as a reviewed
  `invalid` marker; nothing to require). The tripwire still rejects any
  UNEXPECTED `invalid` marker, so a new unreviewed override cannot enter silently.
- Add `REVIEWED_CONSUMER_VERSIONS` + `reviewedVersionProblems`: a POSITIVE
  assertion that replaces the retired `invalid`-marker proof. The consumer tree's
  @hono/node-server must resolve to the exact reviewed pin 2.0.11; an absent pin
  or a drift to a vulnerable in-range version (e.g. 1.19.14, which satisfies the
  SDK's `^1.19.9` and carries no `invalid` marker) is rejected. This closes the
  gap the codex reviewer found by differential test (empty list accepted 1.19.14
  where the prior invalid-marker check rejected it).
- Add an explicit structural fail-closed guard (`treeContainsSubject`): emptying
  the list removed the implicit guard by which a missing reviewed pin used to
  reject a degenerate `{}` / `[]` tree. The gate now fails closed when the tree
  does not contain `llm-cli-gateway`.
- The GHSA-frvp floor ratchet moves from the (now empty) reviewed list to the
  actual `package.json#overrides` pin, asserted directly in the test.

No change to `package.json#overrides`, `supply-chain/prod-closure.ledger.json`,
or `prod-closure.baseline.json`.

## verification (commands, recorded separately from the reviewer verdict)

- `npx vitest run scripts/check-consumer-tree.test.mjs`: 32 passed (classifier
  tests decoupled from the production list via an explicit sample; CLI
  fail-closed tests repointed to list-independent reject/pass scenarios; the
  floor ratchet reads package.json; new reviewedVersionProblems block plus a CLI
  end-to-end for the vulnerable-in-range rejection).
- End-to-end `node scripts/check-consumer-tree.mjs` on a realistic clean consumer
  tree (llm-cli-gateway -> sdk -> @hono/node-server 2.0.11, no `invalid`):
  CONSUMER_TREE_CHECK_OK, exit 0.
- End-to-end on a degenerate `{}` tree: fails closed, exit 1
  ("consumer tree does not contain llm-cli-gateway").
- End-to-end on a tree with @hono/node-server 1.19.14 (in-range, no `invalid`):
  fails closed, exit 1 ("is not the reviewed pin 2.0.11").
- `bash scripts/pre-release.sh`: recorded after cross-LLM validation.

## cross-LLM validation

Round 1 (commit c7c8237, EXPECTED_TREE_PROBLEMS empty + treeContainsSubject only):
grok (hns-pin-grok-01) and cursor (hns-pin-cursor-01) APPROVED_UNCONDITIONALLY;
codex (hns-pin-codex-01) CHANGES_REQUIRED, `security_not_weakened: false`, with a
differential: 1.19.14 satisfies the SDK's `^1.19.9`, carries no `invalid` marker,
and was accepted by the empty-list checker though the prior invalid-marker check
rejected it. Codex was correct; the positive REVIEWED_CONSUMER_VERSIONS assertion
above was added in response and the overclaim it flagged was corrected.

Round 2 (amended commit): job ids and terminal verdicts recorded here after
re-dispatch.
