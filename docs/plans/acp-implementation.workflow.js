export const meta = {
  name: 'acp-gateway-implementation',
  description: 'Implement the first-class ACP gateway extension DAG with a multi-LLM review gate per phase',
  whenToUse: 'Run to implement docs/plans/first-class-acp-gateway-extension.dag.toml end to end, autonomously, with an adversarial cross-LLM review gate after every phase. Stops at release-ready (PR + green CI, ACP off by default); never publishes.',
  phases: [
    { title: 'Phase A — Contract & capability', detail: 'freeze contract, config schema, capability metadata, upstream contracts, registry+errors (no runtime)' },
    { title: 'Phase B — Transport core', detail: 'json-rpc stdio, protocol types, client core, process manager' },
    { title: 'Phase C — Smoke + HostServices', detail: 'read-only smoke harness, deny-by-default HostServices boundary' },
    { title: 'Phase D — Permissions/sessions/redaction', detail: 'permission bridge, session map, event normalizer, flight-recorder redaction' },
    { title: 'Phase E — Mistral pilot', detail: 'gated mistral_request ACP runtime' },
    { title: 'Phase F — Grok pilot', detail: 'gated grok_request ACP runtime, isolated leader socket' },
    { title: 'Phase G — Async/resources/docs', detail: 'async jobs, resources+doctor, agent-facing docs' },
    { title: 'Phase H — Validation & release', detail: 'full-panel validation + release-readiness (no publish)' },
  ],
}

// ---------------------------------------------------------------------------
// Authoritative spec lives in the DAG file. Implementer/verifier agents read
// their own [[steps]] block from it by id, so this script stays lean and the
// DAG stays the single source of truth. We never inline step bodies here.
// ---------------------------------------------------------------------------
const DAG = 'docs/plans/first-class-acp-gateway-extension.dag.toml'
const STATE_DIR = 'docs/acp/state'
const VERIFY_DIR = 'docs/acp/verification'
const REVIEW_DIR = 'docs/acp/review'
const MAX_REVIEW_ROUNDS = 6
// Phase A is merged to master; resume from B by default. Override via args.startPhase.
const START_PHASE = (typeof args === 'object' && args && args.startPhase) || 'B'

// Phase -> ordered step ids (linear DAG; we honor depends_on order).
const PHASES = [
  { key: 'A', title: 'Phase A — Contract & capability', fastPath: true, mutationProbe: false,
    lenses: ['codex', 'grok'],
    steps: ['freeze-contract-and-non-goals', 'add-acp-config-schema', 'extend-provider-capability-metadata', 'track-acp-upstream-contracts', 'define-acp-provider-registry-and-errors'] },
  { key: 'B', title: 'Phase B — Transport core', fastPath: false, mutationProbe: true,
    lenses: ['codex', 'grok'],
    steps: ['build-json-rpc-stdio-transport', 'define-acp-protocol-types', 'implement-acp-client-core', 'add-acp-process-manager'] },
  { key: 'C', title: 'Phase C — Smoke + HostServices', fastPath: false, mutationProbe: true,
    lenses: ['codex', 'grok', 'claude'],
    steps: ['add-read-only-smoke-harness', 'define-host-services-boundary'] },
  { key: 'D', title: 'Phase D — Permissions/sessions/redaction', fastPath: false, mutationProbe: true,
    lenses: ['codex', 'grok', 'claude'],
    steps: ['implement-permission-bridge', 'implement-session-map', 'normalize-session-updates', 'define-acp-flight-recorder-redaction'] },
  { key: 'E', title: 'Phase E — Mistral pilot', fastPath: false, mutationProbe: true,
    lenses: ['codex', 'grok', 'mistral', 'claude'],
    steps: ['pilot-mistral-acp-runtime'] },
  { key: 'F', title: 'Phase F — Grok pilot', fastPath: false, mutationProbe: true,
    lenses: ['codex', 'grok', 'claude'],
    steps: ['pilot-grok-acp-runtime'] },
  { key: 'G', title: 'Phase G — Async/resources/docs', fastPath: false, mutationProbe: true,
    lenses: ['codex', 'grok', 'gemini', 'mistral'],
    steps: ['integrate-async-jobs', 'integrate-resources-and-doctor', 'add-agent-facing-docs'] },
  { key: 'H', title: 'Phase H — Validation & release', fastPath: false, mutationProbe: false,
    lenses: ['codex', 'grok', 'gemini', 'mistral', 'claude'],
    steps: ['validate-with-multi-llm-review', 'release-gate-and-publish-readiness'] },
]

// Reviewer lens -> gateway async request tool. Codex + Claude are read-only:
// per the standing claude_request write-access hazard, the same-repo Claude
// reviewer must never get write/commit/release authority (session bleed).
const REVIEWER_TOOL = {
  codex: 'mcp__gtwy__codex_request_async',
  gemini: 'mcp__gtwy__gemini_request_async',
  grok: 'mcp__gtwy__grok_request_async',
  mistral: 'mcp__gtwy__mistral_request_async',
  claude: 'mcp__gtwy__claude_request_async',
}
const NO_WRITE_REVIEWERS = new Set(['codex', 'claude'])

// ---------------------------------------------------------------------------
// Structured-output schemas (force agents to return validated data, not prose)
// ---------------------------------------------------------------------------
const IMPLEMENT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['stepId', 'filesChanged', 'testsAdded', 'buildPassed', 'testPassed', 'commit', 'digest'],
  properties: {
    stepId: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    testsAdded: { type: 'array', items: { type: 'string' } },
    buildPassed: { type: 'boolean' },
    testPassed: { type: 'boolean' },
    commit: { type: 'string', description: 'commit SHA on the feature branch, or empty if not committed' },
    digest: { type: 'string', description: 'one-paragraph summary of what changed and gate output' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['stepId', 'validationPassed', 'reportPath', 'claims', 'vacuousTests', 'failures'],
  properties: {
    stepId: { type: 'string' },
    validationPassed: { type: 'boolean' },
    reportPath: { type: 'string' },
    claims: { type: 'array', items: { type: 'object', additionalProperties: true } },
    vacuousTests: { type: 'array', items: { type: 'string' }, description: 'tests that stayed green under mutation (must be empty to pass)' },
    failures: { type: 'array', items: { type: 'string' } },
  },
}
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['reviewer', 'verdict', 'findings', 'inspected'],
  properties: {
    reviewer: { type: 'string' },
    verdict: { type: 'string', enum: ['APPROVED', 'CHANGES_REQUIRED', 'BLOCKER'] },
    findings: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['file', 'line', 'claim', 'evidence', 'severity', 'scope'],
      properties: {
        file: { type: 'string' }, line: { type: 'string' },
        claim: { type: 'string' }, evidence: { type: 'string' },
        severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
        scope: { type: 'string', enum: ['current_phase', 'downstream_invariant'], description: 'current_phase blocks this phase; downstream_invariant records a required later DAG invariant without blocking unless the current phase exposes an unsafe bypass' },
      } } },
    inspected: { type: 'array', items: { type: 'string' }, description: 'files/tests/commands the reviewer actually opened or ran' },
  },
}
const FIX_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['commit', 'addressed', 'rebuttals', 'unresolved'],
  properties: {
    commit: { type: 'string' },
    addressed: { type: 'array', items: { type: 'string' } },
    rebuttals: { type: 'array', items: {
      type: 'object', additionalProperties: false,
      required: ['finding', 'evidence'],
      properties: { finding: { type: 'string' }, evidence: { type: 'string', description: 'file:line / test / doc citation refuting the finding' } } } },
    unresolved: { type: 'array', items: { type: 'string' }, description: 'concrete blockers that survived evidence-based rebuttal' },
  },
}

// ---------------------------------------------------------------------------
// Agent prompt builders
// ---------------------------------------------------------------------------
function implementPrompt(stepId, phase) {
  return [
    `You are the implementer for ONE step of the ACP gateway extension.`,
    `Read the verbatim [[steps]] block with id="${stepId}" from ${DAG} and implement exactly it.`,
    `Also read the [security_invariants], [architecture], and [config] sections for binding constraints.`,
    ``,
    `Hard rules:`,
    `- TypeScript strict; explicit return types on exported functions; Zod at boundaries.`,
    `- NEVER console.log / write to stdout from gateway code (stdout = MCP only). Use the logger (stderr).`,
    `- No shell eval for provider entrypoints; argv arrays only.`,
    `- default_transport stays "cli"; do not change existing CLI behavior or request-tool schemas in a breaking way.`,
    `- Honor every applicable [security_invariants] entry.`,
    `- Add tests that satisfy this step's validation clause and the relevant [test_matrix] rows. Tests must be non-vacuous.`,
    phase.fastPath ? `- You may be running concurrently with sibling foundation steps; touch only files this step owns, avoid cross-step edits.` : ``,
    ``,
    `Then: run \`npm run build\` and the relevant \`npm test\` suites. Commit on the CURRENT feature branch (already checked out) with a precise message (no Co-Authored-By trailer).`,
    `CRITICAL: never create, switch to, rebase, or merge another branch, and never create a separate "integration" branch — commit directly on the checked-out feature branch so the code is never stranded. Do not run git worktree/checkout/branch/switch.`,
    `Return the structured result. Keep prose out of the response — the schema IS the response.`,
  ].filter(Boolean).join('\n')
}

function verifyPrompt(stepId, phase) {
  return [
    `You are the independent verifier for step id="${stepId}".`,
    `Do NOT trust the implementer. Read the [[steps]] block "${stepId}" from ${DAG}, run its validation clause and the relevant [test_matrix] rows yourself.`,
    `Write a verification report (the corrective-program spec) to ${VERIFY_DIR}/${stepId}.md: for every behavioral claim, cite the exact file:line, the exact test name proving it, and the command-output digest. Claims without code/test citations are not allowed.`,
    phase.mutationProbe
      ? `Mutation-probe audit (test-veracity): in a throwaway git worktree, mutate each key code path the new tests claim to cover (e.g. make HostServices allow writes by default; let a raw JSON-RPC body reach the flight recorder; drop a fail-closed branch) and confirm the corresponding test FAILS. Any test that stays green under its mutation is vacuous — list it in vacuousTests. Discard the worktree afterward. Record probe results in the report.`
      : `No mutation probe required for this phase; still confirm tests are real by reading them.`,
    `Return the structured result. validationPassed must be false if any validation row fails OR vacuousTests is non-empty.`,
  ].join('\n')
}

function reviewPrompt(reviewer, phase, packet, round) {
  const tool = REVIEWER_TOOL[reviewer]
  const noWrite = NO_WRITE_REVIEWERS.has(reviewer)
  return [
    `You are a review-driver. Obtain an ADVERSARIAL release review from the ${reviewer} model by calling the MCP tool ${tool}.`,
    `Call it with the most permissive NON-INTERACTIVE settings so the reviewer can independently inspect and run things:`,
    `  alwaysApprove=true, a non-interactive permissionMode, broad allowedTools, and pass mcpServers so the reviewer can reach gtwy/sqry/ref tools.`,
    noWrite
      ? `  IMPORTANT: grant READ + verify + MCP access ONLY. Do NOT grant repo write/commit/release to this reviewer (${reviewer} is read-only by policy).`
      : `  Grant full read + verify + MCP access (no need to write to the repo to review).`,
    `Working directory = repo root.`,
    ``,
    `Pass this reviewer prompt verbatim:`,
    `"""`,
    `You are an adversarial release reviewer for the llm-cli-gateway ACP extension (${phase.title}, lens: ${reviewer}).`,
    `Inputs: (1) verification report at ${packet.reportPath}; (2) change set: commits ${packet.commits}, diff range ${packet.diffRange}, changed files: ${packet.changedFiles}.`,
    `The verification report is a CLAIM, not evidence. Do NOT approve based on it. Open each cited file yourself, read the real code and docs, and run the cited tests plus \`npm run build\` / \`npm test\` / \`npm run upstream:contracts\` yourself.`,
    `Classify every finding by DAG scope before deciding the verdict:`,
    `- scope=current_phase: the issue is in a file/behavior owned by this phase's steps, or the phase exposes an unsafe bypass of a downstream invariant. These findings may justify CHANGES_REQUIRED or BLOCKER.`,
    `- scope=downstream_invariant: the concern is a real final-state invariant, but the DAG assigns its implementation/tests to a later step that is not in this phase. Record it with evidence, but do not block this phase on that basis alone.`,
    `Return APPROVED only if ALL current_phase obligations hold, each backed by something you personally inspected or executed: every report claim verified against actual code/tests/docs; this phase's DAG validation clauses and applicable [test_matrix] rows satisfied by real non-vacuous tests; existing CLI transport path unchanged; [security_invariants] entries applicable to this phase hold (no raw ACP JSON-RPC / prompt text / file contents / credential paths reaching logs, flight recorder, doctor, or resources; no shell eval for entrypoints; deny-by-default HostServices where this phase owns HostServices; ApprovalManager-mediated permissions where this phase owns the permission bridge); no console.log/stdout writes from gateway code.`,
    `Do NOT approve on intent, plan-compliance, "looks correct", or "should be fixed later". For anything wrong in current_phase scope return CHANGES_REQUIRED with file:line + what is wrong + inspected evidence. For an unfixable current_phase defect return BLOCKER with evidence. Include downstream_invariant findings separately without using them as the verdict basis.`,
    `"""`,
    ``,
    `Reviewer permission grants are not durable, so the call will defer to an async job. Poll mcp__gtwy__llm_job_status NO MORE OFTEN than once every 90 seconds; pull mcp__gtwy__llm_job_result only when done.`,
    `Then persist the round to disk: create ${REVIEW_DIR} if needed and write the reviewer's verbatim reply plus your structured verdict (verdict + findings + inspected list) to ${REVIEW_DIR}/${phase.key}-round-${round}-${reviewer}.md. You (the driver) may write this file even though the ${reviewer} reviewer itself is read-only.`,
    `Translate the reviewer's reply into the structured schema and RETURN it (the schema IS your response). reviewer="${reviewer}".`,
  ].join('\n')
}

function fixPrompt(phase, findings, packet) {
  return [
    `You are the fix+rebuttal driver for ${phase.title}.`,
    `Reviewer findings (JSON): ${JSON.stringify(findings)}`,
    `Change set under review: commits ${packet.commits}, diff range ${packet.diffRange}.`,
    `For each finding:`,
    `- If it is correct: fix it in code/tests, re-run \`npm run build\` + relevant \`npm test\` + \`npm run upstream:contracts\`, and commit ON THE CURRENT feature branch (never a side/integration branch). Add the test name to addressed[].`,
    `- If you believe it is wrong: rebut ONLY with a concrete file:line / test / doc citation that refutes it (never assertion, intent, or "by design"). Add to rebuttals[].`,
    `- If a finding is a real defect that cannot be resolved within this slice's scope: add it to unresolved[] with inspected evidence.`,
    `Regenerate the affected portions of the verification report at ${packet.reportPath}. Return the new head commit SHA.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Retry wrapper for schema'd agents. A structured agent occasionally finishes
// WITHOUT emitting StructuredOutput (transient), returning null. In a review
// round a null verdict poisons the round and can exhaust MAX_REVIEW_ROUNDS for
// no real reason (the Phase A round-6 flake: both reviewer drivers returned
// null and the gate falsely "failed"). Retry a few times before accepting null.
// ---------------------------------------------------------------------------
async function agentRetry(prompt, opts, tries = 3) {
  let last = null
  for (let i = 1; i <= tries; i++) {
    last = await agent(prompt, opts)
    if (last) return last
    log(`${opts.label || 'agent'}: null result (StructuredOutput miss) — retry ${i}/${tries - 1}`)
  }
  return last
}

// ---------------------------------------------------------------------------
// Per-step: implement -> verify (pipeline, no barrier between steps within a
// phase beyond the linear data dependency we enforce by awaiting in order).
// ---------------------------------------------------------------------------
async function runStep(stepId, phase) {
  const impl = await agentRetry(implementPrompt(stepId, phase), {
    label: `impl:${stepId}`, phase: phase.title, schema: IMPLEMENT_SCHEMA,
    isolation: phase.fastPath ? 'worktree' : undefined,
  })
  if (!impl || !impl.buildPassed || !impl.testPassed) {
    // one repair attempt inline before giving the step to verification
    const repair = await agentRetry(
      `${implementPrompt(stepId, phase)}\n\nThe previous attempt failed local gates: ${impl ? impl.digest : 'agent returned null'}. Fix and re-run gates.`,
      { label: `impl-repair:${stepId}`, phase: phase.title, schema: IMPLEMENT_SCHEMA })
    if (repair) Object.assign(impl ?? {}, repair)
  }
  const ver = await agentRetry(verifyPrompt(stepId, phase), {
    label: `verify:${stepId}`, phase: phase.title, schema: VERIFY_SCHEMA,
  })
  return { stepId, impl, ver }
}

// ---------------------------------------------------------------------------
// Review Gate: parallel reviewer barrier, iterate to unconditional approval.
// ---------------------------------------------------------------------------
async function reviewGate(phase, packet) {
  let round = 1
  let currentPacket = packet
  while (round <= MAX_REVIEW_ROUNDS) {
    log(`${phase.title}: review round ${round} — fanning out ${phase.lenses.join(', ')}`)
    const reviews = (await parallel(phase.lenses.map((lens) => () =>
      agentRetry(reviewPrompt(lens, phase, currentPacket, round), {
        label: `review:${phase.key}:${lens}:r${round}`, phase: phase.title, schema: REVIEW_SCHEMA,
      })
    ))).filter(Boolean)

    // A reviewer that stays null after retries cannot be counted as approval;
    // log it so an exhausted gate is attributable to a flaky lens, not silence.
    if (reviews.length < phase.lenses.length) {
      log(`${phase.title} round ${round}: ${phase.lenses.length - reviews.length} reviewer(s) returned no verdict after retries`)
    }

    const approved = reviews.filter((r) => r.verdict === 'APPROVED')
    const changes = reviews.filter((r) => r.verdict === 'CHANGES_REQUIRED')
    const blockers = reviews.filter((r) => r.verdict === 'BLOCKER')

    if (approved.length === phase.lenses.length) {
      log(`${phase.title}: unconditional approval from all ${phase.lenses.length} lenses (round ${round})`)
      return { approved: true, round, reviews }
    }

    // Gather every finding and hand to the fix+rebuttal driver. Note: a BLOCKER
    // is not auto-fatal — it must survive an evidence-based rebuttal first.
    const findings = [...changes, ...blockers].flatMap((r) => r.findings.map((f) => ({ ...f, reviewer: r.reviewer })))
    const fix = await agentRetry(fixPrompt(phase, findings, currentPacket), {
      label: `fix:${phase.key}:r${round}`, phase: phase.title, schema: FIX_SCHEMA,
    })

    if (fix && fix.unresolved && fix.unresolved.length > 0) {
      log(`${phase.title}: ${fix.unresolved.length} unresolved blocker(s) survived rebuttal — stopping`)
      return { approved: false, round, reviews, blockers: fix.unresolved }
    }

    // Rebuild the evidence packet against the new head commit for the next round.
    currentPacket = await buildPacket(phase, fix && fix.commit ? fix.commit : currentPacket.commits)
    round += 1
  }
  return { approved: false, round: round - 1, blockers: [`exceeded ${MAX_REVIEW_ROUNDS} review rounds without unconditional approval`] }
}

// Verifier-built evidence packet: report path + exact commit/diff/changed-file list.
async function buildPacket(phase, headHint) {
  const p = await agentRetry([
    `Assemble the review evidence packet for ${phase.title} (steps: ${phase.steps.join(', ')}).`,
    `Determine the phase base and head commits on the feature branch (head near ${headHint}).`,
    `Aggregate the per-step verification reports under ${VERIFY_DIR}/ into one phase report at ${VERIFY_DIR}/phase-${phase.key}.md.`,
    `Run and digest local gates: npm run build, npm run lint, relevant npm test, npm run upstream:contracts, git diff --check.`,
    `Return reportPath, commits (range string), diffRange (base..head), and changedFiles (comma-separated).`,
  ].join('\n'), {
    label: `packet:${phase.key}`, phase: phase.title,
    schema: {
      type: 'object', additionalProperties: false,
      required: ['reportPath', 'commits', 'diffRange', 'changedFiles', 'gatesGreen'],
      properties: {
        reportPath: { type: 'string' }, commits: { type: 'string' },
        diffRange: { type: 'string' }, changedFiles: { type: 'string' },
        gatesGreen: { type: 'boolean' },
      },
    },
  })
  return p
}

// ---------------------------------------------------------------------------
// Main: phases sequential (linear DAG). Within a phase, steps run in order;
// Phase A foundation steps may fast-path in parallel worktrees.
// ---------------------------------------------------------------------------
const phasesToRun = PHASES.filter((p) => p.key >= START_PHASE)
log(`ACP implementation workflow — running phases ${phasesToRun.map((p) => p.key).join(',')} on the current feature branch; per-phase review gate; stops at release-ready, never publishes.`)

await agentRetry(
  `Bootstrap (idempotent — Phase A is already merged to master): confirm you are on a clean feature branch off the current master that already contains Phase A (src/acp/errors.ts and src/config.ts's [acp] schema are present; do NOT recreate them). Do NOT create, switch, or rename branches — just verify the checked-out branch is a feature branch (not master) and the tree is clean. Ensure ${STATE_DIR}, ${VERIFY_DIR}, ${REVIEW_DIR} exist (mkdir -p). decisions.md already exists from Phase A; only (re)write ${STATE_DIR}/decisions.md if it is missing, using the documented [open_questions] defaults (process reuse = per gateway-session w/ idle reaping; default_transport stays cli; adapters user-installed/deferred). Return "ok".`,
  { label: 'bootstrap', phase: phasesToRun[0].title })

async function runPhase(phase) {
  log(`${phase.title}: implementing steps ${phase.steps.join(', ')}`)
  if (phase.fastPath && phase.steps.length > 1) {
    // foundation fast-path: implement disjoint-file steps concurrently, then
    // integrate/verify in DAG order. Fall back to sequential on any null.
    const impls = await parallel(phase.steps.map((s) => () => runStep(s, phase)))
    if (impls.some((r) => !r)) log(`${phase.title}: a fast-path step returned null; results may need sequential repair`)
  } else {
    for (const s of phase.steps) await runStep(s, phase)
  }
  const packet = await buildPacket(phase, 'HEAD')
  if (!packet || !packet.gatesGreen) {
    return { phase: phase.key, approved: false, blockers: ['local gates not green before review'] }
  }
  const gate = await reviewGate(phase, packet)
  return { phase: phase.key, approved: gate.approved, round: gate.round, blockers: gate.blockers || [] }
}

const summary = []
for (const phase of phasesToRun) {
  const result = await runPhase(phase)
  summary.push(result)
  if (!result.approved) {
    log(`Stopping at ${phase.title}: not approved. Blockers: ${(result.blockers || []).join(' | ')}`)
    break
  }
}

const allApproved = summary.length === phasesToRun.length && summary.every((s) => s.approved)
log(allApproved
  ? 'All phases approved. Terminal state: release-ready (PR + green CI expected), ACP disabled by default, nothing published.'
  : 'Run halted before completion — see blockers above and docs/acp/state/blockers.md.')

return {
  approvedPhases: summary.filter((s) => s.approved).map((s) => s.phase),
  haltedAt: allApproved ? null : (summary.find((s) => !s.approved) || {}).phase || null,
  phaseResults: summary,
  releaseReady: allApproved,
  published: false,
}
