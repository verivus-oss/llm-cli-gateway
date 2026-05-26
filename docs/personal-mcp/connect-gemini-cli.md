# Connect Gemini CLI

> **Canonical install guidance lives under `setup/providers/<provider>.md` and `setup/assistants/`.** This page is retained for historical context; for the current install flow, follow the agent-driven contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) and the per-provider snippets at [`setup/providers/`](../../setup/providers/).

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/gemini-install-prompt.md`
- Provider snippet path: `setup/providers/gemini-cli.md`

Gemini CLI is a local inbound MCP client and outbound validation provider. Gemini web is not verified as an inbound custom MCP host for this MVP.

## Steps

1. Open the setup UI and load doctor JSON.
2. Confirm Gemini CLI is installed and signed in.
3. Use the setup UI snippet:

```bash
gemini mcp add llm-cli-gateway http://127.0.0.1:3333/mcp --transport http --header "Authorization: Bearer $(cat ~/.llm-cli-gateway/auth-token)"
gemini mcp list
```

4. Do not paste the expanded bearer token into a remote chat.

## Verification

Ask Gemini CLI:

```text
validate this sentence with two other models: Gemini CLI can call the gateway.
```
