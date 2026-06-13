# Verification report — step `add-acp-process-manager`

Plan: `docs/plans/first-class-acp-gateway-extension.dag.toml`
Step id: `add-acp-process-manager`
Verifier: independent (does not trust implementer)
Branch/worktree: `feat/acp-phase-b`
Commit under test: `9a84770 feat(acp): add ACP provider process manager`
Date: 2026-06-13

## Verdict

- Step validation clause: **PASS** — all five behavioral claims are backed by code and by a non-vacuous test.
- Mutation-probe audit: **PASS** — 11/11 mutations of the covered code paths produced a failing test. No vacuous tests.
- `validationPassed = true`.
- Non-blocking finding: the ACP source files (including this step's `process-manager.ts`) fail `npm run format:check`. This does not affect the step's `validation` rows but does break the `npm run check` release gate. Recorded below.

## Files under verification

- Implementation: `src/acp/process-manager.ts` (committed, clean working tree, `git diff --check` clean).
- Tests: `src/__tests__/acp-process-manager.test.ts` (committed, clean). 17 tests, all passing.

## Step validation clause → code + test citations

Validation clause (verbatim): "Tests assert argv is passed without shell parsing, cwd is
controlled, provider-specific env isolation can be applied, idle timeout kills the process,
and crashed process state is reported to callers."

### 1. argv is passed without shell parsing
- Code: `src/acp/process-manager.ts:226` `resolveProviderSpawn` returns `{command, args}` as an executable + argv array (`:266-272`); `:178` `SHELL_METACHARACTERS` regex; `:180` `assertSafeExecutable` rejects shell strings; `:251` it is invoked on the resolved command; `:283` the default spawner sets `shell: false`.
- Test: `src/__tests__/acp-process-manager.test.ts:184` `passes argv as an array with no shell parsing (grok agent stdio)` — asserts `args` equals `["agent","stdio"]` and is never a single concatenated string.
- Test: `:203` `rejects a shell-style command with metacharacters` — asserts `resolveProviderSpawn` throws `AcpError` for `"vibe-acp; rm -rf /"`.

### 2. cwd is controlled
- Code: `src/acp/process-manager.ts:269` `cwd: cwd ?? \`${tmpdir()}/llm-gateway-acp-${provider}\`` — caller-supplied cwd used verbatim, else a per-provider OS temp dir; never derived from provider/prompt input.
- Test: `:215` `uses the provided cwd verbatim and a temp cwd otherwise` — asserts explicit cwd is preserved and the default starts with `tmpdir()`.
- Test: `:256` `spawns with the controlled cwd and argv and initializes` — asserts `resolved[0].cwd === "/disposable/workspace"`.

### 3. provider-specific env isolation can be applied
- Code: `src/acp/process-manager.ts:198` `buildProviderEnv`; `:209-213` Grok `isolatedLeaderSocket` sets `GROK_LEADER_SOCKET` to a per-process socket path under the OS temp dir (data-only, never a shell string).
- Test: `:225` `applies Grok leader-socket isolation when enabled` — asserts `env.GROK_LEADER_SOCKET` is a string containing `tmpdir()`.
- Test: `:235` `does not set leader socket isolation when disabled` — asserts the var is undefined when the flag is off.
- Test: `:244` `inherits the base env ... and extends PATH` — asserts a base credential ref survives and `PATH` is set (supports the provider-matrix note that Grok credential lookup is CLI-managed).

### 4. idle timeout kills the process
- Code: `src/acp/process-manager.ts:528` `armIdleTimer`; `:536-548` timer re-arms while requests are in flight (`transport.pendingCount > 0`) and otherwise calls `:547` `this.shutdown("SIGTERM")`.
- Test: `:332` `kills the process after the idle window with no in-flight requests` — fake timers; after advancing the idle window asserts the child was killed, `isHealthy() === false`, and `state === "quarantined"`.

### 5. crashed process state is reported to callers
- Code: `src/acp/process-manager.ts:559` `handleExit` records `_exitCode`/`_signal`, sets `state = "exited"`, propagates exit to the transport (`:573`), builds an `AcpProcessExitError` and stores it in `_terminalError` (`:579`), and notifies callbacks via `:586` `client.notifyProcessExit(error)`. `:590` `handleSpawnError` does the equivalent for spawn `error` events with state `"quarantined"`.
- Test: `:363` `reports crashed process state to callers via terminalError and onProcessExit` — asserts `state==="exited"`, `exitCode===139`, `signal==="SIGSEGV"`, `terminalError instanceof AcpProcessExitError`, and the `onProcessExit` callback fired once.
- Test: `:393` `rejects a pending request after the process exits` — asserts an in-flight `transport.request` rejects with `AcpProcessExitError` after exit.
- Test: `:408` `surfaces a spawn 'error' event as a quarantined terminal error`.

## Additional security/spec invariants covered by this step's tests

- Fail-closed when spawn produces no stdio: code `:339-351`; test `:290` `fails closed with a typed error when spawn produces no stdio`.
- Initialize-timeout quarantine (process not left live): code `:371-381`; test `:310` `propagates a typed initialize timeout and quarantines the process`.
- Kill-all on gateway shutdown: code `:390-395` `shutdownAll`; test `:430` `kills every live process on gateway shutdown`.
- `stdout_reserved_for_mcp` security invariant: the manager never writes gateway stdout; test `:256` asserts `stdoutWrites` is empty across spawn/initialize (beforeEach spy at `:167-176`).
- Read-only smoke posture (no HostServices side effects during start): code initialize advertises all-false client capabilities (`src/acp/client.ts:248` initialize); test `:460` `never writes a hostServices method during start (read-only smoke posture)`.

## Command-output digests

- `npm run build` (tsc -p tsconfig.build.json): exit 0. Production code compiles, including `dist/config.js` ACP exports (`grep -ac DEFAULT_ACP_PROCESS_IDLE dist/config.js` = 3).
- `npx eslint src/acp/process-manager.ts`: 0 errors, 1 warning (`security/detect-object-injection` at `:232`, consistent with codebase-wide pattern; non-blocking).
- `npx vitest run src/__tests__/acp-process-manager.test.ts`: `Test Files 1 passed (1)`, `Tests 17 passed (17)`.
- Combined ACP suite (`process-manager` + `acp-client` + `acp-json-rpc-stdio`): `Tests 44 passed (44)`.
- `git diff --check`: clean.

### Dependency-surface checks (consumed by this step, present and committed)
- `src/config.ts:615-701` exports `ACP_TRANSPORTS`, `DEFAULT_ACP_PROCESS_IDLE_TIMEOUT_MS`, `DEFAULT_ACP_INITIALIZE_TIMEOUT_MS`, `AcpConfig`, `AcpProviderConfig`, `loadAcpConfig`.
- `src/acp/client.ts`: `HostServices` (`:91`), `AcpClientCallbacks.onProcessExit` (`:130/:141`), `isInitialized` (`:232`), `agentInfo` (`:237`), `notifyProcessExit` (`:514`).
- `src/acp/json-rpc-stdio.ts`: `handleProcessExit` (`:466`), `pendingCount` (`:530`), `dispose` (`:516`), `request` (`:340`).
- `src/acp/errors.ts`: `AcpError` (`:145`), `ProviderUnavailableError` (`:225`), `AcpProcessExitError` (`:281`).
- `src/executor.ts`: `getExtendedPath` (`:162`), `envWithExtendedPath` (`:166`).

## Mutation-probe audit (test-veracity)

Performed in a throwaway detached worktree at the step commit (`git worktree add --detach /tmp/acp-pm-mutation 9a84770`), node_modules symlinked from the primary checkout, worktree removed afterward (`git worktree remove --force` + prune; confirmed gone). Each mutation was applied, the test file run, the result observed, then reverted (`git checkout --`). The baseline (17/17 pass) was re-confirmed before and after.

| # | Mutated code path (`process-manager.ts`) | Failing test (expected guard) | Result |
|---|---|---|---|
| 1 | `:181` neuter `assertSafeExecutable` shell-metachar guard (`if (false && ...)`) | `rejects a shell-style command with metacharacters` | FAILED as expected |
| 2 | `:269` always use tmpdir for cwd (drop `cwd ??`) | `uses the provided cwd verbatim ...` + `spawns with the controlled cwd and argv ...` | FAILED as expected (2 tests) |
| 3 | `:212` drop `GROK_LEADER_SOCKET` assignment | `applies Grok leader-socket isolation when enabled` | FAILED as expected |
| 4 | `:547` remove idle-timer `shutdown("SIGTERM")` | `kills the process after the idle window ...` | FAILED as expected |
| 5 | `:579/:586` skip `_terminalError` + `notifyProcessExit` in `handleExit` | `reports crashed process state to callers via terminalError and onProcessExit` | FAILED as expected |
| 6 | `:339` disable no-stdio fail-closed guard | `fails closed with a typed error when spawn produces no stdio` | FAILED as expected |
| 7 | `:358` invoke `hostServices.writeTextFile` during `start` (violate read-only smoke) | `never writes a hostServices method during start (read-only smoke posture)` | FAILED as expected |
| 8 | `:353` `process.stdout.write(...)` during start (violate stdout-reserved invariant) | `spawns with the controlled cwd and argv and initializes` (stdoutWrites assertion) | FAILED as expected |
| 9 | `:374` skip `shutdown` + `live.delete` on initialize failure | `propagates a typed initialize timeout and quarantines the process` | FAILED as expected |
| 10 | `:391` make `shutdownAll` a no-op (no per-child signal) | `kills every live process on gateway shutdown` | FAILED as expected |
| 11 | `:573` drop `transport.handleProcessExit(code, signal)` | `rejects a pending request after the process exits` | FAILED (test timed out at 120s — pending request never rejected) |

All 11 mutations were detected. **No vacuous tests.**

## Non-blocking finding (release-gate hygiene, outside this step's validation rows)

`npm run format:check` fails on every ACP source file, including this step's `src/acp/process-manager.ts`
(also `client.ts`, `json-rpc-stdio.ts`, `types.ts`). The committed `.prettierrc` sets `printWidth: 100`,
but the ACP files were formatted at ~80-column width; prettier 3.8.3 wants to re-collapse those lines.
Non-ACP committed files (`src/config.ts`, `src/executor.ts`) pass `format:check` cleanly, so this is
specific to the ACP files and not a tooling-config drift.

This does not affect any of the step's behavioral `validation` rows (all tests pass and are non-vacuous),
so it does not flip `validationPassed`. It is recorded because `npm run format:check` is part of the
`npm run check` release gate (`release_gates.local_commands`) and the step pre-commit checklist; it should
be fixed (`npm run format`) before the slice's release gate.
