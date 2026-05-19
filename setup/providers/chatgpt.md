# ChatGPT Setup

## Support Status

ChatGPT is a verified inbound MCP host with plan limits. Use this path only when the user has access to ChatGPT custom MCP or full MCP connectors. Web setup requires a public HTTPS gateway URL; localhost is not sufficient.

## Human Instructions

1. Start the gateway with HTTP transport and bearer auth.
2. Configure a public HTTPS tunnel or reverse proxy to the gateway `/mcp` endpoint.
3. Run `llm-cli-gateway doctor --json` and confirm `endpoint_exposure.web_clients_supported` is `true`.
4. In ChatGPT connector/app settings, add the generated MCP URL.
5. Configure bearer auth in the ChatGPT UI when prompted. Do not paste the token into a remote chat transcript.

## Assistant Instructions

Ask only for OS, desired clients, redacted `doctor --json`, and the setup packet from `setup/ui/index.html`. If `web_clients_supported` is not `true`, stop and fix endpoint exposure before giving ChatGPT connection steps.

## Config Snippet

```text
Name: llm-cli-gateway
MCP URL: <public-https-url>/mcp
Authentication: Bearer token configured in ChatGPT connector UI
```

## Verification

In ChatGPT, ask: `validate this sentence with two other models: The gateway is connected.`

## Known Limitations

Plan access and connector UI names can vary. Gemini web status does not affect ChatGPT setup. Never include bearer tokens, tunnel tokens, provider credentials, or authorization headers in assistant prompts.
