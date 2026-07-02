# ChatGPT Setup

## Support Status

ChatGPT is a verified inbound MCP host with plan limits. Use this path only when the user has access to ChatGPT custom MCP or full MCP connectors. Web setup requires a public HTTPS gateway URL; localhost is not sufficient.

## Recommended path

OAuth is the recommended remote connector authentication mode for new setups:
a public HTTPS URL, the `/mcp` endpoint, OAuth, and a registered/default
workspace. Inspect `doctor --json` -> `remote_http_oauth.stage` first and follow
its `next_actions`; each stage names the single next blocking action.

## Human Instructions

1. Run `llm-cli-gateway tunnel start` or configure a public HTTPS reverse proxy, then set `LLM_GATEWAY_PUBLIC_URL` to that public HTTPS URL.
2. Run `llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once`.
3. Register a workspace so remote provider calls resolve: add a `[[workspaces.repos]]` entry with a `[workspaces].default` in `~/.llm-cli-gateway/config.toml` (or `llm-cli-gateway workspace add <alias> <absolute-repo-path> --default` when an allowed root is configured). Remote clients select the workspace by alias; they never send local absolute paths.
4. Run `llm-cli-gateway connector setup` to print the copy-safe connector fields (MCP URL, authorization URL, token URL, client id).
5. In ChatGPT connector/app settings, use those fields.
6. Paste the client secret only into the local connector setup field that asks for it. Do not paste the secret, bearer token, tunnel tokens, or provider credentials into a remote chat transcript.

## Assistant Instructions

Ask only for OS, desired clients, redacted `doctor --json`, and the copy-safe packet from `llm-cli-gateway connector setup` (or `setup/ui/index.html`). Inspect `remote_http_oauth.stage` first: if it is not `ready`, follow that stage's `next_actions` (and `setup/assistants/endpoint-exposure-agent-runbook.md` for endpoint stages) before giving ChatGPT connection steps.

## Troubleshooting by readiness stage

| `remote_http_oauth.stage` | What it means | Next action |
|---|---|---|
| `not_started` | No public URL and OAuth not enabled | Start a tunnel/reverse proxy; set `LLM_GATEWAY_PUBLIC_URL`. |
| `missing_public_url` | No usable public HTTPS URL | Set `LLM_GATEWAY_PUBLIC_URL` to a public https URL, not localhost/LAN. |
| `endpoint_unreachable` | Public URL not reachable from the web | Fix tunnel/proxy routing; rerun `doctor --json`. |
| `oauth_disabled` | Endpoint up but OAuth off | `oauth client add <id> --redirect-uri <callback> --print-once`. |
| `unsafe_oauth_config` | OAuth config is unsafe/malformed for a public endpoint | Use `registration_policy=static_clients` with a confidential client secret. |
| `missing_oauth_client` | OAuth on but no client registered | `oauth client add <id> --redirect-uri <callback> --print-once`. |
| `missing_workspace` | No default/registered workspace | Register a repo and set `[workspaces].default`. |
| `ready` | All checks pass | Run `connector setup` and paste the copy-safe fields. |

## Config Snippet

Sanitized MCP templates are also collected in `setup/assistants/mcp-config-samples.md`.

```text
Name: llm-cli-gateway
MCP URL: <connector.mcp_url from `connector setup`>
Authentication: OAuth
Authorization URL: <connector.authorization_url>
Token URL: <connector.token_url>
Client ID: <connector.client_id>
Client Secret: <copy-once local output from `oauth client add ... --print-once`>
```

## Verification

In ChatGPT, ask: `validate this sentence with two other models: The gateway is connected.`

## Known Limitations

Plan access and connector UI names can vary. Gemini web status does not affect ChatGPT setup. The default `/mcp` URL remains bearer-protected for clients that support headers and supports OAuth for remote web connectors. Older high-entropy no-auth ChatGPT URLs are deprecated. Never include client secrets, bearer tokens, tunnel tokens, provider credentials, or authorization headers in assistant prompts.
