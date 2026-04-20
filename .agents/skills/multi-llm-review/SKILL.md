---
name: multi-llm-review
description: Parallel code reviews across Claude, Codex, Gemini. Use for quality analysis, bug finding, or security audit.
metadata:
  author: verivusai-labs
  version: "1.3"
---

# Multi-LLM Code Review

Parallel reviews using gateway MCP tools. Each LLM has different strengths — combine for comprehensive coverage.

## LLM Strengths

| LLM | Best For | Sync | Async |
|-----|----------|------|-------|
| Claude | Architecture, design, quality, docs | `claude_request` | `claude_request_async` |
| Codex | Implementation correctness, logic bugs, tests | `codex_request` | `codex_request_async` |
| Gemini | Security, edge cases, multimodal context | `gemini_request` | `gemini_request_async` |

## Workflow

### 1. Discover Models

```
list_models()
```

### 2. Send Parallel Reviews

Sync tools auto-defer at 45s — if response contains `status:"deferred"`, poll `jobId` via `llm_job_status`/`llm_job_result`.

**Claude — Quality & Architecture:**
```
claude_request({prompt:"Review changes in {path} for architecture, design patterns, maintainability, documentation gaps. Read the files directly. Specific line numbers and fixes.",optimizePrompt:true,optimizeResponse:true})
```

**Codex — Logic & Correctness:**
```
codex_request({prompt:"Analyze {path} for logic bugs, off-by-one, missing error handling, race conditions, test gaps. Read the files directly. Severity: critical/high/medium/low.",optimizePrompt:true,optimizeResponse:true})
```

**Gemini — Security & Edge Cases:**
```
gemini_request({prompt:"Security audit {path}: injection, auth bypasses, data leaks, OWASP Top 10, crash-causing edge cases. Read the files directly.",model:"gemini-2.5-pro",optimizePrompt:true,optimizeResponse:true})
```

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
claude_request_async({prompt:"Review all TS files in src/ for architecture/quality...",optimizePrompt:true,correlationId:"review-quality"})
codex_request_async({prompt:"Check all TS files in src/ for logic bugs/test gaps...",optimizePrompt:true,correlationId:"review-bugs"})
gemini_request_async({prompt:"Security audit all TS files in src/...",model:"gemini-2.5-pro",correlationId:"review-security"})
```

Poll with `llm_job_status`, retrieve with `llm_job_result`.

For iterative Gemini reviews, pass `sessionId` for resumability:

```
gemini_request_async({prompt:"Deep security audit of src/...",sessionId:"gemini-security-review",model:"gemini-2.5-pro"})
// Response: resumable:true
```

## Anti-Patterns

These patterns undermine review quality and trigger review integrity warnings:

- **Don't inline code in `<code>` blocks** — provide file paths and let reviewers read files directly
- **Don't suppress tools** — never include "do not run tools" or "respond only based on code provided" in review prompts
- **Don't use `allowedTools:[]`** for reviews — reviewers need at minimum `["Read", "Grep", "Glob"]` to verify claims
- **Do provide file paths** — `"Review changes in src/auth.ts"` instead of dumping file contents

## Tips

- Always use `optimizePrompt:true` and `optimizeResponse:true`
- Use sessions for iterative reviews (review → fix → re-review)
- For security-sensitive: `approvalStrategy:"mcp_managed"`, `approvalPolicy:"strict"`
- Include file paths and line numbers for actionable feedback
- If CLI unavailable, skip gracefully and note gap
- Use all three async variants for true parallel reviews
- Pass `sessionId` to `gemini_request_async` for resumable follow-up
- Check for `status:"deferred"` in sync responses — poll `jobId` if present
