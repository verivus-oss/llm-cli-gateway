# BYO-server brainstorm — parked notes

**Date parked:** 2026-04-20
**Reason parked:** Pivoted to a marketing sprint to validate demand before building v2. BYO-server returns after the sprint, informed by user feedback.
**Status:** Mid-brainstorm. Approach chosen; design sections not yet drafted.

This document preserves the decisions and reasoning from the brainstorm so we can resume without re-deriving everything.

## Vision

A single user's **personal multi-LLM collaboration hub**. The user has accounts with each provider (Anthropic, OpenAI, Google). They deploy the gateway somewhere always-on and connect all their LLM surfaces — Claude Code, Codex CLI, Gemini CLI locally, plus (eventually) claude.ai, ChatGPT, Gemini web — to the same MCP endpoint. Any LLM, on any surface, can reach into a shared workspace and coordinate with the others to do development, research, or document creation.

The gateway is the **thin glue** that holds everything together, with minimal surface area. It's not trying to be a product in its own right — it's the connective tissue that makes the LLMs work together.

## Locked-in decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Tenancy | Single-user per deployment. Multi-tenant / per-user CLI creds = hosted SaaS problem, out of scope. |
| 2 | Packaging | Docker Compose (v1). Helm chart later. Published OCI image. |
| 3 | Transport | Streamable HTTP (remote MCP). Stdio retained for local use via flag. |
| 4 | Inbound client scope (v1) | CLI clients only: Claude Code, Codex CLI, Gemini CLI, Claude Desktop, Cursor, VS Code. Web clients (claude.ai, ChatGPT, Gemini web) deferred to v2. |
| 5 | Inbound auth | Bearer token by default; `AUTH=none` opt-out. Generated 256-bit token at first run, shown once. Hashed at rest with Argon2id. `gateway auth rotate` with overlap window (max 2 active hashes). |
| 6 | OAuth 2.1 | Deferred to v2. Required for web-client support but non-trivial (similar weight to workspace feature). |
| 7 | TLS strategy | Gateway is HTTP-only internally. TLS handled at the deployment boundary via opinionated Compose overlays: Tailscale Funnel (probable default), Cloudflare Tunnel, Caddy+ACME. Plus BYO-reverse-proxy docs. |
| 8 | Launch hardening | TLS required off-loopback. `Authorization: Bearer` header only (never query/cookie). Redact auth headers from logs/traces/metrics/panic dumps. CORS off by default, explicit allowlist if enabled. Validate `Host`. Trust `X-Forwarded-*` only from configured proxies. Defend DNS rebinding when `AUTH=none`. Request size + concurrency + idle-timeout limits. |
| 9 | CLI login UX | `gateway-login` bootstrap command walks the user through device-code flows for Claude, Codex, Gemini sequentially. Detects already-authed CLIs and skips them. Creds persist to mounted volumes (`/data/claude`, `/data/codex`, `/data/gemini`). |
| 10 | Orchestration pattern | Both peer-to-peer (LLMs invoke tools that call other LLMs) AND user-driven (pre-baked orchestration primitives the user invokes directly). |
| 11 | Shared workspace (v1) | Sessions + documents/artifacts (option ii). |
| 12 | Shared workspace (future) | Add memory/knowledge layer (option iii) in later release. |
| 13 | Architecture | Thin orchestration hub — minimal surface area, existing CLI-invoking executor continues to run provider CLIs server-side. |

## Proposed tool surface

| Category | Tools | Purpose |
|---|---|---|
| Peer-to-peer | `ask_claude`, `ask_codex`, `ask_gemini` | One LLM delegates a sub-task to another |
| Orchestration | `review_pipeline`, `fan_out`, `consensus_vote` | User (or LLM) invokes a pre-baked multi-LLM workflow |
| Workspace | `workspace_list`, `workspace_read`, `workspace_write`, `workspace_append` | Read/write shared artifacts (docs, code, notes) |
| Sessions | `session_create`, `session_list`, `session_read`, `session_continue` | Shared conversation state across clients |
| Jobs | `job_submit`, `job_status`, `job_result` | Durable async work — survives client disconnects |
| Memory (deferred) | `memory_save`, `memory_search`, `memory_forget` | Long-lived notes / project context — v2 |

## High-level architecture (sketch)

```
 ┌────────── MCP clients (CLI, v1) ──────────┐
 │ Claude Code, Codex, Gemini, Claude        │
 │ Desktop, Cursor, VS Code                  │
 └─────────────────┬─────────────────────────┘
                   │ Streamable HTTP + Bearer (TLS via overlay)
 ┌─────────────────▼───────────────────────────────────────────┐
 │               llm-cli-gateway (Node, HTTP)                  │
 │  Auth middleware │ MCP tool surface │ Flight recorder       │
 │  Workspace store │ CLI executor     │ Async job manager     │
 └─────────────────┬───────────────────────────────────────────┘
                   │ spawn (stdio)
 ┌─────────────────▼───────────────────────────────────────────┐
 │  Provider CLIs: claude, codex, gemini (server-side)         │
 │  Creds in /data/claude, /data/codex, /data/gemini           │
 └─────────────────────────────────────────────────────────────┘
```

## New code needed (vs. current codebase)

1. Streamable HTTP transport wiring alongside existing Stdio.
2. Auth middleware (bearer verification, Host/Origin checks, redaction, rate + concurrency limits).
3. **Workspace store** — new persistent layer for shared artifacts/sessions. Not in current code.
4. New MCP tools: workspace_*, session_* (extended), orchestration primitives, ask_*, jobs_* (extended).
5. `gateway-login` command — sequential device-code walkthrough for the three CLIs.
6. Docker Compose bundle + tunnel/proxy overlays (Tailscale, Cloudflared, Caddy).

## Codex's security hardening advice (verbatim highlights)

Codex weighed in on inbound auth and recommended option C (bearer default + `AUTH=none` opt-out) with these concrete requirements:

- Generate 256-bit random token at first run, show once.
- Hash at rest (Argon2id preferred).
- Rotation via `gateway auth rotate`, overlap window, max 2 active hashes.
- Token-per-client = fake complexity for v1 (needs naming/revoke/audit to be real).
- **Fourth option worth considering later:** `auth=proxy` mode that trusts a verified identity header from a configured front-proxy on localhost (for users who want OIDC/SSO via e.g. oauth2-proxy without the gateway implementing it).
- Skip mTLS/JWTs/OIDC-on-endpoint for v1.
- Launch-day hardening: see decision #8 above.

## Open questions when resuming

- **Persistence for workspace store.** SQLite (simple, single-user matches), Postgres (concurrent writers, scales), or "SQLite default / Postgres optional" like sessions?
- **Default TLS overlay.** Tailscale feels like the best zero-config path (free `*.ts.net` certs, no public DNS). Is that the "recommended" default or do we present them equally?
- **Stdio coexistence.** Keep stdio in the same binary as a flag, or split into two entry points?
- **Workspace data model.** What's an "artifact"? Are sessions and artifacts separate or one unified thing?
- **Deployment target assumption.** Homelab? VPS? Raspberry Pi? Mac mini? This affects overlay recommendation and image size.
- **Flight recorder exposure.** Query via MCP tool or via separate HTTP endpoint (Datasette-style)?

## How to resume

1. Re-read this doc + MEMORY.md.
2. Check whether marketing-sprint feedback has changed scope, priority, or target audience.
3. Validate that bearer-only + CLI-clients-v1 is still the right first cut (might upgrade based on who shows up asking).
4. Answer the open questions above.
5. Continue from "Present design sections" in the brainstorming flow.

## References

- `docs/superpowers/specs/` — spec docs (when BYO-server spec is eventually written)
- `MEMORY.md` → `project_positioning.md`, `project_hosted_direction.md` for context
- `CROSS_TOOL_REVIEW.md`, `DOGFOODING_SUCCESS.md` — validated orchestration patterns
