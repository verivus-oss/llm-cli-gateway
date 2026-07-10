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
roll-forward/dropped, `3` tag-along / source anomaly / integrity mismatch, `1`
tool error. If clean, stop; otherwise triage every flagged row.

### 2. Research each actionable package with exa

For each drifted package: latest npm version; any GHSA/OSV advisory (exa is the
authoritative current check; `osv-scanner` pre-screens known ones); for a
roll-forward, the changelog baseline -> resolved (no new capability, no
maintainer change); for a tag-along, `npm ls <pkg>` (who pulled it in), the
license, and a full first-time trust review.

### 3. Decide + fill the contract

Fill each generated `contracts/<pkg>.md`: `safe-to-upgrade: YES/NO` + rationale;
run `npm run build && npm test && npm run security:audit` and record PASS/FAIL.

### 4. Cross-LLM validation (mandatory, independent)

Before any ledger change, dispatch via the `gtwy` MCP to codex + grok + mistral,
each `createNewSession: true`, read-only, verifying the classification and
safe-to-upgrade calls **against npm / advisory DBs / changelogs directly**, not
your summary. codex sandbox read-only; mistral `permissionMode: auto-approve`
(its `plan` mode blocks reads); grok high effort. A tag-along needs unanimous
approval. Record each verdict + job id in the contract.

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

- Rubber-stamping a tag-along (full review + unanimous cross-LLM approval, or out).
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
