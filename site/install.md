# Install llm-cli-gateway

llm-cli-gateway is a local MCP server that wraps installed coding-agent CLIs.

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
npm install -g @google/gemini-cli
# Grok Build (xAI): https://docs.x.ai/build/overview
curl -fsSL https://x.ai/cli/install.sh | bash
```

Mistral Vibe ships separately as the `vibe` binary.

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
