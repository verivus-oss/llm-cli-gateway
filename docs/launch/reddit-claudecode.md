# I built an MCP server that lets Claude Code orchestrate Codex and Gemini (with real session continuity and async jobs)

The problem: you have Claude Code, Codex, and Gemini CLIs installed. Each is good at different things. Claude is strong on architecture and design. Codex is fast at implementation. Gemini catches security issues others miss. But orchestrating all three manually, copy-pasting prompts between terminals, losing context, waiting for slow responses, is painful enough that most people just stick with one.

**llm-cli-gateway** is an MCP server that wraps all three CLIs. You add it to your MCP config and suddenly Claude Code can delegate to Codex and Gemini natively, using real tool calls.

What makes this different from API-based multi-LLM tools (LiteLLM, PAL MCP, etc.): it wraps the actual CLI binaries. That means you get everything the CLIs offer (tool use, file access, sandboxing, your existing auth and billing) without proxying through a separate API layer.

**Setup takes one line:**

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

**Things that actually work well:**

- **Real session continuity.** Claude sessions use `--continue`, Gemini uses `--resume`. Multi-turn conversations persist across requests, not just in bookkeeping.
- **Auto-async deferral.** Sync calls that exceed 45 seconds transparently become async jobs. You poll with `llm_job_status` and fetch with `llm_job_result`. No more tool-call timeouts killing long reviews.
- **Parallel multi-LLM review.** Send the same code to all three LLMs at once, then synthesize. The `multi-llm-review` skill has the exact prompts for this.
- **Approval gates with risk scoring.** When you set `approvalStrategy: "mcp_managed"`, the gateway scores operations and can require approval before execution. No other orchestration tool does this.
- **12 workflow skills** baked in, built from running this across 11+ production repos. Implement-review-fix cycles, red/blue team security assessments, model routing, design review, consensus workflows.

It also ships as a Claude Code plugin with slash commands if you prefer that interface.

221 tests. MIT license. TypeScript/Node.js.

- npm: [llm-cli-gateway](https://npmjs.com/package/llm-cli-gateway)
- GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
- MCP Registry: `io.github.verivus-oss/llm-cli-gateway`

Happy to answer questions about the architecture or how the async deferral works.
