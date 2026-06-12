---
name: provider-claude
description: Track and maintain the upstream Claude Code CLI contract. Use when Anthropic ships a Claude Code release, when a `claude` flag/output/permission behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: Claude Code CLI

Process guidance for keeping the gateway's Claude (`claude`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour — the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.claude` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, output modes, permission modes,
or session rules here or in TOML.

## Identity

| Field | Value |
|-------|-------|
| CliType | `claude` |
| Executable | `claude` |
| Package | `@anthropic-ai/claude-code` (npm) |
| Changelog | https://code.claude.com/docs/en/changelog.md |
| Install docs | https://code.claude.com/docs/en/overview |
| Watch categories | `flags`, `output-formats`, `permission-modes`, `session-resume`, `models` |

These values mirror `UPSTREAM_CLI_CONTRACTS.claude.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.claude]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- An Anthropic Claude Code release lands and you need to check for contract drift.
- A `claude` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on the Claude changelog.

## How LLM agents should use Claude through the gateway

1. Discover the live gateway/provider surface before relying on provider-specific
   controls:
   ```
   provider_tool_capabilities({cli:"claude"})
   ```
   For a cached read-only resource, use `provider-tools://claude`.
2. Use `claude_request` for normal turns and `claude_request_async` for
   long-running review, implementation, or analysis. Sync calls may auto-defer;
   poll `llm_job_status` and fetch with `llm_job_result` when that happens.
3. Omit `model` unless the caller explicitly asked for a specific variant; the
   gateway resolves the configured Claude default.
4. For review or code-reading tasks, keep tool access available. Claude supports
   `allowedTools`, `disallowedTools`, and `tools`, but do not pass an empty
   allowlist for reviews.
5. Use `mcpServers` only for gateway-known MCP servers, and set
   `strictMcpConfig:true` when missing MCP access should fail fast.
6. Prefer `approvalStrategy:"mcp_managed"` over raw
   `dangerouslySkipPermissions`; the gateway approval gate runs before Claude's
   permissive execution mode is applied.
7. Use `createNewSession`, `sessionId`, or `continueSession` for real Claude
   continuity. Claude also supports structured output via `outputFormat` and
   `jsonSchema`.

## Scan for upstream change

```bash
# Offline summary (no network):
npm run upstream:scan -- --provider claude
# Advisory live check against the changelog (network; manual only):
npm run upstream:scan -- --live --provider claude --fail-on-critical
# Persist a content-hash snapshot + dated report:
npm run upstream:scan -- --live --provider claude --write-snapshot --write-report
```

A failed fetch is advisory (exit 0) unless `--fail-on-critical` is passed; it
never breaks the default release gate.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.claude`):
   add/adjust the flag, arity, enum `values`, or `permission`/`resume` rule.
   This is the only place mechanical behaviour lives.
2. **Add a conformance fixture** under `conformanceFixtures` proving the new
   accept/reject behaviour (mirror the existing `claude-*` fixtures).
3. **If a source URL or watch category changed**, update
   `upstreamMetadata` in the contract, then mirror it into
   `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` (offline fixtures +
   report + TOML-sync) and `npm test`.

## Claude-specific notes (see the contract for exact rules)

- `-p` has `optional` arity: standalone in slice κ stdin mode, legacy `-p <prompt>` otherwise.
- `stream-json` output requires `--verbose` alongside `--print`; the gateway emits them together.
- `--input-format stream-json` carries caller `cache_control` breakpoints.
- Permission modes and reasoning-effort levels are closed enums — extend the enum in the contract, not here.
- Continuity is real via `--continue` / `--session-id`.
