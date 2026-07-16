# llm-cli-gateway agent guide

llm-cli-gateway is a local-first MCP server for operating coding-agent CLIs and
configured API providers through one control plane. Use it when an MCP client
needs cross-model review, provider CLI session continuity, durable async jobs,
or a single approval and audit surface.

## When to use

- Ask Claude Code, Codex, Gemini/Antigravity, Grok Build, Mistral Vibe, Devin,
  Cursor Agent, or configured API providers from one MCP client.
- Review a Git change with `review_changes`, or run general cross-model
  validation with `consensus_check`, `compare_answers`, `second_opinion`, or
  `red_team_review`.
- Start long-running provider work with `*_request_async` and recover it later
  with `llm_job_status`, `llm_job_watch`, and `llm_job_result`.
- Reuse provider-native sessions through `session_create`, `session_get`, and
  provider-specific resume support.
- Keep a single-developer instruction baseline in sync across workstations and
  repository overlays with Personal Agent Config Kit.
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
principal-scoped. OAuth or trusted-principal callers cannot read another
principal's sessions, jobs, or stored requests; callers sharing one static bearer
token deliberately share one principal and are not multi-tenant isolated.

Remote provider calls require a registered workspace. Non-Kit local stdio
callers can pass local `workingDir`, `addDir`, or provider-native path controls
directly. Claude requests made with Personal Agent Config Kit enabled are an
exception: the Kit rejects caller-supplied `workingDir`; use an already
configured registered `workspace` alias or the configured default workspace.
Kit scope never inherits the gateway process cwd.

An ordinary local CLI request with no resolved target runs in a fresh private
temporary cwd, not the gateway process repository. Select `workingDir` or a
registered `workspace` for repository-dependent work. A gateway worktree also
requires a selected registered workspace and never falls back to process cwd.
Cwd-scoped `resumeLatest` requests fail closed without a stable target.

## Security model

- stdout is reserved for MCP JSON-RPC; gateway diagnostics use stderr.
- Async job stores persist prompts and results; treat SQLite or Postgres stores
  as sensitive at rest.
- `review_changes` retains its exact fenced prompt in the expiry-bound job
  payload, stores only a hash marker in persisted argv, and does not copy the
  repository-review prompt into the flight recorder.
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
- Async jobs: `llm_job_status`, `llm_job_watch`, `llm_job_result`, `llm_job_cancel`,
  `llm_request_result`.
- Sessions: `session_create`, `session_list`, `session_set_active`,
  `session_get`, `session_delete`, `session_clear_all`.
- Review and validation: `review_changes`, `consensus_check`, `compare_answers`,
  `red_team_review`, `second_opinion`, `validate_with_models`.
- Workspaces: `workspace_create`, `workspace_list`, `workspace_get`,
  `workspace_register_existing_repo`.
- Personal Agent Config Kit, local-only: `config_init`, `config_publish`,
  `config_sync`, `config_status`, `config_rollback`, `config_ack_stale`,
  `config_recover_kit_attempt`, and `explain_effective_config`.

## Common workflows

- Cross-model review: <https://llm-cli-gateway.dev/workflows/cross-model-review.md>
- Personal Agent Config Kit: <https://llm-cli-gateway.dev/guides/personal-agent-config-kit.md>
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
- Page normalized progress with `afterProgressSeq`, or use `llm_job_watch` for a
  bounded long poll. Progress messages are privacy-safe activity, not raw
  reasoning or provider output.
- An argv-bound provider can reject a multibyte prompt as non-retryable
  `input_too_large`. The gateway never truncates instructions; narrow the input
  or choose a verified stdin, ACP, or HTTP path. Codex new and resume prompts
  use stdin. `codex_fork_session` remains argv-bound and rejects oversized
  UTF-8 prompts as non-retryable `input_too_large`. Every other
  caller-controlled argv value is also checked in its final encoded form,
  including serialized JSON and joined lists, before a provider can spawn. The
  resolved command line also has a conservative platform-specific aggregate
  byte budget and a 2,048-element cap. Native `E2BIG` remains a redacted
  fallback for environment and platform variance. Windows preflight assumes
  the smaller npm `.cmd`/`.bat` wrapper limit until resolution proves a native
  executable, and handler-added native session flags are admitted before
  workspace, session, provider-artifact handoff, or durable-job side effects on
  non-Kit requests. Claude Kit projects its eventual argv before compiled-context
  artifact materialization or durable Kit-session allocation. An embedded NUL
  byte in command or argv is rejected before spawn as non-retryable
  `invalid_input`; long-lived job memory, durable args, and async flight rows use
  a fixed invalid-argv marker, while the optional duplicate durable payload is
  suppressed. Public and retained fields omit the rejected vector and Node's
  value-echoing native message. Stdin-backed requests also
  require a successful complete-payload callback before a clean child exit can
  complete; closed or pending delivery becomes a fixed non-sensitive failure.
- For resumable large-output retrieval, use `llm_job_result` with
  `rawOutput:true` and its per-stream next offsets. Default display output is
  transformed and cannot resume from captured-stream offsets. Local stdio raw
  pages concatenate to captured streams; remote raw pages remain
  provider-session-ID-redacted. See the
  [technical guide](https://llm-cli-gateway.dev/guides/coding-agent-gateway-technical-guide.md#retrieve-large-job-output-safely).

## Machine-readable resources

- Agent metadata: <https://llm-cli-gateway.dev/.well-known/agent.json>
- MCP server card: <https://llm-cli-gateway.dev/.well-known/mcp/server-card.json>
- API catalog: <https://llm-cli-gateway.dev/.well-known/api-catalog>
- Compatibility AI catalog: <https://llm-cli-gateway.dev/.well-known/ai-catalog.json>
- Integration declaration: <https://llm-cli-gateway.dev/.well-known/integrations.json>
- Sitemap: <https://llm-cli-gateway.dev/sitemap.md>
- Repository: <https://github.com/verivus-oss/llm-cli-gateway>
- npm package: <https://www.npmjs.com/package/llm-cli-gateway>
