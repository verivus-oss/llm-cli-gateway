# Tier-B T5d (mistral terminal-envelope routing): verification notes

Base commit: `046378e` (master, post T5c/PR #221). Branch:
`feature/prep-pipeline-tier-b-t5d`. Design (3/3-approved rev 2):
`docs/plans/request-pipeline-tier-b-t5-generalize.design.md`. Fourth of five T5
slices; the hardest (the model-selection retry loop).

## Implementation

- wire-mistral-handler: handleMistralRequest builds env + hooks and returns
  runKitTerminalEnvelope(env, hooks). ACP branch + rejectUnreachableGatewayWorktree
  stay OUTSIDE. env: kit=null, all managers = deps.sessionManager, logger =
  deps.logger, fire=false, optimizationApplied=false, outputFormat=params.outputFormat,
  usageUpdateSessionId = userProvidedSession ? effectiveSessionId : undefined (D4
  split). mistral has claude's in-try topology WITH the inline worktree-resolve
  ok:false seam (id "mistral_request"), applyEffectiveWorkingDirectory
  ("--workdir"/"--add-dir"), the invoked log (resolveMistralAgentMode), and the
  success worktree-prefix. env.logger = deps.logger and mistral already logs all
  three terminal lines, so there is NO D5 delta. The effectiveSessionId mint is
  hoisted before env (pure); pre-mint sessionResult.effectiveSessionId feeds the
  existing-session lookup + worktree-resolve #1. computeSuccessFacts/finalizeKit are
  no-ops.
- RETRY LOOP (the load-bearing mistral divergence) folds entirely into the execute
  hook: first awaitJobOrDefer; if deferred, return it (driver's deferred branch
  handles settle + usage-split + the fence); if code!=0 && stale-model failure &&
  a recovery model exists, rearm the worktree lifecycle and dispatch once more with
  the recovery prep (forceRefresh=true, retryPrep.env, reused FR handoff so the
  original flight row is updated); if the retry defers, return it; else mutate
  prep.resolvedModel/prep.args and return the inline result. Both deferred sites now
  route through the driver's single deferred branch; flight.start() runs once.
- build clean; existing mistral nets (mistral-handler, mistral-argv-golden,
  mistral-meta-json-parser) green (49) + unmodified; the retry-invariant nets
  (test-veracity-regressions, test-veracity-regressions-slice-zeta,
  post-session-argv-admission) green; lint 0 errors; format/typos PASS; no em dash /
  node:sqlite / fetch added.
- mistral-terminal-net: new src/__tests__/mistral-handler-terminal-net.test.ts (9
  tests): inline success/failure/exception, the worktree-resolve ok:false seam, an
  argv throw, the model-selection RETRY in two directions (first dispatch stale-model
  => rearm + retry SUCCEEDS: executeCli called twice, one flight completion, one
  success metric; and first dispatch stale-model => rearm + retry FAILS non-stale:
  executeCli called twice, one flight completion, one failure metric), the deferred
  Mode-B fence, and BOTH D4-split directions. mistral's H-DoubleComplete is documented
  UNREACHABLE (defensive, like grok/devin/codex).
- Documented untestable combination: the retry-then-DEFER route (first dispatch
  completes inline with a stale-model failure, the hook rearms, the SECOND dispatch
  defers) is the one path into the driver's deferred branch from a rearmed worktree
  lifecycle, but it is unreachable in either net harness by construction (the inline
  harness forces the sync-inline executeCli-mock branch and cannot defer; the async
  harness forces the async-manager branch, which runs the REAL executor for its jobs,
  so a controlled stale-model failure cannot be injected on the first dispatch; the
  branch decision is constant across both dispatches of one invocation). Both
  CONSTITUENTS are pinned independently (the driver deferred branch by the deferred +
  D4-split tests; the retry rearm + second dispatch by the two retry tests), and the
  fold routing both deferred sites through the driver's single deferred branch is
  verified byte-for-byte by the cross-LLM review. A precise NOTE records this in the
  net beside the H-DoubleComplete note. (The ultracode verification workflow surfaced
  the gap as MINOR; the retry-then-fail test closes the reachable half of it.)

## Cross-LLM review (3/3 UNCONDITIONAL, inspected-evidence)

Adversarial byte-preservation review vs base `046378e`, prompt
`scratchpad/t5d-impl-review.md`, each reviewer a fresh session with the repo path and
the base-snapshot reference:

- Codex (gpt-5.5, danger-full-access, read-only intent): "No blocker found.
  UNCONDITIONAL APPROVAL" (verified the retry fold, the single-deferred-branch
  routing, flight.start once, the D4 split, and byte-preservation outside the fence).
- Grok (grok-4.5, effort high): verified the retry block byte-identical incl.
  `rearm()` placement, the reused FR handoff, and prep mutation only on inline retry;
  approving.
- Mistral (mistral-medium-3.5): "UNCONDITIONAL APPROVAL" with a line-referenced
  checklist (first dispatch + deferred returns, retry block, flight.start once, both
  deferred sites through the driver branch, D4 split, test suite green).

The two later test-only additions (retry-then-fail + the documented note) do not touch
production code, so the code approvals stand unchanged.

## ultracode multi-lens verification

Before the external gate, a Workflow ran five parallel adversarial lenses
(byte-choreography, wiring, fence, retry-loop, tests) plus a synthesis critic over the
staged change. All four code lenses were CLEAN; the tests lens surfaced two
test-completeness gaps (retry-then-fail, retry-then-defer) as MINOR (byte-correct
production code, untested combinations only). retry-then-fail is now covered; the
retry-then-defer combination is documented as harness-unreachable above.
