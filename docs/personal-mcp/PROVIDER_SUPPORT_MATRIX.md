# Provider Support Matrix

Status: Layer 1 evidence record  
Verified: 2026-05-19 (Mistral/Vibe row added 2026-06-07; Devin, Cursor, and API-provider rows added 2026-07-02)
Method: primary documentation search plus local CLI inspection where available.

This matrix separates inbound MCP hosting from outbound validation. A client can connect to the gateway as an inbound MCP host. A provider runtime can be used by the gateway as an outbound validation provider.

## Summary

| Target                        | Classification                                            | Verified connection path                                                                                                                                              | MVP gate                          | Evidence                                                                                                |
| ----------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ChatGPT                       | Inbound MCP host                                          | ChatGPT web apps/custom MCP; strongest full-MCP path is Business and Enterprise/Edu developer mode                                                                    | Verified for web with plan limits | OpenAI Apps in ChatGPT and Developer mode docs                                                          |
| Claude web                    | Inbound MCP host                                          | Remote MCP custom connector                                                                                                                                           | Verified beta                     | Claude custom connector docs                                                                            |
| Claude Desktop                | Inbound MCP host                                          | Remote MCP custom connector; local stdio remains a separate desktop mechanism                                                                                         | Verified beta/local               | Claude custom connector docs                                                                            |
| Codex                         | Inbound CLI/IDE MCP host and outbound validation provider | Codex CLI/IDE can connect to MCP servers; gateway can call Codex CLI outbound                                                                                         | Verified CLI/IDE                  | OpenAI Docs MCP quickstart and local `codex --help`                                                     |
| Gemini CLI                    | Inbound CLI MCP host and outbound validation provider     | Gemini CLI `mcpServers` supports stdio, SSE, and Streamable HTTP                                                                                                      | Verified CLI                      | Gemini CLI MCP docs and local `gemini --help`                                                           |
| Gemini web                    | Installer assistant only                                  | No primary consumer Gemini web custom MCP host path verified                                                                                                          | Deferred                          | Gemini Apps connected-apps docs describe fixed connected apps, not custom MCP                           |
| Grok                          | Inbound MCP host and outbound validation provider         | Grok custom MCP connectors require a public MCP server URL; gateway can call Grok CLI/API outbound                                                                    | Verified web and outbound         | xAI Grok connectors docs and local `grok --help`                                                        |
| Mistral (Vibe)                | Inbound CLI MCP host and outbound validation provider     | Vibe CLI manages MCP servers via `vibe mcp`; gateway calls Vibe outbound (`mistral_request`/`mistral_request_async`)                                                  | Verified CLI and outbound         | Local `vibe --help` and gateway `doctor --json` provider block                                          |
| Devin                         | Inbound MCP host and outbound validation provider         | Devin supports custom MCP servers over stdio, SSE, and HTTP where account permissions allow; gateway calls Devin CLI outbound (`devin_request`/`devin_request_async`) | Verified custom MCP and outbound  | Devin MCP Marketplace docs, Devin MCP docs, Devin release notes, gateway `doctor --json` provider block |
| Cursor                        | Inbound IDE/CLI MCP host and outbound validation provider | Cursor docs cover MCP server configuration for Cursor and Cursor CLI; gateway calls Cursor Agent CLI outbound (`cursor_request`/`cursor_request_async`)               | Verified IDE/CLI and outbound     | Cursor MCP and Cursor CLI MCP docs, gateway `doctor --json` provider block                              |
| Configured HTTP API providers | Outbound validation provider                              | Gateway config registers OpenAI-compatible, Anthropic Messages, and xAI Responses adapters backed by API-key env vars                                                 | Verified gateway config path      | `src/api-provider.ts`, `src/config.ts`, README API provider section                                     |

## Evidence Details

### ChatGPT

Classification: inbound MCP host with plan limitations.

OpenAI's ChatGPT Apps documentation says custom apps can be built using MCP and lists "Custom (MCP)" as an app capability by plan. OpenAI's developer mode page says full MCP support and developer mode are available for ChatGPT Business and Enterprise/Edu customers on ChatGPT web. Full MCP should therefore be treated as verified for those plans, while Plus/Pro support may be narrower and must be represented accurately in setup docs.

MVP implication: ChatGPT setup docs can be generated only after U10 has exact plan-specific wording and the gateway has a public HTTPS endpoint.

Sources:

- https://help.openai.com/en/articles/11487775/
- https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta.svgz

### Claude Web

Classification: inbound MCP host.

Claude's custom connector docs state that custom connectors using remote MCP are available on Claude and that users can connect Claude to existing remote MCP servers. The docs also state that Claude connects from Anthropic cloud infrastructure and the remote MCP server must be publicly reachable.

MVP implication: Claude web setup requires a public HTTPS endpoint and cannot be satisfied by a localhost-only gateway.

Source:

- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

### Claude Desktop

Classification: inbound MCP host.

Claude's remote MCP docs include Claude Desktop in the custom connector availability statement. The same docs distinguish remote connectors from local `claude_desktop_config.json`: remote connectors originate from Anthropic infrastructure, while local desktop config uses the local machine.

MVP implication: Claude Desktop may support both remote connector setup and local stdio setup, but setup docs must be explicit about which mode is being configured.

Source:

- https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp

### Codex

Classification: inbound CLI/IDE MCP host and outbound validation provider.

OpenAI's Docs MCP quickstart says Codex can connect to MCP servers in the CLI or IDE extension and shows `codex mcp add ... --url ...` plus `codex mcp list`. Local CLI inspection also shows `codex mcp` and `codex mcp-server` commands.

MVP implication: Codex can be a local command-capable setup assistant and an inbound MCP client. The gateway can also call Codex CLI as an outbound validation provider using existing gateway tools.

Sources:

- https://developers.openai.com/learn/docs-mcp
- Local command: `codex --help`

### Gemini CLI

Classification: inbound CLI MCP host and outbound validation provider.

The Gemini CLI MCP docs say Gemini CLI uses `mcpServers` in `settings.json` and supports stdio, SSE, and Streamable HTTP transports. Google's Gemini CLI announcement also describes MCP support as a built-in extension mechanism. Local CLI inspection shows `gemini mcp`.

MVP implication: Gemini CLI can connect to the gateway over stdio or Streamable HTTP when configured and can also be used outbound by the gateway.

Sources:

- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-cli-open-source-ai-agent/
- Local command: `gemini --help`

### Gemini Web

Classification: installer assistant only; inbound MCP support deferred.

Google's Gemini Apps connected-apps help page documents available connected-app behavior and mentions app availability varies by app, device, country, and account context. It does not document a user-supplied custom MCP server flow for consumer Gemini web. Google AI developer docs show SDK-level MCP support, but that is not the same as Gemini web hosting a user's custom MCP endpoint.

MVP implication: Gemini web must not receive inbound setup docs until primary provider evidence confirms custom MCP hosting in that product.

Sources:

- https://support.google.com/gemini/answer/13695044?co=GENIE.Platform%3DDesktop&hl=en
- https://ai.google.dev/gemini-api/docs/function-calling

### Grok

Classification: inbound MCP host and outbound validation provider.

xAI's Grok connectors docs state that users can bring their own MCP server as a custom connector, enter the MCP server URL, and use discovered tools in Grok conversations. The same page states that the server must be publicly reachable and local servers need tunneling. Local CLI inspection shows Grok can run headlessly and existing gateway support can use it outbound.

MVP implication: Grok can be documented as a verified inbound web target only when endpoint exposure is complete. It still requires a public URL and any required Grok account/connector access.

Sources:

- https://docs.x.ai/grok/connectors
- https://docs.x.ai/build/overview
- Local command: `grok --help`

### Mistral (Vibe)

Classification: inbound CLI MCP host and outbound validation provider.

Vibe is Mistral's coding CLI. It manages its own MCP server configuration via `vibe mcp`, so a locally running gateway can be registered as an stdio MCP server for inbound use. Outbound, the gateway drives Vibe headlessly through `mistral_request` / `mistral_request_async` (programmatic mode with `--trust`, `--max-turns`, `--max-price`, `--max-tokens` caps); the provider block in `llm-cli-gateway doctor --json` reports the installed Vibe version, active model, and session-logging state.

MVP implication: Mistral support is CLI-scoped (no public-URL web connector path verified); setup docs can describe local stdio registration only.

Sources:

- Local command: `vibe --help`
- Local command: `llm-cli-gateway doctor --json` (mistral provider block)

### Devin

Classification: inbound MCP host with account/permission limits and outbound
validation provider.

Devin's MCP Marketplace documentation says custom MCP servers can be added by
organization admins and that Devin supports stdio, SSE, and HTTP transports.
Its Devin MCP documentation also describes MCP-compatible clients and Devin's
own hosted MCP server. Separately, the gateway drives the local Devin CLI
through `devin_request` / `devin_request_async` for outbound validation.

MVP implication: Devin can be documented as an inbound MCP target only when the
user has the required Devin account permissions and a gateway endpoint reachable
from the Devin environment. The outbound gateway provider remains the local
Devin CLI path and must not require pasting Devin API keys or credential files
into chat.

Sources:

- https://docs.devin.ai/work-with-devin/mcp
- https://docs.devin.ai/work-with-devin/devin-mcp
- https://docs.devin.ai/release-notes/2026
- Gateway command: `llm-cli-gateway doctor --json`

### Cursor

Classification: inbound IDE/CLI MCP host and outbound validation provider.

Cursor's MCP documentation covers connecting Cursor to external tools through
MCP, and Cursor CLI documentation covers using MCP servers from the CLI. The
gateway also drives Cursor Agent headlessly through `cursor_request` /
`cursor_request_async`; that outbound path is separate from configuring Cursor
as an inbound MCP client.

MVP implication: Cursor setup docs can describe local IDE/CLI MCP registration
and outbound Cursor Agent validation, but should keep the two roles separate.
Assistants must use generated config or placeholders rather than asking for raw
bearer tokens.

Sources:

- https://cursor.com/docs/mcp
- https://cursor.com/docs/cli/mcp
- Gateway command: `llm-cli-gateway doctor --json`

### Configured HTTP API providers

Classification: outbound validation providers only.

The gateway can register API-provider tools from `[providers.<name>]` config
blocks. API keys are read from named environment variables at request time and
are not stored in gateway config, diagnostics, persisted request payloads,
dedup keys, logs, or the flight recorder. These providers participate in model
listing, validation, async jobs, and request-result retrieval, but they are not
inbound MCP clients.

MVP implication: API-provider docs should show env-var names and generated
`api_<name>_request` tool names, never raw key values.

Sources:

- `README.md#api-providers-http`
- `site/install.md#api-providers-optional`
- `src/api-provider.ts`

## Release Rules

- Minimum-MVP targets require exact setup docs generated from U10 artifacts before user-facing claims.
- Web clients require a public HTTPS endpoint; localhost alone is insufficient for ChatGPT, Claude web, and Grok custom connectors.
- Gemini web remains deferred until primary documentation or inspected product behavior confirms user-supplied custom MCP hosting.
- Provider credentials stay on the user-owned machine, provider CLI store, or user-owned volume.
- Assistant packets and logs must redact authorization headers, bearer tokens, provider credentials, and tunnel tokens.
