# Tier-B T5a (gemini terminal-envelope routing): verification notes

Base commit: `18f06e3` (master, post T4/PR #218). Branch:
`feature/prep-pipeline-tier-b-t5a`. Anchors are `src/index.ts` unless noted.

Source-of-truth:
- Design: `docs/plans/request-pipeline-tier-b-t5-generalize.design.md` (rev 2)
- DAG: `docs/plans/request-pipeline-tier-b-t5a-gemini.dag.toml`

## T5 design review (shared contract for all five slices)

3/3 UNCONDITIONAL cross-LLM approval of the rev-2 design (each fresh session,
verified against the five real handlers + the T4 driver at 18f06e3):

- Round 1 (rev 1): Mistral UNCONDITIONAL; Codex + Grok each named the SAME concrete
  blocker: the shipped `runKitTerminalEnvelope` couples the usage-update session id
  and the deferred-response session id on one `effectiveSessionId`, but
  grok/devin/cursor/mistral split them (`userProvidedSession ? effectiveSessionId :
  undefined` for usage vs full minted id for the deferred response). Gemini
  coincides, so T5a is unexposed, but the shared contract was wrong for T5b..T5e.
- Rev 2 fix: added `usageUpdateSessionId` envelope field (D4), inert for
  claude/codex/gemini; plus documented `env.optimizationApplied = false` for the
  five and the devin/cursor terminal-log delta (D5).
- Round 2 (rev 2): Codex (corrId t5-design-codex-r2), Grok (t5-design-grok-r2),
  Mistral (t5-design-mistral-r2) all UNCONDITIONAL. D4 confirmed byte-inert for
  claude/codex (neither gates usage on userProvidedSession); optimizationApplied
  false confirmed at gemini 11497/11597, grok 12247/12336, devin 13016/13092,
  cursor 13751/13823, mistral 14415/14499; D5 devin/cursor log-absence confirmed;
  all non-blockers re-verified against code.

## T5a implementation

- add-usage-update-session-id (D4): added `usageUpdateSessionId` to
  KitTerminalEnvelope; driver reads it at both usage-update sites (deferred +
  success), keeps `effectiveSessionId` for buildDeferredToolResponse; claude/codex
  env blocks set `usageUpdateSessionId: effectiveSessionId`. Byte-inert:
  claude/codex terminal + handler nets green (84 tests). build clean.
- wire-gemini-handler: handleGeminiRequest builds env (kit=null, all managers =
  deps.sessionManager, fire=false, effectiveSessionId = usageUpdateSessionId =
  effectiveSessionIdHint, optimizationApplied = false, outputFormat =
  params.outputFormat) + hooks and returns runKitTerminalEnvelope(env, hooks).
  States 4..8 inside runInsideTerminalTry (claude topology); the inline
  worktree-resolve #1 catch returns ok:false earlyResponse id "gemini_request";
  computeSuccessFacts extracts { geminiUsage, cost, geminiMeta }; finalizeKit is a
  no-op; buildSuccessResponse owns the success flight.completeInline. The moved
  userProvidedSession/effectiveSessionIdHint computations are pure (cannot throw),
  so hoisting them before the env is behaviour-neutral. build clean; gemini nets
  (gemini-handler, gemini-argv-golden, gemini-async-handler) green (54) +
  unmodified. lint 0 errors, format:check pass.
- gemini-terminal-net: new src/__tests__/gemini-handler-terminal-net.test.ts (7
  tests): inline success/failure/exception (metric once + right wasSuccessful,
  arm never), worktree-resolve ok:false seam (id "gemini_request", catch not
  taken, one metric), argv/assert throw (id "gemini"), deferred Mode-B fence (arm
  + no inline complete), and the H-DoubleComplete fence flip (deferred + rejecting
  finishHandler => NO second logComplete; reachable for gemini because a fresh
  request keeps effectiveSessionIdHint undefined => no admission => the deferred
  settle calls finishHandler). All 7 green.
- verification-gate: `npm run check` green through build + lint + format:check +
  provider-surfaces + site + full test (237 files / 3734 tests, +7 net); security:audit stops only at the
  never-committed shrinkwrap (identical to master); generating it and re-running
  `npm run security:audit` => "Release security audit passed" (supply-chain exit
  0). typos PASS on all T5 changed files. No em dash added by the diff (removed
  one from the replaced gemini region; the 87 remaining in src/index.ts are
  pre-existing). No new node:sqlite/fetch.
- cross-llm-review-gate: 3/3 UNCONDITIONAL (fresh sessions, verified vs 18f06e3).
  Codex gpt-5.5 (t5a-impl-codex-r1): "Findings: none"; ran build/lint/format/typos
  + full test (237 files / 3734) himself. Grok grok-4.5 (t5a-impl-grok-r1): line-
  level ledger-mapping table + fence verified; two NON-blocking notes (fail/
  exception info logs go via runtime.logger not deps.logger, but the registered
  tool path destructures logger from runtime so identity matches; the pure-extractor
  reorder matches the shipped codex driver contract). Mistral mistral-medium-3.5
  (t5a-impl-mistral-r1): line-cited verification of Part A + Part B + the fence.
  D1/D2 (inertness + H-DoubleComplete fence) ratified against inspected code.
