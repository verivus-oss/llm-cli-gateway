# llm-cli-gateway

> *"Without consultation, plans are frustrated, but with many counselors they succeed."*
> — Proverbs 15:22 (LSB)

A Model Context Protocol (MCP) server providing unified access to Claude Code, Codex, and Gemini CLIs with session management, retry logic, and async job orchestration.

## Features

### Core Capabilities
- **Multi-LLM Orchestration**: Unified interface for Claude Code, Codex, and Gemini CLIs
- **Session Management**: Track and resume conversations across all CLIs with persistent storage
- **Token Optimization**: Automatic 44% reduction on prompts, 37% on responses (opt-in)
- **Correlation ID Tracking**: Full request tracing across all LLM interactions
- **Cross-Tool Collaboration**: LLMs can use each other via MCP (validated through dogfooding)

### Reliability & Performance
- **Retry Logic**: Exponential backoff with circuit breaker for transient failures
- **Atomic File Writes**: Process-specific temp files with fsync for data integrity
- **Memory Limits**: 50MB cap on CLI output prevents DoS attacks
- **NVM Path Caching**: Eliminates I/O overhead on every request
- **Long-Running Jobs**: Non-time-bound async execution via `*_request_async` + polling tools

### Security & Quality
- **Comprehensive Testing**: 221 tests covering unit, integration, and regression scenarios
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
git clone https://github.com/verivusai-labs/llm-cli-gateway.git
cd llm-cli-gateway
npm install
npm run build
```

## Usage

### As an MCP Server

Add to your MCP client configuration (e.g., Claude Desktop):

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

### Available Tools

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

##### `claude_request_async` / `codex_request_async`
Start a long-running Claude or Codex request without waiting for completion in the same MCP call.

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
- `cli` (string, required): CLI to create session for ("claude", "codex", "gemini")
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
- `cli` (string, optional): Filter by CLI ("claude", "codex", "gemini")

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
- `cli` (string, optional): Specific CLI to list models for ("claude", "codex", "gemini")

**Response includes:**
- Model names and descriptions
- Best use cases for each model
- CLI-specific information

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
- **No Eval**: No dynamic code evaluation
- **Sandboxing**: Consider running in containers for production use

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

