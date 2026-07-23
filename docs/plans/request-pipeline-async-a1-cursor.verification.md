# RequestPipeline async A1 (driver + cursor async): verification notes

Base commit: `c2f871e` (master). Branch: `feature/prep-pipeline-async-a1`. Design
(3/3-approved): `docs/plans/request-pipeline-async-envelope.design.md`. First async slice:
introduce `runAsyncEnqueueEnvelope` + rewire the minimal non-Kit async sibling (cursor).

## Implementation

- New driver `runAsyncEnqueueEnvelope(env, hooks)` added after `runKitTerminalEnvelope`
  in src/index.ts, plus `AsyncEnqueueEnvelope` / `AsyncEnqueueHooks<TValue>`. It owns one
  `try { runInsideTry; enqueue; jobHandedOff + sessionAdmissionCommitted; settle(null);
  usage; log; buildSuccessResponse } catch { rollback-if-not-handed-off; error }`. Pure
  Mode C: NO flight completion, NO recordRequest, NO finally, NO H-DoubleComplete fence.
- Reuses the Tier-B `RequestTerminalLedger`: `ledger.settle(null)` == the base inline
  `if (sessionAdmission) transfer() else await finishHandler()` (a no-op for cursor, which
  installs no lifecycle); the catch `if (!jobHandedOff) ledger.rollbackOnException(null,
  mgr)` == base's `if (!jobHandedOff) rollbackSessionAndWorktreeAdmission(mgr,
  sessionAdmission, undefined, runtime)` once the driver commits `sessionAdmissionCommitted
  = true` at the `jobHandedOff` instant. The 3/3-approved design proves the latch-timing
  equivalence (a throw in settle/usage/log after handoff rolls back in neither).
- cursor wiring: the ACP-less front half (managed-MCP reject, workspace selection, session
  args, prep, insertAndAdmit) stays OUTSIDE. env: provider "cursor", logger deps.logger,
  usageUpdateSessionId = userProvidedSession ? sessionResult.effectiveSessionId : undefined
  (the pre-mint form, provably equal since the mint fires only when !userProvided), ledger
  = new RequestTerminalLedger(runtime, undefined), usage/rollback managers = deps.session
  Manager. runInsideTry runs states 4..8 (existingSession lookup, the worktree-resolve
  ok:false seam id "cursor_request_async", applyEffectiveWorkingDirectory, the 3 asserts,
  the 3-branch admission incl. the mid-body gw- mint) setting ledger.sessionAdmission, NO
  installWorktree, and returns { worktreeResolution, effectiveSessionId }. enqueue builds
  the FR handoff + calls startJob with the 19 base positional args (arg #9 =
  ledger.worktreeLifecycle?.onTerminal = undefined for cursor). buildSuccessResponse emits
  the byte-identical { success, job, sessionId||null, gatewaySessionId/resumable via
  isGatewayTrackingOnlySession } JSON.
- D3 refinement: the mint stays inside runInsideTry (async admission shapes differ per
  provider, so restructuring to a sync-style hoist would risk a behaviour change); the
  post-mint effectiveSessionId rides to buildSuccessResponse via TValue.
- Lint fix: `let worktreeResolution: ResolvedWorktree;` (dropped a dead `= {}` initializer
  flagged by no-useless-assignment); behaviour-neutral.
- build clean; lint 0 errors; format PASS; full suite 3770 green (before the net's 6th
  test); no em dash / node:sqlite / fetch added; the diff is confined to the driver + the
  import (`type AsyncJobSnapshot`) + handleCursorRequestAsync. The other 5 async handlers
  (gemini/grok/devin/mistral/codex) are UNTOUCHED.
- cursor-async-handler-net (6 tests): fresh-mint enqueue (tracking-only gw- session, usage
  NOT updated), user-provided (resumable, usage updated), the worktree-resolve ok:false
  seam (id "cursor_request_async", no job), the argv-throw envelope-catch seam, the
  COMMITTED-admission rollback (startJob throws on a fresh-mint request => the driver
  unwinds the minted admission via rollbackSessionAdmission -> compareAndSetSession; this
  pins the byte-changed rollback path), and the anti-orphan (session-manager failure before
  handoff, no job). The unmodified cursor-handler.test.ts + gemini-async-handler.test.ts
  (incl. handleCodexRequestAsync) stay green.

## ultracode multi-lens verification

Before the external gate, a Workflow ran four adversarial lenses (byte-choreography,
wiring-and-mode-c, ledger-latch-equivalence, tests) + a synthesis critic. All 3 CODE
lenses returned ZERO findings and the critic confirmed no blocker/major. The tests lens
surfaced two coverage gaps (byte-correct code, untested paths): a MINOR (the committed-
admission rollback, now pinned by the 5th test above) and a NOTE (the user-provided
existing-session persist branch - a mechanical `sessionAdmission -> ledger.sessionAdmission`
rename identical in shape to the tested create branch; left documented).
