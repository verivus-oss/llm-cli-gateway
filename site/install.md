# Install llm-cli-gateway

llm-cli-gateway is a local MCP server that wraps installed coding-agent CLIs.

Requires Node.js >= 24.4.0 (as of 2.0.0 the gateway uses Node's built-in
`node:sqlite` module — no native bindings, no install scripts).

## Agent task

Read this file and configure your current MCP client to launch:

```bash
npx -y llm-cli-gateway
```

Use stdio transport. No subcommand is required.

## Manual install

```bash
npm install -g llm-cli-gateway
llm-cli-gateway
```

or run without a global install:

```bash
npx -y llm-cli-gateway
```

## Provider CLIs

Install whichever provider CLIs you want the gateway to expose:

```bash
npm install -g @anthropic-ai/claude-code
npm install -g @openai/codex
# Gemini provider runs through Google Antigravity CLI (agy):
curl -fsSL https://antigravity.google/cli/install.sh | bash
# Grok Build (xAI): https://docs.x.ai/build/overview
curl -fsSL https://x.ai/cli/install.sh | bash
```

Mistral Vibe ships separately as the `vibe` binary (`pip install mistral-vibe`,
`uv tool install mistral-vibe`, or `brew install mistral-vibe`).

## MCP registry

Name:

```text
io.github.verivus-oss/llm-cli-gateway
```

Package:

```text
llm-cli-gateway
```

Default command:

```json
{
  "command": "npx",
  "args": ["-y", "llm-cli-gateway"]
}
```

## Useful links

- Repository: https://github.com/verivus-oss/llm-cli-gateway
- npm: https://www.npmjs.com/package/llm-cli-gateway
- MCP Registry name: `io.github.verivus-oss/llm-cli-gateway`
