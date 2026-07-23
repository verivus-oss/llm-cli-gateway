# Tier-B T4 (the terminal-envelope driver): coordinated design

Status: DESIGN rev 3, for unconditional cross-LLM approval before implementation.
Rev 3 folds in round-2 review (Grok + Mistral unconditional; Codex 3 blockers):
(B-scaffold) the rejected uncommitted scaffold has been reverted from `src/index.ts`
so implementation replaces it in place, not beside it; (B-section1) section 1's
codex-catch summary is corrected to the non-uniform reality (worktree/argv do NOT
roll back; only session-admission does), matching sections 3.2/4; (B-facts-type)
`computeSuccessFacts` is now REQUIRED (claude implements it as a no-op
`() => undefined` with `TFacts = undefined`), which type-enforces extract-before-
finalize and removes the unsound `undefined as TFacts` cast from the driver body.
Rev 2 changelog retained below.

Rev 2
Rev 2 folds in round-1 review blockers (Mistral unconditional; Codex + Grok
accepted the architecture with blockers): (B-facts) added the `computeSuccessFacts`
pre-finalize hook so codex extracts usage/cost/metadata BEFORE finalize exactly as
today (a parse throw leaves the Kit session un-finalized), section 2.3/2.4/5/6;
(B-catches) corrected codex's non-uniform front-half catches (worktree-resolve and
argv catches do NOT roll back; only session-admission does), section 3.2/4;
(B-log) removed `invokedLogLine` from the envelope; the "invoked" log is
provider-owned after `flight.start()` (claude ~10409..10411 inside the seam),
section 2.2/2.3/3.1; (B-tests) every state 4..8 failure path now has its own
explicit test for both providers plus a codex facts-order-throw test, section 6.
Companion to `docs/plans/request-pipeline-tier-b-handler-envelope.spec.md` (the
Tier-B spec). This document SUPERSEDES the spec's one-line T4 framing ("the driver
replays states 0..12"); section 1 explains why, with evidence. Every anchor is
`src/index.ts` at master `e94ae13` (post T0/T0.5/T0.1/T1/T2/T3).

Goal (per the explicit instruction): a SINGLE coordinated design that is robust,
secure, and production quality; byte-behaviour-preserving for BOTH sync Kit
handlers; complete in one change (both handlers wired, full test coverage, no
provider or edge case deferred to a follow-up).

## 1. Why not a literal 0..12 driver (spec reconciliation)

Three independent adversarial reviews (Codex gpt-5.5 reading 1.47M tokens, Grok
4.5, Mistral) unanimously rejected a generic driver that replays states 0..12,
for one load-bearing reason plus one design reason. This design adopts their
correction and reconciles the spec.

**Load-bearing reason: the two handlers have DIFFERENT try/finally topologies.**
- `handleClaudeRequest` wraps states 4..12 in ONE `try/catch/finally`: worktree
  resolve, argv working-dir + asserts, session admission, worktree materialize,
  `installWorktree`, `flight.start()`, execute, terminals. Errors in states 4..8
  therefore reach the terminal catch (rollback + cleanup + a no-op
  `completeInline` on the not-yet-started flight) AND the `finally` records a
  performance metric. Anchors: main try opens before worktree resolve; nested
  worktree-resolve catch early-returns (~10341); `flight.start()` INSIDE the try
  (~10408); `finally` `recordRequest` (~10684).
- `handleCodexRequest` does states 4..6 (worktree resolve ~10975, argv admission
  ~10997, session admission/materialize ~11053), `installWorktree` (~11059), and
  `flight.start()` (~11084) ALL OUTSIDE its main try, which opens only at ~11090
  and wraps just states 9..12. Each of states 4..6 has its OWN dedicated
  early-return catch, and the three are NOT uniform (see section 3.2 for the
  verified detail): worktree-resolve (~10975) and argv-admission (~10997) do
  `prepCleanup?.()` + discard with NO rollback; only session-admission/materialize
  (~11053) does `rollbackOnFailure(kitSession, runtime.sessionManager)` +
  `requestCleanup?.()` + discard. All three record NO performance metric and run
  NO `completeInline` on a state 4..6 failure.

A single shared `try/finally` that owns states 4..12 (the rejected scaffold)
would force Claude's topology onto Codex: a Codex state 4..6 failure would newly
run the driver `finally` (recording a metric Codex does not record today) and, if
it ever threw into the shared catch, would drop `requestCleanup` (Codex's main
catch uses `fireRequestCleanupInCatch=false`, ~11314) and use the wrong rollback
manager. That is a real behaviour change, not a doc nit.

**Design reason: the front half (states 0..8) is genuinely divergent** (opposite
prep-vs-kitSession ordering, mint-vs-empty `effectiveSessionId`, claude-only MCP
plumbing, opposite try scopes). Hiding it behind a `prepare` callback relocates
~300-400 lines per provider without de-duplicating them, and adds indirection,
worse stack traces, and a "read top-to-bottom" penalty for two call sites.

**What IS genuinely shared and worth extracting** is the terminal envelope: the
`try/catch/finally` itself plus the execute dispatch and the
deferred/failure/success terminal choreography (the exact `ledger` + `flight`
call order and gating, including the H-DoubleComplete fence). Both handlers
implement this identically today (modulo injected leaves).

**Spec reconciliation.** The spec's section 5/7 wording "the driver replays states
0..12" is amended to: **"the driver owns the terminal envelope (the request's
single `try/catch/finally`, the execute dispatch, and the terminal
choreography); each provider injects the front-half work and the leaf parse via
callbacks, including WHAT runs inside the terminal try so each provider's existing
error/metric boundary is preserved exactly."** The intent of section 5 ("provider
entanglement stays in the driver via injected callbacks; generic units stay
pure") is preserved; only the false uniformity of a 12-state replay is dropped.
This amendment is part of what the review gate must approve.

## 2. The driver: `runKitTerminalEnvelope`

Generic machinery: no provider literals beyond a `provider: CliType` label, no
gateway-server import (same discipline as `PrepPipeline` / `RequestTerminalLedger`
/ `FlightOwnership`).

### 2.1 Outcome type (tagged union, per review)

Replaces the weak `"earlyResponse" in o` discriminant that all three reviewers
flagged:

```ts
type KitStageOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; earlyResponse: ExtendedToolResponse };
```

### 2.2 Context (the terminal envelope's inputs)

The manager-selection fields are per-context (NOT hard-coded): the two handlers
deliberately target different session managers per call-site, and the ledger
already takes the manager as an argument to preserve exactly this asymmetry. All
three reviewers verified these mappings against the code and confirmed them
correct; they are retained.

```ts
interface KitTerminalEnvelope {
  runtime: GatewayServerRuntime;
  provider: CliType;                 // "claude" | "codex"; log + recordRequest label + catch error id
  corrId: string;
  kit: PersonalKitRequestContext | null;
  kitSession: PersonalKitSessionResolution | null;
  effectiveSessionId: string | undefined;
  ledger: RequestTerminalLedger;
  flight: FlightOwnership;
  startTime: number;
  optimizationApplied: boolean;      // optimizePrompt || optimizeResponse (only var in shared fail/catch completeInline)
  outputFormat: string | undefined;  // fed to buildTerminalCliFailure
  usageUpdateManager: ISessionManager;       // claude deps.sessionManager; codex runtime.sessionManager
  failureRollbackManager: ISessionManager;   // claude deps.sessionManager; codex runtime.sessionManager
  exceptionRollbackManager: ISessionManager; // claude runtime.sessionManager; codex deps.sessionManager
  fireRequestCleanupInCatch: boolean;        // claude true; codex false
}
```

Note: `kitJobHandedOff` is NOT a context field. It is a driver-local, set inside
the envelope and read only by the envelope's catch (preserving today's semantics
where each handler owns it as a local).

### 2.3 Hooks (provider-injected)

`TFacts` is the provider's opaque state-10c pre-finalize facts type (codex: its
`{ codexUsage, costBasis, codexMeta }`; claude: `undefined`).

```ts
interface KitTerminalHooks<TFacts = undefined> {
  /**
   * WHAT runs INSIDE the terminal try, BEFORE execute. This is the topology
   * seam. Claude passes states 4..8 here (worktree resolve + argv/asserts +
   * session admission + worktree materialize + installWorktree + flight.start +
   * its "invoked with ..." log line, which sits AFTER flight.start), so their
   * failures reach the envelope catch/finally EXACTLY as today. Codex passes a
   * trivial passthrough that returns the worktree resolution it already computed
   * OUTSIDE the try (states 4..8, installWorktree, flight.start, and its invoked
   * log all stay in the codex handler with codex's own dedicated early-return
   * catches and NO metric), so codex's boundary is unchanged. Returning
   * `{ ok:false }` early-returns through the envelope finally (matches Claude's
   * in-try early returns); a throw reaches the catch. The "invoked" log is
   * PROVIDER-OWNED (each provider logs it inside its own state-8 code); the
   * driver never logs it.
   */
  runInsideTerminalTry(): Promise<KitStageOutcome<{ worktreeResolution: ResolvedWorktree }>>;

  /** State 9. Provider's full awaitJobOrDefer(...) inside runWithPersonalKitAttemptLease. */
  execute(worktreeResolution: ResolvedWorktree): Promise<KitTerminalExecuteResult>;

  /** State 10a decorate: claude attaches warnings; codex omits (hook optional). */
  decorateDeferred?(deferred: ExtendedToolResponse): ExtendedToolResponse;

  /**
   * State 10c pre-finalize facts. REQUIRED (not optional) so the extract-before-
   * finalize contract is type-enforced for any provider whose TFacts is not
   * `undefined`. Called by the driver on the success path BEFORE finalizeKit.
   * Codex extracts its usage/cost/provider-metadata here so that a parse/
   * extraction throw leaves the Kit session UN-finalized, exactly as codex does
   * today (extract at ~11243/11247/11255 BEFORE finalize at ~11256). Claude sets
   * `TFacts = undefined` and implements this as a no-op `() => undefined`; it
   * extracts inside buildSuccessResponse AFTER finalize, matching claude's current
   * finalize-at-~10554-before-parse-at-~10568 order (the no-op does nothing before
   * finalize, so claude's order is unchanged). Making it required removes the
   * unsound `undefined as TFacts` cast: the driver always has a hook to call.
   */
  computeSuccessFacts(stdout: string, result: KitTerminalInlineResult): Promise<TFacts> | TFacts;

  /**
   * Kit terminal finalize. The driver owns the gate `kit && kitSession &&
   * !result.jobId` (per review) and calls this ONLY when it holds; the hook
   * supplies the provider-specific finalize params (claude includes
   * initialNativeSessionId, codex omits it; success passes terminalMetadata built
   * from stdout, which is why finalize does NOT need TFacts).
   */
  finalizeKit(args: { completed: boolean; stdout: string; result: KitTerminalInlineResult }): Promise<void>;

  /** State 10b response build (the fail completeInline is written by the driver). */
  buildFailureResponse(args: {
    code: number; stdout: string; stderr: string;
    terminalFailure: KitTerminalFailure; result: KitTerminalInlineResult;
  }): ExtendedToolResponse;

  /** State 10c parse + OWN completeInline + response build (claude dual stream-json
   *  branch vs codex codexFrResponse: the success completeInline metadata is
   *  provider-specific, so it stays in the leaf; the driver has already run
   *  settle + usage-update + computeSuccessFacts + finalizeKit before calling
   *  this). `facts` is the computeSuccessFacts result (codex uses it; claude,
   *  with TFacts=undefined, ignores it and parses stdout itself). */
  buildSuccessResponse(args: {
    worktreeResolution: ResolvedWorktree; stdout: string; durationMs: number; facts: TFacts;
  }): ExtendedToolResponse;
}
```

### 2.4 Driver body (exact, byte-faithful to the shared terminal order)

```ts
async function runKitTerminalEnvelope<TFacts>(
  env: KitTerminalEnvelope,
  hooks: KitTerminalHooks<TFacts>
): Promise<ExtendedToolResponse> {
  const { runtime, provider, corrId, kit, kitSession, effectiveSessionId, ledger, flight } = env;
  const logger = runtime.logger;
  let durationMs = 0;
  let wasSuccessful = false;
  let kitJobHandedOff = false;
  try {
    const staged = await hooks.runInsideTerminalTry();     // states the provider puts inside the try
    if (!staged.ok) return staged.earlyResponse;
    const { worktreeResolution } = staged.value;

    const result = await hooks.execute(worktreeResolution); // state 9
    kitJobHandedOff = !isDeferredResponse(result) && result.jobId !== undefined;

    if (isDeferredResponse(result)) {                       // 10a
      kitJobHandedOff = true;
      flight.transferCompletionToManager();                 // BEFORE settle: H-DoubleComplete fence
      ledger.sessionAdmissionCommitted = true;
      await ledger.settle(kitSession);
      if (!kitSession) await safeUpdateSessionUsageAfterJobAdmission(env.usageUpdateManager, effectiveSessionId, runtime);
      const deferred = buildDeferredToolResponse(result, effectiveSessionId);
      return hooks.decorateDeferred ? hooks.decorateDeferred(deferred) : deferred;
    }

    const { stdout, stderr, code } = result;
    durationMs = Math.max(0, Date.now() - env.startTime);

    if (code !== 0) {                                        // 10b
      await ledger.rollbackOnFailure(kitSession, env.failureRollbackManager);
      const terminalFailure = buildTerminalCliFailure(provider, stdout, stderr, code, env.outputFormat);
      if (kit && kitSession && !result.jobId) await hooks.finalizeKit({ completed: false, stdout, result });
      logger.info(`[${corrId}] ${provider}_request failed in ${durationMs}ms`);
      flight.completeInline({ ...terminalFailure, durationMs, retryCount: 0, circuitBreakerState: "closed",
        optimizationApplied: env.optimizationApplied, exitCode: code, status: "failed" });
      return hooks.buildFailureResponse({ code, stdout, stderr, terminalFailure, result });
    }

    wasSuccessful = true;                                    // 10c
    ledger.sessionAdmissionCommitted = true;
    await ledger.settle(kitSession);
    if (!kitSession) await safeUpdateSessionUsageAfterJobAdmission(env.usageUpdateManager, effectiveSessionId, runtime);
    logger.info(`[${corrId}] ${provider}_request completed successfully in ${durationMs}ms`);
    // Pre-finalize facts (codex extracts BEFORE finalize; claude no-op returns
    // undefined) so an extraction throw leaves the Kit session un-finalized
    // exactly as today. Always present (required hook) -> no cast.
    const facts: TFacts = await hooks.computeSuccessFacts(stdout, result);
    if (kit && kitSession && !result.jobId) await hooks.finalizeKit({ completed: true, stdout, result });
    return hooks.buildSuccessResponse({ worktreeResolution, stdout, durationMs, facts });
  } catch (error) {                                          // 11
    await ledger.rollbackOnException(kitSession, env.exceptionRollbackManager);
    await ledger.cleanupOnException(kitJobHandedOff, error, kitSession, env.fireRequestCleanupInCatch);
    const elapsedMs = Math.max(0, Date.now() - env.startTime);
    logger.info(`[${corrId}] ${provider}_request threw exception after ${elapsedMs}ms`);
    flight.completeInline({ response: "", durationMs: elapsedMs, retryCount: 0, circuitBreakerState: "closed",
      optimizationApplied: env.optimizationApplied, exitCode: 1, errorMessage: (error as Error).message, status: "failed" });
    return kitAwareErrorResponse(provider, 1, "", corrId, error as Error, kit);
  } finally {                                                // 12
    await ledger.worktreeLifecycle?.finishHandler();
    const finalizedDurationMs = Math.max(0, durationMs || Date.now() - env.startTime);
    runtime.performanceMetrics.recordRequest(provider, finalizedDurationMs, wasSuccessful);
  }
}
```

## 3. How each handler wires it (dual topology, no behaviour change)

### 3.1 Claude (states 4..8 inside the envelope try)

The claude handler keeps states 0..3 + ledger init + flight construction inline
(with its existing early-return error handling for validation / kit / prep /
insertAndAdmitFinalSessionArgs / session resolve). It then builds `env` + `hooks`
and `return runKitTerminalEnvelope(env, hooks)`. Its `runInsideTerminalTry` runs
CURRENT lines ~10328..10411 verbatim: the nested worktree-resolve try (returns
`{ ok:false, earlyResponse }` with operation id `"claude_request"`, cleanup +
discard, NO rollback, NO completeInline), `applyEffectiveWorkingDirectory` +
asserts (throw -> envelope catch), session admission, worktree materialize
(~10387..10404, throw -> envelope catch), `installWorktree`, `flight.start()`, and
the claude "invoked with ..." `logger.info` (~10409..10411, which sits AFTER
`flight.start()`). Because these run inside the envelope try, a state 4..7 throw
reaches the envelope catch (no-op `completeInline` on the not-yet-started flight,
operation id `"claude"`) and the envelope `finally` records the metric; the
worktree-resolve early return also hits the `finally` (metric) but NOT the catch --
both byte-identical to today.

### 3.2 Codex (states 4..8 outside; passthrough hook)

The codex handler keeps states 0..8 inline EXACTLY as today, including its three
dedicated early-return catches, `installWorktree`, `flight.start()`, and its
"invoked" log -- all OUTSIDE any envelope try. The three catches are NOT uniform
(verified against the code, correcting the prior draft):
- worktree resolve (~10975): `prepCleanup?.()` + `discardPendingPersonalKitSession`
  + return `"codex_request"`. **NO rollback.**
- argv/assert admission (~10997): `requestCleanup?.()` + discard + return. **NO
  rollback.**
- session admission / materialize (~11036..11057, shared catch):
  `rollbackOnFailure(kitSession, runtime.sessionManager)` + `requestCleanup?.()` +
  discard + return.
All three record NO metric (outside the try). The codex handler then builds `env`
+ `hooks` and `return runKitTerminalEnvelope(env, hooks)`. Its
`runInsideTerminalTry` is a trivial `async () => ({ ok: true, value: {
worktreeResolution } })` that returns the resolution it already computed and can
neither throw nor return `{ ok:false }`. So a codex state 4..8 failure is handled
entirely by codex's own code and NEVER calls the envelope -- no new metric, no
dropped cleanup, correct managers. Byte-identical to today.

This is the crux: the envelope owns exactly one `try/catch/finally` (states 9..12
for both, plus whatever the provider chooses to run inside it), and the
`runInsideTerminalTry` seam is what lets Claude keep 4..8 inside and Codex keep
4..8 outside -- preserving both boundaries with no product change.

## 4. Byte-preservation matrix (every path, both providers)

| Path | Claude today -> driver | Codex today -> driver | Preserved? |
|------|------------------------|-----------------------|------------|
| Validation / kit / prep / session-resolve error (0..3) | inline early return, no metric | inline early return, no metric | yes (stays in handler) |
| Worktree-resolve error (4) | in-try nested catch: cleanup+discard+return "claude_request", NO rollback, NO completeInline, metric via finally | dedicated catch outside try: prepCleanup+discard+return "codex_request", NO rollback, NO metric | yes (claude via runInsideTerminalTry ok:false + finally; codex via handler) |
| Argv/assert error (4) | throw -> envelope catch (rollbackOnException(runtime)+cleanup fire=true+no-op completeInline, id "claude")+finally metric | dedicated catch outside try: requestCleanup+discard, NO rollback, NO metric | yes |
| Session-admission / materialize error (5..6) | throw -> envelope catch + finally metric | dedicated catch outside try: rollbackOnFailure(runtime mgr)+requestCleanup+discard, NO metric | yes |
| Deferred (10a) | transfer+settle+usage(deps)+warnings-decorate | transfer+settle+usage(runtime)+bare | yes |
| Inline success (10c) | settle+usage+finalize(initialNativeSessionId)+dual stream-json build | settle+usage+finalize+codexFrResponse build | yes |
| Inline failure (10b) | rollbackOnFailure(deps)+finalize+completeInline+warnings error | rollbackOnFailure(runtime)+finalize+completeInline+JSONL+resume-hint error | yes |
| Exception (11) | rollbackOnException(runtime)+cleanup fire=true+completeInline+error | rollbackOnException(deps)+cleanup fire=false+completeInline+error | yes (manager + fire fields) |
| finally (12) | finishHandler + recordRequest("claude") | finishHandler + recordRequest("codex") | yes |
| H-DoubleComplete (deferred + finishHandler reject) | transfer-before-settle -> catch completeInline no-op | (unreachable, codex always transfers) | yes (T3 fence intact) |

Metric count is EXACTLY ONCE per request that enters the envelope, and ZERO for
front-half failures that never enter it (codex) or ONCE for front-half failures
that do (claude) -- identical to today.

## 5. Robustness and security invariants (production quality)

- **Exactly-once metric.** `recordRequest` fires in exactly one `finally`, which
  wraps `execute`. No second try/finally exists, so no double-count and no gap.
- **Exactly-once / fenced flight completion.** Deferred transfers ownership to
  the manager BEFORE settle, so the catch `completeInline` is a no-op once
  transferred (T3 H-DoubleComplete fence, structurally preserved). Success writes
  its completeInline in the leaf; failure/catch in the driver. No path writes two
  inline completions.
- **No dropped or double `requestCleanup`.** Codex front-half cleanup stays in
  codex's dedicated catches (unchanged); the envelope catch uses the provider's
  `fireRequestCleanupInCatch` (claude true, codex false) exactly as today; the
  deferred handoff path is unchanged (`kitJobHandedOff` gates
  `cleanupOnException`).
- **Manager asymmetry preserved** per the verified mapping (section 2.2).
- **Kit-finalize gate centralised** in the driver (`kit && kitSession &&
  !result.jobId`), so a leaf can never forget it.
- **Success facts/finalize order preserved.** On the success path the driver calls
  `computeSuccessFacts` (provider parse/extraction) BEFORE `finalizeKit`. Codex
  extracts there, so a parse/extraction throw propagates with the Kit session
  still UN-finalized (matching codex today, extract-before-finalize). Claude's
  `computeSuccessFacts` is a no-op `() => undefined` (it does nothing before
  finalize) and it parses inside `buildSuccessResponse` AFTER finalize (matching
  claude today, finalize-before-parse). Neither order is silently changed.
- **Principal isolation (security) unchanged.** No `sessionId` / `workingDir` /
  `worktree` crosses principals; the front half (which owns all caller-input
  resolution and ownership checks) stays per-handler, and the envelope introduces
  no new data flow between principals. The envelope only sequences already-owned
  `ledger` / `flight` / manager objects.
- **No em dash; snake_case tool names; stderr-only logging; no `node:sqlite`
  outside the adapter; no `fetch` token in dist** (release invariants unaffected).
- **Type safety.** Tagged-union `KitStageOutcome` (no structural false positives);
  `result` narrowed to `KitTerminalInlineResult` after `isDeferredResponse`; `env`
  fields fully typed.

## 6. Test plan (complete, no coverage deferred)

The existing characterization nets stay green untouched: `claude-handler-terminal-net`,
`codex-handler-terminal-net` (T0.5 + T3), `claude-handler`, `codex-handler`,
`claude-kit-preadmission`, `codex-kit-preadmission`, `claude-prep-parity`,
`personal-config-flight-recorder-privacy`, `sync-terminal-failure-redaction`,
`claude-mcp-config`, `claude-argv-golden`, `async-job-manager-flight-recorder`.

NEW tests added in the same change. Every state 4..8 failure path gets its OWN
explicit test for BOTH providers (no path folded into another), each asserting the
exact tuple `(recordRequest count, requestCleanup fired?, discard fired?, rollback
call + manager, completeInline fired?, response operation id)`:

Codex (all assert recordRequest count == 0, NO metric bleed):
1. worktree-resolve failure: prepCleanup + discard, NO rollback, NO completeInline,
   id `"codex_request"`.
2. argv/assert-admission failure: requestCleanup + discard, NO rollback, NO
   completeInline, id `"codex_request"`.
3. session-admission failure: `rollbackOnFailure(runtime.sessionManager)` +
   requestCleanup + discard, NO completeInline.
4. worktree-materialize failure (shares the session-admission catch): same as (3),
   asserted explicitly.

Claude (all assert recordRequest count == 1, metric via finally):
5. worktree-resolve early return (the `ok:false` seam): cleanup + discard, NO
   rollback, NO `flight.completeInline`, id `"claude_request"`, catch NOT taken.
6. argv/assert failure (throw -> catch): `rollbackOnException(runtime.sessionManager)`
   + cleanupOnException(fire=true) + no-op completeInline, id `"claude"`.
7. session-admission failure (throw -> catch): as (6).
8. worktree-materialize failure (throw -> catch): as (6).

Terminal parity (both providers): deferred / inline-success / inline-failure /
exception each assert the flight ownership call sequence, settle/rollback/cleanup
calls, and the single `recordRequest`.

Success facts-order: a codex success where `computeSuccessFacts` (extraction)
THROWS asserts the Kit session is left UN-finalized (finalizeKit NOT called) and
the throw surfaces via the envelope catch -- pinning the codex extract-before-
finalize order.

H-DoubleComplete stays pinned (claude reachable; codex documented unreachable) via
the existing terminal nets, re-run against the driver.

## 7. Deliverable shape (one change, both handlers)

One PR: introduce `runKitTerminalEnvelope` + `KitTerminalEnvelope` +
`KitTerminalHooks` + tagged `KitStageOutcome`; rewrite BOTH `handleClaudeRequest`
and `handleCodexRequest` to build `env` + `hooks` and call the envelope; add the
new boundary tests; amend the spec's T4 wording (section 1). No provider, edge
case, or test is deferred. Gate: `npm run check` green (build + lint + format +
provider-surfaces + site + full test + security audit), then unconditional
cross-LLM review.

## 8. Open decisions the review gate must ratify

- **D1**: accept the spec amendment (driver owns the terminal envelope, not a
  literal 0..12 replay) as the coordinated T4 definition. If any reviewer holds
  that the literal 0..12 must be implemented despite the topology break, that is a
  blocker to resolve before coding.
- **D2**: confirm the `runInsideTerminalTry` seam fully preserves BOTH boundaries
  (the central claim of section 3/4). Reviewers must verify against the real
  handlers that no state 4..8 path changes its metric/cleanup/rollback behaviour.
- **D3**: confirm the manager mapping (2.2), the centralised finalize gate, and
  the tagged-union outcome resolve all findings from the prior review round with
  nothing outstanding.
