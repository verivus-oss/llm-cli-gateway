---
name: model-routing
description: Choose the right LLM and model for each task based on proven patterns. Use when deciding whether to delegate to Claude, Codex, Gemini, or Grok, or when selecting model variants.
---

# Model Routing

Choose the right LLM for each task. Based on real usage across 11+ VerivusAI projects.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches. Call `list_models` only when the caller has asked for a specific variant.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution; Claude then uses `bypassPermissions`, Gemini uses `yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work.
3. **No wallclock timeout; poll every 60 s** — `idleTimeoutMs` is a separate no-output safeguard.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with "End with APPROVED or NOT APPROVED with findings." Loop: dispatch → parse verdict → on `NOT APPROVED` or conditional, fix + re-review → repeat. Escalate after 3 rounds. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Decision Matrix

All tool invocations below use the dispatch defaults above (omit `model`, `approvalStrategy:"mcp_managed"`, `fullAuto:true` for Codex, poll every 60 s, loop on reviews).

| Task | Best LLM | Why | Tool |
|------|----------|-----|------|
| **Code implementation** | Codex | Strongest at writing correct code, handles large codebases | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Code review (quality)** | Codex | Thorough, finds real issues, gives actionable feedback | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Code review (security)** | Gemini | Strong security focus, OWASP awareness, edge case detection | `gemini_request` (`approvalStrategy:"mcp_managed"`) |
| **Architecture review** | Claude | Best at high-level design, pattern recognition, trade-off analysis | `claude_request` (`approvalStrategy:"mcp_managed"`) |
| **Design doc review** | Codex | Checks feasibility, completeness, finds gaps in plans | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Bug investigation** | Codex | Can read code, trace logic, identify root causes | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Refactoring** | Codex | Handles multi-file changes reliably | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Documentation** | Claude | Best prose quality, understands audience | `claude_request` (`approvalStrategy:"mcp_managed"`) |
| **Test generation** | Codex | Understands test frameworks, generates comprehensive cases | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Security audit** | Gemini | Security-focused analysis, threat modeling | `gemini_request` (`approvalStrategy:"mcp_managed"`) |
| **Multi-file analysis** | Codex | Handles large codebases with sqry integration | `codex_request` (`fullAuto:true`, `approvalStrategy:"mcp_managed"`) |
| **Diversity / tie-breaker review** | Grok (xAI) | Independent fourth model from a different vendor family — useful when Claude/Codex/Gemini might share a blind spot | `grok_request` (`approvalStrategy:"mcp_managed"`) |
| **Consensus / unanimous gate** | All four in parallel | Catches issues any single model misses; use when correctness > cost | `*_request_async` for Claude/Codex/Gemini/Grok |

## Model Selection Rules

### Rule 1: Omit the model parameter by default

The gateway uses sensible configured defaults. Omitting `model` is almost always correct.

```
codex_request({prompt: "...", fullAuto: true, approvalStrategy: "mcp_managed"})
gemini_request({prompt: "...", approvalStrategy: "mcp_managed"})
claude_request({prompt: "...", approvalStrategy: "mcp_managed"})
grok_request({prompt: "...", approvalStrategy: "mcp_managed"})
```

### Rule 2: Avoid stale hardcoded model IDs

Treat old memory/config IDs such as `o3`, `o3-pro`, and `gpt-4o` as legacy unless `list_models` currently reports them for the target CLI.

If you see stale IDs in old configs or memory, prefer the configured default or call `list_models`.

### Rule 3: Specify model only when the caller has asked for a specific variant

The dispatch default is to omit `model`. Only include it if the user has explicitly named a model in the current turn.

```
// Only when the caller asked for this specific variant:
gemini_request({prompt: "...", model: "<explicit-user-request>", approvalStrategy: "mcp_managed"})
```

### Rule 4: Check available models when unsure

```
list_models()                    // All CLIs
list_models({cli: "codex"})      // Codex models only
```

## Delegation Patterns

### "Ask Codex to implement"

The most common pattern. Codex with fullAuto handles implementation + testing:

```
codex_request({
  prompt: "Implement [feature] in [path]. Requirements:\n- [req 1]\n- [req 2]\n\nInclude tests.",
  fullAuto: true,
  approvalStrategy: "mcp_managed"
})
```

### "Ask Codex to review"

Second most common. Codex reviews with full codebase access:

```
codex_request({
  prompt: "Review [path] for [criteria]. End with APPROVED or NOT APPROVED with findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed"
})
```

### "Ask Gemini for security perspective"

For security-sensitive changes:

```
gemini_request({
  prompt: "Security audit [path]. Check for injection, auth bypass, data leaks, OWASP Top 10. End with APPROVED or NOT APPROVED with findings.",
  approvalStrategy: "mcp_managed"
})
```

### "Parallel review from multiple LLMs"

For comprehensive coverage:

```
codex_request_async({prompt: "Review [path] for correctness... End with APPROVED or NOT APPROVED with findings.", fullAuto: true, approvalStrategy: "mcp_managed", correlationId: "review-codex"})
gemini_request_async({prompt: "Security audit [path]... End with APPROVED or NOT APPROVED with findings.", approvalStrategy: "mcp_managed", correlationId: "review-gemini"})
grok_request_async({prompt: "Independent review of [path]... End with APPROVED or NOT APPROVED with findings.", approvalStrategy: "mcp_managed", correlationId: "review-grok"})
```

## Session Continuity Implications

Model routing affects session strategy:

| LLM | Session Continuity | Implication |
|-----|-------------------|-------------|
| Claude | Real (`--continue` / `--session-id`) | Can do multi-turn refinement |
| Codex | Real (`codex exec resume <UUID>` / `--last`) — sessionId must be a real Codex UUID from `~/.codex/sessions/`; `--full-auto` dropped on resume | Good for iterative work; pass `resumeLatest:true` for the most recent cwd session |
| Gemini | Real (`--resume`) | Good for iterative analysis |
| Grok | Real (`--resume <id>` / `--continue`) | Good for iterative review/diversity rounds |

This means:
- **All four CLIs support multi-turn workflows** through the gateway
- Codex resume requires either `resumeLatest:true` or a real Codex session UUID — gateway-generated `gw-*` IDs are rejected
- Resumed Codex sessions inherit the original approval policy; `fullAuto:true` is silently dropped on resume
- Gemini-generated `gw-*` IDs are bookkeeping handles and rejected if replayed

## Cost Considerations

- Codex with `fullAuto` is the most autonomous but most expensive per call
- Gemini is generally cheaper for review tasks
- Claude is middle ground
- Grok depends on xAI billing/pricing — treat as an extra reviewer slot for high-stakes paths, not the default
- For routine reviews: single LLM (Codex) is sufficient
- For critical reviews: parallel multi-LLM (see multi-llm-consensus skill); add Grok when consensus across vendor families matters
- For huge codebases: use async variants to avoid blocking

## Tips

- For routine read-only analysis, drafting, or review, prefer Claude or Gemini with omitted `model` so configured fast defaults such as Haiku or Flash can apply.
- Use Codex with `fullAuto: true` and `approvalStrategy: "mcp_managed"` when the task needs autonomous code edits, tests, or shell commands.
- For security-specific work, always include Gemini. Add Grok for an independent vendor-family perspective when stakes are high.
- Don't overthink model selection — the default is almost always fine. **Omit `model` unless the caller asked for a specific variant.**
- Use `correlationId` on every request for tracing.
- If a task exceeds 45s, it auto-defers. Check for `status:"deferred"` in responses, then poll every 60s. Results are durable for 30 days (`LLM_GATEWAY_JOB_RETENTION_DAYS`) — re-issuing the same call within the dedup window (`LLM_GATEWAY_DEDUP_WINDOW_MS`, default 1h) reattaches to the live job. Pass `forceRefresh:true` only when inputs actually changed.
- Use `cli_versions` to inspect installed CLI versions. Use `cli_upgrade` with `dryRun:true` first; run real upgrades only when the caller wants the local CLI updated. Grok self-updates via `grok update`; the same `cli_upgrade` tool routes it for you.
