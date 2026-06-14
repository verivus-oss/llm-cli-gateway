# Connect Grok

> **Canonical install guidance lives under `setup/providers/<provider>.md` and `setup/assistants/`.** This page is retained for historical context; for the current install flow, follow the agent-driven contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) and the per-provider snippets at [`setup/providers/`](../../setup/providers/).

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/grok-install-prompt.md`
- Provider snippet path: `setup/providers/grok.md`

Grok custom connectors require a public MCP server URL. Continue with inbound Grok setup only when doctor JSON shows `endpoint_exposure.web_clients_supported: true`.

Provider execution from Grok custom connectors must use a registered workspace alias, session workspace, or configured default workspace. Pass relative paths inside that workspace; tunnel headers and auth mode do not downgrade HTTP to local trust.

## Steps

1. Open the setup UI and load doctor JSON.
2. Confirm the public HTTPS endpoint is reachable from web clients.
3. In Grok connector settings, add the public HTTPS MCP URL from the setup UI.
4. Configure auth through the connector UI without pasting raw tokens into chat.
5. For outbound-only Grok validation, use the official local Grok CLI/API login path and verify `providers.grok` in doctor JSON.

## Verification

Ask Grok:

```text
validate this sentence with two other models: Grok can call the gateway.
```

If endpoint exposure is not ready, use a local client first or configure a supported HTTPS tunnel/proxy.
