---
name: agent-codex-gate
description: Pattern for spawning subagents whose work must receive an evidence-backed, unconditional Codex review through the local llm-cli-gateway stdio MCP server. Use when parallel implementation tasks need an independent Codex quality gate.
---

# Agent + Codex Gate Pattern

Spawn subagents for independent implementation work, then make each one obtain
an unconditional Codex verdict before accepting its result. A Codex-only gate is
not a substitute for a required cross-LLM review.

## Required Transport and Review Contract

Use the local stdio gateway only. In Codex, the tools normally appear as
mcp__gtwy__codex_request, mcp__gtwy__codex_request_async, and
mcp__gtwy__llm_job_*. Other MCP clients may display the short names. Do not run
the codex CLI directly for a review request.

For every mandatory review:

1. Omit model unless the caller explicitly selected a model.
2. Pass approvalStrategy: "legacy". Gateway-managed approval is Claude-only;
   Codex rejects mcp_managed and ignores approvalPolicy.
3. Use sandboxMode: "read-only" for normal inspection. Use
   sandboxMode: "workspace-write" only when the reviewer must produce
   write-producing build or test artifacts. Do not use fullAuto; it is a
   deprecated shorthand for workspace-write.
4. Require the terminal JSON verdict:
   `APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED`, or `BLOCKED_EXTERNAL`.
5. Do not set a review round, turn, token, price, cost, or wallclock limit.
   The configured idle-timeout safeguard is for a process that produces no
   output, not a completion deadline.
6. Continue until Codex returns explicit, evidence-backed
   `APPROVED_UNCONDITIONALLY`. A conditional verdict, residual finding,
   malformed response, inability to verify, timeout, cancellation, or provider
   failure is not approval.

Repair access, targeting, evidence, or findings and resubmit as often as
needed. Stop only on explicit user cancellation or a terminal external provider
failure. Report a terminal failure as `BLOCKED_EXTERNAL` with its exact error;
never skip the gate or label the work approved.

## Explicit user-authorized full-access Codex gate

The preceding read-only and workspace-write defaults are the normal Codex gate,
not a limit on an explicitly authorized full-access review. For that exception,
build the exact target checkout and start `node dist/index.js --transport=stdio`
from it. Do not use a globally installed or stale `gtwy` process.

Start a fresh Codex review session with
`approvalStrategy:"legacy"`, `sandboxMode:"danger-full-access"`, and
`dangerouslyBypassApprovalsAndSandbox:true`. Do not use `fullAuto`, a resume
that needs a new sandbox, or a gateway MCP/tool restriction as a claimed
full-access configuration. Preserve Codex's ambient native MCP configuration,
verify its live availability, and tell the reviewer to use available MCP tools
when useful. Full capability does not authorize mutation: request no edits,
staging, commits, resets, or destructive repository actions unless separately
authorized.

Supply the verification report as a corrective-program specification, the exact
base plus diff or exhaustive changed-file list (including relevant untracked
files), and persistent job/test evidence. Require direct code, docs, tests, and
command inspection. Accept only `APPROVED_UNCONDITIONALLY`; otherwise require
evidence-backed `CHANGES_REQUIRED` or a concrete `BLOCKED_EXTERNAL` error. Do
not set caller caps, and when the user requests 90-second progress checks, do
not poll earlier. Reapply this posture on every new review job because Codex
resume inherits its prior sandbox.

## Orchestrator Protocol

1. Spawn one subagent per independent task.
2. Give every subagent the target repository path, acceptance criteria, and
   the following completion contract.

```
After implementing:
1. Build and test the changed work.
2. Submit a review through the local gtwy stdio MCP tool:

   codex_request({
     prompt: "Review [what changed] in [paths]. Check correctness, edge cases,
       tests, and project conventions. Return terminal JSON verdict
       APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with
       inspected evidence.",
     sandboxMode: "read-only",
     approvalStrategy: "legacy"
   })

3. If the review must run a command that writes build or test artifacts, use
   sandboxMode: "workspace-write" for that request instead.
4. If the response is deferred, poll llm_job_status through gtwy and collect
   llm_job_result when terminal.
5. On anything other than `APPROVED_UNCONDITIONALLY`, fix every finding or
   supply the missing evidence, rebuild, retest, and re-submit.
6. Continue without a numeric review cap. A provider failure is
   `BLOCKED_EXTERNAL`, not an approval.
7. Report the implementation evidence, every review result, and the final
   `APPROVED_UNCONDITIONALLY` verdict.
```

3. Verify each report rather than trusting a summary. Confirm the exact
   reviewer verdict, validation evidence, and target paths.
4. Accept work only after the required Codex gate has
   `APPROVED_UNCONDITIONALLY`.

## Deferred Reviews

If the gateway exposes async job tools and a request returns status: "deferred",
retain its job identifier and use the gateway job tools:

```
repeat using a non-blocking wait:
  status = llm_job_status({ jobId })
  if status is completed, failed, canceled, or orphaned:
    break

result = llm_job_result({ jobId })
```

Do not cancel a review because it is slow. When persistence uses SQLite or
Postgres, jobs are durable. Memory persistence is process-lifetime only and
requires its explicit ephemeral acknowledgement; persistence.backend = "none"
does not register async or job tools. Reissue an identical request only when
the gateway supports deduplication and the reviewed inputs are unchanged.

Use the orchestrator's non-blocking wakeup or job-notification mechanism rather
than a synchronous sleep that freezes the agent.

## Target and Evidence Discipline

Codex accepts local workingDir and addDir on a new session. Pass the actual
target directory or start the stdio gateway in that repository; never allow a
default workspace to silently redirect the review. Native Codex resume inherits
the original working directory and sandbox posture, so establish them correctly
on the first request. A Codex sessionId must be a real Codex UUID; gateway
generated gw- identifiers are not valid native resume identifiers.

Supply command output or focused file content only when Codex cannot access a
necessary dependency. Inline evidence supplements direct repository inspection;
it does not turn an unverifiable verdict into approval.

For repeated Codex reviews, promptParts may preserve a stable review brief:

```
codex_request({
  promptParts: {
    system: "Stable review criteria",
    context: "Stable target paths and acceptance criteria",
    task: "Re-review after the listed fixes. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence."
  },
  sandboxMode: "read-only",
  approvalStrategy: "legacy"
})
```

prompt and promptParts are mutually exclusive. Keep only the stable prefix in
system, tools, or context; inspect cache-state resources only for aggregate
tokens and hashes, never as proof that a review passed.

## Cross-LLM Escalation

When the task requires a cross-LLM gate, first call provider_tool_capabilities
through gtwy and define the required roster from the seven CLI surfaces:
Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor. Dispatch every required
available reviewer through gtwy. Do not replace an unavailable reviewer with a
smaller roster without explicit user direction; an unavailable required provider
is `BLOCKED_EXTERNAL`, not an approval.

Use the multi-llm-consensus or multi-llm-orchestration skill for the complete
roster, provider-specific repository targeting, and promptParts limitation:
Devin and Cursor accept flat prompt only.

## Acceptance Checklist

- [ ] The review was dispatched through the local gtwy stdio MCP server.
- [ ] Codex used legacy approval and an explicit current sandbox mode.
- [ ] The reviewer inspected the intended repository and paths.
- [ ] All findings and verification gaps were resolved or re-reviewed.
- [ ] The final response was explicit `APPROVED_UNCONDITIONALLY`.
- [ ] Any terminal provider failure was reported as `BLOCKED_EXTERNAL`, never accepted.
