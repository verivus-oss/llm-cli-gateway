# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This repository contains the **llm-cli-gateway** (npm `llm-cli-gateway`, MCP name `io.github.verivus-oss/llm-cli-gateway`), a production-ready Model Context Protocol (MCP) server that provides unified access to multiple LLM CLI tools (Claude Code, Codex, Gemini, Grok, Mistral Vibe, Devin, and Cursor). The canonical provider list is `CLI_TYPES` in `src/provider-types.ts`. The gateway enables multi-LLM orchestration, session management, async job orchestration with durable results, cross-LLM validation, token optimization, and retry logic with circuit breakers. Requires Node `>=24.4.0` (uses the built-in `node:sqlite` module).

The package is developed in this internal repo and released via a public GitHub mirror (`verivus-oss/llm-cli-gateway`) that publishes to npm. See the memory notes on the release flow before touching anything release related.

## Development Commands

### Build and Test

The test runner is **vitest** (`npm test` == `vitest run`). The default suite spans `src/__tests__/**/*.test.ts` and `scripts/**/*.test.mjs`.

```bash
# Build TypeScript to JavaScript (tsconfig.build.json excludes tests)
npm run build

# Run all tests
npm test

# Run a single test file (any path)
npx vitest run src/__tests__/executor.test.ts
# ...or a single test by name
npx vitest run -t "circuit breaker opens"

# Named suite shortcuts
npm run test:unit          # executor.test.ts
npm run test:session       # session-manager.test.ts
npm run test:integration   # real CLI calls (INTEGRATION_TESTS=1)
npm run test:fuzz          # fast-check property/fuzz tests
npm run test:pg            # Postgres-backed suites (spins up PG via scripts/test-pg.sh)
npm run test:all           # npm test + test:pg
npm run test:coverage      # v8 coverage (70% lines/functions/statements, 60% branches)

# Watch mode for development
npm run test:watch

# Full gate: build + lint + format:check + provider-surfaces check + site checks + test + security:audit
npm run check
```

`npm run check` also runs two structural gates and the release audit:

- `npm run provider:surfaces:check` - the DRY ratchet for the provider registry: fails on any hand-maintained provider-name array or literal `sessions://` / `models://` resource URI outside the sanctioned files (everything must derive from `src/provider-definitions.ts` / `CLI_TYPES`).
- `npm run site:generate:check` + `npm run site:validate` - `scripts/generate-site-discovery.mjs` generates `site/agent.json`, `.well-known/api-catalog`, `.well-known/ai-catalog.json`, `.well-known/mcp/server-card.json`, `.well-known/mcp.json`, `tools.md`, and `tools.fixture.json` from the live MCP tool surface. Regenerate those artifacts with `npm run site:generate`. `llms.txt`, `DISCOVERY.md`, `sitemap.*`, `openapi.json`, `agents.md`, and `.well-known/agent.json` are maintained separately and validated for discovery consistency.
- `scripts/release-security-audit.sh` (`npm run security:audit`), which enforces release invariants. For example, `node:sqlite` must not be referenced outside `src/sqlite-driver.ts`, and packed `dist/**/*.js` and `dist/**/*.d.ts` must contain no unapproved `fetch` token. Run it before any release.

### Linting and Formatting

```bash
# Run ESLint
npm run lint

# Auto-fix ESLint issues
npm run lint:fix

# Format code with Prettier
npm run format

# Check formatting without changes
npm run format:check
```

### Running the Server

```bash
# Start the MCP server (stdio transport, default)
npm start

# With debug logging
DEBUG=1 npm start

# HTTP transport (OAuth-gated remote surface)
npm run start:http        # node dist/index.js --transport=http

# Environment doctor (provider/CLI health, JSON output)
npm run doctor            # node dist/index.js doctor --json

# Apply PostgreSQL migrations (requires DATABASE_URL; install optional pg peer if absent)
DATABASE_URL='postgresql://<user>:<password>@<host>/<database>' npm run migrate
```

## Architecture

### Core Modules

The codebase follows strict single-responsibility principles:

- **`src/index.ts`** - Main MCP server setup and tool orchestration (the largest file in the tree). Defines all tools (`claude_request` / `codex_request` / `gemini_request` / `grok_request` / `mistral_request` / `devin_request` / `cursor_request` and their `*_request_async` variants, validation tools, session/job/workspace tools). The heavy per-request logic is delegated to `src/request-helpers.ts`; `createGatewayServer` (re-exported via the tiny `src/gateway-server.ts`) wires everything together behind a `GatewayServerRuntime`. All logging must go to stderr (stdout is reserved for MCP protocol).

- **`src/request-helpers.ts`** - Shared request-handling logic factored out of `index.ts`: building CLI args, running the executor, normalizing provider output, two-phase flight-recorder logging, and principal-isolation enforcement. Most provider behavior lives here, not in `index.ts`.

- **`src/executor.ts`** - CLI command execution with timeout support. Spawns child processes with extended PATH (includes ~/.local/bin, ~/.nvm paths). Enforces 50MB output limit to prevent DoS. Implements graceful termination (SIGTERM → SIGKILL after 5s). Unscoped CLI children receive a fresh private cwd from `src/neutral-workspace.ts`; native `E2BIG` is normalized through `src/cli-input-limits.ts`.

- **`src/session-manager.ts`** - Persistent session storage. Uses atomic file writes (temp file + fsync + rename) to prevent corruption. Sessions stored in `~/.llm-cli-gateway/sessions.json` with 0o600 permissions. Maintains active session per CLI type. `src/session-manager-pg.ts` is the Postgres-backed variant (over the `pg` pool in `src/db.ts`), exercised by the `*-pg` suites via `npm run test:pg`.

- **`src/retry.ts`** - Exponential backoff retry logic with circuit breaker pattern. Per-CLI circuit breakers track failures (threshold: 5, reset: 60s). Distinguishes transient errors (timeout, ECONNRESET) from non-transient (ENOENT).

- **`src/optimizer.ts`** - Token optimization for prompts (44% reduction) and responses (37% reduction). Opt-in via optimizePrompt/optimizeResponse parameters.

- **`src/resources.ts`** - MCP resources provider. Exposes session data (`sessions://*`), model registries (`models://*`), and performance metrics (`metrics://performance`) as MCP resources. CLI/model info itself lives in `src/model-registry.ts`.

- **`src/metrics.ts`** - Performance tracking for CLI requests (latency, token usage, success rates).

- **`src/sqlite-driver.ts`** - Thin adapter over Node's built-in `node:sqlite` module (`DatabaseSync`). The ONLY production module that touches `node:sqlite`; flight-recorder and job-store talk to SQLite exclusively through its `GatewayDatabase`/`GatewayStatement` surface (`openDatabase`/`openReadOnly`/`withTransaction`). No native binding, no install scripts. As of 2.0.0, better-sqlite3 is a devDependency only (legacy-schema seeding tests + cross-engine WAL fixtures); the release security audit hard-fails if `node:sqlite` is referenced outside this adapter.

- **`src/flight-recorder.ts`** - SQLite flight recorder over the `node:sqlite` adapter (`src/sqlite-driver.ts`). Logs all requests/responses to `~/.llm-cli-gateway/logs.db` with two-phase logging (logStart/logComplete), WAL mode, and graceful degradation. `queryRequests` uses a dedicated read-only connection (`openReadOnly`) so write-disguised-as-read SQL fails at the SQLite engine level (SQLITE_READONLY). Configurable via `LLM_GATEWAY_LOGS_DB` env var.

- **`src/job-store.ts`** - Async-job persistence layer. Defines the `JobStore` interface plus three implementations: `SqliteJobStore` (default, durable), `MemoryJobStore` (ephemeral, used by tests), and `PostgresJobStore` (shipped: because the `JobStore` interface is synchronous, Postgres work runs in a worker thread, `src/postgres-job-store-worker.ts`, and each call waits for the worker's result; needs the optional `pg` peer dependency and a built `dist/`, plus `src/db.ts` / `scripts/test-pg.sh` for tests). A shared Postgres store can serve multiple gateway instances, so orphan recovery and normalized progress writes are status-fenced and instance-scoped rather than using a blanket startup sweep. Construct via `createJobStore(persistenceConfig)`. **Structural invariant**: when `persistence.backend = "none"`, `createJobStore` returns `null` AND `createGatewayServer` does not register the `*_request_async` / `llm_job_*` tools, making silent in-memory loss impossible by construction.

- **`src/config.ts`** - Gateway configuration loader. `loadPersistenceConfig()` reads `~/.llm-cli-gateway/config.toml` (override with `LLM_GATEWAY_CONFIG`), validated via Zod. The legacy env vars `LLM_GATEWAY_LOGS_DB` / `LLM_GATEWAY_JOBS_DB` / `LLM_GATEWAY_JOB_RETENTION_DAYS` / `LLM_GATEWAY_DEDUP_WINDOW_MS` still work as deprecated overrides and emit one-time warnings. The resolved `PersistenceConfig` is threaded through `GatewayServerRuntime` so tool registration can gate on `persistence.asyncJobsEnabled`.

- **`src/review-integrity.ts`** - Detects when orchestrating agents bypass multi-LLM review via tool suppression, empty allowedTools, or critical tool disabling. Three violation types with scoring.

- **`src/async-job-manager.ts`** - Orchestrates the `*_request_async` lifecycle: enqueue, run, poll/watch (`llm_job_status` / `llm_job_watch` / `llm_job_result` / `llm_job_cancel`), dedup window, retention. `src/job-progress.ts` produces bounded privacy-safe structured/activity progress and a versioned durable projection. Persists through the `JobStore` (see `job-store.ts`). Sync requests that exceed ~45s auto-defer into this same machinery.

- **`src/personal-config.ts`** / **`src/personal-config-types.ts`** - Personal Agent Config Kit for a single developer's verified Git baseline and repository overlay across local workstations. Kit execution is local-only, requires durable SQLite or PostgreSQL job admission, supports Claude and Codex only, binds context and native continuity to the current process, and fails closed when provenance or recovery evidence is incomplete. `src/codex-kit-isolation.ts`, `src/mcp-artifact-admission.ts`, and `src/mcp-artifact-recovery.ts` enforce its provider-isolation and durable-artifact boundaries.

- **`src/provider-definitions.ts`** - The provider registry: single source of truth for provider identity, capability, session-continuity, and discovery facts for every member of `CLI_TYPES` (`src/provider-types.ts` is the one sanctioned place the provider names are spelled out). No other module may keep its own provider list, capability matrix, or literal `sessions://` / `models://` URI; import the registry (or a projection via `src/provider-surface-generator.ts`) instead. Enforced by `npm run provider:surfaces:check` and a compile-time `satisfies Record<CliType, ProviderDefinition>`. Import direction is one-way: it imports only from `provider-types.ts`; everything else imports from it.

- **`src/model-registry.ts`** / **`src/mcp-registry.ts`** - Single source of truth for CLI/model metadata (`getCliInfo` / `getAvailableCliInfo`) and for the internal MCP server names. `mcp-registry.ts` is deliberately stripped to a stub in the published tarball; the release audit guards against internal names leaking.

- **Validation subsystem** (`src/validation-orchestrator.ts`, `validation-tools.ts`, `validation-prompts.ts`, `validation-normalizer.ts`, `validation-report.ts`, `validation-receipt.ts`) - Implements the cross-LLM validation tools (`review_changes`, `validate_with_models`, `second_opinion`, `compare_answers`, `red_team_review`, `consensus_check`, `synthesize_validation`). `src/review-scope.ts` captures complete hashed Git evidence and `src/review-prompt.ts` fences it as untrusted input. Validation runs are durable (`validation_runs`), gated on a SQLite or PostgreSQL validation-run store, and emit canonically hashed immutable receipts.

- **API-provider surface** (`src/api-provider.ts`, `api-request.ts`, `api-http.ts`) - First-class HTTP/API providers (OpenRouter, OpenAI-compatible) that reach parity with the CLI-tool providers, using `node:https` rather than spawning a CLI. Routed through the same request/job/validation machinery.

- **`src/http-transport.ts`** + **`src/oauth.ts`** / **`src/auth.ts`** + **`src/endpoint-exposure.ts`** - The optional remote HTTP transport (`--transport=http`) and its OAuth gating. Remote exposure is opt-in; principal isolation (per-caller session/workspace ownership) is enforced in `request-helpers.ts`.

- **`src/workspace-registry.ts`** + **`src/worktree-manager.ts`** - Gateway-owned workspaces and git worktrees (`workspace_*` tools), letting providers operate in isolated checkouts with lifecycle managed by the gateway.

- **`src/doctor.ts`** - The `doctor` CLI subcommand: probes provider CLIs, auth state, persistence config, and DB health; emits JSON validated against `setup/status.schema.json`.

- **`src/upstream-contracts.ts`** + **`src/provider-codegen.ts`** + **`src/provider-tool-capabilities.ts`** - Upstream-CLI drift detection. After upgrading any provider CLI, the read-only `--help` probes here detect subcommand/flag drift (`upstream_contracts`, `provider_subcommand_*` tools, `npm run upstream:contracts`).

- **`src/acp/`** - Agent Client Protocol runtime (JSON-RPC over stdio): client, process manager, permission bridge, session map, event normalizer, and smoke harness. Phase B live synchronous routing is shipped for Grok, Mistral, Devin, and Cursor, but remains dormant by default and fails closed unless the global ACP gate plus the provider `enabled` and `runtime_enabled` gates are configured. Claude, Codex, and Antigravity expose no native ACP route at their tracked versions; async request tools remain CLI-only.

### Multi-LLM Orchestration Patterns

**Pattern 1: Single-Level (Supported)**
Parent orchestrates multiple child LLMs directly:

```
Parent → codex_request (implementation)
Parent → claude_request (review)
Parent → gemini_request (bug finding)
```

**Pattern 2: Multi-Level (Not Supported)**
Child LLMs cannot orchestrate grandchildren due to MCP server lifecycle limitations. Nested MCP connections will fail with error -32000.

**Pattern 3: Manual Multi-Level (Recommended)**
Parent coordinates all levels sequentially:

```
1. codex_request (implement)
2. claude_request (review quality) + gemini_request (review bugs) in parallel
3. codex_request (apply fixes)
4. Verify with tests
```

### Session Management

Sessions persist conversation context across requests:

- Each CLI (claude/codex/gemini/grok/mistral/devin/cursor) can have one active session
- Sessions include: id, cli type, created/lastUsed timestamps, optional description
- Active session automatically used if no sessionId specified
- Session state is minimal (no conversation content stored)

### Error Handling Philosophy

- **Low-level functions throw** - executor.ts throws detailed errors
- **Top-level functions catch** - tool handlers catch and format via createErrorResponse()
- **Context-aware messages** - Errors include actionable guidance (e.g., "Ensure claude CLI installed and in PATH")
- **Exit code handling** - 124 = timeout, 0 = success, non-zero = CLI error

## Coding Conventions (Critical)

### Tool Design

- **Tool names MUST use snake_case** (claude_request, not claudeRequest)
- Use Zod for all input validation
- Tool descriptions must be clear and actionable (20+ chars)
- Return structured error responses via createErrorResponse()

### Logging

- **NEVER use console.log** - stdout is reserved for MCP protocol
- Use logger.info(), logger.error(), logger.debug() (writes to stderr)
- Include correlation IDs in all logs for request tracing
- Structured logging: timestamps, CLI type, model, timing, session IDs

### TypeScript

- All exported functions MUST have explicit return type annotations
- Strict mode enabled (tsconfig.json)
- Use Zod schemas for runtime validation at API boundaries

### Testing Requirements

- Enforced coverage: 70% lines, functions, and statements; 60% branches
- Follow AAA pattern (Arrange, Act, Assert)
- Unit tests: complete mocks for isolation (fs, child_process)
- Integration tests: real CLI calls with actual commands
- Each test cleans up its own sessions

### DRY Principle

- No duplicate constants across files
- Provider identity/capability facts live only in provider-definitions.ts; never write a literal provider-name array or `sessions://` / `models://` URI elsewhere (`npm run provider:surfaces:check` fails the build if you do)
- CLI/model info defined once in model-registry.ts (`getCliInfo`/`getAvailableCliInfo`), imported elsewhere
- Shared types exported from their defining module

### Session State Design

- Persist only essential data (id, cli, timestamps, description)
- No conversation content in session storage
- Use crypto.randomUUID() for secure session IDs
- File permissions: 0o600 on sessions.json

## Common Gotchas

### MCP Protocol

- stdout is reserved for MCP JSON-RPC protocol
- All human-readable output must go to stderr
- Tool results return content array: `[{ type: "text", text: "..." }]`

### Retry Logic

- Circuit breakers are per-CLI command
- Transient errors (timeout, ECONNRESET) trigger retry
- Non-transient errors (ENOENT) fail immediately
- Retry respects circuit breaker state (CLOSED/OPEN/HALF_OPEN)

### Path Resolution

- CLI tools may be in ~/.local/bin, ~/.nvm/versions/node/*/bin
- executor.ts extends PATH automatically
- NVM paths are cached after first lookup

### Session IDs Are Provider-Specific

- Gateway mints `gw-*` session IDs for its own tracking, but **Codex** resume requires a real Codex UUID (from `~/.codex/sessions/`); a `gw-*` ID is rejected. Other providers (Claude `--continue`, Gemini `--conversation` / `--continue`, Grok/Mistral `--resume` / `--continue`) accept the gateway flow.
- Principal isolation: a caller may only resume sessions / use workspaces it owns. Never thread a `sessionId`, `workingDir`, or `worktree` taken from another principal's metadata into a request handler.

### Persistence and Async Jobs

- Persistence is configured in `~/.llm-cli-gateway/config.toml` (override with `LLM_GATEWAY_CONFIG`); `persistence.backend` is `"sqlite"` (default), `"postgres"` (shared store, multi-instance capable), or `"none"`. When `persistence.backend = "none"`, the `*_request_async` / `llm_job_*` tools are **not registered** at all, so async work can never silently land in lost in-memory state.
- Durable validation receipts and cross-LLM validation runs require a SQLite (or attached) job store, not merely `asyncJobsEnabled`.

### Atomic File Writes

- Always use pattern: write to temp → fsync → rename
- Temp files include process.pid to avoid conflicts
- Set file permissions (0o600) after atomic rename

## Pre-Commit Checklist

Before finalizing any changes:

- [ ] All tool names use snake_case
- [ ] Error messages are actionable and context-aware
- [ ] No console.log (use logger.info/error/debug)
- [ ] All exported functions have return type annotations
- [ ] Tests added for new functionality
- [ ] TypeScript compiles: `npm run build`
- [ ] All tests pass: `npm test`
- [ ] No duplicate code or constants
- [ ] `docs/guides/BEST_PRACTICES.md` reviewed if introducing new patterns

## Additional Documentation

Refer to these files for deeper context:

- `docs/guides/BEST_PRACTICES.md` - Comprehensive design patterns and architectural decisions
- `.cursorrules` - Project-specific rules and conventions
- `README.md` - User-facing documentation and API reference
- `CHANGELOG.md` - Release history and breaking changes
- `docs/guides/PERSONAL_AGENT_CONFIG_KIT.md` - Personal Agent Config Kit setup, scope, recovery, and privacy boundary
- `.agents/skills/*/SKILL.md` - Agent-facing skills shipped in the npm package (async-job-orchestration, multi-llm-review, session-workflow, secure-orchestration, implement-review-fix, retrospective-walk, public-demo-session, least-cost-routing, personal-agent-config-kit) plus per-provider skills under `.agents/skills/provider-*/`
- `docs/plans/` - In-flight design drafts (API-provider surface, Grok API provider, provider modernisation slices, ACP phases)
