# Endpoint Exposure

Status: Layer 3 design and operator guide

Assistant-facing setup instructions live in
`setup/assistants/endpoint-exposure-agent-runbook.md`. Use that runbook when an LLM agent needs to
install `cloudflared`, start the managed tunnel, verify doctor output, and generate client setup
values on the user's behalf.

The gateway has two different endpoint stories:

- Local clients that need unrestricted machine-local filesystem access should use stdio.
- HTTP clients can use `http://127.0.0.1:<port>/mcp`, but provider execution over HTTP must resolve a registered workspace alias, session workspace, or `[workspaces].default`.
- Web clients need a public HTTPS MCP URL that routes to the local gateway and the same registered workspace boundary applies.

Local success is not enough for ChatGPT, Claude web, or Grok custom connectors. Those clients connect from provider infrastructure, so `doctor --json` must show an HTTPS public URL before setup docs claim web-client readiness.

Remote clients pass relative `workingDir`, `addDir`, and include-directory values inside the selected workspace. Disabling HTTP auth, using a generated no-auth connector path, or setting `[workspaces].allow_unregistered_working_dir` does not permit arbitrary HTTP/tunnel filesystem paths.

## Modes

`doctor --json` reports `endpoint_exposure.mode`:

- `local_only`: localhost-only gateway. Use stdio for unrestricted local filesystem access, or HTTP for workspace-registered local testing.
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

For ChatGPT, create a static OAuth client locally and use the verified public `/mcp` URL with
`Authentication: OAuth`:

```powershell
llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once
```

Use the authorization and token URLs from `print-client-config` or the setup UI. The client secret is
copy-once local output; paste it only into the provider setup field that asks for it.

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

For ChatGPT, use `print-client-config` or the setup UI and configure OAuth against the verified
public `/mcp` URL.

Example diagnostic command:

```bash
LLM_GATEWAY_PUBLIC_URL='https://example.trycloudflare.com/mcp' \
LLM_GATEWAY_VERIFY_PUBLIC_URL=1 \
npm run --silent doctor
```

Do not paste tunnel tokens, bearer tokens, provider credentials, or authorization headers into remote chats. Doctor output redacts sensitive public URL query and fragment parameters before reporting them.
Do not use `localhost`, `127.0.0.1`, `0.0.0.0`, or private LAN IP addresses as the public URL for
web clients; doctor reports those as local-only or LAN endpoints even when they use HTTPS.

## Remote connector readiness (OAuth-first)

OAuth is the recommended remote connector path: a public HTTPS URL, the `/mcp`
endpoint, OAuth, and a registered/default workspace. `doctor --json` reports a
single ordered readiness projection at `remote_http_oauth`:

- `remote_http_oauth.stage` is one of `not_started`, `missing_public_url`,
  `endpoint_unreachable`, `oauth_disabled`, `unsafe_oauth_config`,
  `missing_oauth_client`, `missing_workspace`, `ready`. The first failing gate is
  the reported stage; `remote_http_oauth.next_actions` names the minimal next step.
- `remote_http_oauth.mcp_url`, `.oauth.issuer`, `.oauth.authorization_url`, and
  `.oauth.token_url` are the exact copy-safe URLs (also printed by
  `llm-cli-gateway connector setup`). They are built from the same helper the
  running server uses for its OAuth well-known metadata, so they never drift.
- `remote_http_oauth.workspace` reports readiness, the default alias, and the
  registered aliases (no local paths) that remote provider calls can select.

Inspect `remote_http_oauth.stage` first, then fall back to the raw
`endpoint_exposure` fields below for endpoint detail.

## Verification

For web-client setup, `endpoint_exposure` should show:

- `https_configured: true`
- `public_url_configured: true`
- `mode: "tunnel"` or `mode: "byo_reverse_proxy"`
- `reachable_from_web: "reachable"` after `LLM_GATEWAY_VERIFY_PUBLIC_URL=1`

If reachability is `not_checked`, assistant-led setup must ask the user to run a fresh doctor command with verification enabled before claiming the endpoint is ready for web clients.

The deprecated no-auth connector path (a generated high-entropy URL that bypasses authentication) is compatibility-only and is not the recommended path for new setups. `llm-cli-gateway connector setup` omits it unless `--include-legacy-no-auth` is passed, and it is never a filesystem bypass: remote provider execution still requires a registered workspace alias, a session workspace, or `[workspaces].default`.

## Session and job backpressure (issue #130)

When the gateway is exposed over HTTP, it bounds session and job growth so a
misbehaving or hostile client cannot exhaust host memory, the process table, CPU,
or provider capacity. All limits are per gateway process and configured under
`[http]` and `[limits]` in `~/.llm-cli-gateway/config.toml` (see the README
"Host-protection limits" section for the full key list and defaults).

Operator-facing behavior:

- **Session cap**: at most `[http].max_sessions` concurrent HTTP MCP sessions.
  A further `initialize` returns `429` with `Retry-After: 5` and a JSON body
  `{ error, code: "session_capacity", retryable: true }`. Clients should back off
  and retry, or close idle sessions with an MCP `DELETE`.
- **Idle reaping**: a session idle longer than `[http].session_idle_ttl_ms` is
  closed automatically by the reaper (interval `session_reaper_interval_ms`),
  even if the client never sends `DELETE`. A session with a request in flight is
  never reaped mid-request.
- **Job limiter**: async and sync provider execution shares a global limit
  (`[limits].max_running_jobs`), a per-provider limit
  (`max_running_jobs_per_provider`), and a bounded FIFO queue (`max_queued_jobs`,
  `queue_timeout_ms`). A saturated gateway returns a retryable `saturated` error
  (`structuredContent.errorCategory = "saturated"`); nothing is spawned outside
  the limit.
- **Health/metrics**: `GET /healthz` (unauthenticated) and the `llm_process_health`
  tool report live session caps/ages, running/queued job counts (global and per
  provider), limiter saturation, configured caps, and parent-process memory.
  These surfaces expose **counts, ages, and bytes only**: no prompt text, response
  content, tokens, session IDs, bearer/OAuth tokens, API keys, or machine paths.

## Failure Handling

- If mode is `local_only`, use local clients only or configure a tunnel.
- If mode is `lan`, do not use it for provider web clients.
- If mode is `misconfigured`, replace the public URL with HTTPS.
- If reachability is `unreachable`, fix tunnel/proxy routing before editing provider client settings.
