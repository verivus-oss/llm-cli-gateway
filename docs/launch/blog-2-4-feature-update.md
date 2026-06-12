---
title: "llm-cli-gateway 2.5.0: OAuth for remote MCP connectors and safer workspaces"
published: false
description: "What changed after the 2.0.0 supply-chain release: direct Grok API support, provider-owned sessions, MCP OAuth for remote connectors, and workspace aliases for safer provider spawning."
tags: mcp, ai, node, opensource
---

llm-cli-gateway 2.0.0 was the quiet supply-chain release. It moved persistence to Node's built-in `node:sqlite`, removed the production `better-sqlite3` native install path, and made the package simpler to install and easier to audit.

That was intentionally not a flashy release. It was about removing risk.

The releases since then have been about the product surface: making the gateway easier for MCP clients to understand, keeping provider contracts current, adding a direct xAI API path alongside the existing Grok CLI provider, and now making remote MCP connector setup use OAuth instead of credential-shaped URL shortcuts.

The short version: `llm-cli-gateway@2.5.0` is now published on npm, the GitHub release has signed installer artifacts, and the gateway has a safer remote-connector story than it had at 2.0.0.

## 2.5.0 adds OAuth for remote MCP connectors

The biggest change in 2.5.0 is the remote connector auth model.

The gateway now exposes public-ready MCP OAuth metadata and an authorization-code flow for remote MCP clients. That means clients such as ChatGPT custom connectors can discover the authorization server, request a code, exchange it for an opaque bearer token, and call the MCP endpoint without relying on a static bearer header pasted into a provider UI.

The setup shape is deliberately conservative:

- static OAuth clients can be configured with hashed client secrets;
- dynamic client registration is not open by default;
- dynamic registration, when enabled, is gated by either explicit public-client policy or a shared registration secret;
- shared secrets and client secrets are stored only as hashes;
- secrets are never accepted in query strings;
- generated client secrets are copy-once local output;
- doctor, setup JSON, and default CLI output redact secret-bearing fields.

The practical result is that the public `/mcp` endpoint can support remote web connectors through OAuth while local bearer-token clients keep working.

## The old ChatGPT no-auth URL path is deprecated

Earlier HTTP setup work created a separate high-entropy ChatGPT connector URL because ChatGPT connector setup could not rely on arbitrary static Authorization headers.

2.5.0 replaces that new-setup path with OAuth.

The current ChatGPT setup flow is:

```bash
llm-cli-gateway tunnel start
llm-cli-gateway oauth client add chatgpt --redirect-uri <ChatGPT callback URL> --print-once
llm-cli-gateway print-client-config
```

In ChatGPT, use the verified public `/mcp` URL with `Authentication: OAuth`, plus the authorization and token URLs from `print-client-config` or the setup UI.

The old high-entropy no-auth URL remains treated as deprecated compatibility surface only. New setup docs, the setup UI, and assistant runbooks no longer recommend it. Doctor output also redacts old persisted no-auth connector URLs instead of reconstructing them.

## Workspaces are now registered aliases, not arbitrary paths

Remote MCP clients should not be able to browse or select arbitrary local filesystem paths. 2.5.0 adds a workspace registry so provider requests can target a named workspace alias instead.

The registry supports:

- workspace aliases;
- configured allowed roots;
- default workspace selection;
- provider request `workspace` input across sync and async request tools;
- session metadata so a selected workspace can carry through provider-owned sessions;
- workspace-aware async dedup keys, so the same argv in two different workspaces does not collide.

For local administration there are also workspace creation tools, but they are intentionally narrow. A workspace admin can create a new folder or initialize a new local Git repository under a configured allowed root. The gateway rejects absolute remote paths, traversal, denied directory names, symlink escapes, and existing non-empty targets. There is no network clone in this release.

That last point is important. This is not a remote filesystem browser and not a general "clone this URL into my machine" tool. It is a controlled local workspace registry.

## Remote provider requests fail closed before spawning

The security invariant for 2.5.0 is simple: a remote OAuth-authenticated provider request must resolve to a registered workspace before any provider CLI is spawned.

That applies to the normal provider tools:

- `claude_request`
- `codex_request`
- `gemini_request`
- `grok_request`
- `mistral_request`
- the async variants

It also applies to `codex_fork_session`, which matters because forking a Codex session is still a provider spawn path.

Local bearer/stdin callers keep the existing local behavior unless they explicitly ask for unsafe `workingDir` or `addDir` values. Remote OAuth callers, by contrast, need an explicit workspace, a session-associated workspace, or a configured default workspace. Otherwise the gateway fails before the child process starts.

That closes off the bad fallback where a remote request silently inherits the gateway process cwd or ends up running in `~/.llm-cli-gateway`.

## 2.4.0 still matters: direct Grok API and provider-owned sessions

The 2.5.0 release builds on the 2.4.0 product work.

2.4.0 added a separate direct API provider for xAI: `grok-api`.

This is not a transport flag on `grok_request`. It is a distinct provider type and a distinct tool, `grok_api_request`, because the API path has a different contract from an agentic CLI:

- no sandbox or approval-mode flags;
- no CLI process to spawn;
- no `grok` local login requirement;
- session continuity through xAI Responses API metadata rather than CLI resume flags;
- API-only request parameters such as xAI Responses fields.

Configuration is isolated under `[providers.xai]`. The gateway stores the name of the API-key environment variable, not the secret itself. The tool is only registered when `[providers.xai]` is configured and the named environment variable is present.

Adding `grok-api` also forced a useful cleanup: stored gateway sessions are now owned by a provider, not treated as generic strings that any handler might try to resume.

The wider provider set now includes:

- `claude`
- `codex`
- `gemini`
- `grok`
- `mistral`
- `grok-api`

Wrong-provider session reuse is rejected across request handlers instead of failing later in a provider-specific way. A `grok-api` session should not be passed to `grok_request`, and a Codex session should not be passed to `claude_request`.

This is a boring invariant until it saves you from debugging a bad resume id at the wrong layer.

## MCP tools are clearer and safer for clients

The 2.1.0, 2.2.0, and 2.3.0 releases were mostly about improving the MCP surface itself.

2.1.0 added Grok Build 0.2.32 support, including the `leaderSocket` parameter for `grok_request` and `grok_request_async`. It also improved upstream contract drift handling: the gateway can now distinguish hidden upstream flags from true missing flags, and it can acknowledge upstream-only flags that the gateway intentionally does not emit.

2.2.0 made all tools self-describing. Before that, clients saw tool names and schemas, but not much action-level description. Now the tool descriptions explain what each tool does, when sync requests can defer, why `job_status` differs from `llm_job_status`, and which tools are local-only.

2.3.0 added MCP tool annotations:

- display titles;
- `readOnlyHint`;
- `destructiveHint`;
- `idempotentHint`;
- `openWorldHint`.

Those annotations let MCP clients build better confirmation UX. A read-only local status tool can be treated differently from a provider-spawning request that may cause an agentic CLI to modify files.

The important bit is not that the metadata exists. The important bit is that the metadata is tested as an invariant: exact read-only, destructive, and open-world sets are pinned, and contradictory read-only plus destructive annotations are rejected.

## Resource URIs now use valid schemes

MCP Inspector caught a concrete interoperability bug in the resource surface.

The gateway had advertised resource URIs like:

```text
cache_state://global
provider_subcommands://catalog
```

Those look readable to a human, but underscores are not valid in URI schemes. Standard URL parsing rejected them.

2.4.0 fixed the advertised resources to use hyphenated schemes:

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

The gateway tracks upstream CLI contracts so it can reject unsupported flags before spawning a provider CLI. 2.4.0 extended the planning and resource side of that work.

There are now provider subcommand catalog and detail resources, plus tools for listing provider subcommands, reading a subcommand contract, and checking drift.

This is intentionally CLI-only. The direct `grok-api` provider is not a spawnable CLI and does not belong in the same subcommand contract path. That split is explicit.

The practical value: an MCP client can inspect the provider command surface instead of relying only on prose docs or hardcoded assumptions.

## Host auto-upgrade operations landed

2.4.0 also added an operational path for machines that run the gateway as a local appliance.

The `scripts/host-upgrade.sh` flow stages npm releases into versioned directories, verifies the staged binary, applies upgrades atomically, and supports rollback. There are also user systemd service and timer units for scheduled upgrade checks.

This is not a replacement for the signed GitHub installer artifacts. It is for hosts where npm is the chosen install channel and you want a managed, reversible upgrade loop rather than an ad hoc global install command.

## What changed from the 2.0.0 story

2.0.0 made the package safer to install.

2.1.0 through 2.5.0 made the gateway better to operate and easier for MCP clients to reason about:

- Grok CLI support stayed current with upstream.
- Tool descriptions and annotations now describe the real behavior of every MCP tool.
- Direct xAI API access exists alongside the Grok CLI path.
- Sessions are provider-owned, so cross-provider resume mistakes fail early.
- Cache and provider-subcommand resources use valid URI schemes.
- Provider subcommand contracts are inspectable through MCP.
- Remote web connector setup now uses MCP OAuth instead of no-auth connector URLs.
- Workspace aliases give remote clients a bounded way to select where provider CLIs run.
- Local workspace creation is constrained to configured allowed roots and local `git init`.
- Host upgrade operations have a staged and rollback-capable path.

The gateway is still what it has been from the start: one MCP endpoint that wraps provider CLIs and exposes durable jobs, sessions, validation, review, and provider orchestration.

The difference is that the surface is now less ambiguous. Clients can see which tools exist, what they do, how risky they are, which resources can be read, which provider owns a session, and which workspace a remote request is allowed to use.

That is the kind of functionality work that matters after the supply-chain story is handled. Fewer surprises at install time, fewer surprises at runtime.

## Release evidence

2.5.0 shipped through the public mirror release path:

- npm publishes with GitHub Actions provenance;
- release installer artifacts are signed and uploaded;
- public mirror CI, security, OpenSSF Scorecard, and CodeQL passed on the release commit;
- the local release gate passed `go test ./...`, `npm run build`, `npm run lint`, `npm run format:check`, `npm test`, and `npm run upstream:contracts`;
- the full test suite passed at 1,152 tests.

Links:

- Release: https://github.com/verivus-oss/llm-cli-gateway/releases/tag/v2.5.0
- npm: https://www.npmjs.com/package/llm-cli-gateway
- Site: https://llm-cli-gateway.dev

As always, MIT licensed.
