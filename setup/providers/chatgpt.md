# ChatGPT Setup

## Support Status

ChatGPT is a verified inbound MCP host with plan limits. Use this path only when the user has access to ChatGPT custom MCP or full MCP connectors. Web setup requires a public HTTPS gateway URL; localhost is not sufficient.

## Human Instructions

1. Run `llm-cli-gateway tunnel start` or configure a public HTTPS reverse proxy.
2. Run `llm-cli-gateway chatgpt-url` or `llm-cli-gateway print-client-config`.
3. In ChatGPT connector/app settings, add the generated `chatgpt.url`.
4. Set Authentication to `No Authentication`.
5. Do not paste the ChatGPT URL, bearer token, tunnel tokens, or provider credentials into a remote chat transcript.

## Assistant Instructions

Ask only for OS, desired clients, redacted `doctor --json`, and the setup packet from `setup/ui/index.html`. If `web_clients_supported` is not `true`, follow `setup/assistants/endpoint-exposure-agent-runbook.md` before giving ChatGPT connection steps.

## Config Snippet

Sanitized MCP templates are also collected in `setup/assistants/mcp-config-samples.md`.

```text
Name: llm-cli-gateway
MCP URL: <chatgpt.url>
Authentication: No Authentication
```

## Verification

In ChatGPT, ask: `validate this sentence with two other models: The gateway is connected.`

## Known Limitations

Plan access and connector UI names can vary. Gemini web status does not affect ChatGPT setup. The default `/mcp` URL is still bearer-protected; ChatGPT uses a separate high-entropy URL because its connector setup may not support arbitrary static Authorization headers. Never include ChatGPT URLs, bearer tokens, tunnel tokens, provider credentials, or authorization headers in assistant prompts.
