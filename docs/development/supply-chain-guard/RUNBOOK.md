# supply-chain-guard runbook

Canonical process for the prod-closure **dependency drift** and **tag-along**
guard. This is the source of truth; the `/supply-chain-guard` skill
(`.claude/skills/supply-chain-guard/SKILL.md`) is a condensed walkthrough that
points here. Spec: `docs/plans/supply-chain-guard.draft.md`. DAG:
`docs/plans/supply-chain-guard.dag.toml`.

## Why the drift happens

`package.json` uses caret ranges and the release does a fresh `npm install`, so a
caret bump of any direct or transitive dependency can pull a new version, or a
brand-new package name, into the prod closure between releases. The existing
release gate (`npm audit`, `osv-scanner`, the version blocklist, `socket.yml`) is
blocklist + invariants with no name/instance allowlist, so a new package with no
CVE lands silently. This guard adds the allowlist layer.

## Two kinds of change, two levels of scrutiny

The scanner classifies each path-keyed prod **instance**
(`{path,name,version,resolved,integrity}`) against the committed baseline + ledger
(spec 4.3 decision table). Names are path-derived
(`meta.name ?? path.split(/node_modules\//).pop()`); the root `""` is excluded.

- **Roll-forward** (routine, exit 2): a ledgered name moved to another accepted
  version or a new path. Still a change: it must be researched and the baseline
  refreshed before it counts as clean. Confirm source/maintainer unchanged, no
  advisory landed.
- **Tag-along** (real review, exit 3): a name not in the ledger, an unaccepted
  version of a ledgered name, or a name absent from the baseline (`new_to_tree`).
  The case you must not rubber-stamp.
- **Source anomaly** (exit 3): a non-`registry.npmjs.org` `resolved` (git/http/
  file), surfaced even for a ledgered name.
- **Integrity mismatch** (exit 3): a `name@version` matching the baseline but with
  a different `integrity` (registry-immutability break / lock tampering).
- **Dropped** (exit 2): a baseline instance whose `path` left the closure. Blocks
  until the baseline is pruned; the ledger name is revoked only when ALL its
  instances are gone.

## The tool

`scripts/supply-chain/dep-drift-scan.mjs` (npm scripts below). It only writes to
the ledger/baseline under the explicit `--seed` mode; every other mode reads and
classifies without touching the ledger, baseline, or working tree.

```bash
npm run supply-chain:scan          # local/advisory (fresh resolve in a temp copy; tolerates exit 2)
npm run supply-chain:scan:check    # gate form: --frozen, requires exit 0 (wired into security:audit)
npm run supply-chain:seed          # bootstrap: (re)write ledger + baseline from the committed lock
```

Exit codes: `0` clean, `2` roll-forward and/or dropped only (blocks the exit-0
gate), `3` tag-along / source anomaly / integrity mismatch / reused-invariant
failure, `1` tool error (e.g. a non-exact `acceptedVersions` entry). Outputs land
under the gitignored `.supply-chain/scan-<timestamp>/` (`report.json`,
`report.md`, `contracts/<pkg>.md` stubs).

**Modes**: `--frozen` scores the committed lock via the shared `prodFilter`
(the CI/gate mode, scores the tree the release ships); the default fresh-resolve
runs `npm install` in a throwaway temp copy and never touches the working tree.
`--closure FILE` injects a fixture (tests). A release gate MUST use `--frozen`;
treating a local fresh sweep as the authoritative gate is an anti-pattern.

## Process

### 1. Scan

```bash
npm run supply-chain:scan
```

Read `report.md`. If the verdict is exit 0, stop. Otherwise triage every flagged
row and dropped/invariant finding.

### 2. Research each actionable package with exa

For every drifted package, use the `exa` MCP (`web_search_exa`,
`get_code_context_exa`, `crawling_exa`) to establish, up to date:

- the latest npm version and whether the resolved version is current;
- any advisory: `GHSA-*` (GitHub Advisory Database) or OSV for the package
  (the `osv-scanner` step in `.github/workflows/security.yml` pre-screens known
  ones, but exa is the authoritative current check; the local DB lags);
- for a **roll-forward**: read the changelog between the baseline version and the
  resolved version. Confirm no new capability (no new network/FS/proc surface),
  no maintainer/ownership change;
- for a **tag-along**: `npm ls <pkg>` (or the lockfile) to find which direct
  dependency pulled it in, check the license, and do a full first-time trust
  review of the package and its publisher.

### 3. Safe-to-upgrade decision + contract

Fill the generated `contracts/<pkg>.md` stub: an explicit `safe-to-upgrade:
YES/NO` with a one-line rationale, the advisory finding, and the test result. Run
the contract (`npm run build && npm test && npm run security:audit`) against the
resolved tree and record PASS/FAIL. A `NO` on a tag-along means the package must
not enter the tree (pin the caret range or hold the release).

### 4. Cross-LLM validation (mandatory, independent)

Before writing any ledger change, get independent validation via the `gtwy` MCP
from at least codex, grok, and mistral, each as an independent reviewer:

- `createNewSession: true`, read-only tool access (no resume, no commits);
- hand each the `report.json` + the filled contracts, and ask them to verify the
  classification and the safe-to-upgrade calls **against npm / the advisory DBs /
  the changelog directly**, not against your summary;
- codex via `codex_request` (sandbox read-only); mistral `permissionMode:
  auto-approve` (its `plan` mode blocks file reads); grok high effort. Antigravity
  refuses security reviews and a same-repo `claude_request` reviewer has a
  write-access hazard, so prefer Codex + Grok + Mistral.

Record each verdict + job id in the contract. A tag-along needs unanimous
approval; a split verdict means hold and investigate.

### 5. Write the ledger + refresh the baseline

Only after steps 2 to 4. For each approved package, append the newly accepted
EXACT version to that name's `acceptedVersions` in
`supply-chain/prod-closure.ledger.json` (never a range: a caret/tilde/`||`/`*` is
a tool error, exit 1). For a dropped name, set `state: "revoked"` once all its
instances are gone. Then regenerate `supply-chain/prod-closure.baseline.json` so
the committed baseline matches the tree the next release will ship. Refreshing the
committed baseline is what turns an exit 2 roll-forward into exit 0.

### 6. Ledger audit trail

Copy the filled contracts to
`docs/development/supply-chain-guard/ledger/<YYYY-MM-DD>/<pkg>.md`. See
`ledger/README.md`. This is the per-dependency audit trail: the version move, the
advisory finding, the test result, and the cross-LLM verdicts that justified the
ledger change.

### 7. Commit + land

Use `build(supply-chain):` or `fix(supply-chain):` and land on `master` via PR
with the two required checks. The blocking `supply-chain:scan:check` runs inside
`release-security-audit.sh` (hence `npm run check`, `ci.yml`, and
`npm-publish.yml`), so an unresolved drift fails CI until the ledger + baseline
are refreshed.

## Tag-along guarantee

A new prod package cannot land silently: it is exit 3 via ledger-membership
(name not trusted) OR the baseline diff (`new_to_tree`), either alone (fail-closed
OR). A non-registry source is an independent source-anomaly exit 3; an `integrity`
change is an independent integrity-mismatch exit 3. The blocking gate requires
exit 0, so even a roll-forward (exit 2) or a dropped instance blocks until the
committed baseline is refreshed through this process.

## Anti-patterns to refuse

- Rubber-stamping a tag-along; it needs full review + unanimous cross-LLM approval.
- Skipping the advisory sweep "because it's just a patch"; every ledger entry is a
  trust assertion.
- Writing a ledger change before cross-LLM validation (steps 2 to 4 come first).
- Accepting a reviewer verdict without cited evidence (npm / advisory / changelog).
- Deleting ledger entries to "clean up": only prune `dropped` names, deliberately,
  after marking them `revoked`.
- Treating a local fresh-resolve sweep as the authoritative gate (the gate is
  `--frozen`).
- Accepting a roll-forward (exit 2) without refreshing the committed baseline.

## Quick links

- Tool: `scripts/supply-chain/dep-drift-scan.mjs` (tests: `dep-drift-scan.test.mjs`)
- Ledger + baseline: `supply-chain/prod-closure.{ledger,baseline}.json`
- Shared filter: `scripts/make-prod-shrinkwrap.mjs` (`prodFilter`)
- Release gate: `scripts/release-security-audit.sh`
- Spec + DAG: `docs/plans/supply-chain-guard.draft.md` / `.dag.toml`
- Proactive upgrades: Dependabot (`.github/dependabot.yml`)
