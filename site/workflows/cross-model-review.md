# Cross-model review workflow

This deterministic transcript shows the intended shape of a review workflow. It
uses redacted output so the page remains stable while the runtime tool names are
checked against the generated tool fixture.

## 1. Start the gateway

```bash
npx -y llm-cli-gateway
```

The MCP client connects over stdio.

## 2. Ask several models to review a claim

```text
> consensus_check({
    models: ["claude", "codex", "gemini"],
    claim: "The patch preserves principal isolation for HTTP callers."
  })
```

Deterministic transcript:

```text
claude_request: APPROVED with caveat about workspace registration
codex_request: CHANGES_REQUIRED, asks for regression test coverage
gemini_request: APPROVED, flags no additional security issue
result: disagreement summarized for human review
```

## 3. Start a long-running provider request

```text
> claude_request_async({
    prompt: "Review the auth changes and return JSON findings."
  })
```

Deterministic transcript:

```text
jobId: 1f0c9a2e-redacted
status: running
persisted: SQLite by default, Postgres when configured
```

## 4. Recover the result

```text
> llm_job_status({ jobId: "1f0c9a2e-redacted" })
```

```text
status: completed
```

```text
> llm_job_result({ jobId: "1f0c9a2e-redacted" })
```

```text
complete: result recovered after gateway restart
summary: one model requested tests; two models approved after caveats
```

## 5. Inspect the decision

Use the disagreement summary as review evidence. If a reviewer finds a material
issue, fix it and run another review round. If all reviewers approve, keep the
receipt or persisted request reference with the change record.

Related references:

- Full agent guide: <https://llm-cli-gateway.dev/agents.md>
- Runtime tool index: <https://llm-cli-gateway.dev/tools.md>
- Install guide: <https://llm-cli-gateway.dev/install.md>
