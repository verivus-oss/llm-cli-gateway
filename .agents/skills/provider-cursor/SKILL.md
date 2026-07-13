---
name: provider-cursor
description: "Track and maintain the upstream Cursor Agent CLI contract. Use when Cursor ships a CLI release, when a `cursor-agent` flag, execution mode, session command, ACP entrypoint, or subcommand changes, or when an upstream scan flags drift. Process guidance only: `src/upstream-contracts.ts` is the mechanical source of truth."
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: Cursor Agent CLI

Keep the gateway's Cursor (`cursor-agent`) integration aligned with the upstream
CLI. This skill does not define argv or environment behaviour. The single
mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.cursor` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` and
`validateUpstreamCliEnv`. Do not re-encode flags, execution modes, ACP rules,
or session rules here or in TOML.

## Identity

| Field               | Value                                                                         |
| ------------------- | ----------------------------------------------------------------------------- |
| CliType             | `cursor`                                                                      |
| Executable          | `cursor-agent`                                                                |
| Distribution        | Cursor Agent vendor distribution                                              |
| CLI docs            | https://cursor.com/cli                                                        |
| ACP docs            | https://cursor.com/docs/cli/acp                                               |
| Parameter reference | https://cursor.com/docs/cli/reference/parameters                              |
| Watch categories    | `flags`, `subcommands`, `session-resume`, `execution-modes`, `acp-entrypoint` |

These values mirror `UPSTREAM_CLI_CONTRACTS.cursor.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.cursor]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## Gateway use

1. Discover the live gateway surface before relying on Cursor-specific controls:
   ```
   provider_tool_capabilities({cli:"cursor"})
   ```
   For a cached read-only resource, use `provider-tools://cursor`.
2. Use `cursor_request` for normal work and `cursor_request_async` for
   long-running work. Sync calls may auto-defer; poll `llm_job_status` and fetch
   with `llm_job_result` when that happens.
3. Omit `model` unless the caller explicitly requests one. Use only controls
   reported by `provider_tool_capabilities`, especially execution mode, sandbox,
   workspace, and session controls.
4. Keep provider-owned MCP configuration separate from gateway approval tracking.
   Do not assume every Cursor CLI control is safe to expose through a request.
5. Use a real resumable Cursor chat only when the response reports it as
   resumable. Gateway bookkeeping IDs are not automatically valid Cursor chat
   IDs.
6. Native ACP is capability-gated. Probe `cursor-agent acp --help` when
   validating the installed entrypoint.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider cursor
npm run upstream:scan -- --live --provider cursor --fail-on-critical
npm run upstream:scan -- --provider cursor --probe-installed --fail-on-critical
npm run upstream:scan -- --live --provider cursor --probe-installed --write-snapshot --write-report
```

A failed source fetch is advisory unless `--fail-on-critical` is passed. Use the
installed help probe as the primary signal for rapidly changing command surface.

## Update procedure

1. Edit `UPSTREAM_CLI_CONTRACTS.cursor` in `src/upstream-contracts.ts`: flags,
   arities, enums, execution modes, session rules, ACP probe commands, and
   catalogued subcommands belong there.
2. Add conformance fixtures that prove every new accept and reject behavior.
3. If a source URL or watch category changes, update TypeScript metadata first,
   then mirror it in `docs/upstream/provider-sources.dag.toml`.
4. Verify with `npm run build`, `npm run upstream:contracts`, and targeted
   provider tests before the full suite.

## Cursor-specific notes

- Tested against `cursor-agent 2026.07.09-a3815c0`.
- Root commands include authentication, MCP, worker, update, chat/session, and
  rule-management surfaces. Catalog them with an explicit risk and exposure tier
  before exposing any of them through gateway admin or request tools.
- Keep destructive or interactive commands, including worker startup and any
  session mutation, catalog-only unless an approval-gated product surface is
  deliberately added.
