# Connect Claude Web

> **Canonical install guidance lives under `setup/providers/<provider>.md` and `setup/assistants/`.** This page is retained for historical context; for the current install flow, follow the agent-driven contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) and the per-provider snippets at [`setup/providers/`](../../setup/providers/).

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/claude-install-prompt.md`
- Provider snippet path: `setup/providers/claude-web.md`

Claude web connects from Anthropic infrastructure, so a localhost URL is not enough. Continue only when doctor JSON shows a public HTTPS URL and `endpoint_exposure.web_clients_supported` is `true`.

Provider execution from Claude web must use a registered workspace alias, session workspace, or configured default workspace. Pass relative paths inside that workspace.

## Steps

1. Open the setup UI and load doctor JSON.
2. Confirm endpoint exposure is ready for web clients.
3. In Claude, open custom connector settings.
4. Copy the public HTTPS MCP URL from the setup UI.
5. Configure required auth in the connector UI. Do not paste bearer tokens into a chat message.
6. Save the connector and verify with a validation prompt.

## Verification

Ask Claude:

```text
validate this sentence with two other models: Claude web can call the gateway.
```

If doctor JSON says `local_only`, use Claude Desktop local setup or configure endpoint exposure first.
