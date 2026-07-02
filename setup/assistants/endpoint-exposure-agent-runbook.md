# HTTPS Endpoint Agent Runbook

Status: assistant-executable setup guide for web MCP clients

Use this runbook when a user wants a web-hosted MCP client, such as ChatGPT,
Claude web, or Grok custom connectors, to connect to `llm-cli-gateway`.
Localhost is not enough for those clients; they need a public HTTPS URL that
routes back to the local gateway.

## Source of Truth

- Assistant contract: `setup/assistants/ASSISTANT_CONTRACT.md`
- Endpoint guide: `docs/personal-mcp/ENDPOINT_EXPOSURE.md`
- Setup UI: `http://127.0.0.1:3333/`
- Doctor command: `llm-cli-gateway doctor --json`
- Client snippets: `llm-cli-gateway print-client-config`
- Sanitized config samples: `setup/assistants/mcp-config-samples.md`

Cloudflare `cloudflared` install commands move over time. Before adding or
changing package-manager commands, check the official Cloudflare Tunnel
downloads page: `https://developers.cloudflare.com/tunnel/downloads/`.

## Agent Scope

A command-capable local assistant may run the commands below on the user's
machine when the user has granted shell access.

A remote chat assistant must not claim it has installed or verified anything.
It should give one command or one UI action at a time, then ask the user for
fresh redacted `doctor --json`.

All assistants must avoid collecting:

- gateway bearer tokens;
- OAuth client secrets and deprecated ChatGPT high-entropy connector URLs;
- Cloudflare tunnel tokens;
- provider API keys, OAuth tokens, passwords, or credential files;
- authorization headers.

If the user pastes any of those values, tell them to rotate the exposed secret
through the appropriate product flow before continuing.

## Registration and Access Checklist

Before starting endpoint setup, distinguish Quick Tunnel, persistent tunnel, and
provider connector access.

For the gateway-managed Cloudflare Quick Tunnel path:

- The user does not need to register a Cloudflare account.
- The user does not need to add a domain to Cloudflare.
- The user does need `cloudflared` installed and outbound internet access from
  the machine running the gateway.
- The generated `*.trycloudflare.com` URL is temporary and tied to the running
  tunnel process.

For a persistent Cloudflare tunnel or BYO reverse proxy:

- The user needs the relevant account, domain, DNS, tunnel token, or reverse
  proxy access for that product.
- The assistant may ask whether the user wants the managed Quick Tunnel path or
  a persistent/BYO endpoint.
- The assistant must not ask the user to paste tunnel tokens, DNS provider
  secrets, private keys, or reverse-proxy credentials into chat.
- If persistent setup is selected, use the provider's official setup flow and
  verify the resulting public HTTPS MCP URL through `doctor --json`.

For provider web-client access:

- ChatGPT requires a plan or workspace surface that supports custom MCP or full
  MCP connectors.
- Claude web requires access to Anthropic's remote custom connector surface.
- Grok web requires access to xAI's custom connector surface.
- The assistant may ask whether the user can see the relevant connector UI.
- The assistant must not ask for provider passwords, OAuth tokens, bearer
  tokens, API keys, or screenshots that expose secrets.

If the required provider connector UI is unavailable, label that client setup as
blocked by account or plan support and offer a local MCP client path instead.

## What the Agent May Ask For

For HTTPS endpoint setup, ask only for:

- operating system and CPU architecture;
- whether the user wants the managed Quick Tunnel path or a persistent/BYO
  HTTPS endpoint;
- which inbound web client is being configured;
- whether the relevant connector UI is available in that product;
- desired outbound validation providers;
- fresh redacted `llm-cli-gateway doctor --json`;
- generated setup packet from `llm-cli-gateway print-client-config` or the setup
  UI;
- OAuth readiness from `doctor --json` (`auth.oauth.enabled`,
  `auth.oauth.registration_policy`, `auth.oauth.clients_configured`);
- workspace readiness from `doctor --json` (`workspaces.enabled`,
  `workspaces.default`, `workspaces.repo_count`);
- non-secret error messages from `cloudflared`, `llm-cli-gateway`, `doctor`, or
  the provider connector UI.

If the assistant is command-capable, it may ask for permission to run
package-manager commands and `llm-cli-gateway tunnel start`. If administrator
approval is needed, ask the user to approve the OS prompt locally.

## Preflight

1. Ask for the user's OS, CPU architecture, desired inbound web clients, and
   desired outbound validation providers.
2. Ask whether the user wants the managed Quick Tunnel path or a persistent/BYO
   HTTPS endpoint.
3. Ask whether the selected provider connector UI is available to the user.
4. Ask for fresh redacted `llm-cli-gateway doctor --json`, or run it locally if
   the assistant has command access.
5. Inspect `remote_http_oauth.stage` FIRST. It is the single ordered readiness
   signal for the preferred OAuth connector path; the first failing gate is the
   reported stage and its `next_actions` name the minimal next step. Only drop to
   the individual fields below when you need detail:
   - `remote_http_oauth.stage` and `remote_http_oauth.next_actions`
   - `remote_http_oauth.mcp_url`, `remote_http_oauth.oauth.authorization_url`, `remote_http_oauth.oauth.token_url`
   - `remote_http_oauth.workspace.ready`, `remote_http_oauth.workspace.default`, `remote_http_oauth.workspace.aliases`
   - `transport.http.enabled`
   - `auth.token_configured`
   - `auth.oauth.enabled`
   - `auth.oauth.registration_policy`
   - `workspaces.enabled`
   - `workspaces.default`
   - `endpoint_exposure.https_configured`
   - `endpoint_exposure.public_url_configured`
   - `endpoint_exposure.mode`
   - `endpoint_exposure.reachable_from_web`
   - `endpoint_exposure.web_clients_supported`
6. If the selected client is local-only, do not configure a public tunnel.
7. If a web client is selected and
   `endpoint_exposure.web_clients_supported` is not `true`, continue with this
   runbook.

## Install `cloudflared` When Missing

First check whether `cloudflared` is already installed.

macOS/Linux:

```bash
command -v cloudflared >/dev/null 2>&1 && cloudflared --version
```

Windows PowerShell:

```powershell
Get-Command cloudflared -ErrorAction SilentlyContinue
cloudflared --version
```

If it is missing, use the smallest official package-manager path for the user's
OS.

Windows PowerShell:

```powershell
winget install --id Cloudflare.cloudflared --exact
```

macOS with Homebrew:

```bash
brew install cloudflared
```

Linux:

Use the Cloudflare Package Repository instructions for the user's distribution:
`https://developers.cloudflare.com/tunnel/downloads/`.

After install, verify:

```bash
cloudflared --version
```

If the install command requires administrator approval, the assistant should ask
the user to approve the OS prompt. Do not work around a failed install by
downloading an arbitrary binary from an unofficial URL.

## Start Managed HTTPS Exposure

Use the gateway-managed tunnel command instead of asking the user to manually
parse a `cloudflared` URL.

```bash
llm-cli-gateway tunnel start
```

Expected behavior:

- starts the local HTTP gateway if needed;
- starts `cloudflared tunnel --url http://127.0.0.1:3333`;
- captures the generated `https://*.trycloudflare.com` URL;
- persists the normalized public `/mcp` URL;
- enables public URL verification for future doctor runs.

Then verify:

```bash
llm-cli-gateway doctor --json
```

For web-client readiness, require:

- `endpoint_exposure.https_configured: true`
- `endpoint_exposure.public_url_configured: true`
- `endpoint_exposure.mode: "tunnel"`
- `endpoint_exposure.web_clients_supported: true`
- `endpoint_exposure.reachable_from_web: "reachable"` when verification is
  enabled

If `reachable_from_web` is `not_checked`, rerun doctor with public URL
verification enabled through the gateway-managed configuration or the setup UI.
Do not tell the user a web client is ready while reachability is unverified.

## Generate Client Setup Values

After endpoint verification, use the copy-safe connector setup packet.

```bash
llm-cli-gateway connector setup
```

The packet reuses `remote_http_oauth` readiness, so its `stage`, URLs, and
`next_actions` match `doctor --json`. It contains only copy-safe fields (MCP URL,
authorization URL, token URL, client id) and never secrets.

For ChatGPT, create or reuse a static OAuth client locally:

```bash
llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once
```

Ensure a workspace is registered so remote provider calls resolve: set a
`[workspaces].default` (or register a repo alias). Remote clients select the
workspace by alias and never send local absolute paths.

ChatGPT setup uses the verified public `/mcp` URL with `Authentication: OAuth`.
Use the authorization and token URLs from `connector setup` or the setup UI.
The client secret is copy-once local output and must be pasted only into the
provider setup field that asks for it, never into a remote assistant transcript.

Claude web and Grok custom connector setup use the public HTTPS MCP URL and
bearer auth configured inside the provider's connector UI. Do not paste the
bearer token into chat.

## Verification Prompt

After the user adds the connector, verify from inside the selected web client:

```text
validate this sentence with two other models: gateway setup works.
```

If the selected client cannot call a validation tool, ask for fresh redacted
`doctor --json` and the non-secret error message from the provider UI.

## Rotation and Shutdown

Rotate any exposed OAuth client secret by creating a replacement client secret
locally, then restart the gateway if the setup flow instructs it:

```bash
llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once
llm-cli-gateway stop
llm-cli-gateway start
```

Stop the managed tunnel:

```bash
llm-cli-gateway tunnel stop
```

Stopping a managed tunnel clears the persisted public URL only when it still
matches the URL created by that tunnel. User-provided public URLs are left
alone.

## Failure Handling

- `cloudflared` missing: install from the official Cloudflare path for the OS,
  then rerun `cloudflared --version`.
- `endpoint_exposure.mode: "local_only"`: use local clients or start a tunnel.
- `endpoint_exposure.mode: "lan"`: do not use it for web clients.
- `endpoint_exposure.mode: "misconfigured"`: replace the public URL with an
  HTTPS URL.
- `endpoint_exposure.reachable_from_web: "unreachable"`: fix tunnel or reverse
  proxy routing before editing provider connector settings.
- ChatGPT connector cannot be added: label it blocked by plan or workspace
  support and offer a local MCP client path.

Do not disable gateway auth to work around setup failure.
