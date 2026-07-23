# Tier-B T5b (grok terminal-envelope routing): verification notes

Base commit: `9bf5fcb` (master, post T5a/PR #219). Branch:
`feature/prep-pipeline-tier-b-t5b`. Design (shared, 3/3-approved rev 2):
`docs/plans/request-pipeline-tier-b-t5-generalize.design.md`. Second of five T5
slices; the driver + usageUpdateSessionId field already exist on master (T5a).

## Implementation

- wire-grok-handler: handleGrokRequest builds env (kit=null, all managers =
  deps.sessionManager, fire=false, optimizationApplied=false, outputFormat =
  params.outputFormat) + hooks and returns runKitTerminalEnvelope(env, hooks). The
  ACP transport branch and rejectUnreachableGatewayWorktree guard stay OUTSIDE the
  envelope, unchanged. grok is the FIRST slice to use the D4 split:
  env.effectiveSessionId = effectiveSessionId (deferred response);
  env.usageUpdateSessionId = `sessionResult.userProvidedSession ? effectiveSessionId
  : undefined` (a gateway-minted session gets no durable usage update). The
  effectiveSessionId mint (`if (!createNewSession && !effectiveSessionId) gw-mint`)
  is hoisted before the env; it is pure and non-throwing, and worktree-resolve #1 +
  existingSession still use the PRE-mint `sessionResult.effectiveSessionId`.
  computeSuccessFacts returns only { grokMeta } (grok does not extract usage/cost;
  the FR handoff owns token accounting); finalizeKit is a no-op; buildSuccessResponse
  owns the success flight.completeInline. build clean; existing grok nets
  (grok-handler, grok-argv-golden, grok-streaming-normalization, grok-sync-content,
  grok-sync-content-wire, grok-schema-golden) green (34) + unmodified; lint 0
  errors, format:check pass.
- grok-terminal-net: new src/__tests__/grok-handler-terminal-net.test.ts (7 tests):
  inline success/failure/exception, worktree-resolve ok:false seam (via an
  unregistered workspace; id "grok_request", catch not taken, one metric; a
  worktree:true request would instead fail closed at rejectUnreachableGatewayWorktree
  BEFORE the envelope), argv/assert throw (id "grok"), deferred Mode-B fence (arm +
  no inline complete), and the D4 SPLIT pin (a fresh non-createNewSession request
  mints + admits a gw-* session, so the deferral returns the minted id but
  updateSessionUsage is NOT called). grok's H-DoubleComplete is documented
  UNREACHABLE (defensive/symmetric like codex T3): a worktree request without a
  provider-native sessionId fails closed, and a request with a tracked-remote
  sessionId admits a session so the deferred settle always transfer()s.
- verification-gate: `npm run check` green through build + lint + format:check +
  provider-surfaces + upstream-contracts + site + full test (3741 tests, +7 net);
  security:audit stops only at the never-committed shrinkwrap (generating it and
  re-running `npm run security:audit` => "Release security audit passed"). typos
  PASS. No em dash / node:sqlite / fetch added by the diff.

## Cross-llm-review-gate

Round 1: Grok UNCONDITIONAL; Mistral (pending); Codex named ONE blocker (valid):
the shared driver logged the three terminal lines via runtime.logger, but base
grok logs them via deps.logger (an observable drift for a direct-handler caller
with a mismatched deps.logger). NOTE on gemini: at this base (9bf5fcb, post-T5a)
gemini's terminal logs were ALREADY on runtime.logger, having drifted there in the
merged T5a from its pre-T5a deps.logger sink; the same fix therefore restores
gemini too. Grok listed the same as a non-blocker; treated as a real
byte-preservation gap and fixed rather than rebutted.

Round-2 fix: added a per-context `logger: HandlerDeps["logger"]` field to
KitTerminalEnvelope; the driver now does `const logger = env.logger`; each handler
wires its original sink (claude/codex = runtime.logger, INERT; gemini = deps.logger,
RESTORES the pre-T5a sink and tightens the already-merged T5a; grok = deps.logger,
PRESERVES). Driver uses `logger` only for the three terminal logs. build clean; all
four handler + terminal nets green (141 tests); lint 0 errors; format PASS.

Round-2 verdicts: Grok grok-4.5 (t5b-impl-grok-r2) UNCONDITIONAL (verified the
env.logger fix + every T5b claim "Hold"). Codex gpt-5.5 approved the code fix but
named a precise DOC blocker (a false base-sink claim for gemini at 9bf5fcb); the
doc was corrected and Codex gpt-5.5 (t5b-impl-codex-r3) then gave UNCONDITIONAL
APPROVAL ("Findings: none"; confirmed grok=deps.logger inline, gemini already on
runtime.logger at 9bf5fcb having drifted from pre-T5a deps.logger which env.logger
restores). Mistral r2 (t5b-impl-mistral-r2) stalled (Vibe flake, killed at 600s); re-dispatched fresh as t5b-impl-mistral-r2b => UNCONDITIONAL APPROVAL. Result: 3/3 UNCONDITIONAL (Codex+Grok+Mistral).
