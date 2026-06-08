# Grok Setup

## Support Status

Grok is verified as an inbound custom MCP host when the user has connector access and a public MCP server URL. Grok can also be an outbound validation provider through the local Grok runtime/API path.

## Human Instructions

1. Install and sign in to the Grok CLI or configured xAI provider path for outbound validation.
2. For Grok web custom connector setup, expose the gateway through public HTTPS.
3. Run `llm-cli-gateway doctor --json` and verify endpoint exposure.
4. Add a custom connector with the generated MCP URL.
5. Configure bearer auth in the connector UI.

## Assistant Instructions

Do not ask for xAI API keys, OAuth tokens, bearer tokens, or credential files. If endpoint exposure is local-only or unreachable, follow `setup/assistants/endpoint-exposure-agent-runbook.md` before giving web connector steps.

## Config Snippet

Sanitized MCP templates are also collected in `setup/assistants/mcp-config-samples.md`.

```text
Connector name: llm-cli-gateway
MCP URL: <public-https-url>/mcp
Authentication: Bearer token configured in Grok connector settings
```

## Verification

In Grok, ask: `validate this sentence with two other models: Grok can call the gateway.`

## Known Limitations

Grok connector availability can vary by account/product surface. Local-only URLs are not acceptable for web connector setup.
