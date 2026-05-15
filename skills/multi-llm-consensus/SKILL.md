---
name: multi-llm-consensus
description: Run a task through multiple LLMs (Claude, Codex, Gemini, Grok) independently and require agreement before proceeding. Use for high-stakes generation, conflict resolution, or final quality gates requiring unanimous approval.
---

# Multi-LLM Consensus

When correctness matters more than speed, send the same task to Claude, Codex, Gemini, and (optionally) Grok independently, then compare results. All agents must agree before proceeding. Adding Grok gives an independent fourth model from a different vendor (xAI) — useful when consensus needs diversity to defend against shared-blind-spot failures across the OpenAI/Google/Anthropic family.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). For Codex, also pass `fullAuto:true` when it needs file/shell access.
3. **No wallclock timeout; poll every 60 s** — `idleTimeoutMs` is a separate no-output safeguard.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." Consensus requires **all** reviewers to return unconditional APPROVED; any `NOT APPROVED` or conditional approval from any reviewer triggers the fix-and-re-review loop to all reviewers. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## When to Use

- Generating code that will run in production without human review
- Resolving ambiguous specification decisions
- Final quality gates requiring unanimous sign-off
- Any task where a single LLM's blind spot could cause harm

## Consensus Patterns

### Pattern 1: Independent Generation + Comparison

Each LLM generates a solution independently. Compare outputs structurally.

```
claude_request_async({
  prompt: "Given this specification:\n[spec]\n\nGenerate the implementation. Output only code.",
  approvalStrategy: "mcp_managed",
  correlationId: "gen-claude"
})
codex_request_async({
  prompt: "Given this specification:\n[spec]\n\nGenerate the implementation. Output only code.",
  fullAuto: true,
  approvalStrategy: "mcp_managed",
  correlationId: "gen-codex"
})
gemini_request_async({
  prompt: "Given this specification:\n[spec]\n\nGenerate the implementation. Output only code.",
  approvalStrategy: "mcp_managed",
  correlationId: "gen-gemini"
})
grok_request_async({
  prompt: "Given this specification:\n[spec]\n\nGenerate the implementation. Output only code.",
  approvalStrategy: "mcp_managed",
  correlationId: "gen-grok"
})
```

Poll all four. When complete, compare:
- If all four agree → very high confidence, proceed
- If three agree, one differs → investigate the outlier (often a real edge case the majority missed)
- If split 2-2 → escalate; the spec is ambiguous, clarify before proceeding
- If all four differ → spec is fundamentally underspecified

### Pattern 2: Unanimous Approval Gate

All three LLMs must approve the same artifact. Used for final review gates.

```
claude_request_async({
  prompt: "Review [path] for: grammar correctness, extraction completeness, test coverage, performance, security. End with APPROVED or NOT APPROVED with findings.",
  approvalStrategy: "mcp_managed",
  correlationId: "review-claude"
})
codex_request_async({
  prompt: "Review [path] for: grammar correctness, extraction completeness, test coverage, performance, security. End with APPROVED or NOT APPROVED with findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed",
  correlationId: "review-codex"
})
gemini_request_async({
  prompt: "Review [path] for: grammar correctness, extraction completeness, test coverage, performance, security. End with APPROVED or NOT APPROVED with findings.",
  approvalStrategy: "mcp_managed",
  correlationId: "review-gemini"
})
grok_request_async({
  prompt: "Review [path] for: grammar correctness, extraction completeness, test coverage, performance, security. End with APPROVED or NOT APPROVED with findings.",
  approvalStrategy: "mcp_managed",
  correlationId: "review-grok"
})
```

**Verdict rules:**
- All reviewers APPROVED → gate passes
- Any NOT APPROVED → fix issues, re-submit to **all** reviewers (not just the one that rejected)
- Any unable to review → provide evidence, re-submit to that reviewer

### Pattern 3: Conflict Resolution

Multiple valid approaches exist. Each LLM proposes independently, then a designated LLM synthesizes.

1. All three propose solutions (async, parallel)
2. Collect all proposals
3. Send all proposals to Claude for synthesis:

```
claude_request({
  prompt: "Three LLMs proposed solutions for [problem]:\n\nClaude's proposal: [proposal]\nCodex's proposal: [proposal]\nGemini's proposal: [proposal]\n\nSynthesize the best approach, explaining why. If they agree, confirm. If they conflict, choose the strongest with justification.",
  approvalStrategy: "mcp_managed"
})
```

## Execution Flow

### Parallel Dispatch

Always use async tools for consensus — you need all results before deciding:

```
// Fire all four (each with approvalStrategy:"mcp_managed"; Codex also fullAuto:true)
job1 = claude_request_async({...})
job2 = codex_request_async({...})
job3 = gemini_request_async({...})
job4 = grok_request_async({...})

// Poll every 60 seconds (no wallclock timeout; cancel only on explicit instruction or hard failure)
llm_job_status({jobId: job1.job.id})
llm_job_status({jobId: job2.job.id})
llm_job_status({jobId: job3.job.id})
llm_job_status({jobId: job4.job.id})

// Collect results when all complete
result1 = llm_job_result({jobId: job1.job.id})
result2 = llm_job_result({jobId: job2.job.id})
result3 = llm_job_result({jobId: job3.job.id})
result4 = llm_job_result({jobId: job4.job.id})
```

Results are durable (default 30 days). If your polling wrapper dies, re-issue the same `*_request_async` calls — auto-dedup snaps each new call back onto the live job. Use `forceRefresh:true` only if you've genuinely changed the inputs.

### Comparison

Compare results structurally, not textually. Two implementations may look different but be functionally equivalent.

For code generation:
- Same algorithm/approach → agreement
- Different approach, same output → agreement (note the alternatives)
- Different output → disagreement (investigate)

For reviews:
- All APPROVED → pass
- Same issues found → agreement on problems
- Different issues found → union of all issues (review each)

## LLM Strengths in Consensus

| LLM | Generation Strength | Review Strength |
|-----|-------------------|-----------------|
| Claude | Architecture, patterns, documentation | Design quality, maintainability |
| Codex | Implementation correctness, algorithms | Logic bugs, edge cases, test gaps |
| Gemini | Security-aware generation, edge cases | Security audit, OWASP, crash cases |
| Grok (xAI) | Independent perspective from a different vendor family | Tie-breaker / diversity reviewer when the other three converge on a blind spot |

## Model Selection

Dispatch default: **omit `model` on every call**. The gateway's configured default per CLI is the right choice in the vast majority of cases. Only nominate a model when the caller explicitly named a specific variant in the current turn.

Avoid stale hardcoded model IDs such as `o3`, `o3-pro`, and `gpt-4o`; omit `model` or call `list_models` instead.

## Tips

- Use `correlationId` to group consensus rounds: `"consensus-r1-claude"`, `"consensus-r1-codex"`, `"consensus-r1-gemini"`, `"consensus-r1-grok"`
- For Codex: real continuity is available via `resumeLatest:true` or `sessionId:<UUID>` (the UUID from `~/.codex/sessions/`); otherwise re-state context inline
- For Gemini and Grok reviews: pass `sessionId` for resumable follow-up rounds
- If one LLM is unavailable, proceed with the rest but note the gap
- Consensus is expensive (3–4x tokens). Use it for high-stakes decisions, not routine tasks.
- When re-submitting after fixes, re-submit to ALL reviewers (not just the one that rejected)
- **Durable results**: deferred consensus jobs persist (default 30 days, `LLM_GATEWAY_JOB_RETENTION_DAYS`). If the orchestrator dies mid-round, re-issue the same calls — auto-dedup reattaches to the running jobs and you don't restart the consensus round.
