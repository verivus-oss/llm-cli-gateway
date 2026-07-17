# I built an MCP server that lets Claude Code orchestrate seven CLI providers (with real session continuity and async jobs)

The problem: you have several coding-agent CLIs installed. Claude is strong on
architecture and design. Codex is fast at implementation. Gemini catches
security issues others miss. Grok Build, Mistral Vibe, Devin, and Cursor Agent
add their own strengths. Orchestrating them manually, copy-pasting prompts
between terminals, losing context, and waiting for slow responses is painful
enough that most people just stick with one.

**llm-cli-gateway** is an MCP server that wraps Claude Code, Codex, Gemini /
Antigravity, Grok Build, Mistral Vibe, Devin, and Cursor Agent. You add it to
your MCP config and can delegate across whichever of those locally installed
providers you choose, using real tool calls.

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

- **Real session continuity.** Claude sessions use `--continue`; Gemini / Antigravity uses `--conversation <id>` or `--continue`. Multi-turn conversations persist across requests, not just in bookkeeping.
- **Auto-async deferral.** When async jobs are enabled, sync calls that exceed 45 seconds transparently become async jobs. You poll with `llm_job_status` and collect with `llm_job_result`; with async disabled, calls run to completion.
- **Parallel multi-LLM review.** Send the same code to any selected installed providers at once, then synthesize. The `multi-llm-review` skill has the exact prompts for this.
- **Claude-only approval gates with risk scoring.** When a Claude request sets `approvalStrategy: "mcp_managed"`, the gateway scores the operation and can require approval before execution. Codex, Gemini, Grok, Mistral, Devin, and Cursor use `approvalStrategy: "legacy"`; their `approvalPolicy` has no effect.
- **Workflow skills** baked in, built from running this across 11+ production repos. Implement-review-fix cycles, red/blue team security assessments, model routing, design review, consensus workflows.

It also ships as a Claude Code plugin with slash commands if you prefer that interface.

MIT license. TypeScript/Node.js.

- npm: [llm-cli-gateway](https://npmjs.com/package/llm-cli-gateway)
- GitHub: [verivus-oss/llm-cli-gateway](https://github.com/verivus-oss/llm-cli-gateway)
- MCP Registry: `io.github.verivus-oss/llm-cli-gateway`

Happy to answer questions about the architecture or how the async deferral works.
