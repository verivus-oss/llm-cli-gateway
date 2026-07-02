// Autonomous workflow: drive phases 2-9 of the full-featured CLI/ACP provider
// integration DAG to completion WITHOUT human babysitting.
//
// Runs in the background. For each phase it: implements (fresh sub-agent) ->
// runs every gate to green -> runs the cross-LLM review roster (Codex/Grok/
// Mistral, plus Gemini for non-security phases) -> loops fix rounds until the
// reviewers raise no blockers (max 3 rounds) -> commits the phase. Phase-9 runs
// the full-diff review plus `npm run check` and stops at "PR ready" (never
// releases).
//
// Prereqs already committed on branch feature/remote-http-oauth-ux-improvements-v2:
//   phase-0 (baseline), phase-1 (provider-definitions SoT), phase-1b (runtime
//   capability discovery + cache). This workflow starts at phase-2.
//
// Invoke:  Workflow({ scriptPath: '<repo>/docs/plans/full-featured-cli-acp-provider-integrations.workflow.mjs' })
// Resume:  Workflow({ scriptPath, resumeFromRunId: '<prior runId>' })  (unchanged
//          agent() calls return cached; re-run continues from the first change).

export const meta = {
  name: 'full-featured-cli-acp-provider-integrations',
  description:
    'Autonomously implement phases 2-9 of the provider-integration DAG: per phase implement + gate + cross-LLM review loop (Codex/Grok/Mistral[/Gemini]) + commit; stop at PR-ready.',
  phases: [
    { title: 'grounding', detail: 'capture installed provider --help/--version evidence' },
    { title: 'phase-2 resources', detail: 'generated models://sessions:// resources' },
    { title: 'phase-3 model-discovery', detail: 'live/account-aware model discovery' },
    { title: 'phase-4 request-fields', detail: 'complete CLI request schemas + argv' },
    { title: 'phase-5 acp', detail: 'native ACP full surface (security)' },
    { title: 'phase-6 admin', detail: 'provider admin surfaces (security)' },
    { title: 'phase-7 normalization', detail: 'output/event normalization' },
    { title: 'phase-8 docs', detail: 'README/CLAUDE/provider skills' },
    { title: 'phase-9 release-gate', detail: 'full-diff review + npm run check, stop at PR-ready' },
  ],
}

const REPO = '/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway'
const DAG = `${REPO}/docs/plans/full-featured-cli-acp-provider-integrations.dag.toml`
const BRIEF = `${REPO}/docs/plans/full-featured-cli-acp-provider-integrations.prompt.md`
const HELP = '/tmp/ffci-provider-help'

const GUARDRAILS = [
  'GUARDRAILS (hard, non-negotiable):',
  '- No em dash U+2014 anywhere (a PreToolUse hook blocks edits and commits that contain one). Use comma/period/colon/parentheses.',
  '- No Co-Authored-By trailer. Match repo commit style (conventional, imperative).',
  '- Tool names snake_case; Zod at every input boundary; explicit return types on exported functions.',
  '- All human-readable output to stderr; stdout is MCP JSON-RPC only; no provider ACP stdout ever reaches gateway stdout.',
  '- node:sqlite referenced only in src/sqlite-driver.ts; no `fetch` token in dist/.',
  '- No shell interpolation when spawning provider processes; fixed argv arrays only.',
  '- Credentials/tokens/OAuth codes/bearer headers/account ids never appear in MCP responses, docs, logs, plan files, or test snapshots.',
  '- Principal isolation: never thread a sessionId/workingDir/worktree from another principal into a handler. Codex resume needs a real Codex UUID, not gw-*.',
  `- Ground every flag/subcommand/ACP method in installed --help (files under ${HELP}) or the DAG docs URLs. Never invent capability; if installed help and a doc disagree, installed help wins and is recorded as a capability fact.`,
  '- src/provider-definitions.ts is the single source of truth. Do NOT add provider-name array literals or manual models://<name> / sessions://<name> blocks outside the registry and its generated projections; scripts/provider-surfaces-check.mjs (npm run provider:surfaces:check) enforces this and has a shrinking LEGACY_ALLOWLIST that phases drain.',
  '- Prefer the sqry MCP tools (mcp__sqry__*) to locate code before editing; avoid whole-file reads.',
  '- Do NOT git commit inside impl/fix agents; a dedicated commit step commits each phase.',
].join('\n')

const GATES =
  'Run ALL of these and fix-and-rerun until every one is green (do not stop on red): the node `commands`, plus `npm run build`, `npm run lint` (0 ERRORS; warnings are the pre-existing baseline and are OK), `npm run format:check`, `npm run provider:surfaces:check`, and the FULL `npm test`.'

const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    phase: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    gatesGreen: { type: 'boolean' },
    gateSummary: { type: 'string', description: 'each gate command with pass/fail + npm test counts' },
    acceptanceMet: { type: 'array', items: { type: 'string' }, description: 'each node acceptance item with a file:line or test-name citation' },
    openRisks: { type: 'array', items: { type: 'string' } },
  },
  required: ['phase', 'filesChanged', 'gatesGreen', 'gateSummary'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reviewer: { type: 'string' },
    approved: { type: 'boolean' },
    ranFailed: { type: 'boolean', description: 'true if the external reviewer crashed/hung and produced no usable verdict' },
    blockers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
  required: ['reviewer', 'approved', 'ranFailed', 'blockers'],
}

// Phase specs. `security:true` drops Gemini from the roster (Antigravity refuses
// audit/vuln tasks). `drains` names a LEGACY_ALLOWLIST entry the phase removes.
const PHASES = [
  {
    node: 'phase-2-generated-model-and-session-resources',
    title: 'phase-2 resources',
    files: ['src/resources.ts', 'src/model-registry.ts', 'src/session-manager.ts', 'src/__tests__/resources.test.ts'],
    drains: 'the src/resources.ts [manual-resource-block] entry in scripts/provider-surfaces-check.mjs LEGACY_ALLOWLIST (remove it once the manual sessions://models:// blocks are gone; confirm the check still passes)',
    gate: 'npx vitest run src/__tests__/resources.test.ts src/__tests__/session-tools.test.ts',
    security: false,
  },
  {
    node: 'phase-3-live-model-discovery',
    title: 'phase-3 model-discovery',
    files: ['src/model-registry.ts', 'src/provider-model-discovery.ts', 'src/provider-tool-capabilities.ts', 'src/__tests__/model-registry.test.ts'],
    drains: null,
    gate: 'npx vitest run src/__tests__/model-registry.test.ts src/__tests__/provider-tool-capabilities.test.ts',
    security: false,
  },
  {
    node: 'phase-4-complete-cli-request-fields',
    title: 'phase-4 request-fields',
    files: ['src/index.ts', 'src/provider-codegen.ts', 'src/upstream-contracts.ts', 'src/__tests__ handler/argv tests'],
    drains: 'the src/index.ts [literal-provider-array] entry (approval_list) in the LEGACY_ALLOWLIST if the request-tool wiring is migrated to the registry projection',
    gate: 'npm test',
    security: false,
  },
  {
    node: 'phase-5-native-acp-full-surface',
    title: 'phase-5 acp',
    files: ['src/acp/types.ts', 'src/acp/client.ts', 'src/acp/process-manager.ts', 'src/acp/provider-registry.ts', 'src/acp/event-normalizer.ts', 'src/acp/session-map.ts', 'src/provider-acp-capabilities.ts', 'src/__tests__/acp-*.test.ts'],
    drains: null,
    gate: 'npx vitest run src/__tests__/acp-types.test.ts src/__tests__/acp-client.test.ts src/__tests__/acp-process-manager.test.ts src/__tests__/acp-provider-registry.test.ts src/__tests__/acp-event-normalizer.test.ts src/__tests__/acp-session-map.test.ts src/__tests__/acp-smoke-harness.test.ts',
    security: true,
  },
  {
    node: 'phase-6-provider-admin-surfaces',
    title: 'phase-6 admin',
    files: ['src/provider-admin-tools.ts', 'src/upstream-contracts.ts', 'src/index.ts', 'src/__tests__/provider-admin-tools.test.ts'],
    drains: null,
    gate: 'npx vitest run src/__tests__/provider-admin-tools.test.ts src/__tests__/upstream-contracts.test.ts',
    security: true,
  },
  {
    node: 'phase-7-output-and-event-normalization',
    title: 'phase-7 normalization',
    files: ['src/claude-json-parser.ts', 'src/codex-json-parser.ts', 'src/gemini-json-parser.ts', 'src/grok-json-parser.ts (create; confirm-then-create)', 'src/mistral-meta-json-parser.ts', 'src/acp/event-normalizer.ts', 'src/flight-recorder.ts'],
    drains: null,
    gate: 'npx vitest run src/__tests__/*parser*.test.ts src/__tests__/acp-event-normalizer.test.ts src/__tests__/flight-recorder*.test.ts',
    security: false,
  },
  {
    node: 'phase-8-provider-capability-docs-and-skills',
    title: 'phase-8 docs',
    files: ['README.md', 'CLAUDE.md', '.agents/skills/provider-claude/SKILL.md', '.agents/skills/provider-codex/SKILL.md', '.agents/skills/provider-gemini/SKILL.md', '.agents/skills/provider-grok/SKILL.md', '.agents/skills/provider-mistral/SKILL.md'],
    drains: null,
    gate: 'npm run format:check ; rg -n "pilot|deferred|watchlist|not yet|todo|incomplete" README.md docs .agents/skills || true',
    security: false,
  },
]

const rosterFor = (p) => (p.security ? ['codex', 'grok', 'mistral'] : ['codex', 'grok', 'mistral', 'gemini'])

const implPrompt = (p) => `Implement node "${p.node}" of the DAG at ${DAG}. That DAG node (its description, files, acceptance, commands) and the mission brief at ${BRIEF} are the authoritative spec; read the node and the relevant brief sections in full. DO the work; do not describe it.

Files in scope: ${p.files.join(', ')}.
${p.drains ? `This phase drains ${p.drains}.` : ''}

${GUARDRAILS}

${GATES} The node gate is: ${p.gate}
If this phase adds tests, each new test MUST fail under a mutation of the behavior it guards (mutation-probe veracity); verify that and note it.

Return the structured report (filesChanged, gatesGreen, gateSummary with npm test counts, acceptanceMet with citations, openRisks). Do NOT git commit.`

const reviewPrompt = (p, cli) => `You orchestrate an external ${cli} cross-LLM review of DAG node "${p.node}" in ${REPO}. READ-ONLY: do not edit/stage/commit.

1. Compute the phase diff: run \`git -C ${REPO} --no-pager diff --stat HEAD\` and \`git -C ${REPO} --no-pager diff HEAD\`; save the full diff to /tmp/ffci-review-${p.node}.diff. Changed files should be within: ${p.files.join(', ')}.
2. Load the gateway tools via ToolSearch: select:mcp__gtwy__${cli}_request_async,mcp__gtwy__llm_job_status,mcp__gtwy__llm_request_result .
3. Send ${cli} a strict, adversarial READ-ONLY review prompt (${cli === 'codex' ? 'sandboxMode:read-only; ' : ''}${cli === 'grok' ? 'disableWebSearch:true; ' : ''}${cli === 'mistral' ? 'omit permissionMode so it is not stuck in plan mode; ' : ''}set a unique correlationId like ffci-${p.node}-${cli}). Tell ${cli}: verify every claim against the ACTUAL code/tests and installed --help evidence in ${HELP}, NOT against any summary; give it the absolute changed-file paths and the diff path; do NOT pass workingDir/workspace/addDir. It must check: no invented capability (every flag/subcommand/ACP method traces to installed help); DRY honesty (provider:surfaces:check is real, its LEGACY_ALLOWLIST holds only genuine legacy sites, no new provider-name literals or manual resource blocks outside the registry); security invariants (no shell interpolation, no secret leakage to responses/logs/snapshots, principal isolation, mutating admin gated); and test veracity (each NEW test must fail under a mutation of the guarded behavior). It must answer "UNCONDITIONAL APPROVAL" or list concrete file:line blockers.
4. Poll mcp__gtwy__llm_job_status every ~90s (sleep in bash between polls) up to ~9 minutes. When complete, fetch the clean verdict via mcp__gtwy__llm_request_result by the correlationId (not llm_job_result, which returns from the start).
5. If ${cli} crashes ("worker quit"/tool_output_error) or hangs past the deadline, cancel it (mcp__gtwy__llm_job_cancel) and retry ONCE. If it still fails, return approved:false is WRONG - instead return ranFailed:true with an empty blockers array (a flaky reviewer must not block the phase).

Parse the verdict into the schema: reviewer="${cli}", approved (true only on an explicit unconditional approval), ranFailed, blockers[] (each concrete finding with file/line/summary). Only include blockers the reviewer actually raised with code evidence.`

const fixPrompt = (p, blockers) => `Cross-LLM review of DAG node "${p.node}" in ${REPO} raised these blockers:\n${JSON.stringify(blockers, null, 2)}\n
Fix every genuinely-valid blocker, grounded in installed --help (${HELP}) and the DAG. If a blocker is invalid, already-handled, or an out-of-scope/undetectable class, do NOT thrash: justify the dismissal with a specific code citation in openRisks instead of adding speculative code. ${GUARDRAILS}\n
${GATES} The node gate is: ${p.gate}\nReturn the structured report of what you changed. Do NOT git commit.`

const commitPrompt = (p, unresolved) => `All gates are green and the cross-LLM review of DAG node "${p.node}" is clean${unresolved && unresolved.length ? ` except these dismissed/out-of-scope items which are acceptable: ${JSON.stringify(unresolved)}` : ''}. Stage and commit ONLY this phase's working-tree changes: \`git -C ${REPO} add -A && git -C ${REPO} commit\` with a conventional, imperative message summarizing the phase (no Co-Authored-By trailer, no em dash U+2014 anywhere in the message). Then output ONLY the short commit hash from \`git -C ${REPO} rev-parse --short HEAD\`.`

// ---- run ----

phase('grounding')
await agent(
  `Capture installed provider evidence for downstream review grounding. Create ${HELP}/ . For each command below, run it with a 25s timeout and NO shell interpolation, saving combined stdout+stderr to ${HELP}/<slug>.txt, then write ${HELP}/checksums.txt via sha256sum. Commands: claude --version, codex --version, agy --version, grok --version, vibe --version, devin --version, cursor-agent --version, claude --help, codex --help, codex exec --help, agy --help, grok --help, grok agent --help, vibe --help, vibe-acp --help, devin --help, devin acp --help, cursor-agent --help, cursor-agent acp --help. Report the versions captured and any command that failed.`,
  { label: 'grounding', phase: 'grounding' }
)

const summary = []
for (const p of PHASES) {
  phase(p.title)
  await agent(implPrompt(p), { schema: REPORT_SCHEMA, label: `impl:${p.node}`, phase: p.title })

  let round = 0
  let open = []
  while (round < 3) {
    const verdicts = (
      await parallel(
        rosterFor(p).map((cli) => () =>
          agent(reviewPrompt(p, cli), { schema: VERDICT_SCHEMA, label: `review:${p.node}:${cli}`, phase: p.title })
        )
      )
    ).filter(Boolean)
    open = verdicts.filter((v) => !v.ranFailed).flatMap((v) => v.blockers || [])
    const approvals = verdicts.filter((v) => v.approved && !v.ranFailed).length
    const failed = verdicts.filter((v) => v.ranFailed).map((v) => v.reviewer)
    log(`${p.node} review round ${round + 1}: ${approvals}/${verdicts.length} approve, ${open.length} blockers${failed.length ? `, no-verdict from ${failed.join(',')}` : ''}`)
    if (open.length === 0) break
    await agent(fixPrompt(p, open), { schema: REPORT_SCHEMA, label: `fix:${p.node}:r${round + 1}`, phase: p.title })
    round++
  }
  if (open.length) log(`WARNING ${p.node}: ${open.length} blocker(s) survived ${round} fix rounds; committing with them recorded as open risk for phase-9.`)

  const commit = await agent(commitPrompt(p, open), { label: `commit:${p.node}`, phase: p.title })
  summary.push({ node: p.node, commit: (commit || '').trim(), residualBlockers: open })
  log(`${p.node} committed ${(commit || '').trim()}`)
}

// ---- phase-9: full-diff review + npm run check, stop at PR-ready ----
phase('phase-9 release-gate')
const finalReview = (
  await parallel(
    ['codex', 'grok', 'mistral'].map((cli) => () =>
      agent(
        `Final full-branch cross-LLM review via external ${cli} in ${REPO}. READ-ONLY. The full change set is the diff of the current branch vs master: run \`git -C ${REPO} --no-pager diff master...HEAD --stat\` and save \`git -C ${REPO} --no-pager diff master...HEAD\` to /tmp/ffci-review-final-${cli}.diff. Load ToolSearch select:mcp__gtwy__${cli}_request_async,mcp__gtwy__llm_job_status,mcp__gtwy__llm_request_result,mcp__gtwy__llm_job_cancel . Ask ${cli} (${cli === 'codex' ? 'sandboxMode:read-only, ' : ''}${cli === 'grok' ? 'disableWebSearch:true, ' : ''}correlationId ffci-final-${cli}) to verify the WHOLE integration against actual code/tests/installed-help (${HELP}): DRY single-source-of-truth, grounded capabilities, security invariants, native-ACP only where upstream advertises it (grok/mistral/devin; NOT claude/codex/gemini), docs match shipped surface, and test veracity. Poll status every 90s up to ~10 min; collect via llm_request_result by correlationId; retry once on crash/hang, else ranFailed:true. Return the verdict.`,
        { schema: VERDICT_SCHEMA, label: `final-review:${cli}`, phase: 'phase-9 release-gate' }
      )
    )
  )
).filter(Boolean)

const finalOpen = finalReview.filter((v) => !v.ranFailed).flatMap((v) => v.blockers || [])
if (finalOpen.length) {
  log(`phase-9: ${finalOpen.length} full-diff blocker(s); dispatching a final fix pass.`)
  await agent(
    `Final-review blockers on the full branch in ${REPO}:\n${JSON.stringify(finalOpen, null, 2)}\nFix the valid ones (grounded; justify any dismissal with a code cite). ${GUARDRAILS}\n${GATES}\nThen commit the fixes (conventional, no Co-Authored-By, no em dash). Do not release.`,
    { label: 'phase-9:fix', phase: 'phase-9 release-gate' }
  )
}

const gate = await agent(
  `Run the release gate in ${REPO} and produce the PR-ready handoff. Execute \`npm run check\` (build + lint + format:check + test + security:audit) and \`npm run upstream:contracts\` and \`npm run provider:surfaces:check\`; fix-and-rerun until all green (${GUARDRAILS}). Do NOT release, do NOT push, do NOT open a PR - STOP at "PR ready for review". Return a concise handoff: the branch name, \`git -C ${REPO} --no-pager diff master...HEAD --stat\` inventory, the green gate output (npm test counts), and any residual open risk.`,
  { label: 'phase-9:gate', phase: 'phase-9 release-gate' }
)

return { branch: 'feature/remote-http-oauth-ux-improvements-v2', phases: summary, finalReviewBlockers: finalOpen, releaseGate: gate }
