# Connect Claude Desktop

> **Canonical install guidance lives under `setup/providers/<provider>.md` and `setup/assistants/`.** This page is retained for historical context; for the current install flow, follow the agent-driven contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) and the per-provider snippets at [`setup/providers/`](../../setup/providers/).

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/claude-install-prompt.md`
- Provider snippet path: `setup/providers/claude-desktop.md`

Claude Desktop can use a remote connector path when available, or a local setup path. Use stdio for unrestricted machine-local filesystem access. HTTP provider execution, including local HTTP, must use a registered workspace alias, session workspace, or configured default workspace.

## Steps

1. Open the setup UI and load doctor JSON.
2. Choose remote connector only if endpoint exposure is ready for web clients.
3. For local HTTP, use the generated Claude command/snippet with the bearer header.
4. If the remote connector path cannot set custom bearer headers, use local stdio setup instead of disabling gateway auth.
5. Restart or reload Claude Desktop after changing MCP settings.

## Verification

Ask Claude Desktop:

```text
validate this sentence with two other models: Claude Desktop can call the gateway.
```

Do not hand-edit source code. Use generated snippets and fresh doctor JSON after each change.
