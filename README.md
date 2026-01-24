# LLM CLI Gateway

A Model Context Protocol (MCP) server that provides a unified gateway to multiple LLM CLI tools (Claude Code, Codex, and Gemini), with comprehensive session and conversation management.

## Features

- **Multi-CLI Support**: Unified interface for Claude Code, Codex, and Gemini CLIs
- **Session Management**: Track and resume conversations across all CLIs
- **Context Reuse**: Maintain conversation history and context between requests
- **Input Validation**: Robust validation for prompts and parameters
- **Error Handling**: Consistent, helpful error messages across all tools
- **Timeout Protection**: Prevent hanging with configurable timeouts
- **Logging**: Comprehensive logging for debugging and monitoring
- **Type Safety**: Full TypeScript implementation with strict type checking

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
# Installation instructions for Codex
# Visit Codex documentation
```

### Gemini CLI
```bash
# Installation instructions for Gemini
# Visit Google AI documentation
```

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
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
- `model` (string, optional): Model to use ("opus", "sonnet", "haiku")
- `outputFormat` (string, optional): Output format ("text" or "json"), default: "text"
- `sessionId` (string, optional): Specific session ID to use
- `continueSession` (boolean, optional): Continue the active session
- `createNewSession` (boolean, optional): Always create a new session

**Example:**
```json
{
  "prompt": "Write a Python function to calculate fibonacci numbers",
  "model": "sonnet",
  "continueSession": true
}
```

##### `codex_request`
Execute a Codex request with optional session tracking.

**Parameters:**
- `prompt` (string, required): The prompt to send (1-100,000 chars)
- `model` (string, optional): Model to use ("o3", "o4-mini", "gpt-4.1")
- `fullAuto` (boolean, optional): Enable full-auto mode, default: false
- `sessionId` (string, optional): Session identifier for tracking
- `createNewSession` (boolean, optional): Always create a new session

**Example:**
```json
{
  "prompt": "Create a REST API endpoint",
  "model": "o4-mini",
  "fullAuto": true
}
```

##### `gemini_request`
Execute a Gemini CLI request with session support.

**Parameters:**
- `prompt` (string, required): The prompt to send (1-100,000 chars)
- `model` (string, optional): Model to use ("gemini-2.5-pro", "gemini-2.5-flash")
- `sessionId` (string, optional): Session ID to resume
- `resumeLatest` (boolean, optional): Resume the latest session automatically
- `createNewSession` (boolean, optional): Always create a new session

**Example:**
```json
{
  "prompt": "Explain quantum computing",
  "model": "gemini-2.5-pro",
  "resumeLatest": true
}
```

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

### Timeout
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

Default timeout is 120 seconds (2 minutes). Commands that exceed this will be:
1. Sent SIGTERM
2. After 5 seconds, sent SIGKILL if still running
3. Returned with exit code 124

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

[Your License Here]

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues and documentation
- Review CLI-specific documentation for CLI-related problems

## Changelog

### v1.0.0 (2026-01-24)

- Initial release
- Support for Claude Code, Codex, and Gemini CLIs
- Comprehensive session management
- Input validation and error handling
- Timeout protection
- Logging and observability
- Full TypeScript support
