# Connect Claude Desktop

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/claude-install-prompt.md`
- Provider snippet path: `setup/providers/claude-desktop.md`

Claude Desktop can use a remote connector path when available, or a local setup path. The setup UI is the source of the snippet to use.

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
