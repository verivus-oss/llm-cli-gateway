---
name: provider-codex
description: Track and maintain the upstream OpenAI Codex CLI contract. Use when OpenAI ships a Codex release, when a `codex exec` flag/sandbox/approval/resume/subcommand behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.2"
---

# Provider: OpenAI Codex CLI

Process guidance for keeping the gateway's Codex (`codex`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour — the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.codex` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, sandbox/approval modes, or
resume rules here or in TOML.

## Identity

| Field | Value |
|-------|-------|
| CliType | `codex` |
| Executable | `codex` |
| Package | `@openai/codex` (npm) |
| Repo | https://github.com/openai/codex |
| Releases | https://github.com/openai/codex/releases |
| Changelog | https://developers.openai.com/codex/changelog |
| Watch categories | `flags`, `sandbox-modes`, `approval-modes`, `session-resume`, `output-schema` |

These values mirror `UPSTREAM_CLI_CONTRACTS.codex.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.codex]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- An OpenAI Codex CLI release lands and you need to check for contract drift.
- A `codex` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on the Codex release notes
  or changelog.

## How LLM agents should use Codex through the gateway

1. Discover the live gateway/provider surface before relying on Codex-specific
   controls:
   ```
   provider_tool_capabilities({cli:"codex"})
   ```
   For a cached read-only resource, use `provider-tools://codex`.
2. Use `codex_request` for normal implementation/review turns,
   `codex_request_async` for long-running work, and `codex_fork_session` when a
   real Codex session needs to branch.
3. Omit `model` unless the caller explicitly asked for a specific variant; the
   gateway resolves the configured Codex default/profile.
4. Include `fullAuto:true` when Codex must edit files or run shell commands.
   Pair it with `approvalStrategy:"mcp_managed"` for the gateway approval gate.
5. Do not pass Claude-style `allowedTools` or `disallowedTools`; Codex does not
   expose those request fields through the gateway. `mcpServers` is approval
   tracking only because Codex owns its MCP configuration.
6. Use `sandboxMode`, `askForApproval`, `profile`, `configOverrides`, images,
   `outputFormat`, and `outputSchema` only as reported by
   `provider_tool_capabilities`.
7. Codex continuity is real through `codex exec resume`: pass a real Codex UUID
   from `~/.codex/sessions/`, or `resumeLatest:true`. Gateway `gw-*` IDs are not
   Codex sessions, and `fullAuto:true` is dropped on resume because Codex
   inherits the original session approval policy.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider codex
npm run upstream:scan -- --live --provider codex --fail-on-critical
npm run upstream:scan -- --live --provider codex --write-snapshot --write-report
```

A failed fetch is advisory (exit 0) unless `--fail-on-critical` is passed.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.codex`):
   the `exec` / `exec resume` command shape, flag arities/enums, and the
   `resumeOnlyFlags` / `resumeForbiddenFlags` lists all live here.
2. **Add a conformance fixture** proving the new accept/reject behaviour
   (mirror the existing `codex-*` fixtures, including resume cases).
3. **If a source URL or watch category changed**, update `upstreamMetadata` and
   mirror it into `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` and `npm test`.

## Codex-specific notes (see the contract for exact rules)

- Tested against codex-cli 0.141.0 (ACP targetVersion).
- argv must start with `exec`; `exec resume` enters resume context.
- `--last` is resume-only; `--sandbox` / `--ask-for-approval` / `--full-auto` / `--search` are forbidden on resume (per resumeForbiddenFlags).
- `--output-schema`, `-c key=value`, `--ephemeral`, safety bypasses (on review), `--json` etc. are accepted on resume/review (codex-cli 0.141.0). Example (resume):
  ```
  codex exec resume --ephemeral --json <UUID> "follow up"
  ```
- Sandbox and approval values are closed enums — extend the enum in the contract.
- Continuity is real via `codex exec resume <UUID>` / `--last`; `sessionId` must be a real Codex UUID (gateway `gw-*` IDs rejected).
