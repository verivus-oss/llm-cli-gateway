# Endpoint Exposure

Status: Layer 3 design and operator guide

The gateway has two different endpoint stories:

- Local clients can use stdio or `http://127.0.0.1:<port>/mcp`.
- Web clients need a public HTTPS MCP URL that routes to the local gateway.

Local success is not enough for ChatGPT, Claude web, or Grok custom connectors. Those clients connect from provider infrastructure, so `doctor --json` must show an HTTPS public URL before setup docs claim web-client readiness.

## Modes

`doctor --json` reports `endpoint_exposure.mode`:

- `local_only`: localhost-only gateway. Use this for stdio, Codex CLI, Gemini CLI, or local testing.
- `lan`: gateway listens on a LAN interface, but there is no public HTTPS URL.
- `tunnel`: public HTTPS URL appears to be provided by a tunnel service such as Cloudflare Tunnel, Tailscale Funnel, or ngrok.
- `byo_reverse_proxy`: public HTTPS URL is configured and does not match a known tunnel hostname.
- `misconfigured`: a public URL is configured, but it is not HTTPS.

## Managed Desktop Path

The desktop bootstrapper can manage a Cloudflare Quick Tunnel and persist the HTTPS MCP URL:

```powershell
llm-cli-gateway tunnel start
llm-cli-gateway doctor --json
llm-cli-gateway print-client-config
```

`tunnel start` starts the local gateway if needed, launches `cloudflared tunnel --url
http://127.0.0.1:3333`, reads the generated `https://*.trycloudflare.com` URL, persists the
normalized `/mcp` URL, and enables public URL verification for future doctor runs.

If `cloudflared` is not installed on Windows:

```powershell
winget install --id Cloudflare.cloudflared --exact
llm-cli-gateway tunnel start
```

Stop the managed tunnel with:

```powershell
llm-cli-gateway tunnel stop
```

Stopping a managed tunnel clears the persisted public URL only when it still matches the URL created
by that tunnel. User-provided `public-url` values are left alone.

## Manual Layer 3 Path

Layer 3 documents the first testable path as an HTTPS Cloudflare quick tunnel. Equivalent HTTPS
tunnels or BYO reverse proxies are acceptable when they forward to the same local `/mcp` endpoint.

1. Start the gateway locally with a bearer token.
2. Start a tunnel that forwards public HTTPS traffic to the local gateway.
3. Set `LLM_GATEWAY_PUBLIC_URL` to the public HTTPS `/mcp` URL printed by the tunnel.
4. Set `LLM_GATEWAY_VERIFY_PUBLIC_URL=1` and rerun `doctor --json`.
5. Continue to web-client setup only when `endpoint_exposure.reachable_from_web` is `reachable` and
   `endpoint_exposure.web_clients_supported` is `true`.

Example local command:

```bash
LLM_GATEWAY_AUTH_TOKEN='<local-token>' npm run start:http
```

Example Cloudflare quick tunnel command:

```bash
cloudflared tunnel --url http://127.0.0.1:3333
```

If the tunnel prints `https://example.trycloudflare.com`, the public MCP URL is:

```text
https://example.trycloudflare.com/mcp
```

Example diagnostic command:

```bash
LLM_GATEWAY_PUBLIC_URL='https://example.trycloudflare.com/mcp' \
LLM_GATEWAY_VERIFY_PUBLIC_URL=1 \
npm run --silent doctor
```

Do not paste tunnel tokens, bearer tokens, provider credentials, or authorization headers into remote chats. Doctor output redacts sensitive public URL query and fragment parameters before reporting them.
Do not use `localhost`, `127.0.0.1`, `0.0.0.0`, or private LAN IP addresses as the public URL for
web clients; doctor reports those as local-only or LAN endpoints even when they use HTTPS.

## Verification

For web-client setup, `endpoint_exposure` should show:

- `https_configured: true`
- `public_url_configured: true`
- `mode: "tunnel"` or `mode: "byo_reverse_proxy"`
- `reachable_from_web: "reachable"` after `LLM_GATEWAY_VERIFY_PUBLIC_URL=1`

If reachability is `not_checked`, assistant-led setup must ask the user to run a fresh doctor command with verification enabled before claiming the endpoint is ready for web clients.

## Failure Handling

- If mode is `local_only`, use local clients only or configure a tunnel.
- If mode is `lan`, do not use it for provider web clients.
- If mode is `misconfigured`, replace the public URL with HTTPS.
- If reachability is `unreachable`, fix tunnel/proxy routing before editing provider client settings.
