# Claude Web Setup

## Support Status

Claude web is a verified inbound MCP host through remote custom connectors. It connects from Anthropic infrastructure, so the gateway must be reachable through public HTTPS.

## Human Instructions

1. Open the local setup UI and load fresh `doctor --json`.
2. Confirm the endpoint mode is `tunnel` or `byo_reverse_proxy`.
3. Confirm `endpoint_exposure.reachable_from_web` is `reachable` when verification is enabled.
4. Add a Claude custom connector using the generated MCP URL.
5. Configure bearer auth in Claude's connector settings, not in chat text.

## Assistant Instructions

Use doctor JSON fields rather than guessing. If the public URL is missing, HTTP-only, localhost, LAN-only, or unreachable, follow `setup/assistants/endpoint-exposure-agent-runbook.md` before giving Claude web connector steps.

## Config Snippet

Sanitized MCP templates are also collected in `setup/assistants/mcp-config-samples.md`.

```text
Connector name: llm-cli-gateway
Remote MCP URL: <public-https-url>/mcp
Auth: Bearer token in connector settings
```

## Verification

In Claude, ask: `validate this sentence with two other models: Claude can reach my gateway.`

## Known Limitations

Claude web cannot reach a localhost-only gateway. Do not ask users for Claude passwords, OAuth tokens, bearer tokens, or credential files.
