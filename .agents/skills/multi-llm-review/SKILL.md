---
name: multi-llm-review
description: Parallel code reviews across Claude, Codex, Gemini, Grok, and Mistral. Use for quality analysis, bug finding, or security audit.
metadata:
  author: verivus-oss
  version: "1.7"
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
| Mistral Vibe | Independent fifth perspective; uncorrelated with the OpenAI/Anthropic/Google/xAI family; defaults to `--agent auto-approve` | `mistral_request` | `mistral_request_async` |

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Use the stdio gateway MCP surface only** — call the host's `mcp__gtwy__*` tools (or the equivalent stdio `gtwy` namespace exposed to the current agent). Do not use connector/shadow gateway tools when the user asked for stdio gateway validation.
2. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, ...) and capability mismatches. Call `list_models` only when the caller has asked for a specific variant.
3. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It gates the request before execution. Grant full non-interactive verification permissions on every review round because permission grants are not assumed durable.
4. **Full verification access for reviewers is required** — reviewers need read, test/build, code-search, docs lookup, web/search, and provider-safe gateway introspection access where appropriate. Do not suppress tools or pass empty allowlists. If a provider-specific permission or MCP server required for verification is rejected, treat that as a review dispatch failure and fix the gateway/permission setup before proceeding, unless the user explicitly authorizes a degraded review.
5. **No wallclock timeout; poll every 90 s** — use `*_request_async`. Poll `llm_job_status` no more than once every 90 seconds. Do **not** cancel reviewer jobs for taking too long; cancel only on explicit user instruction or a terminal provider/runtime failure. `idleTimeoutMs` (no-output safeguard) is separate.
6. **Iterate until unconditional APPROVED** (review dispatches only) — every review prompt must end with a strict verdict requirement. On `NOT APPROVED`, `CHANGES_REQUIRED`, `BLOCKER`, or conditional approval, consolidate findings, apply fixes, refresh the verification report and exact diff/commit evidence, then re-dispatch the same reviewers. Repeat until unconditional approval or a concrete blocker remains after evidence-based rebuttal. This rule does **not** apply to pure implementation or non-review analysis dispatches.

## Standard Validation Gate

Use this gate whenever the user asks for "the other LLMs", "cross review",
"red team", "validation", or similar review work.

### Evidence Packet

Before dispatch, prepare a stable packet and pass the same packet to every
reviewer:

- **Corrective-program verification report**: the local verification report used
  as the spec for the review. It must list claims, commands run, test names,
  command-result digests, and code/doc evidence.
- **Exact change set**: commit SHA(s) when available, the diff range or explicit
  `git diff` command, and the changed-file list. If the work is uncommitted,
  state that clearly and include the exact dirty-file list.
- **Scope and invariants**: DAG step(s), issue/PR references, security
  invariants, docs that define intended behavior, and out-of-scope files.
- **Review log from prior rounds**: verbatim reviewer findings plus per-finding
  responses marked `FIXED`, `DISAGREE`, or `BLOCKER`, each with file:line, test,
  command, or doc evidence.

The packet is not a substitute for inspection. The prompt must explicitly say
that the verification report and summary are claims, not evidence.

### Reviewer Contract

Every reviewer prompt must require:

- Verify claims against actual code, tests, docs, and upstream documentation.
- Open/read the changed files and relevant neighboring code directly.
- Run or inspect the cited tests/builds; approval cannot be based on a summary,
  intent, plan-compliance, or "should be fixed" language.
- Cite concrete evidence for each finding: `file:line`, test name + command, or
  upstream doc URL. If a claim cannot be verified, report it as at least a major
  finding.
- Return strict structured output with `verdict`, `findings`, `inspected`, and
  `unconditional_approval_blockers`.

Recommended final verdict enum:

```json
{
  "verdict": "APPROVED | CHANGES_REQUIRED | BLOCKER",
  "findings": [
    {
      "id": "F1",
      "severity": "blocker | major | minor | nit",
      "file": "src/example.ts",
      "line": 123,
      "claim": "Exact claim reviewed",
      "issue": "What is wrong",
      "evidence": "file:line, command/test output digest, URL, or unable to verify: reason",
      "suggested_fix": "Concrete fix"
    }
  ],
  "inspected": ["files, tests, commands, docs actually inspected"],
  "unconditional_approval_blockers": ["F1"]
}
```

### Evidence-Based Triage

For every finding:

- If correct: fix it, run the relevant local gates, update the verification
  report, and start a new review round with a fresh exact change set.
- If disputed: respond to that reviewer through the gateway with code/doc/test
  evidence. Do not rebut with assertion, intent, "by design", or "the code should
  already do that" unless accompanied by the exact evidence. The reviewer must
  withdraw the finding or provide counter-evidence.
- If unresolvable in scope: record it as a concrete `BLOCKER` with evidence and
  stop advancing the change until the user decides scope.

"Approved with nits" is not unconditional approval. Fix the nits or get the
reviewer to withdraw them as non-blocking with evidence.

## Workflow

### 1. Discover Models (optional)

Only when the caller has asked for a specific variant:

```
list_models()
```

Otherwise omit `model` and proceed.

### 1a. Discover Provider Capabilities

Before applying provider-specific controls such as tool allowlists, MCP server
fields, session resume, media skills, or output formats, ask the gateway for the
provider surface:

```
provider_tool_capabilities({cli:"claude"})
provider_tool_capabilities({cli:"codex"})
provider_tool_capabilities({cli:"gemini"})
provider_tool_capabilities({cli:"grok"})
provider_tool_capabilities({cli:"mistral"})
```

Use the reported `unsupportedInputs` and `controls` instead of assuming all
CLIs share Claude's tool names or MCP semantics. The same data is available as
`provider-tools://{provider}` resources.

### 2. Send Parallel Reviews

Sync tools auto-defer at 45s, but review gates should prefer async tools. Poll
`jobId` via `llm_job_status` no more than once every 90s, fetch with
`llm_job_result` only after a terminal status.

**Tip — share the stable prefix across reviewers:** when the same long brief / file dump is sent to every reviewer, switch from `prompt` to the structured `promptParts` field. The gateway concatenates in canonical order `system → tools → context → task`, so every reviewer sees byte-identical stable prefix bytes, raising implicit cache hit rate at each provider. `prompt` and `promptParts` are mutually exclusive — the runtime returns `provide exactly one of \`prompt\` or \`promptParts\`` if both are supplied. After the round, read `cache-state://prefix/{hash}` (tokens/hashes only, no prompt text) to confirm reviewers actually shared the prefix.

**Claude — Quality & Architecture:**
```
claude_request_async({prompt:"Review the attached evidence packet and exact change set for architecture, design patterns, maintainability, and documentation gaps. The packet is a claim, not evidence. Verify against the changed files, neighboring source, tests, and docs directly. Cite file:line/test/doc evidence. Return strict JSON and end with APPROVED, CHANGES_REQUIRED, or BLOCKER.",approvalStrategy:"mcp_managed",optimizePrompt:true})
```

**Codex — Logic & Correctness:**
```
codex_request_async({prompt:"Review the attached evidence packet and exact change set for logic bugs, off-by-one errors, missing error handling, races, and test gaps. The packet is a claim, not evidence. Verify against code/tests/docs directly. Cite file:line/test/doc evidence. Return strict JSON and end with APPROVED, CHANGES_REQUIRED, or BLOCKER.",fullAuto:true,approvalStrategy:"mcp_managed",optimizePrompt:true})
```

**Gemini — Security & Edge Cases:**
```
gemini_request_async({prompt:"Review the attached evidence packet and exact change set for security issues: injection, auth bypasses, data leaks, OWASP Top 10, and crash-causing edge cases. The packet is a claim, not evidence. Verify against code/tests/docs/upstream docs directly. Cite evidence. Return strict JSON and end with APPROVED, CHANGES_REQUIRED, or BLOCKER.",approvalStrategy:"mcp_managed",optimizePrompt:true})
```

**Grok — Independent Diversity (optional 4th reviewer):**
```
grok_request_async({prompt:"Independent review of the attached evidence packet and exact change set. The packet is a claim, not evidence. Verify against code/tests/docs directly, flag blind spots, and contradict weak findings with evidence. Return strict JSON and end with APPROVED, CHANGES_REQUIRED, or BLOCKER.",approvalStrategy:"mcp_managed",optimizePrompt:true})
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
mistral_request_async({prompt:"Independent Vibe review of all TS files in src/... End with APPROVED or NOT APPROVED with findings.",approvalStrategy:"mcp_managed",correlationId:"review-mistral"})
```

Poll with `llm_job_status` no more than once every 90s, retrieve with
`llm_job_result` when terminal. Jobs are durable — if your polling wrapper times
out, re-issue the same call (the gateway auto-dedups onto the live job) or fetch
by `jobId` later (default 30-day retention).

For iterative Gemini reviews, pass `sessionId` for resumability:

```
gemini_request_async({prompt:"Deep security audit of src/... End with APPROVED or NOT APPROVED with findings.",sessionId:"gemini-security-review",approvalStrategy:"mcp_managed"})
// Response: resumable:true
```

## Anti-Patterns

These patterns undermine review quality and trigger review integrity warnings:

- **Don't use non-stdio gateway surfaces** when the requested validation path is
  the local stdio gateway.
- **Don't provide only a summary** — provide the verification report and exact
  change set, while requiring reviewers to verify against files/tests/docs
  directly.
- **Don't under-grant review access** — full read, test/build, and MCP
  verification access is the default. A partial-access review is not a valid
  approval unless the user explicitly accepts that limitation.
- **Don't suppress tools** — never include "do not run tools" or "respond only based on code provided" in review prompts
- **Don't use `allowedTools:[]`** for reviews — reviewers need tool access to
  verify claims
- **Don't copy tool names between providers** — Claude's `Read` / `Grep` /
  `Glob` names are not Grok, Codex, Gemini, or Vibe allowlist names. Check
  `provider_tool_capabilities` first, or omit provider tool allowlists.
- **Don't cancel reviewer jobs** just because they are slow. Let them reach a
  terminal status unless the user explicitly says to stop them.
- **Do provide file paths and exact diff identifiers** — `"Review commit
  abc123, diff range base..head, changed files src/auth.ts ..."` instead of
  vague summaries.

## Iteration Loop (mandatory)

Reviews are not one-shot. The caller runs this loop:

1. Dispatch reviewer(s) with the verdict clause in the prompt
2. Poll every 90s if deferred; fetch result only after terminal status
3. Parse verdict from each reviewer — APPROVED / NOT APPROVED / conditional
4. **Any NOT APPROVED, CHANGES_REQUIRED, BLOCKER, or conditional** → triage each finding with evidence → fix or rebut with code/doc/test citations → refresh verification report and exact diff → re-dispatch same review → goto 2
5. **All APPROVED (unconditional)** → done
6. After 3 rounds without convergence, escalate to the user

"APPROVED with residual notes" counts as approved only if notes are purely informational.

## Tips

- Always use `optimizePrompt:true` and `optimizeResponse:true`
- Use sessions for iterative reviews (review → fix → re-review). Claude,
  Codex, Gemini, Grok, and Mistral carry real provider continuity when their
  provider-specific session rules are satisfied
- For security-sensitive: `approvalPolicy:"strict"` (in addition to default `mcp_managed`)
- Include file paths and line numbers for actionable feedback
- If CLI unavailable, skip gracefully and note gap
- Use all five async variants for true parallel reviews when you want Grok's
  independent perspective and Mistral Vibe's fifth review
- Pass `sessionId` to `gemini_request_async` / `grok_request_async` for resumable follow-up
- Check for `status:"deferred"` in sync responses — poll `jobId` no more than once every 90s if present
- Gateway `mcpServers` default to the host's configured Claude MCP set; pass explicit server names only when the review needs those capabilities
- **Re-issuing after a polling timeout is safe** — auto-dedup (default 1 h window, `LLM_GATEWAY_DEDUP_WINDOW_MS`) reattaches the new call to the existing job. Use `forceRefresh:true` only when inputs genuinely changed
