# Frozen ACP extension contract

Status: frozen contract for
`docs/plans/first-class-acp-gateway-extension.dag.toml`, step
`freeze-contract-and-non-goals`.

This document freezes the extension contract before implementation begins. It is
the authoritative, human-readable statement of what the first-class ACP gateway
extension is and is not. Implementation steps must not weaken these decisions;
they may only add detail underneath them.

## Acronym scope (read first)

In this gateway, **ACP means Agent Client Protocol** — the JSON-RPC protocol
that editors and clients use to talk to coding agents. It does **not** mean
"Agent Communication Protocol" or any agent-to-agent messaging scheme. Any
agent-to-agent "Agent Communication Protocol" work is explicitly **out of
scope** for this slice and would require a separate plan. Every spec,
implementation note, doc, and capability-metadata field in this slice uses
"Agent Client Protocol" terminology consistently.

## Frozen decisions

1. **MCP remains the client-facing gateway protocol.** llm-cli-gateway stays an
   MCP stdio server for clients. ACP is not a replacement frontend. Serving the
   gateway itself as an outbound ACP agent is a separate later design.

2. **ACP is an internal provider transport.** ACP is used to talk to provider
   agents that expose a native ACP process. The primary flow is
   `MCP client -> gateway MCP tool -> provider request router -> ACP client/host
   layer -> provider ACP agent`. Gateway stdout stays reserved for MCP JSON-RPC;
   provider ACP stdout is consumed only by the ACP transport and is never
   forwarded to gateway stdout.

3. **Existing request tools keep CLI behavior by default.** `default_transport`
   is `cli`. The stable request tools (`claude_request`,
   `claude_request_async`, `codex_request`, `codex_request_async`,
   `gemini_request`, `gemini_request_async`, `grok_request`,
   `grok_request_async`, `mistral_request`, `mistral_request_async`) keep their
   current behavior. A later step adds an optional `transport` selector
   (`cli` | `acp`, default `cli`); omitting it preserves the existing CLI path,
   so the addition is backwards-compatible. ACP is never used implicitly until a
   future plan explicitly changes `default_transport`.

4. **Native ACP support is separate from adapter-mediated support.** Only
   providers with a native ACP entrypoint enter runtime pilots in this slice.
   Adapter-mediated providers are tracked but not shipped as native gateway ACP
   support until adapter ownership, install, and a separate threat model are
   resolved. An adapter is never labeled as native gateway ACP support.

5. **HostServices side effects are deny-by-default.** ACP HostServices
   (filesystem, terminal, MCP, permission surfaces) start deny-by-default and
   read-only. Filesystem write services and terminal services are disabled by
   default. Provider permission callbacks route through ApprovalManager before
   any side effect is allowed. This stays frozen until the permission bridge is
   implemented and tested.

6. **No new public tool exposes raw ACP JSON-RPC.** Agents continue to use
   gateway MCP tools and resources, not provider-specific JSON-RPC calls. A
   diagnostic ACP smoke tool may ship only if it is read-only (`readOnlyHint`)
   and cannot start prompts. No agent-facing surface accepts or returns raw ACP
   JSON-RPC bodies.

7. **Gateway sessions stay gateway-owned.** Gateway session IDs remain gateway
   owned (`gw-*`). Provider-native ACP session IDs are stored only as session
   metadata and are never reused as gateway session IDs.

## Frozen non-goals

- Replace the MCP server.
- Ship an outbound ACP server/frontend in this slice.
- Wrap every provider immediately.
- Run adapter-mediated providers by default.
- Grant write or terminal HostServices by default.
- Expose raw ACP JSON-RPC to agents.
- Implement any agent-to-agent "Agent Communication Protocol" layer.

## Frozen provider classification

This classification is recorded in code as `ACP_CONTRACT` in
`src/provider-tool-capabilities.ts` and surfaced per provider as the
`acpContract` field of provider-tool capabilities. The richer runtime ACP
capability fields (`acp.status`, `acp.entrypoint`, smoke status, and so on) are
added by the later `extend-provider-capability-metadata` step; this frozen
classification does not pre-empt them.

| Provider               | Target CLI version       | Frozen ACP classification | Native entrypoint        |
| ---------------------- | ------------------------ | ------------------------- | ------------------------ |
| Mistral Vibe           | vibe 2.14.1              | native_candidate          | `vibe-acp`               |
| xAI Grok CLI           | grok 0.2.50 (cadf94855)  | native_candidate          | `grok agent stdio`       |
| Cognition Devin CLI    | devin 2026.5.26-8 (1a388fa9) | native_candidate      | `devin acp`              |
| OpenAI Codex CLI       | codex-cli 0.139.0        | adapter_mediated_deferred | none at target version   |
| Anthropic Claude Code  | claude 2.1.175           | adapter_mediated_deferred | none at target version   |
| Google Antigravity agy | agy 1.0.7                | absent_watchlist          | none at target version   |

Notes:

- Mistral, Grok and Devin are native ACP runtime-pilot candidates (Devin's
  `initialize` + `session/new` smoke passed in Slice D1); their runtime routing
  stays behind global and per-provider config gates.
- Codex and Claude are adapter-mediated and deferred at their target CLI
  versions; adapter evidence is documentation only and never native support.
- Antigravity `agy` 1.0.7 has no ACP surface. Legacy Gemini CLI ACP evidence
  does not transfer to `agy`, so `agy` stays a watchlist item.

## Authoritative references

- `docs/plans/first-class-acp-gateway-extension.dag.toml` — implementation DAG.
- `docs/research/2026-06-12-acp-provider-transport-feasibility.md` — feasibility
  evidence.
- `docs/acp-scope.md` — historical scope note, narrowed by this contract.
