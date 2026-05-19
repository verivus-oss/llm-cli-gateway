# Codex Setup

## Support Status

Codex is a verified inbound MCP client and an outbound validation provider. It is suitable for command-capable assistant setup.

## Human Instructions

1. Install and sign in to Codex CLI through the official Codex flow.
2. Run `llm-cli-gateway doctor --json` and confirm `providers.codex.cli_available` is `true`.
3. Add the gateway as an MCP server using the generated URL and bearer-token environment variable.
4. Run `codex mcp list` or the current Codex equivalent to verify registration.

## Assistant Instructions

Use copy/paste-safe commands and never request OpenAI passwords, API keys, or Codex credential files. If Codex login is not verified, direct the user to the official login command and ask for fresh doctor JSON.

## Config Snippet

```bash
export LLM_GATEWAY_AUTH_TOKEN="$(cat ~/.llm-cli-gateway/auth-token)"
codex mcp add llm-cli-gateway --url <gateway-url>/mcp --bearer-token-env-var LLM_GATEWAY_AUTH_TOKEN
```

For local-only development, `<gateway-url>` can be `http://127.0.0.1:3333`. For web clients, use public HTTPS instead.
Keep the token export local to the shell that runs Codex. Do not paste the expanded bearer token into a remote chat.

## Verification

In Codex, ask: `validate this sentence with two other models: Codex can call the gateway.`

## Known Limitations

Codex CLI configuration and command names can change. Prefer `doctor --json` and `codex mcp list` evidence over memory.
