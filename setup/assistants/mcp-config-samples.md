# MCP Configuration Samples

Status: sanitized templates for assistant-led setup

Use these samples only as adaptation templates. The preferred source of truth is
still generated output from:

```bash
llm-cli-gateway print-client-config
```

or the setup UI at `http://127.0.0.1:3333/`.

Never paste expanded bearer tokens, OAuth client secrets, tunnel tokens, provider
credentials, private keys, or authorization headers into a remote chat. Use
placeholders or generated local snippets.

## Selection Rules

- Local stdio clients can use `npx -y llm-cli-gateway` or an installed gateway
  command.
- Local HTTP clients use `http://127.0.0.1:3333/mcp` and bearer auth.
- Web-hosted clients use a public HTTPS MCP URL verified by `doctor --json`.
- ChatGPT uses the verified public `/mcp` URL with OAuth authorization and token
  URLs from `print-client-config` or the setup UI.
- Claude web and Grok custom connectors use the public HTTPS MCP URL and bearer
  auth configured inside the provider UI.
- Mistral Vibe, Devin, and Cursor have inbound MCP paths, but each has
  provider-specific account or local-environment constraints. Keep inbound MCP
  setup separate from the gateway's outbound validation provider setup.

## Generic Local Stdio

Use this when the MCP client launches local stdio servers.

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "command": "npx",
      "args": ["-y", "llm-cli-gateway"]
    }
  }
}
```

For a repo checkout instead of npm:

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "command": "node",
      "args": ["/absolute/path/to/llm-cli-gateway/dist/index.js"]
    }
  }
}
```

Agents must replace only the path placeholder. Do not commit a machine-specific
absolute path to a shared config file.

## Local HTTP With Bearer Auth

Use this when the client supports Streamable HTTP MCP and bearer headers.

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-local-secret-store>"
      }
    }
  }
}
```

Do not ask the user to paste the token. Prefer generated snippets that read the
token locally from `~/.llm-cli-gateway/auth-token` or a local secret manager.

## Codex CLI

Use a bearer-token environment variable rather than expanding the token into the
command transcript.

```bash
export LLM_GATEWAY_AUTH_TOKEN="$(cat ~/.llm-cli-gateway/auth-token)"
codex mcp add llm-cli-gateway --url http://127.0.0.1:3333/mcp --bearer-token-env-var LLM_GATEWAY_AUTH_TOKEN
codex mcp list
```

Keep the export scoped to the shell that runs Codex.

## Gemini CLI

```bash
gemini mcp add llm-cli-gateway http://127.0.0.1:3333/mcp --transport http --header "Authorization: Bearer $(cat ~/.llm-cli-gateway/auth-token)"
gemini mcp list
```

This writes the header into the local Gemini CLI MCP config. Do not paste the
expanded token into chat.

Equivalent settings shape:

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "httpUrl": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-local-secret-store>"
      }
    }
  }
}
```

## Claude CLI Or Claude Desktop Local HTTP

```bash
claude mcp add --transport http llm-cli-gateway http://127.0.0.1:3333/mcp --header "Authorization: Bearer $(cat ~/.llm-cli-gateway/auth-token)"
```

Equivalent JSON shape when the client supports HTTP MCP server definitions:

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-local-secret-store>"
      }
    }
  }
}
```

For Claude Desktop on Windows with 1Password-managed environment injection, use
`setup/providers/claude-desktop-windows-mcp-config.example.json`.

## ChatGPT Custom Connector

Use only after `doctor --json` shows web-client readiness.

```text
Name: llm-cli-gateway
MCP URL: <public-https-url>/mcp
Authentication: OAuth
Authorization URL: <issuer>/oauth/authorize
Token URL: <issuer>/oauth/token
Client ID: chatgpt
Client Secret: <copy-once local oauth command output>
```

Create the client secret locally with
`llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once`.
Paste the secret only into the provider setup field that asks for it.

## Claude Web Custom Connector

Use only after `doctor --json` shows web-client readiness.

```text
Connector name: llm-cli-gateway
Remote MCP URL: <public-https-url>/mcp
Auth: Bearer token configured in connector settings
```

Configure the bearer token inside the provider UI or through generated local
setup output. Do not send the bearer token to the assistant.

## Grok Custom Connector

Use only after `doctor --json` shows web-client readiness and the user confirms
connector UI access.

```text
Connector name: llm-cli-gateway
MCP URL: <public-https-url>/mcp
Authentication: Bearer token configured in Grok connector settings
```

Do not configure Grok web with localhost, LAN-only, or HTTP-only URLs.

## Mistral Vibe

Use Vibe's current MCP configuration command or generated config from
`llm-cli-gateway print-client-config`. Keep bearer tokens local and prefer
environment-variable-backed snippets when the client supports them.

## Devin Custom MCP

Use only when the account has permission to add custom MCP servers. For a
gateway running on the user's machine, prefer a public HTTPS HTTP endpoint over
stdio; stdio inside Devin's managed environment is not the user's local shell.

```text
Server name: llm-cli-gateway
Transport: HTTP
URL: <public-https-url>/mcp
Authorization header: Bearer <token configured in Devin UI>
```

Do not paste the bearer token into chat. Configure it only in Devin's MCP
server settings or through generated local setup output.

## Cursor IDE Or Cursor CLI

Use Cursor's MCP settings or CLI MCP command with either local stdio or local
HTTP. For HTTP, use the same bearer-header shape as the generic local HTTP
sample.

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-local-secret-store>"
      }
    }
  }
}
```

For outbound validation, install and authenticate `cursor-agent`; that is
separate from configuring Cursor as an MCP client.

## Verification

After adapting any sample, verify with fresh diagnostics:

```bash
llm-cli-gateway doctor --json
```

Then ask the selected connected client:

```text
validate this sentence with two other models: gateway setup works.
```
