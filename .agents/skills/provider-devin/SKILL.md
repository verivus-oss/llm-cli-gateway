---
name: provider-devin
description: "Track and maintain the upstream Devin CLI contract. Use when Devin ships a CLI release, when a `devin` flag, permission mode, ACP entrypoint, or subcommand changes, or when an upstream scan flags drift. Process guidance only: `src/upstream-contracts.ts` is the mechanical source of truth."
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: Devin CLI

Keep the gateway's Devin (`devin`) integration aligned with the upstream CLI.
This skill does not define argv or environment behaviour. The single mechanical
source of truth is `UPSTREAM_CLI_CONTRACTS.devin` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` and
`validateUpstreamCliEnv`. Do not re-encode flags, permission modes, ACP rules,
or session rules here or in TOML.

## Identity

| Field            | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| CliType          | `devin`                                                      |
| Executable       | `devin`                                                      |
| Distribution     | vendor installer / self-update                               |
| Command docs     | https://cli.devin.ai/docs/reference/commands                 |
| CLI docs         | https://docs.devin.ai/cli                                    |
| Changelog        | https://docs.devin.ai/cli/changelog/stable                   |
| Watch categories | `flags`, `subcommands`, `permission-modes`, `acp-entrypoint` |

These values mirror `UPSTREAM_CLI_CONTRACTS.devin.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.devin]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## Gateway use

1. Discover the live gateway surface before relying on Devin-specific controls:
   ```
   provider_tool_capabilities({cli:"devin"})
   ```
   For a cached read-only resource, use `provider-tools://devin`.
2. Use `devin_request` for normal work and `devin_request_async` for long-running
   work. Sync calls may auto-defer; poll `llm_job_status` and fetch with
   `llm_job_result` when that happens.
3. Omit `model` unless the caller explicitly requests one. Use only request
   controls reported by `provider_tool_capabilities`.
4. Treat `permissionMode:"accept-edits"` as an explicit edit-authorizing choice.
   It is not equivalent to unrestricted autonomous execution.
5. Use a real resumable provider session only when the response reports it as
   resumable. Gateway bookkeeping IDs are not automatically valid Devin session
   IDs.
6. Native ACP is capability-gated. Probe the actual entrypoint with
   `devin acp --help`, not only `devin --version`.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider devin
npm run upstream:scan -- --live --provider devin --fail-on-critical
npm run upstream:scan -- --provider devin --probe-installed --fail-on-critical
npm run upstream:scan -- --live --provider devin --probe-installed --write-snapshot --write-report
```

A failed source fetch is advisory unless `--fail-on-critical` is passed. The
installed help probe is the primary evidence for fast-moving CLI surface drift.

## Update procedure

1. Edit `UPSTREAM_CLI_CONTRACTS.devin` in `src/upstream-contracts.ts`: flags,
   arities, enum values, permission modes, session rules, ACP probe commands,
   and catalogued subcommands belong there.
2. Add conformance fixtures that prove every new accept and reject behavior.
3. If a source URL or watch category changes, update TypeScript metadata first,
   then mirror it in `docs/upstream/provider-sources.dag.toml`.
4. Verify with `npm run build`, `npm run upstream:contracts`, and targeted
   provider tests before the full suite.

## Devin-specific notes

- Tested against `devin 3000.1.27 (0d4bf12e)`.
- Current upstream help includes `auto`, `accept-edits`, `smart`, and
  `dangerous` permission modes. Keep the gateway contract, request schemas,
  capability description, and fixtures synchronized when that set changes.
- `--print` and `--resume` accept optional upstream values. The gateway's
  headless request path may intentionally use a narrower form, which should be
  stated in request tests rather than inferred from root help.
- Catalog administrative, authentication, plugin, MCP, sandbox, and setup
  commands for drift monitoring. Do not expose them through request argv without
  a separately reviewed gateway surface.
