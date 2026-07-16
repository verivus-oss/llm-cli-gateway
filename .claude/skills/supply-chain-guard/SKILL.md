---
name: supply-chain-guard
description: Resolve prod-closure dependency drift safely and catch tag-along dependencies. Reproduces the release-gate scan (supply-chain:scan:check), classifies each path-keyed prod INSTANCE as clean / roll-forward / tag-along / source-anomaly / integrity-mismatch / dropped against a committed ledger + baseline, researches advisories with exa, gets independent cross-LLM validation, and writes per-dependency contracts before any ledger change. Use when release-security-audit.sh fails with a supply-chain verdict (exit 2 or 3), to sweep drift before cutting a release, or to audit whether a new package slipped into the prod tree.
metadata:
  author: verivus-oss
  version: "1.0"
---

# /supply-chain-guard

Canonical process: `docs/development/supply-chain-guard/RUNBOOK.md`. Read it once
at the start of any session that uses this skill; everything below is a condensed
walkthrough and the runbook is the source of truth. Spec:
`docs/plans/supply-chain-guard.draft.md`.

## The problem this solves

The release gate is blocklist + invariants (`npm audit`, `osv-scanner`, the
version blocklist, `socket.yml`) with no name/instance allowlist, so a new
transitive package with no CVE enters the prod closure silently. This guard adds
the allowlist layer: a committed ledger (`supply-chain/prod-closure.ledger.json`,
per-name exact `acceptedVersions`) + instance baseline
(`prod-closure.baseline.json`), and a scanner that fails the release when the
shipped closure diverges from the reviewed baseline.

Not every drift is equal. A **roll-forward** (a ledgered name at a new accepted
version) is low-risk but still blocks the exit-0 gate until the baseline is
refreshed. A **tag-along** (a name not in the ledger, an unaccepted version, or a
name absent from the baseline) needs a real review. Never rubber-stamp a
tag-along.

## When to invoke

- `npm run security:audit` / CI failed with `[supply-chain-guard] verdict exit 2|3`.
- You want to sweep drift before cutting a release.
- You want to confirm no new package slipped into the prod tree.

## Stages, and your responsibilities

### 1. Scan

```bash
npm run supply-chain:scan          # local/advisory (temp-copy fresh resolve; tolerates exit 2)
# or reproduce the gate exactly:
npm run supply-chain:scan:check    # --frozen, requires exit 0 (what CI runs)
```

Read `report.md` under `.supply-chain/scan-<ts>/`. Exit `0` clean, `2`
roll-forward/dropped, `3` tag-along / source anomaly / integrity mismatch /
reused-invariant failure (forbidden native-tar chain, blocked version,
fetch-in-dist) / P2 license-violation (non-allowlisted or missing SPDX license) /
P2 socket-policy-drift (a `socket.yml` issueRule changed from its reviewed value),
`1` tool error. If clean, stop; otherwise triage every flagged row.

### 2. Research each actionable package

Use exa as a search/research aid, not as the authority. Verify current package
facts against the npm registry/package publisher, GHSA/OSV advisory records, and
the relevant vendor changelog or repository. `osv-scanner` pre-screens known
advisories but does not replace that research. For each drifted package, record
the latest npm version and advisories; for a roll-forward, compare the changelog
baseline to resolved version; for a tag-along, run `npm ls <pkg>`, inspect the
license, and perform a first-time trust review.

### 3. Decide + fill the contract

Fill each generated `contracts/<pkg>.md`: `safe-to-upgrade: YES/NO` + rationale;
run `npm run build && npm test && npm run security:audit` and record each
command result separately from the reviewer verdict.

### 4. Cross-LLM validation (mandatory, independent)

Dispatch only through the installed local stdio `gtwy` MCP surface
(`mcp__gtwy__*` or the client-rendered equivalent), never a direct provider
binary, SDK, connector/shadow gateway, or shell fallback. The supply-chain
runbook's explicit selected roster is Codex, Grok, and Mistral. It is a
purpose-specific minimum, not a claim that those three are a universal
seven-provider review.

Before any ledger change, call `provider_tool_capabilities` for each selected
reviewer and confirm that its configured native tools can reach the required
research sources. Then create an independent session for each selected reviewer
and require it to verify the classification and safe-to-upgrade call against
npm, advisory databases, and changelogs, not merely the summary. If a reviewer
cannot access a required source, preserve that research gap, repair the
configuration or provide independently verifiable source provenance, and keep
the validation incomplete until it can return an evidence-backed verdict.
Use Codex's read-only sandbox for inspection; Mistral's programmatic legacy
default is `permissionMode:"accept-edits"`, so retain an explicit no-mutation
instruction; and use only Grok controls confirmed by
`provider_tool_capabilities`. All three use `approvalStrategy:"legacy"` and
omit `approvalPolicy`: `mcp_managed` is Claude-only.

Do not impose a review-round, turn, token, price, budget, or wallclock cap. A
tag-along requires `APPROVED_UNCONDITIONALLY` from every reviewer in the
selected roster. Every review prompt must require exactly one terminal JSON
verdict: `APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED`, or
`BLOCKED_EXTERNAL`. A conditional, malformed, timed-out, or unavailable
reviewer makes the validation incomplete: repair/retry it or hold the ledger
change and report `BLOCKED_EXTERNAL` with its exact error. Record each verdict
and job ID in the contract. `CHANGES_REQUIRED` must contain independent source
evidence and cannot be treated as approval.

### Explicit user-authorized full-access review

When the user explicitly grants full provider permissions and native MCP access
for this validation, follow the canonical `multi-llm-review` full-access
protocol. Build the target checkout and start a fresh local
`node dist/index.js --transport=stdio` process from it; do not use a globally
installed or stale gateway. Reapply provider-native full-access controls on
every new job, preserve ambient native MCP configuration, and do not construct
a pretend gateway allowlist.

Give each reviewer the verification report as a corrective-program
specification, exact base and diff or exhaustive changed-file list, relevant
untracked files, and durable raw evidence. Require independent verification of
the repository, package metadata, registry data, advisories, changelogs, docs,
tests, commands, and available MCP facts. A reviewer must not approve from the
report alone. A disagreement needs code, package, advisory, documentation,
test, or command evidence, not assertion. Retain the purpose-specific Codex,
Grok, and Mistral roster only when the user explicitly scopes this supply-chain
gate to it; otherwise the canonical exhaustive protocol requires all seven CLI
providers. Do not set caller review caps. On a user-required 90-second cadence,
make non-blocking progress checks no more frequently than every 90 seconds.

### 5. Write the ledger + refresh the baseline

Append the newly accepted EXACT version to that name's `acceptedVersions` (never
a range: exit 1). For a dropped name, `state: "revoked"` once all instances are
gone. Regenerate the baseline so it matches the tree the next release ships;
that is what turns exit 2 into exit 0.

### 6. Ledger audit trail

Copy the filled contracts to
`docs/development/supply-chain-guard/ledger/<YYYY-MM-DD>/<pkg>.md`, commit with
the ledger change, land on `master` via PR (`build(supply-chain):` /
`fix(supply-chain):`).

## Anti-patterns to refuse

- Rubber-stamping a tag-along (full review plus explicit
  `APPROVED_UNCONDITIONALLY` from the required roster, or out).
- Skipping the advisory sweep "because it's just a patch."
- Writing a ledger change before cross-LLM validation (steps 2 to 4 first).
- Accepting a reviewer verdict without cited evidence.
- Deleting ledger entries to "clean up" (only prune `dropped` after `revoked`).
- Treating a local fresh-resolve sweep as the authoritative gate (the gate is
  `--frozen`); accepting a roll-forward without refreshing the baseline.

## Quick links

- Runbook: `docs/development/supply-chain-guard/RUNBOOK.md`
- Tool: `scripts/supply-chain/dep-drift-scan.mjs` (tests: `dep-drift-scan.test.mjs`)
- Ledger + baseline: `supply-chain/prod-closure.{ledger,baseline}.json`
- Release gate: `scripts/release-security-audit.sh`
- Proactive upgrades: Dependabot (`.github/dependabot.yml`)
