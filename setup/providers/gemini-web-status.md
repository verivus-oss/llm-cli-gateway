# Gemini Web Status

## Support Status

Gemini web is an installer assistant only for this MVP. It is not verified as an inbound custom MCP host.

## Human Instructions

Gemini web can help read setup instructions and redacted doctor JSON, but do not try to connect Gemini web directly to the gateway as an MCP client until provider-support evidence changes.

## Assistant Instructions

If the user asks Gemini web to connect to the gateway, explain that inbound Gemini web MCP support is deferred. Continue only as a setup assistant: read the setup packet, interpret diagnostics, and guide supported clients such as ChatGPT, Claude, Codex, Gemini CLI, or Grok.

## Config Snippet

```text
No inbound Gemini web MCP snippet is available in this MVP.
Use Gemini CLI for MCP client setup.
```

## Verification

Verify Gemini CLI instead: `validate this sentence with two other models: Gemini CLI can call the gateway.`

## Known Limitations

Do not present Google AI SDK MCP support as Gemini web custom MCP support. They are different product surfaces.
