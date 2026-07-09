# llm-cli-gateway for coding-agent orchestration

This guide shows how to use `llm-cli-gateway` as a local-first MCP control
plane for AI coding agents. It is written for teams comparing direct provider
CLI usage, LLM API proxies, and MCP-based orchestration.

`llm-cli-gateway` is not an OpenAI-compatible API proxy. It wraps installed
coding-agent CLIs and configured API providers behind MCP tools, so supported
clients can operate Claude Code, Codex, Gemini/Antigravity, Grok Build, Mistral
Vibe, Devin, Cursor Agent, and optional HTTP API providers through one gateway.

## Overview

Direct coding-agent use is simple: each CLI runs locally, uses its own
credentials, and reads the current workspace. That works for one agent, but it
gets harder when a user wants cross-model review, durable background jobs,
shared approval gates, remote access, or consistent audit trails.

`llm-cli-gateway` adds a control plane without flattening provider CLIs into a
generic chat API:

- Provider CLIs keep native login, session, model, tool, and filesystem behavior.
- MCP clients get one tool surface for provider requests, async jobs, sessions,
  workspaces, validation, and approval review.
- Remote HTTP mode adds bearer or OAuth authentication and principal-scoped
  access control.
- Durable stores let long-running jobs survive disconnects and gateway restarts.

## Architecture

### Direct provider CLI access

```text
MCP client or terminal
  -> claude / codex / agy / grok / vibe / devin / cursor-agent
  -> provider account and local workspace
```

Direct access is appropriate when one user runs one provider and does not need
cross-model orchestration or durable job recovery.

Limitations:

- No common API for asking several providers to review the same change.
- No shared async job queue or recovery surface.
- No central approval decision log across provider CLIs.
- Remote access has to be solved separately for each client and provider.
- Provider sessions and worktrees are hard to inspect from a different client.

### LLM API proxy access

```text
Coding agent CLI
  -> OpenAI-compatible or provider-compatible proxy
  -> model APIs
```

API proxies are useful for provider-key centralization, model fallback, and cost
tracking when the client can speak the proxy's protocol. They are a different
layer from `llm-cli-gateway`.

Use an API proxy when the main problem is model API routing. Use
`llm-cli-gateway` when the main problem is operating coding-agent CLIs,
sessions, workspaces, approvals, and review workflows through MCP.

### llm-cli-gateway MCP control plane

```text
MCP client
  -> llm-cli-gateway
    -> claude_request / codex_request / gemini_request / ...
    -> *_request_async + llm_job_result
    -> session_* and workspace_*
    -> consensus_check / red_team_review / compare_answers
  -> installed provider CLIs or configured API providers
```

This keeps provider-specific execution intact while giving MCP clients a stable
control plane.

## Quickstart

Install and start the local stdio MCP server:

```bash
npx -y llm-cli-gateway
```

For MCP clients that accept a command config:

```json
{
  "command": "npx",
  "args": ["-y", "llm-cli-gateway"]
}
```

The MCP Registry name is:

```text
io.github.verivus-oss/llm-cli-gateway
```

## Remote HTTP mode

HTTP mode is opt-in:

```bash
LLM_GATEWAY_AUTH_TOKEN="$(openssl rand -hex 32)" llm-cli-gateway --transport=http
```

Default endpoint:

```text
http://127.0.0.1:3333/mcp
```

Remote HTTP supports static bearer tokens and built-in OAuth 2.0 with PKCE.
Remote provider calls require registered workspace aliases so callers cannot
pass arbitrary host paths.

OAuth scopes:

- `mcp:read` - list tools and read public metadata.
- `mcp:call` - call MCP tools.
- `workspace:read` - read workspace aliases.
- `workspace:admin` - register or create workspace aliases.
- `approval:read` - inspect MCP-managed approval decisions.
- `provider:admin` - run gated provider administration tools.

## Configured API providers

`llm-cli-gateway` can also expose configured HTTP API providers as MCP tools.
Provider API keys are read from named environment variables at request time.
They are not written into config, persisted payloads, dedup keys, diagnostics,
logs, or the flight recorder.

The generated tool names use the provider name:

```text
api_<name>_request
api_<name>_request_async
```

Use configured API providers when a review workflow needs model API calls
alongside local provider CLI calls.

## Workflow: cross-model review

1. Ask one model to implement or inspect a change.
2. Ask two or more other models to review the result.
3. Compare findings locally.
4. Fix material issues.
5. Repeat until reviewers approve and local tests pass.

Example MCP calls:

```text
codex_request({
  prompt: "Implement the endpoint validation change and run the relevant tests."
})

consensus_check({
  models: ["claude", "gemini", "grok"],
  claim: "The patch preserves remote workspace isolation and validates generated aliases."
})

compare_answers({
  question: "Which findings are material blockers?",
  answers: [...]
})
```

For long-running work:

```text
claude_request_async({
  prompt: "Review the auth surface and return file:line findings."
})

llm_job_status({ jobId: "..." })
llm_job_result({ jobId: "..." })
```

## Workflow: remote client with registered workspace

Register a workspace on the gateway host:

```bash
LLM_GATEWAY_WORKSPACE_ADMIN=1 llm-cli-gateway workspace add app /path/to/repo --default
```

Then remote callers can invoke provider tools against the alias instead of a raw
host path:

```text
codex_request({
  workspace: "app",
  prompt: "Inspect the failing test and propose the smallest fix."
})
```

This is intentionally stricter than local stdio. Local callers can pass native
provider path controls directly; remote callers use registered aliases.

## Tool families

Read the generated tool index at <https://llm-cli-gateway.dev/tools.md>.

Important families:

- Provider requests: `claude_request`, `codex_request`, `gemini_request`,
  `grok_request`, `mistral_request`, `devin_request`, `cursor_request`.
- Durable jobs: `*_request_async`, `llm_job_status`, `llm_job_result`,
  `llm_job_cancel`.
- Sessions: `session_create`, `session_list`, `session_get`,
  `session_set_active`, `session_delete`, `session_clear_all`.
- Workspaces: `workspace_create`, `workspace_list`, `workspace_get`,
  `workspace_register_existing_repo`.
- Review: `consensus_check`, `red_team_review`, `second_opinion`,
  `validate_with_models`, `compare_answers`.
- Operations: `approval_list`, `llm_process_health`, `cli_versions`,
  `upstream_contracts`, `provider_tool_capabilities`.

## Comparison

| Capability | Direct provider CLIs | LLM API proxy | llm-cli-gateway |
| --- | --- | --- | --- |
| Native coding-agent sessions | yes | usually no | yes |
| MCP tool surface | no | usually no | yes |
| Cross-model review workflow | manual | model API only | built in |
| Durable async jobs | per CLI, if available | proxy dependent | built in |
| Remote workspace scoping | no | no | yes |
| OAuth for remote MCP | no | proxy dependent | yes |
| Provider CLI admin introspection | manual | no | yes |
| OpenAPI description | no | often yes | HTTP MCP transport only |

## Best practices

1. Use stdio first. It keeps the gateway local and avoids remote auth concerns.
2. Use HTTP only when a remote client needs it, and always configure bearer or
   OAuth authentication.
3. Register workspaces before remote provider calls.
4. Use async tools for long reviews, large refactors, and slow provider runs.
5. Keep provider credentials in provider CLIs or named environment variables.
6. Use `consensus_check` and `red_team_review` as review gates, not as proof by
   themselves; local tests still decide whether a change is shippable.

## Troubleshooting

- Run `llm-cli-gateway doctor --json` for environment diagnostics.
- Use `cli_versions` to check installed provider CLIs and login status.
- Use `llm_process_health` to inspect persistence and async job state.
- Use `workspace_list` and `workspace_get` to debug remote workspace aliases.
- Use `provider_tool_capabilities` to see provider-specific feature support.

## FAQ

### Is llm-cli-gateway a hosted service?

No. It is self-hosted open-source software. The website publishes docs and
machine-readable metadata; the gateway runs on the user's machine or
infrastructure.

### Does it replace LiteLLM or other API proxies?

No. API proxies solve model API routing. `llm-cli-gateway` solves MCP access to
coding-agent CLIs, durable jobs, sessions, workspaces, approval review, and
cross-model workflows. The layers can be combined when a provider CLI or API
provider is configured to use an upstream proxy.

### Does remote HTTP expose my filesystem?

Remote provider calls require registered workspace aliases. This prevents a
remote caller from passing arbitrary host paths.

### Where is the API schema?

The HTTP MCP transport has an OpenAPI description at
<https://llm-cli-gateway.dev/openapi.json>. The runtime MCP tool list is at
<https://llm-cli-gateway.dev/tools.md>.
