# Connect ChatGPT

> **Canonical install guidance lives under `setup/providers/<provider>.md` and `setup/assistants/`.** This page is retained for historical context; for the current install flow, follow the agent-driven contract at [`setup/assistants/ASSISTANT_CONTRACT.md`](../../setup/assistants/ASSISTANT_CONTRACT.md) and the per-provider snippets at [`setup/providers/`](../../setup/providers/).

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/chatgpt-install-prompt.md`
- Provider snippet path: `setup/providers/chatgpt.md`

ChatGPT is a remote web client. Use this guide only when the setup UI shows a public HTTPS MCP URL and `endpoint_exposure.web_clients_supported` is `true`.

Provider execution from ChatGPT must use a registered workspace alias, session workspace, or configured default workspace. Pass relative paths inside that workspace; no-auth connector paths and auth changes are not filesystem bypasses.

## Steps

0. Inspect readiness first: `llm-cli-gateway doctor --json` -> `remote_http_oauth.stage`, and follow its `next_actions` until the stage is `ready`.
1. Run `llm-cli-gateway tunnel start`.
2. Run `llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once`.
3. Run `llm-cli-gateway connector setup` for the copy-safe connector fields.
4. In ChatGPT, open the custom MCP connector/app setup flow available for your plan or workspace.
5. Enter the MCP URL and OAuth authorization/token URLs from the setup packet.
6. Enter the client ID and copy-once client secret from the local OAuth command.
7. Save the connector and rerun `llm-cli-gateway doctor --json`.

Do not use deprecated high-entropy no-auth ChatGPT URLs for new setup. The default `/mcp` URL remains bearer-protected for local clients that support Authorization headers and supports OAuth for remote web connectors.

## Verification

Ask ChatGPT:

```text
validate this sentence with two other models: ChatGPT can call the gateway.
```

If ChatGPT cannot add a custom MCP connector on your plan, use a local client such as Codex or Gemini CLI instead.
