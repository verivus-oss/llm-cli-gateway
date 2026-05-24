# Connect ChatGPT

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/chatgpt-install-prompt.md`
- Provider snippet path: `setup/providers/chatgpt.md`

ChatGPT is a remote web client. Use this guide only when the setup UI shows a public HTTPS MCP URL and `endpoint_exposure.web_clients_supported` is `true`.

## Steps

1. Run `llm-cli-gateway tunnel start`.
2. Run `llm-cli-gateway chatgpt-url`.
3. In ChatGPT, open the custom MCP connector/app setup flow available for your plan or workspace.
4. Copy the `chatgpt.url` value into the MCP server URL field.
5. Set Authentication to `No Authentication`.
6. Save the connector and rerun `llm-cli-gateway doctor --json`.

Do not use the default `/mcp` URL for ChatGPT unless the ChatGPT UI explicitly supports static
Authorization headers. The default `/mcp` URL remains bearer-protected for other MCP clients.

## Verification

Ask ChatGPT:

```text
validate this sentence with two other models: ChatGPT can call the gateway.
```

If ChatGPT cannot add a custom MCP connector on your plan, use a local client such as Codex or Gemini CLI instead.
