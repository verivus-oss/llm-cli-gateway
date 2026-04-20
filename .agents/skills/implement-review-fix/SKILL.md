---
name: implement-review-fix
description: Run implement-review-fix cycle using multiple LLMs. Use for features, bugs, or refactoring with multi-LLM collaboration.
metadata:
  author: verivusai-labs
  version: "1.3"
---

# Implement-Review-Fix Cycle

Structured workflow: multiple LLMs implement, review, iterate until quality met.

## Cycle

```
1. Implement (Codex) → 2. Review (Claude+Gemini) → 3. Fix (Codex) → 4. Verify
```

Single-level orchestration only — parent agent coordinates all steps. Child LLMs cannot call other LLMs through gateway.

## Session Continuity

| CLI | Effect | Mechanism |
|-----|--------|-----------|
| **Claude** | Real continuity | `--session-id` or `--continue` passed to CLI |
| **Codex** | Bookkeeping only | `sessionId` tracked, NOT passed to CLI. Each call is fresh |
| **Gemini** | Real continuity | `--resume` passed to CLI |

For Codex: include all context in prompt — no session continuity.

## Step 1: Implement

```
codex_request({prompt:"Implement [feature]. Requirements:\n- [req 1]\n- [req 2]\n\nWrite code in [path]. Include tests.",fullAuto:true,optimizePrompt:true})
```

## Step 2: Review

Send to reviewers in parallel. Reviewers **must have tool access** to read files and verify claims — never use `allowedTools:[]` or include tool-suppression language in review prompts.

**Claude — Quality:**
```
claude_request({prompt:"Review changes in [path]. Read the files directly. Check:\n- Code quality/maintainability\n- Project conventions\n- Error handling\n- Documentation gaps\nList issues with severity and fixes.",allowedTools:["Read","Grep","Glob"],optimizePrompt:true,optimizeResponse:true})
```

**Gemini — Bugs/Security:**
```
gemini_request({prompt:"Analyze [path] for bugs, edge cases, security issues. Read the files directly. Check test coverage. Rate: critical/high/medium/low.",allowedTools:["Read","Grep","Glob"],model:"gemini-2.5-pro",optimizePrompt:true,optimizeResponse:true})
```

Sync tools auto-defer at 45s — if response contains `status:"deferred"`, poll `jobId` via `llm_job_status`/`llm_job_result`.

## Step 3: Fix

Consolidate findings, send to Codex. Re-state context (no CLI continuity):

```
codex_request({prompt:"Fix issues in [path]:\n\n1. [Critical] [desc]\n2. [High] [desc]\n3. [Medium] [desc]\n\nApply fixes and update tests.",fullAuto:true,optimizePrompt:true})
```

## Step 4: Verify

```
claude_request({prompt:"Verify fixes in [path]:\n\n1. [issue 1] — expected: [fix]\n2. [issue 2] — expected: [fix]\n\nConfirm each or flag remaining.",optimizePrompt:true,optimizeResponse:true})
```

## Iteration

- Issues remain → back to Step 3
- Max 3 iterations (diminishing returns)
- Issues persist after 3 rounds → escalate to user

## Long-Running Tasks

Sync tools auto-defer if execution exceeds 45s deadline. Response contains `status:"deferred"` with `jobId` — poll with `llm_job_status`, fetch with `llm_job_result`. No manual sync/async choice needed.

For explicit non-blocking (fire-and-forget, parallel jobs):

```
codex_request_async({prompt:"...",fullAuto:true})
```

### Parallel Async Reviews (All 3 CLIs)

```
codex_request_async({prompt:"Implement [feature]...",fullAuto:true,correlationId:"impl"})
// Wait for completion...

claude_request_async({prompt:"Review [path] for quality...",correlationId:"review-quality"})
codex_request_async({prompt:"Check [path] for logic bugs...",correlationId:"review-bugs"})
gemini_request_async({prompt:"Security audit [path]...",model:"gemini-2.5-pro",correlationId:"review-security"})
// Poll all three, collect, synthesize, fix
```

## Tips

- Consolidate findings before sending fixes (avoid redundant work)
- Use `correlationId` to trace full cycle
- For security-sensitive code: `approvalStrategy:"mcp_managed"`, `approvalPolicy:"strict"`
- Keep implementation prompts specific — file paths, function names, acceptance criteria
- For Codex fixes: re-state problem context (no carry-over)
- Never pass `gw-*` session IDs — use own IDs for resumable workflows
- Check for `status:"deferred"` in sync responses — poll `jobId` if present
