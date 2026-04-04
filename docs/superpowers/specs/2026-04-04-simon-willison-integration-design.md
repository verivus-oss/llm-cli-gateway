# Simon Willison Integration Suite — Design Spec

**Date:** 2026-04-04
**Status:** Approved
**Approach:** Plugin-Heavy (Approach 1)

## Overview

Two complementary features that bridge llm-cli-gateway with Simon Willison's ecosystem:

1. **`llm-gateway` Python plugin** — registers gateway-backed models in Simon's `llm` CLI tool, giving `llm` users access to multi-LLM orchestration with retries, circuit breakers, and session management.
2. **SQLite flight recorder** — logs every gateway request/response to a queryable SQLite database, browsable with Datasette.

The gateway gets only the flight recorder. The plugin does the rest.

## Architecture Decisions

These decisions were validated by Codex and Gemini during the design process.

### Transport: MCP JSON-RPC over stdio (Option A)

The `llm` plugin spawns the gateway as a child process and speaks MCP JSON-RPC over stdio. One-shot per `execute()` call — spawn, call, teardown.

**Rationale:**
- Zero-config: no daemon management, no "is the server running?" failure mode
- Single source of truth: retry/circuit-breaker logic stays in TypeScript, not duplicated in Python
- Subprocess dies cleanly with the parent process — no orphan sockets
- Cold-start latency (~100-300ms) is negligible vs LLM response times (2s+)
- Fits `llm`'s plugin philosophy: plugins should be lightweight, lazily load heavy deps

**Future escape hatch:** `GATEWAY_URL` env var could enable HTTP transport later if latency or cross-invocation state becomes a proven problem.

### Logging: Both gateway and `llm` native (Option C)

- Gateway logs its own comprehensive record to SQLite (for operators)
- Plugin feeds `llm`'s native `response.set_usage()` API (for users via `llm logs`)
- Different audiences, same workflow

### SQLite schema: Separate concerns (Option C)

Two tables joined by request ID:
- `requests` — mirrors Simon's `llm` schema for Datasette compatibility
- `gateway_metadata` — operational fields (retry_count, circuit_breaker_state, etc.)

### SQLite engine: node-sqlite3-wasm

Not sql.js (db.export() rewrites entire DB on every flush — O(n) I/O, WAL unsupported in WASM VFS). Not better-sqlite3 (native bindings break single-file bundling).

`node-sqlite3-wasm` provides WASM-based SQLite with direct file access — proper per-insert I/O, WAL support, bundleable.

### Thinking blocks: Configurable, default stripped (Option C)

- Default: final answer text only (safe for piping)
- Opt-in: `llm -m gateway-claude -o show_thinking true`
- Always: full trace retained in gateway flight recorder

### Conversation mode: Both, user-controlled (Option C)

- Default (`session_mode=off`): stateless, `llm -c` works via `llm`'s own history replay
- `session_mode=gateway`: plugin creates/resumes gateway sessions, CLI gets `--continue`/`--resume` flags

### Plugin options: Tiered (Option C)

Small set of common options + `gateway_args` escape hatch for full access.

### Distribution: Bundled by default (Option A)

- Gateway compiled to single JS file via esbuild, shipped inside Python package
- `GATEWAY_PATH` env var overrides bundled gateway for power users
- Requires Node.js 18+ on the system

### README pitch: Philosophy-focused (Option B)

Explains why multi-LLM orchestration and queryable telemetry matter. Not a tutorial.

---

## Component 1: SQLite Flight Recorder

### Module

New file: `src/flight-recorder.ts`

### Database

- Engine: `node-sqlite3-wasm`
- Default path: `~/.llm-cli-gateway/logs.db`
- Configurable: `LLM_GATEWAY_LOGS_DB` env var
- Opt-out: set env var to empty string or `"none"`
- WAL mode for concurrent reads (Datasette can query while gateway writes)
- File permissions: 0o600

### Schema

```sql
CREATE TABLE requests (
    id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    system TEXT,
    response TEXT,
    conversation_id TEXT,
    duration_ms INTEGER,
    datetime_utc TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER
);

CREATE TABLE gateway_metadata (
    request_id TEXT PRIMARY KEY REFERENCES requests(id),
    cli TEXT NOT NULL,
    retry_count INTEGER DEFAULT 0,
    circuit_breaker_state TEXT,
    cost_usd REAL,
    approval_decision TEXT,
    optimization_applied BOOLEAN DEFAULT FALSE,
    thinking_blocks TEXT,
    exit_code INTEGER,
    error_message TEXT,
    session_id TEXT,
    async_job_id TEXT
);

CREATE INDEX idx_requests_datetime ON requests(datetime_utc);
CREATE INDEX idx_requests_model ON requests(model);
CREATE INDEX idx_metadata_cli ON gateway_metadata(cli);
```

### API

```typescript
export class FlightRecorder {
  constructor(dbPath: string);
  logStart(entry: FlightLogStart): void;
  logComplete(correlationId: string, result: FlightLogResult): void;
  close(): void;
}

export interface FlightLogStart {
  correlationId: string;
  cli: 'claude' | 'codex' | 'gemini';
  model: string;
  prompt: string;
  system?: string;
  sessionId?: string;
  asyncJobId?: string;
}

export interface FlightLogResult {
  response: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs: number;
  retryCount: number;
  circuitBreakerState: string;
  costUsd?: number;
  approvalDecision?: string;
  optimizationApplied: boolean;
  thinkingBlocks?: string[];
  exitCode: number;
  errorMessage?: string;
}
```

### Integration

- Two-phase logging: write row on request start (with null response), update on completion
- Crashed requests and never-fetched async jobs remain as incomplete rows — queryable as failures
- Non-blocking: writes dispatched via internal async queue (EventEmitter pattern)
- Failures are never fatal: try/catch wrapper, errors logged to stderr, MCP response unaffected
- FlightRecorder injected as constructor parameter so tests can pass a no-op recorder
- Schema versioning via `_migrations` table — pending migrations applied on startup

### New dependency

`node-sqlite3-wasm` — WASM-based, no native bindings, bundleable via esbuild.

---

## Component 2: `llm-gateway` Python Plugin

### Package

- **Name:** `llm-gateway` (PyPI)
- **Install:** `llm install llm-gateway` or `pip install llm-gateway`
- **Dependencies:** None beyond `llm` itself (pin minimum `llm` version)
- **Python:** >= 3.9

### Directory Structure

```
integrations/llm-plugin/
├── pyproject.toml
├── llm_gateway/
│   ├── __init__.py              # Plugin entry point, hook registrations (lazy imports)
│   ├── models.py                # GatewayClaude, GatewayCodex, GatewayGemini
│   ├── mcp_client.py            # MCP JSON-RPC stdio transport client
│   ├── bundled/                 # Single gateway.js file (esbuild output)
│   │   └── gateway.js
│   └── options.py               # Tiered option definitions
├── tests/
│   ├── test_models.py
│   ├── test_mcp_client.py
│   └── test_options.py
├── LICENSE
└── README.md
```

### Build Process

1. `esbuild src/index.ts --bundle --platform=node --outfile=gateway.js` — compiles gateway to single file
2. Copy `gateway.js` into `llm_gateway/bundled/`
3. Build Python wheel with `gateway.js` included via `package_data`

### pyproject.toml

```toml
[project]
name = "llm-gateway"
description = "llm plugin for multi-LLM orchestration via llm-cli-gateway"
requires-python = ">=3.9"
dependencies = ["llm>=0.19"]  # Verify minimum version supports set_usage() and response_json during implementation

[project.entry-points.llm]
gateway = "llm_gateway"

[tool.setuptools.package-data]
llm_gateway = ["bundled/**/*"]
```

### Model Classes

Three classes in `models.py`, all subclassing `llm.Model`:

| Class | model_id | MCP tool |
|-------|----------|----------|
| `GatewayClaude` | `gateway-claude` | `claude_request` |
| `GatewayCodex` | `gateway-codex` | `codex_request` |
| `GatewayGemini` | `gateway-gemini` | `gemini_request` |

### Options (via `-o key value`)

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `show_thinking` | bool | `false` | Include Claude's reasoning blocks inline |
| `timeout` | int | `300000` | Request timeout in ms |
| `optimize_prompt` | bool | `false` | Apply gateway token optimization |
| `session_mode` | string | `"off"` | `"off"` or `"gateway"` (CLI-native resume) |
| `gateway_args` | JSON string | `null` | Escape hatch — raw JSON merged into MCP tool call |

### MCP Client (`mcp_client.py`)

Minimal MCP JSON-RPC client:

1. Spawns `node gateway.js` (from bundled path or `GATEWAY_PATH`)
2. Sends `initialize` → receives `capabilities`
3. Sends `tools/call` with tool name and arguments
4. Reads response, extracts `content[0].text`
5. Sends `shutdown` and closes process

One-shot per `execute()` call. No persistent subprocess.

### Gateway Resolution Order

1. `GATEWAY_PATH` env var
2. `llm_gateway/bundled/gateway.js`
3. Error: "Node.js is required. Install from https://nodejs.org/"

### Node.js Detection

- Check `node` on PATH at first `execute()`, cache per process
- Verify version >= 18 via `node --version`
- Clear `llm.ModelError` if missing or too old

### Streaming

Plugin yields the full response as one chunk. True streaming (SSE/chunked MCP) is out of scope for v1.

### Usage Metadata

After each response:
- `response.set_usage(input=N, output=M)` from gateway token counts
- `response.response_json` populated with full gateway metadata (correlation_id, model, cli, timing, session_id)

### Subprocess Cleanup

- `atexit` handler and SIGINT handler kill the Node.js subprocess
- Spawned with `start_new_session=False` to inherit process group signals

---

## Component 3: README Section

New section "For Fans of Simon Willison" added to `llm-cli-gateway/README.md`:

**Content (philosophy-focused, ~250 words):**

- Multi-LLM orchestration increases the confidence factor
- Having Claude write code, Codex review it, and Gemini check for bugs — and often this isn't even enough. Having the models do iterative reviews is where you start getting real confidence.
- Every interaction should be queryable data (inspired by `llm`'s SQLite logging)
- `datasette ~/.llm-cli-gateway/logs.db` for operational observability
- The plugin bridges both worlds without changing how users work
- Composability over monoliths — the gateway complements `llm`, doesn't replace it

---

## Error Handling

### Flight recorder failures are never fatal

SQLite write fails → log to stderr, continue serving. All writes wrapped in try/catch.

### Plugin failure modes

| Scenario | Behavior |
|----------|----------|
| Node.js not installed | `llm.ModelError` with install URL |
| Node.js < 18 | `llm.ModelError` with version requirement |
| Gateway crashes on startup | `llm.ModelError` with full stderr |
| Gateway returns MCP error | `llm.ModelError` with error message + correlation ID |
| Request timeout | Kill gateway (SIGTERM → SIGKILL 5s), `llm.ModelError` |
| `gateway_args` invalid JSON | `llm.ModelError` before spawning |
| Empty response | Return empty string (not an error) |
| SIGINT during request | Kill subprocess, re-raise KeyboardInterrupt |

### Two-phase logging edge cases

| Scenario | Behavior |
|----------|----------|
| CLI crashes after start logged | Row persists with null response, error_message populated |
| Async job never fetched | Started row persists as incomplete |
| Gateway crashes mid-write | WAL recovery on next startup |
| DB file deleted while running | Next write recreates file and schema |

---

## Testing Strategy

### Gateway: `src/__tests__/flight-recorder.test.ts`

- In-memory SQLite instance (node-sqlite3-wasm supports this)
- Schema creation, migration versioning
- Two-phase logging (start → complete)
- Concurrent read safety
- Opt-out behavior (`LLM_GATEWAY_LOGS_DB=none`)
- Graceful write failure handling (non-fatal)
- Async job logging on fetch
- Edge cases: 50MB truncation, null tokens, missing fields, file permissions

### Plugin: `tests/`

- `test_models.py` — registration, options parsing, model_id values
- `test_mcp_client.py` — mock subprocess: JSON-RPC sequence, timeout, stderr, Node version check
- `test_options.py` — tiered options, `gateway_args` JSON merge, invalid JSON rejection
- Integration test (optional, marked slow): real gateway, simple prompt, verify response + flight recorder entry

### CI

- Plugin tests: Python 3.9+, `llm` installed
- Gateway tests: added to existing Vitest suite (`npm test`)
- Smoke test: install wheel, `llm models list`, verify gateway models appear

### Existing test impact

FlightRecorder injected as constructor parameter — existing tests pass a no-op recorder. No changes to existing test behavior.
