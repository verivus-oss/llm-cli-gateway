---
name: codex-review-gate
description: Submit work to Codex for review and iterate until unconditional approval. Use after completing implementation tasks, before merging, or when a development process requires Codex sign-off.
---

# Codex Review Gate

Submit completed work to Codex via the llm-gateway for review. Iterate on feedback until you receive unconditional approval. This is the standard quality gate used across all VerivusAI projects.

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
  prompt: "Review the changes in [path]. This implements [feature/fix]. Check for: correctness, edge cases, test coverage, and adherence to project conventions. Give APPROVED or NOT APPROVED with specific findings.",
  fullAuto: true
})
```

If the task is large or complex, expect auto-deferral at 45s. When response contains `status:"deferred"`:

```
llm_job_status({jobId: "[from deferred response]"})
// Poll every 90 seconds until completed
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
  prompt: "Re-review after fixes. Previous findings:\n1. [issue] — Fixed by [what you did]\n2. [issue] — Fixed by [what you did]\n\nVerify the fixes are correct. APPROVED or NOT APPROVED.",
  fullAuto: true
})
```

### Step 4: Iterate

Repeat Steps 2-3 until you get unconditional APPROVED. Typical iterations:
- Simple tasks: 1 round (often approved first time)
- Medium tasks: 1-2 rounds
- Complex tasks: 2-3 rounds

If after 3 rounds Codex still has issues, escalate to the user.

## Sandbox Limitations

Codex runs in a sandboxed environment. It often cannot:
- Execute shell commands (bwrap errors)
- Read files via shell (sed, cat blocked)
- Run git commands

Codex CAN use:
- sqry MCP tools (semantic search, symbol lookup, code explanation)
- GitHub app connector (fetch files from GitHub repos)
- Web search

When Codex says "cannot verify because shell blocked," provide the evidence inline:
- Paste the actual file contents
- Paste the `npm pack --dry-run` output
- Paste the `npm test` results

This is NOT cheating — it's giving the reviewer the same information they'd get from shell access.

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

1. Wait 5 seconds after initial deferral
2. Poll `llm_job_status` every 90 seconds
3. When `status:"completed"`, fetch with `llm_job_result`
4. If still running after 10 minutes, consider canceling and re-scoping the review

## Tips

- Use `correlationId` to trace review rounds: `"review-round-1"`, `"review-round-2"`
- For large reviews, use `codex_request_async` explicitly to avoid any sync wait
- Codex is thorough but literal — it checks what you ask it to check. Be specific in review criteria.
- When Codex's sqry index is stale, it may report "cannot find X." Provide the file contents inline.
