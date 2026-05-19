# Gemini CLI Setup

## Support Status

Gemini CLI is a verified inbound MCP client and outbound validation provider. Gemini web remains separate and is not verified as an inbound custom MCP host.

## Human Instructions

1. Install Gemini CLI through Google's official flow.
2. Run Gemini CLI once and complete login if prompted.
3. Run `llm-cli-gateway doctor --json` and check `providers.gemini`.
4. Add the gateway to Gemini CLI using the generated snippet and bearer authorization header.
5. Restart Gemini CLI and list MCP servers using the current Gemini CLI command.

## Assistant Instructions

Ask for redacted doctor JSON. Do not request OAuth files, Google account passwords, or API keys. Do not convert Gemini web into an inbound MCP setup path.

## Config Snippet

```json
{
  "mcpServers": {
    "llm-cli-gateway": {
      "httpUrl": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <token-from-~/.llm-cli-gateway/auth-token>"
      }
    }
  }
}
```

Or add it with the Gemini CLI command:

```bash
gemini mcp add llm-cli-gateway http://127.0.0.1:3333/mcp --transport http --header "Authorization: Bearer $(cat ~/.llm-cli-gateway/auth-token)"
```

Use the public HTTPS URL instead when Gemini CLI is running outside the user's machine. Do not paste the expanded bearer token into a remote chat.

## Verification

In Gemini CLI, ask: `validate this sentence with two other models: Gemini CLI can call the gateway.`

## Known Limitations

Doctor checks Gemini credential-store presence only; it does not inspect credential contents.
