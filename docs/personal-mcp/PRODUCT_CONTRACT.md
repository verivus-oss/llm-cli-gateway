# Personal Cross-LLM Validation MCP Product Contract

This document defines the MVP contract for packaging `llm-cli-gateway` as a personal MCP appliance for cross-LLM validation.

## MVP Contract

The MVP is a single-user personal gateway. One person runs the gateway on a machine or volume they own, connects one MCP endpoint to the AI clients they choose, and asks any connected client for cross-LLM validation.

Primary user workflow:

1. Install and start the personal gateway.
2. Connect one MCP endpoint to a supported client.
3. Ask any client for cross-LLM validation.
4. The gateway fans out to configured outbound model providers and returns a validation report in the initiating client.

Users do not need every provider UI connected for validation to work. Provider UIs connect to the gateway; the gateway performs cross-model requests through the user's configured provider runtimes or APIs.

## Non-Goals

The MVP is not:

- A hosted multi-tenant SaaS.
- A hosted credential broker.
- A service that takes custody of provider credentials.
- A proprietary replacement chat UI.
- A claim that every provider web product supports inbound custom MCP.

Hosted multi-tenant credential custody is explicitly rejected. Provider credentials must stay in user-owned storage, such as local CLI auth stores, local config, or a user-owned deployment volume.

## Security Posture

The MVP assumes a single trusted user. It still treats local secrets as sensitive:

- Provider credentials must not leave user-owned storage.
- Bearer tokens, provider credentials, tunnel tokens, and authorization headers must be redacted from logs, diagnostics, assistant packets, and setup exports.
- Remote web clients require HTTPS at the tunnel, proxy, or hosting boundary.
- Setup flows must not ask users to paste provider passwords, raw credential files, or unrelated config into a remote chat.
- Setup steps must be idempotent and recoverable without hand-editing code.

## Client and Provider Model

The product has two different roles:

- Inbound MCP client: a user-facing client or assistant that connects to the gateway's MCP endpoint.
- Outbound validation provider: a CLI, API, or runtime that the gateway calls to obtain an independent model response.

The same vendor can appear in both roles, but support must be verified per role. A client being useful as an installer assistant does not prove it can host an inbound MCP connection.

## Target Support Matrix

| Target | Role in MVP | Connection path | minimum_mvp | support_status | Setup artifact |
| --- | --- | --- | --- | --- | --- |
| ChatGPT | Inbound MCP client | Remote MCP over HTTPS | true | verified_chatgpt_web_custom_mcp_with_plan_limits | `setup/providers/chatgpt.md` |
| Claude web | Inbound MCP client | Remote MCP over HTTPS | true | verified_claude_web_remote_mcp_beta | `setup/providers/claude-web.md` |
| Claude Desktop | Inbound MCP client and possible local assistant | Remote MCP or stdio | true | verified_claude_desktop_remote_mcp_beta_or_local_stdio | `setup/providers/claude-desktop.md` |
| Codex | Inbound CLI/IDE client and outbound validation provider | Streamable HTTP or stdio inbound; Codex CLI outbound | true | verified_codex_cli_or_ide_mcp | `setup/providers/codex.md` |
| Gemini CLI | Inbound CLI client and outbound validation provider | Streamable HTTP or stdio inbound; Gemini CLI outbound | true | verified_gemini_cli_mcp | `setup/providers/gemini-cli.md` |
| Gemini web | Installer assistant only until inbound support is proven | Unknown or enterprise-only inbound MCP | false | deferred_until_confirmed | `setup/providers/gemini-web-status.md` |
| Grok | Inbound MCP client and outbound validation provider | Remote MCP over HTTPS or provider CLI/API outbound | false | verified_grok_custom_mcp_public_url_and_outbound_provider | `setup/providers/grok.md` |

Provider-support verification is recorded in `docs/personal-mcp/PROVIDER_SUPPORT_MATRIX.md`. Minimum-MVP targets are still gated by endpoint exposure and generated setup docs before user-facing setup guides may claim support. Gemini web remains unknown or deferred unless current provider support is confirmed.

## User-Facing Validation Workflows

The user-visible workflow is:

> Connect one MCP endpoint, ask any client for cross-LLM validation.

Expected examples:

- "Ask two other models whether this answer misses anything important."
- "Get a second opinion from Codex and Gemini before I send this."
- "Compare Claude, Codex, and Gemini on this plan and show disagreements."
- "Red-team this response with another model and summarize the risk."

The initiating client is only the entry point. Validation can still use outbound providers that are not connected as inbound clients, as long as the user's local provider runtime is installed and authenticated.

## Release Gates

Before public setup guides claim a provider is supported:

- Provider-support evidence must confirm the exact inbound MCP path for that provider/client.
- The gateway must expose the required transport for that path.
- Remote web-client instructions must include an HTTPS-reachable endpoint story.
- Diagnostics must report provider runtime status without exposing secrets.
- Unsupported or uncertain targets must be labeled as deferred, unknown, or outbound-only.

This contract is the product baseline consumed by later implementation DAG units.
