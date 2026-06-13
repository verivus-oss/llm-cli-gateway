# Verification report: `track-acp-upstream-contracts`

- **Plan**: `docs/plans/first-class-acp-gateway-extension.dag.toml`
- **Step id**: `track-acp-upstream-contracts` (DAG lines 509-529)
- **Verifier role**: independent (did not trust implementer; located the implementing
  commit, re-read source + tests, and re-ran the gate + tests myself)
- **Implementation under review**: worktree
  `.claude/worktrees/wf_a414fd6a-a3f-5` at HEAD `a937f02`
  ("feat(acp): track ACP upstream entrypoint contracts separately from request argv"),
  parent `662bfdc` (master tip).
- **Verdict**: PASS. Both validation rows pass; no vacuous tests.

## Where the implementation lives (not in the main working tree)

The main working tree (`/srv/repos/.../llm-cli-gateway`, HEAD `662bfdc`) has **no**
ACP upstream-contract code — `grep -niE "acp" src/upstream-contracts.ts` on master
returns only an unrelated pre-existing line (`grok agent stdio` description at
line 1393). The actual step implementation is committed in the workflow worktree
`wf_a414fd6a-a3f-5` at `a937f02`. `git show --stat a937f02` — three files, no other
modifications:

- `src/upstream-contracts.ts` (+268)
- `src/__tests__/upstream-contracts.test.ts` (+134)
- `scripts/upstream-scan.mjs` (+68 / -1)

All absolute paths below are under
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/.claude/worktrees/wf_a414fd6a-a3f-5/`.

## DAG validation clause (lines 526-529)

> npm run upstream:contracts passes offline. Live probe mode reports ACP
> entrypoint drift separately from request-tool command drift.

Two behavioral requirements, both proven below.

## Command-output digests

### Requirement A — `npm run upstream:contracts` passes offline

`npm run upstream:contracts` (= `node scripts/upstream-scan.mjs --contracts-check`):

```
[upstream-scan] contracts-check OK: 5 providers, fixtures + report + TOML-sync verified (offline).
```
`UPSTREAM_EXIT:0`. No network access; no provider process spawned in `--contracts-check`
mode (the offline path runs only the in-memory contract/report/TOML assertions plus the
new ACP block 2b at `scripts/upstream-scan.mjs:173-205`).

### Requirement B — live probe reports ACP entrypoint drift separately

`node scripts/upstream-scan.mjs --probe-installed` (filtered to ACP + drift lines):

```
  [probe] subcommands: 13 declared path(s), 1 with drift          <- request-tool command drift
  [acp-probe] claude: adapter_mediated_deferred (claude 2.1.175) — no native entrypoint to probe
  [acp-probe] codex: adapter_mediated_deferred (codex-cli 0.139.0) — no native entrypoint to probe
  [acp-probe] gemini: absent_watchlist (agy 1.0.7) — no native entrypoint to probe
  [acp-probe] grok: native ACP entrypoint `grok agent stdio` present (probed 1 read-only command(s))
  [acp-probe] mistral: native ACP entrypoint `vibe-acp` present (probed 2 read-only command(s))
```

The `[acp-probe]` lines are emitted from a code block (`scripts/upstream-scan.mjs:584-613`)
that is textually and structurally distinct from the request-tool `[probe] subcommands ...
drift` block. ACP findings use a dedicated `category: "acp-entrypoint-drift"` finding
(scan line ~607), never the request-tool drift category. On this host both native
entrypoints are present, so no ACP drift finding fires; the drift *path* is proven by the
unit test below that forces an absent binary.

### Focused test run (the step's 9 added tests)

`npx vitest run src/__tests__/upstream-contracts.test.ts -t "ACP upstream entrypoint contracts"`:

```
Test Files  1 passed (1)
     Tests  9 passed | 33 skipped (42)
```
`VITEST_EXIT:0`. Verbose reporter confirmed all 9 `✓` ACP lines (names in the table below).

### Full test file (no regression to existing upstream-contract tests)

`npx vitest run src/__tests__/upstream-contracts.test.ts`:

```
Test Files  1 passed (1)
     Tests  42 passed (42)
```
`EXIT:0`. The pre-existing 33 tests stay green; the 9 new ACP tests pass alongside them.

### Production build (the compile gate)

`npx tsc --noEmit -p tsconfig.build.json` → `BUILD_TSC_EXIT:0`. The modified
`src/upstream-contracts.ts` compiles clean under the build config (which excludes
`src/__tests__`, the gate used by `npm run build`).

### Commit-message count note (cosmetic, not a failure)

`a937f02`'s message says "10 new non-vacuous unit tests"; the actual count of added
`it(` blocks is **9** (`git show a937f02 -- ...test.ts | grep -cE '^\+\s+it\(' = 9`).
Off-by-one in the commit prose only; all 9 added tests exist, run, and pass. No
validation row depends on the count.

## Claim-by-claim verification (each cites file:line + test name + digest)

### Requirement A claims

| Claim | Source proof | Test / command proof |
|---|---|---|
| ACP entrypoint contract exists for all 5 providers, mirroring matrix status | `ACP_ENTRYPOINT_CONTRACTS` `src/upstream-contracts.ts:260-325` (mistral=native:264, grok=native:276, codex=adapter_mediated_deferred:290, claude=adapter_mediated_deferred:303, gemini=absent_watchlist:316) | `upstream-contracts.test.ts:620` "declares an ACP entrypoint contract for every provider with the matrix status" — exact-literal `expected[cli]` map, `.toBe(...)` |
| Offline contracts-check asserts ACP contracts + report mirror, network-free | `scripts/upstream-scan.mjs:173-205` (block 2b: per-CLI presence, status mirror, native-must-have-probe, non-native-must-not) | `npm run upstream:contracts` → `contracts-check OK: 5 providers ... (offline)`, exit 0 |
| ACP entrypoint surfaces in report under `acpEntrypoint`, separate from request flags | `serializeAcpEntrypointContract` `src/upstream-contracts.ts:3114-3128`; wired at `buildUpstreamContractReport` line 3192 | `upstream-contracts.test.ts:689` "surfaces ACP entrypoint metadata in the report under acpEntrypoint, separate from request flags" — asserts `acpEntrypoint.status`/`.native` per provider |

### Requirement B claims

| Claim | Source proof | Test / command proof |
|---|---|---|
| `acpInstalledProbe` is a top-level report key distinct from `installedProbe` | `buildUpstreamContractReport` `src/upstream-contracts.ts:3202-3210` (two separate keys) | `upstream-contracts.test.ts:703` "emits acpInstalledProbe separately from request-tool installedProbe only when probing" — `expect(probed.acpInstalledProbe).not.toBe(probed.installedProbe)`; null when not probing |
| Live `--probe-installed` prints ACP drift in its own section | `scripts/upstream-scan.mjs:584-613` (`[acp-probe]` block + `category: "acp-entrypoint-drift"` finding) | live scan digest above: `[acp-probe]` lines distinct from `[probe] subcommands ... drift` |
| Native entrypoint drift is detected (not a no-op) when binary absent | `probeInstalledAcpEntrypoint` `src/upstream-contracts.ts:3043-3108` (`entrypointDrift = !anyProbeSucceeded`, line 3104) | `upstream-contracts.test.ts:730` "probeInstalledAcpEntrypoint reports native entrypoint drift when the binary is absent" — forces nonexistent binary, asserts `available===false`, `entrypointDrift===true`, `warnings.length>0` |
| Adapter/absent providers are NOT probed (no spawn) | early return `src/upstream-contracts.ts:3052-3065` when `status !== "native"` | `upstream-contracts.test.ts:721` "probeInstalledAcpEntrypoint does not spawn anything for adapter/absent providers" — `available===null`, `checkedProbeCommands===[]` for codex/claude/gemini |

### Safety constraints from the step action (kept safe, read-only, no allowlist widening)

| Constraint | Source proof | Test proof |
|---|---|---|
| Probes are read-only `--version`/`--help` only; never the bare live ACP process | `probeArgs` are `[["--version"],["--help"]]` (mistral:268) and `[["agent","stdio","--help"]]` (grok:282); `probeInstalledAcpEntrypoint` runs only `contract.probeArgs` | `upstream-contracts.test.ts:658` "only native providers declare a read-only probe, and probes never start the live ACP process" — asserts every probe contains `--version`/`--help` AND `JSON.stringify(probe) !== JSON.stringify(entrypointArgs)` |
| Tracking does NOT widen any request argv allowlist | ACP data is a separate `ACP_ENTRYPOINT_CONTRACTS` record; `validateUpstreamCliArgs` reads `UPSTREAM_CLI_CONTRACTS` only | `upstream-contracts.test.ts:681` "does NOT widen any request argv allowlist" — `validateUpstreamCliArgs("grok", ["-p","hello","agent","stdio"])` → `result.ok === false` |
| No shell eval; spawn is array-arg | `spawnSync(resolved.command, resolved.args, {...})` `src/upstream-contracts.ts:3074-3081` — no `shell:true`; uses existing `resolveCommandForSpawn` | grep of new code: no `shell:true`, no `exec/execSync`, no `console.log` |
| agy stays watchlist with no ACP surface at 1.0.7 | gemini entry `status:"absent_watchlist"`, `executable:"agy"`, `entrypointArgs:[]`, `probeArgs:[]` (lines 316-320) | `upstream-contracts.test.ts:649` "keeps agy on the watchlist with no ACP surface at agy 1.0.7" |
| No adapter labelled native; codex/claude carry adapter candidates only | codex:290 / claude:303 `adapter_mediated_deferred`, `adapterCandidates` 295/308 | `upstream-contracts.test.ts:636` "pins native entrypoints to vibe-acp and `grok agent stdio`, no adapter labelled native" — `.not.toBe("native")` for codex/claude, candidates length > 0 |

## Non-vacuity confirmation (no mutation probe required; read-confirmed)

Tests are real, not green-by-construction:

- Status tests compare against an explicit `expected` literal map with `.toBe(...)`
  exact-equality (test:620, :689), not existence checks. Wrong literals fail.
- The drift test (test:730) **mutates the contract to point at a nonexistent binary**
  and asserts the probe flips `available` false / `entrypointDrift` true / `warnings`
  non-empty, then restores in a `finally`. A no-op probe (always "available") would fail
  this. This is the load-bearing proof that Requirement B's drift path is live, not stubbed.
- The no-spawn test (test:721) asserts `checkedProbeCommands === []` and `available === null`
  for adapter/absent providers — a probe that spawned anyway would populate these.
- The allowlist-non-widening test (test:681) calls the **real** `validateUpstreamCliArgs`
  with the Grok ACP entrypoint tokens (`agent stdio`) as request argv and asserts rejection;
  a leak between the two surfaces would make `result.ok` true and fail the test.
- The read-only probe test (test:658) pairs a positive assertion (`--version`/`--help`
  present) with a negative one (`probe !== entrypointArgs`) — a probe equal to the bare
  live entrypoint fails. A stub cannot satisfy both.
- Tests import real symbols (`ACP_ENTRYPOINT_CONTRACTS`, `probeInstalledAcpEntrypoint`,
  `buildUpstreamContractReport`, `validateUpstreamCliArgs`) from the unit under test; no
  internal mocking. The build (`tsconfig.build.json`, exit 0) compiles the same source.

## Validation rows summary

| Row | Result |
|---|---|
| `npm run upstream:contracts` passes offline | PASS (`contracts-check OK: 5 providers ... (offline)`, exit 0) |
| Live probe mode reports ACP entrypoint drift separately from request-tool command drift | PASS (separate `[acp-probe]` section + `acp-entrypoint-drift` category; drift path proven by test:730) |
| Step's 9 unit tests | PASS (9/9 green; full file 42/42) |
| Production build compiles | PASS (`tsc -p tsconfig.build.json` exit 0) |

vacuousTests: none. failures: none.
