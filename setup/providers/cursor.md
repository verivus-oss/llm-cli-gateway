# Cursor Setup

## Support Status

Cursor is a verified inbound MCP client through Cursor IDE / Cursor CLI MCP
configuration, and it is an outbound validation provider through the local
Cursor Agent CLI. Keep those roles separate: inbound setup lets Cursor call the
gateway; outbound setup lets the gateway call `cursor-agent`.

## Human Instructions

1. Install Cursor Agent CLI from Cursor's official instructions and make sure
   `cursor-agent` is on `PATH`.
2. Run `llm-cli-gateway doctor --json` and confirm
   `providers.cursor.cli_available` is `true`.
3. For inbound local use, add the gateway to Cursor's MCP configuration using
   either stdio (`npx -y llm-cli-gateway`) or local HTTP
   (`http://127.0.0.1:3333/mcp` with bearer auth).
4. For remote/web-style use, expose the gateway through public HTTPS and verify
   endpoint exposure before configuring the URL.

## Assistant Instructions

Use copy/paste-safe commands and placeholders. Never ask for Cursor account
credentials, bearer token values, API keys, or local credential files. Prefer
`llm-cli-gateway print-client-config` or setup UI output when available.

## Config Snippet

Local stdio:

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

Local HTTP:

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

## Verification

In Cursor, ask: `validate this sentence with two other models: Cursor can call the gateway.`

For outbound validation from another client, call `cursor_request` with
`mode: "ask"` or `mode: "plan"` and a small prompt.

## Known Limitations

Cursor's MCP configuration shape can differ between IDE and CLI releases. Use
fresh Cursor docs, generated gateway config, and `doctor --json` evidence rather
than relying on remembered command names.
