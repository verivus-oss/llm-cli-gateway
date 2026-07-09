# llm-cli-gateway agent guide

llm-cli-gateway is a local-first MCP server for operating coding-agent CLIs and
configured API providers through one control plane. Use it when an MCP client
needs cross-model review, provider CLI session continuity, durable async jobs,
or a single approval and audit surface.

## When to use

- Ask Claude Code, Codex, Gemini/Antigravity, Grok Build, Mistral Vibe, Devin,
  Cursor Agent, or configured API providers from one MCP client.
- Run cross-model validation with `consensus_check`, `compare_answers`,
  `second_opinion`, or `red_team_review`.
- Start long-running provider work with `*_request_async` and recover it later
  with `llm_job_result`.
- Reuse provider-native sessions through `session_create`, `session_get`, and
  provider-specific resume support.
- Expose the gateway over local stdio by default, or HTTP when a remote client
  needs it and authentication is configured.

## When not to use

- Do not use the HTTP transport without bearer or OAuth authentication.
- Do not use remote provider calls without a registered workspace.
- Do not treat the gateway as a hosted model API replacement; provider CLIs keep
  their own credentials, tools, files, and session semantics.
- Do not put API key values in config. Configured API providers read keys from
  named environment variables at request time.

## Install task for agents

Read <https://llm-cli-gateway.dev/install.md> and configure the current MCP
client to launch:

```bash
npx -y llm-cli-gateway
```

Use stdio transport unless the user explicitly asks for remote HTTP.

## Local stdio setup

The default command is:

```json
{
  "command": "npx",
  "args": ["-y", "llm-cli-gateway"]
}
```

The MCP Registry name is `io.github.verivus-oss/llm-cli-gateway`.

## Remote HTTP setup

HTTP transport is opt-in:

```bash
LLM_GATEWAY_AUTH_TOKEN=your-long-random-token llm-cli-gateway --transport=http
```

The default endpoint is `http://127.0.0.1:3333/mcp`. Remote HTTP supports a
static bearer token or built-in OAuth 2.0 with PKCE. Remote calls are
principal-scoped: one caller cannot read another caller's sessions, jobs, or
stored requests.

Remote provider calls require a registered workspace. Local stdio callers can
pass local `workingDir`, `addDir`, or provider-native path controls directly.

## Security model

- stdout is reserved for MCP JSON-RPC; gateway diagnostics use stderr.
- Async job stores persist prompts and results; treat SQLite or Postgres stores
  as sensitive at rest.
- API provider keys are resolved from environment variables and excluded from
  persisted payloads, dedup keys, logs, diagnostics, and the flight recorder.
- Dangerous remote OAuth configurations fail closed.
- Approval decisions are inspectable through `approval_list`.

## Tool families

See <https://llm-cli-gateway.dev/tools.md> for the runtime-derived public MCP
tool index. Common families:

- Provider requests: `claude_request`, `codex_request`, `gemini_request`,
  `grok_request`, `mistral_request`, `devin_request`, `cursor_request`, and
  async variants.
- Async jobs: `llm_job_status`, `llm_job_result`, `llm_job_cancel`,
  `llm_request_result`.
- Sessions: `session_create`, `session_list`, `session_set_active`,
  `session_get`, `session_delete`, `session_clear_all`.
- Review and validation: `consensus_check`, `compare_answers`,
  `red_team_review`, `second_opinion`, `validate_with_models`.
- Workspaces: `workspace_create`, `workspace_list`, `workspace_get`,
  `workspace_register_existing_repo`.

## Common workflows

- Cross-model review: <https://llm-cli-gateway.dev/workflows/cross-model-review.md>
- Short install spec: <https://llm-cli-gateway.dev/install.md>
- Runtime tool index: <https://llm-cli-gateway.dev/tools.md>

## Troubleshooting

- Run `llm-cli-gateway doctor --json` for local configuration diagnostics.
- Use `cli_versions` to inspect installed provider CLIs.
- Use `llm_process_health` to inspect async-job manager state and persistence.
- If a remote call cannot access files, register or select a workspace instead
  of trying to pass arbitrary host paths.
- If an async job is interrupted, poll `llm_job_status` and fetch the result with
  `llm_job_result`.

## Machine-readable resources

- Agent metadata: <https://llm-cli-gateway.dev/.well-known/agent.json>
- MCP server card: <https://llm-cli-gateway.dev/.well-known/mcp/server-card.json>
- API catalog: <https://llm-cli-gateway.dev/.well-known/api-catalog>
- Compatibility AI catalog: <https://llm-cli-gateway.dev/.well-known/ai-catalog.json>
- Integration declaration: <https://llm-cli-gateway.dev/.well-known/integrations.json>
- Sitemap: <https://llm-cli-gateway.dev/sitemap.md>
- Repository: <https://github.com/verivus-oss/llm-cli-gateway>
- npm package: <https://www.npmjs.com/package/llm-cli-gateway>
