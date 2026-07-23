# Tier-B T4 (terminal-envelope driver): verification notes

Corrective-program evidence log for the T4 slice. Base commit: `e94ae13`
(master, post T0/T0.5/T0.1/T1/T2/T3). Branch: `feature/prep-pipeline-tier-b-t4`.
Every anchor is `src/index.ts` unless noted.

Source-of-truth artifacts:

- Design: `docs/plans/request-pipeline-tier-b-t4-driver.design.md` (rev 3)
- DAG: `docs/plans/request-pipeline-tier-b-t4-driver.dag.toml`
- Spec being amended: `docs/plans/request-pipeline-tier-b-handler-envelope.spec.md`

---

## Phase A

### Step: refresh-anchors-audit (doc / evidence only, no product change)

Verified every anchor against live code at HEAD `e94ae13`. The design doc's
`~NNNN` numbers sit ~200..600 lines below the real code; the DAG's corrected
table is authoritative and was re-verified line-by-line. Result: the DAG's
anchor table is CORRECT at `e94ae13`; no anchor moved. Scaffold confirmed absent.

Structural markers:

- `RequestTerminalLedger` class: `src/index.ts:2266`.
- `FlightOwnership` class: `src/index.ts:2404`.
- `handleClaudeRequest`: `src/index.ts:9706`.
- `handleCodexRequest`: `src/index.ts:10499`.

Scaffold-absence grep (expect 0 in `src/`): `runKitTerminalEnvelope`,
`KitTerminalEnvelope`, `KitStageOutcome`, `KitTerminalHooks` => 0 matches in
every `src/**` product and test file. The rejected 0..12 scaffold is gone.

#### Claude (`handleClaudeRequest` 9706..10452), verified anchors

- `sessionManager = deps.sessionManager` (9711). This is the claude
  usage/failure manager.
- States 0..3 inline early returns: mutual-exclusion guards 9768/9779; kit
  resolve catch 9842..9845 (id `claude_request`); projected-session-args catch
  9878..9880; sessionId utf8 assert catch 9907..9909; prep non-`args` return
  9968..9972; kit artifact/session materialize catch 10002..10007;
  `insertAndAdmitFinalSessionArgs` catch 10020..10024 (fires `baseRequestCleanup`
  10021); session-resolve catch 10036..10046 (fires `ledger.requestCleanup?.()`
  10043).
- `baseRequestCleanup` composed 10009; `ledger = new RequestTerminalLedger`
  10016. `kitJobHandedOff` local declared 10088 (BEFORE the main try).
- Main try open: **10089**.
- Nested worktree-resolve try/catch: **10093 / 10105**, on catch fires
  `ledger.requestCleanup?.()` (10106) + `discardPendingPersonalKitSession`
  (10107) + return `kitAwareErrorResponse("claude_request", ...)` (10108). NO
  rollback, NO `flight.completeInline`.
- `applyEffectiveWorkingDirectory` + `assertUpstreamCliArgs/Env` +
  `assertFinalCliProcessAdmission` (10110..10121): throw reaches the main catch.
- Session admission (10122..10150) and worktree materialize (10151..10168):
  throw reaches the main catch.
- `ledger.installWorktree(...)` **10169**; `flight.start()` **10172**; claude
  `invoked with ...` `logger.info` **10173..10175** (AFTER `flight.start()`).
- Pre-`awaitJobOrDefer` state-9 setup (idle timeout / effectiveCompress /
  FR-handoff) 10177..10195; execute (`runWithPersonalKitAttemptLease` wrapping
  `awaitJobOrDefer`) 10196..10238; `kitJobHandedOff` recompute 10239.
- Deferred branch: `flight.transferCompletionToManager()` **10248** BEFORE
  `ledger.settle` (10250); `sessionAdmissionCommitted = true` 10249; usage-if-
  `!kitSession` via `sessionManager` (deps) 10251..10253; warnings-decorate
  10255..10257.
- Inline failure branch: `rollbackOnFailure(kitSession, sessionManager)`
  **10265** (`sessionManager` is deps); `buildTerminalCliFailure("claude", ...)`
  10266; gated `finalizePersonalKitSessionOrThrow` (completed:false,
  terminalMetadata:null, initialNativeSessionId) 10267..10278; failed
  `flight.completeInline` 10280; `kitAwareErrorResponse("claude", ...)` +
  warnings 10292..10307.
- Inline success branch: `sessionAdmissionCommitted = true` 10310;
  `ledger.settle` 10311; usage-if-`!kitSession` via `sessionManager` (deps)
  10312..10314; log 10316; gated finalize (completed:true, terminalMetadata =
  `createPersonalKitTerminalMetadata`, initialNativeSessionId) **10318..10329**
  BEFORE parse (`parseStreamJson` **10332**); dual stream-json vs json/text build
  each with its OWN `flight.completeInline` (10352 / 10396). finalize-before-parse
  order confirmed.
- catch (10428): `rollbackOnException(kitSession, runtime.sessionManager)`
  **10429**; `cleanupOnException(kitJobHandedOff, error, kitSession, true)`
  **10430** (fire is true); no-op `flight.completeInline` 10436;
  `kitAwareErrorResponse("claude", ...)` 10446.
- finally (10447): `ledger.worktreeLifecycle?.finishHandler()` **10448**;
  `recordRequest("claude", ...)` **10450**.

Claude manager mapping => usageUpdateManager = failureRollbackManager =
`deps.sessionManager`; exceptionRollbackManager = `runtime.sessionManager`;
fireRequestCleanupInCatch = true. Matches design 2.2 and matrix section 4.

#### Codex (`handleCodexRequest` 10499..11101), verified anchors

- Kit resolve catch 10595..10598 (id `codex_request`); kit isolation/session
  catch 10666..10668; prep non-`args` return 10682..10685. `prepCleanup` bound
  10688..10689; `ledger = new RequestTerminalLedger(runtime, prepCleanup)`
  **10699** (base cleanup is `prepCleanup`).
- Session-resolution try/catch **10702 / 10714**, on catch fires `prepCleanup?.()`
  (10716) + discard (10720) + return `codex_request` (10721). This is a state-3
  prep catch; it stays inline either way (NOT one of the three state-4..8
  catches).
- **Three state-4..8 front-half catches, all OUTSIDE the main try, all NO
  metric:**
  - worktree-resolve **10728 / 10739**, fires `prepCleanup?.()` (10741) + discard
    (10745) + return `codex_request`. NO rollback.
  - argv / assert-admission **10748 / 10761**, fires `prepCleanup?.()` (10763) +
    discard (10767) + return `codex_request`. NO rollback. (The code fires the
    `prepCleanup` LOCAL, which `=== ledger.requestCleanup` here because
    `installWorktree` at 10823 has not yet recomposed `requestCleanup`: the ctor
    sets `requestCleanup = baseRequestCleanup = prepCleanup`, `src/index.ts:2283`.)
  - session-admission / materialize **10771 / 10817**, fires
    `rollbackOnFailure(kitSession, runtime.sessionManager)` (10818) +
    `ledger.requestCleanup?.()` (10819) + discard (10820) + return
    `codex_request`. worktree-materialize (10800..10816) shares THIS catch.
- `ledger.installWorktree(...)` **10823**; `flight.start()` **10848**; codex
  `invoked with ...` log 10849..10851, all OUTSIDE the main try.
- `kitJobHandedOff` local declared 10853 (BEFORE the main try).
- Main try open: **10854** (wraps states 9..12 only). Pre-`awaitJobOrDefer`
  state-9 setup (effectiveCompress / FR-handoff) 10855..10870; execute
  10871..10908; `kitJobHandedOff` recompute 10909.
- Deferred branch: `transferCompletionToManager()` **10919** BEFORE
  `ledger.settle` (10921); `sessionAdmissionCommitted = true` 10920; usage-if-
  `!kitSession` via `runtime.sessionManager` 10922..10928; bare
  `buildDeferredToolResponse` 10929 (NO decorate).
- Inline failure branch: `rollbackOnFailure(kitSession, runtime.sessionManager)`
  **10936**; `buildTerminalCliFailure("codex", ...)` 10937; gated finalize
  (completed:false, terminalMetadata:null, NO initialNativeSessionId)
  10944..10953; failed `flight.completeInline` 10956; JSONL + resume-hint
  `kitAwareErrorResponse("codex", ...)` 10972..10993.
- Inline success branch: `sessionAdmissionCommitted = true` 10996;
  `ledger.settle` 10997; usage-if-`!kitSession` via `runtime.sessionManager`
  10998..11004; log 11006; **`extractUsageAndCost("codex", ...)` 11007** +
  `deriveCostBasis` 11011 + **`extractProviderOutputMetadata("codex", ...)`
  11019**, all BEFORE gated finalize **11020..11030**; success
  `flight.completeInline` 11038 + `codexFrResponse` build 11055.
  extract-before-finalize order confirmed.
- catch (11076): `rollbackOnException(kitSession, deps.sessionManager)` **11077**;
  `cleanupOnException(kitJobHandedOff, error, kitSession, false)` **11078** (fire
  is false); no-op `flight.completeInline` 11084;
  `kitAwareErrorResponse("codex", ...)` 11094.
- finally (11095): `ledger.worktreeLifecycle?.finishHandler()` **11096**;
  `recordRequest("codex", ...)` **11098**.

Codex manager mapping => usageUpdateManager = failureRollbackManager =
`runtime.sessionManager`; exceptionRollbackManager = `deps.sessionManager`;
fireRequestCleanupInCatch = false. Matches design 2.2 and matrix section 4.

#### Shared helper / type signatures the driver body invokes (confirmed in scope)

- `RequestTerminalLedger` exposes: `requestCleanup`, `worktreeLifecycle`,
  `sessionAdmission`, `sessionAdmissionCommitted`, `installWorktree`, `settle`,
  `rollbackOnFailure(kitSession, sessionManager)`,
  `rollbackOnException(kitSession, sessionManager)`,
  `cleanupOnException(kitJobHandedOff, error, kitSession, fireRequestCleanup)`
  (2266..2372). `worktreeLifecycle.finishHandler()` is the finally call.
- `FlightOwnership` exposes: `start()`, `transferCompletionToManager()`,
  `completeInline(metadata)` (2404..2439).
- `isDeferredResponse(result): result is DeferredJobResponse` (1890).
- `awaitJobOrDefer(...)` returns `Promise<InlineJobResponse | DeferredJobResponse>`
  (1485).
- `buildDeferredToolResponse(deferred, sessionId?)` (1903).
- `safeUpdateSessionUsageAfterJobAdmission(sessionManager, sessionId, runtime)`
  (2163).
- `buildTerminalCliFailure(cli, stdout, stderr, code, outputFormat)` returns
  `{ response; errorMessage; providerSessionId?; stopReason? }` (3655).
- `kitAwareErrorResponse(operation, code, stderr, correlationId?, error?, kit,
  redaction?, jobFailure?)` (7377).
- `resolveEffectiveCompression(...)` returns `boolean` (3718).
- Types in scope in `index.ts`: `ExtendedToolResponse` (352),
  `GatewayServerRuntime` (1132), `ResolvedWorktree` (1940),
  `DeferredJobResponse` (1449), `InlineJobResponse` (1457), `CliType` (import
  55), `ISessionManager` (import 45), `PersonalKitRequestContext`,
  `PersonalKitSessionResolution`.

Type aliases the driver introduces (over real underlying types):

- `KitTerminalExecuteResult = InlineJobResponse | DeferredJobResponse` (the
  `awaitJobOrDefer` return; `isDeferredResponse` narrows it).
- `KitTerminalInlineResult = InlineJobResponse` (narrowed non-deferred arm).
- `KitTerminalFailure = ReturnType<typeof buildTerminalCliFailure>`.

Conclusion: DAG anchor table is accurate at `e94ae13`; ledger/flight/helper
signatures match what design section 2.4 invokes. No product code changed in
this step.

### Step: spec-amendment (docs-only)

`docs/plans/request-pipeline-tier-b-handler-envelope.spec.md` sections 5 (line
190) and 7 (Stage T4 bullet, line 266) no longer claim a literal 0..12 replay;
both now describe the terminal-envelope framing and the `runInsideTerminalTry`
seam, and cite `docs/plans/request-pipeline-tier-b-t4-driver.design.md`. Diff is
21 insertions / 5 deletions, docs-only. No em dash. `npm run format:check` PASS
(its scope is `src/**/*.ts` + `scripts/**`; markdown docs are outside it, so no
unrelated markdown reflow was introduced).

---

## Phase B (implementation)

### Step: introduce-driver

Added to `src/index.ts` immediately after `FlightOwnership` (now at ~2441):
`KitStageOutcome<T>` (tagged union), `KitTerminalExecuteResult`,
`KitTerminalInlineResult`, `KitTerminalFailure` type aliases, `KitTerminalEnvelope`,
`KitTerminalHooks<TFacts = undefined>`, and `runKitTerminalEnvelope<TFacts>`. The
driver body is byte-faithful to design section 2.4: exactly one try/catch/finally;
deferred transfers completion BEFORE settle (H-DoubleComplete fence);
finalize gate `kit && kitSession && !result.jobId` in both branches;
computeSuccessFacts awaited BEFORE finalizeKit on success; recordRequest fires once
in the finally. No provider literal beyond the `provider: CliType` label.
`npm run build` PASS with the driver present and (at this step) unused.

### Step: wire-claude-handler

`handleClaudeRequest` back half (former main try/catch/finally) replaced with
`env` + `hooks` + `return runKitTerminalEnvelope(env, hooks)`. States 4..8 run
INSIDE the envelope try via `runInsideTerminalTry`; the two former locals
`durationMs` / `wasSuccessful` are now driver-owned and were removed. env manager
mapping: usageUpdate = failureRollback = `deps.sessionManager` (the
`sessionManager` local); exceptionRollback = `runtime.sessionManager`;
fireRequestCleanupInCatch = true. `computeSuccessFacts` is the no-op
`() => undefined`; claude parses AFTER finalize inside `buildSuccessResponse`.
The `worktreeResolution` initializer `= {}` was dropped (dead: overwritten in the
try before any read; the catch returns without reading it) to satisfy the ESLint
`no-useless-assignment` rule; codex already used the no-initializer form.
`npm run build` PASS. Claude characterization nets GREEN and unmodified:
`claude-handler-terminal-net`, `claude-handler`, `claude-kit-preadmission`,
`claude-prep-parity`, `claude-mcp-config`, `claude-argv-golden` (115 tests).

### Step: wire-codex-handler

`handleCodexRequest` back half (former main try/catch/finally) replaced with
`env` + `hooks` + `return runKitTerminalEnvelope(env, hooks)`. States 0..8 stay
INLINE outside any envelope try, including the three dedicated non-uniform
early-return catches, `installWorktree`, `flight.start()`, and the "invoked" log.
`runInsideTerminalTry` is the trivial passthrough
`async () => ({ ok: true, value: { worktreeResolution } })`. env manager mapping:
usageUpdate = failureRollback = `runtime.sessionManager`; exceptionRollback =
`deps.sessionManager`; fireRequestCleanupInCatch = false.
`computeSuccessFacts` extracts `{ codexUsage, cost, codexMeta }` (extractUsageAndCost
+ deriveCostBasis + extractProviderOutputMetadata) BEFORE finalizeKit. One
comment em dash in the migrated `#44` block was changed to a semicolon (comment
only, no behaviour impact). The two former locals `durationMs` / `wasSuccessful`
were removed (driver-owned). `npm run build` PASS. Codex characterization nets
GREEN and unmodified: `codex-handler-terminal-net`, `codex-handler`,
`codex-kit-preadmission`, `codex-argv-golden`, plus shared
`sync-terminal-failure-redaction`, `personal-config-flight-recorder-privacy`,
`async-job-manager-flight-recorder` (88 tests).

Both handlers end in `return runKitTerminalEnvelope(env, hooks)` (exactly 2 call
sites in `src/index.ts`); neither has a second try/finally around execute.

### Step: boundary-tests

New file `src/__tests__/request-pipeline-tier-b-t4-boundary.test.ts` (15 tests),
alongside the unmodified characterization nets. Observables: `recordRequest` count
(via injected `performanceMetrics` spy), response operation id
(`structuredContent.cli`), and `flight.logComplete` spy.

State 4..8 metric/cleanup boundary (design section 6, items 1..8):

- Codex (all recordRequest == 0, id `codex_request`, no flight completion):
  #1 worktree-resolve (worktree:true + allowWorktree:false), #2 argv/assert
  (assertUpstreamCliArgs mocked to throw once), #3 session-admission
  (createSession/createSessionWithMetadata spied to throw), #4 worktree-materialize
  (createWorktree mocked to throw; shares the session-admission catch).
- Claude: #5 worktree-resolve early-return via the `ok:false` seam (recordRequest
  == 1 via finally, id `claude_request`, catch NOT taken, no flight completion);
  #6 argv/assert, #7 session-admission, #8 worktree-materialize (all throw to the
  envelope catch: recordRequest == 1, id `claude`).

Terminal parity (both providers): inline success (recordRequest ==
`[provider, n, true]`, one logComplete), inline failure code!=0 (`[provider, n,
false]`, one logComplete), exception (`[provider, n, false]`, id = provider).

Codex facts-order (extract-before-finalize): a non-kit codex success whose
success-path extraction (`extractProviderOutputMetadata` for codex) throws
surfaces via the envelope catch (id `codex`); because `finalizeKit` sits AFTER
`computeSuccessFacts` in the driver, the throw provably cannot reach it (the Kit
session is left un-finalized exactly as pre-T4 codex). `wasSuccessful` was already
latched true before `computeSuccessFacts`, so the finally metric records success,
matching pre-T4 codex ordering (`wasSuccessful=true` at ~10995 precedes the
extraction at ~11007). NOTE: a durable Kit request cannot complete inline
deterministically (it defers past the sync deadline), and even an inline-completing
durable Kit job carries a `jobId` so the driver's `finalizeKit` gate
`!result.jobId` is off by construction; the finalize-runs baseline on Kit success
stays covered by the existing kit characterization nets, and the driver's
textual `computeSuccessFacts`-before-`finalizeKit` order is verified by inspection.

Anti-deferral grep on the `src/**` diff vs master: 0 matches for
`TODO|FIXME|XXX|@ts-ignore|@ts-expect-error|it.skip|it.todo|follow-up|will be
implemented` (the only `deferred` hits are the legitimate deferred-response
branch). No new `node:sqlite` reference and no new `fetch` token in the diff.

---

## Phase C

### Step: verification-gate

Commands and results (base `e94ae13`, branch `feature/prep-pipeline-tier-b-t4`):

- `npm run build` => PASS.
- `npm run lint` => PASS (0 errors; the 1024 warnings are pre-existing
  `security/detect-non-literal-fs-filename` + `no-explicit-any` warnings present
  on master, none introduced by this change).
- `npm run format:check` => PASS.
- `npm test` => PASS, 236 files / 3727 tests (baseline was 235 / 3712; +1 file,
  +15 tests, all from `request-pipeline-tier-b-t4-boundary.test.ts`). No existing
  characterization net modified.
- `npm run check` => green through build + lint + format:check +
  provider:surfaces:check + site:generate:check + site:validate + full test +
  security:audit. The security audit's only dev-time stop is
  "npm-shrinkwrap.json missing", which is expected and identical on master: the
  prod shrinkwrap is generated at release time (pre-release.sh / CI) and is NEVER
  committed. Generating it locally with `node scripts/make-prod-shrinkwrap.mjs`
  and re-running `npm run security:audit` => "Release security audit passed"
  (0 npm vulnerabilities; node:sqlite confined to `src/sqlite-driver.ts`; no
  literal `fetch` in shipped dist source; packed manifest verified;
  supply-chain guard exit 0; PostgreSQL migration contract passed). The generated
  shrinkwrap was then removed (never committed).
- CI-only gates: `typos` (1.42.3) => PASS on the changed files and whole repo
  (uses `_typos.toml` allowlist). `gitleaks` is not installed on this host; the
  diff is a pure internal refactor plus tests and docs and introduces no secret
  material (manual scan of the staged diff for secret/token/key assignments =>
  none).

Release invariants confirmed unaffected: no new `node:sqlite` reference outside
the adapter; no new `fetch` token in `dist/**/*.js`; test count rose by the new
boundary tests.

### Step: cross-llm-review-gate

Final adversarial cross-LLM review of the implemented diff. Reviewers dispatched
via the local stdio gateway with FULL local FS access, each a FRESH session
(createNewSession:true, unique correlationId), absolute paths in-prompt (no
workspace/workingDir shadowing). Packet: the design doc, amended spec,
verification notes, DAG, the staged diff, and the base `git show e94ae13:src/index.ts`
for byte comparison. Each was asked to ratify D1/D2/D3 against inspected code and
end with UNCONDITIONAL APPROVAL or one concrete blocker.

Round 1:

- Codex `gpt-5.5` (corrId `t4-final-codex-r1`, job 5cf0f438): **UNCONDITIONAL
  APPROVAL**, "Findings: none." Ratified D1 (terminal-envelope framing over 0..12
  replay), D2 (claude 4..8 inside via runInsideTerminalTry, codex passthrough
  keeps front-half outside; manager mappings match base), D3 (transfer-before-
  settle, centralized finalize gate, single metric finally). Ran
  `request-pipeline-tier-b-t4-boundary.test.ts` (15 passed) and the claude/codex
  terminal nets (10 passed).
- Grok `grok-4.5` (corrId `t4-final-grok-r1`, job f343487c): **UNCONDITIONAL
  APPROVAL**. Line-by-line structural compare of the driver against both base
  terminal sequences at `e94ae13`. Confirmed: no state 4..8 path changes its
  metric/cleanup/rollback for either provider (codex front-half = no metric, no
  flight complete; claude worktree-resolve = ok:false seam, id `claude_request`,
  catch not taken, one metric via finally; claude argv/admission/materialize =
  throw to envelope catch, id `claude`, one metric); the manager table
  (usage/failure/exception + fireRequestCleanupInCatch) matches base; centralized
  finalize gate `kit && kitSession && !result.jobId`; tagged-union KitStageOutcome;
  codex extract-before-finalize and claude finalize-before-parse orders preserved;
  H-DoubleComplete transfer-before-settle fence intact; no em dash in new hunks;
  no any/@ts-ignore; characterization nets unmodified.
- Mistral `mistral-medium-3.5` (corrId `t4-final-mistral-r1`, job 7ec0f85d):
  **UNCONDITIONAL APPROVAL**. Verification tables against `e94ae13` for D1
  (different try/finally topologies confirmed), D2 (metric table: claude 1 via
  finally, codex 0; claude worktree-resolve ok:false id `claude_request` catch not
  taken, other 4..7 throw to catch id `claude`; codex three inline catches never
  enter the envelope), and D3 (manager mapping table, centralized finalize gate at
  both branches, tagged-union outcome, computeSuccessFacts-before-finalizeKit).
  Also confirmed the H-DoubleComplete transfer-before-settle fence, recordRequest
  once in finally, no em dash / no `@ts-ignore` / no `as any` in `src/index.ts`,
  and the characterization nets unmodified (3727 tests pass).

**Result: 3/3 UNCONDITIONAL cross-LLM approval (Codex gpt-5.5, Grok grok-4.5,
Mistral mistral-medium-3.5), each from a fresh session, each verifying against the
real driver + both handlers and the `e94ae13` base, with D1/D2/D3 explicitly
ratified. No open blocker.**
