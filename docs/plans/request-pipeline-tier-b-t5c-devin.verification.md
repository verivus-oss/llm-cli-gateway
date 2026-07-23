# Tier-B T5c (devin terminal-envelope routing): verification notes

Base commit: `90d3690` (master, post T5b/PR #220). Branch:
`feature/prep-pipeline-tier-b-t5c`. Design (3/3-approved rev 2):
`docs/plans/request-pipeline-tier-b-t5-generalize.design.md`. Third of five T5
slices.

## Implementation

- wire-devin-handler: handleDevinRequest builds env + hooks and returns
  runKitTerminalEnvelope(env, hooks). ACP branch + rejectUnreachableGatewayWorktree
  stay OUTSIDE. env: kit=null, all managers = deps.sessionManager,
  logger = deps.logger, fire=false, optimizationApplied=false, outputFormat=undefined,
  effectiveSessionId = post-mint value, usageUpdateSessionId = userProvidedSession ?
  effectiveSessionId : undefined (D4 split). devin diverges from gemini/grok: NO
  inline worktree-resolve catch (a resolve throw reaches the envelope catch, id
  "devin", not an ok:false seam), NO applyEffectiveWorkingDirectory, NO invoked log;
  decorateDeferred attaches approval + reviewIntegrity; computeSuccessFacts and
  finalizeKit are no-ops (devin extracts no provider meta); buildSuccessResponse has
  NO worktree-prefix. The effectiveSessionId mint is hoisted before env (pure);
  pre-mint sessionResult.effectiveSessionId still feeds existingSession + worktree
  resolve #1. build clean; existing devin nets (devin-handler, devin-argv-golden,
  devin-managed-approval) green (29) + unmodified; lint 0 errors; format PASS; typos
  PASS; no em dash / node:sqlite / fetch added.
- D5 (ratified here): devin logged NONE of the three terminal lines
  (failed/completed/threw) at base; the driver emits all three via
  env.logger=deps.logger, so devin gains exactly those three stderr lines. This is
  the intended, documented, non-functional observability delta (design D5), asserted
  by the terminal net.
- devin-terminal-net: new src/__tests__/devin-handler-terminal-net.test.ts (7 tests):
  inline success/failure/exception (metric + flight completion + the D5 terminal-log
  assertions), worktree-resolve failure reaching the envelope catch (id "devin", not
  a seam), argv throw (id "devin"), deferred Mode-B fence with the approval
  decoration, and the D4 split (minted session => deferred id present but
  updateSessionUsage NOT called). devin's H-DoubleComplete is documented UNREACHABLE
  (defensive, like grok/codex).

## Ultracode adversarial verification workflow (pre-external-gate)

Before the external gate, a 4-lens verification workflow (byte-choreography /
wiring / fence-d5 / tests) + a completeness-critic synthesis ran over the devin
slice. Three lenses (byte-choreography, wiring, fence-d5) returned CLEAN; the
production wiring was independently verified byte-correct vs the base. The tests
lens (confirmed by the synthesis) found a real characterization gap: the net pinned
only the MINTED direction of the D4 split (usage NOT called) and never the
USER-PROVIDED direction (usage DID fire), leaving the requireTrackedRemoteSession
admission arm and the usage-fires wiring uncovered, contrary to the design's own
test plan (section 6, "a deferral on a USER-provided session asserts the usage
update did fire"). FIX: added the "D4 split (user-provided)" test (a provided
sessionId => userProvidedSession true => updateSessionUsage fires for that id, and
the deferred response returns the provided id, not a gw-* mint), and tightened the
exception test with a single-flight-completion assertion. devin-terminal-net is now
8 tests, all green. Production code unchanged (test-only strengthening).

## Cross-llm-review-gate

3/3 UNCONDITIONAL (fresh sessions, verified vs 90d3690). Codex gpt-5.5
(t5c-impl-codex-r1): "Findings: none"; ran targeted Vitest + build/lint/format
himself. Grok grok-4.5 (t5c-impl-grok-r1): programmatic strip-and-compare confirmed
everything outside handleDevinRequest is byte-identical; verified the wiring table +
the two intended deltas (fence + D5). Mistral mistral-medium-3.5 (t5c-impl-mistral-r1):
full field-by-field verification table, all pass. The internal verification workflow
had additionally caught a test-completeness gap (user-provided-session usage-fires
direction), fixed before merge; the external reviewers confirmed the production
wiring byte-correct.
