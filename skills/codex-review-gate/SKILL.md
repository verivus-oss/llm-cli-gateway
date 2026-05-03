---
name: codex-review-gate
description: Submit work to Codex for review and iterate until unconditional approval. Use after completing implementation tasks, before merging, or when a development process requires Codex sign-off.
---

# Codex Review Gate

Submit completed work to Codex via the llm-gateway for review. Iterate on feedback until you receive unconditional approval. This is the standard quality gate used across all VerivusAI projects.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). For Codex, also pass `fullAuto:true`; this gives sandboxed autonomy while keeping the gateway approval gate in front of execution.
3. **No wallclock timeout; poll every 60 s** — `idleTimeoutMs` is a separate no-output safeguard.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch → parse verdict → on `NOT APPROVED` or conditional, fix + re-submit → repeat. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## When to Use

- After completing an implementation task
- Before merging or shipping
- When CLAUDE.md or a development process mandates "Codex review via llm gateway"
- When a plan says "iterate until unconditional approval"

## Protocol

### Step 1: Submit for Review

Use `codex_request` with a review prompt that includes:
- What was changed and why
- File paths (let Codex read them — never inline code)
- Specific review criteria if applicable

```
codex_request({
  prompt: "Review the changes in [path]. This implements [feature/fix]. Check for: correctness, edge cases, test coverage, and adherence to project conventions. End with APPROVED or NOT APPROVED with specific findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed"
})
```

**`fullAuto: true` is mandatory.** Without it, Codex runs in a restricted sandbox where it cannot read files, run commands, or use MCP tools. The review will fail with "cannot verify" errors. Always pass `fullAuto: true` and `approvalStrategy: "mcp_managed"` for review requests.

If the task is large or complex, expect auto-deferral at 45s. When response contains `status:"deferred"`:

```
llm_job_status({jobId: "[from deferred response]"})
// Poll every 60 seconds until completed (no wallclock timeout)
llm_job_result({jobId: "[jobId]"})
```

### Step 2: Parse the Verdict

Look for explicit **APPROVED** or **NOT APPROVED** in the response.

- **APPROVED** (unconditional, no caveats) → Gate passed. Proceed.
- **APPROVED with residual notes** → Gate passed if notes are informational only (e.g., "approved; residual: index was stale"). Proceed.
- **NOT APPROVED** → Fix the issues listed, then re-submit.
- **Cannot verify** (sandbox/access blocked) → Re-submit with evidence inline (file contents, command output).

### Step 3: Fix and Re-submit

When NOT APPROVED:
1. Read Codex's findings carefully — each is a specific, actionable issue
2. Fix every issue (not just the easy ones)
3. Verify fixes locally (build, test)
4. Re-submit with a focused prompt describing what was fixed

```
codex_request({
  prompt: "Re-review after fixes. Previous findings:\n1. [issue] — Fixed by [what you did]\n2. [issue] — Fixed by [what you did]\n\nVerify the fixes are correct. End with APPROVED or NOT APPROVED with findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed"
})
```

### Step 4: Iterate

Repeat Steps 2-3 until you get unconditional APPROVED. Typical iterations:
- Simple tasks: 1 round (often approved first time)
- Medium tasks: 1-2 rounds
- Complex tasks: 2-3 rounds

If after 3 rounds Codex still has issues, escalate to the user.

## Permissions — the Most Common Mistake

If Codex says "cannot verify" or you see `bwrap` sandbox errors, you almost certainly forgot `fullAuto: true`. Without it, Codex runs in a restricted sandbox that blocks file access, shell commands, and MCP tools.

With `fullAuto: true`, Codex gets sandboxed autonomous execution:
- Full file system read/write access in the workspace
- Shell command execution
- any MCP/tools configured for that Codex CLI environment

In the rare case where Codex genuinely cannot access something specific (e.g., needs credentials it doesn't have), provide the evidence inline:
- Paste the test output, build output, or file contents
- This gives the reviewer the same information it would get from running the commands itself

## Anti-Patterns

- **Don't skip the gate** because "it's a small change." Small changes break things.
- **Don't accept NOT APPROVED** and move on. Fix the issues.
- **Don't argue with Codex.** If the finding is wrong, verify locally and provide evidence.
- **Don't inline large code blocks.** Provide file paths. Codex can read via sqry/GitHub.
- **Don't submit without building/testing first.** Codex catches code issues, not "forgot to compile."

## Integration with Development Workflows

This skill is referenced by:
- trstr CLAUDE.md: "Every work product MUST include reviews and unconditional approvals from Codex via the llm MCP gateway"
- aivcs implementation plans: "Submit to Codex via llm-gateway for review. Iterate until approval."
- sqry review documents: Codex review requests with iteration tracking

## Polling Strategy for Deferred Jobs

When `codex_request` returns `status:"deferred"`:

1. Poll `llm_job_status` every 60 seconds using a **non-blocking** wait between polls (see below)
2. When `status:"completed"`, fetch with `llm_job_result`
3. Do **not** cancel running jobs for taking too long. Cancel only on explicit user instruction or hard failure (process dead, non-transient error such as exit 125/126)
4. `idleTimeoutMs` (no-output safeguard, default 10 min) remains active and will kill genuinely hung processes — this is separate from wallclock timeout

### Wait-between-polls (orchestrator-specific)

Standalone `sleep 60` is blocked in some orchestrators (e.g. the Claude Code harness rejects `Bash({command: "sleep 60"})` and also rejects chained short sleeps). Use a non-blocking equivalent:

- **Claude Code harness**: `Bash({command: "sleep 60 && echo done", run_in_background: true})` — emits a completion notification after 60s; poll then. `Monitor` is for streaming progress, not one-shot waits.
- **`ScheduleWakeup`** (if available in your orchestrator): schedule a wakeup with `delaySeconds: 60` and a prompt that resumes the polling loop.
- **Other orchestrators**: use the native non-blocking wait primitive. Treat the 60 s as "yield control, get notified," not "block the shell for 60 s."

## Tips

- Use `correlationId` to trace review rounds: `"review-round-1"`, `"review-round-2"`
- Omit `model` — let the gateway default apply
- For large reviews, use `codex_request_async` explicitly to avoid any sync wait
- Codex is thorough but literal — it checks what you ask it to check. Be specific in review criteria.
- When Codex's sqry index is stale, it may report "cannot find X." Provide the file contents inline.
