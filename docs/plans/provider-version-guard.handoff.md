# Handoff: provider version guard + upgrade availability + contract auto-rebaseline

Continue building the provider version/contract self-maintenance mechanism.
Two of five slices are built and verified; three remain. **The work is
uncommitted on `master`.**

## Start here

Repo: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`
Branch: `master` at `ab53a2b` (clean history; PR #237 just merged)

**Uncommitted working tree** (do not lose this; there is no branch yet):

```
 M setup/status.schema.json          # added upstream.version_guard to the doctor schema
 M src/doctor.ts                     # wires the comparison into every doctor run
?? src/provider-version-guard.ts             # slice 1
?? src/__tests__/provider-version-guard.test.ts        # 20 tests
?? src/provider-upgrade-availability.ts      # slice 2
?? src/__tests__/provider-upgrade-availability.test.ts # 11 tests
```

Verify it still stands before continuing:

```bash
npm run build
./node_modules/.bin/vitest run src/__tests__/provider-version-guard.test.ts \
  src/__tests__/provider-upgrade-availability.test.ts   # expect 31 passed
./node_modules/.bin/vitest run src/__tests__/doctor.test.ts   # expect 58 passed
node dist/index.js doctor --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(JSON.parse(s).upstream.version_guard,null,1)))'
```

## Why this exists

`npm run check` cannot see provider CLI drift: its `upstream:contracts` step is
**offline** and only proves the fixtures, report and TOML agree with each other.
The only gate that probes real binaries is `upstream:drift`, which runs in
exactly one place, `scripts/pre-release.sh:73`. CI does not run it (a stock
runner has none of the seven CLIs) and neither does anything scheduled.

So a provider can move underneath its contract and nothing notices until
someone attempts a release. That is how grok 0.2.112 dropped `--best-of-n` and
`--check` while the gateway kept emitting them (PR #236).

`doctor` already had **both halves** of the answer in one JSON document,
`installed_versions` and the full contract, with `probed: false` and a
`how_to_check` string telling a human to go run the probe. It never compared
them. Werner's reaction, verbatim: "WE WERE SUPPOOSED TO HAVE THIS ALREADY!!!!!"

## Decisions Werner already made (do not relitigate)

Asked explicitly and answered:

1. **On detected surface drift, AUTO-UPDATE the contract baseline.** No review
   step. I flagged that this turns the gate from a tripwire into a self-healer,
   and that a provider silently removing a flag the gateway emits would then be
   auto-accepted rather than caught. He chose it anyway. Build it that way.
   Do still leave a record of what changed (the file is committed, so it shows
   up in review regardless) but do NOT add a review gate in front of it.
2. **All four triggers**: doctor on demand, gateway startup check, a new MCP
   tool plus a scheduled job on this host, and the upgrade-availability check.

## Done: slice 1, version comparison (`src/provider-version-guard.ts`)

Exports `normalizeProviderVersion`, `stripProductPrefix`, `versionsMatch`,
`compareInstalledToTargets`, `summarizeVersionGuard`, `PRODUCT_PREFIXES`.

Wired into `doctor`: `upstream.version_guard` is computed on every run, offline,
spawning nothing (it reuses `installed_versions`). Verified live on this host,
all seven report `match`.

**The normalizer is load-bearing.** Reported and contracted spellings differ:

| provider | doctor reports | `PROVIDER_TARGET_VERSIONS` |
|---|---|---|
| gemini | `1.1.7` | `agy 1.1.7` |
| cursor | `2026.07.23-e383d2b` | `cursor-agent 2026.07.23-e383d2b` |
| claude | `2.1.220 (Claude Code)` | `claude 2.1.220` |
| grok | `grok 0.2.112 (9bbd559437)` | same, with build id |

A plain equality check reports drift on three of seven **correct** installs.
There is a test asserting a naive compare would have been wrong, so nobody
"simplifies" it away. Build ids compare only when both sides carry one.

Trap already hit and fixed: `PRODUCT_PREFIXES` happens to be declared
longest-first for every colliding pair (`codex-cli` before `codex`), so a test
of the longest-match rule could not fail. `stripProductPrefix` now takes an
injectable prefix list and is tested with a hostile order.

## Done: slice 2, upgrade availability (`src/provider-upgrade-availability.ts`)

Exports `UPGRADE_PROBES`, `checkUpgradeAvailability`, `latestFromNpm`,
`latestFromPyPi`, `parseCliCheckVersion`, `upgradableProviders`. Not yet wired
into anything.

Verified against live registries:

| provider | source | verified |
|---|---|---|
| claude | npm `@anthropic-ai/claude-code` | yes, 2.1.220 |
| codex | npm `@openai/codex` | yes, 0.145.0 |
| mistral | PyPI `mistral-vibe` | yes, 2.22.0 |
| grok | `grok update --check` | yes, 0.2.112 |
| gemini, devin, cursor | none | `unknown` + stated reason |

**`devin update` checks AND optionally installs**, so it is not safe to run as
a probe. `cursor-agent update` installs directly. Neither has a check-only
mode. Do not "fix" these by running the update command.

`grok update --check` prints `Grok Build - v0.2.112 (latest: 0.2.112) [stable]`.
The first parser missed it (it required the word "version" after "latest").
Only running the real binary caught that. There is a test on the verbatim
string.

A failed probe must always report `unknown`, never `current`: claiming
up-to-date off a failed check is the one answer that hides a needed upgrade.

## Remaining

### Slice 3: MCP tool + gateway startup check
- New read-only MCP tool exposing version guard + upgrade availability. Existing
  neighbours to match: `cli_versions`, `upstream_contracts`,
  `provider_subcommand_drift`, `cli_upgrade` (all in `src/index.ts`).
- Startup check logging drift to stderr. Must be async and must NOT block start:
  seven `--help` spawns per boot is too much on the hot path. Consider
  reusing the cheap `--version` path only, and gating behind config.
- `cli_upgrade` already exists and `buildCliUpgradePlan` already encodes each
  provider's upgrade mechanism, so "offer to start an upgrade" is wiring
  availability results to that, not new upgrade logic.

### Slice 4: contract auto-rebaseline (the big one)
Rewrite the baseline in `src/upstream-contracts.ts` (hand-maintained TypeScript,
31 contract entries) and `PROVIDER_TARGET_VERSIONS` in
`src/provider-definitions.ts` from probe output. Existing probe machinery to
reuse: `scripts/upstream-scan.mjs` (detects only; writes snapshots under
`--write-snapshot` and reports under `--write-report`, never the contract) and
`buildUpstreamContractReport({ probeInstalled: true })`.

Note the structural constraint: `flags` is the argv **emit allowlist** (what the
gateway may pass), while `acknowledgedUpstreamFlags` is **probe
acknowledgements only, long flags only** (the help scanner extracts only
`--foo`). Auto-rebaselining must not move a removed flag from `flags` into
`acknowledgedUpstreamFlags` blindly, because a flag disappearing from upstream
while the gateway still emits it is a real breakage, which is precisely the
grok 0.2.112 case.

### Slice 5: scheduled job on workhorse3
`systemd --user` timer on this host. GitHub-hosted CI structurally cannot do
this. Must not collide with `llm-cli-gateway-http.service`. Note the existing
`sqryd` user service as a pattern.

## Repo constraints that will bite

- **No `fetch` anywhere in shipped `dist/`.** `scripts/release-security-audit.sh`
  fails the build on the literal token (Socket networkAccess heuristic). Use
  `node:https` like `src/api-http.ts` and `provider-upgrade-availability.ts`.
- **No em dash (U+2014)** anywhere, including comments and commit messages. A
  PreToolUse hook enforces it on edits.
- `setup/status.schema.json` has `additionalProperties: false` on
  `upstream`; any new doctor field must be added there or `doctor.test.ts` fails.
- Use `./node_modules/.bin/prettier` and `./node_modules/.bin/vitest` directly.
  RTK proxies `npx` and masks real output and exit codes.
- `typos` and `gitleaks` are CI-only, not in `npm run check`. Run `typos`
  before pushing.
- `npm-shrinkwrap.json` is generated at release time and **never committed**.
- PR to `master` via `GH_CONFIG_DIR=/home/werner/.config/gh-werner_veriai`,
  merge with `--merge` (not `--squash`). Never bypass a red check.
- Cross-LLM review gate applies. Codex dissents and is usually right; grok is
  good but stalls (pre-generate the diff to a file and shrink the prompt);
  mistral has repeatedly approved while asserting untested negatives, so treat
  its verdicts as incomplete unless it shows commands it actually ran.
- Full `npm run check` has NOT been run against this work yet.

## Suggested first move

Commit the two finished slices on a branch before adding more, so the verified
work is not at risk:

```bash
git checkout -b feature/provider-version-guard
git add src/provider-version-guard.ts src/provider-upgrade-availability.ts \
        src/__tests__/provider-version-guard.test.ts \
        src/__tests__/provider-upgrade-availability.test.ts \
        src/doctor.ts setup/status.schema.json
```

Then continue with slice 3.
