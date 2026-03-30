---
name: model-routing
description: Choose the right LLM and model for each task based on proven patterns. Use when deciding whether to delegate to Claude, Codex, or Gemini, or when selecting model variants.
---

# Model Routing

Choose the right LLM for each task. Based on real usage across 11+ VerivusAI projects.

## Decision Matrix

| Task | Best LLM | Why | Tool |
|------|----------|-----|------|
| **Code implementation** | Codex | Strongest at writing correct code, handles large codebases | `codex_request` with `fullAuto: true` |
| **Code review (quality)** | Codex | Thorough, finds real issues, gives actionable feedback | `codex_request` with `fullAuto: true` |
| **Code review (security)** | Gemini | Strong security focus, OWASP awareness, edge case detection | `gemini_request` with `model: "gemini-2.5-pro"` |
| **Architecture review** | Claude | Best at high-level design, pattern recognition, trade-off analysis | `claude_request` |
| **Design doc review** | Codex | Checks feasibility, completeness, finds gaps in plans | `codex_request` with `fullAuto: true` |
| **Bug investigation** | Codex | Can read code, trace logic, identify root causes | `codex_request` with `fullAuto: true` |
| **Refactoring** | Codex | Handles multi-file changes reliably | `codex_request` with `fullAuto: true` |
| **Documentation** | Claude | Best prose quality, understands audience | `claude_request` |
| **Test generation** | Codex | Understands test frameworks, generates comprehensive cases | `codex_request` with `fullAuto: true` |
| **Security audit** | Gemini | Security-focused analysis, threat modeling | `gemini_request` with `model: "gemini-2.5-pro"` |
| **Multi-file analysis** | Codex | Handles large codebases with sqry integration | `codex_request` with `fullAuto: true` |

## Model Selection Rules

### Rule 1: Omit the model parameter by default

The gateway uses sensible configured defaults. Omitting `model` is almost always correct.

```
codex_request({prompt: "...", fullAuto: true})  // Uses configured default
gemini_request({prompt: "..."})                  // Uses configured default
claude_request({prompt: "..."})                  // Uses configured default
```

### Rule 2: Never use deprecated models

These models cause failures or excessive delays:
- **o3** — deprecated
- **o3-pro** — deprecated
- **gpt-4o** — deprecated

If you see these in old configs or memory, ignore them.

### Rule 3: Specify model only when you need a specific variant

```
gemini_request({prompt: "...", model: "gemini-2.5-pro"})  // For thorough security review
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
  fullAuto: true
})
```

### "Ask Codex to review"

Second most common. Codex reviews with full codebase access:

```
codex_request({
  prompt: "Review [path] for [criteria]. APPROVED or NOT APPROVED with findings.",
  fullAuto: true
})
```

### "Ask Gemini for security perspective"

For security-sensitive changes:

```
gemini_request({
  prompt: "Security audit [path]. Check for injection, auth bypass, data leaks, OWASP Top 10.",
  model: "gemini-2.5-pro"
})
```

### "Parallel review from multiple LLMs"

For comprehensive coverage:

```
codex_request_async({prompt: "Review [path] for correctness...", fullAuto: true, correlationId: "review-codex"})
gemini_request_async({prompt: "Security audit [path]...", model: "gemini-2.5-pro", correlationId: "review-gemini"})
```

## Session Continuity Implications

Model routing affects session strategy:

| LLM | Session Continuity | Implication |
|-----|-------------------|-------------|
| Claude | Real (conversation carries over) | Can do multi-turn refinement |
| Codex | None (each call is fresh) | Must include all context in every prompt |
| Gemini | Real (can resume) | Good for iterative analysis |

This means:
- **Codex tasks must be self-contained** — include all context in the prompt
- **Claude/Gemini tasks can be conversational** — "continue from where we left off"
- **Don't use Codex for multi-turn workflows** unless you restate context each time

## Cost Considerations

- Codex with `fullAuto` is the most autonomous but most expensive per call
- Gemini is generally cheaper for review tasks
- Claude is middle ground
- For routine reviews: single LLM (Codex) is sufficient
- For critical reviews: parallel multi-LLM (see multi-llm-consensus skill)
- For huge codebases: use async variants to avoid blocking

## Tips

- When in doubt, use Codex with `fullAuto: true`. It handles most tasks well.
- For security-specific work, always include Gemini.
- Don't overthink model selection — the default is almost always fine.
- Use `correlationId` on every request for tracing.
- If a task exceeds 45s, it auto-defers. Check for `status:"deferred"` in responses.
