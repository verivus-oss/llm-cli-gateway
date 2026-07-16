---
name: provider-mistral
description: Track and maintain the upstream Mistral Vibe CLI contract. Use when Mistral ships a Vibe release, when a `vibe` flag/agent-mode/output-format/session-logging/env-model/subcommand behaviour changes, or when an upstream scan flags drift. Process guidance only; `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.2"
---

# Provider: Mistral Vibe CLI

Process guidance for keeping the gateway's Mistral (`vibe`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour; the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.mistral` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, agent modes, output formats,
the env-model rule, or resume rules here or in TOML.

## Identity

| Field            | Value                                                                    |
| ---------------- | ------------------------------------------------------------------------ |
| CliType          | `mistral`                                                                |
| Executable       | `vibe`                                                                   |
| Package          | `mistral-vibe` (pypi; also uv / brew)                                    |
| Repo             | https://github.com/mistralai/mistral-vibe                                |
| Release API      | https://api.github.com/repos/mistralai/mistral-vibe/releases/latest      |
| Watch categories | `flags`, `agent-modes`, `session-logging`, `output-formats`, `env-model` |

These values mirror `UPSTREAM_CLI_CONTRACTS.mistral.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.mistral]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- A Mistral Vibe release lands and you need to check for contract drift.
- A `mistral` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on the Vibe releases page.

## How LLM agents should use Mistral Vibe through the gateway

1. Discover the live gateway/provider surface before relying on Vibe-specific
   controls:
   ```
   provider_tool_capabilities({cli:"mistral"})
   ```
   For a cached read-only resource, use `provider-tools://mistral`.
2. Use `mistral_request` for normal turns and `mistral_request_async` for
   long-running review, analysis, or fifth-perspective checks. Sync calls may
   auto-defer; poll `llm_job_status` and fetch with `llm_job_result` when that
   happens.
3. Omit `model` unless the caller explicitly asked for a specific variant; the
   gateway selects the resolved model through `VIBE_ACTIVE_MODEL`.
4. The gateway emits `--agent <mode>` explicitly and defaults programmatic
   callers to `accept-edits`. Use `approvalStrategy:"legacy"` for Mistral;
   callers may use `permissionMode:"plan"` or another supported Vibe mode when
   they need a different behavior. Mistral rejects `mcp_managed` before launch,
   and `approvalPolicy` has no effect.
5. `allowedTools` maps to repeated `--enabled-tools` flags and
   `disallowedTools` maps to repeated `--disabled-tools` flags. Check
   `provider_tool_capabilities` before relying on either provider-native
   control.
6. `mcpServers` is descriptive metadata only; Vibe owns its MCP configuration.
7. Vibe supports output format, trust, working directory/additional directories,
   workspace/worktree, session, and max-turn/price/token controls as reported
   by `provider_tool_capabilities`. It does not support gateway
   `effort` / `reasoningEffort`.
8. Vibe continuity is real via `sessionId`, `resumeLatest`, and
   `createNewSession`. Continuation, `trust:true`, and a non-empty `addDir`
   retain the provider's native behavior under legacy. Current Vibe defaults
   session logging on; check `doctor --json` for an explicit
   `[session_logging] enabled = false` warning before assuming continuity
   transcripts are retained.
9. Bind concurrent repository work with `workingDir` or a verified `workspace`.
   Use gateway `worktree` only with an explicit provider-native `sessionId`
   that is not overridden by `createNewSession`; fresh, `createNewSession`, and
   `resumeLatest`-only worktree requests fail closed. An unscoped child uses a
   fresh neutral temporary cwd, and cwd-scoped `resumeLatest` fails closed
   without a stable target. Vibe's current prompt contract is argv-bound, so
   oversized UTF-8 input returns non-retryable `input_too_large` without
   truncation. All other
   caller-controlled argv values are admitted in their final encoded form
   before spawn. Embedded NUL bytes return non-retryable `invalid_input`
   without exposing the rejected value.

### Full-access review handoff

For a user-authorized exhaustive review that needs full provider permissions and
native MCP access, do not infer the launch controls from this maintenance guide.
Follow `multi-llm-review`'s full-access protocol, inspect the current request
schema and live capability response, and use a fresh target-checkout
`node dist/index.js --transport=stdio` gateway rather than a global process.
Reapply the grant on every new job, preserve native MCP configuration without a
pretend gateway allowlist, send the corrective-program report and exact
diff/file identity, set no caller caps, and honor a user-required 90-second
progress cadence. The reviewer must independently inspect code, docs, tests,
and commands before it can approve.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider mistral
npm run upstream:scan -- --live --provider mistral --fail-on-critical
npm run upstream:scan -- --live --provider mistral --write-snapshot --write-report
```

A failed fetch is advisory (exit 0) unless `--fail-on-critical` is passed.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.mistral`):
   flag arities, the `--agent` behavior and `--output` enum, the `--max-*` patterns, and the
   `VIBE_ACTIVE_MODEL` env contract all live here.
2. **Add a conformance fixture** proving the new accept/reject behaviour
   (mirror the existing `mistral-*` fixtures, including the env fixture).
3. **If a source URL or watch category changed**, update `upstreamMetadata` and
   mirror it into `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` and `npm test`.

## Mistral-specific notes (see the contract for exact rules)

- Tested against vibe 2.19.1. Vibe has a native ACP entrypoint (`vibe-acp`); `mistral_request` accepts `transport:"acp"` and `provider-acp://mistral` reports the negotiated capability set (fails closed unless `[acp]` and the provider `runtime_enabled` gate are set). ACP rejects `approvalStrategy:"mcp_managed"` and any `approvalPolicy`; the Mistral CLI rejects them as well because managed approval is Claude-only.
- Model is selected via the `VIBE_ACTIVE_MODEL` env var (validated by the env contract), not a `--model` flag.
- Permission/agent names are emitted as `--agent <name>`. Legacy requests may use Vibe built-ins, install-gated agents, and custom agents; the gateway defaults programmatic callers to `accept-edits`.
- Vibe 2.19.1 advertises repeatable `--disabled-tools`; the gateway maps
  `disallowedTools` to that flag once per tool.
- `--output` formats (`text`, `json`, `streaming`) are a closed enum; `--max-price` is decimal-only (no scientific notation) to match `MAX_PRICE_SCHEMA`.
- Continuity is real via `--resume` / `--continue`; current Vibe defaults session logging on, and `doctor --json` flags an explicit `[session_logging] enabled = false`.
- No cache statistics are surfaced by the Vibe CLI.
