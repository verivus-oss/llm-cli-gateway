# llm-cli-gateway tools

> Runtime-derived public MCP tool index for llm-cli-gateway.

This file is generated from the gateway's actual MCP `tools/list` response, not from source-code pattern matching. Update it with:

```bash
npm run site:generate
```

- Package: `llm-cli-gateway@2.15.0`
- Tool count: 52
- Source: runtime MCP tools/list from dist/index.js over in-memory MCP transport
- Capture command: `node scripts/generate-site-discovery.mjs`
- Generated at: deterministic build output

## Provider requests

- `claude_request` - Run a Claude Code CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.
- `claude_request_async` - Start a Claude Code CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.
- `codex_fork_session` - Fork an existing Codex session into a new branch (codex fork <ID|--last>) and run a prompt against the fork without mutating the original.
- `codex_request` - Run an OpenAI Codex CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.
- `codex_request_async` - Start an OpenAI Codex CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.
- `cursor_request` - Run a Cursor Agent CLI request synchronously (auto-defers to a pollable job past the sync deadline when async jobs are enabled; otherwise runs to completion). Headless print mode (`cursor-agent --print`).
- `cursor_request_async` - Start a Cursor Agent CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.
- `devin_request` - Run a Cognition Devin CLI request synchronously (auto-defers to a pollable job past the sync deadline when async jobs are enabled; otherwise runs to completion). Headless print mode (`devin -p`).
- `devin_request_async` - Start a Cognition Devin CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.
- `gemini_request` - Run a Google Antigravity CLI (`agy`) request through the Gemini-compatible gateway tool synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.
- `gemini_request_async` - Start a Google Antigravity CLI (`agy`) request as a durable background job through the Gemini-compatible gateway tool. Poll with llm_job_status, collect with llm_job_result.
- `grok_request` - Run an xAI Grok CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts.
- `grok_request_async` - Start an xAI Grok CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.
- `mistral_request` - Run a Mistral Vibe CLI request synchronously (when async jobs are enabled, auto-defers to a pollable job past the sync deadline; otherwise runs to completion). Requires exactly one of prompt or promptParts. Defaults to --agent accept-edits (auto-accepts file edits; dangerous ops such as shell stay gated); pass permissionMode auto-approve (or set LLM_GATEWAY_APPROVAL_ALLOW_BYPASS) for unattended tool execution.
- `mistral_request_async` - Start a Mistral Vibe CLI request as a durable background job. Poll with llm_job_status, collect with llm_job_result.

## Async jobs

- `llm_job_cancel` - Cancel a running gateway async or deferred-sync job by jobId.
- `llm_job_result` - Retrieve captured stdout/stderr for a gateway async or deferred-sync job by jobId.
- `llm_job_status` - Check lifecycle status (queued|running|completed|failed|canceled|orphaned) of a gateway async or deferred-sync job by jobId.
- `llm_request_result` - Read back any persisted request (sync or async) from the flight recorder by correlationId, including prompt and response.

## Sessions

- `session_clear_all` - Delete all gateway session records, optionally scoped to one provider.
- `session_create` - Create a gateway session record for a provider. NOTE: this is gateway bookkeeping (a plain UUID), not a provider-native session; Codex resume needs a real Codex UUID.
- `session_delete` - Delete a gateway session record by ID (also removes any gateway-owned worktree attached to it).
- `session_get` - Get one gateway session record by session ID, including recent request history when available.
- `session_list` - List gateway session records and the active session per provider, optionally filtered by provider.
- `session_set_active` - Set or clear the active session for a provider; the active session is used when a request omits sessionId.

## Validation and review

- `ask_model` - Ask one provider CLI a question through the simplified validation surface (starts a validation job).
- `compare_answers` - Summarize agreement/differences between caller-provided answers LOCALLY — does not call any provider.
- `consensus_check` - Ask provider CLIs whether they agree or disagree with a claim (starts validation jobs).
- `job_result` - Collect a VALIDATION job's normalized provider output — distinct from llm_job_result, which returns raw provider request job output.
- `job_status` - Check a VALIDATION job's status (jobs started by validate_with_models/ask_model/etc.) — distinct from llm_job_status, which tracks provider request jobs.
- `list_available_models` - List models and capabilities for every available provider CLI (takes no arguments; complements per-provider list_models).
- `red_team_review` - Challenge a plan, answer, or document for risks and failure modes via provider CLIs (starts validation jobs).
- `second_opinion` - Ask one provider CLI to review an answer (starts a validation job; poll job_status, collect job_result).
- `synthesize_validation` - Run an explicit judge model over already-collected validation results to produce a synthesis.
- `validate_with_models` - Ask two or more provider CLIs to independently validate a question. Starts validation jobs — poll with job_status, collect with job_result (not llm_job_*).

## Workspaces

- `workspace_create` - Create a remote HTTP/OAuth workspace alias by creating a new local folder or git repo under a configured allowed root. Not for stdio/local provider path access. Requires LLM_GATEWAY_WORKSPACE_ADMIN=1 and OAuth scope workspace:admin.
- `workspace_get` - Inspect a registered remote HTTP/OAuth workspace alias. Does not list files. Not needed for stdio/local provider calls; do not use workspace_* tools to fix local path access.
- `workspace_list` - List registered workspace aliases for remote HTTP/OAuth provider calls. Does not browse files. Stdio/local callers should not use workspace_* tools to fix provider path access; pass local workingDir/addDir/includeDirs directly.
- `workspace_register_existing_repo` - Register an existing local Git repo as a remote HTTP/OAuth workspace alias. Not for stdio/local provider path access. Requires LLM_GATEWAY_WORKSPACE_ADMIN=1 and OAuth scope workspace:admin.

## Provider introspection

- `provider_admin_list` - List provider CLI admin operations (auth status, model list, mcp list, plugin list, doctor, etc.) available on the installed CLIs, projected from runtime discovery. Read-only.
- `provider_admin_mutate` - Execute a MUTATING provider CLI admin operation (mcp add/remove, login/logout, plugin install/remove, session delete/archive, ...). Disabled unless [admin] allow_mutating_cli_admin_ops=true; routed through approval and audited.
- `provider_admin_run` - Execute a READ-ONLY provider CLI admin operation (from provider_admin_list) and return redacted output. Rejects mutating operations.
- `provider_subcommand_contract` - Return the detailed read-only contract for exactly one declared provider CLI subcommand.
- `provider_subcommand_drift` - Probe declared provider subcommand --help surfaces and return compact drift rows without raw help output.
- `provider_subcommands_list` - Return a compact, filterable read-only catalog of declared provider CLI subcommands without flags or raw help.
- `provider_tool_capabilities` - Report provider tool/feature capabilities and discovered local skill/tool integrations for claude|codex|gemini|grok|mistral|devin|cursor|grok_api, or an enabled API provider name.

## Operations

- `approval_list` - List recent MCP-managed approval decisions recorded by the gateway (approvalStrategy: mcp_managed).
- `cli_upgrade` - Plan (dryRun, default true) or execute an upgrade for one provider CLI using its native update mechanism.
- `cli_versions` - Report installed provider CLI versions, availability, and login status for all registered CLI providers (claude|codex|gemini|grok|mistral|devin|cursor) or one.
- `list_models` - List models, aliases, and defaults for one provider (claude|codex|gemini|grok|mistral|devin|cursor, or an enabled API provider name), or omit cli to list all providers. API providers are returned under an `apiProviders` array.
- `llm_process_health` - Report gateway process health: async-job manager state plus the resolved persistence configuration and paths.
- `upstream_contracts` - Return the gateway's declared provider CLI contracts; with probeInstalled true, diff against installed --help surfaces to detect flag drift.
