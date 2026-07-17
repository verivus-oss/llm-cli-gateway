# Plan: close the runtime subcommand-help-probe fail-open (F4) - v2

Status: DRAFT v2, revised per cross-LLM review (Codex + Grok, both "sound-with-changes",
both code-cited). Branch: feat/personal-agent-config-kit-and-hardening (base HEAD 19cfb4e).

## 0. What v2 changed (from the review)

Two independent reviewers converged on ONE blocker and several required changes:

- BLOCKER (both): the shared predicate `subcommandHelpProbeIsUntrusted(sub, result)`
  reads `result.available`, but the runtime holds a RAW `spawnSync` result with no
  `available` field. Calling it directly makes `!result?.available` truthy and marks
  EVERY probe (including clean exit-0) untrusted, inverting the bug. Fix: normalize to
  `{ available: !result.error, status: result.status }` at every runtime call site, and
  document that shape as the predicate's input contract. See v2 section 3.
- Schema wording was wrong: the `upstream` object is `additionalProperties:false`
  (`setup/status.schema.json:646-674`); only the nested `contracts`/`probe_report`
  blobs are open. New probe fields land inside `probe_report`, so still NO schema change
  needed, but the plan must not claim the upstream node is open. See v2 section 1.
- Build-order / coverage hazard (Codex): `npm run upstream:contracts` runs
  `runContractsCheck` and NEVER exercises the installed-probe path
  (`upstream-scan.mjs:1817`); `loadMachinery` only checks that `dist` exists, not that
  it is fresh or exports the new symbol. So "upstream:contracts runs clean" proves
  nothing about the wiring. Fix: add a fail-fast export assertion in `loadMachinery`
  AND a built-dist test that asserts the symbol exists. See v2 sections 3g and 4.
- Root parity is not what folding runtime warnings gives (both): the scanner
  `probeInstalledCliSurface` folds THREE sources (declared `helpArgs` nonzero, a
  SEPARATE literal root `--help` probe, and subcommands). The runtime only runs
  `contract.helpArgs`, and for Codex those are `exec --help` / `exec resume --help`,
  NOT `codex --help` (`upstream-contracts.ts:1060-1063`). Decision v2: this slice
  closes the SUBCOMMAND + helpArgs-loop fail-open and explicitly does NOT add the
  scanner's separate root `--help` discovery probe (that is execution-body expansion,
  out of scope). We therefore claim "fail-open closed", NOT "full surface parity".
  See v2 section 3c.
- The mutation-test plan was inadequate (both). v2 section 4 replaces it with wiring +
  handler + doctor + built-dist tests, each mutation-anchored.

## 1. Problem (evidence, verified by two reviewers)

Round 10 hardened `scripts/upstream-scan.mjs` (the build-time `--require-installed`
gate). The runtime probe used by `doctor` and the `upstream_contracts` /
`provider_subcommand_*` MCP tools is a SEPARATE implementation
(`src/upstream-contracts.ts` `probeInstalledCliSubcommands` :4211, sole caller
`probeInstalledCliContract` :4190) and was not fixed.

- `InstalledCliSubcommandProbe` (:4085-4100) has no `helpExitedNonzero`.
- Probe body (:4238-4248): a spawn error sets `available=false` + warning + `break`;
  a nonzero exit only warns and NEVER flips `available`; a `helpProbeExitTolerant`
  subcommand suppresses even the warning. `available` staying true means the help text
  is still parsed for drift (:4251-4267).
- `provider_subcommand_drift` (`src/index.ts:21075-21082`):
  `drifted = !sub.available || sub.extraFlags.length>0 || sub.missingFlags.length>0`,
  default `includeClean=false` (:21063-21066) drops clean rows.

The exact fail-open (both reviewers): a nonzero exit whose help text still parses into
matching flags => `available:true`, `drifted:false`, row DROPPED. (Spawn-fail already
surfaces via `!available`; nonzero-exit WITH flag mismatch already surfaces via
missing/extra. Only nonzero-exit-but-parses-clean is invisible.)

Other consumers (`buildUpstreamContractReport` :4399, `doctor` :1274-1382 whose `ok`
is only flipped by HTTP-auth :1377 and personal_config :1381, CLI `contracts`) attach
the probe raw with NO verdict; both failure modes are purely informational there. No
`--require-installed`/`helpExitedNonzero`/`criticalCount` exists in `src/**.ts`.

## 2. Root cause + DRY decision (Option B, endorsed by both reviewers)

F4 exists because the trust decision is DUPLICATED. Fix once:

- Define and export `subcommandHelpProbeIsUntrusted(subcommand, result)` in TS
  (`src/upstream-contracts.ts`), input contract `{ available: boolean; status: number|null }`,
  round-10 semantics: not-available => untrusted regardless of tolerance; else untrusted
  iff not `helpProbeExitTolerant` and `status !== 0`; clean run => trusted.
- Runtime uses it (with normalization, section 3).
- `scripts/upstream-scan.mjs` imports it via `loadMachinery()` (as
  `machinery.subcommandHelpProbeIsUntrusted`) and DELETES its own copy. Layering is
  one-way (scripts to dist; `upstream-contracts` imports only provider-definitions +
  executor; no cycle, verified by both reviewers).

Option A (independent runtime copy + a truth-table agreement test) is the fallback only
if we reject any scripts-to-runtime dependency (already present via loadMachinery), and it
re-creates the duplication that caused F4. Recommend B.

## 3. Scope (Option B)

### 3a. Types (`src/upstream-contracts.ts`)
- `InstalledCliSubcommandProbe` (:4085): add `helpExitedNonzero: boolean`.
- `InstalledCliContractProbe` (:4102): add `helpExitedNonzero: boolean` (rolled-up).

### 3b. Predicate
- Add + export `subcommandHelpProbeIsUntrusted` in `src/upstream-contracts.ts` with the
  documented `{available,status}` input contract and round-10 truth table.

### 3c. Runtime probe body: NORMALIZE, keep branches separate
`probeInstalledCliSubcommands` (:4211), per-subcommand `let helpExitedNonzero = false`:
- Spawn-error branch (:4238): keep `available=false` + warning + `break`, AND set
  `helpExitedNonzero = subcommandHelpProbeIsUntrusted(sub, { available:false, status:result.status })`
  (=> true) before break.
- Nonzero/clean branch (:4243): replace `if (result.status !== 0 && !sub.helpProbeExitTolerant)`
  with
  `if (subcommandHelpProbeIsUntrusted(sub, { available:true, status:result.status })) { helpExitedNonzero = true; warnings.push('... exited with status N ...'); }`
  (spawn already succeeded here, so `available:true` is correct; do NOT reuse the raw
  result object).
- Emit `helpExitedNonzero` on the probe object (:4257-4272).

`probeInstalledCliContract` (:4128):
- helpArgs loop nonzero (:4173): fold into a surface `let helpExitedNonzero` via the
  same normalized predicate (`{available:true, status:result.status}`). NOTE these are
  `contract.helpArgs` (for Codex `exec --help`, not `codex --help`); we fold them, we do
  NOT add a separate root `--help` discovery probe (out of scope; we claim fail-open
  closure, not full scanner surface parity).
- Early spawn-error return (:4153-4170): return `helpExitedNonzero` (the accumulator),
  NOT a hard-coded `false`. `available:false` carries this probe's spawn failure, but
  `contract.helpArgs` can hold more than one entry (Codex: `exec --help` +
  `exec resume --help`); if an EARLIER entry spawned and exited nonzero, that untrusted
  signal must survive a later entry's spawn failure. (Implementation refinement from the
  round-1 cross-LLM review, Grok Medium; v2 draft originally said `false`, which dropped
  the prior nonzero exit. The accumulator is only ever true after a successful spawn with
  a nonzero/null status, so it never false-positives.)
- Success return (:4192-4208):
  `helpExitedNonzero: helpExitedNonzero || Object.values(subcommands).some(p => p.helpExitedNonzero)`
  (OR-fold; a partial multi-helpArgs failure stays true).

### 3d. Consumer 1: `provider_subcommand_drift` (`src/index.ts:21075-21082`) [closes the fail-open]
- `drifted = !sub.available || sub.helpExitedNonzero || sub.extraFlags.length>0 || sub.missingFlags.length>0`.
- Add `helpExitedNonzero: sub.helpExitedNonzero` to the emitted row.
- Update the tool/`includeClean` description to say drift now includes "untrusted help
  exit". Keep `provider-subcommand-drift.v1` (no in-repo consumer asserts the version;
  additive field, additive rows: semantic expansion, not a structural break).

### 3e. Consumer 2: `doctor` (`src/doctor.ts`)
- Field flows into `probe_report` for free. Do NOT flip `report.ok` (matches scanner's
  opt-in `--require-installed`; doctor is advisory, missing CLIs only add next_actions
  :1410). No strict flag this slice.
- When `probeUpstream` and any probed CLI has `helpExitedNonzero` OR a subcommand
  `available:false`, add ONE specific `next_actions` entry ("re-probe <cli>: an installed
  help probe exited nonzero or could not run; its contract is unverified"). Gate on both
  conditions so the "could not run" wording is honest. Do not duplicate the existing
  generic "see probe_report" line.

### 3f. `buildUpstreamContractReport` / `upstream_contracts` / CLI `contracts`
- No verdict logic (deliberate raw serializers). New fields flow through automatically.
  Schema unaffected: fields live inside `probe_report` (`additionalProperties:true`),
  and the closed `upstream` object gains nothing.

### 3g. Build-order fail-fast (`scripts/upstream-scan.mjs` loadMachinery :103)
- After importing, assert `typeof machinery.subcommandHelpProbeIsUntrusted === 'function'`
  and exit 2 with "stale dist; run npm run build" if absent. This turns a stale/missing
  dist into a loud failure instead of a silently-wrong scan.

## 4. Test plan (mutation-anchored; replaces v1's inadequate "upstream:contracts runs clean")

1. Predicate unit (TS): round-10 truth table on the `{available,status}` contract.
2. Runtime wiring, EXIT-0 (regression guard for the invert-the-bug blocker): mock the
   probe's spawn to return `{status:0}` (no error); assert probe.helpExitedNonzero===false
   AND contract.helpExitedNonzero===false. Mutation: pass the raw result unnormalized =>
   this test fails.
3. Runtime wiring, spawn-fail: mock `{error}`; assert probe.available===false AND
   probe.helpExitedNonzero===true. Mutation: drop the spawn-fail assignment => fails.
4. Runtime wiring, nonzero-exit non-tolerant: mock `{status:1, stdout:<parseable help>}`;
   assert probe.helpExitedNonzero===true and available stays true.
5. Runtime wiring, nonzero-exit TOLERANT: assert helpExitedNonzero===false.
6. Contract-level helpArgs nonzero fold: mock a helpArgs probe exiting nonzero; assert
   contract.helpExitedNonzero===true. Early root spawn-fail: assert the early return
   carries helpExitedNonzero===false with available===false.
7. Handler test for `provider_subcommand_drift` (NOT a pure helper): synthesize a probe
   with sub `{available:true, helpExitedNonzero:true, extraFlags:[], missingFlags:[]}` and
   default includeClean=false; assert the row IS present with driftStatus:"drift" and the
   new field. Mutation: remove `|| sub.helpExitedNonzero` from the handler => fails.
8. `createDoctorReport` test with an injected/mocked probe_report: helpExitedNonzero =>
   the specific next_action present AND `ok` unchanged; a clean probe => no action.
9. Scanner parity: repoint `src/__tests__/upstream-scan.test.ts` predicate import to the
   TS module (the scripts copy is deleted); add a test that loads the BUILT dist and
   asserts `subcommandHelpProbeIsUntrusted` is exported (guards 3g + build order).
10. Full suite + `npm run check` (provider surfaces + site generate stay green; the new
    tool-output field is additive, input schemas unchanged).

## 5. Risks / non-goals
- Additive fields only; `drifted` becomes true in one more (intended) case. No field
  removed/renamed. Keep `provider-subcommand-drift.v1`.
- doctor `ok` semantics unchanged by default.
- `helpProbeExitTolerant` preserved for nonzero-exit; spawn-fail untrusted even when
  tolerant (round-10 F3 parity).
- OUT OF SCOPE, noted: the scanner's separate root `--help` discovery probe (no full
  surface parity claim); `versionHint` is not exit-0-gated like the scanner's
  `parseTrustedInstalledVersion` (separate parity gap); unifying the two probe EXECUTION
  bodies (only the trust PREDICATE is shared).

## 6. Deliverable
One PR/commit on the current branch, message referencing Codex F3/Grok F4 and the plan
review. Cross-LLM review to unconditional approval before merge.

## 7. Non-blocking implementation notes (from the v2 confirmation review, Grok UNCONDITIONAL APPROVAL)

These do not reopen F4 but should be honored during implementation:

- Explicitly mutation-anchor the contract-level OR-fold: add an assertion (in test 6 or
  a dedicated case) that `contract.helpExitedNonzero` is true when ONLY a subcommand is
  untrusted (root/helpArgs clean). Without it, dropping
  `helpExitedNonzero || Object.values(subcommands).some(...)` would weaken the
  doctor/CLI-level signal while the drift handler still passes.
- `CreateDoctorReportOptions` (`src/doctor.ts:882`) currently exposes only
  `probeUpstream?: boolean`, no probe-report injection. The doctor test (item 8) should
  mock via `vi.mock` of `buildUpstreamContractReport` rather than an inject option; this
  is a test mechanism, not a plan defect.
- Inlining an equivalent truth table in the runtime instead of calling the shared export
  is a DRY-only regression (F4 stays closed); Option B code review is the guard. No extra
  test required.

Plan review status: v1 Codex + Grok = sound-with-changes (converged on the normalization
blocker); v2 Grok = UNCONDITIONAL APPROVAL. Mistral flaked (0-byte) on both the diff and
plan reviews; Cursor flaked (1-byte) twice earlier. Ready to implement.
