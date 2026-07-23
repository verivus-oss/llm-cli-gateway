# RequestPipeline: the async-enqueue envelope (non-Kit siblings)

Status: DESIGN (pre cross-LLM review). Base: master `c2f871e` (Tier-B complete).
Scope decision recorded 2026-07-23: the 5 non-Kit async siblings first; the 2 Kit
async handlers deferred.

## 1. Context

Tier-A (`PrepPipeline`) and Tier-B (`runKitTerminalEnvelope`) factored the SYNC
request handlers. This design extends the same DRY discipline to the `*_request_async`
handlers, which are still the pre-Tier-B legacy inline shape.

The async handlers are structurally DIFFERENT from the sync terminal envelope and MUST
NOT reuse `runKitTerminalEnvelope`. A sync handler dispatches via `awaitJobOrDefer`
(Mode A inline / Mode B defer) and owns a terminal choreography (deferred/failure/
success/catch/finally + flight completion + the H-DoubleComplete fence + a
`recordRequest` metric). An async handler is pure **Mode C**: it `startJob`s
(fire-and-forget enqueue), the AsyncJobManager owns the flight recorder (via the FR
handoff) and the terminal metric, and the handler simply returns a job reference. There
is therefore:

- NO inline/deferred/failure/success branching (the only outcomes are "job started" or
  "threw before handoff").
- NO in-handler flight completion (`safeFlightComplete` is never called; the manager
  writes both flight ends for this corrId).
- NO `recordRequest` and NO `finally`.
- NO H-DoubleComplete hazard (there is no inline completion to double).

So this is a NEW, simpler driver: `runAsyncEnqueueEnvelope`.

## 2. Scope

IN scope (the 5 uniform non-Kit standalone handlers):

| provider | handler | lines @ c2f871e |
|----------|---------|-----------------|
| gemini | `handleGeminiRequestAsync` | 11608..11822 |
| grok | `handleGrokRequestAsync` | 12312..12565 |
| devin | `handleDevinRequestAsync` | 13039..13241 |
| cursor | `handleCursorRequestAsync` | 13741..13945 |
| mistral | `handleMistralRequestAsync` | 14371..14605 |

OUT of scope (deferred; the 2 Kit async handlers):

- `handleCodexRequestAsync` (14607..15007) is standalone but carries the full Personal
  Agent Config Kit machinery (isolation plan, durable session lease, attempt-lease
  wrapper around `startJob`, a manager-side terminal finalizer threaded through
  `startJob` args 16/17/18, `kitJobHandedOff`, kit-aware error/discard at every exit).
- claude async is NOT extracted: it lives inline in the `claude_request_async`
  `server.tool(...)` closure (~18538..19315, ~510 lines of logic) and is a full second
  Kit sibling. Enveloping it requires a T0-style extraction (`handleClaudeRequestAsync`)
  as a prerequisite.

Rationale for deferring both: the async Kit path is heavier than even the sync Kit path,
and (per the Tier-B T4 lesson) forcing a divergent topology into a shared driver caused
the only rejected T4 attempts. The non-Kit 5 are uniform and factor cleanly; prove the
async envelope there first, then decide separately whether the Kit async handlers join
it or get a lighter dedicated treatment.

## 3. The shared non-Kit async-enqueue shape

All 5 non-Kit async handlers are the same skeleton (line cites from grok, the fullest):

**Pre-try front half (provider-specific, stays in the handler, OUTSIDE the driver):**
reject-unreachable-worktree (grok/devin/mistral) / none (gemini/cursor); `resolveX
SessionArgs` in its own try/catch -> early `createErrorResponse("X_request_async", ...)`;
`prepareXRequest` with `if (!("args" in prep)) return prep`; destructure `{ corrId, args,
... }`; `insertAndAdmitFinalSessionArgs(...)` (or gemini's `args.push(...) +
assertFinalCliArgvAdmission`) in its own try/catch -> early error.

**Main try (states 4..8 + enqueue + settle):**
1. derive/mint `effectiveSessionId`
2. `existingSession` lookup (userProvidedSession-gated, except gemini unconditional)
3. worktree resolve #1 (`deferWorktree: true`), in an inner try/catch -> early
   `createErrorResponse("X_request_async", ...)` (devin has NO inner catch)
4. `applyEffectiveWorkingDirectory(...)` (devin has NONE)
5. asserts: `assertUpstreamCliArgs` / `assertUpstreamCliEnv` / `assertFinalCliProcess
   Admission` (mistral threads `mistralEnv`)
6. session admission -> sets `sessionAdmission`, may mint `effectiveSessionId`
7. worktree resolve #2 `if (params.worktree)` + `advanceSessionAdmissionWorktree`
8. `worktreeLifecycle = createRequestOwnedWorktreeLifecycle(...)` (cursor: NONE)
9. `effectiveCompress`; `buildAsyncFlightRecorderHandoff(...)`
10. `deps.asyncJobManager.startJob(...)` (19 positional args)
11. `jobHandedOff = true`
12. settle: `if (sessionAdmission) worktreeLifecycle.transfer() else await worktree
    Lifecycle.finishHandler()` (cursor: NONE)
13. `safeUpdateSessionUsageAfterJobAdmission(mgr, <usage id>, runtime)`
14. `deps.logger.info("[corrId] X_request_async started job <id>")`
15. build + return the success JSON (`{ success, job, sessionId, ... }`)

**Catch:** `if (!jobHandedOff) await rollbackSessionAndWorktreeAdmission(mgr,
sessionAdmission, worktreeLifecycle, runtime)`; return `createErrorResponse
("X_request_async", 1, "", corrId, error)`.

**No finally, no recordRequest, no flight completion.**

## 4. Decisions

### D1 - a new driver, not `runKitTerminalEnvelope`

`runAsyncEnqueueEnvelope<T>(env, hooks)` owns exactly: one `try { runInsideTry;
enqueue; jobHandedOff/settle/usage/log; buildSuccessResponse } catch { rollback-if-not-
handed-off; error }`. No flight ownership, no fence, no metric, no finally. Generic
machinery only (no provider literals beyond the `provider` label / error id), same
discipline as the Tier-B units.

### D2 - reuse the T2 `RequestTerminalLedger` (verified byte-exact)

The non-Kit async worktree/session terminal bookkeeping is ALREADY exactly what the
ledger encodes:

- inline `if (sessionAdmission) transfer() else await finishHandler()`
  == `ledger.settle(null)` (which calls `settleWorktreeOnTerminal(worktreeLifecycle,
  Boolean(sessionAdmission || null))`, and no-ops when `worktreeLifecycle` is undefined
  - matching cursor, which installs none). Confirmed against `settleWorktreeOnTerminal`
  and `RequestTerminalLedger.settle` at c2f871e.
- catch `if (!jobHandedOff) rollbackSessionAndWorktreeAdmission(mgr, sessionAdmission,
  worktreeLifecycle, runtime)` == `ledger.rollbackOnException(null, mgr)` gated on
  `!sessionAdmissionCommitted`, provided the driver sets `ledger.sessionAdmission
  Committed = true` at the same instant the handler sets `jobHandedOff = true` (right
  after `startJob` returns). The two latches are then identical.

The driver therefore holds a `RequestTerminalLedger`; `runInsideTry` sets
`ledger.sessionAdmission` and calls `ledger.installWorktree(...)` (non-cursor); the
driver runs `ledger.settle(null)` on success and `ledger.rollbackOnException(null, mgr)`
in the catch.

IMPORTANT byte-preservation nuance: the non-Kit handlers pass `worktreeLifecycle.on
Terminal` DIRECTLY as `startJob` arg #9 (`onComplete`). They do NOT pass a composed
`requestCleanup` (that composition is a codex/claude Kit-path detail). So the `enqueue`
hook MUST pass `ledger.worktreeLifecycle?.onTerminal` as arg #9, NOT `ledger.request
Cleanup`. The catch path likewise fires NO `requestCleanup` (`ledger.cleanupOnException`
is not called for the non-Kit async siblings); worktree removal on failure is entirely
inside `rollbackSessionAndWorktreeAdmission`. This mirrors the sync non-Kit siblings
(`fireRequestCleanupInCatch = false`, and the sync non-Kit success leaf never fired
requestCleanup either).

### D3 - the mint STAYS in `runInsideTry`; `TValue` carries it; usage id is pre-mint

REFINED after starting A1 (supersedes the earlier "hoist the mint" phrasing). Unlike the
sync handlers, the async mint is entangled with admission (it fires inside the `else if
(!createNewSession && !effectiveSessionId)` branch and does the `createSessionWithResolved
Scope` inline), and each provider's async admission SHAPE differs from its sync sibling.
Restructuring it to the sync "hoist" form would risk a behaviour change, so the async
admission (incl. its mid-body mint) stays VERBATIM inside `runInsideTry`, and the post-mint
`effectiveSessionId` is returned in `TValue` for `buildSuccessResponse` (it is what feeds
`sessionId || null` and the `gatewaySessionId` field).

`env.usageUpdateSessionId` is still a plain pre-hook field, because it is provably equal to
its pre-mint form: the usage id is `userProvided ? effectiveSessionId : undefined`, and the
mint fires ONLY when `!userProvided` (a fresh, no-sessionId request), where the ternary is
`undefined` regardless of the mint. So `userProvided ? effectiveSessionId(post-mint) :
undefined` == `userProvided ? sessionResult.effectiveSessionId : undefined`, computable
before the hook. gemini is the outlier: it passes the id DIRECTLY (no split) and never
mints (`effectiveSessionId = sessionPlan.resumed ? params.sessionId : undefined`), so its
`usageUpdateSessionId` is exactly that derivation and its `TValue.effectiveSessionId` is the
same value.

### D4 - per-provider deltas (the driver must accommodate all five)

| aspect | gemini | grok | devin | mistral | cursor |
|--------|--------|------|-------|---------|--------|
| worktree lifecycle | yes | yes | yes | yes | NONE (arg#9 undefined, no settle, rollback worktree undefined) |
| inner worktree-resolve catch (`ok:false` seam) | yes | yes | NO | yes | yes |
| `applyEffectiveWorkingDirectory` | `--add-dir` only | `--cwd` | NONE | `--workdir`+`--add-dir` | `--add-dir` only |
| CLI token vs provider token | agy/gemini | grok/grok | devin/devin | vibe/mistral | cursor-agent/cursor |
| `startJob` arg #8 (env) | undefined | undefined | undefined | `mistralEnv` | undefined |
| mints effectiveSessionId | NO | yes | yes | yes | yes |
| existingSession lookup | unconditional | userProvided-gated | userProvided-gated | userProvided-gated | userProvided-gated |
| usage id (D4 split) | `effectiveSessionId` DIRECT (no split) | `userProvided ? id : undefined` | `userProvided ? id : undefined` | `userProvided ? id : undefined` | `userProvided ? id : undefined` |
| `outputFormat` into FR handoff | `params.outputFormat` | `params.outputFormat` | `undefined` | `params.outputFormat` | `params.outputFormat` |
| success JSON extras | resumable=sessionPlan.resumed; approval; mcpServers; reviewIntegrity?; worktreePath? | gatewaySessionId/resumable; approval; mcpServers; reviewIntegrity?; worktreePath? | same as grok | same as grok | minimal (success, job, sessionId, gatewaySessionId/resumable) |

The driver stays generic; every row above is provider-owned inside the `runInsideTry` /
`enqueue` / `buildSuccessResponse` hooks or a per-context `env` field (`usageUpdate
SessionId`, `provider`, `logger`, the managers). No new behaviour is introduced (this is
byte-preserving, unlike the sync D5 which added terminal log lines - async already logs
only the single "started job" line, and that stays).

### D5 - the driver interface (proposed)

```
interface AsyncEnqueueEnvelope {
  runtime; logger;                 // deps.logger sink for the "started job" line
  provider: CliType;               // label + "<provider>_request_async" error id
  corrId: string;
  effectiveSessionId: string | undefined;      // hoisted (D3)
  usageUpdateSessionId: string | undefined;    // D4 split; gemini = effectiveSessionId
  ledger: RequestTerminalLedger;
  usageUpdateManager; rollbackManager;         // both deps.sessionManager for all five
}
// NOTE (review r1, OQ2): no `startTime` field - async has no duration metric and no
// "completed in Xs" log; carrying it would invite a false sync-envelope copy. Dropped.

interface AsyncEnqueueHooks<TValue> {
  // states 4..8: resolve, asserts, admission (sets ledger.sessionAdmission),
  // worktree materialize + ledger.installWorktree (non-cursor). { ok:false } early-returns.
  runInsideTry(): Promise<{ ok: true; value: TValue } | { ok: false; earlyResponse }>;
  // build FR handoff + call startJob(...) with the provider's exact 19 args
  // (arg #9 = ledger.worktreeLifecycle?.onTerminal). Returns the started job.
  // The return type is the manager's real `AsyncJobSnapshot` (async-job-manager.ts),
  // NOT a placeholder - flagged by both r1 reviewers.
  enqueue(value: TValue): Promise<AsyncJobSnapshot>;
  // provider-specific success JSON (grok/devin/mistral: gatewaySessionId/resumable/
  // approval/mcpServers/reviewIntegrity?/worktreePath?; gemini: resumable=plan.resumed;
  // cursor: minimal). Provider-only context (worktreeResolution, approvalDecision,
  // requestedMcpServers, session flags) rides in TValue (OQ4), never widening the driver.
  buildSuccessResponse(args: { value: TValue; job: AsyncJobSnapshot }): ExtendedToolResponse;
}
```

Driver body:

```
async function runAsyncEnqueueEnvelope(env, hooks) {
  let jobHandedOff = false;
  try {
    const staged = await hooks.runInsideTry();
    if (!staged.ok) return staged.earlyResponse;   // early return, no rollback (nothing committed)
    const job = await hooks.enqueue(staged.value);
    jobHandedOff = true;
    env.ledger.sessionAdmissionCommitted = true;   // == jobHandedOff latch
    await env.ledger.settle(null);                 // transfer / finishHandler / no-op(cursor)
    await safeUpdateSessionUsageAfterJobAdmission(env.usageUpdateManager, env.usageUpdateSessionId, env.runtime);
    env.logger.info(`[${env.corrId}] ${env.provider}_request_async started job ${job.id}`);
    return hooks.buildSuccessResponse({ value: staged.value, job });
  } catch (error) {
    if (!jobHandedOff) await env.ledger.rollbackOnException(null, env.rollbackManager);
    return createErrorResponse(`${env.provider}_request_async`, 1, "", env.corrId, error as Error);
  }
}
```

Note the two early-return worktree-resolve `ok:false` seams currently return DIRECTLY
from inside the try (no rollback runs, because nothing is committed yet). The driver's
`if (!staged.ok) return staged.earlyResponse` reproduces that: it returns before
`jobHandedOff` and before any rollback. The pre-try front half stays in the handler.

## 5. Byte-preservation invariants (the review must confirm)

1. `ledger.settle(null)` is byte-identical to the inline transfer/finish for each of the
   4 lifecycle providers, and a no-op for cursor.
2. `ledger.rollbackOnException(null, mgr)` gated on `sessionAdmissionCommitted` reproduces
   the `if (!jobHandedOff)` catch rollback (same args: sessionAdmission, worktreeLifecycle).
3. arg #9 to `startJob` remains `worktreeLifecycle.onTerminal` DIRECT (not `requestCleanup`).
4. the two provider-specific error ids on the pre-try + inner-catch early returns stay
   `"<provider>_request_async"`, and the catch id stays the same.
5. the usage id keeps the per-provider form (gemini direct; the other four D4-split).
6. the success JSON is byte-identical per provider (all conditional fields preserved).
7. no `finally`, no `recordRequest`, no flight completion is introduced.
8. nothing outside each migrated handler changes; the async Kit handlers (codex, inline
   claude) are untouched.

## 6. Staging

One PR per handler (proven cadence), each: wire the handler through
`runAsyncEnqueueEnvelope` + a new `<provider>-async-handler-net` characterization net +
the ultracode multi-lens verification + the 3/3 external gate + CI + `--merge`.

Suggested order (simplest ratifier first, then increasing delta):

- **A1 introduce-driver + cursor**: cursor is the minimal member (no worktree lifecycle),
  so it ratifies the no-lifecycle degradation the same way sync T5e did. Ship the driver
  with cursor in one PR.
- **A2 grok**: the fullest lifecycle shape (two-phase resolve, native-session meta).
- **A3 gemini**: the no-mint / unconditional-lookup / NO-D4-split outlier.
- **A4 devin**: no `applyEffectiveWorkingDirectory`, no inner resolve-catch, remote-tracked,
  outputFormat undefined.
- **A5 mistral**: the `mistralEnv` + vibe-token case.

## 7. Open questions - RESOLVED (cross-LLM review r1, Codex + Grok both unconditional)

- OQ1 (new driver vs thin helper): **new `runAsyncEnqueueEnvelope`** - the dual latch +
  settle + usage + log + error-id is exactly the call-site uniformity Tier-B paid for; a
  free-floating helper would re-scatter it.
- OQ2 (`env.startTime`): **dropped** - no async duration metric or "completed in Xs" log.
- OQ3 (fold codex async now): **defer BOTH Kit async handlers** - composed requestCleanup
  as onComplete, the attempt-lease wrapper, kit-tail startJob args 15-18, `kitJobHandedOff`
  / discard, and prepCleanup ownership make it a genuinely different envelope.
- OQ4 (success fields): **ride in `TValue`** (the `runInsideTry` result) or handler locals
  closed over by `buildSuccessResponse`; never widen the driver with provider JSON shape.

Non-blocking naming fix folded in: the enqueue/return type is `AsyncJobSnapshot`
(async-job-manager.ts), not a placeholder.

### Original open questions (for the record)

- OQ1: is a NEW `runAsyncEnqueueEnvelope` the right call, or should the driver be a thin
  shared helper (a la `settleWorktreeOnTerminal`) plus the ledger, given the async body is
  small? (I favour a driver for call-site uniformity + a single tested skeleton, matching
  the sync arc.)
- OQ2: should `env.startTime` exist at all, given there is no metric? (Likely drop it.)
- OQ3: is deferring BOTH Kit async handlers correct, or should codex async (already
  standalone) be folded now with a `kit`-aware `enqueue` + a catch `discardPending
  PersonalKitSession`? (Design recommends deferring; the Kit `startJob` tail + lease
  wrapper + kit-aware errors are a materially different envelope.)
- OQ4: the `enqueue` hook returns only the job; `buildSuccessResponse` needs
  `effectiveSessionId`/`worktreeResolution`/`approvalDecision`/`requestedMcpServers` -
  confirm these ride in `TValue` (the `runInsideTry` result) cleanly rather than widening
  the driver.
