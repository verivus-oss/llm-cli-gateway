---
name: red-team-assessment
description: Get an adversarial red team security assessment from any LLM (Claude, Codex, or Gemini) with full tool access including sqry, exa, and ref MCP tools. Use when you need adversarial security analysis of code, architecture, or configurations.
---

# Red Team Assessment

Submit code, designs, or configurations to one or more LLMs for adversarial security analysis. The reviewer gets full tool access to read code, search the web for known vulnerabilities, and check documentation.

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

For maximum coverage, use **multiple LLMs in parallel** (see Multi-LLM Red Team below).

## Single-LLM Red Team

### Using Gemini

```
gemini_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nYou have full tool access. Read the code directly. Use sqry for semantic search across the codebase. Use exa for known CVEs and vulnerability patterns. Use ref for framework-specific security docs.\n\nAssess:\n1. Attack surface analysis — what can an attacker reach?\n2. Input validation gaps — what inputs are trusted but shouldn't be?\n3. Authentication/authorization bypasses\n4. Data exposure risks (logs, errors, side channels)\n5. Dependency risks (known CVEs, supply chain)\n6. Race conditions and state management\n7. Injection vectors (SQL, command, template, path traversal)\n8. Cryptographic misuse\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL (critical/high findings exist).",
  model: "gemini-2.5-pro",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"]
})
```

### Using Codex

```
codex_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nYou have full tool access. Read the code, run tests, trace execution paths. Use sqry for semantic code search and call graph analysis.\n\nAssess:\n1. Attack surface analysis\n2. Input validation gaps\n3. Authentication/authorization bypasses\n4. Race conditions and state management issues\n5. Logic vulnerabilities that could be exploited\n6. Injection vectors\n7. Error handling that leaks information\n8. Test coverage gaps in security-critical paths\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL (critical/high findings exist).",
  fullAuto: true
})
```

### Using Claude

```
claude_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nYou have full tool access. Read the code directly. Use sqry for semantic search. Use exa for known vulnerability patterns. Use ref for security documentation.\n\nAssess:\n1. Trust boundary analysis — where does trusted meet untrusted?\n2. Attack surface analysis\n3. Authentication/authorization design flaws\n4. Data flow risks — where does sensitive data go?\n5. Dependency and supply chain risks\n6. Cryptographic design issues\n7. Injection vectors\n8. Failure mode analysis — what happens when things break?\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL (critical/high findings exist).",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"]
})
```

## Multi-LLM Red Team (Maximum Coverage)

For critical security reviews, run all three in parallel. Each LLM catches different classes of vulnerabilities.

```
claude_request_async({
  prompt: "Red team [path]. Focus on architecture-level threats: trust boundaries, data flow, design flaws, failure modes. PASS or FAIL with findings.",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  correlationId: "red-team-claude"
})

codex_request_async({
  prompt: "Red team [path]. Focus on implementation-level threats: logic bugs, race conditions, injection, error handling, test gaps. PASS or FAIL with findings.",
  fullAuto: true,
  correlationId: "red-team-codex"
})

gemini_request_async({
  prompt: "Red team [path]. Focus on known vulnerability patterns: OWASP Top 10, CVEs in dependencies, crypto misuse, data exposure. PASS or FAIL with findings.",
  model: "gemini-2.5-pro",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"],
  correlationId: "red-team-gemini"
})
```

Poll all three every 90 seconds. Synthesize findings:

1. **Union all findings** — every finding from every LLM counts
2. **Deduplicate** — same issue found by multiple LLMs = high confidence
3. **Cross-validate unique findings** — issue found by only one LLM may be a false positive or a blind spot the others missed
4. **Verdict**: ALL must PASS for the assessment to pass. Any FAIL = fix and re-assess.

## Handling Deferred Responses

Red team assessments are thorough — expect auto-deferral at 45s.

```
// Response will likely be: status:"deferred", jobId:"..."
// Poll every 90 seconds:
llm_job_status({jobId: "[jobId]"})

// When completed:
llm_job_result({jobId: "[jobId]"})
```

## Triage Findings

| Severity | Action | Timeline |
|----------|--------|----------|
| Critical | Fix immediately, re-assess | Before any merge |
| High | Fix before shipping | Before release |
| Medium | Fix in current sprint | Scheduled |
| Low | Track, fix when convenient | Backlog |

## Re-assess After Fixes

Use the same LLM(s) that found the issues:

```
[llm]_request({
  prompt: "Re-assess security after fixes.\n\nPrevious findings:\n1. [Critical] [issue] — Fixed by: [what changed]\n2. [High] [issue] — Fixed by: [what changed]\n\nVerify fixes are effective. Check for regressions. PASS or FAIL.",
  ...same tool access as original assessment...
})
```

For multi-LLM red teams, re-submit to ALL reviewers after fixes (not just the ones that found issues).

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

- For Gemini security assessments, use `model: "gemini-2.5-pro"` for maximum thoroughness
- Include `mcpServers: ["sqry", "exa", "ref_tools"]` for full research capability
- Provide context about data sensitivity and threat model — generic assessments miss domain-specific risks
- Red team assessments are expensive but catch issues that code review misses
- Use `correlationId` for tracing: `"red-team-r1-claude"`, `"red-team-r1-codex"`, `"red-team-r1-gemini"`
- For large codebases, scope to specific components rather than "audit everything"
- Multi-LLM red teams find more issues but cost 3x — use for critical security paths
- Single-LLM is fine for routine security checks
