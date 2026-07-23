# Tier-B T5 (generalize the terminal envelope to the non-Kit siblings): coordinated design

Status: DESIGN rev 2, for unconditional cross-LLM approval before implementation.
Rev 2 folds in round-1 review (Mistral unconditional; Codex + Grok each named the
SAME concrete blocker): the T4 driver couples the usage-update session id and the
deferred-response session id on one `effectiveSessionId`, but grok/devin/cursor/
mistral deliberately pass DIFFERENT ids at those two sites (usage-update gets
`userProvidedSession ? effectiveSessionId : undefined`; the deferred response gets
the full minted `effectiveSessionId`). Rev 2 adds a separate `usageUpdateSessionId`
envelope field (section 3 D4 / section 4), which is inert for claude/codex/gemini
(they set it equal to `effectiveSessionId`) and lands in T5a so later slices can
differ. Rev 2 also pins two secondary deltas the reviewers flagged: the five
hard-code `optimizationApplied: false` on their fail/exception flight completions
(so `env.optimizationApplied` is wired to `false` for the five, section 4), and
devin + cursor emit NO terminal `logger.info` lines today whereas the driver always
logs three (a documented log-only delta, section 3 D5). Rev 1 changelog retained
below.

Companion to `docs/plans/request-pipeline-tier-b-handler-envelope.spec.md` (the
Tier-B spec, stage T5) and to
`docs/plans/request-pipeline-tier-b-t4-driver.design.md` (the shipped Kit-sibling
driver). Every anchor is `src/index.ts` at master `18f06e3` (post
T0/T0.5/T0.1/T1/T2/T3/T4; T4 = PR #218, merge 18f06e3).

Goal (per the spec's Stage T5): generalize the terminal-envelope machinery that
the two Kit siblings (claude, codex) already use to the five remaining sync
handlers (gemini, grok, devin, cursor, mistral), which are still at the pre-T1
inline shape. The result must be byte-behaviour-preserving except for one
deliberate, visible, tested change per exposed handler: installing the T3
`FlightOwnership` fence for the pre-existing H-DoubleComplete hazard (exactly as
T3 did for claude/codex, a reviewed flip, never a silent fix).

## 1. Grounding: the five siblings are a uniform non-Kit family

Verified control-flow maps of all five sync handlers at `18f06e3`
(handler bodies: gemini 11277..11610, grok 11983..12349, devin 12810..13108,
cursor 13535..13838, mistral 14112..14512). They share ONE terminal shape, which
is claude's topology (states 4..8 INSIDE the main try), NOT codex's:

- **One main `try/catch/finally`** wrapping the front half (states 4..8) plus the
  execute dispatch plus the deferred/failure/success terminal branches. A
  front-half throw reaches the main catch; the finally always runs
  `worktreeLifecycle?.finishHandler()` (where a lifecycle exists) then the single
  `recordRequest(<provider>, ...)`.
- **`deps.sessionManager` used uniformly** for every session read, admission,
  usage-update and rollback. There is NO deps-vs-runtime split (claude/codex
  deliberately target different managers per call-site; the five do not). So the
  T4 envelope's three manager fields
  (`usageUpdateManager`/`failureRollbackManager`/`exceptionRollbackManager`) all
  collapse to `deps.sessionManager` for every sibling.
- **Settle predicate is `sessionAdmission` alone**, open-coded as
  `if (sessionAdmission) worktreeLifecycle.transfer(); else await worktreeLifecycle.finishHandler();`
  at the deferred and success sites. This is exactly `ledger.settle(kitSession)`
  with `kitSession = null`, because `Boolean(sessionAdmission || null) ===
  Boolean(sessionAdmission)`.
- **Raw `safeFlightComplete`, no `FlightOwnership`.** All inline completions call
  `safeFlightComplete(corrId, {...}, runtime)` directly (fail / success /
  exception). There is no Mode-A-to-B `transferCompletionToManager()` latch. The
  deferred path avoids a double completion only by returning before any inline
  complete.
- **Executor onComplete is the bare `worktreeLifecycle.onTerminal`** (gemini
  11446, grok 12196, devin 12971, mistral 14304/14362) or `undefined` (cursor),
  NOT a composed `requestCleanup`. There is no `composeRequestCleanup` /
  `baseRequestCleanup` fan-out in any sibling (Kit-only).
- **`recordRequest` fires once, only in the finally**, reading `durationMs`
  (0 until set on the code!=0 / success paths) and `wasSuccessful` (false until
  the success path). A deferral therefore records `wasSuccessful=false` with a
  `Date.now()-startTime` fallback duration. (Cursor is the one exception to the
  "finally also runs `worktreeLifecycle?.finishHandler()`" shape: it has no
  worktree lifecycle, so its finally is `recordRequest` only, 13831..13837.)
- **Usage-update session id can differ from the deferred-response session id.**
  Four siblings (grok 12214..12219, devin 12987..12992, cursor 13721..13726,
  mistral 14321..14326) pass `userProvidedSession ? effectiveSessionId : undefined`
  to `safeUpdateSessionUsageAfterJobAdmission` (so a gateway-minted `gw-*` session
  gets NO durable usage update) while still passing the full minted
  `effectiveSessionId` to `buildDeferredToolResponse`. Gemini uses one value
  (`effectiveSessionIdHint`) for both (11464 / 11469), so gemini is unexposed; but
  the shared contract MUST carry both ids. See section 3 D4.
- **`optimizationApplied` on the fail/exception flight is hard-coded `false`** for
  the five (e.g. gemini 11497 / 11597); only the SUCCESS completion (in the leaf)
  carries the real `optimizePrompt || optimizeResponse` flag. See section 4.
- **Direct `awaitJobOrDefer`, no `runWithPersonalKitAttemptLease`** (the lease is
  Kit-only).
- **No Kit surface at all** (grep-confirmed per handler): no `kit`, `kitSession`,
  `PersonalKit*`, `discardPendingPersonalKitSession`, `KitTerminalFinalizationError`,
  or `safePersonalKitFlightComplete`. Kit is rejected upstream in
  `prepare<Provider>Request`, never inside the handler.

### 1.1 Per-handler divergences (the parts that stay per-handler)

| Handler | Body | ACP early-return branch | Worktree lifecycle | Inline resolve-#1 catch | Provider-specific bits |
|---|---|---|---|---|---|
| gemini | 11277..11610 | none | yes | yes (11359) | applyEffectiveWorkingDirectory + invoked log; usage/cost/meta success facts |
| grok | 11983..12349 | yes (11988) | yes | yes (12106) | grok-native providerSessionId/stopReason; streaming normalization |
| devin | 12810..13108 | yes (12815) | yes | **no** (all front-half throws reach main catch) | no applyEffectiveWorkingDirectory, no invoked log; remote-tracked sessions (`requireTrackedRemoteSession`) |
| cursor | 13535..13838 | yes (13539) | **no lifecycle at all** (deferWorktree requested but never materialized/installed/settled); onComplete=undefined; finally has NO finishHandler | yes (13634) | minimal generic build |
| mistral | 14112..14512 | yes (14117) | yes | yes (14211) | **model-selection retry loop** (14329..14388): a second `awaitJobOrDefer` + `rearm()` + a second embedded deferred branch |

ACP branches short-circuit to `runAcpTransport(...)` BEFORE `runtime`/`startTime`
and the try/finally exist, so they add NO terminal path inside the CLI handler
and MUST stay outside any envelope wrap. The `runAcpTransport` path owns its own
terminal accounting and is out of T5 scope.

## 2. The load-bearing finding: an unfenced H-DoubleComplete on four siblings

For gemini, grok, devin and mistral the deferred branch runs
`else await worktreeLifecycle.finishHandler()` (when `sessionAdmission` is falsy)
BEFORE the early return, and the exception catch runs an **unconditional**
`safeFlightComplete(...)`. If a post-handoff `finishHandler()` rejects into the
catch after `awaitJobOrDefer` armed the async manager to own `logComplete`, the
catch writes a SECOND completion over the manager-owned flight. This is precisely
the pre-existing H-DoubleComplete hazard that T3's `FlightOwnership.completeInline`
no-op fences for claude/codex (spec section 4), and it is still unfenced here.

- **Reachability** mirrors the codex T3 analysis and is NOT assumed. It is only
  reachable when `sessionAdmission` is falsy on a deferral (so the settle branch
  calls `finishHandler()` rather than `transfer()`) AND that `finishHandler()`
  (worktree `removeWorktree`) can reject. Grok/mistral/devin mint a `gw-*`
  `effectiveSessionId` and admit a session for most requests (like codex, this
  can make it defensive/unreachable in the mint-always case); gemini does not
  uniformly mint, so it is the most likely to be genuinely reachable. Each slice
  PINS reachability in its characterization net (reachable => assert the flip;
  documented-unreachable => the codex-style defensive pin), exactly as T3 did.
- **cursor is NOT exposed**: it has no worktree lifecycle, so its deferred branch
  runs only the `safe`-prefixed (error-swallowing) usage-update before returning;
  there is no rejecting terminal in the deferred path. cursor keeps its current
  behaviour with no fence needed (the fence is inert for it).

Installing `FlightOwnership` per exposed handler is therefore a real, valuable
correctness improvement (fencing a latent double-complete), delivered as a
VISIBLE, tested change per the spec's non-negotiable: "do not silently fix the
H-DoubleComplete edge; T3/FlightOwnership is the stage that fences it."

## 3. Decision: route each sibling through the existing `runKitTerminalEnvelope`

**D1 (scope + mechanism).** Route each of the five siblings through the ALREADY
SHIPPED, already-3/3-reviewed `runKitTerminalEnvelope` driver (src/index.ts:2584)
with `kit = null`, `kitSession = null`, and the Kit hooks as no-ops, plus a
per-handler `RequestTerminalLedger` (T2) and `FlightOwnership` (T3). Because the
five share claude's in-try topology, each passes states 4..8 into
`runInsideTerminalTry` (like claude), returns `{ ok:false, earlyResponse }` for
its inline resolve-#1 catch, and lets a front-half throw reach the envelope catch.

Why this over the alternatives:

- **vs a lean "T1 settle-helper only" pass** (replace the raw
  `if (sessionAdmission) transfer() else finishHandler()` with
  `settleWorktreeOnTerminal(worktreeLifecycle, Boolean(sessionAdmission))`): that
  is the smallest change but leaves the H-DoubleComplete hazard unfenced and does
  not de-duplicate the terminal choreography (settle + rollback + usage +
  flight-complete + finally). It is a strictly smaller subset of D1 and forfeits
  the correctness win. Rejected as insufficient for "generalize".
- **vs a NEW non-Kit envelope** (a second driver without the kit fields): that
  doubles the driver surface to maintain and to review, for no behaviour benefit.
  With `kit`/`kitSession = null` the T4 driver's Kit machinery is entirely inert
  (the finalize gate `kit && kitSession && !result.jobId` is false, so
  `finalizeKit` is never called; `cleanupOnException(kitJobHandedOff, error, null,
  false)` skips requestCleanup and `discardPendingPersonalKitSession(runtime,
  null)` is a no-op; `kitAwareErrorResponse(provider, 1, "", corrId, error, null)`
  reduces to `createErrorResponse(provider, 1, "", corrId, error)`, which is
  exactly the siblings' current catch response). Reusing the proven driver is
  lower-risk than authoring and reviewing a parallel one. Rejected as redundant.

**D2 (manager collapse).** For every sibling the three envelope manager fields
are ALL wired to `deps.sessionManager`, and `fireRequestCleanupInCatch = false`
(the siblings never fire a request cleanup in their catch; they only rollback +
complete). The envelope's manager-split and fire flag are inert but must be wired
explicitly to `deps.sessionManager` / `false`, never defaulted.

**D4 (usage-update session id, a required driver change; round-1 blocker).** The
shipped `runKitTerminalEnvelope` uses one `effectiveSessionId` for BOTH the
usage-update (`safeUpdateSessionUsageAfterJobAdmission`, src/index.ts:2611..2615
and 2653..2657) and the deferred response (`buildDeferredToolResponse`, 2618 /
implicit at success). That is correct for claude/codex/gemini (they use one value
for both) but NOT for grok/devin/cursor/mistral, which pass
`userProvidedSession ? effectiveSessionId : undefined` to the usage update while
passing the full minted `effectiveSessionId` to the deferred response. T5 therefore
adds a `usageUpdateSessionId: string | undefined` field to `KitTerminalEnvelope`;
the driver reads it at BOTH usage-update sites (deferred + success) and keeps
`effectiveSessionId` for `buildDeferredToolResponse`. claude/codex/gemini set
`usageUpdateSessionId = effectiveSessionId` (byte-inert: the driver call is
identical); grok/devin/cursor/mistral set
`usageUpdateSessionId = userProvidedSession ? effectiveSessionId : undefined`. This
driver change plus the re-wiring of the claude/codex/gemini env blocks LANDS IN
T5a (gemini), so the field exists for T5b..T5e; it is inert for the two shipped
Kit siblings and for gemini. Each slice's terminal net pins BOTH ids (the deferred
response's session id AND whether a durable usage update fired for a minted
session).

**D5 (devin/cursor terminal-log delta; documented, log-only).** The driver
unconditionally logs three terminal `logger.info` lines (`..._request failed`,
`... completed successfully`, `... threw exception`, at 2637 / 2660 / 2679).
gemini/grok/mistral already emit these; devin and cursor emit NONE of the three
(grep-confirmed). Routing devin/cursor through the driver therefore ADDS three
stderr log lines to those two providers. This is a benign, stderr-only,
non-functional observability delta (no test asserts their absence; no response,
metric, session, flight-row, or worktree behaviour changes). It does NOT affect
T5a (gemini logs them today). The T5c (devin) and T5e (cursor) slices must either
(a) accept the added terminal logs as a documented improvement with review
sign-off, or (b) gate the driver's terminal logs behind a per-context flag. This
design recommends (a) and flags it for ratification when those two slices are cut;
it is out of scope for T5a.

**D3 (staging).** One handler per slice (one PR each), simplest-representative
first, each independently verifiable and cross-LLM reviewed, so the tree never
sits in a half-migrated split for long and each byte-preservation surface is
bounded to one handler:

- **T5a = gemini** (the canonical "gemini-family sibling" the spec names: has a
  worktree lifecycle, applyEffectiveWorkingDirectory, an invoked log, provider
  success-facts, the inline resolve-#1 catch, and the exposed H-DoubleComplete).
  It establishes the non-Kit wiring template + the sibling terminal-net idiom.
- **T5b = grok** (adds: ACP early-return branch stays outside; grok-native
  session/stop metadata in success facts).
- **T5c = devin** (adds: no applyEffectiveWorkingDirectory / no invoked log; NO
  inline resolve-#1 catch; remote-tracked-session lookup).
- **T5d = mistral** (adds: the model-selection retry loop with a second dispatch
  + `rearm()` + a second deferred site, folded into the `execute` hook so the
  driver still sees one result; the retry's deferred handling moves to the
  driver's deferred branch).
- **T5e = cursor** (special/minimal: no worktree lifecycle, onComplete=undefined,
  finally without finishHandler; the ledger is empty, `FlightOwnership` fences
  nothing new; the win is only choreography de-dup. May be descoped if the review
  finds the empty-ledger route adds more indirection than it removes.)

Each slice is scoped and reviewed on its own; this design is the shared contract
they all cite. The DAG plan `docs/plans/request-pipeline-tier-b-t5-generalize.dag.toml`
decomposes T5a (the template slice) in full and lists T5b..T5e as follow-on
slices that reuse this design.

## 4. How each sibling wires the envelope (per-handler hook mapping)

For a sibling `<P>` the handler keeps states 0..3 + its ledger/flight construction
inline, then builds `env` + `hooks` and `return runKitTerminalEnvelope(env, hooks)`:

- **env**: `provider "<P>"`; `kit = null`; `kitSession = null`;
  `usageUpdateManager = failureRollbackManager = exceptionRollbackManager =
  deps.sessionManager`; `fireRequestCleanupInCatch = false`; `effectiveSessionId`
  = the sibling's minted/hint session id (fed to the deferred response);
  `usageUpdateSessionId` (D4) = `effectiveSessionId` for gemini (its hint is used
  for both today), `userProvidedSession ? effectiveSessionId : undefined` for
  grok/devin/cursor/mistral; `optimizationApplied = false` (the driver's fail +
  catch `completeInline` consume `env.optimizationApplied`, and the five hard-code
  `false` there; the real `optimizePrompt || optimizeResponse` flag is carried only
  by the SUCCESS `completeInline` inside `buildSuccessResponse`); `ledger` = a
  `RequestTerminalLedger` (base cleanup = undefined for the siblings, since none
  compose a request cleanup); `flight` = a `FlightOwnership` wrapping the sibling's
  `safeFlightStart` closure and its `safeFlightComplete` closure; `startTime`;
  `outputFormat`.
- **runInsideTerminalTry**: runs the sibling's states 4..8 (worktree resolve,
  applyEffectiveWorkingDirectory + asserts where present, session admission,
  worktree materialize, `ledger.installWorktree(lifecycle)`, `flight.start()`,
  invoked log where present). Its inline resolve-#1 catch returns
  `{ ok:false, earlyResponse: createErrorResponse("<P>_request", ...) }` (gemini,
  grok, mistral, cursor); devin has no inline resolve-#1 catch so a resolve throw
  reaches the envelope catch. Returns `{ ok:true, value:{ worktreeResolution } }`.
- **execute**: the sibling's direct `awaitJobOrDefer(...)` with its bare
  `worktreeLifecycle.onTerminal` (or undefined for cursor) onComplete, plus the
  pre-dispatch `effectiveCompress`/FR-handoff setup (moved into `execute` to keep
  the try boundary). For mistral, `execute` encapsulates the whole
  model-selection retry (first dispatch; on model-selection failure, `rearm()` +
  second dispatch) and returns the final result; if either dispatch defers, it
  returns the deferral and the driver's single deferred branch handles it.
- **decorateDeferred**: omitted for the siblings that return a bare deferral;
  devin attaches its approval + review-integrity decoration.
- **computeSuccessFacts**: extracts the sibling's usage/cost + provider metadata
  (`extractUsageAndCost`, `deriveCostBasis`, `extractProviderOutputMetadata`) and
  returns them; the success `flight.completeInline` in `buildSuccessResponse`
  consumes them. (Non-Kit, so there is no extract-before-finalize hazard; the
  ordering is preserved trivially because `finalizeKit` is a no-op.)
- **finalizeKit**: no-op `async () => {}` (never called: `kit`/`kitSession` null).
- **buildFailureResponse**: the sibling's `buildTerminalCliFailure` +
  `createErrorResponse("<P>", code, stderr, corrId, ...)` body.
- **buildSuccessResponse**: the sibling's `buildCliResponse` + worktree-prefix +
  `safeRecordCompression` + its OWN success `flight.completeInline` consuming the
  facts.

## 5. Byte-preservation matrix (per sibling, every path)

For each slice the following must hold vs the pre-T5 handler at `18f06e3`:

| Path | Pre-T5 (raw inline) | Post-T5 (envelope, kit=null) | Preserved? |
|---|---|---|---|
| Validation / prep / session-arg error (0..3) | inline early return, no metric | stays inline in the handler, no metric | yes |
| Worktree-resolve #1 error | inline early-return `createErrorResponse` (gemini/grok/mistral/cursor); main catch (devin) | `runInsideTerminalTry` ok:false earlyResponse (gemini/grok/mistral/cursor); envelope catch (devin) | yes |
| Argv/assert + session-admission + materialize error | throw -> main catch: rollback(deps)+`safeFlightComplete`+`createErrorResponse`; finally metric | throw -> envelope catch: rollbackOnException(deps)+`flight.completeInline`+`kitAwareErrorResponse(=createErrorResponse)`; finally metric | yes |
| Deferred (10a) | committed=true; settle(sessionAdmission); usage(deps); bare deferred (or devin decorated) | committed=true; transfer-before-settle; `ledger.settle(null)`; usage(deps); decorateDeferred? | yes + adds the T3 fence (deferred now transfers flight completion ownership) |
| Inline success (10c) | committed; settle; usage(deps); build; raw `safeFlightComplete(completed)` | committed; `ledger.settle(null)`; usage(deps); computeSuccessFacts; no-op finalize; buildSuccessResponse owns `flight.completeInline(completed)` | yes |
| Inline failure code!=0 (10b) | rollback(deps); raw `safeFlightComplete(failed)`; `createErrorResponse` | rollbackOnFailure(deps); `flight.completeInline(failed)`; buildFailureResponse | yes |
| Exception (11) | rollback if !committed (deps); UNCONDITIONAL raw `safeFlightComplete(failed)`; `createErrorResponse` | rollbackOnException(deps); `cleanupOnException(_, _, null, false)` (no-op); `flight.completeInline(failed)` (no-op once transferred); `kitAwareErrorResponse` | yes for non-deferred; the deferred-then-throw case is the DELIBERATE H-DoubleComplete fence flip |
| finally (12) | `worktreeLifecycle?.finishHandler()` (absent for cursor) + `recordRequest("<P>")` | `ledger.worktreeLifecycle?.finishHandler()` + `recordRequest("<P>")` | yes |

On the deferred and success paths the usage update targets
`env.usageUpdateSessionId` (D4), NOT `env.effectiveSessionId`, so a gateway-minted
session still gets NO durable usage update for grok/devin/cursor/mistral while the
deferred response still returns the minted `effectiveSessionId`; the fail/catch
`completeInline` uses `env.optimizationApplied = false` for the five, matching
their hard-coded value. The metric count is EXACTLY ONCE per request that enters
the envelope, and the `wasSuccessful`/`durationMs` finally-fallback semantics are
unchanged (deferral = false + wall-clock).

Intended, documented behaviour changes (NOT silent): (1) the H-DoubleComplete
fence on the exposed siblings (gemini/grok/devin/mistral), pinned by each slice's
net; (2) for devin and cursor ONLY, three added terminal `logger.info` lines (D5,
stderr-only, no functional change). Everything else is byte-behaviour-preserving.

## 6. Test plan (per slice)

The existing `<P>-handler.test.ts`, `<P>-argv-golden.test.ts`, and the
provider-specific nets (e.g. `grok-streaming-normalization`, `grok-sync-content`,
`devin-managed-approval`) stay GREEN and UNMODIFIED. Each slice ADDS a
`<P>-handler-terminal-net.test.ts` (mirroring `claude-handler-terminal-net` /
`codex-handler-terminal-net`) driving the handler directly and asserting:

- inline success / failure / exception: `logStart` + `logComplete` once each, the
  async manager never armed, `recordRequest` once with the right `wasSuccessful`;
- deferred (Mode B): the manager IS armed and the handler does NOT inline-complete
  (the FlightOwnership fence), matching the codex/claude terminal nets;
- worktree latch: transfer (session admitted) keeps + binds vs finish (no
  admission) removes;
- H-DoubleComplete: for gemini/grok/devin/mistral, a deferred-then-rejecting
  `finishHandler()` asserts NO second `logComplete` (the fence). Where reachable,
  the net is the reachable pin; where the mint-always case makes it defensive
  (codex-style), the net documents the reachability chain (as
  `codex-handler-terminal-net` does).
- Session-id split (D4): for the siblings that split (grok/devin/cursor/mistral),
  a deferral on a gateway-MINTED session asserts BOTH that the deferred response
  carries the minted `effectiveSessionId` AND that no durable usage update fired
  for it (`usageUpdateSessionId` was `undefined`); a deferral on a USER-provided
  session asserts the usage update did fire. gemini's net asserts the single-value
  behaviour (both use the hint).

`npm run check` green per slice; the full suite test count rises by each slice's
new net.

## 7. Deliverable shape

One PR PER SLICE (T5a gemini first). Each: route one handler through
`runKitTerminalEnvelope` (kit=null) + build its ledger/flight + add its
terminal-net + keep all existing nets green. No new driver, no new abstraction
beyond per-handler wiring. Gate: `npm run check` green, then unconditional
cross-LLM review (Codex + Grok + Mistral), then PR to master via werner_veriai
(`--merge`). This design is the shared contract every slice cites.

## 8. Open decisions the review gate must ratify

- **D1**: accept routing the five non-Kit siblings through the existing
  `runKitTerminalEnvelope` (kit=null) rather than (a) a lean settle-helper-only
  pass or (b) a new non-Kit envelope. Reviewers must confirm the Kit machinery is
  genuinely inert with kit/kitSession null (finalize gate off,
  cleanupOnException no-op, kitAwareErrorResponse == createErrorResponse) so the
  route is byte-preserving except the fence.
- **D2**: confirm the H-DoubleComplete fence is a correct, in-scope, VISIBLE
  change (not a silent fix), and that its reachability is pinned per slice (real
  flip where reachable, codex-style defensive pin where mint-always makes it
  unreachable). Confirm cursor is genuinely NOT exposed.
- **D3**: confirm the per-handler divergences (mistral retry loop folded into
  `execute`; devin's missing resolve-catch / workdir / log and remote-tracked
  sessions; cursor's absent worktree lifecycle and finally; the ACP branches
  staying outside the envelope) are all preserved by the wiring in section 4, and
  ratify the staging order in D3/section 3.
- **D4** (round-1 blocker resolution): confirm the `usageUpdateSessionId` field
  correctly decouples the usage-update id from the deferred-response id, that
  setting it equal to `effectiveSessionId` for claude/codex/gemini is byte-inert,
  and that the driver change (read it at both usage sites, keep `effectiveSessionId`
  for the deferred response) preserves the shipped Kit-sibling behaviour.
- **D5**: ratify the devin/cursor terminal-log delta as an acceptable documented,
  stderr-only change (option a), or require gating it (option b), when the T5c and
  T5e slices are cut. Confirm it does not affect T5a.
