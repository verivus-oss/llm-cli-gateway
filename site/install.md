# Install llm-cli-gateway

llm-cli-gateway is an MCP server that wraps installed coding-agent CLIs. It runs
locally over stdio by default, and as of 2.9.0 it also runs remotely over HTTP
behind a bearer token or a built-in OAuth 2.0 server.

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

## Remote / HTTP transport (optional)

The default is stdio. To serve the gateway over HTTP for remote MCP clients,
start it with `--transport=http` (or `LLM_GATEWAY_TRANSPORT=http`):

```bash
LLM_GATEWAY_AUTH_TOKEN=your-long-random-token llm-cli-gateway --transport=http
```

It binds to `127.0.0.1:3333` at `/mcp` by default (`LLM_GATEWAY_HTTP_HOST`,
`LLM_GATEWAY_HTTP_PORT`, `LLM_GATEWAY_HTTP_PATH`). Authentication options:

- **Static bearer token** — set `LLM_GATEWAY_AUTH_TOKEN`; clients send it as a
  bearer token. One shared token is one principal, not multi-tenant.
- **Built-in OAuth 2.0** — configure `[http.oauth]` in
  `~/.llm-cli-gateway/config.toml` (PKCE is on by default). Register clients with
  `llm-cli-gateway oauth client add <id> --redirect-uri <uri>`. Turn on the
  optional human-consent gate with `require_consent`
  (`LLM_GATEWAY_OAUTH_REQUIRE_CONSENT=1`).
- **Your own identity proxy** — terminate identity at a proxy you already trust
  and have it inject the principal into the header named by
  `LLM_GATEWAY_TRUSTED_PRINCIPAL_HEADER` (honoured only on a bearer-authenticated
  hop).

Every session, job, and stored request is owned by a principal, so one caller
never sees another's. Remote provider calls require a registered workspace: set
one up with `llm-cli-gateway workspace create` / `workspace add`, or a
`[workspaces].default`. A dangerous OAuth configuration (open registration on a
non-loopback bind) fails closed rather than starting.

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
