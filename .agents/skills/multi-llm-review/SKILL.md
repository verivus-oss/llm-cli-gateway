---
name: multi-llm-review
description: Parallel code reviews across Claude, Codex, Gemini, and Grok. Use for quality analysis, bug finding, or security audit.
metadata:
  author: verivusai-labs
  version: "1.5"
---

# Multi-LLM Code Review

Parallel reviews using gateway MCP tools. Each LLM has different strengths — combine for comprehensive coverage.

## LLM Strengths

| LLM | Best For | Sync | Async |
|-----|----------|------|-------|
| Claude | Architecture, design, quality, docs | `claude_request` | `claude_request_async` |
| Codex | Implementation correctness, logic bugs, tests | `codex_request` | `codex_request_async` |
| Gemini | Security, edge cases, multimodal context | `gemini_request` | `gemini_request_async` |
| Grok (xAI) | Independent fourth perspective for diversity / consensus tie-breaks | `grok_request` | `grok_request_async` |

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches. Call `list_models` only when the caller has asked for a specific variant.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution; Claude then runs with `--permission-mode bypassPermissions`, Gemini with `--approval-mode yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work. Prefer this over raw bypass flags.
3. **No wallclock timeout; poll every 60 s** — let sync auto-defer at 45 s or use `*_request_async`. Poll `llm_job_status` once every 60 seconds. Do **not** cancel jobs for taking too long; cancel only on explicit instruction or hard failure. `idleTimeoutMs` (no-output safeguard) is separate.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." On `NOT APPROVED` or conditional approval, consolidate findings, dispatch fixes (Codex + `fullAuto:true`), re-dispatch the review to the same reviewer. Repeat until unconditional APPROVED. Escalate after 3 rounds without convergence. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Workflow

### 1. Discover Models (optional)

Only when the caller has asked for a specific variant:

```
list_models()
```

Otherwise omit `model` and proceed.

### 2. Send Parallel Reviews

Sync tools auto-defer at 45s — if response contains `status:"deferred"`, poll `jobId` via `llm_job_status` every 60s, fetch with `llm_job_result`.

**Claude — Quality & Architecture:**
```
claude_request({prompt:"Review changes in {path} for architecture, design patterns, maintainability, documentation gaps. Read the files directly. Specific line numbers and fixes. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

**Codex — Logic & Correctness:**
```
codex_request({prompt:"Analyze {path} for logic bugs, off-by-one, missing error handling, race conditions, test gaps. Read the files directly. Severity: critical/high/medium/low. End with APPROVED or NOT APPROVED with findings.",fullAuto:true,approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

**Gemini — Security & Edge Cases:**
```
gemini_request({prompt:"Security audit {path}: injection, auth bypasses, data leaks, OWASP Top 10, crash-causing edge cases. Read the files directly. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

**Grok — Independent Diversity (optional 4th reviewer):**
```
grok_request({prompt:"Independent review of {path}. Read the files directly. Flag issues the other reviewers may have missed, contradict findings you disagree with, and call out blind spots. End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,optimizeResponse:true})
```

Add Grok when consensus matters (high-stakes changes, security-critical paths) or to break ties between the other three. Auth must already be set up (`grok login` OAuth or `GROK_CODE_XAI_API_KEY`).

### 3. Synthesize

1. **Deduplicate** — Remove findings from multiple LLMs
2. **Prioritize** — critical > high > medium > low
3. **Cross-validate** — Unique findings from one LLM → verify
4. **Categorize** — Security, Correctness, Performance, Maintainability

### 4. Consolidated Report

```markdown
## Code Review Summary
### Critical (must fix)
- [Issue] — found by [LLM], severity: critical
### High Priority
- ...
### Medium Priority
- ...
### Suggestions
- ...
### Positive Observations
- ...
```

## Large Codebases

Use async for parallel execution:

```
claude_request_async({prompt:"Review all TS files in src/ for architecture/quality... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",optimizePrompt:true,correlationId:"review-quality"})
codex_request_async({prompt:"Check all TS files in src/ for logic bugs/test gaps... End with APPROVED or NOT APPROVED with findings.",fullAuto:true,approvalStrategy:"mcp_managed",optimizePrompt:true,correlationId:"review-bugs"})
gemini_request_async({prompt:"Security audit all TS files in src/... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-security"})
grok_request_async({prompt:"Independent diversity review of all TS files in src/... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-grok"})
```

Poll with `llm_job_status` every 60s, retrieve with `llm_job_result` when terminal. Jobs are durable — if your polling wrapper times out, re-issue the same call (the gateway auto-dedups onto the live job) or fetch by `jobId` later (default 30-day retention).

For iterative Gemini reviews, pass `sessionId` for resumability:

```
gemini_request_async({prompt:"Deep security audit of src/... End with APPROVED or NOT APPROVED with findings.",sessionId:"gemini-security-review",approvalStrategy:"mcp_managed"})
// Response: resumable:true
```

## Anti-Patterns

These patterns undermine review quality and trigger review integrity warnings:

- **Don't inline code in `<code>` blocks** — provide file paths and let reviewers read files directly
- **Don't suppress tools** — never include "do not run tools" or "respond only based on code provided" in review prompts
- **Don't use `allowedTools:[]`** for reviews — reviewers need at minimum `["Read", "Grep", "Glob"]` to verify claims
- **Do provide file paths** — `"Review changes in src/auth.ts"` instead of dumping file contents

## Iteration Loop (mandatory)

Reviews are not one-shot. The caller runs this loop:

1. Dispatch reviewer(s) with the verdict clause in the prompt
2. Poll every 60s if deferred; fetch result
3. Parse verdict from each reviewer — APPROVED / NOT APPROVED / conditional
4. **Any NOT APPROVED or conditional** → consolidate findings → dispatch fixes (Codex + `fullAuto:true`) → re-dispatch same review → goto 2
5. **All APPROVED (unconditional)** → done
6. After 3 rounds without convergence, escalate to the user

"APPROVED with residual notes" counts as approved only if notes are purely informational.

## Tips

- Always use `optimizePrompt:true` and `optimizeResponse:true`
- Use sessions for iterative reviews (review → fix → re-review). Claude/Gemini/Grok carry real CLI continuity; Codex is bookkeeping only
- For security-sensitive: `approvalPolicy:"strict"` (in addition to default `mcp_managed`)
- Include file paths and line numbers for actionable feedback
- If CLI unavailable, skip gracefully and note gap
- Use all four async variants for true parallel reviews when you want Grok's independent perspective
- Pass `sessionId` to `gemini_request_async` / `grok_request_async` for resumable follow-up
- Check for `status:"deferred"` in sync responses — poll `jobId` every 60s if present
- Gateway `mcpServers` default to `["sqry"]`; add `exa`, `ref_tools`, or `trstr` only when the review needs those capabilities
- **Re-issuing after a polling timeout is safe** — auto-dedup (default 1 h window, `LLM_GATEWAY_DEDUP_WINDOW_MS`) reattaches the new call to the existing job. Use `forceRefresh:true` only when inputs genuinely changed
