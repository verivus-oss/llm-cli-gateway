# llm-cli-gateway

> *"Without consultation, plans are frustrated, but with many counselors they succeed."*
> — Proverbs 15:22 (LSB)

A Model Context Protocol (MCP) server providing unified access to Claude Code, Codex, Gemini, and Grok CLIs with session management, retry logic, and async job orchestration.

## Personal MCP Appliance MVP

`llm-cli-gateway` is being packaged as a single-user personal MCP appliance for cross-LLM validation. The intended workflow is: connect one MCP endpoint, ask any client for cross-LLM validation.

The product contract is documented in [docs/personal-mcp/PRODUCT_CONTRACT.md](docs/personal-mcp/PRODUCT_CONTRACT.md). It defines the single-user scope, security posture, target support matrix, and provider-support verification gates. Public setup guides must not claim ChatGPT, Claude web, Claude Desktop, Codex, Gemini CLI, Gemini web, or Grok inbound support until the corresponding provider/client path has been verified.

This project does not provide hosted multi-tenant credential custody. Provider credentials stay on the user's machine or user-owned deployment volume.

MVP release readiness is tracked in [docs/personal-mcp/RELEASE_READINESS.md](docs/personal-mcp/RELEASE_READINESS.md). Dogfooding evidence (which target LLMs guided setup, what unsafe suggestions were captured, which findings are deferred to post-MVP work) is in [docs/personal-mcp/DOGFOODING_RESULTS.md](docs/personal-mcp/DOGFOODING_RESULTS.md).

Current personal-appliance artifacts include:

- Streamable HTTP startup: `LLM_GATEWAY_AUTH_TOKEN=<token> npm run start:http`
- Machine-readable diagnostics: `npm run doctor`
- Go bootstrapper scaffold: `installer/` with `setup`, `doctor --json`, `start`, `stop`, `status`, `repair`, `upgrade`, `uninstall`, `print-client-config`, and verified bundle download commands.
- Release packaging: the release workflow builds Linux binaries on the local self-hosted runner, builds Windows/macOS binaries on GitHub-hosted runners, then publishes checksummed platform bundles with the gateway, production dependencies, and a managed Node runtime; see [installer/packaging/README.md](installer/packaging/README.md).
- Docker Compose fallback: [docker-compose.personal.yml](docker-compose.personal.yml) + [Dockerfile.personal](Dockerfile.personal) for users who already manage containers.
- Local setup UI artifact: [setup/ui/index.html](setup/ui/index.html)
- Provider setup snippets: [setup/providers/](setup/providers/)
- Cross-validation tools: `validate_with_models`, `second_opinion`, `compare_answers`, `red_team_review`, `consensus_check`, `ask_model`, `synthesize_validation`, `job_status`, and `job_result`.

### Install / Upgrade / Uninstall (single binary)

Windows PowerShell:

```powershell
$Version = '<version>'
$Base = "https://github.com/verivus-oss/llm-cli-gateway/releases/download/v$Version"
$InstallDir = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'llm-cli-gateway'
$Exe = Join-Path $InstallDir 'llm-cli-gateway.exe'
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Invoke-WebRequest -UseBasicParsing "$Base/llm-cli-gateway-$Version-windows-amd64.exe" -OutFile $Exe
$env:RVWR_GATEWAY_BUNDLE_URL = "$Base/llm-cli-gateway-bundle-$Version-windows-amd64.tar.gz"
$env:RVWR_GATEWAY_BUNDLE_SHA256 = '<bundle-sha256-from-SHA256SUMS>'
& $Exe setup
& $Exe stop
& $Exe install-bundle
& $Exe start
& $Exe status
& $Exe doctor
```

The Windows installer keeps a stable `llm-cli-gateway.exe` command in
`%LOCALAPPDATA%\Programs\llm-cli-gateway` and adds that directory to the user
PATH. Do not script against release-versioned exe names after install.

```bash
# After downloading the binary that matches your OS/arch from a release:
sha256sum --check SHA256SUMS            # verify before run (or `shasum -a 256 --check` on macOS)
chmod +x llm-cli-gateway-<ver>-<os>-<arch>
./llm-cli-gateway-<ver>-<os>-<arch> setup
./llm-cli-gateway-<ver>-<os>-<arch> install-bundle    # uses the platform bundle URL/SHA256
./llm-cli-gateway-<ver>-<os>-<arch> start
./llm-cli-gateway-<ver>-<os>-<arch> doctor

# Upgrade: replace the binary, set the new bundle env vars, run upgrade.
./llm-cli-gateway-<new>-<os>-<arch> upgrade

# Uninstall: dry-run first, then run with --yes.
./llm-cli-gateway-<ver>-<os>-<arch> uninstall
./llm-cli-gateway-<ver>-<os>-<arch> uninstall --yes
```

Docker fallback:

```bash
LLM_GATEWAY_AUTH_TOKEN=$(openssl rand -hex 32) \
  docker compose -f docker-compose.personal.yml up -d
docker compose -f docker-compose.personal.yml run --rm doctor
```

## Features

### Core Capabilities
- **Multi-LLM Orchestration**: Unified interface for Claude Code, Codex, Gemini, and Grok CLIs
- **Session Management**: Track and resume conversations across all CLIs with persistent storage
- **Token Optimization**: Automatic 44% reduction on prompts, 37% on responses (opt-in)
- **Correlation ID Tracking**: Full request tracing across all LLM interactions
- **Cross-Tool Collaboration**: LLMs can use each other via MCP (validated through dogfooding)

### Observability
- **SQLite Flight Recorder**: Every request/response logged to `~/.llm-cli-gateway/logs.db` with correlation IDs, token usage, duration, retry counts, and circuit breaker state. Browse with [Datasette](https://datasette.io/): `datasette ~/.llm-cli-gateway/logs.db`
- **Structured Metadata**: Tool responses include machine-readable `structuredContent` (model, cli, correlationId, sessionId, durationMs, token counts)

### Reliability & Performance
- **Retry Logic**: Exponential backoff with circuit breaker for transient failures
- **Atomic File Writes**: Process-specific temp files with fsync for data integrity
- **Memory Limits**: 50MB cap on CLI output prevents DoS attacks
- **NVM Path Caching**: Eliminates I/O overhead on every request
- **Long-Running Jobs**: Non-time-bound async execution via `*_request_async` + polling tools

### Security & Quality
- **Comprehensive Testing**: 284 tests covering unit, integration, and regression scenarios
- **Input Validation**: Zod schemas prevent injection attacks
- **No Secret Leakage**: Generic session descriptions only (file permissions 0o600)
- **No ReDoS**: Bounded regex patterns prevent catastrophic backtracking
- **Type Safety**: Strict TypeScript with comprehensive error handling
- **221 Tests**: Unit, integration, and regression tests with real CLI execution

## Prerequisites

Before using this gateway, you need to install the CLI tools you want to use:

### Claude Code CLI
```bash
# Installation instructions for Claude Code
# Visit: https://docs.anthropic.com/claude-code
npm install -g @anthropic-ai/claude-code
```

### Codex CLI
```bash
npm install -g @openai/codex
codex login
```

### Gemini CLI
```bash
npm install -g @google/gemini-cli
# Or: https://github.com/google-gemini/gemini-cli
```

### Grok CLI (xAI)
```bash
npm install -g grok-build
grok login   # OAuth flow, or set GROK_CODE_XAI_API_KEY
# Docs: https://docs.x.ai/build/cli
```

### Mistral Vibe CLI
```bash
# Pick one — the gateway's cli_upgrade auto-detects which one you used.
pip install vibe-cli
uv tool install vibe-cli
brew install mistral-vibe

vibe auth login
# Required for `mistral_request --resume` / `--continue` to persist sessions:
vibe config set session_logging.enabled true   # or edit ~/.vibe/config.toml
```

Vibe-specific notes:

- **Model selection is via the `VIBE_ACTIVE_MODEL` environment variable** —
  Vibe has no `--model` flag. The gateway discovers `~/.vibe/config.toml` /
  `VIBE_MODELS`, injects `VIBE_ACTIVE_MODEL` only when a model is explicitly
  requested or Vibe config needs recovery, and retries once after a
  model-not-found failure with refreshed discovery.
- **`permissionMode` accepts** `default | plan | accept-edits | auto-approve |
  chat | explore | lean` and emits `--agent <mode>`. The gateway's
  programmatic-mode default is `auto-approve`; pick a stricter mode
  explicitly if you need approval gates.
- **`allowedTools` is allow-list only** — the gateway emits one
  `--enabled-tools <tool>` flag per entry. `disallowedTools` is accepted in
  the schema for caller-side parity but is silently ignored at the CLI
  boundary (a `logger.info` warning records the no-op).
- **No self-update**: `cli_upgrade --cli mistral` detects whether you used
  pip / uv / brew and dispatches the matching upgrade command. Running
  `vibe update` is not a thing.

## Installation

### As an MCP server (npm)
```bash
npm install -g llm-cli-gateway
```

Or use directly with `npx`:
```json
{
  "mcpServers": {
    "llm-gateway": {
      "command": "npx",
      "args": ["-y", "llm-cli-gateway"]
    }
  }
}
```

### From source
```bash
git clone https://github.com/verivus-oss/llm-cli-gateway.git
cd llm-cli-gateway
npm install
npm run build
```

## Usage

### As an MCP Server

For clients that already support local stdio MCP servers, add a configuration like:

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "command": "node",
      "args": ["/path/to/llm-cli-gateway/dist/index.js"]
    }
  }
}
```

This generic stdio example is not provider-support verification for the Personal MCP Appliance MVP. Client-specific setup guides for ChatGPT, Claude web, Claude Desktop, Codex, Gemini CLI, Gemini web, and Grok remain gated by the provider-support matrix in [docs/personal-mcp/PRODUCT_CONTRACT.md](docs/personal-mcp/PRODUCT_CONTRACT.md).

### Available Tools

#### Cross-LLM Validation Tools

The personal-appliance surface exposes simplified validation tools for non-developer clients. These tools start provider CLI jobs through the durable async job manager and return normalized provider status plus raw job references.

- `validate_with_models`: ask two or more providers to independently validate a question.
- `second_opinion`: ask one provider to review an answer.
- `red_team_review`: challenge a plan, answer, or document for risks and failure modes.
- `consensus_check`: check whether providers agree with a claim.
- `ask_model`: ask one provider through the simplified surface.
- `synthesize_validation`: run an explicit judge model after provider results have been collected.
- `job_status` and `job_result`: poll and collect validation job outputs.

The validation report preserves per-provider disagreement. Optional judge synthesis is explicit about which provider produced the judge job.

#### LLM Request Tools

##### `claude_request`
Execute a Claude Code request with optional session management.

**Parameters:**
- `prompt` (string, required): The prompt to send (1-100,000 chars)
- `model` (string, optional): Model name or alias (use `list_models` for available values; supports `latest`)
- `outputFormat` (string, optional): Output format ("text" or "json"), default: "text"
- `sessionId` (string, optional): Specific session ID to use
- `continueSession` (boolean, optional): Continue the active session
- `createNewSession` (boolean, optional): Always create a new session
- `allowedTools` (string[], optional): Restrict Claude tools to this allow-list
- `disallowedTools` (string[], optional): Explicitly deny listed Claude tools
- `dangerouslySkipPermissions` (boolean, optional): Request CLI-side permission bypass (legacy mode only)
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): Claude MCP servers to expose (default: `["sqry","exa","ref_tools"]`; `"trstr"` available as opt-in)
- `strictMcpConfig` (boolean, optional): Require Claude to use only supplied MCP config, default: true (request fails if any requested server is unavailable)
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency (44% reduction), default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency (37% reduction), default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)

**Response extras:**
- `approval`: Approval decision record when `approvalStrategy="mcp_managed"`
- `mcpServers`: Requested/enabled/missing MCP servers for this call

**Example:**
```json
{
  "prompt": "Write a Python function to calculate fibonacci numbers",
  "model": "sonnet",
  "continueSession": true,
  "optimizePrompt": true,
  "optimizeResponse": true
}
```

##### `codex_request`
Execute a Codex request with optional session tracking.

**Parameters:**
- `prompt` (string, required): The prompt to send (1-100,000 chars)
- `model` (string, optional): Model name or alias (use `list_models` for available values; supports `latest`, recommended: `gpt-5.4`)
- `fullAuto` (boolean, optional): Enable full-auto mode, default: false
- `dangerouslyBypassApprovalsAndSandbox` (boolean, optional): Request Codex bypass flags
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): MCP servers expected for Codex execution context
- `sessionId` (string, optional): Session identifier for tracking
- `createNewSession` (boolean, optional): Always create a new session
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency, default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (number, optional): Kill a stuck Codex process after output inactivity; 30,000 to 3,600,000 ms

**Response extras:**
- `approval`: Approval decision record when `approvalStrategy="mcp_managed"`
- `mcpServers`: Requested MCP servers for this call

**Example:**
```json
{
  "prompt": "Create a REST API endpoint",
  "model": "gpt-5.4",
  "fullAuto": true,
  "optimizePrompt": true
}
```

##### `gemini_request`
Execute a Gemini CLI request with session support.

**Parameters:**
- `prompt` (string, required): The prompt to send (1-100,000 chars)
- `model` (string, optional): Model name or alias (use `list_models` for available values; supports `latest`, `pro`, `flash`)
- `sessionId` (string, optional): Session ID to resume
- `resumeLatest` (boolean, optional): Resume the latest session automatically
- `createNewSession` (boolean, optional): Always create a new session
- `approvalMode` (string, optional): Gemini approval mode (`default|auto_edit|yolo`) in legacy mode
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): Allowed Gemini MCP server names
- `allowedTools` (string[], optional): Restrict Gemini tools to this allow-list
- `includeDirs` (string[], optional): Additional workspace directories for Gemini
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency, default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)

**Response extras:**
- `approval`: Approval decision record when `approvalStrategy="mcp_managed"`
- `mcpServers`: Requested MCP servers for this call

**Example:**
```json
{
  "prompt": "Explain quantum computing",
  "model": "latest",
  "resumeLatest": true,
  "optimizePrompt": true
}
```

##### `grok_request`
Execute a Grok CLI (xAI) request with session support.

**Parameters:**
- `prompt` (string, required): The prompt to send (1-100,000 chars)
- `model` (string, optional): Model name or alias (e.g. `grok-build`, `latest`)
- `outputFormat` (string, optional): `"plain"` (default), `"json"`, or `"streaming-json"`
- `sessionId` (string, optional): Session ID to resume (`--resume <id>`)
- `resumeLatest` (boolean, optional): Resume the most recent session in the current cwd (`--continue`)
- `createNewSession` (boolean, optional): Always create a new session
- `alwaysApprove` (boolean, optional): Auto-approve all tool executions (`--always-approve`) in legacy mode
- `permissionMode` (string, optional): `default|acceptEdits|auto|dontAsk|bypassPermissions|plan`
- `effort` (string, optional): `low|medium|high|xhigh|max`
- `reasoningEffort` (string, optional): Reasoning effort for reasoning models
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): MCP server names tracked for approvals (Grok manages its own MCP config via `grok mcp`)
- `allowedTools` (string[], optional): Allowed built-in tools (passed as `--tools` comma list)
- `disallowedTools` (string[], optional): Disallowed built-in tools (passed as `--disallowed-tools` comma list)
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency, default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)

**Example:**
```json
{
  "prompt": "Summarize the latest commit message in 1 sentence",
  "model": "grok-build",
  "effort": "low"
}
```

#### Durable job results & automatic dedup

Every async job is persisted to a job store as it transitions through running → completed/failed/canceled. This makes the gateway a durable collection layer:

- **Re-issuing a request is safe.** Identical `*_request` / `*_request_async` calls within the dedup window (default 1 hour) short-circuit onto the existing running or completed job — the caller gets back the same job ID instead of starting a duplicate run. This directly fixes the "agent times out polling, re-issues, and the whole job starts over" failure mode.
- **`llm_job_status` and `llm_job_result` work across gateway restarts.** Job rows live for 30 days by default; callers can fetch results long after the in-memory cache has evicted them.
- **Jobs running at shutdown are marked `orphaned`** on the next gateway boot (the detached child can't be reattached to). Their captured partial output remains readable.
- **Pass `forceRefresh: true`** on any request tool to bypass dedup and force a fresh CLI run.

##### Persistence configuration

The job-store backend is configured by `~/.llm-cli-gateway/config.toml` (override with `LLM_GATEWAY_CONFIG=/path/to/config.toml`). Example:

```toml
[persistence]
backend = "sqlite"                          # "sqlite" | "memory" | "postgres" | "none"
path = "~/.llm-cli-gateway/logs.db"         # for sqlite
# dsn = "postgresql://user:pw@host/db"      # for postgres (interface only — impl not yet shipped)
retentionDays = 30
dedupWindowMs = 3600000
acknowledgeEphemeral = false                # required to enable async tools with memory backend
```

Backends:
- **`sqlite`** (default) — durable, file-backed. Safe for single-instance deployments.
- **`memory`** — in-process Map. Lost on gateway exit. Requires `acknowledgeEphemeral = true` to be loaded. Suitable for tests and ephemeral CI gateways.
- **`postgres`** — interface only, implementation not yet shipped. Selecting this backend throws at startup.
- **`none`** — no store. **`*_request_async`, `llm_job_status`, `llm_job_result`, and `llm_job_cancel` are NOT registered on the gateway.** This is a structural invariant: agents that try to call async tools against a gateway with `backend = "none"` get a clean "tool not found" at connect time instead of silent in-memory loss after the 1-hour TTL. Use `llm_process_health` to inspect the resolved persistence state programmatically.

Legacy environment variables (deprecated; emit a warning at startup):
- `LLM_GATEWAY_LOGS_DB` / `LLM_GATEWAY_JOBS_DB` — `none` selects `backend = "none"`; any other value selects `backend = "sqlite"` with that path.
- `LLM_GATEWAY_JOB_RETENTION_DAYS` — overrides `retentionDays`.
- `LLM_GATEWAY_DEDUP_WINDOW_MS` — overrides `dedupWindowMs`.
- `LLM_GATEWAY_ACKNOWLEDGE_EPHEMERAL` — `1`/`true`/`yes` sets `acknowledgeEphemeral = true`.

##### Per-project isolation

By default, **all gateway data is global per user**, not per project. With no overrides, every Claude Code window — across every repo — spawns its own gateway subprocess but they all read and write the same files:

- `~/.llm-cli-gateway/logs.db` (async jobs + flight recorder)
- `~/.llm-cli-gateway/sessions.json` (CLI sessions)
- `~/.llm-cli-gateway/config.toml` (resolved config)

This is usually what you want — `session_list` from repo A shows sessions from repo B, an async job started in window A can be polled from window B, and the 1-hour dedup window catches re-issues across windows. SQLite WAL mode makes concurrent access from multiple gateway subprocesses safe.

If you instead want **per-project isolation** (e.g. unrelated repos shouldn't share session lists or risk false dedup hits), point each project at its own config file. In `.claude/settings.local.json` for the project:

```json
{
  "mcpServers": {
    "llm-gateway": {
      "env": {
        "LLM_GATEWAY_CONFIG": "${workspaceFolder}/.gateway/config.toml"
      }
    }
  }
}
```

…and put a per-project `config.toml` in the repo:

```toml
[persistence]
backend = "sqlite"
path = "/srv/repos/.../my-repo/.gateway/logs.db"
```

Now every gateway subprocess spawned for *this* repo's Claude Code window reads its own config and writes to its own SQLite file; sessions, jobs, and dedup state are scoped to the repo. Other repos keep using the global default. `llm_process_health.persistence.sources.configFile` lets an agent confirm which config it's actually running under.

###### Agent-executable spec (DAG-TOML)

If you want an LLM agent to perform this setup deterministically — rather than reading the prose above and guessing — copy the following DAG-TOML into the repo (e.g. `docs/planning/per-project-gateway-isolation.toml`) and point your agent at it. The schema is [`agent-assurance`](https://github.com/verivus-oss/agent-assurance/blob/main/SPEC.md) `template_kind = "implementation-dag"`. The agent MUST execute units in layer order, must not skip the verification unit, and must treat any failed gate as blocking.

```toml
[meta]
schema_version    = "1.0.0"
template_kind     = "implementation-dag"
docs              = "https://github.com/verivus-oss/agent-assurance/blob/main/SPEC.md"
confidentiality   = "public"
title             = "Per-project llm-cli-gateway persistence isolation"
spec              = "https://github.com/verivusai-labs/llm-cli-gateway#per-project-isolation"
created           = "YYYY-MM-DD"
total_units       = 5
tier1_units       = ["U01","U02","U03","U04","U05"]
tier2_units       = []
tier3_units       = []

# ============================================================================
# [policy.agent] — persona for the agent performing the configuration.
# ============================================================================

[policy.agent]
name                 = "Gateway Persistence Isolator"
role                 = "Configuration Engineer"
purpose              = "Configure the llm-cli-gateway MCP server so its async job store, sessions, dedup state, and flight recorder are scoped to THIS repository instead of the per-user default at ~/.llm-cli-gateway/."
validation_type      = "Structural + Runtime Verification"
workflow_initiator   = false
description          = "Writes a repo-local config.toml, registers an LLM_GATEWAY_CONFIG override in .claude/settings.local.json, restarts the MCP server, and confirms via llm_process_health that the gateway is now reading the repo-local config and writing to the repo-local SQLite path."

[policy.agent.orchestration]
consumes_events      = ["PerProjectIsolationRequested"]
produces_events      = ["PerProjectIsolationComplete"]

[policy.agent.responsibilities]
items = [
  "Create the repo-local gateway data directory and add it to .gitignore.",
  "Write a config.toml that pins backend=sqlite to a repo-local path.",
  "Register the LLM_GATEWAY_CONFIG env override in .claude/settings.local.json (NOT .mcp.json — that file is committed and shared).",
  "Trigger an MCP server reconnect.",
  "Verify via llm_process_health that the resolved configFile and dbPath are the repo-local values.",
]

# ============================================================================
# [policy.instance] — concrete paths the agent fills in for THIS repo.
# Agent MUST replace <REPO_ABS_PATH> with the absolute path to the repo
# before emitting any artefact. Relative paths in config.toml MUST be
# expanded to absolute — the gateway does not re-resolve them per cwd.
# ============================================================================

[policy.instance]
repo_abs_path                  = "<REPO_ABS_PATH>"           # e.g. /srv/repos/me/my-project
gateway_data_dir_relative      = ".gateway"                  # repo-relative directory
config_toml_relative           = ".gateway/config.toml"
sqlite_db_relative             = ".gateway/logs.db"
claude_local_settings_relative = ".claude/settings.local.json"
gitignore_relative             = ".gitignore"
mcp_server_name                = "llm-gateway"               # must match the entry in .mcp.json

# ============================================================================
# [policy.gates] — blocking checks. Any failure stops the workflow.
# ============================================================================

[policy.gates]
gate_repo_abs_path_resolved    = "policy.instance.repo_abs_path must NOT be the literal string '<REPO_ABS_PATH>' when U01 starts."
gate_config_is_committed       = "policy.instance.config_toml_relative MAY be committed. policy.instance.claude_local_settings_relative MUST NOT be committed (it is per-developer). Agent MUST verify .gitignore covers .claude/settings.local.json if absent."
gate_no_legacy_env_leak        = "Agent MUST grep the shell init files for LLM_GATEWAY_LOGS_DB / LLM_GATEWAY_JOBS_DB. If set, the legacy env var will override the new config and the deprecation warning will fire at every gateway boot. The agent reports this as a finding and asks the operator to unset before proceeding."
gate_health_confirms_isolation = "U05 MUST observe llm_process_health.persistence.sources.configFile == policy.instance.repo_abs_path + '/' + policy.instance.config_toml_relative AND llm_process_health.persistence.path == policy.instance.repo_abs_path + '/' + policy.instance.sqlite_db_relative. Anything else means the override did not take effect."

# ============================================================================
# [policy.evidence] — what each unit must emit so the work is auditable.
# ============================================================================

[policy.evidence]
per_unit_required_fields = [
  "unit_id",                  # U01..U05
  "status",                   # "completed" | "failed"
  "artefact_paths",           # files written / modified
  "stdout_tail",              # last 20 lines of any command output
  "verification_quote",       # for U05, the verbatim llm_process_health.persistence block
]
findings_required_fields = [
  "gate_id",                  # which gate failed
  "observed",
  "expected",
  "remediation",
]

# ============================================================================
# Units. Execute in layer order. U01..U03 modify the working tree; U04
# triggers a reconnect; U05 is the verification gate that decides success.
# ============================================================================

[units.U01]
name           = "create-repo-local-data-dir"
summary        = "mkdir -p <repo>/.gateway and append /.gateway/ to .gitignore (creating .gitignore if missing). The gateway will write logs.db, logs.db-wal, logs.db-shm here — none should be committed."
layer          = 0
tier           = 1
status         = "pending"
depends_on     = []
blocks         = ["U02"]
estimated_loc  = 5
files_modify   = [".gitignore"]
produces       = ["ART:gateway-data-dir"]
consumes       = []

[units.U02]
name           = "write-config-toml"
summary        = "Write <repo>/.gateway/config.toml with [persistence] backend='sqlite' and path=<absolute-path-to-repo>/.gateway/logs.db. Path MUST be absolute. Do NOT use ~ — the gateway expands ~ but [persistence].path is read literally if not prefixed with ~/, and Claude Code may launch the gateway with a HOME that surprises you."
layer          = 1
tier           = 1
status         = "pending"
depends_on     = ["U01"]
blocks         = ["U03"]
estimated_loc  = 10
files_modify   = [".gateway/config.toml"]
produces       = ["ART:gateway-config"]
consumes       = ["ART:gateway-data-dir"]

[units.U03]
name           = "register-llm-gateway-config-env-in-claude-local-settings"
summary        = "Add (or merge) an mcpServers.<mcp_server_name>.env entry in .claude/settings.local.json that sets LLM_GATEWAY_CONFIG to the absolute path of .gateway/config.toml. Do NOT modify .mcp.json — that file is committed and the path would be wrong for every other developer. If .claude/settings.local.json already has an mcpServers.<mcp_server_name> entry, the agent MUST merge into the existing env map (preserving other keys), not overwrite the whole entry."
layer          = 2
tier           = 1
status         = "pending"
depends_on     = ["U02"]
blocks         = ["U04"]
estimated_loc  = 20
files_modify   = [".claude/settings.local.json"]
produces       = ["ART:claude-local-settings"]
consumes       = ["ART:gateway-config"]

[units.U04]
name           = "trigger-mcp-reconnect"
summary        = "Ask the operator to run /mcp in Claude Code (or restart Claude Code) so the gateway subprocess is re-spawned under the new env. The agent cannot do this itself — MCP server lifecycle is owned by the host."
layer          = 3
tier           = 1
status         = "pending"
depends_on     = ["U03"]
blocks         = ["U05"]
estimated_loc  = 0
files_modify   = []
produces       = ["OUT:mcp-reconnected"]
consumes       = ["ART:claude-local-settings"]

[units.U05]
name           = "verify-via-llm-process-health"
summary        = "Call llm_process_health and assert the returned persistence block satisfies policy.gates.gate_health_confirms_isolation. Quote the verbatim persistence block in evidence. If the assertion fails, the agent MUST NOT mark the workflow complete — it must emit a finding under policy.evidence.findings_required_fields, naming the observed vs. expected configFile/path, and stop."
layer          = 4
tier           = 1
status         = "pending"
depends_on     = ["U04"]
blocks         = []
estimated_loc  = 5
files_modify   = []
produces       = ["ART:isolation-verification","OUT:per-project-isolation-complete"]
consumes       = ["OUT:mcp-reconnected"]
```

**Why this matters for agents:** the gateway has multiple configuration surfaces (TOML file, env-var overrides, two different MCP settings files) and one easy mistake — editing the committed `.mcp.json` instead of the local-only `.claude/settings.local.json` — will silently break the per-project scope for every other developer on the repo. The DAG above encodes the correct sequence, the verification gate, and the failure modes explicitly so an agent can execute it without inference.

##### `mistral_request`
Run a Mistral Vibe agentic coding request. Like `grok_request` in shape, but with Vibe's specific surface:

- `model` (string, optional): Vibe model alias (for example `mistral-medium-3.5` or `latest`). The resolved value is injected via the `VIBE_ACTIVE_MODEL` environment variable; omit it to let the gateway discover Vibe config and avoid stale hardcoded defaults.
- `permissionMode`: `default | plan | accept-edits | auto-approve | chat | explore | lean` — emitted as `--agent <mode>`. Defaults to `auto-approve` in programmatic mode.
- `allowedTools` (string[], optional): One `--enabled-tools <tool>` flag per entry (allow-list only).
- `disallowedTools` (string[], optional): Accepted for parity with the other providers; ignored at the CLI boundary with a logged warning.
- `sessionId` / `resumeLatest` / `createNewSession`: standard session controls. Continuity requires `[session_logging] enabled = true` in `~/.vibe/config.toml` — `doctor --json` surfaces an actionable next-action when the toggle is missing.

##### `claude_request_async` / `codex_request_async` / `gemini_request_async` / `grok_request_async` / `mistral_request_async`
Start a long-running Claude, Codex, Gemini, Grok, or Mistral request without waiting for completion in the same MCP call.

Use this flow when analysis/runtime can exceed client tool-call limits:
1. Start job with `*_request_async`
2. Poll with `llm_job_status`
3. Fetch output with `llm_job_result`
4. Optionally stop with `llm_job_cancel`

Async request tools accept the same approval strategy fields as their sync variants:
- `approvalStrategy`: `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy`: `"strict"|"balanced"|"permissive"` override
- `mcpServers`: Requested MCP servers (`sqry`, `exa`, `ref_tools`, `trstr`)
- `claude_request_async` also supports `strictMcpConfig` and fails fast when requested servers are unavailable

##### `llm_job_status`
Return lifecycle status (`running`, `completed`, `failed`, `canceled`) and metadata for an async job.

##### `llm_job_result`
Return captured stdout/stderr for an async job (with configurable max chars per stream).

##### `llm_job_cancel`
Cancel a running async job.

##### `approval_list`
List recent MCP-managed approval decisions recorded by the gateway.

**Parameters:**
- `limit` (number, optional): Max records (1-500), default: 50
- `cli` (string, optional): Filter by `"claude"`, `"codex"`, or `"gemini"`

Approval records are persisted to `~/.llm-cli-gateway/approvals.jsonl`.

#### Session Management Tools

##### `session_create`
Create a new session for a specific CLI.

**Parameters:**
- `cli` (string, required): CLI to create session for ("claude", "codex", "gemini", "grok", "mistral")
- `description` (string, optional): Description for the session
- `setAsActive` (boolean, optional): Set as active session, default: true

**Example:**
```json
{
  "cli": "claude",
  "description": "Code review session",
  "setAsActive": true
}
```

##### `session_list`
List all sessions, optionally filtered by CLI.

**Parameters:**
- `cli` (string, optional): Filter by CLI ("claude", "codex", "gemini", "grok", "mistral")

**Response includes:**
- Total session count
- Session details (ID, CLI, description, timestamps, active status)
- Active session IDs for each CLI

##### `session_set_active`
Set the active session for a specific CLI.

**Parameters:**
- `cli` (string, required): CLI to set active session for
- `sessionId` (string, required): Session ID to activate (or null to clear)

##### `session_get`
Retrieve details for a specific session.

**Parameters:**
- `sessionId` (string, required): Session ID to retrieve

##### `session_delete`
Delete a specific session.

**Parameters:**
- `sessionId` (string, required): Session ID to delete

##### `session_clear_all`
Clear all sessions, optionally for a specific CLI.

**Parameters:**
- `cli` (string, optional): Clear sessions for specific CLI only

#### Utility Tools

##### `list_models`
List available models for each CLI.

**Parameters:**
- `cli` (string, optional): Specific CLI to list models for ("claude", "codex", "gemini", "grok", "mistral")

**Response includes:**
- Model names and descriptions
- Best use cases for each model
- CLI-specific information
- `defaultModel` and `defaultModelSource` when a default is explicitly configured
- `modelMetadata` with source/confidence (`fallback`, `config`, `env`, `observed`)
- `aliases` and `warnings` when configured or when discovery degrades gracefully

The registry treats explicit configuration as authoritative. Bundled fallback models are low-confidence hints, and Gemini models observed in local session history are merged as low-confidence entries only; they do not become the default model.

Model registry environment overrides:

```bash
# Explicit defaults
CLAUDE_DEFAULT_MODEL=haiku
CODEX_DEFAULT_MODEL=<codex-model-id>
GEMINI_DEFAULT_MODEL=gemini-2.5-flash

# Additional models: comma/newline list, JSON array, or JSON object of model->description
GEMINI_MODELS='{"gemini-team-default":"Team-approved Gemini model"}'

# Aliases
GEMINI_MODEL_ALIASES='team=gemini-team-default'
LLM_GATEWAY_MODEL_ALIASES='codex.fast=gpt-5.3-codex-spark,gemini.fast=gemini-team-default'

# Deterministic config/discovery paths
CODEX_CONFIG_PATH=/path/to/config.toml
CLAUDE_SETTINGS_PATH=/path/to/settings.json
CLAUDE_SETTINGS_LOCAL_PATH=/path/to/settings.local.json
GEMINI_SETTINGS_PATH=/path/to/settings.json
GEMINI_HISTORY_ROOT=/path/to/.gemini/tmp

# Disable local model-history discovery
LLM_GATEWAY_DISABLE_MODEL_DISCOVERY=1
```

##### `cli_versions`
Report installed CLI versions.

**Parameters:**
- `cli` (string, optional): Specific CLI to inspect ("claude", "codex", "gemini", "grok", "mistral")

##### `cli_upgrade`
Plan or run an upgrade for one CLI.

**Parameters:**
- `cli` (string, required): CLI to upgrade ("claude", "codex", "gemini", "grok", "mistral")
- `target` (string, optional): Package tag/version/target, default: `latest`
- `dryRun` (boolean, optional): Return the upgrade plan without running it, default: `true`
- `timeoutMs` (number, optional): Upgrade timeout when `dryRun=false`

**Upgrade strategies:**
- Claude latest: `claude update`
- Claude explicit target: `claude install <target>`
- Codex latest: `codex update`
- Codex explicit target: `npm install -g @openai/codex@<target>`
- Gemini: `npm install -g @google/gemini-cli@<target>`

**Example dry run:**
```json
{
  "cli": "gemini",
  "target": "latest",
  "dryRun": true
}
```

## Session Management

### How It Works

1. **Automatic Session Tracking**: By default, the gateway automatically tracks sessions for each CLI
2. **Active Sessions**: Each CLI can have one active session that's used by default
3. **Persistent Storage**: Sessions are stored in `~/.llm-cli-gateway/sessions.json`
4. **Context Reuse**: Using sessions maintains conversation history and context

### Session Workflow

```javascript
// 1. Create a new session
await callTool("session_create", {
  cli: "claude",
  description: "Debugging session",
  setAsActive: true
});

// 2. Make requests (automatically uses active session)
await callTool("claude_request", {
  prompt: "What's the bug in this code?",
  // sessionId is automatically used
});

// 3. Continue the conversation
await callTool("claude_request", {
  prompt: "Can you explain that fix in more detail?",
  continueSession: true
});

// 4. List all sessions
await callTool("session_list", { cli: "claude" });

// 5. Switch to a different session
await callTool("session_set_active", {
  cli: "claude",
  sessionId: "some-other-session-id"
});

// 6. Delete when done
await callTool("session_delete", {
  sessionId: "session-id-to-delete"
});
```

## Configuration

### Environment Variables

- `DEBUG`: Enable debug logging (set to any value)
  ```bash
  DEBUG=1 node dist/index.js
  ```
- `LLM_GATEWAY_APPROVAL_POLICY`: Default approval policy when request does not pass `approvalPolicy` (`strict`, `balanced`, `permissive`)
  ```bash
  LLM_GATEWAY_APPROVAL_POLICY=strict node dist/index.js
  ```
- `LLM_GATEWAY_CONFIG`: Path to the gateway TOML config (default: `~/.llm-cli-gateway/config.toml`). See **Persistence configuration** above for the `[persistence]` schema.
- `LLM_GATEWAY_LOGS_DB`: **Deprecated** — overrides `[persistence].path` and selects `backend = "sqlite"` (or `backend = "none"` when set to `none`). Emits a deprecation warning at startup; migrate to `config.toml`.
  ```bash
  # Custom path
  LLM_GATEWAY_LOGS_DB=/var/log/gateway/logs.db node dist/index.js
  # Disable durable persistence (also disables *_request_async tools)
  LLM_GATEWAY_LOGS_DB=none node dist/index.js
  ```

### CLI-Specific Settings

Each CLI can be configured through its own configuration files:
- Claude Code: `~/.claude/config.json`
- Codex: `~/.codex/config.toml`
- Gemini: `~/.gemini/config.json`

## For Fans of Simon Willison

Simon's `llm` tool made it trivially easy to talk to any LLM from the command line. But as AI-assisted development matures, the challenge shifts from "how do I call a model" to "how do I orchestrate multiple models reliably, and what did they actually do?"

**Multiple models increase the confidence factor.** When Claude writes code, Codex reviews it, and Gemini checks for bugs -- each bringing different training data and reasoning patterns -- the result is more robust than any single model alone. And often this isn't even enough. Having the models do iterative reviews is where you start getting real confidence.

**Every interaction should be queryable data.** Inspired by `llm`'s SQLite logging philosophy, the gateway records every request and response to a local SQLite database. Not just prompts and responses -- retry counts, circuit breaker states, approval decisions, thinking blocks, cost estimates. Open it with Datasette and you have a complete operational picture of your AI usage:

    datasette ~/.llm-cli-gateway/logs.db

**The `llm-gateway` plugin bridges both worlds.** Install it, and your existing `llm` workflows gain orchestration features without changing how you work:

    llm install llm-gateway
    llm -m gateway-claude "explain this function"

Your gateway interactions appear in both `llm logs` (for your personal history) and the gateway's flight recorder (for operational observability). Two audiences, one workflow.

**Composability over monoliths.** The gateway doesn't replace `llm` -- it complements it. Use `llm` directly when you want simplicity. Route through the gateway when you want resilience, multi-model coordination, or detailed operational telemetry. The plugin is the bridge, not the destination.

## Development

### Project Structure

```
llm-cli-gateway/
├── src/
│   ├── index.ts              # Main MCP server and tool definitions
│   ├── executor.ts           # CLI execution with timeout support
│   ├── session-manager.ts    # Session management logic
│   └── __tests__/
│       ├── executor.test.ts  # Unit tests for executor
│       └── integration.test.ts # Integration tests
├── dist/                     # Compiled JavaScript
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

### Running Tests

```bash
# Run all tests
npm test

# Run unit tests only
npm run test:unit

# Run integration tests only
npm run test:integration

# Watch mode
npm run test:watch
```

### Building

```bash
npm run build
```

### Starting the Server

```bash
npm start
```

## Error Handling

The gateway provides detailed error messages for common issues:

### CLI Not Found
```
Error executing claude CLI:
spawn claude ENOENT

The 'claude' command was not found. Please ensure claude CLI is installed and in your PATH.
```

### External Timeout / Legacy Timeout Option
```
Error executing codex CLI: Command timed out
Process timed out after 120000ms
```

### Invalid Parameters
```
Prompt cannot be empty
Prompt too long (max 100k chars)
```

## Logging

Logs are written to stderr (stdout is reserved for MCP protocol):

```
[INFO] 2026-01-24T05:00:00.000Z - Starting llm-cli-gateway MCP server
[INFO] 2026-01-24T05:00:01.000Z - claude_request invoked with model=sonnet, prompt length=150
[INFO] 2026-01-24T05:00:05.000Z - claude_request completed successfully in 4523ms, response length=2048
[ERROR] 2026-01-24T05:00:10.000Z - codex CLI execution failed: spawn codex ENOENT
```

Enable debug logging:
```bash
DEBUG=1 node dist/index.js
```

## Troubleshooting

### CLIs Not Found

Make sure the CLIs are installed and in your PATH:
```bash
which claude
which codex
which gemini
```

The gateway extends PATH to include common locations:
- `~/.local/bin`
- `/usr/local/bin`
- `/usr/bin`
- All `~/.nvm/versions/node/*/bin` directories

### Permission Errors

If you encounter permission errors, ensure the CLI tools have proper permissions:
```bash
chmod +x $(which claude)
chmod +x $(which codex)
chmod +x $(which gemini)
```

### Session Storage Issues

Sessions are stored in `~/.llm-cli-gateway/sessions.json`. If you encounter issues:

1. Check file permissions:
```bash
ls -la ~/.llm-cli-gateway/
```

2. Reset sessions:
```bash
rm ~/.llm-cli-gateway/sessions.json
```

3. Or manually edit the session file:
```bash
cat ~/.llm-cli-gateway/sessions.json
```

## Performance

### Timeouts

The gateway does not enforce a default execution timeout for LLM CLI requests.

If your MCP client/runtime enforces per-tool-call deadlines, use async tools (`*_request_async` + `llm_job_status`/`llm_job_result`) so long-running jobs can complete outside a single call window.

### Concurrent Requests

The gateway supports concurrent requests across different CLIs. Each request spawns a separate process.

## Security Considerations

- **Input Validation**: All prompts are validated (min 1 char, max 100k chars)
- **Command Execution**: Uses `spawn` with separate arguments (not shell execution)
- **No Eval**: No dynamic code evaluation in our source (see "Socket alerts" below for the transitive `ajv` codegen case)
- **Sandboxing**: Consider running in containers for production use
- **Provenance**: Releases are published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted publishing from GitHub Actions

### Socket alerts — context for reviewers

If you're vetting `llm-cli-gateway` through [Socket](https://socket.dev/npm/package/llm-cli-gateway) or a similar supply-chain scanner, you'll see three behavioural alerts and some dependency-ownership alerts. They are accurate descriptions of what the package does and what it depends on; we've left them visible (not silenced in `socket.yml`) so you don't have to take our word for it. Here's the context for each:

| Alert | Where | Why it's bounded |
|---|---|---|
| **Network access** | `src/http-transport.ts` opens an HTTP MCP transport when started via `npm run start:http`. `src/endpoint-exposure.ts` issues a HEAD probe to verify configured public/tunnel URLs. | The transport binds to `127.0.0.1` by default and requires `LLM_GATEWAY_AUTH_TOKEN` to be set. The default stdio MCP entry point (`npm start`) opens no sockets. |
| **Shell access** | `src/executor.ts` uses `child_process.spawn(cmd, args, …)` to invoke the underlying LLM CLIs. | `spawn` is called with an argument array and **never** `shell: true`, so there is no shell interpolation path for caller input. The command name is restricted to an allow-list of known CLI binaries (`claude`, `codex`, `gemini`, `grok`, `vibe`). |
| **Uses eval** | None in our source. Transitive: `@modelcontextprotocol/sdk` → `ajv@8` uses `new Function(...)` in `ajv/dist/compile/index.js` to compile JSON Schema validators. | This is ajv's standard codegen path. Only known schemas (defined in our source and the MCP SDK) flow into it; no caller-supplied data ever reaches the compiled function body. |
| **Dependency ownership** | A handful of small transitive packages (e.g. `bindings` via `better-sqlite3`, `media-typer` via `@modelcontextprotocol/sdk`) trip Socket's "unstable ownership" or "obfuscated code" heuristics. | These are pinned, well-known micro-deps in the Node ecosystem with no known issues. We pin direct override versions of `content-type` and `type-is` in `package.json#overrides`. Our previous direct dependency on `toml@3.0.0` (also single-maintainer, last released 2020) was replaced with the actively-maintained `smol-toml` to reduce inherited risk. |

See [`socket.yml`](./socket.yml) for the same context in machine-readable form.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests: `npm test`
5. Build: `npm run build`
6. Submit a pull request

## License

MIT. See [LICENSE](LICENSE) for details.

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues and documentation
- Review CLI-specific documentation for CLI-related problems

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed release history.
