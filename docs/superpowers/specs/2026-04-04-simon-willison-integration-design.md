# Simon Willison Integration Suite — Design Spec

**Date:** 2026-04-04
**Status:** Approved (Codex review passed — round 3)
**Approach:** Plugin-Heavy (Approach 1)
**Review Round:** 3 (addressing Codex round 2 feedback)

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

Two tables joined by `correlation_id` (the canonical request identifier):
- `requests` — inspired by Simon's `llm` log schema (not a direct mirror — `llm` uses `responses`/`conversations` tables with `prompt_json`, `options_json`, `response_json` fields that don't map to our gateway semantics)
- `gateway_metadata` — operational fields (retry_count, circuit_breaker_state, etc.)

### SQLite engine: better-sqlite3 (gateway runtime) with esbuild externals

After investigation, `node-sqlite3-wasm` does not have verified WAL support and ships a JS+WASM pair (not single-file). `better-sqlite3` is the proven choice for Node.js SQLite with WAL, synchronous writes, and production reliability.

**Bundling strategy:** The esbuild command marks `better-sqlite3` as an external dependency (`--external:better-sqlite3`). The resulting `gateway.js` contains `require("better-sqlite3")` calls that Node.js must resolve at runtime. To make this work inside the Python package:

1. The `bundled/` directory includes a complete `node_modules/better-sqlite3/` subtree (the JS wrapper package + platform-specific `.node` binary).
2. The gateway is launched with `NODE_PATH` set to the `bundled/` directory, so Node.js resolves `require("better-sqlite3")` from there.
3. Platform-specific wheels (linux-x64, darwin-x64, darwin-arm64, win-x64) each include the correct prebuilt `.node` binary for that platform.

This is the same pattern used by Electron apps and standalone Node.js deployments that ship native addons alongside a bundled entry point.

**Fallback:** If the native addon fails to load (unsupported platform), the flight recorder is silently disabled and a warning is logged to stderr. The gateway continues to function without logging.

### Thinking blocks: Configurable, default stripped (Option C)

- Default: final answer text only (safe for piping)
- Opt-in: `llm -m gateway-claude -o show_thinking true`
- Always: full trace retained in gateway flight recorder
- `show_thinking` is a no-op for `gateway-codex` and `gateway-gemini` (only Claude produces thinking blocks)

### Conversation mode: Both, user-controlled (Option C)

- Default (`session_mode=off`): stateless, `llm -c` works via `llm`'s own history replay
- `session_mode=gateway`: plugin creates a gateway session on first call. The gateway returns `session_id` in the structured response. On subsequent calls within the same `llm` conversation, the plugin reads `session_id` from the previous response's `response_json["gateway_session_id"]` and passes it to the gateway. If the prior `response_json` is absent or the session is stale/expired, the plugin creates a new session and logs a warning.

### Plugin options: Tiered (Option C)

Small set of common options + `gateway_args` escape hatch for full access.

**`gateway_args` safety rules:**
- Reserved keys that cannot be overridden via `gateway_args`: `prompt`, `model`, `sessionId`, `createNewSession`, `correlationId`
- Plugin-set keys take precedence over `gateway_args` for: `optimizePrompt`, `idleTimeoutMs`
- `gateway_args` keys take precedence for everything else
- Invalid JSON or reserved key violations raise `llm.ModelError` before spawning

### Distribution: Bundled by default (Option A)

- Gateway compiled via esbuild with `better-sqlite3` as external, shipped inside Python package as platform-specific wheels
- `GATEWAY_PATH` env var overrides bundled gateway for power users
- Requires Node.js 18+ on the system

### README pitch: Philosophy-focused (Option B)

Explains why multi-LLM orchestration and queryable telemetry matter. Not a tutorial.

---

## Component 1: SQLite Flight Recorder

### Module

New file: `src/flight-recorder.ts`

### Database

- Engine: `better-sqlite3`
- Default path: `~/.llm-cli-gateway/logs.db` on all platforms. Resolved via `path.join(os.homedir(), '.llm-cli-gateway', 'logs.db')`. On Windows, this typically resolves to `C:\Users\<user>\.llm-cli-gateway\logs.db`.
- Configurable: `LLM_GATEWAY_LOGS_DB` env var
- Opt-out: set env var to empty string or `"none"`
- WAL mode for concurrent reads (Datasette can query while gateway writes)
- File permissions: 0o600 (Unix only)

### Schema

```sql
-- Inspired by llm's logging schema, adapted for gateway semantics.
-- Not a direct mirror of llm's responses/conversations tables.
CREATE TABLE requests (
    id TEXT PRIMARY KEY,           -- correlation_id (canonical request identifier)
    cli TEXT NOT NULL,              -- claude | codex | gemini
    model TEXT NOT NULL,
    prompt TEXT NOT NULL,
    system TEXT,
    response TEXT,
    session_id TEXT,                -- gateway session ID (doubles as conversation grouping key)
    duration_ms INTEGER,
    datetime_utc TEXT NOT NULL,
    input_tokens INTEGER,
    output_tokens INTEGER
);

CREATE TABLE gateway_metadata (
    request_id TEXT PRIMARY KEY REFERENCES requests(id),
    retry_count INTEGER DEFAULT 0,
    circuit_breaker_state TEXT,
    cost_usd REAL,
    approval_decision TEXT,
    optimization_applied INTEGER DEFAULT 0,  -- 0 or 1 (SQLite has no BOOLEAN)
    thinking_blocks TEXT,          -- JSON array of strings, NULL if none. Max 1MB stored; truncated with marker if larger.
    exit_code INTEGER,
    error_message TEXT,            -- populated on handled failures; NULL on hard crashes
    async_job_id TEXT,
    status TEXT NOT NULL DEFAULT 'started'  -- started | completed | failed
);

CREATE INDEX idx_requests_datetime ON requests(datetime_utc);
CREATE INDEX idx_requests_model ON requests(model);
CREATE INDEX idx_requests_cli ON requests(cli);
CREATE INDEX idx_requests_session ON requests(session_id);
CREATE INDEX idx_metadata_status ON gateway_metadata(status);
```

### Canonical ID Mapping

- `requests.id` = `correlation_id` from the gateway (the unique per-request trace ID)
- `requests.session_id` = gateway session ID (groups related requests, maps to `conversation_id` concept)
- `gateway_metadata.request_id` = foreign key to `requests.id`
- The `correlation_id` is the primary join key between both tables

### API

```typescript
export class FlightRecorder {
  constructor(dbPath: string);
  logStart(entry: FlightLogStart): void;   // Synchronous INSERT
  logComplete(correlationId: string, result: FlightLogResult): void;  // Synchronous UPDATE
  flush(): void;                            // No-op for better-sqlite3 (writes are immediate)
  close(): void;                            // Close DB connection
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
  thinkingBlocks?: string[];       // Serialized as JSON array. Truncated to 1MB with "[TRUNCATED]" marker.
  exitCode: number;
  errorMessage?: string;
  status: 'completed' | 'failed';
}
```

### Integration

- **Two-phase write path (authoritative definition):**
  1. `logStart()` performs a single transaction with two INSERTs:
     - INSERT into `requests` (id, cli, model, prompt, system, session_id, datetime_utc) — response and duration are NULL
     - INSERT into `gateway_metadata` (request_id, async_job_id, status='started') — all metric fields are NULL/default
  2. `logComplete()` performs a single transaction with two UPDATEs:
     - UPDATE `requests` SET response, duration_ms, input_tokens, output_tokens WHERE id = correlationId
     - UPDATE `gateway_metadata` SET retry_count, circuit_breaker_state, cost_usd, approval_decision, optimization_applied, thinking_blocks, exit_code, error_message, status WHERE request_id = correlationId
  - The `status` field lives in `gateway_metadata` (not `requests`). It transitions from `'started'` → `'completed'` or `'failed'`.
- **Synchronous writes:** `better-sqlite3` is synchronous by design. Both `logStart()` and `logComplete()` are transactional and durable before they return. No async queue needed — writes complete in <1ms and don't block meaningfully relative to CLI execution times (seconds).
- On gateway shutdown, `close()` is called. Since writes are already flushed (synchronous), no data loss occurs.
- Crashed requests remain as rows with `gateway_metadata.status='started'` and `requests.response=NULL` — queryable as incomplete.
- Never-fetched async jobs: `logStart()` is called when the async job is created. `logComplete()` is called when `llm_job_result` fetches the result. If never fetched, the row stays with `status='started'`.
- Failures are never fatal: all recorder calls wrapped in try/catch, errors logged to stderr, MCP response unaffected
- FlightRecorder injected as constructor parameter so tests can pass a no-op recorder
- Schema versioning via `_migrations` table — pending migrations applied on startup

### Data Handling

- **Prompts and responses** are stored as-is. Users who need redaction should set `LLM_GATEWAY_LOGS_DB=none` to disable.
- **Thinking blocks** are stored as JSON arrays, truncated to 1MB with a `"[TRUNCATED]"` marker appended.
- **Retention:** No automatic rotation. Users manage DB size via external tools (`sqlite-utils`, cron, etc.). The spec does not impose retention policy — this matches `llm`'s approach (logs grow indefinitely unless manually managed).
- **Size caps:** Individual fields have no hard limit except `thinking_blocks` (1MB). Total DB growth is bounded only by disk space.

### New dependency

`better-sqlite3` — native addon, synchronous, production-proven. Marked as esbuild external for bundling.

---

## Component 2: `llm-gateway` Python Plugin

### Package

- **Name:** `llm-gateway` (PyPI)
- **Install:** `llm install llm-gateway` or `pip install llm-gateway`
- **Dependencies:** `llm>=0.19` (verify minimum version supports `set_usage()` and `response_json` during implementation)
- **Python:** >= 3.9

### Directory Structure

```
integrations/llm-plugin/
├── pyproject.toml
├── llm_gateway/
│   ├── __init__.py              # Plugin entry point, hook registrations (lazy imports)
│   ├── models.py                # GatewayClaude, GatewayCodex, GatewayGemini
│   ├── mcp_client.py            # MCP JSON-RPC stdio transport client
│   ├── bundled/                 # gateway.js + better-sqlite3 module (platform-specific)
│   │   ├── gateway.js
│   │   └── node_modules/
│   │       └── better-sqlite3/  # JS wrapper + prebuilt .node binary
│   └── options.py               # Tiered option definitions
├── tests/
│   ├── test_models.py
│   ├── test_mcp_client.py
│   └── test_options.py
├── LICENSE
└── README.md
```

### Build Process

1. `esbuild src/index.ts --bundle --platform=node --external:better-sqlite3 --outfile=gateway.js` — compiles gateway to single file with native dep excluded
2. Copy `gateway.js` into `llm_gateway/bundled/`
3. Install `better-sqlite3` for the target platform and copy the complete `node_modules/better-sqlite3/` subtree (JS wrapper + prebuilt `.node` binary) into `llm_gateway/bundled/node_modules/`
4. Build platform-specific Python wheels (linux-x64, darwin-x64, darwin-arm64, win-x64)

### pyproject.toml

```toml
[project]
name = "llm-gateway"
description = "llm plugin for multi-LLM orchestration via llm-cli-gateway"
requires-python = ">=3.9"
dependencies = ["llm>=0.19"]

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
| `show_thinking` | bool | `false` | Include Claude's reasoning blocks inline (no-op for codex/gemini) |
| `timeout` | int | `300000` | Request timeout in ms |
| `optimize_prompt` | bool | `false` | Apply gateway token optimization |
| `session_mode` | string | `"off"` | `"off"` or `"gateway"` (CLI-native resume) |
| `gateway_args` | JSON string | `null` | Escape hatch — raw JSON merged into MCP tool call (see safety rules above) |

### MCP Client (`mcp_client.py`)

Minimal MCP JSON-RPC client implementing the [MCP lifecycle spec](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle/):

**Message framing:** Each JSON-RPC message is preceded by `Content-Length: N\r\n\r\n` followed by `N` bytes of JSON (same as LSP). The client reads/writes using this framing on stdin/stdout of the subprocess.

**Lifecycle:**
1. Spawns `node gateway.js` (from bundled path or `GATEWAY_PATH`)
2. Sends `initialize` request → receives `InitializeResult` with capabilities
3. Sends `notifications/initialized` notification (required by MCP spec)
4. Sends `tools/call` with tool name and arguments
5. Reads response, parses structured result (see Response Contract below)
6. Sends `shutdown` request, waits for acknowledgement, closes process

One-shot per `execute()` call. No persistent subprocess.

### Gateway Response Contract

The gateway's tool handlers return MCP `CallToolResult` with structured content. The plugin expects:

**Success response:**
```json
{
  "content": [
    {
      "type": "text",
      "text": "<response text>"
    }
  ],
  "structuredContent": {
    "response": "<response text>",
    "model": "<resolved model name>",
    "cli": "claude|codex|gemini",
    "correlationId": "<uuid>",
    "sessionId": "<gateway session id or null>",
    "durationMs": 1234,
    "inputTokens": 100,
    "outputTokens": 200,
    "thinkingBlocks": ["<thinking content>"],
    "exitCode": 0,
    "retryCount": 0
  }
}
```

**Error response:**
```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "<error message>"
    }
  ],
  "structuredContent": {
    "correlationId": "<uuid>",
    "exitCode": 1,
    "errorMessage": "<detailed error>"
  }
}
```

**Note:** The `structuredContent` field requires a gateway-side change to populate it in tool handler responses. This is a new addition to the existing tool handlers — the structured metadata is assembled from data already available in the handler scope (correlation ID, timing, token counts from CLI output parsing).

The plugin extracts:
- `content[0].text` for the response text yielded to `llm`
- `structuredContent` for `response.set_usage()`, `response.response_json`, thinking blocks, and session ID

### Gateway Resolution Order

1. `GATEWAY_PATH` env var
2. `llm_gateway/bundled/gateway.js`
3. Error: "Node.js 18+ is required. Install from https://nodejs.org/"

### Node.js Detection

- Check `node` on PATH at first `execute()`, cache per process
- Verify version >= 18 via `node --version` (parse major version from output)
- Clear `llm.ModelError` if missing or too old, with specific guidance

### Streaming

Plugin yields the full response as one chunk. True streaming (SSE/chunked MCP) is out of scope for v1.

### Usage Metadata

After each response, the plugin maps `structuredContent` (camelCase) to `response_json` (snake_case for Python convention):

- `response.set_usage(input=N, output=M)` from `structuredContent.inputTokens`/`outputTokens`
- `response.response_json` populated with an explicit mapping:
  - `structuredContent.correlationId` → `response_json["correlation_id"]`
  - `structuredContent.sessionId` → `response_json["gateway_session_id"]`
  - `structuredContent.model` → `response_json["model"]`
  - `structuredContent.cli` → `response_json["cli"]`
  - `structuredContent.durationMs` → `response_json["duration_ms"]`
  - `structuredContent.inputTokens` → `response_json["input_tokens"]`
  - `structuredContent.outputTokens` → `response_json["output_tokens"]`
  - `structuredContent.exitCode` → `response_json["exit_code"]`
  - `structuredContent.retryCount` → `response_json["retry_count"]`
  - `structuredContent.thinkingBlocks` → `response_json["thinking_blocks"]`

The canonical wire format is `structuredContent` (camelCase). The `response_json` mapping is a plugin-side transformation for Python consumers.

### Session Recovery (session_mode=gateway)

When `session_mode=gateway` is active:
1. First call: plugin passes `createNewSession=true` in the MCP tool call. Gateway returns `sessionId` in `structuredContent`.
2. Plugin stores `sessionId` in `response.response_json["gateway_session_id"]`.
3. Subsequent calls (via `llm -c`): `llm` passes the previous response to the plugin. Plugin reads `response.response_json["gateway_session_id"]` and passes `sessionId` to the gateway.
4. If prior `response_json` is absent (e.g., first message in a continued conversation from before the plugin was installed), or if the session is expired/invalid, the plugin creates a new session and logs a warning to stderr.

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

If `better-sqlite3` fails to load (unsupported platform, missing native addon), the flight recorder is silently disabled with a stderr warning. The gateway continues without logging.

### Plugin failure modes

| Scenario | Behavior |
|----------|----------|
| Node.js not installed | `llm.ModelError` with install URL |
| Node.js < 18 | `llm.ModelError` with version requirement |
| Gateway crashes on startup | `llm.ModelError` with full stderr |
| Gateway returns MCP error | `llm.ModelError` with error message + correlation ID |
| Request timeout | Kill gateway (SIGTERM → SIGKILL 5s), `llm.ModelError` |
| `gateway_args` invalid JSON | `llm.ModelError` before spawning |
| `gateway_args` contains reserved key | `llm.ModelError` listing the reserved keys |
| Empty response | Return empty string (not an error) |
| SIGINT during request | Kill subprocess, re-raise KeyboardInterrupt |

### Two-phase logging edge cases

| Scenario | Behavior |
|----------|----------|
| CLI crashes after start logged | Row persists with `status='started'`, null response. `error_message` is NOT guaranteed to be populated on hard crashes — only on handled failures where the gateway catches the error before dying. |
| Async job never fetched | Started row persists as `status='started'` indefinitely |
| Gateway crashes mid-write | better-sqlite3 uses WAL with atomic commits. Partial writes are rolled back on next open. |
| DB file deleted while running | better-sqlite3 holds an open file handle. Behavior is OS-dependent. On Linux, existing handle continues to work but file is unlinked. New writes go to the unlinked file. On next gateway restart, a new DB is created. |

---

## Testing Strategy

### Gateway: `src/__tests__/flight-recorder.test.ts`

- In-memory SQLite instance (better-sqlite3 supports `:memory:`)
- Schema creation, migration versioning
- Two-phase logging (start → complete), verify status transitions
- WAL mode verification (PRAGMA journal_mode query after init)
- Opt-out behavior (`LLM_GATEWAY_LOGS_DB=none`)
- Graceful write failure handling (non-fatal, verify stderr output)
- Async job logging on fetch
- Graceful degradation when better-sqlite3 fails to load
- Edge cases: null tokens, missing fields, file permissions
- Thinking block truncation at 1MB boundary
- Canonical ID mapping: verify correlation_id is used as primary key

### Plugin: `tests/`

- `test_models.py` — registration, options parsing, model_id values, `show_thinking` no-op for non-Claude
- `test_mcp_client.py` — mock subprocess: full MCP lifecycle (initialize → notifications/initialized → tools/call → shutdown), Content-Length framing, timeout, stderr, Node version check, structured response parsing
- `test_options.py` — tiered options, `gateway_args` JSON merge, reserved key rejection, invalid JSON rejection
- `test_sessions.py` — session_mode=gateway flow: create → store in response_json → recover on -c, stale session fallback
- Integration test (optional, marked slow): real gateway, simple prompt, verify response + flight recorder entry + structuredContent

### CI

- Plugin tests: Python 3.9+, `llm` installed
- Gateway tests: added to existing Vitest suite (`npm test`)
- Smoke test: install wheel, `llm models list`, verify gateway models appear
- Platform smoke tests for bundled better-sqlite3 (linux-x64, darwin-arm64 at minimum)

### Existing test impact

FlightRecorder injected as constructor parameter — existing tests pass a no-op recorder. No changes to existing test behavior.
