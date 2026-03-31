---
name: agent-codex-gate
description: Pattern for spawning subagents that must get Codex approval before their work is accepted. Use when dispatching parallel agents that each need independent Codex review gates.
---

# Agent + Codex Gate Pattern

Spawn subagents to do work, then each agent submits its work to Codex for review via the LLM gateway. Agents iterate on Codex feedback until they get unconditional approval. Work is not accepted until Codex approves.

## When to Use

- Dispatching multiple parallel agents to implement different tasks
- Any workflow where "spawn agents, let them work, gate on Codex approval" is the pattern
- When you want autonomous agents with quality gates
- Implementation plans with independent tasks

## Protocol

### For the Orchestrator (You)

1. **Spawn subagents** for each independent task
2. **Include these instructions** in each agent's prompt:

```
After completing your implementation:
1. Build and test to verify your changes work
2. Submit your work for Codex review via the llm MCP gateway:
   codex_request({
     prompt: "Review [description of what was done] in [paths]. APPROVED or NOT APPROVED with findings.",
     fullAuto: true
   })
3. If the response contains status:"deferred", poll llm_job_status every 90 seconds until completed, then fetch with llm_job_result
4. If NOT APPROVED: fix every issue Codex identified, then re-submit
5. Iterate until you get unconditional APPROVED from Codex
6. Report back with: what you did, Codex's final verdict, and the approval details
```

3. **Review each agent's report** — verify Codex approved, check the work makes sense
4. **Only accept work** that has Codex's unconditional approval

### For Each Subagent

The subagent follows this loop:

```
implement → build → test → submit to Codex →
  if APPROVED: done, report back
  if NOT APPROVED: fix issues → rebuild → retest → resubmit to Codex
  if deferred: poll every 90s → get result → parse verdict
```

### Handling Deferred Reviews

Codex reviews often exceed 45s. Subagents must handle deferral:

```
// Submit review
result = codex_request({prompt: "Review...", fullAuto: true})

// Check if deferred
if result contains "status":"deferred":
  jobId = result.jobId
  // Poll every 90 seconds
  loop:
    wait 90 seconds
    status = llm_job_status({jobId})
    if status.completed: break
  // Get the review
  review = llm_job_result({jobId})
  // Parse APPROVED or NOT APPROVED from review.stdout
```

### Permissions — The Most Common Mistake

If Codex says "cannot verify" or shows `bwrap` sandbox errors, `fullAuto: true` was not passed. Without it, Codex cannot read files, run commands, or use MCP tools. **Always include `fullAuto: true` in every `codex_request` for reviews.**

In the rare case Codex genuinely cannot access something (needs credentials it doesn't have), provide the evidence inline:
- Paste build output, test results, or file contents
- Re-submit with this evidence alongside `fullAuto: true`

## Example: Parallel Implementation with Gates

```
// Orchestrator dispatches 3 agents in parallel:

Agent 1: "Implement Task A in src/feature-a.ts. [full task spec]
After completing, get Codex review. Iterate until unconditional approval."

Agent 2: "Implement Task B in src/feature-b.ts. [full task spec]
After completing, get Codex review. Iterate until unconditional approval."

Agent 3: "Implement Task C in src/feature-c.ts. [full task spec]
After completing, get Codex review. Iterate until unconditional approval."

// Each agent works independently, gets own Codex review
// Orchestrator collects results only after all three have Codex approval
```

## Escalation

- Agent can't get Codex approval after 3 rounds → escalate to orchestrator
- Codex consistently unreachable → report the error, don't skip the gate
- Codex findings are wrong → provide evidence and re-submit, don't ignore

## Quality Checklist

Before accepting an agent's work:
- [ ] Agent reports Codex gave unconditional APPROVED
- [ ] Agent addressed all findings from earlier rounds (if any)
- [ ] Build passes
- [ ] Tests pass
- [ ] Changes match the original task specification

## Tips

- Always include `fullAuto: true` for Codex — it needs tool access to review
- Use `correlationId` per agent per round: `"agent1-review-r1"`, `"agent1-review-r2"`
- For large tasks, expect 2-3 review rounds
- Don't let agents skip the Codex gate because "it's a small change"
- If an agent reports "Codex approved with residual notes" — that counts as approved if the notes are informational only
