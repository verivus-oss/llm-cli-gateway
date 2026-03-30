---
name: gemini-red-team
description: Get a red team security assessment from Gemini with full tool access including sqry, exa, and ref MCP tools. Use when you need adversarial security analysis of code, architecture, or configurations.
---

# Gemini Red Team Assessment

Submit code, designs, or configurations to Gemini for adversarial security analysis. Gemini gets full tool access to read code, search the web for known vulnerabilities, and check documentation.

## When to Use

- Before shipping security-sensitive code (auth, crypto, data handling)
- After implementing access control or permission systems
- When changing API surfaces or data models
- For threat modeling of new architectures
- When you want an adversarial perspective ("how would I break this?")

## Protocol

### Step 1: Submit to Gemini with Full Access

```
gemini_request({
  prompt: "Red team security assessment of [path/component].\n\nContext: [what it does, who uses it, what data it handles]\n\nYou have full tool access. Read the code directly. Use sqry for semantic search across the codebase. Use exa for known CVEs and vulnerability patterns. Use ref for framework-specific security docs.\n\nAssess:\n1. Attack surface analysis — what can an attacker reach?\n2. Input validation gaps — what inputs are trusted but shouldn't be?\n3. Authentication/authorization bypasses\n4. Data exposure risks (logs, errors, side channels)\n5. Dependency risks (known CVEs, supply chain)\n6. Race conditions and state management\n7. Injection vectors (SQL, command, template, path traversal)\n8. Cryptographic misuse\n\nFor each finding: severity (critical/high/medium/low), attack scenario, and recommended fix.\n\nEnd with PASS (no critical/high findings) or FAIL (critical/high findings exist).",
  model: "gemini-2.5-pro",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"]
})
```

### Step 2: Handle Deferred Response

Red team assessments are thorough — expect auto-deferral at 45s.

```
// Response will likely be: status:"deferred", jobId:"..."
// Poll every 90 seconds:
llm_job_status({jobId: "[jobId]"})

// When completed:
llm_job_result({jobId: "[jobId]"})
```

### Step 3: Triage Findings

| Severity | Action | Timeline |
|----------|--------|----------|
| Critical | Fix immediately, re-assess | Before any merge |
| High | Fix before shipping | Before release |
| Medium | Fix in current sprint | Scheduled |
| Low | Track, fix when convenient | Backlog |

### Step 4: Re-assess After Fixes (if FAIL)

```
gemini_request({
  prompt: "Re-assess security after fixes.\n\nPrevious findings:\n1. [Critical] [issue] — Fixed by: [what changed]\n2. [High] [issue] — Fixed by: [what changed]\n\nVerify fixes are effective. Check for regressions. PASS or FAIL.",
  model: "gemini-2.5-pro",
  mcpServers: ["sqry", "exa", "ref_tools"],
  allowedTools: ["Read", "Grep", "Glob", "Bash"]
})
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

## MCP Tool Usage

Gemini should use these MCP tools during assessment:

| Tool | Purpose |
|------|---------|
| **sqry** | Semantic code search — find all callers of a function, trace data flow, find similar patterns |
| **exa** | Web search — look up CVEs for dependencies, find known vulnerability patterns |
| **ref_tools** | Documentation — check framework security docs, verify best practices |

## Tips

- Always use `model: "gemini-2.5-pro"` for security assessments — it's the most thorough
- Include `mcpServers: ["sqry", "exa", "ref_tools"]` for full research capability
- Provide context about data sensitivity and threat model — generic assessments miss domain-specific risks
- Red team assessments are expensive but catch issues that code review misses
- Use `correlationId` for tracing: `"red-team-r1"`, `"red-team-r2"`
- For large codebases, scope to specific components rather than "audit everything"
