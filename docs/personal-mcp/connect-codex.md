# Connect Codex

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/codex-install-prompt.md`
- Provider snippet path: `setup/providers/codex.md`

Codex can be a local inbound MCP client and an outbound validation provider.

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

## Verification

Ask Codex:

```text
validate this sentence with two other models: Codex can call the gateway.
```
