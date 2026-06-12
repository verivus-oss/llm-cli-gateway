---
name: provider-gemini
description: Track and maintain the gateway's Gemini-compatible Google Antigravity CLI contract. Use when Google ships an Antigravity CLI release, when an `agy` flag/permission/session behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: Google Antigravity CLI

Process guidance for keeping the gateway's Gemini-compatible provider key
(`gemini`) aligned with Google Antigravity CLI (`agy`). This skill does **not**
define argv/env behaviour — the single mechanical source of truth is
`UPSTREAM_CLI_CONTRACTS.gemini` in `src/upstream-contracts.ts`, enforced by
`validateUpstreamCliArgs` / `validateUpstreamCliEnv`. Never re-encode flags,
permission modes, output formats, or resume rules here or in TOML.

## Identity

| Field            | Value                                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| CliType          | `gemini`                                                                         |
| Executable       | `agy`                                                                            |
| Package          | vendor installer / self-update                                                   |
| Repo             | https://github.com/google-antigravity/antigravity-cli                            |
| Docs             | https://antigravity.google/docs/cli-overview                                     |
| Changelogs       | `agy changelog` · https://github.com/google-antigravity/antigravity-cli/releases |
| Watch categories | `flags`, `permissions`, `session-resume`, `subcommands`                          |

These values mirror `UPSTREAM_CLI_CONTRACTS.gemini.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.gemini]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- A Google Antigravity CLI release lands and you need to check for contract drift.
- A `gemini` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on either Antigravity source.

## How LLM agents should use Gemini/Antigravity through the gateway

1. Discover the live gateway/provider surface before relying on
   Antigravity-specific controls:
   ```
   provider_tool_capabilities({cli:"gemini"})
   ```
   For a cached read-only resource, use `provider-tools://gemini`.
2. Use `gemini_request` for normal turns and `gemini_request_async` for
   long-running review or analysis. Sync calls may auto-defer; poll
   `llm_job_status` and fetch with `llm_job_result` when that happens.
3. Omit `model` unless the caller explicitly asked for a specific variant; the
   gateway resolves the configured Gemini/Antigravity default.
4. Do not pass non-empty `allowedTools` or `mcpServers` to the current
   Antigravity request path; the gateway rejects them. Do not assume old Gemini
   CLI allowlist semantics apply to `agy`.
5. Use `approvalStrategy:"mcp_managed"` for autonomous review/analysis. It
   maps to Antigravity's supported permissive approval mode through the gateway.
6. `sandbox`, `includeDirs`, `workspace`, `worktree`, `sessionId`,
   `resumeLatest`, and `createNewSession` are the relevant controls. JSON or
   stream-json output, attachments, policy files, admin policy files, and
   `skipTrust` are unsupported/rejected in the current Antigravity path.
7. For continuity, use your own stable `sessionId` or `resumeLatest:true`.
   Gateway-generated `gw-*` IDs are bookkeeping IDs and are rejected if replayed
   as Gemini session IDs; check the response `resumable` field.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider gemini
npm run upstream:scan -- --live --provider gemini --fail-on-critical
npm run upstream:scan -- --live --provider gemini --write-snapshot --write-report
```

Antigravity has two tracked sources (docs site + GitHub releases); both are
fetched under `--live`. A failed fetch is advisory unless `--fail-on-critical`
is set.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.gemini`):
   flag arities, permission bypasses, output-format support, and session flags live here.
2. **Add a conformance fixture** proving the new accept/reject behaviour
   (mirror the existing `gemini-*` fixtures).
3. **If a source URL or watch category changed**, update `upstreamMetadata` and
   mirror it into `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` and `npm test`.

## Antigravity-specific notes (see the contract for exact rules)

- The public MCP tool names stay `gemini_request` / `gemini_request_async`, but
  the spawned executable is `agy`.
- Antigravity print mode uses `--print <prompt-as-positional>`, not Gemini's
  old `-p <prompt>` shape.
- `yolo` maps to `--dangerously-skip-permissions`; unsupported Gemini-only
  knobs such as `--approval-mode`, `-o`, policy files, MCP allowlists, and
  attachment tokens must fail before spawn unless Antigravity adds an equivalent.
- Continuity is real via `--conversation <id>` or `--continue`;
  gateway-generated `gw-*` IDs are bookkeeping only and rejected if replayed as
  `sessionId`.
- Check the `resumable` response field to know whether a session can continue.
