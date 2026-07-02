# llm-cli-gateway

[![CI](https://github.com/verivus-oss/llm-cli-gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/verivus-oss/llm-cli-gateway/actions/workflows/ci.yml)
[![Security](https://github.com/verivus-oss/llm-cli-gateway/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/verivus-oss/llm-cli-gateway/actions/workflows/security.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/verivus-oss/llm-cli-gateway/badge)](https://scorecard.dev/viewer/?uri=github.com/verivus-oss/llm-cli-gateway)
[![npm](https://img.shields.io/npm/v/llm-cli-gateway.svg)](https://www.npmjs.com/package/llm-cli-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

> _"Without consultation, plans are frustrated, but with many counselors they succeed."_
> — Proverbs 15:22 (LSB)

A Model Context Protocol (MCP) gateway for running Claude Code, Codex, Gemini, Grok, Mistral (Vibe), Devin, and Cursor Agent CLIs from one MCP endpoint, with durable async jobs, session continuity, cache-aware prompting, observability, and personal-appliance setup tooling.

**Why developers try it:** one local MCP endpoint for cross-LLM validation, multi-agent coding workflows, and repeatable assistant-led setup across registered provider CLIs.

**Current signals:** CI and security workflows pass on `main`, OpenSSF Scorecard is published, OpenSSF Best Practices is passing, releases use Sigstore signing, and the package is MIT licensed.

## Quick Start

```bash
npm install -g llm-cli-gateway
```

Or use directly with `npx` from an MCP client:

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

## What It Provides Today

`llm-cli-gateway` is a single-user MCP gateway for cross-LLM validation and multi-agent coding workflows. It is more than a thin CLI wrapper:

- Runs registered provider CLIs through consistent sync and async MCP tools.
- Persists long-running jobs, supports restart-safe result collection, deduplication, cancellation, and sync-to-async deferral.
- Tracks sessions, real CLI resume paths, structured response metadata, and cache telemetry.
- Supports cache-aware `promptParts`, including explicit Claude `cache_control` when opted in.
- Can run requests inside gateway-managed git worktrees for isolated multi-agent review and implementation loops.
- Ships personal-appliance setup surfaces: HTTP transport with bearer-token auth, `doctor --json`, setup UI artifacts, provider setup snippets, Docker fallback, and checked release bundles.
- Remote web connectors use MCP OAuth discovery and authorization-code setup with static client or shared-secret gates. Client secrets are generated locally, stored only as hashes, and printed only by explicit copy-once commands.
- Provider CLI requests can select registered workspaces by alias via `workspace`; every HTTP/tunnel request must use a registered alias, session workspace, or `[workspaces].default` before provider execution. Local unrestricted filesystem access is the stdio transport.

## Workflow Assets

The repo ships agent-ready workflow skills under [`.agents/skills`](.agents/skills) for async orchestration, session continuity, multi-LLM review, implement-review-fix loops, and secure approval-gated dispatch. Six caller-facing skills are bundled in the published npm package: `async-job-orchestration`, `multi-llm-review`, `session-workflow`, `secure-orchestration`, `implement-review-fix`, and `public-demo-session`. Machine-readable DAG-TOML plans live under [`docs/plans`](docs/plans) and [`setup/install-plan.dag.toml`](setup/install-plan.dag.toml) for workflows that need deterministic sequencing and verification gates.

The next documentation focus is provider-specific skill and DAG-TOML pairs for each outbound CLI: Claude, Codex, Gemini, Grok, and Mistral Vibe. The implementation plan is tracked in [`docs/plans/provider-workflow-assets.dag.toml`](docs/plans/provider-workflow-assets.dag.toml), with each provider asset expected to cover install/login checks, session behavior, approval modes, cache/telemetry surfaces, failure modes, and a smoke-test gate.

## Trust & Supply Chain

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13025/badge)](https://www.bestpractices.dev/projects/13025)
[![Releases: Sigstore signed](https://img.shields.io/badge/releases-Sigstore%20signed-2e7d32.svg)](SECURITY.md#release-signing)

- CI runs build, lint, format, tests, package checks, and npm audit.
- Security CI runs actionlint, zizmor, shellcheck, typos, osv-scanner, gitleaks, and lychee.
- GitHub release installer artifacts are checksummed and signed with Sigstore keyless signing.
- npm releases use provenance through OIDC trusted publishing.
- The npm package intentionally ships a generated, prod-only `npm-shrinkwrap.json` so registry installs resolve the audited release tree. Release gates regenerate it from `package-lock.json`, compare for parity, and run a registry-fidelity consumer install before publishing.
- Socket behavioural alerts are documented in [`socket.yml`](./socket.yml) and under "Security Considerations" below. `shellAccess` and `shrinkwrap` are reviewed package capabilities/configuration for this CLI appliance, not hidden install behaviour.

## Personal MCP Appliance

The personal-appliance contract keeps that surface intentionally narrow: one trusted user runs the gateway on a machine or volume they own, connects one MCP endpoint, and asks any connected client for cross-LLM validation.

The product contract is documented in [docs/personal-mcp/PRODUCT_CONTRACT.md](docs/personal-mcp/PRODUCT_CONTRACT.md). It defines the single-user scope, security posture, target support matrix, and provider-support verification gates. Public setup guides must not claim ChatGPT, Claude web, Claude Desktop, Codex, Gemini CLI, Gemini web, or Grok inbound support until the corresponding provider/client path has been verified.

This project does not provide hosted multi-tenant credential custody. Provider credentials stay on the user's machine or user-owned deployment volume.

Release-readiness history is tracked in [docs/personal-mcp/RELEASE_READINESS.md](docs/personal-mcp/RELEASE_READINESS.md). Dogfooding evidence (which target LLMs guided setup, what unsafe suggestions were captured, and which findings were deferred from the initial personal-appliance rollout) is in [docs/personal-mcp/DOGFOODING_RESULTS.md](docs/personal-mcp/DOGFOODING_RESULTS.md).

Current personal-appliance artifacts include:

- Streamable HTTP startup: `LLM_GATEWAY_AUTH_TOKEN=<token> npm run start:http`
- Machine-readable diagnostics: `npm run doctor`
- Go bootstrapper: `installer/` with `setup`, `doctor --json`, `start`, `stop`, `status`, `repair`, `upgrade`, `uninstall`, `print-client-config`, and verified bundle download commands.
- Release packaging: the release workflow builds Linux binaries on the local self-hosted runner, builds Windows/macOS binaries on GitHub-hosted runners, then publishes checksummed platform bundles with the gateway, production dependencies, and a managed Node runtime; see [installer/packaging/README.md](installer/packaging/README.md).
- Docker Compose fallback: [docker/personal.compose.yml](docker/personal.compose.yml) + [docker/Dockerfile.personal](docker/Dockerfile.personal) for users who already manage containers.
- Local setup UI artifact: [setup/ui/index.html](setup/ui/index.html)
- Provider setup snippets: [setup/providers/](setup/providers/)
- Cross-validation tools: `validate_with_models`, `second_opinion`, `compare_answers`, `red_team_review`, `consensus_check`, `ask_model`, `synthesize_validation`, `job_status`, `job_result`, and `validation_receipt` (plus the `validation-receipt://{validationId}` resource).

### Install / Upgrade / Uninstall (single binary)

Windows PowerShell:

```powershell
$Version = '<version>'
$Base = "https://github.com/verivus-oss/llm-cli-gateway/releases/download/v$Version"
$InstallDir = Join-Path (Join-Path $env:LOCALAPPDATA 'Programs') 'llm-cli-gateway'
$ExeName = "llm-cli-gateway-$Version-windows-amd64.exe"
$BundleName = "llm-cli-gateway-bundle-$Version-windows-amd64.tar.gz"
$Exe = Join-Path $InstallDir 'llm-cli-gateway.exe'
$Checksums = Join-Path $InstallDir 'SHA256SUMS'
$ChecksumBundle = Join-Path $InstallDir 'SHA256SUMS.sigstore.json'
New-Item -ItemType Directory -Force $InstallDir | Out-Null
Invoke-WebRequest -UseBasicParsing "$Base/$ExeName" -OutFile $Exe
Invoke-WebRequest -UseBasicParsing "$Base/SHA256SUMS" -OutFile $Checksums
Invoke-WebRequest -UseBasicParsing "$Base/SHA256SUMS.sigstore.json" -OutFile $ChecksumBundle
cosign verify-blob $Checksums --bundle $ChecksumBundle --certificate-identity "https://github.com/verivus-oss/llm-cli-gateway/.github/workflows/release-installer.yml@refs/tags/v$Version" --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
if ($LASTEXITCODE -ne 0) { throw "Sigstore verification failed for SHA256SUMS" }
function Get-ReleaseSha256($Name) {
  $line = Select-String -Path $Checksums -Pattern "^[a-fA-F0-9]{64}\s+$([regex]::Escape($Name))$" | Select-Object -First 1
  if (-not $line) { throw "No SHA256SUMS entry found for $Name" }
  return (($line.Line -split "\s+")[0]).ToLowerInvariant()
}
if ((Get-FileHash $Exe -Algorithm SHA256).Hash.ToLowerInvariant() -ne (Get-ReleaseSha256 $ExeName)) { throw "Checksum mismatch for $ExeName" }
$env:RVWR_GATEWAY_BUNDLE_URL = "$Base/$BundleName"
$env:RVWR_GATEWAY_BUNDLE_SHA256 = Get-ReleaseSha256 $BundleName
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
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity "https://github.com/verivus-oss/llm-cli-gateway/.github/workflows/release-installer.yml@refs/tags/v<version>" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com"
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
  docker compose -f docker/personal.compose.yml up -d
docker compose -f docker/personal.compose.yml run --rm doctor
```

## Features

### Core Capabilities

- **Multi-LLM Orchestration**: Unified interface for Claude Code, Codex, Gemini, Grok, Mistral (Vibe), Devin, and Cursor Agent CLIs
- **Session Management**: Track and resume conversations across all CLIs with persistent storage
- **Gateway-owned worktrees**: Run any sync or async provider request inside a managed git worktree, with per-session reuse and cleanup
- **Token Optimization**: Automatic 44% reduction on prompts, 37% on responses (opt-in)
- **Correlation ID Tracking**: Full request tracing across all LLM interactions
- **Cross-Tool Collaboration**: LLMs can use each other via MCP (validated through dogfooding)

### Observability

- **SQLite Flight Recorder**: Every request/response logged to `~/.llm-cli-gateway/logs.db` with correlation IDs, token usage, duration, retry counts, and circuit breaker state. Browse with [Datasette](https://datasette.io/): `datasette ~/.llm-cli-gateway/logs.db`
- **Structured Metadata**: Tool responses include machine-readable `structuredContent` (model, cli, correlationId, sessionId, durationMs, token counts)
- **Cache observability resources**: `cache-state://global`, `cache-state://session/{id}`, and `cache-state://prefix/{hash}` MCP resources return aggregate cache hit/miss/savings — tokens and hashes only, no prompt text. `session_get` includes a `cacheState` block when the session has prior requests.
- **Provider capability inventory**: `provider_tool_capabilities` and `provider-tools://catalog` expose the gateway request fields, supported/degraded provider controls, local skill/tool discovery, and safe config-surface hints for Claude Code, Codex CLI, Gemini/Antigravity, Grok CLI/API, Mistral Vibe, Cognition Devin, and Cursor Agent. `doctor --json` includes a compact `provider_capabilities` summary for setup assistants.

### Cache-aware operation

Every `*_request` and `*_request_async` tool except `devin_request` / `devin_request_async` and `cursor_request` / `cursor_request_async` accepts an optional `promptParts` field that structures the prompt for better cache hit rates (the Devin and Cursor headless paths take a plain `prompt` only). The gateway concatenates the parts in canonical order (`system → tools → context → task`) so that the stable prefix bytes precede the volatile task tail unchanged across calls, letting each provider's automatic prompt-caching land on the same content hash each time.

```json
{
  "promptParts": {
    "system": "You are a helpful code reviewer.",
    "tools": "You have access to Read, Grep, Bash.",
    "context": "<long stable context block — file dumps, etc.>",
    "task": "Review the changes in src/foo.ts for security issues."
  }
}
```

`prompt` and `promptParts` are mutually exclusive — pass exactly one.

Per-CLI capability matrix (prefix discipline is automatic via `promptParts` for all providers except Devin and Cursor, which have no `promptParts` surface; explicit levers are provider-specific):

| CLI     | Prefix discipline | Explicit lever(s) |
| ------- | ----------------- | ----------------- |
| claude  | yes               | `promptParts.cacheControl` + `outputFormat: "stream-json"` (Anthropic `cache_control` breakpoints on stable blocks; `ttl="1h"` forced) |
| codex   | yes               | none (OpenAI implicit) |
| gemini  | yes               | none (implicit server-side) |
| grok    | yes               | `compactionMode` / `compactionDetail` (context compaction: `summary|transcript|segments`; `segments` writes per-segment markdown) |
| mistral | yes               | none (implicit) |
| devin   | no                | plain `prompt` only |
| cursor  | no                | plain `prompt` only |

**Claude example (explicit cacheControl)**

```ts
claude_request({
  promptParts: {
    system: "You are a helpful code reviewer.",
    context: "<long stable file dump>",
    task: "Review the diff.",
    cacheControl: { system: true, context: true }  // task is never marked
  },
  outputFormat: "stream-json"
})
```

Gateway emits the `stream-json` stdin path with `cache_control: {type:"ephemeral", ttl:"1h"}` on marked blocks only.

**Grok example (compaction)**

```ts
grok_request({
  promptParts: { system: "...", context: "...", task: "..." },
  compactionMode: "segments",
  compactionDetail: "balanced"
})
```

Emits `--compaction-mode segments --compaction-detail balanced`.

See `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` for full surfaces, telemetry differences (e.g. Grok `-p` vs ACP), exact stream-json payload shapes, and cross-LLM review notes.

Opt-in flags (all default off) live under `[cache_awareness]` in `~/.llm-cli-gateway/config.toml`.

### Reliability & Performance

- **Retry Logic**: Exponential backoff with circuit breaker for transient failures
- **Atomic File Writes**: Process-specific temp files with fsync for data integrity
- **Host-protection backpressure**: bounded HTTP session lifecycle (max sessions + idle reaper), global and per-provider job-execution limits with a bounded FIFO queue, and a configurable per-job output cap (default 50MB). See [Host-protection limits](#host-protection-limits-http-and-limits).
- **NVM Path Caching**: Eliminates I/O overhead on every request
- **Long-Running Jobs**: Non-time-bound async execution via `*_request_async` + polling tools

### Security & Quality

- **Comprehensive Testing**: 1,700+ tests covering unit, integration, and regression scenarios with real CLI execution
- **Input Validation**: Zod schemas prevent injection attacks
- **No Secret Leakage**: Generic session descriptions only (file permissions 0o600)
- **No ReDoS**: Bounded regex patterns prevent catastrophic backtracking
- **Type Safety**: Strict TypeScript with comprehensive error handling
- **Supply-chain hardening**: a dedicated `.github/workflows/security.yml` runs actionlint, zizmor, shellcheck, typos, osv-scanner, gitleaks, and lychee on every push and PR (see `SECURITY.md` for the threat model)

## Provider capability surface

Every provider is reachable through the same request, session, job, and validation machinery, but the underlying CLIs differ in what they natively expose. The table records what actually shipped per provider; discover the live surface at runtime with `provider_tool_capabilities`, `list_models`, and the `provider-acp://<provider>` / `provider-tools://<provider>` resources.

| Provider | CLI request tools | Native ACP | Live model discovery | Admin surface |
| --- | --- | --- | --- | --- |
| Claude Code (`claude`) | `claude_request` / `_async` | None (CLI-first; no ACP entrypoint at claude 2.1.198) | model aliases, reasoning-effort levels, fallback model | read-only via `provider_admin_list` / `provider_admin_run` |
| OpenAI Codex (`codex`) | `codex_request` / `_async`, `codex_fork_session` | None (codex-cli 0.142.4 advertises mcp-server / app-server transports, not native ACP) | `codex debug models` | read-only via `provider_admin_list` / `provider_admin_run` |
| Gemini / Antigravity (`gemini`, `agy`) | `gemini_request` / `_async` | None (agy 1.0.14 exposes no ACP entrypoint; legacy Gemini CLI ACP evidence does not transfer) | `agy models` | read-only via `provider_admin_list` / `provider_admin_run` |
| xAI Grok (`grok`) | `grok_request` (sync `transport: "acp"`) / `_async` | Native via `grok agent stdio` | `grok models` + `~/.grok/config.toml` | read-only via `provider_admin_list` / `provider_admin_run` |
| Mistral Vibe (`mistral`) | `mistral_request` (sync `transport: "acp"`) / `_async` | Native via `vibe-acp` | Vibe config plus the `VIBE_ACTIVE_MODEL` active model and agent profiles | read-only via `provider_admin_list` / `provider_admin_run` |
| Cognition Devin (`devin`) | `devin_request` (sync `transport: "acp"`, `agentType: summarizer\|review`) / `_async` | Native via `devin acp` | `--model` / `DEVIN_MODEL` | read-only via `provider_admin_list` / `provider_admin_run` |
| Cursor Agent (`cursor`) | `cursor_request` (sync `transport: "acp"`) / `_async` | Native via `cursor-agent acp` (companion-owned) | model aliases | read-only via `provider_admin_list` / `provider_admin_run` |

- **Native ACP** is reported honestly. `grok`, `mistral`, `devin`, and `cursor` expose a native ACP entrypoint, so `provider-acp://<provider>` carries the negotiated `initialize` capability set and the derived session-method availability, and the sync `*_request` accepts `transport: "acp"` (fails closed unless `[acp]` and the provider's `runtime_enabled` gate are set). ACP routing is sync-only: the `*_request_async` variants always run the CLI transport and do not accept `transport: "acp"` (nor Devin's `agentType`); async ACP parity is a later phase. `claude`, `codex`, and `gemini` have no native ACP entrypoint at their target CLI versions; their `provider-acp://` records report `native: false` with no methods and no adapter-as-native masquerade, and they expose no `transport: "acp"` selector.
- **Resources** are generated from the provider registry for every CLI provider: `models://<provider>`, `sessions://<provider>`, `provider-acp://<provider>`, `provider-tools://<provider>`, and `provider-subcommands://<provider>`.
- **Model discovery** is live and account-aware: the discovery listed above reaches `models://<provider>` and `list_models`, degrading to static registry facts when a live probe is unavailable (a resource read never spawns a CLI).
- **Admin surfaces** are discovery-driven and output-redacted. `provider_admin_list` and `provider_admin_run` are read-only for every provider. State-mutating admin operations are exposed only through `provider_admin_mutate`, gated behind `[admin] allow_mutating_cli_admin_ops`, the remote `cli:admin` scope, an approval gate, and an audit record. Mutating ACP session operations are likewise gated behind `[acp] allow_mutating_session_ops`.
- **Validation** commands work across every provider: `validate_with_models`, `second_opinion`, `compare_answers`, `red_team_review`, `consensus_check`, `ask_model`, and `synthesize_validation`, with durable signed receipts via `validation_receipt` and the `validation-receipt://{validationId}` resource.

## Prerequisites

**Node.js >= 24.4.0** is required (`engines.node` in `package.json`). The gateway uses Node's built-in `node:sqlite` module for persistence — there is no native binding to compile and no install scripts run. The 24.4 floor is where `allowBareNamedParameters` defaults to `true`, which the persistence layer relies on.

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

### Gemini (Google Antigravity CLI)

The Gemini provider runs through Google Antigravity CLI (`agy`).

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
# Docs: https://antigravity.google/docs/cli-overview
```

### Grok Build CLI (xAI)

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok login   # OAuth flow; for headless auth, set XAI_API_KEY
# Docs: https://docs.x.ai/build/overview
```

### Mistral Vibe CLI

```bash
# Pick one — the gateway's cli_upgrade auto-detects which one you used.
curl -LsSf https://mistral.ai/vibe/install.sh | bash
pip install mistral-vibe
uv tool install mistral-vibe
brew install mistral-vibe

vibe auth login
# Current Vibe defaults session logging to enabled. If an older config disabled it,
# edit ~/.vibe/config.toml and set:
# [session_logging]
# enabled = true
```

Vibe-specific notes:

- **Model selection is via the `VIBE_ACTIVE_MODEL` environment variable** —
  Vibe has no `--model` flag. The gateway discovers `~/.vibe/config.toml` /
  `VIBE_MODELS`, injects `VIBE_ACTIVE_MODEL` only when a model is explicitly
  requested or Vibe config needs recovery, and retries once after a
  model-not-found failure with refreshed discovery.
- **`permissionMode` is the Vibe `--agent` name.** Builtins are
  `default | plan | accept-edits | auto-approve`; Vibe also accepts install-gated
  builtins (e.g. `lean`) and custom agents from `~/.vibe/agents`, so any name is
  passed through and Vibe validates availability. The gateway's
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

Stdio is the recommended path for unrestricted machine-local development access. HTTP MCP, including localhost HTTP and tunneled HTTPS, is treated as remote-capable for provider execution: provider tools must resolve a registered workspace alias, a session workspace, or `[workspaces].default` before spawning a CLI. Remote clients should pass relative `workingDir`, `addDir`, and include-directory values inside the selected workspace; disabling auth or using a no-auth connector path is not a filesystem bypass.

This generic stdio example is not provider-support verification for the Personal MCP Appliance. Client-specific setup guides for ChatGPT, Claude web, Claude Desktop, Codex, Gemini CLI, Gemini web, and Grok remain gated by the provider-support matrix in [docs/personal-mcp/PRODUCT_CONTRACT.md](docs/personal-mcp/PRODUCT_CONTRACT.md).

### Available Tools

#### Cross-LLM Validation Tools

The personal-appliance surface exposes simplified validation tools for non-developer clients. These tools start provider CLI jobs through the durable async job manager and return normalized provider status plus raw job references.

- `validate_with_models`: ask two or more providers to independently validate a question.
- `second_opinion`: ask one provider to review an answer.
- `red_team_review`: challenge a plan, answer, or document for risks and failure modes.
- `consensus_check`: check whether providers agree with a claim.
- `ask_model`: ask one provider through the simplified surface.
- `synthesize_validation`: run an explicit judge model after provider results have been collected.
- `list_available_models`: list the models each provider CLI exposes through the simplified surface.
- `job_status` and `job_result`: poll and collect validation job outputs.
- `validation_receipt`: retrieve the immutable receipt of a terminal cross-LLM validation run by `validationId` (returns `minted | pending | expired_unminted | not_found`, own-or-not-found). `format: "markdown"` renders a human-readable report; `includeRawResponses` inlines provider answer text. Registered only under the durable persistence gate (`backend = "sqlite"` with an attached validation-run store).

The same receipt is also exposed as the `validation-receipt://{validationId}` MCP resource (same durable gate and own-or-not-found owner scoping).

The validation report preserves per-provider disagreement. Optional judge synthesis is explicit about which provider produced the judge job.

#### LLM Request Tools

##### `claude_request`

Execute a Claude Code request with optional session management.

**Parameters:**

- `prompt` (string, optional*): The prompt to send (1-100,000 chars). *Exactly one of `prompt` or `promptParts` is required (mutually exclusive)
- `model` (string, optional): Model name or alias (use `list_models` for available values; supports `latest`)
- `outputFormat` (string, optional): Output format (`text|json|stream-json`), default: `stream-json` — the gateway parses NDJSON usage events for token/cost observability; override to `text` only when you want unparsed stdout
- `sessionId` (string, optional): Specific session ID to use
- `continueSession` (boolean, optional): Continue the active session
- `createNewSession` (boolean, optional): Always create a new session
- `forkSession` (boolean, optional): Fork the resumed session instead of appending to it
- `allowedTools` (string[], optional): Restrict Claude tools to this allow-list
- `disallowedTools` (string[], optional): Explicitly deny listed Claude tools
- `permissionMode` (string, optional): Claude permission mode (`default|acceptEdits|plan|auto|dontAsk|bypassPermissions`); preferred over `dangerouslySkipPermissions`
- `dangerouslySkipPermissions` (boolean, optional): Deprecated — maps to `permissionMode: "bypassPermissions"`; `permissionMode` wins when both are set
- `agent` (string, optional): Named sub-agent to run as
- `agents` (string, optional): Inline agent definitions JSON
- `systemPrompt` / `appendSystemPrompt` (string, optional): Replace or extend the system prompt
- `maxBudgetUsd` (number, optional): Budget cap in USD for the request
- `maxTurns` (integer, optional): Agent-loop turn cap
- `effort` (string, optional): Reasoning effort (`low|medium|high|xhigh|max`)
- `fallbackModel` (string, optional): Auto-fallback model when the default is overloaded
- `jsonSchema` (string, optional): JSON Schema literal constraining structured output
- `addDir` (string[], optional): Additional workspace directories
- `noSessionPersistence` (boolean, optional): Ephemeral session (not persisted to disk)
- `settingSources` / `settings` / `tools` (optional): Setting sources to load, settings JSON path/literal, built-in tool restriction
- `excludeDynamicSystemPromptSections` (boolean, optional): Trim dynamic system prompt sections
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): Names of MCP servers to expose to Claude (default: none). The gateway resolves each name to a launch command from its local registry / Codex MCP config; unknown names are reported as unavailable. Configure the servers your deployment uses in the gateway environment.
- `strictMcpConfig` (boolean, optional): Require Claude to use only supplied MCP config, default: true (request fails if any requested server is unavailable)
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency (44% reduction), default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency (37% reduction), default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck process after output inactivity; 30,000 to 3,600,000 ms
- `worktree` (boolean|object, optional): Run inside a gateway-owned git worktree (slice λ)
- `promptParts` (object, optional): Cache-aware structured prompt `{ system?, tools?, context?, task }`; mutually exclusive with `prompt`
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false

Workspace boundary: stdio callers may use machine-local paths directly. HTTP/tunnel callers must pass `workspace` or rely on a configured default/session workspace; path fields are then validated relative to that workspace. `[workspaces].allow_unregistered_working_dir` is a stdio/local legacy setting and does not allow arbitrary HTTP working directories or additional directories.

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

- `prompt` (string, optional*): The prompt to send (1-100,000 chars). *Exactly one of `prompt` or `promptParts` is required (mutually exclusive)
- `model` (string, optional): Model name or alias (use `list_models` for available values; supports `latest`, recommended: `gpt-5.5`)
- `fullAuto` (boolean, optional): Deprecated — expands to `--sandbox workspace-write` only (current Codex no longer accepts approval-policy flags); prefer `sandboxMode`
- `sandboxMode` (string, optional): Codex sandbox (`read-only|workspace-write|danger-full-access`)
- `dangerouslyBypassApprovalsAndSandbox` (boolean, optional): Request Codex bypass flags
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): MCP servers expected for Codex execution context
- `sessionId` (string, optional): Session identifier for tracking
- `resumeLatest` (boolean, optional): Resume the most recent Codex session in the current cwd (`codex exec resume --last`); ignored if `sessionId` is set
- `createNewSession` (boolean, optional): Always create a new session
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false
- `outputFormat` (string, optional): `text` (default) or `json` (`--json` JSONL events for token usage extraction)
- `outputSchema` (string|object, optional): Codex `--output-schema` — path or inline JSON Schema
- `workingDir` (string, optional): Working root for this session (`-C`/`--cd`; new sessions only)
- `addDir` (string[], optional): Additional writable workspace directories (one `--add-dir` per entry; new sessions only)
- `ephemeral` (boolean, optional): Codex `--ephemeral` (no session persistence)
- `images` (string[], optional): Image attachments (one `-i <path>` per entry)
- `profile` (string, optional): Codex `--profile <name>` (new sessions only; ignored with a logged warning on resume)
- `configOverrides` (object, optional): Codex `-c key=value` overrides
- `ignoreRules` / `ignoreUserConfig` (boolean, optional): Codex `--ignore-rules` / `--ignore-user-config`
- `worktree` (boolean|object, optional): Run inside a gateway-owned git worktree (slice λ)
- `promptParts` (object, optional): Cache-aware structured prompt `{ system?, tools?, context?, task }`; mutually exclusive with `prompt`
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency, default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck Codex process after output inactivity; 30,000 to 3,600,000 ms

**Response extras:**

- `approval`: Approval decision record when `approvalStrategy="mcp_managed"`
- `mcpServers`: Requested MCP servers for this call

**Example:**

```json
{
  "prompt": "Create a REST API endpoint",
  "model": "gpt-5.5",
  "sandboxMode": "workspace-write",
  "optimizePrompt": true
}
```

##### `codex_fork_session`

Fork an existing Codex session into a new branch (`codex fork <SESSION_ID|--last> <prompt>`), preserving the original session's history while the fork diverges.

**Parameters:**

- `prompt` (string, required): Prompt text for the forked session (1-100,000 chars)
- `sessionId` (string, optional): Codex session UUID to fork from (mutually exclusive with `forkLast`)
- `forkLast` (boolean, optional): Fork the most recent Codex session instead of naming one
- `model` (string, optional): Model name or alias (e.g. `gpt-5.5`, `latest`)
- `sandboxMode` (string, optional): Codex sandbox (`read-only|workspace-write|danger-full-access`)
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (number, optional): Idle timeout in ms (30s-1h, omit for CLI default)

##### `gemini_request`

Execute a Google Antigravity CLI (`agy`) request with session support.

**Parameters:**

- `prompt` (string, optional*): The prompt to send (1-100,000 chars). *Exactly one of `prompt` or `promptParts` is required (mutually exclusive)
- `model` (string, optional): Model name or alias (use `list_models` for available values; supports `latest`, `pro`, `flash`)
- `sessionId` (string, optional): Session ID to resume
- `resumeLatest` (boolean, optional): Resume the latest session automatically
- `createNewSession` (boolean, optional): Always create a new session
- `approvalMode` (string, optional): Antigravity approval mode in legacy mode. Only `default` (prompted execution) and `yolo` (emits `--dangerously-skip-permissions`) are accepted; `auto_edit` and `plan` are rejected with an error.
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `includeDirs` (string[], optional): Additional workspace directories (passed as `--add-dir`)
- `project` (string, optional): Select the Antigravity project for this session (`--project <ID>`); mutually exclusive with `newProject`
- `newProject` (boolean, optional): Create a new Antigravity project for this session (`--new-project`); mutually exclusive with `project`
- `sandbox` (boolean, optional): Run Antigravity in sandbox mode (`--sandbox`)
- `outputFormat` (string, optional): `text` only. Antigravity print mode emits text; `json` and `stream-json` are rejected.
- `mcpServers`, `allowedTools`, `policyFiles`, `adminPolicyFiles`, `attachments` (string[], optional) and `skipTrust` (boolean, optional): **Unsupported by Antigravity CLI** — non-empty values (or `skipTrust: true`) are rejected with an explanatory error. Retained in the schema for caller parity.
- `yolo` (boolean, optional): Auto-approve all; equivalent to `approvalMode: "yolo"`. Emits `--dangerously-skip-permissions`
- `worktree` (boolean|object, optional): Run inside a gateway-owned git worktree (slice λ)
- `promptParts` (object, optional): Cache-aware structured prompt `{ system?, tools?, context?, task }`; mutually exclusive with `prompt`
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency, default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck process after output inactivity; 30,000 to 3,600,000 ms
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false

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

- `prompt` (string, optional*): The prompt to send (1-100,000 chars). *Exactly one of `prompt` or `promptParts` is required (mutually exclusive)
- `model` (string, optional): Model name or alias (e.g. `grok-build`, `latest`)
- `transport` (string, optional): `"cli"` (default) runs the Grok CLI; `"acp"` routes through Grok's native `grok agent stdio` transport when `[acp].enabled` and the provider's `runtime_enabled` are set (fails closed otherwise). Sync-only: `grok_request_async` always runs the CLI transport and does not accept `transport`
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
- `maxTurns` (integer, optional): Agent-loop iteration cap (`--max-turns`)
- `workingDir` (string, optional): Working directory for this invocation (`--cwd`)
- `sandbox` (string, optional): Sandbox profile for filesystem/network access (`--sandbox`, freeform; also via `GROK_SANDBOX`)
- `rules` (string, optional): Extra rules appended to the system prompt (`--rules`; supports `@file` prefix)
- `systemPromptOverride` (string, optional): Replace the agent's system prompt entirely
- `allow` / `deny` (string[], optional): Permission allow/deny rules (one `--allow`/`--deny` per entry)
- `compactionMode` (string, optional): `summary` (default) `|transcript|segments`
- `compactionDetail` (string, optional): `none|minimal|balanced|verbose` (segments mode only)
- `agent` (string, optional): Agent name or definition file path
- `agents` (string|object, optional): Inline subagent definitions JSON
- `bestOfN` (integer, optional): Run the task N ways in parallel and pick the best (headless only)
- `check` (boolean, optional): Append a self-verification loop (headless only)
- `disableWebSearch` (boolean, optional): Disable web search and remote retrieval tools
- `todoGate` (boolean, optional): Enable runtime turn-end TodoGate (session-scoped)
- `verbatim` (boolean, optional): Send the prompt exactly as given (also skips gateway prompt optimisation)
- `promptFile` / `promptJson` / `single` (optional): Single-turn prompt from a file / JSON blocks / literal
- `experimentalMemory` / `noMemory` (boolean, optional): Enable/disable cross-session memory
- `noAltScreen` / `noPlan` / `noSubagents` (boolean, optional): Disable alt screen / plan mode / subagent spawning
- `oauth` (boolean, optional): Use OAuth during authentication
- `restoreCode` (boolean, optional): Check out the original session commit when resuming
- `leaderSocket` (string, optional): Custom leader socket path (`--leader-socket`, Grok 0.2.32+; default `~/.grok/leader.sock`) — targets an isolated leader process, e.g. a local/branch Grok build
- `nativeWorktree` (boolean|string, optional): Grok's own `--worktree` flag (`true` → bare, string → named); distinct from the gateway `worktree` option
- `worktreeRef` (string, optional): Branch/tag/commit to base the native worktree on (`--worktree-ref`); requires `nativeWorktree`
- `forkSession` (boolean, optional): Fork the resumed session into a new branch instead of appending to it
- `jsonSchema` (string|object, optional): JSON Schema (string or object) constraining structured output (`--json-schema`)
- `worktree` (boolean|object, optional): Run inside a gateway-owned git worktree (slice λ)
- `promptParts` (object, optional): Cache-aware structured prompt `{ system?, tools?, context?, task }`; mutually exclusive with `prompt`
- `optimizePrompt` (boolean, optional): Optimize prompt for token efficiency, default: false
- `optimizeResponse` (boolean, optional): Optimize response for token efficiency, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck process after output inactivity; 30,000 to 3,600,000 ms
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false

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
- **`llm_job_status` and `llm_job_result` work across gateway restarts.** Job rows live for 30 days by default; callers can collect results long after the in-memory cache has evicted them.
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

##### Host-protection limits (`[http]` and `[limits]`)

The gateway bounds HTTP session growth and async/sync job execution so a burst of
clients or requests cannot drive unbounded memory, process, CPU, or provider-request
growth. All keys live in the same `~/.llm-cli-gateway/config.toml`; defaults are
conservative but chosen not to surprise local stdio development.

```toml
[http]                              # HTTP MCP transport session lifecycle
max_sessions = 100                  # max concurrent live sessions; excess initialize returns HTTP 429
session_idle_ttl_ms = 1800000       # 30 min: reap a session idle longer than this (no client DELETE needed)
session_reaper_interval_ms = 60000  # 1 min: how often the idle reaper sweeps

[limits]                            # async + sync job-execution backpressure (per gateway process)
max_running_jobs = 32               # global concurrent running jobs (process CLI + HTTP API)
max_running_jobs_per_provider = 16  # per-provider concurrent running jobs
max_queued_jobs = 128               # bounded wait queue; a full queue rejects new work
queue_timeout_ms = 120000           # 2 min: max time a job waits in the queue before failing
completed_job_memory_ttl_ms = 3600000  # 1 h: in-memory retention for finished jobs (durable rows kept separately)
max_job_output_bytes = 52428800     # 50 MB: per-job stdout+stderr cap
```

Failure modes (all deterministic and safe to retry):

- **HTTP session cap reached**: the initialize request returns `429` with `Retry-After: 5` and a structured `{ error, code: "session_capacity", retryable: true }` body. No new session is created.
- **Idle HTTP session**: the reaper closes it (transport + gateway server) once idle past `session_idle_ttl_ms`, independent of the client sending `DELETE`. A session with an in-flight request is never reaped mid-request.
- **Job limiter saturated**: when the running limit is reached and the queue is full, `*_request` / `*_request_async` and the direct-sync fallback return a retryable `saturated` error (`structuredContent.errorCategory = "saturated"`, `retryable: true`). Nothing is spawned. When the queue has room the job waits (FIFO, per-provider fair) up to `queue_timeout_ms`, then fails with the same category.
- **Sync direct execution**: the `SYNC_DEADLINE_MS=0` and storeless/`backend="none"` paths acquire the same process permit before spawning, so no execution bypasses the limiter.
- **Output overflow**: a job whose combined stdout+stderr exceeds `max_job_output_bytes` is failed (exit code 126), its process terminated, its completion persisted, and its run slot released.
- **In-memory vs durable retention**: `completed_job_memory_ttl_ms` only ages finished jobs out of the in-memory map; the durable job store keeps its own (longer) `[persistence].retentionDays` retention, so results stay readable via `llm_job_result` / `llm_request_result` after in-memory eviction.

Live counters are exposed on `GET /healthz` (unauthenticated, HTTP transport) and via the `llm_process_health` tool `backpressure` block: session current/max/oldest-age/idle-TTL/saturation, running and queued job counts globally and per provider, limiter saturation counters, configured TTL/output caps, and parent-process RSS/heap. These surfaces report **counts, ages, and bytes only**, never prompt text, response content, tokens, session IDs, bearer/OAuth tokens, API keys, or machine secrets.

For production user services, pair the in-process limits above with systemd's
outer guardrails so an unexpected bug, provider CLI leak, or evaluation burst
cannot consume the host:

```bash
systemctl --user edit llm-cli-gateway.service
```

```ini
[Service]
MemoryMax=2G
TasksMax=512
```

Choose values for your workload: `MemoryMax` should cover the gateway process,
the configured `max_running_jobs` provider children, and normal output buffering;
`TasksMax` should exceed the process/thread count implied by `max_running_jobs`
plus the HTTP server and SQLite work, but still be far below host exhaustion. If
systemd terminates the service at those limits, durable jobs can be inspected
after restart and `llm_process_health.backpressure` should be used to tune
`[http]`, `[limits]`, `MemoryMax`, and `TasksMax` together.

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

Now every gateway subprocess spawned for _this_ repo's Claude Code window reads its own config and writes to its own SQLite file; sessions, jobs, and dedup state are scoped to the repo. Other repos keep using the global default. `llm_process_health.persistence.sources.configFile` lets an agent confirm which config it's actually running under.

###### Agent-executable spec (DAG-TOML)

If you want an LLM agent to perform this setup deterministically — rather than reading the prose above and guessing — copy the following DAG-TOML into the repo (e.g. `docs/planning/per-project-gateway-isolation.toml`) and point your agent at it. The schema is [`agent-assurance`](https://github.com/verivus-oss/agent-assurance/blob/main/SPEC.md) `template_kind = "implementation-dag"`. The agent MUST execute units in layer order, must not skip the verification unit, and must treat any failed gate as blocking.

```toml
[meta]
schema_version    = "1.0.0"
template_kind     = "implementation-dag"
docs              = "https://github.com/verivus-oss/agent-assurance/blob/main/SPEC.md"
confidentiality   = "public"
title             = "Per-project llm-cli-gateway persistence isolation"
spec              = "https://github.com/verivus-oss/llm-cli-gateway#per-project-isolation"
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
- `transport` (string, optional): `"cli"` (default) runs the Vibe CLI; `"acp"` routes through Vibe's native `vibe-acp` transport when `[acp].enabled` and the provider's `runtime_enabled` are set (fails closed otherwise). Sync-only: `mistral_request_async` always runs the CLI transport and does not accept `transport`
- `permissionMode`: the Vibe `--agent` name — builtins `default | plan | accept-edits | auto-approve`, or any install-gated/custom agent. Emitted as `--agent <name>`. Defaults to `auto-approve` in programmatic mode.
- `allowedTools` (string[], optional): One `--enabled-tools <tool>` flag per entry (allow-list only).
- `disallowedTools` (string[], optional): Accepted for parity with the other providers; ignored at the CLI boundary with a logged warning.
- `outputFormat` (string, optional): Vibe 2.x values are `"text"`, `"json"`, or `"streaming"`; legacy aliases `"plain"` and `"stream-json"` are accepted and normalized before spawn.
- `sessionId` / `resumeLatest` / `createNewSession`: standard session controls. Current Vibe defaults session logging to enabled; if an older config has `[session_logging] enabled = false`, `doctor --json` surfaces an actionable next-action.
- `trust` (boolean, optional): Emit `--trust` so Vibe trusts the cwd for this invocation only (not persisted; skips the interactive trust prompt)
- `maxTurns` (integer, optional): Agent-loop iteration cap (`--max-turns`, programmatic mode only)
- `maxPrice` (number, optional): Interrupt when cumulative cost crosses this USD cap (`--max-price`, programmatic mode only)
- `maxTokens` (integer, optional): Cap cumulative prompt + completion tokens (`--max-tokens`, programmatic mode only)
- `workingDir` (string, optional): Change to this directory before running (`--workdir`)
- `addDir` (string[], optional): Additional writable workspace directories (one `--add-dir` per entry)
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"`
- `mcpServers` (string[], optional): MCP server names tracked for approvals (Vibe manages its own MCP config via `vibe mcp`)
- `worktree` (boolean|object, optional): Run inside a gateway-owned git worktree (slice λ)
- `promptParts` (object, optional): Cache-aware structured prompt `{ system?, tools?, context?, task }`; mutually exclusive with `prompt`
- `optimizePrompt` / `optimizeResponse` (boolean, optional): Token-efficiency optimisation, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck process after output inactivity; 30,000 to 3,600,000 ms
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false

##### `devin_request`

Run a Cognition Devin CLI request synchronously (headless print mode, `devin -p`). Auto-defers to a pollable job past the sync deadline when async jobs are enabled.

**Parameters:**

- `prompt` (string, optional*): Prompt text for Devin CLI (1-100,000 chars). Required in practice; `promptFile` is additive
- `model` (string, optional): Model name or alias (e.g. `opus`, `latest`)
- `transport` (string, optional): `"cli"` (default) runs the Devin CLI; `"acp"` routes through Devin's native `devin acp` transport when `[acp].enabled` and the provider's `runtime_enabled` are set (fails closed otherwise). Sync-only: `devin_request_async` always runs the CLI transport and accepts neither `transport` nor `agentType`
- `agentType` (string, optional): ACP agent variant for `transport: "acp"` (`devin acp --agent-type`): `"summarizer"` (no tools, text summary) or `"review"` (read-only plus shell code-review); ignored for the CLI transport
- `permissionMode` (string, optional): Devin CLI permission mode (`--permission-mode`): `auto` (auto-approves read-only tools), `smart` (also auto-runs actions a fast model judges safe), `dangerous` (auto-approves all). Omit to use Devin's headless default
- `promptFile` (string, optional): Load the initial prompt from a file (`--prompt-file`)
- `sessionId` (string, optional): Devin session ID to resume (`--resume <id>`). The `gw-*` id minted for a brand-new session is not resumable via `sessionId`; continue with `resumeLatest: true`
- `resumeLatest` (boolean, optional): Resume the most recent Devin session in cwd (`--continue`)
- `createNewSession` (boolean, optional): Force a new session
- `optimizePrompt` / `optimizeResponse` (boolean, optional): Token-efficiency optimisation, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck process after output inactivity; 30,000 to 3,600,000 ms
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false

##### `cursor_request`

Run a Cursor Agent CLI request synchronously. Defaults to headless print mode (`cursor-agent --print`) and auto-defers to a pollable job past the sync deadline when async jobs are enabled. Set `transport: "acp"` to use Cursor's native `cursor-agent acp` transport when `[acp]` and `[acp.providers.cursor].runtime_enabled` are enabled; current ACP routing accepts only prompt/model/session inputs and rejects CLI-only options such as `mode`, `workspace`, `sandbox`, `force`, and `trust`.

**Parameters:**

- `prompt` (string, required): Prompt text for Cursor Agent CLI (1-100,000 chars)
- `model` (string, optional): Model name or alias (for example `gpt-5`, `sonnet-4-thinking`, or `latest`)
- `mode` (string, optional): Cursor mode, `"plan"` or `"ask"` (`--mode`)
- `outputFormat` (string, optional): `"text"` (default), `"json"`, or `"stream-json"`
- `transport` (string, optional): `"cli"` (default) or `"acp"`; ACP fails closed unless enabled in gateway config and rejects unsupported Cursor CLI-only controls instead of dropping them. Sync-only: `cursor_request_async` always runs the CLI transport and does not accept `transport`
- `force` (boolean, optional): Emit `--force` for non-interactive operation
- `autoReview` (boolean, optional): Emit `--auto-review`
- `sandbox` (string, optional): `"enabled"` or `"disabled"` (`--sandbox`)
- `trust` (boolean, optional): Emit `--trust` for this invocation
- `workspace` (string, optional): Cursor workspace path or name (`--workspace`); remote HTTP/OAuth callers must pass a registered workspace alias, while local stdio callers may pass paths
- `addDir` (string[], optional): Additional workspace roots (one `--add-dir` per entry); remote HTTP/OAuth callers must use registered workspace roots
- `sessionId` (string, optional): Cursor chat/session ID to resume (`--resume <id>`). The `gw-*` id minted for a brand-new gateway session is not resumable through `sessionId`; continue with `resumeLatest: true`
- `resumeLatest` (boolean, optional): Resume the most recent Cursor chat (`--continue`)
- `createNewSession` (boolean, optional): Force a new session
- `approvalStrategy` (string, optional): `"legacy"` (default) or `"mcp_managed"`; under MCP-managed approval, high-impact Cursor flags (`force`, `trust`, or `sandbox: "disabled"`) are denied unless bypass approval is explicitly allowed
- `approvalPolicy` (string, optional): `"strict"`, `"balanced"`, or `"permissive"` override for MCP-managed approval
- `optimizePrompt` / `optimizeResponse` (boolean, optional): Token-efficiency optimisation, default: false
- `correlationId` (string, optional): Request trace ID (auto-generated if omitted)
- `idleTimeoutMs` (integer, optional): Kill a stuck process after output inactivity; 30,000 to 3,600,000 ms
- `forceRefresh` (boolean, optional): Bypass dedup and force a fresh CLI run, default: false

##### `claude_request_async` / `codex_request_async` / `gemini_request_async` / `grok_request_async` / `mistral_request_async` / `devin_request_async` / `cursor_request_async`

Start a long-running Claude, Codex, Gemini, Grok, Mistral, Devin, or Cursor request without waiting for completion in the same MCP call.

Use this flow when analysis/runtime can exceed client tool-call limits:

1. Start job with `*_request_async`
2. Poll with `llm_job_status`
3. Read output with `llm_job_result`
4. Optionally stop with `llm_job_cancel`

Async request tools accept the same approval strategy fields as their sync variants:

- `approvalStrategy`: `"legacy"` (default) or `"mcp_managed"`
- `approvalPolicy`: `"strict"|"balanced"|"permissive"` override
- `mcpServers`: Names of requested MCP servers, resolved against the gateway's local registry / Codex MCP config
- `claude_request_async` also supports `strictMcpConfig` and fails fast when requested servers are unavailable

##### `llm_job_status`

Return lifecycle status (`queued`, `running`, `completed`, `failed`, `canceled`, `orphaned`) and metadata for an async job.

##### `llm_job_result`

Return captured stdout/stderr for an async job (with configurable max chars per stream).

##### `llm_job_cancel`

Cancel a running async job.

##### `approval_list`

List recent MCP-managed approval decisions recorded by the gateway.

**Parameters:**

- `limit` (number, optional): Max records (1-500), default: 50
- `cli` (string, optional): Filter by `"claude"`, `"codex"`, `"gemini"`, `"grok"`, or `"mistral"`

Approval records are persisted to `~/.llm-cli-gateway/approvals.jsonl`.

##### `llm_request_result`

Read back any persisted request — sync or async — by its correlation ID. Every response echoes its ID in `structuredContent.correlationId`; pass it here to recover the persisted prompt/response after the inline result is gone. Reads the flight recorder, so it works independently of async-job persistence (returns "not found" when flight recording is disabled).

**Parameters:**

- `correlationId` (string, required): Correlation ID from a prior request
- `maxChars` (number, optional): Max chars of the persisted response to return (1,000-2,000,000)
- `includePrompt` (boolean, optional): Include the full persisted prompt text, default: false

##### `llm_process_health`

Report gateway process health: async-job manager state plus the resolved persistence block (`backend`, `dbPath`, config sources). Use it to confirm which config file and SQLite paths the gateway is actually running under.

##### `upstream_contracts`

Return the gateway's declared provider CLI contracts, optionally probing the installed binaries for drift.

**Parameters:**

- `cli` (string, optional): Filter (`claude|codex|gemini|grok|mistral|devin|cursor`)
- `probeInstalled` (boolean, optional, default `false`): Run local `--help` probes and compare advertised flags against the declared contract — strongly recommended after any provider CLI upgrade. The probe reports `missingFlags`, `extraFlags`, `acknowledgedExtraFlags` (known upstream-only flags filtered from `extraFlags`), `discoveredFlags`, and stale-marker `warnings`.

#### Session Management Tools

##### `session_create`

Create a new session for a specific CLI.

**Parameters:**

- `cli` (string, required): CLI to create session for ("claude", "codex", "gemini", "grok", "mistral", "devin", "cursor")
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

- `cli` (string, optional): Filter by CLI ("claude", "codex", "gemini", "grok", "mistral", "devin", "cursor")

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

- `cli` (string, optional): Specific provider to list models for (`"claude"`, `"codex"`, `"gemini"`, `"grok"`, `"mistral"`, `"devin"`, `"cursor"`, or an enabled API provider name). When one or more `[providers.<name>]` API providers are enabled, the unfiltered response also carries an `apiProviders` array (each entry tagged `providerKind: "api"`); see [API providers (HTTP)](#api-providers-http).

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

##### `provider_tool_capabilities`

Report the provider tool and feature capability catalog. Use this before
orchestrating provider-specific requests so callers can distinguish supported
controls, provider-owned configuration, ignored parity fields, and unsupported
inputs.

**Parameters:**

- `cli` (string, optional): Provider filter (`"claude"`, `"codex"`, `"gemini"`, `"grok"`, `"mistral"`, `"devin"`, `"cursor"`, `"grok_api"`, or an enabled API provider name)
- `includeSkills` (boolean, default `true`): Include bounded local skill discovery
- `includeProviderTools` (boolean, default `true`): Include provider-native tools extracted from discovered skills
- `includeUnsupported` (boolean, default `true`): Include explicit unsupported/degraded input records
- `includePaths` (boolean, default `false`): Include raw local filesystem paths in discovery output
- `refresh` (boolean, default `false`): Bypass the short-lived capability cache

The response schema is `provider-tool-capabilities.v2`. Capability discovery is
read-only and bounded; raw local paths are redacted unless `includePaths` is
explicitly true, and secret-bearing auth files are not read.

Equivalent MCP resources:

- `provider-tools://catalog`: full provider catalog
- `provider-tools://claude`
- `provider-tools://codex`
- `provider-tools://gemini`
- `provider-tools://grok`
- `provider-tools://grok_api`
- `provider-tools://mistral`
- `provider-tools://devin`
- `provider-tools://cursor`
- `provider-tools://<api-provider>` for each enabled `[providers.<name>]` API provider

`doctor --json` also emits a compact `provider_capabilities` block with the
same schema version, per-provider request tool names, supported feature names,
unsupported input names, config-surface counts, discovery counts, and resource
URIs. This block is intended for setup assistants that need a concise capability
summary without local skill bodies or raw paths. When API providers are enabled,
`doctor --json` additionally emits an `api_providers` health block; see
[API providers (HTTP)](#api-providers-http).

##### `cli_versions`

Report installed CLI versions.

**Parameters:**

- `cli` (string, optional): Specific CLI to inspect ("claude", "codex", "gemini", "grok", "mistral", "devin", "cursor")

##### `cli_upgrade`

Plan or run an upgrade for one CLI.

**Parameters:**

- `cli` (string, required): CLI to upgrade ("claude", "codex", "gemini", "grok", "mistral", "devin", "cursor")
- `target` (string, optional): Package tag/version/target, default: `latest`
- `dryRun` (boolean, optional): Return the upgrade plan without running it, default: `true`
- `timeoutMs` (number, optional): Upgrade timeout when `dryRun=false`

**Upgrade strategies:**

- Claude latest: `claude update`
- Claude explicit target: `claude install <target>`
- Codex latest: `codex update`
- Codex explicit target: `npm install -g @openai/codex@<target>`
- Gemini latest: `agy update` (Antigravity self-update; explicit version targets are unsupported)
- Grok latest: `grok update`
- Grok explicit target: `grok update --version <target>`
- Mistral (Vibe): dispatches to the detected installer (`pip`/`uv`/`brew`); errors with guidance when none is detected (Vibe ships no self-update command)
- Devin latest: `devin update` (self-update; explicit version targets are unsupported)
- Cursor latest: `cursor-agent update` (self-update; explicit version targets are unsupported)

**Example dry run:**

```json
{
  "cli": "gemini",
  "target": "latest",
  "dryRun": true
}
```

## API providers (HTTP)

In addition to the spawnable CLI tools, the gateway can route requests to first-class **HTTP/API providers** (OpenRouter and other OpenAI-compatible endpoints, the Anthropic Messages API, and the xAI Responses API). These use Node's built-in HTTP client (`node:https`, or `node:http` for loopback endpoints) rather than spawning a CLI, and they run through the same request/job/validation/flight-recorder machinery as the CLI tools, so they reach parity for sessions, async jobs, dedup, retries, usage/cost capture, and cross-LLM validation.

### Configuring a provider

API providers are declared as `[providers.<name>]` blocks in `~/.llm-cli-gateway/config.toml` (override with `LLM_GATEWAY_CONFIG`). The `<name>` becomes the provider's identity across every tool and resource and **must not** collide with a spawnable CLI name (`claude`, `codex`, `gemini`, `grok`, `mistral`, `devin`, `cursor`); a collision is rejected with a warning and the provider is disabled.

```toml
# OpenRouter (OpenAI-compatible). The key is read from the named env var at
# request time and is never written to config, logs, the flight recorder, or
# the dedup key.
[providers.openrouter]
kind = "openai-compatible"                 # "openai-compatible" | "anthropic" | "xai-responses"
base_url = "https://openrouter.ai/api/v1"
api_key_env = "OPENROUTER_API_KEY"         # env var NAME, not the key itself
default_model = "x-ai/grok-2"
models = ["x-ai/grok-2", "anthropic/claude-sonnet-4.6"]   # optional allowlist: an explicit model must be listed (omit model to use default_model)
usage_include = true                       # OpenRouter token/cost reporting (usage:{include:true})

# Keyless-local: an openai-compatible provider on a loopback base_url (Ollama,
# llama.cpp) is enabled with no api_key_env at all.
[providers.ollama]
kind = "openai-compatible"
base_url = "http://127.0.0.1:11434/v1"
default_model = "qwen2.5"
```

A provider is **enabled** when its `api_key_env` resolves to a non-empty value, OR it is a keyless-local `openai-compatible` provider on a loopback `base_url`. `base_url` must use `https` unless it targets localhost/loopback. A **schema-invalid** single `[providers.<name>]` block disables only itself (with a warning) and leaves the other providers untouched; a TOML **syntax** error anywhere in the file is different, it makes the whole config fall back to defaults.

The pre-existing `[providers.xai]` block keeps its dedicated `grok_api_request` tool and xAI identity. It is also exposed through the generic surface like any other enabled provider, so a configured xAI key registers **both** `grok_api_request` and the generic `api_xai_request` (and the `xai` entry appears in `apiProviders`, `models://xai`, etc.).

### Request tools

For each enabled provider, the gateway registers `api_<name>_request` (and `api_<name>_request_async` when async jobs are enabled). They accept the same shape as the CLI request tools:

- `prompt` (or the cache-aware `promptParts` `{ system?, tools?, context?, task }`, mutually exclusive), optional `system`
- `model` (omit to use `default_model`; an explicit value is rejected if outside a configured `models` allowlist), `maxOutputTokens`, `temperature`, `topP`
- `reasoningEffort` (`none|low|medium|high`): forwarded only by the `xai-responses` adapter; accepted but ignored by the other kinds
- `timeoutMs`, `optimizePrompt`, `optimizeResponse`, `forceRefresh`, `correlationId`
- `sessionId` / `createNewSession` for continuity on the synchronous `api_<name>_request` (see below); on the async variant they are currently inert

Responses (and the 50 MB output cap, dedup window, cancellation, retention) behave exactly as for the CLI tools, and HTTP requests are logged to the flight recorder with status/usage/cost like everything else.

### Continuity

Continuity is capability-typed per provider kind and never stores conversation content in the session record (the gateway's no-transcript-in-sessions invariant holds):

- **`xai-responses`** uses real server-side continuation: the gateway persists the provider's `previous_response_id` in session metadata and threads it back on resume, self-healing on a stale-handle 404.
- **`openai-compatible`** and **`anthropic`** are stateless-resend: the session tracks active/owner state for principal isolation, but the caller resends prior context (no server-side conversation handle exists).

### Discovery surfaces

Enabled API providers appear, alongside the CLI providers, across the discovery surfaces. The model, capability, doctor, and resource surfaces below **omit** their API field entirely when no API providers are enabled, so their output is byte-identical to before; `llm_process_health` is the exception (it always carries an `apiProviders` array that is simply empty when none are enabled):

- **`list_models`** / **`list_available_models`**: an `apiProviders` array tagged `providerKind: "api"` with `defaultModel` and the optional allowlist, omitted entirely when no API providers are enabled.
- **`llm_process_health`**: an always-present `outboundProviders.apiProviders` array (empty when none are enabled) carrying the same projection plus each provider's circuit-breaker state.
- **`provider_tool_capabilities`**: per-`api`-kind capability metadata. Model + sampling + (for `xai-responses`) reasoning + continuity are supported; allow/deny tool lists, MCP servers, local skills, and workspace/worktree controls are not (those are CLI-only).
- **`doctor --json`**: an `api_providers` health block (kind, `base_url`, `default_model`, models, the key env var name, whether the key is present, and login guidance), omitted entirely when none are enabled. The optional flag `doctor --json --probe-api-providers` adds a per-provider endpoint-reachability result (a bare `GET`, treating any HTTP response as reachable). The probe is **opt-in and off by default**: a normal `doctor` run opens no socket and spends no tokens (`reachable` stays `null`).
- **MCP resources**: `models://<provider>` for every enabled provider and `sessions://<provider>` for continuity-tracked kinds, plus `provider-tools://<provider>`. The `provider-subcommands://` resources stay CLI-only (API providers have no subcommands).

The API key value is never emitted on any of these surfaces (only the env var name and a presence boolean). Because `base_url` is config-supplied and may legally carry URL userinfo, the diagnostic surfaces (`doctor`, login guidance) redact any embedded credentials before displaying it; the actual request path and the reachability probe still use the original configured URL.

### Security note

The resolved API key is excluded from `payloadJson`, the dedup key, logs, and the flight recorder. However, the **request prompt is persisted in plaintext** in the async job store (the SQLite file at `[persistence].path`, default `~/.llm-cli-gateway/logs.db`) and is not covered by secret redaction. This mirrors the CLI tools, whose prompt is persisted in `argsJson` whenever it is passed as a command argument (a few CLI paths instead stream the prompt over stdin and so do not persist it). Treat the job store as sensitive at rest. See [Security Considerations](#security-considerations).

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
  setAsActive: true,
});

// 2. Make requests (automatically uses active session)
await callTool("claude_request", {
  prompt: "What's the bug in this code?",
  // sessionId is automatically used
});

// 3. Continue the conversation
await callTool("claude_request", {
  prompt: "Can you explain that fix in more detail?",
  continueSession: true,
});

// 4. List all sessions
await callTool("session_list", { cli: "claude" });

// 5. Switch to a different session
await callTool("session_set_active", {
  cli: "claude",
  sessionId: "some-other-session-id",
});

// 6. Delete when done
await callTool("session_delete", {
  sessionId: "session-id-to-delete",
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
- `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS`: Under `approvalStrategy:"mcp_managed"`, a full permission / sandbox bypass request (e.g. `dangerouslyBypassApprovalsAndSandbox`, `dangerouslySkipPermissions`) is **denied by default** regardless of approval score, **and** `mcp_managed` no longer force-bypasses any provider — each defaults to an auto-accept-edits-level mode (auto-accept file edits, still gate Bash and other dangerous tools) instead of full auto-approve:
  - **Claude** → `--permission-mode acceptEdits` (was `bypassPermissions`)
  - **Grok** → `--permission-mode acceptEdits` (was `--always-approve`)
  - **Mistral (Vibe)** → `--agent accept-edits` (was `--agent auto-approve`)
  - **Gemini (Antigravity)** → `default` / prompted, i.e. **no** `--dangerously-skip-permissions` (the `agy` CLI has no accept-edits middle rung, so the safe default is prompted execution; without the opt-in, Gemini cannot auto-approve mutating tools under `mcp_managed`)

  Set to `1`/`true` to let the operator opt back in: this permits bypass requests through the approval gate **and** restores each provider's full auto-approve mode under `mcp_managed` (Claude `bypassPermissions`, Grok `--always-approve`, Mistral `--agent auto-approve`, Gemini `--dangerously-skip-permissions`). Sandboxed auto modes (e.g. codex `--sandbox workspace-write`) are unaffected.
  ```bash
  LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1 node dist/index.js
  ```
- `LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER`: Name of an HTTP header carrying the authenticated user identity asserted by a **trusted front door** (any identity-aware reverse proxy / IdP). When set, the gateway adopts that header value as the request's ownership principal — but **only** for requests authenticated with the gateway's own static bearer token (i.e. the trusted upstream proxy), never from an arbitrary remote client. Off by default; IdP-agnostic. Lets a proxy-fronted multi-user deployment carry per-user identity into the gateway.
  ```bash
  LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER=x-gateway-principal node dist/index.js
  ```
- `LLM_GATEWAY_OAUTH_REQUIRE_CONSENT` / `LLM_GATEWAY_OAUTH_CONSENT_SECRET`: Opt-in human-consent gate for the built-in OAuth server. When enabled (`REQUIRE_CONSENT=1`, or implied by setting `CONSENT_SECRET`), `/oauth/authorize` renders an operator approval page (CSRF-protected) and issues an authorization code **only** after the dedicated consent password is entered — instead of auto-issuing. `CONSENT_SECRET` is the plaintext password (hashed in memory; or persist a `consent_secret_hash` in `[http.oauth]`). Off by default; remote OAuth refuses to enable consent without a secret to verify.
  ```bash
  LLM_GATEWAY_OAUTH_REQUIRE_CONSENT=1 LLM_GATEWAY_OAUTH_CONSENT_SECRET='choose-a-strong-code' node dist/index.js
  ```
- `LLM_GATEWAY_CONFIG`: Path to the gateway TOML config (default: `~/.llm-cli-gateway/config.toml`). See **Persistence configuration** above for the `[persistence]` schema.
- `LLM_GATEWAY_LOGS_DB`: **Deprecated** — overrides `[persistence].path` and selects `backend = "sqlite"` (or `backend = "none"` when set to `none`). Emits a deprecation warning at startup; migrate to `config.toml`.
  ```bash
  # Custom path
  LLM_GATEWAY_LOGS_DB=/var/log/gateway/logs.db node dist/index.js
  # Disable durable persistence (also disables *_request_async tools)
  LLM_GATEWAY_LOGS_DB=none node dist/index.js
  ```
- `LLM_GATEWAY_REDACT_LOGGED_SECRETS`: Redact recognisable secrets (provider/cloud/VCS keys, bearer tokens, JWTs, PEM private keys, `key=value` secret assignments) from the prompt/system/response copies written to the flight-recorder log. **Enabled by default**; set to `0`/`false`/`off`/`no` to store content verbatim. Only the audit log is affected — live sync responses and async `llm_job_result` output are never altered.
  ```bash
  # Opt out of flight-recorder secret redaction
  LLM_GATEWAY_REDACT_LOGGED_SECRETS=0 node dist/index.js
  ```

### CLI-Specific Settings

Each CLI can be configured through its own configuration files:

- Claude Code: `~/.claude/config.json`
- Codex: `~/.codex/config.toml`
- Gemini: `~/.gemini/config.json`

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
which agy
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
chmod +x $(which agy)
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
- **API-provider keys**: For `[providers.<name>]` HTTP providers, the gateway reads the key from the named environment variable at request time only. The resolved key is excluded from the persisted `payloadJson`, the dedup key, logs, and the flight recorder, and is never surfaced on the discovery/diagnostic surfaces (which report only the env var name and a presence boolean). `base_url` userinfo is redacted on the diagnostic surfaces. See [API providers (HTTP)](#api-providers-http).
- **Prompt persistence at rest**: Async job rows store the request **prompt in plaintext** (HTTP `payloadJson`, and CLI `argsJson` whenever the prompt is passed as a command argument rather than streamed over stdin); this is not covered by secret redaction. The SQLite job-store file (default `~/.llm-cli-gateway/logs.db`, configurable via `[persistence].path`) is `chmod`ed to `0o600` on non-Windows hosts; treat it as sensitive and scope/rotate it like any prompt log. Set `[persistence].backend = "none"` to disable the async job store entirely (the `*_request_async` / `llm_job_*` tools are then not registered).
- **Command Execution**: Uses `spawn` with separate arguments (not shell execution)
- **No Eval**: No dynamic code evaluation in our source (see "Socket alerts" below for the transitive `ajv` codegen case)
- **Sandboxing**: Consider running in containers for production use
- **Provenance**: Releases are published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements) via OIDC trusted publishing from GitHub Actions
- **Release signing**: GitHub release installer artifacts are signed with Sigstore keyless signing; verify `SHA256SUMS.sigstore.json` before trusting the checksum file

### Socket alerts — context for reviewers

If you're vetting `llm-cli-gateway` through [Socket](https://socket.dev/npm/package/llm-cli-gateway) or a similar supply-chain scanner, you'll see behavioural alerts and some dependency-ownership alerts. They are accurate descriptions of what the package does and what it depends on. The reviewed `shellAccess` and `shrinkwrap` entries are configured in `socket.yml` for repository/PR policy surfaces, but Socket's public package page may still display them for the published npm artifact; the rationale remains documented here and in the package.

The currently flagged surfaces are not new in 2.6.x: the 2.3.0, 2.4.0, 2.5.0, and 2.6.3 npm tarballs all include `npm-shrinkwrap.json`, and all include the same `dist/executor.js` child-process spawn surface used to run provider CLIs. The `socket.yml` policy for 2.4.0, 2.5.0, 2.6.0, and 2.6.3 is materially the same for `shellAccess`; this README now adds the missing shrinkwrap disclosure as well.

| Alert                        | Where                                                                                                                                                                                                                                                                                     | Why it's bounded                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Network access**           | `src/http-transport.ts` opens an HTTP MCP transport when started via `npm run start:http`. `src/endpoint-exposure.ts` issues a HEAD probe to verify configured public/tunnel URLs. Socket also flagged `dist/upstream-contracts.js` in v1.17.2 from descriptive text, not a network call. | The transport binds to `127.0.0.1` by default and requires `LLM_GATEWAY_AUTH_TOKEN` to be set. The default stdio MCP entry point (`npm start`) opens no sockets. `src/upstream-contracts.ts` stores provider CLI metadata and imports no HTTP client APIs.                                                                                                                                                                                                                             |
| **Shell access**             | `src/executor.ts` uses `child_process.spawn(cmd, args, …)` to invoke the underlying LLM CLIs.                                                                                                                                                                                             | `spawn` is called with an argument array and **never** `shell: true`, so there is no shell interpolation path for caller input. The command name is restricted to an allow-list of known CLI binaries (`claude`, `codex`, `agy`, `grok`, `vibe`).                                                                                                                                                                                                                                      |
| **Published shrinkwrap**     | The npm artifact includes `npm-shrinkwrap.json`; `package.json#files` includes it and `scripts/make-prod-shrinkwrap.mjs` generates it from `package-lock.json`.                                                                                                                           | This is a CLI/application package. npm documents the shrinkwrap use case for applications, daemons, and command-line tools published through the registry. Our shrinkwrap is a prod-only projection, not a committed full dev lockfile: `scripts/release-security-audit.sh` verifies parity with the audited lockfile, and `scripts/verify-registry-install.sh` proves fresh registry consumers receive no `better-sqlite3`/`prebuild-install`/`tar-fs`/`tar-stream` production chain. |
| **Uses eval**                | None in our source. Transitive: `@modelcontextprotocol/sdk` → `ajv@8` uses `new Function(...)` in `ajv/dist/compile/index.js` to compile JSON Schema validators.                                                                                                                          | This is ajv's standard codegen path. Only known schemas (defined in our source and the MCP SDK) flow into it; no caller-supplied data ever reaches the compiled function body.                                                                                                                                                                                                                                                                                                         |
| **SQLite adapter isolation** | Persistence uses Node's built-in `node:sqlite` module (no native binding, no install scripts) through a single adapter, `src/sqlite-driver.ts`.                                                                                                                                           | `node:sqlite` is touched by exactly one production module (the adapter); every other module talks to SQLite through its typed surface. We never call any `db.pragma()` helper (it does not exist on `node:sqlite`); SQLite setup uses fixed literal `db.exec("PRAGMA ...")` statements. `npm run security:audit` fails the release if production code references `node:sqlite` outside the adapter or reintroduces a `.pragma()` call.                                                 |
| **Dependency ownership**     | A handful of small transitive packages (e.g. `media-typer` via `@modelcontextprotocol/sdk`) trip Socket's "unstable ownership" or "obfuscated code" heuristics.                                                                                                                           | These are pinned, well-known micro-deps in the Node ecosystem with no known issues. We pin direct override versions of `content-type` and `type-is` in `package.json#overrides`. As of 2.0.0 the prod graph carries no native module (`better-sqlite3` moved to devDependencies; `node:sqlite` is built into Node), eliminating the entire `prebuild-install`/`tar-fs`/`tar-stream` install-time chain. Our earlier direct dependency on `toml@3.0.0` was replaced with `smol-toml`.   |

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
