---
title: "llm-cli-gateway 2.4.0: direct Grok API, safer MCP tools, and provider-owned sessions"
published: false
description: "What changed after the 2.0.0 supply-chain release: direct xAI API support, clearer MCP tool metadata, valid resource URIs, provider-owned sessions, and host auto-upgrade operations."
tags: mcp, ai, node, opensource
---

llm-cli-gateway 2.0.0 was the quiet supply-chain release. It moved persistence to Node's built-in `node:sqlite`, removed the production `better-sqlite3` native install path, and made the package simpler to install and easier to audit.

That was intentionally not a flashy release. It was about removing risk.

The releases since then have been about the product surface: making the gateway easier for MCP clients to understand, keeping provider contracts current, and adding a direct xAI API path alongside the existing Grok CLI provider.

The short version: `llm-cli-gateway@2.4.0` is now published on npm, the GitHub release has signed installer artifacts, and the gateway has a stronger MCP interface than it had at 2.0.0.

## The gateway now has a direct Grok API provider

Until now, Grok support meant spawning the `grok` CLI, just like Claude Code, Codex, Gemini, and Mistral Vibe. That still exists. The CLI path is the right tool when you want the upstream agent's file access, terminal behavior, and provider-owned session mechanics.

2.4.0 adds a separate direct API provider: `grok-api`.

This is not a transport flag on `grok_request`. It is a distinct provider type and a distinct tool, `grok_api_request`, because the API path has a different contract from an agentic CLI:

- no sandbox or approval-mode flags;
- no CLI process to spawn;
- no `grok` local login requirement;
- session continuity through xAI Responses API metadata rather than CLI resume flags;
- API-only request parameters such as xAI Responses fields.

Configuration is isolated under `[providers.xai]`. The gateway stores the name of the API-key environment variable, not the secret itself. The tool is only registered when `[providers.xai]` is configured and the named environment variable is present.

That matters for MCP clients. A client connected to a gateway without xAI API credentials will not see a dead `grok_api_request` tool that can never work. The tool surface reflects the actual configured runtime.

The API provider also records xAI response metadata in gateway sessions, including the previous response id used for continuation. That gives the direct API path its own session namespace, separate from the existing `grok` CLI sessions.

## Sessions are now provider-owned

Adding `grok-api` forced a useful cleanup: stored gateway sessions needed to be owned by a provider, not treated as generic strings that any handler might try to resume.

The session schema now distinguishes spawnable CLI providers from the wider provider set. The wider `ProviderType` includes:

- `claude`
- `codex`
- `gemini`
- `grok`
- `mistral`
- `grok-api`

That change touches the file session manager, PostgreSQL session manager, migrations, metrics, and flight-recorder typing. It also means wrong-provider session reuse is rejected across the request handlers instead of failing later in a provider-specific way.

For example, a `grok-api` session should not be passed to `grok_request`, and a Codex session should not be passed to `claude_request`. 2.4.0 enforces that boundary across the synchronous and asynchronous request tools, plus `codex_fork_session`.

This is a boring invariant until it saves you from debugging a bad resume id at the wrong layer.

## MCP tools are clearer and safer for clients

2.1.0, 2.2.0, and 2.3.0 were mostly about improving the MCP surface itself.

2.1.0 added Grok Build 0.2.32 support, including the new `leaderSocket` parameter for `grok_request` and `grok_request_async`. It also improved upstream contract drift handling: the gateway can now distinguish hidden upstream flags from true missing flags, and it can acknowledge upstream-only flags that the gateway intentionally does not emit.

2.2.0 made all 37 tools self-describing. Before that, clients saw tool names and schemas, but not much action-level description. Now the tool descriptions explain what each tool does, when sync requests can defer, why `job_status` differs from `llm_job_status`, and which tools are local-only.

2.3.0 added MCP tool annotations for all 37 tools:

- display titles;
- `readOnlyHint`;
- `destructiveHint`;
- `idempotentHint`;
- `openWorldHint`.

Those annotations let MCP clients build better confirmation UX. A read-only local status tool can be treated differently from a provider-spawning request that may cause an agentic CLI to modify files.

The important bit is not that the metadata exists. The important bit is that the metadata is now tested as an invariant: exact read-only, destructive, and open-world sets are pinned, and contradictory read-only plus destructive annotations are rejected.

## Resource URIs now use valid schemes

MCP Inspector caught a concrete interoperability bug in the resource surface.

The gateway had advertised resource URIs like:

```text
cache_state://global
provider_subcommands://catalog
```

Those look readable to a human, but underscores are not valid in URI schemes. Standard URL parsing rejected them.

2.4.0 fixes the advertised resources to use hyphenated schemes:

```text
cache-state://global
cache-state://session/{sessionId}
cache-state://prefix/{hash}
provider-subcommands://catalog
provider-subcommands://{provider}/{commandPath}
```

Legacy direct `provider_subcommands://...` reads are still accepted internally for compatibility tests and older direct callers, but standard MCP clients should use the advertised hyphenated forms.

After the fix, MCP Inspector successfully read every advertised resource: skills, sessions, models, metrics, cache state, provider subcommand catalog, and process health.

## Provider subcommand contracts are visible

The gateway already tracks upstream CLI contracts so it can reject unsupported flags before spawning a provider CLI. 2.4.0 extends the planning and resource side of that work.

There are now provider subcommand catalog and detail resources, plus tools for listing provider subcommands, reading a subcommand contract, and checking drift.

This is still intentionally CLI-only. The new direct `grok-api` provider is not a spawnable CLI and does not belong in the same subcommand contract path. That split is now explicit.

The practical value: an MCP client can inspect the provider command surface instead of relying only on prose docs or hardcoded assumptions.

## Host auto-upgrade operations landed

2.4.0 also adds an operational path for machines that run the gateway as a local appliance.

The new `scripts/host-upgrade.sh` stages npm releases into versioned directories, verifies the staged binary, applies upgrades atomically, and supports rollback. There are also user systemd service and timer units for scheduled upgrade checks.

This is not a replacement for the signed GitHub installer artifacts. It is for hosts where npm is the chosen install channel and you want a managed, reversible upgrade loop rather than an ad hoc global install command.

## The HTTPS endpoint story is part of setup now

The gateway still starts from a local-first model. Local MCP clients can use stdio, or the HTTP transport at `http://127.0.0.1:3333/mcp` with bearer-token auth.

Web-hosted clients are different. ChatGPT, Claude web, Grok web connectors, and similar MCP hosts connect from provider infrastructure, so `localhost` is not a usable endpoint for them. They need a public HTTPS URL that routes back to the local gateway.

That path is now documented and diagnosed directly by the gateway:

- `doctor --json` reports endpoint exposure state, including whether HTTPS is configured, whether the mode looks like a tunnel or reverse proxy, and whether a public reachability check passed.
- `llm-cli-gateway tunnel start` manages the Cloudflare Quick Tunnel path: it starts the local gateway if needed, runs `cloudflared tunnel --url http://127.0.0.1:3333`, captures the generated `https://*.trycloudflare.com` URL, and persists the normalized `/mcp` endpoint.
- `llm-cli-gateway print-client-config` and `llm-cli-gateway chatgpt-url` expose the right setup values for clients.

There is an important auth split here. The normal public `/mcp` endpoint remains bearer-protected for clients that can send an `Authorization` header. ChatGPT connector setup may not support arbitrary static auth headers, so the gateway also creates a separate high-entropy ChatGPT URL. That URL should be treated like a credential and rotated when needed with `llm-cli-gateway chatgpt-url rotate`.

This means the personal-appliance setup is not just "run a local server and hope the web client can reach it." The gateway can now tell you when you are local-only, LAN-only, misconfigured, tunneled, or behind your own HTTPS reverse proxy before you paste anything into a provider UI.

## What changed from the 2.0.0 story

2.0.0 made the package safer to install.

2.1.0 through 2.4.0 made the gateway better to operate and easier for MCP clients to reason about:

- Grok CLI support stayed current with upstream.
- Tool descriptions and annotations now describe the real behavior of every MCP tool.
- Direct xAI API access exists alongside the Grok CLI path.
- Sessions are provider-owned, so cross-provider resume mistakes fail early.
- Cache and provider-subcommand resources use valid URI schemes.
- Provider subcommand contracts are inspectable through MCP.
- HTTPS endpoint exposure and Cloudflare Quick Tunnel setup are documented, diagnosed, and client-config aware.
- Local host upgrade operations have a staged and rollback-capable path.

The gateway is still what it has been from the start: one MCP endpoint that wraps provider CLIs and exposes durable jobs, sessions, validation, review, and provider orchestration.

The difference is that the surface is now less ambiguous. Clients can see which tools exist, what they do, how risky they are, which resources can be read, and which provider owns a session.

That is the kind of functionality work that matters after the supply-chain story is handled. Fewer surprises at install time, fewer surprises at runtime.

Links:

- Release: https://github.com/verivus-oss/llm-cli-gateway/releases/tag/v2.4.0
- npm: https://www.npmjs.com/package/llm-cli-gateway
- Site: https://llm-cli-gateway.dev

As always, MIT licensed.
