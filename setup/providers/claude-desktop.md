# Claude Desktop Setup

## Support Status

Claude Desktop can use a remote MCP connector when available and can also use local stdio-style MCP configuration. The setup UI is the source of generated snippets.

## Human Instructions

1. Decide whether Claude Desktop should use remote MCP, local HTTP with bearer auth, or local stdio.
2. For remote MCP, complete endpoint exposure and verify `web_clients_supported`.
3. For local stdio, use the generated local command snippet from the installer/bootstrapper.
4. Reload Claude Desktop after configuration changes.
5. Run `llm-cli-gateway doctor --json` after each change.

## Assistant Instructions

Do not ask the user to hand-edit source code. Prefer generated snippets and backups. If a config file must be written, use the bootstrapper/setup UI path and verify with doctor JSON afterward.

## Config Snippet

Sanitized MCP templates are also collected in `setup/assistants/mcp-config-samples.md`.

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "url": "<public-https-url-or-local-http-url>/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-~/.llm-cli-gateway/auth-token>"
      }
    }
  }
}
```

For Claude CLI compatible local configuration, the equivalent command is:

```bash
claude mcp add --transport http llm-cli-gateway http://127.0.0.1:3333/mcp --header "Authorization: Bearer $(cat ~/.llm-cli-gateway/auth-token)"
```

For Claude Desktop on Windows with 1Password-managed environment injection, use
[`claude-desktop-windows-mcp-config.example.json`](claude-desktop-windows-mcp-config.example.json)
as a sanitized template. Replace only the placeholder account/vault/item values;
do not commit a local config with real 1Password account IDs, vault item names,
device names, or machine-specific tool paths.

If a Claude Desktop remote connector path does not expose custom bearer headers, use local stdio setup instead of removing gateway auth. Do not paste the expanded bearer token into a remote chat.

## Verification

In Claude Desktop, ask: `validate this sentence with two other models: Claude Desktop can call the gateway.`

## Known Limitations

Remote mode still requires a reachable HTTPS endpoint. Local stdio mode is machine-local and is not a web-client path.
