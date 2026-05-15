---
name: implement-review-fix
description: Run implement-review-fix cycle using multiple LLMs (Claude, Codex, Gemini, Grok). Use for features, bugs, or refactoring with multi-LLM collaboration.
metadata:
  author: verivusai-labs
  version: "1.5"
---

# Implement-Review-Fix Cycle

Structured workflow: multiple LLMs implement, review, iterate until quality met.

## Cycle

```
1. Implement (Codex) → 2. Review (Claude+Gemini) → 3. Fix (Codex) → 4. Verify
   └──────────────── loop until unconditional APPROVED ────────────────┘
```

Single-level orchestration only — parent agent coordinates all steps. Child LLMs cannot call other LLMs through gateway.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches. Use `list_models` only if the caller has asked for a specific variant.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution; Claude then runs with `--permission-mode bypassPermissions`, Gemini with `--approval-mode yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work. Prefer this over raw bypass flags.
3. **No wallclock timeout; poll every 60 s** — let sync auto-defer at 45 s or use `*_request_async`. Poll `llm_job_status` once every 60 seconds. Do **not** cancel jobs for taking too long; cancel only on explicit instruction or hard failure. `idleTimeoutMs` (no-output safeguard) is separate.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review/re-review dispatch is a loop. End every review prompt with "End with APPROVED or NOT APPROVED with findings." On `NOT APPROVED` or conditional approval, consolidate findings, dispatch fixes (Codex + `fullAuto:true`), re-dispatch the review to the **same reviewer**. Repeat until unconditional APPROVED. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches. (The implementation step in Step 1 is not itself a review; the loop is driven by the reviewer verdict in Step 2 / Step 4.)

## Session Continuity

| CLI | Effect | Mechanism |
|-----|--------|-----------|
| **Claude** | Real continuity | `--session-id` or `--continue` passed to CLI |
| **Codex** | Real continuity | `codex exec resume <UUID>` (`sessionId`) or `codex exec resume --last` (`resumeLatest:true`). `sessionId` must be a real Codex session UUID from `~/.codex/sessions/`; gateway-generated `gw-*` IDs are rejected |
| **Gemini** | Real continuity | `--resume` passed to CLI |
| **Grok** | Real continuity | `--resume` / `--continue` passed to CLI |

For Codex resumption: pass the UUID printed by `codex resume` / visible under `~/.codex/sessions/`, **or** pass `resumeLatest:true` to use the most recent session in cwd. Note: `--full-auto` is silently dropped on resume — Codex inherits the original session's approval policy.

## Step 1: Implement

```
codex_request({prompt:"Implement [feature]. Requirements:\n- [req 1]\n- [req 2]\n\nWrite code in [path]. Include tests.",fullAuto:true,approvalStrategy:"mcp_managed",optimizePrompt:true})
```

## Step 2: Review

Send to reviewers in parallel. Reviewers **must have tool access** to read files and verify claims — never use `allowedTools:[]` or include tool-suppression language in review prompts. `mcp_managed` removes Claude/Gemini approval prompts; Codex also requires `fullAuto:true`.

**Claude — Quality:**
```
claude_request({prompt:"Review changes in [path]. Read the files directly. Check:\n- Code quality/maintainability\n- Project conventions\n- Error handling\n- Documentation gaps\nList issues with severity and fixes. End with APPROVED or NOT APPROVED with findings.",allowedTools:["Read","Grep","Glob"],approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

**Gemini — Bugs/Security:**
```
gemini_request({prompt:"Analyze [path] for bugs, edge cases, security issues. Read the files directly. Check test coverage. Rate: critical/high/medium/low. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

**Grok — Optional 4th Reviewer (Diversity / Consensus):**
```
grok_request({prompt:"Independent review of [path]. Flag issues the other reviewers may have missed; contradict findings you disagree with. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

Add Grok when consensus matters (high-stakes paths) or to break ties. Auth must already be set up (`grok login` or `GROK_CODE_XAI_API_KEY`).

Sync tools auto-defer at 45s — if response contains `status:"deferred"`, poll `jobId` via `llm_job_status` every 60s, fetch with `llm_job_result`. Results are durable (default 30 days) — if your polling wrapper times out, fetch by `jobId` later or re-issue the identical call (auto-dedup reattaches to the live job).

## Step 3: Fix

Consolidate findings, send to Codex. Re-state context (no CLI continuity):

```
codex_request({prompt:"Fix issues in [path]:\n\n1. [Critical] [desc]\n2. [High] [desc]\n3. [Medium] [desc]\n\nApply fixes and update tests.",fullAuto:true,approvalStrategy:"mcp_managed",optimizePrompt:true})
```

## Step 4: Verify (re-review)

Re-dispatch the **same reviewers** from Step 2 with fix context:

```
claude_request({prompt:"Re-review [path] after fixes. Previous findings:\n1. [issue 1] — Fixed by: [what changed]\n2. [issue 2] — Fixed by: [what changed]\n\nConfirm each fix or flag remaining issues. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

## Iteration (mandatory)

- Any `NOT APPROVED` or conditional approval → back to Step 3 → Step 4
- "APPROVED with residual notes" counts as approved only if notes are purely informational
- Max 3 iterations before escalating to the user (but continue iterating until then)
- All reviewers must return unconditional APPROVED before the cycle ends

## Long-Running Tasks

Sync tools auto-defer if execution exceeds 45s deadline. Response contains `status:"deferred"` with `jobId` — poll with `llm_job_status`, fetch with `llm_job_result`. No manual sync/async choice needed.

For explicit non-blocking (fire-and-forget, parallel jobs):

```
codex_request_async({prompt:"...",fullAuto:true,approvalStrategy:"mcp_managed"})
```

### Parallel Async Reviews (up to 4 CLIs)

```
codex_request_async({prompt:"Implement [feature]...",fullAuto:true,approvalStrategy:"mcp_managed",correlationId:"impl"})
// Poll every 60s until completed...

claude_request_async({prompt:"Review [path] for quality... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-quality"})
codex_request_async({prompt:"Check [path] for logic bugs... End with APPROVED or NOT APPROVED with findings.",fullAuto:true,approvalStrategy:"mcp_managed",correlationId:"review-bugs"})
gemini_request_async({prompt:"Security audit [path]... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-security"})
grok_request_async({prompt:"Independent review of [path]... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-grok"})
// Poll every 60s, collect, synthesize, fix, re-review — until all APPROVED
```

## Tips

- Consolidate findings before sending fixes (avoid redundant work)
- Use `correlationId` to trace full cycle
- For security-sensitive code: raise to `approvalPolicy:"strict"` (on top of default `mcp_managed`)
- Keep implementation prompts specific — file paths, function names, acceptance criteria
- For Codex fixes: either pass `resumeLatest:true` (or the session UUID) to carry conversation context, **or** re-state problem context inline if running fresh
- Never pass Gemini `gw-*` session IDs — use your own Gemini IDs for resumable workflows
- Check for `status:"deferred"` in sync responses — poll `jobId` every 60s if present
- **Durable results**: deferred jobs persist for 30 days (`LLM_GATEWAY_JOB_RETENTION_DAYS`). If the cycle is interrupted, re-issue identical calls (auto-dedup snaps onto the live job) or fetch by `jobId` later. Use `forceRefresh:true` only when inputs have actually changed
