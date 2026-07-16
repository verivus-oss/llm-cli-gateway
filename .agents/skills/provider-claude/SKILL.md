---
name: provider-claude
description: Track and maintain the upstream Claude Code CLI contract. Use when Anthropic ships a Claude Code release, when a `claude` flag/output/permission/subcommand behaviour changes, or when an upstream scan flags drift. Process guidance only; `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.2"
---

# Provider: Claude Code CLI

Process guidance for keeping the gateway's Claude (`claude`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour; the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.claude` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, output modes, permission modes,
or session rules here or in TOML.

## Identity

| Field            | Value                                                                     |
| ---------------- | ------------------------------------------------------------------------- |
| CliType          | `claude`                                                                  |
| Executable       | `claude`                                                                  |
| Package          | `@anthropic-ai/claude-code` (npm)                                         |
| Changelog        | https://code.claude.com/docs/en/changelog.md                              |
| Install docs     | https://code.claude.com/docs/en/overview                                  |
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
   allowlist for reviews. Under `mcp_managed`, non-empty `allowedTools` or
   `tools` is a high-risk managed input that requires approval plus
   `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`, but remains bounded.
5. Use `mcpServers` only for gateway-known MCP servers. Under legacy approval,
   `strictMcpConfig` defaults to `false`; set it to `true` when missing MCP
   access should fail fast. Under `mcp_managed`, the gateway forces
   `strictMcpConfig:true`, so Claude uses only the generated configuration and
   only provisioned gateway-owned local definitions are eligible. Dynamic
   `npx`, ambient-PATH, and Codex-config overrides remain legacy-only; a
   caller-supplied `false` cannot weaken that boundary.
6. Prefer `approvalStrategy:"mcp_managed"` over raw
   `dangerouslySkipPermissions`. Under managed approval, a direct
   `dangerouslySkipPermissions` or `permissionMode:"bypassPermissions"` request
   is honored only with an explicit caller request, approval-manager approval,
   and `LLM_GATEWAY_APPROVAL_ALLOW_BYPASS=1`. Settings or setting sources,
   agents, native forks, plugins, added directories, non-empty
   `systemPrompt` / `appendSystemPrompt`, prompt-file controls
   (`systemPromptFile` / `appendSystemPromptFile`), `safeMode:true`, `bare:true`,
   and `debugFile` are high-risk managed inputs: they require approval and the
   operator setting, but remain bounded and do not select full permission on
   their own. A
   gateway-created worktree is also a high-risk managed input under the same
   conditions.
7. Use `createNewSession`, `sessionId`, or `continueSession` for real Claude
   continuity. Under `mcp_managed`, native continuation is also a high-risk
   input that requires approval plus the operator setting but remains bounded.
   Claude also supports structured output via `outputFormat` and `jsonSchema`.
8. Select local repository work with `workingDir`, a verified registered
   `workspace`, or gateway `worktree`. An unscoped CLI child uses a fresh
   neutral temporary cwd, not the gateway repository. A cwd-scoped continuation
   needs a stable selected target.
9. Claude's ordinary print path, including `promptParts` without effective
   cache control, carries the prompt in argv. Oversized UTF-8 input on that path
   fails before spawn as non-retryable `input_too_large`; the gateway does not
   truncate instructions. Effective cache-control requests require
   `outputFormat:"stream-json"` and carry the assembled content blocks through
   stream-json stdin instead. All other caller-controlled argv values are
   admitted in their final encoded form before spawn. Embedded NUL bytes return
   non-retryable `invalid_input` without exposing the rejected value. The stdin
   branch completes only after the full payload write callback succeeds; a
   clean child exit with closed or pending delivery is a fixed non-sensitive
   failure.

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

- Tested against claude 2.1.210. Claude Code is CLI-first with no native ACP entrypoint at this version; `provider-acp://claude` reports `native:false` (no methods, no adapter-as-native masquerade) and `claude_request` exposes no `transport:"acp"` selector.
- `-p` has `optional` arity: standalone in slice κ stdin mode, legacy `-p <prompt>` otherwise.
- `stream-json` output requires `--verbose` alongside `--print`; the gateway emits them together.
- `--input-format stream-json` carries caller `cache_control` breakpoints.
- Permission modes and reasoning-effort levels are closed enums. At this target, `manual` is an upstream permission mode; gateway `default` remains a pseudo-mode that emits no upstream permission flag. Extend the enum in the contract, not here.
- Root `gateway` starts enterprise authentication and telemetry gateway mode. Keep
  it catalogued as an unexposed server-starting command.
- `agents --all` (with `--json`) includes completed background sessions (2.1.185+). Example:
  ```
  claude agents --json --all
  ```
- Continuity is real via `--continue` / `--session-id`.
