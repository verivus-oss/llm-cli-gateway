---
name: red-team-assessment
description: Run an evidence-backed adversarial security assessment through the local llm-cli-gateway stdio MCP server. Use for code, architecture, configuration, data-flow, or supply-chain security review across the full Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor roster.
---

# Red-Team Assessment

Use the local gtwy stdio MCP server for every red-team and blue-team request.
Do not launch a provider CLI directly. Start by calling
provider_tool_capabilities to verify the live provider, transport, tool, and
target-access surface.

The complete gateway CLI roster is Claude, Codex, Gemini, Grok, Mistral, Devin,
and Cursor. A full red-team assessment dispatches every required reviewer in
that roster. If a required provider is unavailable, report a blocker and repair
it or obtain explicit user direction. Do not silently call a smaller set
"complete."

Configured API providers are discovered dynamically with `list_models` and
their reported capabilities. They do not provide a local CLI checkout/worktree
or native ACP boundary, so they are not silently interchangeable with a
required source-inspecting red-team reviewer.

## Security Gate Contract

Every red-team prompt must finish with the exact terminal verdict schema:

```
APPROVED_UNCONDITIONALLY | CHANGES_REQUIRED | BLOCKED_EXTERNAL
```

`APPROVED_UNCONDITIONALLY` is allowed only when no unresolved finding or
verification gap remains. `CHANGES_REQUIRED` must include evidence-backed
findings. `BLOCKED_EXTERNAL` is reserved for a concrete external access,
provider, or environment failure with its exact error. Approval with caveats,
an accepted-but-unverified claim, a skipped surface, a malformed response,
timeout, cancellation, or provider failure is not unconditional approval.

Apply these rules:

1. Omit model unless the caller explicitly selected it.
2. Use approvalStrategy: "legacy" for Codex, Gemini, Grok, Mistral, Devin, and
   Cursor. mcp_managed is rejected for them and approvalPolicy has no effect.
3. Use mcp_managed only for a deliberately configured Claude request. In that
   mode, request-scoped strict MCP configuration is limited to provisioned
   gateway-owned definitions; do not assume ambient research tools are present.
4. Use sandboxMode: "read-only" for inspection-only Codex work, or
   sandboxMode: "workspace-write" only when red-team verification needs to
   create build or test artifacts. Do not use fullAuto.
5. Do not set review-round, turn, token, price, cost, or wallclock caps. The
   configured idle-timeout safeguard only detects a silent process.
6. Continue red-team, blue-team, and reassessment work until every required
   reviewer returns `APPROVED_UNCONDITIONALLY`.

Stop only on explicit user cancellation or a terminal external provider failure.
Treat a terminal failure as `BLOCKED_EXTERNAL` with its exact error, never as
an approval.

## Explicit user-authorized full-access red-team review

The normal inspection controls remain the default. If the user explicitly grants
full provider permissions and native MCP access, use the full
`multi-llm-review` protocol for this red-team gate. Build the target checkout
and start `node dist/index.js --transport=stdio` from it. Do not use a globally
installed or stale gateway process.

Reapply each provider-native full-access control on each new job, preserve its
ambient native MCP configuration, and do not construct a pretend full-access
gateway allowlist. Give every reviewer the verification report as a
corrective-program specification, the exact base plus diff or exhaustive
changed-file list with relevant untracked files, and durable raw evidence.
Require independent inspection of source, docs, tests, commands, and MCP facts.
For this strict review use `APPROVED_UNCONDITIONALLY`, evidence-backed
`CHANGES_REQUIRED`, or a concrete `BLOCKED_EXTERNAL` result rather than a
summary-based verdict. Do not set caller caps. If the user requires 90-second
progress checks, use non-blocking waits and do not poll early. Full capability
does not authorize review mutation unless the user separately asks for it.

## Target the Correct Repository

| Provider                     | Local target rule                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude, Codex, Grok, Mistral | Use workingDir on a new session, or select a registered workspace explicitly or by configured default.                                     |
| Gemini                       | No workingDir exists. includeDirs is auxiliary and does not choose cwd. Select a registered workspace explicitly or by configured default. |
| Devin                        | Use workingDir on a new CLI session, or select a registered workspace explicitly or by configured default.                                 |
| Cursor                       | Pass workspace as the intended local directory or registered alias.                                                                        |

Do not use workspace_* administration tools to repair a local stdio path. Under
managed Claude, custom workingDir, expanded workspace, custom tool selectors,
and native continuation require its gateway approval decision and operator
bypass configuration.

## Review Brief

Give each reviewer the target path and revision, asset classification, trust
boundaries, attacker capabilities, authentication and authorization model,
external dependencies, deployment context, and acceptance criteria. Require it
to inspect source and verification artifacts rather than rely on a summary.

Cover at least:

1. Attack surface and reachable entry points
2. Trust-boundary and data-flow violations
3. Authentication, authorization, tenancy, and privilege escalation
4. Input validation, injection, deserialization, path, command, and template risks
5. Secrets, logging, error disclosure, and privacy failures
6. Race conditions, state confusion, replay, and denial-of-service risks
7. Dependency, build, release, and supply-chain exposure
8. Cryptographic and protocol misuse
9. Detection, monitoring, and regression-test gaps

Only ask a reviewer to use a research or semantic-search tool if its current
provider configuration exposes it. Managed Claude receives only its provisioned
gateway-owned strict allowlist; it does not inherit ambient exa, ref, dynamic
npx, or other provider configuration.

## Single-Provider Assessment

Use a single provider only when the user explicitly scopes the assessment that
way. For example:

```
codex_request({
  prompt: "Red-team [target] at [revision]. Inspect the repository and
    validation evidence. Assess attack surface, trust boundaries, auth,
    validation, injection, data exposure, dependency risks, concurrency,
    crypto, and detection. For each finding provide severity, exploit path,
    proof, affected path, and remediation. Finish with exactly one terminal
    verdict: APPROVED_UNCONDITIONALLY only with no unresolved finding or
    verification gap, CHANGES_REQUIRED with evidence-backed findings, or
    BLOCKED_EXTERNAL with a concrete external error.",
  sandboxMode: "read-only",
  workingDir: "[repo]",
  approvalStrategy: "legacy",
  correlationId: "red-team-codex"
})
```

## Complete Cross-LLM Assessment

For a required full assessment, dispatch all required reviewers through gtwy in
parallel. Apply the targeting table before each request.

```
claude_request_async({
  prompt: "Red-team [target]. Focus on trust boundaries, architecture, data
    flow, failure modes, and supply-chain exposure. Finish with exactly one
    terminal verdict: APPROVED_UNCONDITIONALLY only with no unresolved finding
    or verification gap, CHANGES_REQUIRED with evidence-backed findings, or
    BLOCKED_EXTERNAL with a concrete external error.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "red-team-claude"
})

codex_request_async({
  prompt: "Red-team [target]. Focus on implementation flaws, authorization,
    concurrency, injection, error handling, and tests. Finish with exactly one
    terminal verdict: APPROVED_UNCONDITIONALLY only with no unresolved finding
    or verification gap, CHANGES_REQUIRED with evidence-backed findings, or
    BLOCKED_EXTERNAL with a concrete external error.",
  sandboxMode: "read-only",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "red-team-codex"
})

gemini_request_async({
  prompt: "Red-team [target]. Focus on web and API attack patterns, data
    exposure, dependencies, cryptography, and operational failure modes. Finish
    with exactly one terminal verdict: APPROVED_UNCONDITIONALLY only with no
    unresolved finding or verification gap, CHANGES_REQUIRED with
    evidence-backed findings, or BLOCKED_EXTERNAL with a concrete external error.",
  approvalStrategy: "legacy",
  workspace: "[verified Gemini workspace]",
  correlationId: "red-team-gemini"
})

grok_request_async({
  prompt: "Independently red-team [target]. Seek overlooked attack paths,
    challenge assumptions, and identify shared blind spots. Finish with exactly
    one terminal verdict: APPROVED_UNCONDITIONALLY only with no unresolved
    finding or verification gap, CHANGES_REQUIRED with evidence-backed
    findings, or BLOCKED_EXTERNAL with a concrete external error.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "red-team-grok"
})

mistral_request_async({
  prompt: "Independently red-team [target] for implementation, data-flow, and
    maintainability security risks. Finish with exactly one terminal verdict:
    APPROVED_UNCONDITIONALLY only with no unresolved finding or verification
    gap, CHANGES_REQUIRED with evidence-backed findings, or BLOCKED_EXTERNAL
    with a concrete external error.",
  approvalStrategy: "legacy",
  workingDir: "[repo]",
  correlationId: "red-team-mistral"
})

devin_request_async({
  prompt: "Independently red-team [target] for exploitable defects, permission
    gaps, and missing validation. Finish with exactly one terminal verdict:
    APPROVED_UNCONDITIONALLY only with no unresolved finding or verification
    gap, CHANGES_REQUIRED with evidence-backed findings, or BLOCKED_EXTERNAL
    with a concrete external error.",
  approvalStrategy: "legacy",
  correlationId: "red-team-devin"
})
// Dispatch Devin only from a gateway process whose confirmed cwd is [repo].

cursor_request_async({
  prompt: "Independently red-team [target] for repository-specific vulnerabilities,
    unsafe defaults, and regression risks. Finish with exactly one terminal
    verdict: APPROVED_UNCONDITIONALLY only with no unresolved finding or
    verification gap, CHANGES_REQUIRED with evidence-backed findings, or
    BLOCKED_EXTERNAL with a concrete external error.",
  approvalStrategy: "legacy",
  workspace: "[repo]",
  correlationId: "red-team-cursor"
})
```

Poll with llm_job_status and collect with llm_job_result through gtwy whenever
async job tools are registered. Use non-blocking waits and do not cancel merely
because an assessment runs for a long time.

When persistence.backend = "none", use the corresponding sync request tools for
the same required roster. They run to completion without auto-deferral. Missing
async tooling is not a reason to omit a required red teamer.

## Triage and Blue-Team Response

1. Union findings from all reviewers. A single credible report must be
   investigated; agreement is useful evidence, not a substitute for proof.
2. Confirm the exploit path, affected scope, and severity.
3. Produce a blue-team response for every finding: defense, detection,
   prevention, and verification.
4. Implement every remediation needed to reach the requested unconditional
   `APPROVED_UNCONDITIONALLY` verdict. Critical and high findings must be fixed
   before merge or release.
   Medium and low findings require remediation or explicit user risk acceptance;
   label accepted risk distinctly, never as unconditional approval.
5. Build and test the changes, then re-run every required original red teamer.

```
codex_request({
  prompt: "Implement and test the approved blue-team remediations for [target].
    For each finding provide the code change, detection signal, prevention
    measure, and regression test. Do not claim APPROVED_UNCONDITIONALLY. Return
    implementation and validation evidence for a fresh red-team assessment.",
  sandboxMode: "workspace-write",
  workingDir: "[repo]",
  approvalStrategy: "legacy",
  correlationId: "blue-team-implementation"
})
```

## PromptParts, Sessions, and Persistence

Claude, Codex, Gemini, Grok, and Mistral accept promptParts. Devin and Cursor
accept only flat prompt. Preserve one canonical review brief, send it as prompt
to Devin and Cursor, and derive identical structured stable context for the
other five. Use exactly one of prompt or promptParts. Cache-state resources
expose aggregate hashes and token counts only, never red-team prompt or result
content.

Mistral Vibe defaults to accept-edits for programmatic callers and uses legacy
approval. Current Vibe session logging defaults to enabled; run doctor and
correct an explicit [session_logging] enabled = false setting before relying on
resume. Codex native resume requires a real Codex UUID and inherits its
original target and sandbox posture.

SQLite and Postgres persistence make async jobs durable. Memory persistence is
process-lifetime only and needs explicit acknowledgement. With
persistence.backend = "none", async and job tools are absent. Do not interpret
an unavailable job store as evidence that an assessment completed.

Personal Agent Config Kit supports Claude and Codex only and requires durable
job admission. A complete seven-provider assessment cannot run in Kit mode;
treat that as a blocker unless the user explicitly changes the required scope.
The normal Claude `workingDir` target rule does not apply to a Claude Kit
request: it rejects caller-supplied `workingDir` before context compilation.
`explain_effective_config({workingDir:"<repo>"})` can inspect a candidate scope,
but Claude Kit execution must use an already configured registered `workspace`
alias or the configured default workspace. It never inherits the gateway
process cwd.

## Final Assessment Record

- Required roster, provider capability evidence, and target revision
- Threat model and assessment brief
- Every finding, proof, severity, and blue-team response
- Validation and regression-test evidence
- Fresh final `APPROVED_UNCONDITIONALLY` verdict from every required reviewer,
  with no caveats
- Any accepted risk or terminal provider failure separately labeled as
  `CHANGES_REQUIRED` or `BLOCKED_EXTERNAL`
