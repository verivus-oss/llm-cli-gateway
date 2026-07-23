# Tier-B T5e (cursor terminal-envelope routing): verification notes

Base commit: `6515bf7` (master, post T5d/PR #222). Branch:
`feature/prep-pipeline-tier-b-t5e`. Design (3/3-approved rev 2):
`docs/plans/request-pipeline-tier-b-t5-generalize.design.md`. Fifth and FINAL T5
slice; the minimal one (no request-owned worktree lifecycle).

## Implementation

- wire-cursor-handler: handleCursorRequest builds env + hooks and returns
  runKitTerminalEnvelope(env, hooks). The ACP transport branch +
  rejectUnisolatedManagedMcpProvider + resolveCursorWorkspaceSelection +
  resolveGrokSessionArgs + prepareCursorRequest + insertAndAdmitFinalSessionArgs stay
  OUTSIDE the envelope (unchanged front half). env: kit=null, kitSession=null, all
  three managers = deps.sessionManager, logger = deps.logger, provider="cursor",
  optimizationApplied=false, outputFormat=params.outputFormat,
  fireRequestCleanupInCatch=false, usageUpdateSessionId = userProvidedSession ?
  effectiveSessionId : undefined (D4 split). The effectiveSessionId mint is hoisted
  before env (pure); the pre-mint sessionResult.effectiveSessionId still feeds the
  existing-session lookup + the worktree resolve. computeSuccessFacts/finalizeKit are
  no-ops (cursor extracts no usage/cost/metadata; the FR handoff owns tokens).
- MINIMAL member: cursor installs NO request-owned worktree lifecycle. It never calls
  ledger.installWorktree, so ledger.worktreeLifecycle stays undefined and every
  worktree-dependent driver site degrades to a no-op that MATCHES base cursor:
  ledger.settle() is guarded by `if (this.worktreeLifecycle)` (base cursor never
  settled on deferral/success); rollbackOnFailure/rollbackOnException pass
  worktreeLifecycle=undefined to rollbackSessionAndWorktreeAdmission (base passed
  undefined too); the finally's `ledger.worktreeLifecycle?.finishHandler()` optional-
  chains to nothing (base finally did not finishHandler). execute passes env=undefined
  and onTerminal=undefined to awaitJobOrDefer and cwd = cursorWorkspace.cwd ??
  worktreeResolution.cwd, exactly as base.
- runInsideTerminalTry (states 4..8): existingSession lookup, the inline worktree-
  resolve ok:false seam (id "cursor_request"), applyEffectiveWorkingDirectory
  ("cursor-agent"/undefined workdir/"--add-dir"), the asserts (assertUpstreamCliArgs,
  assertUpstreamCliEnv("cursor", undefined), assertFinalCliProcessAdmission), the
  session admission (sets ledger.sessionAdmission), and flight.start(). cursor has NO
  "invoked" log line (base had none), so runInsideTerminalTry logs nothing.
- D4: byte-identical to the grok/devin/mistral split (a minted session gets the
  deferred id but NO durable usage update; a user-provided session gets both).
- D5 (like devin): the driver ALWAYS logs the three terminal lines
  (`cursor_request failed` / `... completed successfully` / `... threw exception`) via
  env.logger = deps.logger. The old inline cursor handler emitted NONE of these, so
  cursor gains three stderr log lines. Behaviour-additive, documented, tested.
- fence: cursor's H-DoubleComplete is INERT. With no worktree lifecycle the deferred
  settle never calls finishHandler(), and the only post-arm step
  (safeUpdateSessionUsageAfterJobAdmission) swallows its errors, so the envelope catch
  is unreachable after a deferral. The transfer-before-settle fence is applied
  uniformly by the driver but reads/writes only a flag that is never consulted for
  cursor (byte-neutral). Distinct from gemini's reachable edge.
- build clean; lint 0 errors; format PASS; no em dash / node:sqlite / fetch added; the
  diff is confined to handleCursorRequest (single hunk boundary).
- cursor-terminal-net: new src/__tests__/cursor-handler-terminal-net.test.ts (7 tests):
  inline success/failure/exception (each asserting the D5 completed/failed/threw log
  line), the argv-throw envelope-catch seam (id "cursor"), the worktree-resolve
  ok:false seam (id "cursor_request", triggered by a relative addDir with no working
  dir, one metric, no flight completion), the deferred Mode-B fence (arms the manager,
  no inline complete), and both D4-split directions. The unmodified
  src/__tests__/cursor-handler.test.ts stays green (observable byte-preservation). All
  sibling terminal nets (gemini/grok/devin/mistral) + the T5a-d suites stay green and
  unmodified.
