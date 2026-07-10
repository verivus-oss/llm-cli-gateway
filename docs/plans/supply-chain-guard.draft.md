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

Revision: round 1 of the cross-LLM review gate (Codex, Grok; Mistral's round-1
run was invalidated by a sandbox access restriction, re-run in round 2) returned
BLOCKED with a converging set of design-underspecification findings. This
revision folds them in: the trust unit is now a path-keyed package *instance*
(not a bare name), a full classification decision table replaces the prose tiers,
the blocking gate requires exit `0` against the committed baseline (closing the
in-range trust window), the resolve mode is fixed per surface, and the grounding
counts/citations are corrected. See the changelog inline at each section and the
review record on PR #173.

Citation base: `2c56762` on `master` (the 2.16.0 release merge). All "today"
claims below cite files at that base; verify against current `master` before
implementing, as line numbers drift.

Companion machine plan (once this draft is accepted): a
`docs/plans/supply-chain-guard.dag.toml` in the house DAG style. This document is
the human-readable spec that goes through the review gate first.

## Terminology (read first)

- **Prod closure**: the set of packages a registry consumer of
  `llm-cli-gateway` actually installs, i.e. every `node_modules/...` entry in the
  generated prod-only `npm-shrinkwrap.json` (dev-only entries dropped). This is
  the byte-deterministic tree `scripts/make-prod-shrinkwrap.mjs` produces. At the
  citation base the prod closure is 93 entries including the root (92 non-root
  `node_modules` instances) out of 320 total `package-lock.json` entries.
- **Instance** (the trust unit): a single `packages` entry in the lockfile,
  keyed by its `node_modules/...` path, carrying `name`, `version`, `resolved`,
  and `integrity`. The guard classifies *instances*, not bare names, because the
  lockfile is path-keyed (`make-prod-shrinkwrap.mjs:60` preserves those keys) and
  the same name can appear at multiple paths/versions. Two properties this buys:
  a version bump is a changed instance (not silently "the same trusted name"),
  and an `integrity` change on the same `name@version` is detectable.
- **Ledger**: the committed, human/LLM-reviewed allowlist keyed by package name,
  recording the accepted exact version(s), expected registry source, rationale,
  reviewers, and dates. It is the npm analogue of cargo-vet's
  `supply-chain/config.toml` exemptions and answers "why do we trust this name."
  It does not exist today.
- **Baseline**: the committed, machine-generated exact snapshot of the accepted
  prod closure as a list of instances (`path`, `name`, `version`, `resolved`,
  `integrity`), `supply-chain/prod-closure.baseline.json`. It is what "clean =
  exact match" compares against, and the source set for the drift diff. Distinct
  from the ledger: the baseline is the *what* (exact accepted instances), the
  ledger is the *why* (per-name rationale + accepted versions).
- **Roll-forward** (routine): a name in the ledger whose instance differs from
  the baseline (new version, still within the ledger's accepted set, or a new
  path for a trusted name). Low-risk, but still a change: exit `2`, and it must be
  researched and the baseline refreshed before it counts as clean. The research
  is "confirm source/maintainer unchanged, no advisory landed."
- **Tag-along** (real review): a name that is not in the ledger, or a name in the
  fresh closure but not in the baseline (`new_to_tree`). The case the operator
  must not rubber-stamp; a legitimate new transitive dep, or something slipped in
  through a caret bump of an intermediate package.
- **Source anomaly**: any instance whose `resolved` is not the public npm
  registry (`registry.npmjs.org`), e.g. git, http tarball, or file. Surfaced
  regardless of any other verdict.
- **Integrity mismatch**: an instance whose `name@version` matches the baseline
  but whose `integrity` differs (registry-immutability break or lock tampering).
  Surfaced regardless of any other verdict.
- **Dropped**: a ledger/baseline name absent from the fresh closure. On
  acceptance its ledger entry is marked `revoked` and pruned from the baseline,
  so a later re-entry of the same name classifies as a tag-along again (not
  silently re-trusted). Reported, never auto-pruned by the scanner.

## 1. Goals

1. Add a durable, reproducible tool that reproduces this repo's release-time
   prod-dependency resolution locally and classifies each drifted package so a
   routine trust roll-forward is distinguishable from a brand-new tag-along that
   entered the prod closure.
2. Guarantee, by construction, that a new (never-ledgered) prod package, or any
   change to an accepted instance, cannot land silently: fail-closed detectors
   (see 4.4) and a non-zero exit wired to fail the release gate, which requires
   exit `0` against the committed baseline (section 4.5).
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
invariants, but has no name- or instance-level allowlist of the accepted prod
closure. The nearest thing is a coarse reified-package *count* band
(`scripts/verify-registry-install.sh:42-47`, `EXPECTED_REIFIED_MIN=92` /
`MAX=96`, 94 observed), which runs only on the pre-release/verdaccio path (not in
`ci.yml` `security:audit`) and which a single new package (92 -> 93) passes
cleanly. So a brand-new transitive package with no CVE and no blocklist hit
enters the prod closure undetected by any name check. The relevant machinery, at
the citation base:

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
  registry consumer receives (93 entries incl. root at the base, vs 320 total).
  The guard enumerates this. (Note: the in-repo comments still say "~124 prod",
  which is stale; the current closure is 92 non-root instances.)
- **`scripts/release-security-audit.sh`** (`npm run security:audit`) runs, among
  its checks: `npm audit --omit=dev --audit-level=moderate` (`:8`); a shrinkwrap
  prod-projection byte-parity check that regenerates via
  `make-prod-shrinkwrap.mjs` and `cmp -s` compares (`:104-123`); a **version**
  blocklist over the prod graph only (`content-type@2.0.0`, `type-is@2.1.0`, and
  exactly `tar-stream@{2.2.0,2.1.4,2.0.0}`, skipping `dev === true`; `:125-165`);
  a `hono >= 4.12.25` floor that does NOT skip dev entries, unlike the blocklist
  (`:167-204`); a **separate** packed-consumer install that hard-fails on *any*
  `tar-stream` version at all (`:206-258`, distinct from the versioned blocklist
  above); and a shipped-`dist/` heuristic that fails on any literal `\bfetch\b`
  (`:263-305`). All blocklist + invariant + coarse count band, no name/instance
  allowlist. Critically, the byte-parity check only proves the shrinkwrap matches
  the *current* `package-lock.json`; both can regenerate to include a new package
  and still `cmp` equal, so parity is not a drift detector.
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

### 4.1 The ledger and the baseline (the trust surface)

Two committed files under a new `supply-chain/` directory (the name mirrors sqry
for cross-repo familiarity). The **ledger** is the per-name "why we trust it"
record; the **baseline** is the exact "what we accepted" snapshot the scanner
diffs against.

Ledger (`supply-chain/prod-closure.ledger.json`), keyed by package name:

```jsonc
{
  "schemaVersion": "prod-closure-ledger.v1",
  "packages": {
    "zod": {
      "acceptedVersions": ["4.4.3"], // EXACT versions, never a caret range (see below)
      "source": "registry.npmjs.org",
      "state": "trusted",            // "trusted" | "revoked" (revoked on drop; re-entry = tag-along)
      "firstVetted": "2026-07-10",
      "lastReviewed": "2026-07-10",
      "reviewers": ["codex", "grok", "mistral"],  // cross-LLM validators (section 8)
      "rationale": "direct dep; MCP schema validation; no advisory; see ledger/2026-07-10/zod.md"
    }
    // ... one entry per prod-closure package name
  }
}
```

Baseline (`supply-chain/prod-closure.baseline.json`): a machine-generated list of
the accepted *instances*, exactly as the lockfile keys them, so "clean = exact
match" is well-defined:

```jsonc
{
  "schemaVersion": "prod-closure-baseline.v1",
  "instances": [
    { "path": "node_modules/zod", "name": "zod", "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/zod/-/zod-4.4.3.tgz", "integrity": "sha512-..." }
    // ... one per prod-closure node_modules instance
  ]
}
```

- **Seed policy (fixes a round-1 blocker)**: seeded on first run from the current
  shipped closure, but shipping is NOT vetting, so the seed records EXACT resolved
  versions (`acceptedVersions: ["4.4.3"]`, not `^4.4.3`) and the seed rationale is
  explicitly "bootstrap from 2.16.0 shipped closure, not individually reviewed."
  A caret/range accepted-window is never written by the seed; ranges only ever
  arrive through an explicit, reviewed roll-forward. This prevents day one from
  baking a wide, unreviewed trust window.
- First-party (the root package itself) is never ledgered or baselined.
- Both files are names/versions/provenance only; neither contains a secret.

### 4.2 Producing the prod closure (resolve mode is per-surface)

The scanner produces the exact prod closure the release ships, then parses it
into instances. There are two resolve modes, and which one is authoritative
depends on the surface (this fixes a round-1 blocker: a default fresh
`npm install` inside CI could score a different tree than the committed lock the
release actually ships):

- **`--frozen` (the CI / release-gate mode, authoritative there)**: do NOT run
  `npm install`. Run `scripts/make-prod-shrinkwrap.mjs` against the shrinkwrap
  that `ci.yml` / `npm-publish.yml` / `pre-release.sh` have *already regenerated*
  from the committed `package-lock.json`, and classify that. No install, no
  mutation of the operator's tree at all. This is the tree the release ships, so
  it is the tree the gate must score.
- **Fresh-resolve (the local / pre-release sweep mode)**: to discover drift
  *before* it is committed, copy `package.json` + `package-lock.json` into a
  throwaway temp directory, run `npm install` there (fresh registry resolve,
  applies `overrides`), run `make-prod-shrinkwrap.mjs` on the temp copy, and
  classify. The operator's working `package-lock.json`, `npm-shrinkwrap.json`,
  and `node_modules` are never touched. The temp dir is removed in a `finally`.

Either way the scanner parses the resulting prod-only shrinkwrap into instances
`{path -> {name, version, resolved, integrity}}` (4.3). The runbook is explicit
that `--frozen` scores the committed tree while fresh-resolve predicts the next
resolve; a release gate MUST use `--frozen` (or scan a committed fresh lock), and
calling a fresh-resolve sweep a faithful gate reproduction is an anti-pattern
(section 8).

### 4.3 Classification (decision table)

Each fresh prod-closure instance is classified by looking it up in the committed
baseline and the ledger. The table is evaluated top to bottom; the first matching
row wins, so the fail-closed classes (source anomaly, integrity mismatch,
tag-along) take precedence over roll-forward and clean. "In baseline (exact)"
means an instance with the same `path`, `name`, `version`, `resolved`, AND
`integrity`.

| # | source == registry? | integrity matches baseline for this name@version? | name in ledger (state=trusted)? | in baseline (exact)? | version in ledger `acceptedVersions`? | class | exit |
|---|---|---|---|---|---|---|---|
| 1 | no | - | - | - | - | **source anomaly** | 3 |
| 2 | yes | no (same name@version, different integrity) | - | - | - | **integrity mismatch** | 3 |
| 3 | yes | n/a (name@version not in baseline) | no | - | - | **tag-along** | 3 |
| 4 | yes | n/a | yes | no | no | **tag-along** (`new_to_tree`: ledgered name but version not yet accepted) | 3 |
| 5 | yes | yes | yes | no | yes | **roll-forward** (accepted version, new instance/path vs baseline) | 2 |
| 6 | yes | yes | yes | yes | yes | **clean** | 0 |

Plus two whole-closure classes computed by set difference:

- **new_to_tree** (fail-closed): a name present in the fresh closure but absent
  from the baseline is always exit `3`, on its own, regardless of ledger state.
  This is the OR partner of ledger-membership (invariant I3): either detector
  firing alone blocks.
- **dropped** (informational, exit contributes `0`): a baseline/ledger name
  absent from the fresh closure. Reported; on acceptance the human marks the
  ledger entry `state: "revoked"` and prunes it from the baseline (so a later
  re-entry re-classifies as tag-along, not silently trusted). Never auto-pruned.

An instance that matches no row (unresolvable classification) is treated as a
tag-along (exit `3`), never as clean (invariant I2).

### 4.4 Detectors (honest about independence)

The safety claim is fail-closed coverage, not three orthogonal failure domains.
There are two correlated name-set detectors plus two genuinely orthogonal
instance detectors:

1. **Ledger membership** (name axis): any prod-closure name absent from the
   ledger (or `state != trusted`) is a tag-along.
2. **Baseline diff** (name axis, `new_to_tree`): any fresh name absent from the
   committed baseline is exit `3` on its own. Detectors 1 and 2 are CORRELATED,
   both fire on name-set growth; they are dual evidence combined fail-closed with
   OR (invariant I3), not independent detectors. Keeping both matters because the
   ledger can lag the baseline (a `revoked` name is still in neither, a bootstrap
   gap could leave one populated before the other).
3. **Source anomaly** (orthogonal): any non-`registry.npmjs.org` `resolved`,
   flagged even for a ledgered, in-baseline name.
4. **Integrity mismatch** (orthogonal): a `name@version` that matches the
   baseline but whose `integrity` differs. This is the genuine third axis a pure
   name/version check misses (registry-immutability break, lock tampering).

Plus, reusing this repo's existing invariants as additional detectors so the
guard is a superset, not a subset, of today's coverage:

4. **Forbidden native/tar chain** in the prod projection
   (`better-sqlite3`/`prebuild-install`/`tar-fs`/`tar-stream`), the same set
   `pre-release.sh:37-52` asserts.
5. **Blocklisted versions** from `release-security-audit.sh:125-165`
   (`content-type@2.0.0`, `type-is@2.1.0`, and exactly
   `tar-stream@{2.2.0,2.1.4,2.0.0}`) in the prod graph, plus the separate
   any-version `tar-stream` ban from the packed-consumer check (`:206-258`).
6. **`\bfetch\b` in `dist/`** (the shipped-Socket heuristic,
   `release-security-audit.sh:263-305`), included so a single command reproduces
   the whole supply-chain surface locally.

Detectors 4-6 duplicate existing gate checks deliberately: the guard is meant to
be runnable as a single local pre-flight that mirrors the release gate, and CI
still runs the originals independently.

### 4.5 Exit-code contract, and what the gate requires

Exit codes are the maximum severity over all instances (source anomaly, integrity
mismatch, tag-along, and any reused-invariant failure are `3`; roll-forward is
`2`; otherwise `0`):

- `0` clean: every instance matches the committed baseline exactly; no anomaly,
  no invariant tripped.
- `2` roll-forward only: some ledgered names moved to another accepted version /
  path vs the baseline, but nothing un-ledgered entered, no `new_to_tree`, no
  anomaly, no integrity mismatch, no invariant.
- `3` a tag-along, `new_to_tree`, source anomaly, integrity mismatch, or a
  reused-invariant failure is present.
- `1` tool error.

**What the blocking gate requires (fixes the round-1 trust-window blocker)**: the
release-gate form, `supply-chain:scan:check`, requires exit **`0`** against the
committed baseline, not merely "not 3." A roll-forward (exit `2`) therefore BLOCKS
the release until the drift has been researched and the committed baseline
refreshed through the reviewed process (section 8). This is the "no unreviewed
prod change ships" guarantee and matches cargo-vet's per-version exemption model:
an in-range caret bump of a ledgered name is not silently clean, it must move the
committed baseline first. The plain `supply-chain:scan` (local/advisory) form
tolerates exit `2` so an operator can see roll-forwards without blocking.

Outputs under a gitignored `.supply-chain/scan-<timestamp>/`:

- `report.json` / `report.md`: verdict, per-class counts, per-instance drift rows.
  `report.json` MUST be valid JSON in both the clean (empty) and populated cases.
- `contracts/<pkg>.md`: one upgrade + advisory + test contract stub per
  actionable package (roll-forward and tag-along).
- `fresh.shrinkwrap.json` / `baseline.json`: evidence.

### 4.6 Mutation boundary and robustness

The scanner is implemented in **Node (`.mjs`)**, not bash, which removes the
`set -euo pipefail` bug class the sqry review spent two rounds on (the
`grep -c || echo 0` double-count, the `[[ cond ]] && cmd` trailing-return trap,
tab-`read` field loss). JSON is built with `JSON.stringify`, so the empty-drift
case cannot emit invalid JSON.

Mutation boundary, stated honestly (fixes a round-1 blocker; the earlier
"in-place `npm install` then restore lockfiles" plan overpromised tree safety
because `npm install` also mutates `node_modules`):

- **`--frozen` mode**: performs no install and writes nothing outside the
  gitignored `.supply-chain/` output dir. Zero mutation of `package-lock.json`,
  `npm-shrinkwrap.json`, or `node_modules`.
- **Fresh-resolve mode**: the `npm install` runs inside a throwaway temp copy of
  `package.json` + `package-lock.json` (4.2), removed in a `finally`. The
  operator's real `package-lock.json`, `npm-shrinkwrap.json`, and `node_modules`
  are never touched, so there is nothing to restore in the working tree. A
  `SIGKILL` during the temp install can leave only the temp dir behind (safe to
  delete), never a mutated working tree. This is stronger than the sqry
  in-place-restore approach.

This is a deliberate deviation from the sqry bash implementation, justified by
this repo's node + vitest tooling (section 11).

## 5. Surface and wiring into existing gates

- CLI: `node scripts/supply-chain/dep-drift-scan.mjs [--frozen]
  [--out DIR] [--closure FILE]`. `--closure` injects a prod-closure fixture for
  the tests (the sqry `--vet-failures` analogue). `--frozen` scores the current
  committed/regenerated shrinkwrap (no install); the default fresh-resolve mode
  runs in a temp copy (4.2).
- npm scripts: `supply-chain:scan` (local/advisory; tolerates exit `2`) and
  `supply-chain:scan:check` (the blocking gate form: runs `--frozen` and requires
  exit `0` against the committed baseline; see 4.5).
- Gate wiring (P1): append `supply-chain:scan:check` as a final step of
  `scripts/release-security-audit.sh` so it runs inside `npm run check`,
  `ci.yml`, and `npm-publish.yml` with no new workflow. Because those surfaces
  already regenerate the shrinkwrap from the committed lock
  (`ci.yml`, `npm-publish.yml`, `pre-release.sh`), the check runs `--frozen`
  against that exact artifact, never a fresh resolve, so it always scores the
  tree the release ships. Report-only in P0 (prints the verdict, does not fail
  the build), blocking in P1.

## 6. Configuration and gating

- No runtime config; the tool is dev/release tooling only.
- The ledger and baseline are the only committed state; both are plain JSON,
  reviewed like code.
- `--frozen` (score the committed/regenerated shrinkwrap; the CI/gate mode) vs
  the default fresh-resolve-in-temp-copy (the local sweep mode) is the only mode
  knob (4.2). The gate always uses `--frozen`.

## 7. Security and correctness invariants

- **I1 Working tree never mutated**: the scanner writes only inside the gitignored
  `.supply-chain/` output dir. `--frozen` mode performs no install; fresh-resolve
  mode installs only in a throwaway temp copy (4.6). The operator's
  `package-lock.json`, `npm-shrinkwrap.json`, and `node_modules` are untouched, so
  there is nothing to clobber (stronger than the sqry in-place-restore). A test
  asserts sha256 identity of the working lockfiles across a scan, including on
  SIGINT/SIGTERM; a `SIGKILL` can leave only a stray temp dir, never a mutated
  working tree.
- **I2 Fail-closed**: any source anomaly, integrity mismatch, tag-along,
  `new_to_tree`, or reused-invariant failure yields exit `3`. An instance matching
  no decision-table row is treated as a tag-along, never as clean.
- **I3 No silent new package (fail-closed OR)**: a new prod name is exit `3` if it
  is caught by ledger-membership **OR** by the baseline diff (`new_to_tree`),
  either alone; the detectors are combined with OR, not AND, so a gap in one does
  not create a hole. A non-registry source (source anomaly) and an `integrity`
  change (integrity mismatch) are each exit `3` independently, even for a
  ledgered, in-baseline name.
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
   `prod-closure.ledger.json` entry (append the newly accepted exact version to
   `acceptedVersions`; for a dropped name set `state: "revoked"`), then regenerate
   `prod-closure.baseline.json` from the now-accepted closure so the committed
   baseline matches the tree the next release will ship. Refreshing the committed
   baseline is what turns an exit `2` roll-forward into exit `0` (4.5); it is a
   reviewed commit, not something the scanner does.
6. **Ledger audit trail**: copy the filled contracts to
   `docs/development/supply-chain-guard/ledger/<YYYY-MM-DD>/<pkg>.md`.
7. **Commit + land** on `master` with a `build(supply-chain):` or
   `fix(supply-chain):` prefix.

Anti-patterns the skill must refuse (from sqry): rubber-stamping a tag-along;
skipping the advisory sweep "because it's just a patch"; writing a ledger entry
before cross-LLM validation; accepting a reviewer verdict without cited evidence;
deleting ledger entries to "clean up" (only prune `dropped` names, deliberately,
after marking them `revoked`); treating a local fresh-resolve sweep as the
authoritative gate (the gate scores the committed tree via `--frozen`, 4.2);
accepting a roll-forward (exit `2`) without refreshing the committed baseline
through this process (that is what makes it clean, 4.5).

## 9. Required new files (module plan)

- `supply-chain/prod-closure.ledger.json` (committed; per-name allowlist with
  exact `acceptedVersions` + `state` + rationale).
- `supply-chain/prod-closure.baseline.json` (committed; exact per-instance
  snapshot: `path`, `name`, `version`, `resolved`, `integrity`).
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

- The scanner never edits the ledger, the baseline, the working `package-lock.json`,
  or `node_modules`; it reads them and (in fresh mode) installs only in a temp
  copy. All writes to the ledger/baseline are done by the human/LLM in step 5,
  reviewed as code (the one exception is an explicit `--write-baseline`, open
  question 4, which still only runs after the ledger is updated).
- If `npm install` fails during a fresh-resolve sweep, exit `1` with the npm
  error; the temp dir is still removed in the `finally`.
- A dropped name is reported, never auto-removed; on acceptance the human marks
  it `revoked` and prunes the baseline (a supported prior release may still
  resolve it, so pruning is deliberate).

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
6. **Instance + integrity, not name.** Because npm has no cargo-vet to resolve
   trust exactly, this design classifies path-keyed instances with an `integrity`
   check (4.3, 4.4) rather than cargo-vet's name+version trust surface. This
   gives npm an integrity/immutability detector cargo-vet does not need (crates.io
   is content-addressed), and makes "clean = exact committed baseline match" the
   definition, so no in-range version can be silently trusted.

## 12. Open questions

Resolved in this revision (kept for the record):

- **R1 Ledger granularity**: RESOLVED to exact `acceptedVersions` (never a caret
  range). Round-1 flagged that a range plus a non-blocking exit `2` bakes a wide
  trust window; the blocking gate now requires exit `0` and the seed writes exact
  versions (4.1, 4.5).
- **R2 Baseline storage**: RESOLVED to a separate instance-level
  `prod-closure.baseline.json` (`path`/`name`/`version`/`resolved`/`integrity`),
  so `new_to_tree` and integrity checks are exact (4.1, 4.3).
- **R3 Resolve mode**: RESOLVED per-surface: CI/publish/`security:audit` use
  `--frozen` against the already-regenerated shrinkwrap; fresh resolve only for
  local sweeps, in a temp copy (4.2).

Still open:

1. **Overlap with `security:audit`**: reused detectors 4-6 duplicate existing
   checks. Keep them (single-command local reproduction) or drop and rely on
   `security:audit` composition. Proposed: keep, documented as intentional.
2. **Peer/optional deps** (`pg`, an optional peer at `package.json:113-119`): not
   in the default prod closure. Decide whether the ledger tracks optional peers
   separately, or documents them as out of scope.
3. **`acceptedVersions` growth**: exact-version accepts grow the ledger over time.
   Decide a pruning policy (e.g. drop versions no supported release resolves),
   distinct from the `revoked`-on-drop rule for names.
4. **Baseline refresh authorship**: whether the baseline regeneration in step 5 is
   a manual `supply-chain:scan --write-baseline` or a hand edit. Proposed: a
   `--write-baseline` flag that only ever writes after the human has updated the
   ledger, never from the scanner's classification path.

## 13. Rollout (phased, each its own gate)

- **P0 (report-only)**: ledger + exact-version seed + instance baseline snapshot +
  `dep-drift-scan.mjs` (instance classification per the 4.3 decision table, the
  4.4 detectors, exit codes) + offline vitest suite covering every decision-table
  row and both whole-closure classes. Wire as a non-blocking `supply-chain:scan`.
  Cross-LLM review gate on the code.
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
  (`:8` npm audit, `:104-123` byte-parity, `:125-165` version blocklist,
  `:167-204` hono floor, `:206-258` packed-consumer any-tar-stream, `:263-305`
  fetch-in-dist).
- Coarse reified-count band (pre-release only): `scripts/verify-registry-install.sh`
  (`:42-47`, `EXPECTED_REIFIED_MIN/MAX` 92/96).
- Optional peer (`pg`): `package.json` (`:113-119`).
- Accepted-capability ledger: `socket.yml`.
- Dependabot policy: `.github/dependabot.yml`.
- CI/publish topology: `.github/workflows/{ci,security,sast,npm-publish}.yml`.
- Tarball scope (internal-only proof): `package.json` `files`.
- Source template: sqry `feat/supply-chain-guard`
  (`scripts/supply-chain/vet-drift-scan.sh`,
  `docs/development/supply-chain-guard/RUNBOOK.md`,
  `.claude/skills/supply-chain-guard/SKILL.md`, and the review record under
  `docs/reviews/supply-chain-guard/2026-07-10/`).
