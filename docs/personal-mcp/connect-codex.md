# Connect Codex

> **Canonical install guidance lives under `setup/providers/<provider>.md` and `setup/assistants/`.** This page is retained for historical context; for the current install flow, follow the agent-driven contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) and the per-provider snippets at [`setup/providers/`](../../setup/providers/).

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/codex-install-prompt.md`
- Provider snippet path: `setup/providers/codex.md`

Codex can be a local inbound MCP client and an outbound validation provider. Use stdio when Codex needs unrestricted local filesystem paths. The HTTP setup below must use registered workspace aliases, session workspace metadata, or a configured default for provider execution.

## Steps

1. Open the setup UI and load doctor JSON.
2. Confirm `providers.codex.cli_available` is true or install/sign in through the official Codex flow.
3. Use the setup UI snippet:

```bash
export LLM_GATEWAY_AUTH_TOKEN="$(cat ~/.llm-cli-gateway/auth-token)"
codex mcp add llm-cli-gateway --url http://127.0.0.1:3333/mcp --bearer-token-env-var LLM_GATEWAY_AUTH_TOKEN
codex mcp list
```

4. Keep the token export local to the Codex shell. Do not paste the expanded token into chat.

For HTTP provider calls, pass relative `workingDir` and `addDir` values inside the selected workspace. `[workspaces].allow_unregistered_working_dir` is not an HTTP bypass.

## Verification

Ask Codex:

```text
validate this sentence with two other models: Codex can call the gateway.
```
