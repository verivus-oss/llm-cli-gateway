---
name: multi-llm-review
description: Orchestrate parallel code reviews across Claude, Codex, and Gemini via the llm-cli-gateway MCP. Use when the user asks for code review, quality analysis, bug finding, or security audit across multiple LLMs.
metadata:
  author: verivusai-labs
  version: "1.2"
---

# Multi-LLM Code Review

Orchestrate parallel code reviews using the llm-cli-gateway MCP tools. Each LLM has different strengths — use them together for comprehensive coverage.

## LLM Strengths

| LLM | Best For | Sync Tool | Async Tool |
|-----|----------|-----------|------------|
| Claude | Architecture, design patterns, code quality, documentation | `claude_request` | `claude_request_async` |
| Codex | Implementation correctness, logic bugs, test coverage | `codex_request` | `codex_request_async` |
| Gemini | Security analysis, edge cases, multimodal context | `gemini_request` | `gemini_request_async` |

## Standard Review Workflow

### Step 1: Discover available models

```
list_models()
```

Pick the strongest model for each CLI (e.g., claude with default model, codex with default, gemini with gemini-2.5-pro).

### Step 2: Send parallel review requests

Send review prompts to 2-3 LLMs simultaneously. Use `optimizePrompt: true` to reduce token overhead.

**Claude — Quality & Architecture:**
```
claude_request({
  prompt: "Review the following code for architecture quality, design patterns, maintainability, and documentation gaps. Be specific about line numbers and suggest fixes.\n\n<code>\n{paste code here}\n</code>",
  optimizePrompt: true,
  optimizeResponse: true
})
```

**Codex — Logic & Correctness:**
```
codex_request({
  prompt: "Analyze this code for logic bugs, off-by-one errors, missing error handling, race conditions, and test coverage gaps. List each issue with severity (critical/high/medium/low).\n\n<code>\n{paste code here}\n</code>",
  optimizePrompt: true,
  optimizeResponse: true
})
```

**Gemini — Security & Edge Cases:**
```
gemini_request({
  prompt: "Security audit this code. Check for injection vulnerabilities, authentication bypasses, data leaks, OWASP Top 10 issues, and edge cases that could cause crashes or undefined behavior.\n\n<code>\n{paste code here}\n</code>",
  model: "gemini-2.5-pro",
  optimizePrompt: true,
  optimizeResponse: true
})
```

### Step 3: Synthesize findings

After collecting all three responses:

1. **Deduplicate** — Remove findings reported by multiple LLMs
2. **Prioritize** — Rank by severity (critical > high > medium > low)
3. **Cross-validate** — If one LLM flags something the others missed, verify it
4. **Categorize** — Group into: Security, Correctness, Performance, Maintainability

### Step 4: Present consolidated report

Format the combined findings as a structured report:

```
## Code Review Summary

### Critical Issues (must fix)
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

## For Large Codebases

When reviewing many files, use async jobs for all three CLIs so you can run reviews in parallel and work on other tasks while waiting:

```
// All three reviews in parallel
claude_request_async({
  prompt: "Review all TypeScript files in src/ for architecture and quality...",
  optimizePrompt: true,
  correlationId: "review-quality"
})

codex_request_async({
  prompt: "Check all TypeScript files in src/ for logic bugs and test gaps...",
  optimizePrompt: true,
  correlationId: "review-bugs"
})

gemini_request_async({
  prompt: "Security audit all TypeScript files in src/...",
  model: "gemini-2.5-pro",
  correlationId: "review-security"
})
```

Poll with `llm_job_status` and retrieve with `llm_job_result`. See the `async-job-orchestration` skill for details.

For iterative Gemini reviews (review → discuss → re-review), pass a `sessionId` to `gemini_request_async` so the session is resumable:

```
gemini_request_async({
  prompt: "Deep security audit of src/...",
  sessionId: "gemini-security-review",
  model: "gemini-2.5-pro"
})
// Response: resumable: true — session can be continued
```

## Tips

- Always use `optimizePrompt: true` and `optimizeResponse: true` to save tokens
- Use sessions if doing iterative reviews (review -> fix -> re-review)
- For security-sensitive reviews, set `approvalStrategy: "mcp_managed"` with `approvalPolicy: "strict"`
- Include file paths and line numbers in prompts for actionable feedback
- If a CLI is unavailable, gracefully skip it and note the gap
- For large codebases, use all three async variants (`claude_request_async`, `codex_request_async`, `gemini_request_async`) for true parallel reviews
- Pass `sessionId` to `gemini_request_async` to make Gemini reviews resumable for follow-up discussion
