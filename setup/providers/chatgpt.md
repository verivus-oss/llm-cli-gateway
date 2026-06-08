# ChatGPT Setup

## Support Status

ChatGPT is a verified inbound MCP host with plan limits. Use this path only when the user has access to ChatGPT custom MCP or full MCP connectors. Web setup requires a public HTTPS gateway URL; localhost is not sufficient.

## Human Instructions

1. Run `llm-cli-gateway tunnel start` or configure a public HTTPS reverse proxy.
2. Run `llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once`.
3. Run `llm-cli-gateway print-client-config`.
4. In ChatGPT connector/app settings, use the `/mcp` URL and OAuth authorization/token URLs from the setup packet.
5. Paste the client secret only into the local connector setup field that asks for it. Do not paste the secret, bearer token, tunnel tokens, or provider credentials into a remote chat transcript.

## Assistant Instructions

Ask only for OS, desired clients, redacted `doctor --json`, and the setup packet from `setup/ui/index.html`. If `web_clients_supported` is not `true`, follow `setup/assistants/endpoint-exposure-agent-runbook.md` before giving ChatGPT connection steps.

## Config Snippet

Sanitized MCP templates are also collected in `setup/assistants/mcp-config-samples.md`.

```text
Name: llm-cli-gateway
MCP URL: <oauth url ending /mcp>
Authentication: OAuth
Authorization URL: <issuer>/oauth/authorize
Token URL: <issuer>/oauth/token
Client ID: chatgpt
Client Secret: <copy-once local output>
```

## Verification

In ChatGPT, ask: `validate this sentence with two other models: The gateway is connected.`

## Known Limitations

Plan access and connector UI names can vary. Gemini web status does not affect ChatGPT setup. The default `/mcp` URL remains bearer-protected for clients that support headers and supports OAuth for remote web connectors. Older high-entropy no-auth ChatGPT URLs are deprecated. Never include client secrets, bearer tokens, tunnel tokens, provider credentials, or authorization headers in assistant prompts.
