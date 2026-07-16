# Use Codex from Claude Code (or any MCP client) with session management and async jobs

If you use both Codex and Claude Code, you have probably wished they could talk to each other. **llm-cli-gateway** is an MCP server that wraps the Codex CLI (alongside Claude, Gemini / Antigravity, Grok Build, Mistral Vibe, Devin, and Cursor Agent) so any MCP client can invoke them as tool calls.

This is different from OpenAI's codex-plugin-cc, which only bridges Codex into Claude Code. llm-cli-gateway gives you every one of those CLIs through a single MCP server, with session tracking, async job management, and gateway-managed Claude approval gates.

**Install:**

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

**What you get for Codex specifically:**

- `codex_request` and `codex_request_async` tools available to any MCP client
- `sandboxMode` control; `fullAuto: true` is a deprecated shorthand for `sandboxMode: "workspace-write"`
- Auto-async deferral: when async jobs are enabled, a sync `codex_request` that takes longer than 45 seconds becomes an async job. Poll with `llm_job_status`, collect with `llm_job_result`; with async disabled, it runs to completion.
- Configurable idle timeout (`idleTimeoutMs`) to kill stuck Codex processes
- Provider-native execution controls: use `sandboxMode: "workspace-write"` when Codex needs sandboxed edits. Codex uses `approvalStrategy: "legacy"`; `mcp_managed` is Claude-only and rejected before Codex launches.

**The pattern that works well:** use Codex for implementation and Claude for review in the same session:

```
1. codex_request({prompt: "Implement feature X in src/", sandboxMode: "workspace-write"})
2. claude_request({prompt: "Review changes in src/ for quality and bugs"})
3. codex_request({prompt: "Fix: [paste Claude's findings]", sandboxMode: "workspace-write"})
4. Run tests
```

The `implement-review-fix` skill has the full version of this workflow with prompts tuned from running it across 11+ repos.

Since this wraps the actual Codex CLI binary, you get the real sandbox, tool use, and your existing OpenAI auth. No API proxying.

MIT license. TypeScript.

- npm: [llm-cli-gateway](https://npmjs.com/package/llm-cli-gateway)
- GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
