---
name: codex-review-gate
description: Submit completed work to Codex through the local llm-cli-gateway stdio MCP server and continue until an evidence-backed, unconditional approval. Use after implementation, before merging, or whenever a process requires Codex sign-off.
---

# Codex Review Gate

Use this gate after implementation and local verification. Dispatch reviews only
through the local gtwy stdio MCP server, never through a direct codex CLI
command. In Codex the gateway tools normally have names such as
mcp__gtwy__codex_request and mcp__gtwy__codex_request_async; some clients show
their short names instead.

## Non-Negotiable Review Rules

1. Omit model unless the user selected one.
2. Pass approvalStrategy: "legacy". Codex cannot use mcp_managed, and
   approvalPolicy has no effect for it.
3. Use sandboxMode: "read-only" for an inspection-only review. Use
   sandboxMode: "workspace-write" only when the reviewer needs to create build
   or test artifacts. Do not use fullAuto; it is deprecated shorthand for
   workspace-write.
4. Require this exact terminal JSON verdict:
   `APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED`, or `BLOCKED_EXTERNAL`.
5. Do not impose a review-round, turn, token, price, cost, or wallclock cap.
   Do not use a provider equivalent of those controls to shorten a mandatory
   review. The configured idle-timeout safeguard only detects a process that
   stops producing output.
6. Accept only explicit, evidence-backed `APPROVED_UNCONDITIONALLY`.
   Conditional approval, residual findings, a malformed verdict, inability to
   verify, cancellation, timeout, or provider error does not pass the gate.

Keep fixing and re-reviewing until the required verdict arrives. Stop only on
explicit user cancellation or a terminal external provider failure. A terminal
failure is `BLOCKED_EXTERNAL` with its exact error, never permission to skip the gate.

## Explicit user-authorized full-access override

The normal safe posture above does not apply when the user explicitly grants
full provider permissions and native MCP access for this review. Build the
target checkout and start `node dist/index.js --transport=stdio` from that
checkout. Do not call a global or stale `gtwy` process. On a fresh Codex session
use `approvalStrategy:"legacy"`, `sandboxMode:"danger-full-access"`, and
`dangerouslyBypassApprovalsAndSandbox:true`.

Do not combine that posture with `fullAuto`, a resume that needs a new sandbox,
or a gateway tool/MCP restriction. Let Codex's ambient native MCP configuration
be the MCP surface, verify it live, and ask the reviewer to use available MCP
tools when useful. Full capability remains review-only unless separately
authorized: prohibit edits, staging, commits, resets, and destructive actions
in the reviewer prompt.

Give the reviewer a corrective-program verification report, the exact base and
diff or exhaustive changed-file list including relevant untracked files, and
durable job/test output locations. It must inspect code, documentation, tests,
and commands directly, not accept the report as proof. Require
`APPROVED_UNCONDITIONALLY`, `CHANGES_REQUIRED` with file/command evidence, or
`BLOCKED_EXTERNAL` with its exact error. Set no caller caps. If the user asks
for 90-second progress checks, do not poll earlier, and reapply the full posture
on every new job because Codex resume inherits its original sandbox.

## Submit the Initial Review

State the change, target paths, acceptance criteria, and requested evidence.
Make sure the local stdio gateway is operating in the intended repository, or
pass Codex a local workingDir on the first new session.

```
codex_request({
  prompt: "Review the changes in [paths]. They implement [feature or fix].
    Check correctness, edge cases, test coverage, regressions, and project
    conventions. Read the repository and validation evidence. Return terminal
    JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or
    BLOCKED_EXTERNAL with inspected evidence.",
  sandboxMode: "read-only",
  approvalStrategy: "legacy",
  correlationId: "review-initial"
})
```

If the normal review needs to run a command that writes generated output, use
sandboxMode: "workspace-write" for that call. Do not use danger-full-access as
the normal review mode. Use it only through the explicit user-authorized
full-access override above.

## Handle Results

- `APPROVED_UNCONDITIONALLY`: record the response and its evidence. The gate passes.
- `CHANGES_REQUIRED`: fix every finding, build and test, then submit the updated work.
- A qualified approval: treat it as `CHANGES_REQUIRED` until every condition is
  explicitly resolved and Codex gives a fresh strict verdict.
- Cannot verify: correct repository targeting, sandbox access, or missing
  evidence and submit again. Do not accept a conclusion based on an inaccessible
  target.
- Failed, canceled, orphaned, or malformed response: diagnose and retry through
  gtwy. If the provider has a terminal external failure, report `BLOCKED_EXTERNAL`.

```
codex_request({
  prompt: "Re-review [paths] after these fixes: [finding and evidence list].
    Verify every prior finding and inspect for regressions. Return terminal JSON
    verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with
    inspected evidence.",
  sandboxMode: "read-only",
  approvalStrategy: "legacy",
  correlationId: "review-follow-up"
})
```

Do not use a numerical round count as a reason to escalate or accept work.
Continue while a meaningful repair or verification action remains.

## Deferred Jobs

When async jobs are registered and the gateway returns status: "deferred", poll
through gtwy using llm_job_status and collect the terminal response with
llm_job_result. Use the orchestrator's non-blocking wakeup mechanism between
polls. Do not cancel a review because it is long-running.

SQLite and Postgres persistence make jobs durable; memory persistence lasts only
for the gateway process and requires explicit ephemeral acknowledgement.
persistence.backend = "none" does not expose async or job tools. Reuse a job
identifier or an identical deduplicable request only when the reviewed inputs
have not changed.

## Continuity and Stable Prompts

On a new Codex session, establish the target working directory and sandbox
correctly. Native resume inherits those properties. resumeLatest:true or a real
Codex session UUID can continue a legacy Codex session; a gateway-generated
gw-* identifier cannot be supplied as a native Codex sessionId. Resume also
does not apply new sandbox, working-directory, or add-directory settings.

For repeated reviews of the same target, Codex supports promptParts:

```
codex_request({
  promptParts: {
    system: "Stable review policy",
    context: "Stable paths and acceptance criteria",
    task: "Re-review the fixes. Return terminal JSON verdict APPROVED_UNCONDITIONALLY, CHANGES_REQUIRED, or BLOCKED_EXTERNAL with inspected evidence."
  },
  sandboxMode: "read-only",
  approvalStrategy: "legacy"
})
```

Use exactly one of prompt or promptParts. Cache-state resources expose aggregate
hash and token evidence only; they do not prove a review verdict.

## Cross-LLM Requirements

This is a Codex gate. If the task requires a full cross-LLM review, call
provider_tool_capabilities through gtwy first, use the required roster from
Claude, Codex, Gemini, Grok, Mistral, Devin, and Cursor, and follow the
multi-llm-consensus workflow. Do not treat an unavailable required reviewer as a
successful Codex-only substitute.

## Final Checklist

- [ ] The request used the local gtwy stdio MCP tool, not a direct provider CLI.
- [ ] The target repository and paths were verified.
- [ ] The request used legacy approval and a current Codex sandbox mode.
- [ ] Findings, conditions, and verification gaps were all resolved.
- [ ] Codex returned explicit `APPROVED_UNCONDITIONALLY`.
- [ ] A terminal provider failure, if any, was reported as `BLOCKED_EXTERNAL`.
