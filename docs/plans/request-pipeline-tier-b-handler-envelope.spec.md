# Tier-B HandlerEnvelope: grounding and staged extraction plan

Status: DRAFT rev 3 (grounding complete; round-1 + round-2 cross-LLM review by
Grok + Codex + Mistral against master 162b57b. Grok gave unconditional approval at
rev 2; rev 3 folds in the round-2 Codex/Mistral fix that the catch guard skips
BOTH request cleanup and pending-Kit-session discard under
`!kitJobHandedOff && !(error instanceof KitTerminalFinalizationError)`).
Companion to the Tier-A
`PrepPipeline` already shipped (PRs #197 phase-0, #199 Policy, #200 display
helper). This document reconstructs the Tier-B half of the RequestPipeline
design (formerly "design draft v5, section 5.2+") from the real handler, because
the original draft lived only in a working session and is not on disk. Every
claim below is anchored to `src/index.ts` line numbers verified against the code
at master `162b57b`.

## 1. What Tier-B is

Tier-A (`PrepPipeline`) is the request-preparation front: ordinal stages
10..50 (InputGuards, InputResolve, Integrity, PromptShape, Policy) that end at
the fixed `ArgvAndMcp` sub-block, producing a `CliRequestPrep`
(`prepareClaudeRequest`, index.ts:4667). It is pure and provider-generic.

Tier-B PROPER is everything the sync `claude_request` handler does after prep
returns `{ args, mcpConfig, ... }`: the post-prep body from index.ts:15418. But
the pre-prep half of the same tool callback (Kit resolve + native-continuation
planning + the `prepareClaudeRequest` call, 15231..15417) is not separable from
it, so the T0 extraction unit is the WHOLE callback body **index.ts:15156..15936**,
not the post-prep slice alone. It is NOT pure: it mutates durable session state,
creates and tears down git worktrees, writes the flight recorder, and can hand
the whole request off to the async job manager mid-flight. The HandlerEnvelope is
the fixed state machine that names that sequence and makes its two load-bearing
sub-systems (flight-recorder ownership, split cleanup ledger) first-class instead
of inline-and-duplicated.

## 2. The fixed post-prep sequence (the state machine)

Verified control flow of the sync claude handler:

| # | State | index.ts | Notes |
|---|-------|----------|-------|
| 0 | prep returned | 15418 | `{ corrId, args, mcpConfig }` destructured |
| 1 | Kit artifact/session materialize | 15419..15452 | only after prep admission; own cleanup on throw |
| 2 | Ledger init + session-args admit | 15453..15471 | `baseRequestCleanup` composed; `insertAndAdmitFinalSessionArgs` |
| 3 | Session resolve (BEFORE flight) | 15473..15508 | load-bearing: TTL warning + FR row tag read prior row |
| 4 | Worktree resolve (deferred) | 15514..15540 | `deferWorktree:true`; `applyEffectiveWorkingDirectory` |
| 5 | Session admission mutation | 15544..15569 | `persist/createSessionWithResolvedScope`; fills `sessionAdmission` |
| 6 | Worktree materialize | 15570..15587 | second resolve (actual create); `advanceSessionAdmissionWorktree` |
| 7 | Lifecycle compose | 15588..15593 | `createRequestOwnedWorktreeLifecycle`; recompose `requestCleanup` |
| 8 | Flight start | 15594..15613 | `safeFlightStart(personalKitFlightStart(...))` |
| 9 | Execute | 15615..15676 | `awaitJobOrDefer` inside `runWithPersonalKitAttemptLease` |
| 10a | Deferred terminal | 15679..15697 | transfer-or-finish; usage update; `buildDeferredToolResponse` |
| 10b | Failure terminal (code!=0) | 15702..15764 | rollback; failed flight-complete; error response |
| 10c | Success terminal (code 0) | 15765..15898 | transfer-or-finish; completed flight-complete; `buildCliResponse` |
| 11 | catch | 15899..15929 | guarded rollback + cleanup + failed flight-complete |
| 12 | finally | 15930..15934 | `worktreeLifecycle.finishHandler()`; `recordRequest` |

Ordering invariants that MUST survive any extraction:
- Session resolution precedes `safeFlightStart` (state 3 before 8) so the TTL
  warning and the flight row read the prior session's `lastWriteAt`, not the row
  about to be written (comment 15473..15478, codex-r1/F1).
- Worktree resolve is deferred (state 4, `deferWorktree:true`) then materialized
  only after session admission (state 6) so resume-reuse can read
  `metadata.worktreePath`.
- The `finally` (state 12) always runs `finishHandler()` even after transfer.
  Precise semantics: `finishHandler` after `transfer()` does not INITIATE
  cleanup (it still sets the `handlerFinished` latch and awaits `maybeCleanup()`,
  which early-returns because `transferred` is set, 2188..2196). It is not a
  literal no-op: if a cleanup promise was already created it will await it.

## 3. Flight-recorder ownership modes (three, first-class)

Selector flags live on the async job admission: `writeFlightStart` (who writes
`logStart`) and `flightCompleteArmed` (who writes `logComplete`).

- **Mode A: Handler-owned inline** ("grok_api model", index.ts:8988..8992).
  Handler writes both ends; manager inert. The arm flag is set conditionally,
  `flightCompleteArmed: writeFlightStart === true` (NOT a literal false): for
  Claude's process path in `startJobWithDedup` at async-job-manager.ts:3567 (the
  HTTP `startHttpJob` equivalent is 2496, also conditional). Because
  `writeFlightStart` is false on the sync-inline path, the flag is false and the
  manager's `writeFlightComplete` early-returns (async-job-manager.ts:2800..2805).
  Claude sync-inline is this mode: `safeFlightStart` 15594, inline
  `safePersonalKitFlightComplete` 15731 / 15813 / 15862 / 15914.
- **Mode B: Handler-start, manager-complete** (sync-deferred). Handler wrote
  `logStart`; at the sync deadline `armFlightCompleteForDeferral(job.id)`
  (index.ts:1719 CLI, 1877 HTTP) sets `flightCompleteArmed=true` so the manager
  owns completion. The manager's completion is `writeFlightComplete` calling
  `this.flightRecorder.logComplete` (async-job-manager.ts:2863..2889); the
  status-guarded SQL UPDATE itself lives in flight-recorder.ts (`updateCompleteTxn`,
  ~604/674), NOT in async-job-manager.ts:842..850 (that range is only the
  `flightCompleteArmed` field comment). On this path the handler must NOT also
  complete. `writeFlightStart` is never true here.
- **Mode C: Manager-owned** (pure `*_request_async`). `writeFlightStart:true`
  (index.ts:9172) so the manager owns both `logStart` (async-job-manager.ts:2581)
  and `logComplete`. Also the #139 orphan-recovery completion writer
  (async-job-manager.ts:1667..1669).

Envelope requirement: the mode is a function of (async-enabled, deferred-at-
deadline). The envelope selects the mode once and the terminal branches consult
it, rather than each branch open-coding "did we defer?" checks.

## 4. Split cleanup ledger (two halves, one transfer boundary)

The boundary event is the transfer/handoff: either a deferral (Mode B) or a
durable session-admission that outlives the request.

**Half 1: request-scoped, freed inside this handler invocation.**
`composeRequestCleanup` (index.ts:4181..4204) is an idempotent (`completed`
latch) fan-out. Claude composes it twice:
- `baseRequestCleanup = composeRequestCleanup(runtime, prep.cleanup, kit?.artifact?.cleanup)`
  at 15453 (request-scoped MCP config artifact + Kit compiled-context artifact).
  Note the leading `runtime` arg on every real call site (4181 / 15453 / 15589);
  T0 must move the real call sites, not re-type from these shorthand snippets.
  The pre-worktree guard paths fire THIS one by name: `baseRequestCleanup` at
  15468, and `requestCleanup` (which still aliases baseRequestCleanup until the
  recompose) at 15490 / 15528.
- recomposed to fold in the worktree latch:
  `requestCleanup = composeRequestCleanup(base, worktreeLifecycle.onTerminal)`
  at 15589. Passed to the executor as the terminal `onComplete` (15649) and
  fired on the exception path (15909).

The worktree half is a 3-latch state machine (`createRequestOwnedWorktreeLifecycle`,
index.ts:2178..2223): `maybeCleanup` removes the request-owned worktree only when
`!transferred && terminal && handlerFinished`. `onTerminal` sets the terminal
latch, `finishHandler()` sets the handler latch, `abort()` forces both,
`transfer()` disowns, `rearm()` re-opens terminal.

**Half 2: durable / transferred, freed out-of-band after ownership leaves.**
- Session-owned worktree: `advanceSessionAdmissionWorktree` (1990..2001) moves it
  onto the `SessionAdmissionMutation`; `transfer()` disowns the request half; the
  worktree is later removed on session delete via `ensureWorktreeSessionCleanup`
  (7447..7473) then `cleanupAndAcknowledge` (7452..7465) then
  `cleanupSessionWorktree`, retried on startup by
  `listPendingWorktreeCleanupSessions()`.
- Transferred MCP artifact: on defer, path/scope are threaded into
  `startJobWithDedup` (15673..15674) so the manager owns removal until durable
  ack. Post-prep double-free is prevented by THREE mechanisms, none of which is
  `mcpConfigHandedOff`: the `composeRequestCleanup` `completed` latch
  (4190..4193), the `awaitJobOrDefer` onComplete ownership transfer
  (1550..1669), and the manager's `artifactCleanupFired` guard
  (async-job-manager.ts ~2767..2770). `mcpConfigHandedOff` is a DIFFERENT,
  prep-internal guard living entirely inside `prepareClaudeRequest`
  (index.ts:4779 / 5102 / 5124): it governs whether the prep `finally` cleans up
  the MCP artifact or returns `cleanup: mcpConfig.cleanup` to the caller. Do not
  conflate the two ownership chains.

**Release matrix (the 5 paths the Tier-B acceptance net must pin):**

| Path | Session admission | Worktree | Flight complete |
|------|-------------------|----------|-----------------|
| Deferred (10a) | committed; usage updated (non-kit) | `transfer()` if sessionAdmission OR kitSession else `finishHandler()` | Mode B (manager) |
| Inline success (10c) | committed; usage updated (non-kit) | same transfer-or-finish | Mode A completed |
| Inline failure code!=0 (10b) | `rollbackSessionAndWorktreeAdmission` gated `if (!kitSession)` (15703) | rollback: transfer+cleanupBound / abort | Mode A failed |
| Exception (11) | rollback gated `if (!kitSession && !sessionAdmissionCommitted)` (15900) | guarded block (`requestCleanup?.()` + `discardPendingPersonalKitSession`) gated `!kitJobHandedOff && !(err instanceof KitTerminalFinalizationError)` (15908) + finally `finishHandler` | Mode A failed |
| Failed admission (pre-exec) | none / rolled back | `validateResolvedWorktreeForWorkspace` removes just-created | none |

The Kit gates above are load-bearing: the envelope's settle/rollback API must
take `kitSession` / `kitJobHandedOff` as inputs, not assume the non-kit shape.

**Known pre-existing hazard the envelope must eventually fence (H-DoubleComplete):**
On the deferred path (Mode B, manager armed) taken via the `else` branch at
15684 (no sessionAdmission and no kitSession), the `await finishHandler()` awaits
worktree cleanup (`removeWorktree`) and CAN reject. Its rejection is caught at
15899. The guard at 15908 is `if (!kitJobHandedOff && !(error instanceof
KitTerminalFinalizationError))` and it skips the WHOLE guarded block, i.e. BOTH
`requestCleanup?.()` AND `await discardPendingPersonalKitSession(...)`, but it
does NOT guard the unconditional inline `safePersonalKitFlightComplete` at 15914.
So a rejecting post-handoff cleanup causes the handler to write an inline flight
completion AFTER the manager was armed to own it: an ownership ambiguity /
possible double-complete. This is PRE-EXISTING; T0 (a pure move) preserves it
byte-for-byte. The T0.5 net must cover it, and a later envelope stage (T3,
FlightOwnership) should fence it (do not inline-complete once armed).

## 5. Target shape (layered inside the extracted handler, stages T1+)

The envelope is generic machinery: no provider logic, no gateway-server import
(same discipline as `PrepPipeline`). Two cohesive units, wired by a thin driver:

1. `FlightOwnership`: resolves Mode A/B/C once and exposes `start()`,
   `completeInline(metadata)` (no-op under Mode B/C), and the deadline arm hook.
2. `RequestTerminalLedger`: owns the two halves and the settle decisions.
   `settleOnSuccessOrDefer({ sessionAdmission, kitSession })` is the transfer-or-
   finish branch, currently duplicated at 15683..15684 and 15767..15768. Its
   transfer predicate is Kit-aware (`sessionAdmission || kitSession`), NOT just
   `sessionAdmission` (that distinguishes Claude from the gemini sibling). The
   `rollbackOnFailure(...)` and exception paths are likewise `kitSession`-gated
   (15703, 15900) and `kitJobHandedOff`-gated (15908), so those flags are ledger
   inputs, not handler-local afterthoughts.

The driver replays states 0..12 against these units. Provider entanglement (Kit,
per-provider parse) stays in the driver via injected callbacks, not inside the
generic units.

## 6. Codebase reality that reshapes the plan

The codebase ALREADY has a proven, reviewed handler-extraction idiom.
`handleGrokRequest(deps: HandlerDeps, params: GrokRequestParams):
Promise<ExtendedToolResponse>` (index.ts:10141) and its siblings for gemini
(9435), devin (10968), cursor (11693), mistral (12270) are standalone exported
functions; each `server.tool(...)` registration just parses inputs into `params`
and calls the function (17179, 17422, 17638, 17800, 18001). `resolveHandlerRuntime(deps)`
(9407) unwraps the runtime and wires the session-cleanup observers. Those
handlers are directly driveable in tests (see
`sync-terminal-failure-redaction.test.ts` calling `handleGrokRequest(deps, ...)`
inside `runWithRequestContext`).

Claude and codex-sync are the two laggards still fully inline: the claude body
lives inside the `server.tool("claude_request", ...)` closure at
index.ts:15156..15936, and no `ClaudeRequestParams` type exists yet. The
HandlerEnvelope target function signature IS this existing idiom; the "state
machine + first-class ownership modes + split ledger" is the layer added INSIDE
that function once claude is extracted.

## 7. Staged extraction plan (each stage: own PR, green gate, unconditional cross-LLM review)

- **Stage T0 (the first increment): extract `handleClaudeRequest(deps, params)`
  as a standalone exported function**, mirroring the five existing extracted
  handlers, and reduce the `claude_request` tool closure to parse-and-call.
  Define `ClaudeRequestParams` (mirroring `GrokRequestParams`). This is a
  behavior-preserving mechanical move that (a) matches a reviewed 5-provider
  pattern and (b) makes claude directly driveable in tests, which the following
  stages depend on. Guarded by the full existing claude suite (claude-prep-parity,
  personal-config-flight-recorder-privacy, claude-kit-preadmission, the routed
  sync-terminal-failure path) staying green untouched.
  T0 HAZARDS that make this bigger than a `GrokRequestParams`-scale copy (the
  five extracted handlers do NOT carry these; codex-sync is the only true peer):
  1. Kit entanglement is pervasive and load-bearing: `resolvePersonalKitRequest`
     (15237), preferences/planned args (15289..15408), post-prep
     `materializeClaudeKitArtifact` / `resolvePersonalKitSession` (15419..15451),
     `runWithPersonalKitAttemptLease` + terminal hooks (15634..15676),
     `finalizePersonalKitSessionOrThrow` (15718 / 15779), and the `kitSession` /
     `kitJobHandedOff` cleanup gating. All must move intact.
  2. Free-var rebinding checklist: the callback uses bare `sessionManager`,
     `logger`, `performanceMetrics` (15933) and the ambient `runtime` captured
     from `createGatewayServer`. The extracted function must route these through
     `resolveHandlerRuntime(deps)` + `deps.*` (as gemini does at 9439). Missing
     one is a silent behavior/test break.
  3. Claude-only cleanup composition: Claude composes MCP + Kit artifact +
     worktree via `composeRequestCleanup` and threads MCP path/scope into the job
     (15673..15674); gemini passes only `worktreeLifecycle.onTerminal`. The move
     is fine, but do not assume ledger sameness with the five.
  4. `ClaudeRequestParams` is a large, Kit-coupled surface (tool schema
     ~14942..15148: dual system prompts, MCP, worktree, `requestInstructions`,
     etc.), not a small copy-paste.
- **Stage T0.5 (safety net): Tier-B characterization net** against
  `handleClaudeRequest`, asserting for each terminal path: the flight ownership
  call sequence (start / inline-complete / arm), the worktree latch outcome
  (transfer vs finishHandler vs abort), whether the request-scoped cleanup fired,
  and session admission commit vs rollback. The net MUST include the Kit variants
  (Kit deferred / success / failure / exception, and the `kitJobHandedOff` +
  `KitTerminalFinalizationError` cleanup-skip at 15908). For H-DoubleComplete the
  net asserts the CURRENT (pre-fence) behavior explicitly: when the job deferred
  (manager armed) AND the post-handoff `finishHandler()` rejects, the handler
  DOES today write an inline `safePersonalKitFlightComplete` (15914). Pinning the
  pre-existing behavior is what lets T3 flip it to "manager is sole completer
  once armed" as a visible, reviewed change rather than a silent one.
- **Stage T1: extract the settle decision.** Replace the two duplicated
  transfer-or-finish sites (15683, 15767) with a single
  `settleWorktreeOnTerminal(outcome, ledger)` helper. Smallest possible move;
  net stays green; also de-duplicates the identical gemini/codex sites later.
- **Stage T2: introduce `RequestTerminalLedger`** wrapping `requestCleanup` +
  `sessionAdmission` + `worktreeLifecycle`, with the rollback/settle/finish
  methods. Handler holds one ledger object instead of five locals.
- **Stage T3: introduce `FlightOwnership`** wrapping the mode selection + the
  inline-complete / arm decisions.
- **Stage T4: the driver.** Replay states 0..12 against the two units; the
  handler body shrinks to the driver call plus provider/Kit callbacks.
- **Stage T5: generalize** to the other handlers. NOTE: they are SIBLINGS, not
  byte-identical. Gemini's settle is `if (sessionAdmission)` (9618..9621) with no
  `|| kitSession`, its executor `onComplete` is the bare `worktreeLifecycle.onTerminal`
  (not a composed `requestCleanup`), and it has no Kit finalize or dual stream-json
  complete branches. The nearest true sibling to Claude is codex-sync (still
  inline at 15943+), which shares the Kit surface (`runWithPersonalKitAttemptLease`,
  the same cleanup composition, the same Kit finalize hooks). The T1 settle helper
  therefore needs an explicit transfer predicate parameter, not a byte-identical
  merge. Because codex-sync is the one remaining inline Kit handler, extract it in
  immediate succession (a T0.1 mirroring T0) so the tree does not sit long in a
  "6 extracted + 1 inline" split; do the Kit-aware envelope layering (T1+) once,
  against both.

## 8. Non-negotiable invariants (regression fences)

- Tier-A nets (`prep-pipeline.test.ts`, `claude-prep-parity.test.ts`) stay green
  untouched; Tier-B work must not perturb prep.
- Flight row is tagged with `effectiveSessionId` and written after session
  resolution, never before (state 3 < state 8).
- On the deferred path (Mode B) the handler must not inline-complete the flight
  recorder EXCEPT for the one pre-existing H-DoubleComplete edge (section 4):
  T0 preserves that edge byte-for-byte; T3 (FlightOwnership) is the stage that
  fences it. Do not silently "fix" it during T0, and do not claim it is already
  impossible.
- `finishHandler()` after `transfer()` does not INITIATE cleanup (the
  `transferred` latch short-circuits `maybeCleanup`), but is not a literal no-op;
  the finally must remain unconditional.
- Rollback/transfer/cleanup are Kit-gated: `rollbackSessionAndWorktreeAdmission`
  runs only `if (!kitSession)` (15703 / 15900). In the catch, the guarded block
  runs `requestCleanup?.()` AND `discardPendingPersonalKitSession(...)` together,
  under the full condition `!kitJobHandedOff && !(error instanceof
  KitTerminalFinalizationError)` (15908). The envelope's ledger API must take
  BOTH gate inputs and preserve the dual action; dropping either (or splitting
  the two cleanup calls across the gate) corrupts Kit finalization.
- On defer, the MCP artifact path/scope are handed to the job (15673..15674) and
  the manager owns removal thereafter; the sync path must not double-free (guards
  in section 4).
- Principal isolation: no `sessionId` / `workingDir` / `worktree` from another
  principal is ever threaded in (unchanged from today).
- No em dash anywhere; snake_case tool names; stderr-only logging.
