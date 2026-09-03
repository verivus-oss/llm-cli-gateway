# review log, 2026-09-03 production closure change

This review was measured against implementation commit `d64ba20` plus the
candidate ledger and baseline changes recorded beside this file. All provider
work ran through the local gateway. Raw output pagination was used when needed,
and every accepted job reported `outputTruncated: false`.

## Exact versions accepted

- `fast-uri` 3.1.7
- `hasown` 2.0.4
- `qs` 6.16.0
- `side-channel` 1.1.1

## Corrective review trail

The first proposed fast-uri pin was 3.1.6. Codex job
`1e91d558-c69f-4a4f-bdc4-92b19a8f73dd` and Grok job
`0d7d9356-cbf8-4115-8cec-41b307364955` independently returned
`CHANGES_REQUIRED`. They found `GHSA-qw65-cvwx-89v3`, which affects the 3.x
line below 3.1.7, and `GHSA-58mr-gqgx-xq4g`, which affects exactly 3.1.6.
Those vendor advisories had not yet appeared in the npm audit and OSV results
used by the local gates.

The candidate was changed to 3.1.7. Its registry identity, signatures, tarball,
gitHead, signed tags, publisher, license and runtime behavior were checked
again. Reproductions confirmed the corrected port and IP-literal rejection
behavior. The host release-age default was explicitly overridden only after
that exact artifact review because the older eligible releases remained
vulnerable.

## Accepted provider verdicts

- Codex job `e9667d48-7ed8-4438-97ae-3f42580f99ea`:
  `APPROVED_UNCONDITIONALLY` for all four exact versions
- Grok job `b0efa0e3-eea6-49a7-882b-3c4d9ecd904f`:
  `APPROVED_UNCONDITIONALLY` for all four exact versions
- Mistral job `9dce7ffa-fa50-4fe3-84ce-bb9ad4872257`:
  `APPROVED_UNCONDITIONALLY` for fast-uri 3.1.7
- Mistral job `6f6ff239-83e3-4fd7-91c9-279922549140`:
  `APPROVED_UNCONDITIONALLY` for the unchanged hasown, qs and side-channel
  candidates

One additional Mistral response was excluded because the gateway reported a
review-integrity tool-suppression violation. It is not part of the unanimity
claim.

## Gate evidence

Before ledger acceptance, the frozen supply-chain gate returned exit 3 with 90
clean instances and exactly four findings, one for each accepted version. After
the append-only ledger update and four-instance baseline refresh, it returned
exit 0 with 94 clean instances.

`npm run security:audit` passed. The full `npm run check` also passed, including
327 Vitest files and 4,881 tests. The check does not cover the Postgres suite or
the CI-only gitleaks and typos jobs. Those remain release-candidate gates after
the remaining handover branches are integrated.
