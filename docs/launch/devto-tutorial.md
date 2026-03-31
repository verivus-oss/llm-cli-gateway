---
title: "How to Set Up Multi-LLM Code Review with Claude, Codex, and Gemini"
published: true
tags: ai, codereview, mcp, typescript
---

> *"Without consultation, plans are frustrated, but with many counselors they succeed."* -- Proverbs 15:22

Every LLM has blind spots. Claude is strong on architecture and design patterns. Codex catches logic bugs and missing error handling. Gemini is thorough on security issues and edge cases. Using just one reviewer means you are only getting one perspective.

This tutorial walks through setting up **llm-cli-gateway** -- an MCP server that wraps the Claude Code, Codex, and Gemini CLIs -- and running a parallel code review that combines all three.

## Prerequisites

You need the CLI tools installed:

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# Codex
npm install -g @openai/codex
codex login

# Gemini
npm install -g @google/gemini-cli
```

You do not need all three. The gateway works with whichever CLIs you have installed.

## Step 1: Install the Gateway

Add it to your MCP client configuration. If you use Claude Code, edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "llm-gateway": {
      "command": "npx",
      "args": ["-y", "llm-cli-gateway"]
    }
  }
}
```

That is the entire setup. The gateway discovers your installed CLIs automatically via PATH resolution (including `~/.local/bin` and NVM paths).

## Step 2: Verify Your Setup

Once connected, confirm which CLIs are available:

```
list_models()
```

This returns the available models for each detected CLI. If a CLI is not installed, it will not appear in the output.

## Step 3: Run a Parallel Code Review

Here is the core workflow. You send the same codebase to all three LLMs, each with a prompt tuned to its strengths.

### Claude -- Architecture and Quality

```json
claude_request({
  "prompt": "Review the changes in src/auth/ for architecture, design patterns, maintainability, and documentation gaps. Read the files directly. Provide specific line numbers and suggested fixes.",
  "optimizePrompt": true,
  "optimizeResponse": true
})
```

### Codex -- Logic and Correctness

```json
codex_request({
  "prompt": "Analyze src/auth/ for logic bugs, off-by-one errors, missing error handling, race conditions, and test coverage gaps. Read the files directly. Rate each finding: critical, high, medium, or low.",
  "fullAuto": true,
  "optimizePrompt": true,
  "optimizeResponse": true
})
```

### Gemini -- Security and Edge Cases

```json
gemini_request({
  "prompt": "Security audit of src/auth/: check for injection vulnerabilities, authentication bypasses, data leaks, OWASP Top 10 violations, and crash-causing edge cases. Read the files directly.",
  "model": "gemini-2.5-pro",
  "optimizePrompt": true,
  "optimizeResponse": true
})
```

In an MCP client like Claude Code, you can fire all three of these as parallel tool calls in a single turn.

## Step 4: Handle Long-Running Reviews

Code reviews on large files can take over a minute. The gateway handles this transparently.

Any sync request that exceeds 45 seconds automatically becomes an async job. Instead of timing out, you get back a job reference:

```json
{
  "status": "deferred",
  "jobId": "abc-123",
  "message": "Running in background. Poll with llm_job_status."
}
```

Check on it:

```json
llm_job_status({ "jobId": "abc-123" })
```

When status is `completed`, fetch the result:

```json
llm_job_result({ "jobId": "abc-123" })
```

If a review is stuck, cancel it:

```json
llm_job_cancel({ "jobId": "abc-123" })
```

## Step 5: Synthesize the Results

Once all three reviews come back, combine them. Here is a structured approach:

1. **Deduplicate.** Multiple LLMs will often flag the same issue. Merge these and note which LLMs agreed.
2. **Prioritize.** Critical findings first, then high, medium, low. If two or more LLMs flag the same thing as critical, it almost certainly is.
3. **Cross-validate unique findings.** When only one LLM finds something, verify it. Gemini-only security findings are usually real. Single-LLM style complaints are usually noise.
4. **Categorize.** Group by Security, Correctness, Performance, and Maintainability.

The output should look like:

```markdown
## Code Review Summary

### Critical (must fix)
- SQL injection in login handler (line 47) -- found by Gemini, confirmed by Codex

### High
- Missing error handling on token refresh (line 112) -- found by Codex
- Session fixation vulnerability (line 89) -- found by Gemini

### Medium
- Duplicated validation logic across handlers -- found by Claude
- No rate limiting on auth endpoints -- found by Gemini, noted by Claude
```

## Step 6: Fix and Verify

Send the consolidated findings back through Codex for fixes:

```json
codex_request({
  "prompt": "Fix the following issues in src/auth/:\n\n1. [Critical] SQL injection in login handler, line 47 - use parameterized queries\n2. [High] Missing error handling on token refresh, line 112\n3. [High] Session fixation vulnerability, line 89 - regenerate session on login\n\nApply fixes and update tests.",
  "fullAuto": true,
  "optimizePrompt": true
})
```

Then run your test suite. If tests pass, you have a review cycle that caught issues no single LLM would have found alone.

## Using Sessions for Multi-Turn Reviews

For larger reviews that require back-and-forth, create sessions:

```json
session_create({
  "cli": "claude",
  "description": "Auth module review",
  "setAsActive": true
})
```

Subsequent `claude_request` calls with `continueSession: true` will use the Claude CLI's `--continue` flag, maintaining real conversation context. Gemini sessions use `--resume` for the same effect.

```json
claude_request({
  "prompt": "Look at the token refresh logic more carefully. Is the retry backoff correct?",
  "continueSession": true
})
```

## Optional: Approval Gates

For high-risk operations, enable approval gates:

```json
codex_request({
  "prompt": "Refactor the authentication module",
  "fullAuto": true,
  "approvalStrategy": "mcp_managed",
  "approvalPolicy": "strict"
})
```

The gateway scores the operation's risk and records an approval decision before execution. Review past decisions with `approval_list()`.

## What This Is (and Is Not)

**llm-cli-gateway wraps CLI binaries, not APIs.** It spawns `claude`, `codex`, and `gemini` as child processes. You get the full CLI experience -- tool use, sandboxing, file access, your existing authentication and billing. There is no API key to configure for the gateway itself.

This means it does not work like LiteLLM or other API proxy tools. It cannot run in a cloud environment without the CLIs installed. It is designed for local development machines where you already have these tools.

## Links

- **npm:** [llm-cli-gateway](https://npmjs.com/package/llm-cli-gateway)
- **GitHub:** [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
- **MCP Registry:** `io.github.verivus-oss/llm-cli-gateway`
- **License:** MIT, by [VerivusAI Labs](https://github.com/verivus-oss)
