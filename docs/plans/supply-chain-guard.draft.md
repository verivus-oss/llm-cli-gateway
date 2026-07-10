# Supply-chain guard (dependency drift + tag-along) specification (draft)

Status: Reviewed-pending draft. Not yet frozen, not implemented. No
`scripts/supply-chain/` directory, no prod-closure ledger, and no
`dep-drift-scan` symbol exist in the tree at the citation base below. This spec
adapts the sqry (Rust/cargo) `supply-chain-guard` tool + skill + runbook
(`/srv/repos/internal/verivusai-labs/sqry`, branch `feat/supply-chain-guard`,
reviewed to unanimous four-model approval over three rounds; see
`sqry/docs/reviews/supply-chain-guard/2026-07-10/`) to this npm project.

Author: design pass after (a) reading the sqry guard's RUNBOOK, SKILL, and the
three-round cross-LLM review record, and (b) a full inventory of this repo's
release-time supply-chain surface.

Citation base: `2c56762` on `master` (the 2.16.0 release merge). All "today"
claims below cite files at that base; verify against current `master` before
implementing, as line numbers drift.

Companion machine plan (once this draft is accepted): a
`docs/plans/supply-chain-guard.dag.toml` in the house DAG style. This document is
the human-readable spec that goes through the review gate first.

## Terminology (read first)

- **Prod closure**: the set of packages a registry consumer of
  `llm-cli-gateway` actually installs, i.e. every `packages` entry in the
  generated prod-only `npm-shrinkwrap.json` (dev-only entries dropped). This is
  the byte-deterministic tree `scripts/make-prod-shrinkwrap.mjs` produces, not
  the ~316-package dev tree in `package-lock.json`.
- **Ledger**: the committed allowlist of prod-closure packages we have vetted,
  one entry per package name with an accepted version or range, the expected
  registry source, and a rationale/date/reviewers. This is the npm analogue of
  cargo-vet's `supply-chain/config.toml` exemptions. It does not exist today.
- **Roll-forward** (routine): a package name already in the ledger resolved to a
  new version. Low-risk trust roll-forward; still checked (an entry is a trust
  assertion), but the research is "confirm source/maintainer unchanged, no
  advisory landed."
- **Tag-along** (real review): a package name that was never in the ledger
  entered the prod closure. This is the case the operator must not rubber-stamp.
  It can be a legitimate new transitive dep, or something that slipped in through
  a caret bump of an intermediate package.
- **Source anomaly**: any package whose lockfile `resolved` is not the public
  npm registry (`registry.npmjs.org`), e.g. a git, http tarball, or file
  source. Always surfaced regardless of any other verdict.
- **Dropped**: a ledger entry whose package name no longer resolves anywhere in
  the closure. Prunable, but not blindly (a still-supported prior release may
  resolve it).

## 1. Goals

1. Add a durable, reproducible tool that reproduces this repo's release-time
   prod-dependency resolution locally and classifies each drifted package so a
   routine trust roll-forward is distinguishable from a brand-new tag-along that
   entered the prod closure.
2. Guarantee, by construction, that a new (never-ledgered) prod package cannot
   land silently: at least three independent detectors, and a non-zero exit that
   can be wired to fail the release gate.
3. Provide a per-dependency upgrade + advisory + test contract, and a committed
   audit-trail ledger, so every accepted prod package traces to a dated
   rationale and independent validation.
4. Provide a skill + runbook that orchestrate advisory research (exa) and
   mandatory independent cross-LLM validation before any ledger entry is written.
5. Wire the guard into the existing release gate as one more check, without
   replacing or weakening any current check.

## 2. Non-goals

1. Not a replacement for `scripts/release-security-audit.sh`, `npm audit`, the
   `osv-scanner` step in `.github/workflows/security.yml`, or Socket. This guard
   adds the missing allowlist / tag-along layer; the existing blocklist +
   invariant + known-CVE layers stay exactly as they are.
2. Not a general dependency-upgrade tool. Intentional upgrades stay with
   Dependabot (`.github/dependabot.yml`) and manual PRs. The guard is the
   release-gate integrity flow, not the proactive-upgrade flow (sqry splits these
   as `/supply-chain-guard` vs `/dep-update`; this repo has no `/dep-update` yet,
   so the guard's runbook links Dependabot instead).
3. Not shipping to consumers. The scripts, ledger, skill, and runbook are
   internal-only (see section 7, invariant I5).
4. No license-policy enforcement in P0 (deferred to P2; see section 13).

## 3. Background: what exists today (grounding)

The release gate already does a fresh prod resolve and enforces a blocklist plus
invariants, but has no allowlist of accepted prod packages, so a brand-new
transitive package with no CVE and no blocklist hit enters the prod closure
undetected. The relevant machinery, at the citation base:

- **`scripts/pre-release.sh`** removes `npm-shrinkwrap.json`, runs `npm install`
  to apply `overrides` against a fresh registry resolve (`:19-20`), regenerates
  the prod-only shrinkwrap (`:27`), asserts the prod graph is free of
  `better-sqlite3` / `prebuild-install` / `tar-fs` / `tar-stream` (`:37-52`),
  then runs `npm run check` and the verdaccio registry-fidelity install. This IS
  the fresh-resolve step the guard reuses.
- **`scripts/make-prod-shrinkwrap.mjs`** is a pure deterministic filter of
  `package-lock.json`: it drops every `packages` entry with `dev === true`
  (`:63`), strips the root `devDependencies` field (npm/cli#4323), and preserves
  key order with byte-stable formatting. Output is the exact prod closure a
  registry consumer receives (~124 vs ~316 packages). The guard enumerates this.
- **`scripts/release-security-audit.sh`** (`npm run security:audit`) runs, among
  its checks: `npm audit --omit=dev --audit-level=moderate` (`:8`); a shrinkwrap
  prod-projection byte-parity check that regenerates via
  `make-prod-shrinkwrap.mjs` and `cmp -s` compares (`:104-123`); a dependency
  blocklist over the prod graph only (`content-type@2.0.0`, `type-is@2.1.0`,
  `tar-stream@{2.2.0,2.1.4,2.0.0}`, skipping `dev === true`; `:125-165`); a
  `hono >= 4.12.25` floor (`:167-204`); a packed-consumer install that hard-fails
  on any `tar-stream` at all (`:206-258`); and a shipped-`dist/` heuristic that
  fails on any literal `\bfetch\b` (`:263-305`). All blocklist + invariant, no
  allowlist.
- **`socket.yml`** is a hand-maintained ledger of accepted Socket alerts
  (`networkAccess`, `shellAccess` with the full `child_process` call-site list,
  `usesEval` for an ajv transitive, node:sqlite isolation) with `issueRules`
  pinning `shrinkwrap:false`, `shellAccess:false`, etc. It records accepted
  capabilities, not the accepted package-name closure.
- **`.github/dependabot.yml`** groups npm minor/patch updates weekly and pins an
  `ignore` list of known-bad exact versions (`type-is 2.1.0`,
  `content-type 2.0.0`, `body-parser 2.3.0`).
- **`.github/workflows/security.yml`** runs `osv-scanner` (`--recursive
  --no-resolve`) over the lockfile; `ci.yml` runs `security:audit` after
  regenerating the shrinkwrap; `npm-publish.yml` re-runs `security:audit` before
  the provenance publish.
- **Committed vs generated lockfiles**: `package-lock.json` is committed;
  `npm-shrinkwrap.json` is gitignored (`.gitignore:9`) and generated at
  release/CI time. `package.json` dependency ranges are a mix of caret
  (`@modelcontextprotocol/sdk ^1.29.0`, `smol-toml ^1.6.1`, `zod ^4.4.3`) and
  exact pins (`body-parser 2.2.2`, `content-type 1.0.5`, `type-is 2.0.1`), with
  exact `overrides` for the last three plus `fast-uri 3.1.3` and `hono ^4.12.25`.

The caret ranges plus the fresh `npm install` at release are exactly the sqry
drift mechanism: a caret bump of any package (direct or transitive) can pull a
new version, or a new package name, into the prod closure between releases.

## 4. Design

### 4.1 The prod-closure ledger (the trust surface)

A committed `supply-chain/prod-closure.ledger.json` (new directory; the name
`supply-chain/` mirrors sqry for cross-repo familiarity). Schema, one object per
prod package name:

```jsonc
{
  "schemaVersion": "prod-closure-ledger.v1",
  "packages": {
    "zod": {
      "accepted": "^4.4.3",        // semver range or exact; the accepted trust window
      "source": "registry.npmjs.org",
      "firstVetted": "2026-07-10",
      "lastReviewed": "2026-07-10",
      "reviewers": ["codex", "grok", "mistral"],  // cross-LLM validators (section 8)
      "rationale": "direct dep; MCP schema validation; no advisory; see ledger/2026-07-10/zod.md"
    }
    // ... one entry per prod-closure package name
  }
}
```

- Seeded on first run from the current, already-shipped (therefore
  vetted-by-having-been-released) prod closure, so day one is not a wall of
  tag-alongs. The seed rationale records "bootstrap from 2.16.0 shipped closure."
- First-party (the root package itself) is never ledgered.
- The ledger is names + ranges + provenance only; it never contains a secret.

### 4.2 Reproducing the release gate (fresh prod-only shrinkwrap)

The scanner produces the same prod closure the release does, then restores the
tree exactly:

1. Back up `package-lock.json` and `npm-shrinkwrap.json` (if present) to a
   scratch dir.
2. `rm -f npm-shrinkwrap.json`; run `npm install` (fresh registry resolve,
   applies `overrides`), unless `--frozen` is passed (then use the current lock).
3. Run `scripts/make-prod-shrinkwrap.mjs` to produce the prod-only shrinkwrap =
   the authoritative prod closure.
4. Parse the shrinkwrap `packages` map into `{name -> {version, resolved}}`.
5. Restore both lockfiles from backup in a `finally` (see 4.6), so the operator's
   working tree is never left mutated.

Because the fresh resolve is the sqry "warm the index" concern, the runbook
notes `--frozen` gives a fast approximate scan (current lock) while the default
does the full fresh resolve the CI runner would do.

### 4.3 Classification

For each prod-closure package, compared against the ledger:

- **roll-forward**: name in ledger, resolved version differs from a recorded
  exact or is within the accepted range. Tier 2.
- **tag-along**: name not in ledger. Tier 3.
- **source anomaly**: `resolved` host is not `registry.npmjs.org` (git/http/file).
  Tier 3, surfaced even if the name is ledgered.
- **dropped**: ledger entry whose name is absent from the fresh closure. Tier 0
  (informational; prunable, not auto-pruned).
- **clean**: name in ledger, version within the accepted range, registry source.

### 4.4 The three tag-along detectors (+ reused invariants)

The core safety claim, three independent ways so nothing lands silently:

1. **Ledger membership**: any prod-closure name absent from the ledger is a
   tag-along.
2. **Fresh-vs-baseline closure diff**: diff the fresh prod-closure name set
   against the name set of the last-committed baseline (the closure snapshot
   stored alongside the ledger, `supply-chain/prod-closure.baseline.json`). New
   names are reported as `new_to_tree`.
3. **Source anomaly**: any non-registry `resolved` is flagged.

Plus, reusing this repo's existing invariants as additional detectors so the
guard is a superset, not a subset, of today's coverage:

4. **Forbidden native/tar chain** in the prod projection
   (`better-sqlite3`/`prebuild-install`/`tar-fs`/`tar-stream`), the same set
   `pre-release.sh:37-52` asserts.
5. **Blocklisted versions** from `release-security-audit.sh:125-165`
   (`content-type@2.0.0`, `type-is@2.1.0`, `tar-stream@*`) in the prod graph.
6. **`\bfetch\b` in `dist/`** (the shipped-Socket heuristic,
   `release-security-audit.sh:263-305`), included so a single command reproduces
   the whole supply-chain surface locally.

Detectors 4-6 duplicate existing gate checks deliberately: the guard is meant to
be runnable as a single local pre-flight that mirrors the release gate, and CI
still runs the originals independently.

### 4.5 Exit-code contract and outputs

Exit codes (identical scheme to sqry):

- `0` clean: every prod package is ledgered, in range, registry-sourced; no
  invariant tripped.
- `2` roll-forward only: some ledgered packages moved version, nothing new
  entered, no anomaly, no invariant tripped.
- `3` tag-along and/or source anomaly and/or a reused-invariant failure present.
- `1` tool error.

Outputs under a gitignored `.supply-chain/scan-<timestamp>/`:

- `report.json` / `report.md`: verdict, per-class counts, drift rows. `report.json`
  MUST be valid JSON in both the clean (empty) and populated cases.
- `contracts/<pkg>.md`: one upgrade + advisory + test contract stub per
  actionable package (roll-forward and tag-along).
- `fresh.shrinkwrap.json` / `baseline.json`: evidence.

### 4.6 Guarded backup/restore (robustness)

The sqry review spent two of its three rounds on backup/restore robustness under
`set -euo pipefail` (signal handlers, `trap - EXIT` re-entrancy, idempotent
guarded restore, valid JSON when empty, tab-`read` sentinel decoding). This spec
avoids that entire bug class by implementing the scanner in **Node (`.mjs`)**,
not bash:

- Backup/restore is a `try { ... } finally { restore(); }`; process-signal safety
  via a single `process.on("SIGINT"|"SIGTERM"|"exit")` handler that restores once
  (idempotent guard) and re-raises. No `grep -c || echo 0` double-count, no
  `[[ cond ]] && cmd` trailing-return trap, no tab-`read` field loss.
- JSON is built with `JSON.stringify` and validated by construction, so the
  empty-drift case cannot emit invalid JSON.

This is a deliberate deviation from the sqry bash implementation, justified by
this repo's node + vitest tooling (section 11).

## 5. Surface and wiring into existing gates

- CLI: `node scripts/supply-chain/dep-drift-scan.mjs [--frozen] [--no-install]
  [--out DIR] [--closure FILE]`. `--closure` injects a prod-closure fixture for
  the tests (the sqry `--vet-failures` analogue).
- npm scripts: `supply-chain:scan` (the tool) and `supply-chain:scan:check` (the
  blocking form used by CI; exits non-zero on `3`).
- Gate wiring (P1): append `supply-chain:scan:check` as a final step of
  `scripts/release-security-audit.sh`, so it runs inside `npm run check`,
  `ci.yml`, and `npm-publish.yml` with no new workflow. Report-only in P0 (does
  not fail the build; prints the verdict), blocking in P1.

## 6. Configuration and gating

- No runtime config; the tool is dev/release tooling only.
- The ledger and baseline are the only committed state; both are plain JSON,
  reviewed like code.
- `--frozen` (skip fresh resolve; approximate) and `--no-install` (assume
  `node_modules` current) are the only speed knobs. Default is the faithful
  fresh-resolve path.

## 7. Security and correctness invariants

- **I1 Tree never clobbered**: `package-lock.json` and `npm-shrinkwrap.json` are
  byte-identical before and after any scan, including on SIGINT/SIGTERM
  (restore-in-`finally` + signal handler). A test asserts sha256 identity.
- **I2 Fail-closed**: any tag-along, source anomaly, or reused-invariant failure
  yields exit `3`. An unclassifiable package is treated as a tag-along, never as
  clean.
- **I3 No silent new package**: the three independent detectors of 4.4 mean a new
  prod name is caught by ledger-membership AND baseline-diff; a git/http source is
  caught by the source-anomaly detector even if the name is ledgered.
- **I4 Deterministic + offline tests**: the scanner's classification logic is
  pure over an injected closure (`--closure`); the vitest suite runs with no
  network and no `npm install`.
- **I5 Internal-only**: `scripts/supply-chain/`, `supply-chain/*.json`,
  `docs/development/supply-chain-guard/`, and `.claude/skills/supply-chain-guard/`
  are absent from the `package.json` `files` allowlist, so they never ship in the
  tarball. Verified: `files` at the base lists only `dist/`, `migrations/`,
  `npm-shrinkwrap.json`, `setup/status.schema.json`, `README.md`, `CHANGELOG.md`,
  `socket.yml`, `LICENSE`, and seven specific `.agents/skills/*` files; `scripts/`
  and `docs/` are already excluded.
- **I6 No em dash (U+2014)** in any new file (repo hard rule).

## 8. The human + LLM process (skill + runbook)

`.claude/skills/supply-chain-guard/SKILL.md` (condensed) points at
`docs/development/supply-chain-guard/RUNBOOK.md` (source of truth). The staged
process, ported from sqry:

1. **Scan** (`supply-chain:scan`). Read `report.md`. If clean, stop; else triage
   every row.
2. **Research each actionable package with exa**: latest npm version and whether
   the resolved version is current; any GHSA/OSV advisory (osv-scanner hits are
   pre-filled in the contract, but exa is the authoritative current check); for a
   roll-forward read the changelog between baseline and resolved (no new
   capability, no maintainer/ownership change); for a tag-along, `npm ls <pkg>` /
   the lockfile to find which direct dep pulled it in, check the license, and do a
   full first-time trust review of the package and its publisher.
3. **Safe-to-upgrade decision**: fill each `contracts/<pkg>.md` with an explicit
   `safe-to-upgrade: YES/NO` and a one-line rationale; run the contract (build +
   test + `security:audit`) against the fresh tree and record PASS/FAIL.
4. **Cross-LLM validation (mandatory, independent)**: before writing any ledger
   entry, dispatch via the `gtwy` MCP to at least codex, grok, and mistral, each
   `createNewSession: true` with read-only tool access (no resume, no commits),
   handed `report.json` + the filled contracts, verifying classification and the
   safe-to-upgrade calls against npm / advisory DBs / changelogs directly, not the
   summary. Record each verdict + job id in the contract. A tag-along needs
   unanimous approval; a split verdict means hold. (Per repo memory, Antigravity
   refuses security reviews and a same-repo `claude_request` reviewer has a
   write-access hazard, so prefer Codex + Grok + Mistral, read-only.)
5. **Write the ledger entry + refresh the baseline**: add/update the
   `prod-closure.ledger.json` entry and regenerate
   `prod-closure.baseline.json` from the accepted closure.
6. **Ledger audit trail**: copy the filled contracts to
   `docs/development/supply-chain-guard/ledger/<YYYY-MM-DD>/<pkg>.md`.
7. **Commit + land** on `master` with a `build(supply-chain):` or
   `fix(supply-chain):` prefix.

Anti-patterns the skill must refuse (from sqry): rubber-stamping a tag-along;
skipping the advisory sweep "because it's just a patch"; writing a ledger entry
before cross-LLM validation; accepting a reviewer verdict without cited evidence;
deleting ledger entries to "clean up" (only prune `dropped`, deliberately);
scanning with `--frozen` and calling it a faithful gate reproduction.

## 9. Required new files (module plan)

- `supply-chain/prod-closure.ledger.json` (committed; the allowlist).
- `supply-chain/prod-closure.baseline.json` (committed; last-accepted closure
  name+version snapshot for the diff detector).
- `scripts/supply-chain/dep-drift-scan.mjs` (the scanner; reuses
  `make-prod-shrinkwrap.mjs` as a library or subprocess).
- `scripts/supply-chain/dep-drift-scan.test.mjs` (vitest; offline).
- `.claude/skills/supply-chain-guard/SKILL.md`.
- `docs/development/supply-chain-guard/RUNBOOK.md`.
- `docs/development/supply-chain-guard/ledger/README.md`.
- `.gitignore`: add `.supply-chain/`.
- `package.json`: add `supply-chain:scan` + `supply-chain:scan:check` scripts;
  P1 also appends the check to `scripts/release-security-audit.sh`.

## 10. Failure policy

- The scanner never edits the ledger, the baseline, or any lockfile permanently;
  it only reads and restores. All writes to the ledger/baseline are done by the
  human/LLM in step 5, reviewed as code.
- If `npm install` fails during the fresh resolve, exit `1` with the npm error;
  the `finally` restore still runs.
- A dropped ledger entry is reported, never auto-removed (a supported prior
  release may still resolve it).

## 11. Deltas from the sqry template (honest)

1. **No free trust engine.** cargo-vet resolved wildcard/publisher trust
   authoritatively; npm has no equivalent, so the ledger + closure diff IS the
   engine. Upside: the fresh prod-only shrinkwrap already exists and is
   byte-deterministic, so "reproduce the gate" is nearly free here, where sqry had
   to regenerate the lockfile and drive cargo-vet.
2. **`.mjs`, not bash + shellcheck.** Justified by this repo's node + vitest
   tooling, and it removes the pipefail bug classes that consumed two sqry review
   rounds. Cost: we lose shellcheck; gain vitest coverage and try/finally safety.
3. **Advisory sources**: RUSTSEC/crates.io -> GHSA/OSV/npm; `osv-scanner` already
   in `security.yml` gives a head start.
4. **License policy**: sqry has `deny.toml`/cargo-deny; deferred here to P2 (a
   license allowlist), not P0.
5. **Two-flow split**: sqry pairs the guard with `/dep-update`; this repo has no
   `/dep-update`, so the runbook links Dependabot as the proactive flow instead.

## 12. Open questions

1. **Ledger granularity**: name + accepted-range (proposed) vs name + every
   exact version ever shipped. Range is less churny but a wider trust window;
   exact-per-version is the closest cargo-vet analogue but grows unbounded.
   Proposed: accepted-range, with the baseline snapshot recording exact versions
   for the diff.
2. **Baseline storage**: a separate `prod-closure.baseline.json` (proposed) vs
   deriving the baseline from the ledger's accepted ranges. Separate file makes
   the `new_to_tree` diff exact and cheap.
3. **CI cost of the fresh resolve**: the default path runs `npm install`; in CI
   the shrinkwrap is already regenerated by `ci.yml`, so the check step may run
   `--frozen` against that artifact rather than re-installing. Decide per-surface.
4. **Overlap with `security:audit`**: detectors 4-6 duplicate existing checks.
   Keep them (single-command local reproduction) or drop them from the guard and
   rely on `security:audit` composition. Proposed: keep, documented as intentional.
5. **Peer/optional deps** (`pg`): not in the default prod closure (optional peer).
   Decide whether the ledger tracks optional peers separately.

## 13. Rollout (phased, each its own gate)

- **P0 (report-only)**: ledger schema + seed from the current shipped closure +
  baseline snapshot + `dep-drift-scan.mjs` (classification, three detectors, exit
  codes) + offline vitest suite. Wire as a non-blocking `supply-chain:scan`
  script. Cross-LLM review gate on the code.
- **P1 (blocking + process)**: SKILL + RUNBOOK + ledger audit-trail; append
  `supply-chain:scan:check` to `release-security-audit.sh` so a tag-along fails
  the release. Cross-LLM review gate.
- **P2 (breadth)**: license allowlist; optional Socket API cross-check for
  capability drift on ledgered packages; optional `/dep-update` proactive flow.

Each phase lands on `master` via PR with the standard two required checks, and
goes through the cross-LLM review gate to unanimous approval before merge, the
same discipline the sqry guard followed (three rounds).

## 14. Authoritative references (code SoT this spec builds on)

- Fresh resolve + prod-graph assertion: `scripts/pre-release.sh` (`:19-52`).
- Prod-closure generator: `scripts/make-prod-shrinkwrap.mjs` (`:63-74`).
- Existing release gate (blocklist + invariants): `scripts/release-security-audit.sh`
  (`:8`, `:104-123`, `:125-165`, `:167-204`, `:206-258`, `:263-305`).
- Accepted-capability ledger: `socket.yml`.
- Dependabot policy: `.github/dependabot.yml`.
- CI/publish topology: `.github/workflows/{ci,security,sast,npm-publish}.yml`.
- Tarball scope (internal-only proof): `package.json` `files`.
- Source template: sqry `feat/supply-chain-guard`
  (`scripts/supply-chain/vet-drift-scan.sh`,
  `docs/development/supply-chain-guard/RUNBOOK.md`,
  `.claude/skills/supply-chain-guard/SKILL.md`, and the review record under
  `docs/reviews/supply-chain-guard/2026-07-10/`).
