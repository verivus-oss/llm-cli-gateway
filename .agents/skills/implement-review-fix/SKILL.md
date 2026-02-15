---
name: implement-review-fix
description: Run the full implement-review-fix cycle using multiple LLMs via the llm-cli-gateway. Use when building features, fixing bugs, or refactoring code that benefits from multi-LLM collaboration.
metadata:
  author: verivusai-labs
  version: "1.1"
---

# Implement-Review-Fix Cycle

A structured workflow for using multiple LLMs to implement code, review it, and iterate until quality is met.

## The Cycle

```
1. Implement (Codex) → 2. Review (Claude + Gemini) → 3. Fix (Codex) → 4. Verify
```

Only single-level orchestration is supported — you (the parent agent) coordinate all steps. LLMs called via the gateway cannot call other LLMs through it.

## Session Continuity — Important

The gateway tracks sessions as metadata (id, cli, timestamps). How sessions affect CLI behavior differs per tool:

- **Claude**: Real CLI continuity. Passing `sessionId` adds `--session-id` or `--continue` to the Claude CLI, resuming conversation context.
- **Codex**: Gateway bookkeeping only. The `sessionId` is tracked in the gateway but does NOT resume a Codex CLI conversation. Each `codex_request` is a fresh CLI invocation.
- **Gemini**: Real CLI continuity via `--resume`. Passing `sessionId` or `resumeLatest: true` resumes the Gemini CLI session.

For Codex, include all necessary context in the prompt itself — do not rely on session continuity.

## Step 1: Implement

Use Codex for implementation. It works in a sandboxed environment and can make file changes.

```
codex_request({
  prompt: "Implement [feature description]. Requirements:\n- [req 1]\n- [req 2]\n\nWrite the code in [file path]. Include tests.",
  fullAuto: true,
  optimizePrompt: true
})
```

- Use `fullAuto: true` for automated file changes
- The response includes a gateway `sessionId` for tracking purposes

## Step 2: Review

Send the implementation to reviewers in parallel. Do NOT pass the code manually — let each LLM read the files directly.

**Claude — Quality Review:**
```
claude_request({
  prompt: "Review the changes in [file path]. Check for:\n- Code quality and maintainability\n- Adherence to project conventions\n- Missing error handling\n- Documentation gaps\nList issues with severity and suggested fixes.",
  optimizePrompt: true,
  optimizeResponse: true
})
```

**Gemini — Bug Finding:**
```
gemini_request({
  prompt: "Analyze the implementation in [file path] for bugs, edge cases, and security issues. Check that tests cover the critical paths. Rate each finding: critical/high/medium/low.",
  model: "gemini-2.5-pro",
  optimizePrompt: true,
  optimizeResponse: true
})
```

## Step 3: Fix

Consolidate review findings and send fixes to Codex. Since Codex does not maintain CLI session context, include all relevant context in the prompt:

```
codex_request({
  prompt: "Fix the following issues found during code review of [file path]:\n\n1. [Critical] [description]\n2. [High] [description]\n3. [Medium] [description]\n\nThe original implementation is in [file path]. Apply fixes and update tests.",
  fullAuto: true,
  optimizePrompt: true
})
```

## Step 4: Verify

Run a final check to confirm fixes are correct:

```
claude_request({
  prompt: "Verify that these review findings have been properly addressed in [file path]:\n\n1. [issue 1] — expected fix: [description]\n2. [issue 2] — expected fix: [description]\n\nConfirm each fix or flag remaining issues.",
  optimizePrompt: true,
  optimizeResponse: true
})
```

## When to Iterate

- If Step 4 finds remaining issues, go back to Step 3
- Limit to 3 iterations maximum to avoid diminishing returns
- If issues persist after 3 rounds, escalate to the user

## For Long-Running Implementations

If the implementation step may take more than 2 minutes (sync timeout is 120s):

```
codex_request_async({
  prompt: "...",
  fullAuto: true
})
```

Poll with `llm_job_status({ jobId })` and retrieve with `llm_job_result({ jobId })` when complete. See the `async-job-orchestration` skill for details.

## Tips

- Always consolidate review findings before sending fixes (avoids redundant work)
- Use `correlationId` to trace the full cycle in logs
- For security-sensitive code, use `approvalStrategy: "mcp_managed"` with `approvalPolicy: "strict"`
- Keep implementation prompts specific — include file paths, function names, and acceptance criteria
- For Codex fix steps, re-state the problem context since it does not carry over from previous calls
- After the cycle, clean up sessions with `session_delete` if no longer needed
