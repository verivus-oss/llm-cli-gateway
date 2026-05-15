---
name: red-team-assessment
description: Get an adversarial red team security assessment from any LLM (Claude, Codex, Gemini, or Grok) with gateway-managed approvals and optional sqry, exa, and ref_tools MCP access. Use when you need adversarial security analysis of code, architecture, or configurations.
---

# Red Team Assessment

Submit code, designs, or configurations to one or more LLMs for adversarial security analysis. Give reviewers file/tool access appropriate to the CLI and request `sqry`, `exa`, and `ref_tools` when code search, CVE research, or documentation checks are needed.

## Dispatch Defaults

Apply these on every dispatch unless the caller has explicitly overridden a rule in the current turn:

1. **Omit `model`** — let the gateway use its configured default per CLI. Nominating a model risks deprecated IDs (`o3`, `o3-pro`, `gpt-4o`, …) and capability mismatches. Only nominate when the caller has explicitly named a specific variant.
2. **`approvalStrategy:"mcp_managed"`** is the skill dispatch default (the gateway schema default is `"legacy"`). It runs the gateway gate first; Claude then uses `bypassPermissions`, Gemini uses `yolo`, and Codex still needs `fullAuto:true` for autonomous file/shell work. Add `mcpServers:["sqry","exa","ref_tools"]` when research tools are needed.
3. **No wallclock timeout; poll every 60 s** — red team assessments are thorough and routinely run for 5–20 minutes. Do **not** cancel for "taking too long." `idleTimeoutMs` (no-output safeguard) is separate.
4. **Iterate until unconditional APPROVED** (review dispatches only) — every red team prompt must end with "End with PASS (no critical/high findings) or FAIL with findings" (the PASS/FAIL verdict is the red-team equivalent of APPROVED/NOT APPROVED; treat PASS as APPROVED). On FAIL, run the blue-team cycle below, then re-dispatch to the same red teamer. Loop until PASS. Escalate after 3 rounds.

## When to Use

- Before shipping security-sensitive code (auth, crypto, data handling)
- After implementing access control or permission systems
- When changing API surfaces or data models
- For threat modeling of new architectures
- When you want an adversarial perspective ("how would I break this?")

## LLM Selection for Red Teaming

Any LLM can red team. Choose based on the assessment type:

| LLM | Red Team Strength | Best For |
|-----|-------------------|----------|
| **Gemini** | Security-focused, OWASP-aware, CVE research via exa | Web security, API security, dependency audits |
| **Codex** | Deep code analysis, logic bug hunting, can execute tests | Implementation vulnerabilities, race conditions, logic flaws |
| **Claude** | Architecture analysis, design-level threats, broad reasoning | Threat modeling, design review, trust boundary analysis |
| **Grok (xAI)** | Independent vendor-family perspective; useful when the other three converge on the same threat model and miss adversarial angles outside it | Diversity reviewer / tie-breaker for high-stakes assessments |

For maximum coverage, use **multiple LLMs in parallel** (see Multi-LLM Red Team below).

## Single-LLM Red Team

### Using Gemini

```
gemini_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nUse available tools. Read the code directly. Use sqry for semantic search across the codebase. Use exa for known CVEs and vulnerability patterns. Use ref_tools for framework-specific security docs.\n\nAssess:\n1. Attack surface analysis — what can an attacker reach?\n2. Input validation gaps — what inputs are trusted but shouldn't be?\n3. Authentication/authorization bypasses\n4. Data exposure risks (logs, errors, side channels)\n5. Dependency risks (known CVEs, supply chain)\n6. Race conditions and state management\n7. Injection vectors (SQL, command, template, path traversal)\n8. Cryptographic misuse\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  mcpServers: ["sqry", "exa", "ref_tools"]
})
```

### Using Codex

```
codex_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nUse available tools. Read the code, run tests, trace execution paths. Use sqry for semantic code search and call graph analysis if it is configured for Codex.\n\nAssess:\n1. Attack surface analysis\n2. Input validation gaps\n3. Authentication/authorization bypasses\n4. Race conditions and state management issues\n5. Logic vulnerabilities that could be exploited\n6. Injection vectors\n7. Error handling that leaks information\n8. Test coverage gaps in security-critical paths\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL with findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed"
})
```

### Using Claude

```
claude_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nUse available tools. Read the code directly. Use sqry for semantic search. Use exa for known vulnerability patterns. Use ref_tools for security documentation.\n\nAssess:\n1. Trust boundary analysis — where does trusted meet untrusted?\n2. Attack surface analysis\n3. Authentication/authorization design flaws\n4. Data flow risks — where does sensitive data go?\n5. Dependency and supply chain risks\n6. Cryptographic design issues\n7. Injection vectors\n8. Failure mode analysis — what happens when things break?\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"]
})
```

## Multi-LLM Red Team (Maximum Coverage)

For critical security reviews, run all three in parallel. Each LLM catches different classes of vulnerabilities.

```
claude_request_async({
  prompt: "Red team [path]. Focus on architecture-level threats: trust boundaries, data flow, design flaws, failure modes. End with PASS or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  correlationId: "red-team-claude"
})

codex_request_async({
  prompt: "Red team [path]. Focus on implementation-level threats: logic bugs, race conditions, injection, error handling, test gaps. End with PASS or FAIL with findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed",
  correlationId: "red-team-codex"
})

gemini_request_async({
  prompt: "Red team [path]. Focus on known vulnerability patterns: OWASP Top 10, CVEs in dependencies, crypto misuse, data exposure. End with PASS or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  mcpServers: ["sqry", "exa", "ref_tools"],
  correlationId: "red-team-gemini"
})

grok_request_async({
  prompt: "Red team [path] from an independent perspective. Look for threats the other reviewers may have missed, contradict findings you disagree with, and call out shared blind spots in the threat model. End with PASS or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  correlationId: "red-team-grok"
})
```

Poll every 60 seconds. Synthesize findings:

1. **Union all findings** — every finding from every LLM counts
2. **Deduplicate** — same issue found by multiple LLMs = high confidence
3. **Cross-validate unique findings** — issue found by only one LLM may be a false positive or a blind spot the others missed
4. **Verdict**: ALL must PASS for the assessment to pass. Any FAIL = fix and re-assess.

## Handling Deferred Responses

Red team assessments are thorough — expect auto-deferral at 45s.

```
// Response will likely be: status:"deferred", jobId:"..."
// Poll every 60 seconds (no wallclock timeout; cancel only on explicit instruction or hard failure):
llm_job_status({jobId: "[jobId]"})

// When completed:
llm_job_result({jobId: "[jobId]"})
```

Red-team jobs are **durable** (default 30-day retention, `LLM_GATEWAY_JOB_RETENTION_DAYS`). If your polling wrapper times out or restarts mid-assessment, fetch by `jobId` later, or re-issue the identical call — auto-dedup (default 1 h window, `LLM_GATEWAY_DEDUP_WINDOW_MS`) reattaches to the live job. This protects long-running adversarial sweeps from being silently restarted. Use `forceRefresh:true` only when the target code/config has actually changed.

## Triage Findings

| Severity | Action | Timeline |
|----------|--------|----------|
| Critical | Fix immediately, re-assess | Before any merge |
| High | Fix before shipping | Before release |
| Medium | Fix in current sprint | Scheduled |
| Low | Track, fix when convenient | Backlog |

## Blue Team Response

Every red team finding requires a blue team response. The blue team (a different LLM than the one that found the issue) produces a defensive remediation plan for each finding.

### Step 1: Collect Red Team Findings

After the red team assessment completes, structure the findings as a numbered list with severity and attack scenario.

### Step 2: Send to Blue Team LLM

Use a **different LLM** than the red teamer for the blue team response. This avoids confirmation bias — the defender shouldn't be the same model that found the attack.

| Red Teamer | Blue Team Responder | Why |
|------------|-------------------|-----|
| Gemini | Codex or Claude | Codex can implement fixes directly; Claude reasons about defense-in-depth |
| Codex | Claude or Gemini | Claude designs defensive architecture; Gemini validates against known mitigations |
| Claude | Codex or Gemini | Codex implements concrete patches; Gemini verifies against OWASP remediation guides |
| Grok | Codex or Claude | Same reasoning — pair with a model from a different vendor family to break confirmation bias |
| Multi-LLM | Use the strongest available for the fix domain | Match remediation LLM to the type of fix needed |

```
codex_request({
  prompt: "Blue team response to red team findings for [path/component].\n\nRed team findings:\n1. [Critical] [finding + attack scenario]\n2. [High] [finding + attack scenario]\n3. [Medium] [finding + attack scenario]\n...\n\nFor EACH finding, provide:\n- **Defense**: Specific code change or configuration fix\n- **Detection**: How to detect this attack in production (logging, monitoring, alerting)\n- **Prevention**: Architectural change to prevent this class of vulnerability\n- **Verification**: How to test that the fix works (test case or verification step)\n\nThen implement the fixes for all Critical and High findings. Include tests.",
  fullAuto: true,
  approvalStrategy: "mcp_managed",
  correlationId: "blue-team-response"
})
```

### Step 3: Blue Team Response Format

For each red team finding, the blue team must address all four dimensions:

```markdown
### Finding 1: [Red team finding title] (Critical)

**Red team**: [attack scenario summary]

**Defense**: [specific code/config change]
- File: [path]
- Change: [what to change and why]

**Detection**: [how to detect this attack in production]
- Log: [what to log]
- Alert: [what threshold triggers an alert]
- Monitor: [what metric to watch]

**Prevention**: [architectural change to prevent this class of vulnerability]
- [e.g., "Add input validation layer before all handlers"]
- [e.g., "Move secret rotation to vault with TTL"]

**Verification**: [how to prove the fix works]
- Test: [specific test case]
- Manual: [manual verification step]
```

### Step 4: Implement Blue Team Fixes

For Critical and High findings, the blue team LLM should implement fixes directly (not just describe them). Use Codex with `fullAuto: true` for implementation:

```
codex_request({
  prompt: "Implement the blue team fixes for Critical and High findings:\n\n1. [Defense for finding 1 — what to change in which file]\n2. [Defense for finding 2 — what to change in which file]\n\nAlso add:\n- Detection logging for each finding\n- Test cases verifying each fix\n\nDo not change Medium/Low findings — those are tracked for later.",
  fullAuto: true,
  approvalStrategy: "mcp_managed",
  correlationId: "blue-team-impl"
})
```

### Step 5: Re-assess (Red Team Verifies Blue Team)

Send the original red teamer back to verify the fixes are effective. Use the per-CLI snippet that matches your original red teamer — do **not** use a generic placeholder, because `fullAuto:true` is required for Codex and easy to miss if hidden in a comment.

**If the original red teamer was Codex:**

```
codex_request({
  prompt: "Re-assess security after blue team fixes.\n\nOriginal findings and blue team responses:\n1. [Critical] [finding] — Blue team fix: [what changed]\n2. [High] [finding] — Blue team fix: [what changed]\n\nVerify:\n- Are the fixes effective against the original attack scenarios?\n- Did the fixes introduce new vulnerabilities?\n- Are the detection/monitoring additions adequate?\n\nEnd with PASS or FAIL with findings.",
  fullAuto: true,
  approvalStrategy: "mcp_managed"
})
```

**If the original red teamer was Gemini:**

```
gemini_request({
  prompt: "Re-assess security after blue team fixes.\n\nOriginal findings and blue team responses:\n1. [Critical] [finding] — Blue team fix: [what changed]\n2. [High] [finding] — Blue team fix: [what changed]\n\nVerify:\n- Are the fixes effective against the original attack scenarios?\n- Did the fixes introduce new vulnerabilities?\n- Are the detection/monitoring additions adequate?\n\nEnd with PASS or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  mcpServers: ["sqry", "exa", "ref_tools"]
})
```

**If the original red teamer was Claude:**

```
claude_request({
  prompt: "Re-assess security after blue team fixes.\n\nOriginal findings and blue team responses:\n1. [Critical] [finding] — Blue team fix: [what changed]\n2. [High] [finding] — Blue team fix: [what changed]\n\nVerify:\n- Are the fixes effective against the original attack scenarios?\n- Did the fixes introduce new vulnerabilities?\n- Are the detection/monitoring additions adequate?\n\nEnd with PASS or FAIL with findings.",
  approvalStrategy: "mcp_managed",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"]
})
```

**If the original red teamer was Grok:**

```
grok_request({
  prompt: "Re-assess security after blue team fixes.\n\nOriginal findings and blue team responses:\n1. [Critical] [finding] — Blue team fix: [what changed]\n2. [High] [finding] — Blue team fix: [what changed]\n\nVerify:\n- Are the fixes effective against the original attack scenarios?\n- Did the fixes introduce new vulnerabilities?\n- Are the detection/monitoring additions adequate?\n\nEnd with PASS or FAIL with findings.",
  approvalStrategy: "mcp_managed"
})
```

For multi-LLM red teams, re-submit to ALL original reviewers after blue team fixes.

## Full Red/Blue Cycle

```
1. Red Team (one or more LLMs)     → findings with attack scenarios
2. Blue Team (different LLM)       → defense + detection + prevention + verification per finding
3. Blue Team Implementation        → code fixes for Critical/High
4. Red Team Re-assess              → verify fixes, check for regressions
5. Iterate until all red teamers PASS
```

## Assessment Templates

### API Security

```
Red team the API at [path].
- Authentication mechanism: [type]
- Authorization model: [RBAC/ABAC/etc]
- Data sensitivity: [PII/financial/health/etc]

Focus on: auth bypass, privilege escalation, rate limiting, input validation, error information leakage.
```

### Data Pipeline

```
Red team the data pipeline at [path].
- Data sources: [list]
- Data sinks: [list]
- Sensitive fields: [list]

Focus on: injection at ingestion, data leakage in logs/errors, access control on sinks, encryption at rest/transit.
```

### Infrastructure / Configuration

```
Red team the configuration at [path].
- Environment: [dev/staging/prod]
- Exposed services: [list]

Focus on: default credentials, exposed debug endpoints, misconfigured CORS/CSP, secrets in config, overly permissive IAM.
```

## MCP Tool Usage During Assessment

The reviewer should use these MCP tools:

| Tool | Purpose |
|------|---------|
| **sqry** | Semantic code search — find all callers of a function, trace data flow, find similar patterns |
| **exa** | Web search — look up CVEs for dependencies, find known vulnerability patterns |
| **ref_tools** | Documentation — check framework security docs, verify best practices |

## Tips

- Omit `model` by default — let the gateway default apply. Only nominate a specific variant when the caller has explicitly asked for it.
- Include `mcpServers: ["sqry", "exa", "ref_tools"]` for research-heavy assessments. Claude gets a generated MCP config, Gemini gets allowed server names for its existing MCP config, and Codex/Grok treat this as approval tracking while using their own MCP config.
- Provide context about data sensitivity and threat model — generic assessments miss domain-specific risks
- Red team assessments are expensive but catch issues that code review misses
- Use `correlationId` for tracing: `"red-team-r1-claude"`, `"red-team-r1-codex"`, `"red-team-r1-gemini"`, `"red-team-r1-grok"`
- For large codebases, scope to specific components rather than "audit everything"
- Multi-LLM red teams find more issues but cost 3–4x — use for critical security paths. Adding Grok specifically defends against shared blind spots across the Anthropic/OpenAI/Google family.
- Single-LLM is fine for routine security checks
- Use `approvalStrategy: "mcp_managed"` as the skill default; add `fullAuto: true` for Codex — do not use raw `dangerouslyBypassApprovalsAndSandbox` for red-team work
- For multi-round red/blue cycles, pass `resumeLatest:true` (or `sessionId:<UUID>`) to Codex on the re-assess step so it carries the original threat model into the verification. Note: `--full-auto` is dropped on Codex resume — the original session's approval policy is inherited.
- **Durable assessment results** (default 30 days, `LLM_GATEWAY_JOB_RETENTION_DAYS`) mean you can complete a red/blue cycle hours or days later from where you left off; jobs are not lost when the orchestrator dies or polling times out.
