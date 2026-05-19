# Connect ChatGPT

Start here:

- Setup UI path: `http://127.0.0.1:3333/`
- Assistant prompt path: `setup/assistants/chatgpt-install-prompt.md`
- Provider snippet path: `setup/providers/chatgpt.md`

ChatGPT is a remote web client. Use this guide only when the setup UI shows a public HTTPS MCP URL and `endpoint_exposure.web_clients_supported` is `true`.

## Steps

1. Open the setup UI and load doctor JSON.
2. Confirm the gateway shows auth configured and web clients ready.
3. In ChatGPT, open the custom MCP connector/app setup flow available for your plan or workspace.
4. Copy the public HTTPS MCP URL from the setup UI.
5. Configure auth in the connector UI without pasting raw bearer tokens into chat.
6. Save the connector and return to the setup UI for fresh doctor JSON.

## Verification

Ask ChatGPT:

```text
validate this sentence with two other models: ChatGPT can call the gateway.
```

If ChatGPT cannot add a custom MCP connector on your plan, use a local client such as Codex or Gemini CLI instead.
