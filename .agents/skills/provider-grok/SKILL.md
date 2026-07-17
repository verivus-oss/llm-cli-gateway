---
name: provider-grok
description: Track and maintain the upstream xAI Grok CLI contract. Use when xAI ships a Grok CLI release, when a `grok` flag/permission-mode/sandbox/output-format/resume/subcommand behaviour changes, or when an upstream scan flags drift. Process guidance only; `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.2"
---

# Provider: xAI Grok CLI

Process guidance for keeping the gateway's Grok (`grok`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour; the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.grok` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, permission modes, sandbox, or
resume rules here or in TOML.

## Identity

| Field            | Value                                                                      |
| ---------------- | -------------------------------------------------------------------------- |
| CliType          | `grok`                                                                     |
| Executable       | `grok`                                                                     |
| Distribution     | vendor (no pinned npm/PyPI package recorded)                               |
| Changelog        | https://docs.x.ai/developers/release-notes.md                              |
| Install docs     | https://docs.x.ai/build/overview                                           |
| Watch categories | `flags`, `permission-modes`, `session-resume`, `sandbox`, `output-formats` |

These values mirror `UPSTREAM_CLI_CONTRACTS.grok.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.grok]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- An xAI Grok CLI release lands and you need to check for contract drift.
- A `grok` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on the x.ai changelog.

## How LLM agents should use Grok through the gateway

1. Discover the live gateway/provider surface before relying on Grok-specific
   controls or local skill tools:
   ```
   provider_tool_capabilities({cli:"grok"})
   ```
   For a cached read-only resource, use `provider-tools://grok`.
2. Use `grok_request` for normal turns and `grok_request_async` for long-running
   review, analysis, or diversity checks. Sync calls may auto-defer; poll
   `llm_job_status` and fetch with `llm_job_result` when that happens.
3. Omit `model` unless the caller explicitly asked for a specific variant; the
   gateway resolves the configured Grok default.
4. Do not copy Claude tool names such as `Read`, `Grep`, `Glob`, or `Bash` into
   Grok `allowedTools`; Grok has its own provider-native tool names. This was
   the root cause of prior Grok reviewer startup failures.
5. Grok supports gateway `allowedTools` / `disallowedTools`, `allow` / `deny`,
   `alwaysApprove`, `permissionMode`, agent/subagent controls, web-search
   toggles, memory/planning toggles, prompt controls, output format,
   workspace/worktree/native-worktree controls, session controls, and
   compaction/effort controls as reported by `provider_tool_capabilities`. Use
   `approvalStrategy:"legacy"`: Grok rejects `mcp_managed` before launch and
   `approvalPolicy` has no effect. Its permission and sandbox controls remain
   provider-native. Native ACP also rejects those Claude-only fields.
6. `mcpServers` is descriptive metadata only; Grok owns its MCP configuration.
7. Local Grok skills are discoverable from `~/.grok/skills` and bundled skill
   directories. `provider_tool_capabilities` reports discovered provider-native
   tools such as Imagine `image_gen`, `image_edit`, `image_to_video`, and
   `reference_to_video` when those skills are present. The gateway still
   executes Grok through `grok_request`; it does not directly call those native
   tools.
8. The full subcommand surface (including `agent/*`, `update`, `worktree`, `dashboard`, `login`, etc.) is exposed via `provider_subcommands_list`, `provider_subcommand_contract`, and `provider_subcommand_drift` for inspection and drift monitoring. `dashboard` (grok 0.2.60 (474c2bbfc)+) is catalogued as read-only/inspect.
9. Grok continuity is real via `sessionId`, `resumeLatest`, `createNewSession`,
   `--resume`, and `--continue`. Auth must already be set up with `grok login`
   or `XAI_API_KEY`. Bind concurrent repository work with
   `workingDir` or a verified `workspace`. Use gateway `worktree` only with an
   explicit provider-native `sessionId` that is not overridden by
   `createNewSession`; fresh, `createNewSession`, and `resumeLatest`-only
   worktree requests fail closed.
10. An unscoped CLI child uses a fresh neutral temporary cwd. A cwd-scoped
    `resumeLatest` without a stable selected target fails closed. Grok's current
    prompt contract is argv-bound, so oversized UTF-8 input fails as
    non-retryable `input_too_large` and is never truncated. All other
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
npm run upstream:scan -- --provider grok
npm run upstream:scan -- --live --provider grok --fail-on-critical
npm run upstream:scan -- --live --provider grok --write-snapshot --write-report
```

**Strongly recommended for Grok (vendor binary):** include `--probe-installed`.
The tracked web page is high-level product notes and rarely contains detailed
CLI flag/subcommand drift. The installed `--help` probe + help-surface
snapshot diff is the reliable detector for new flags (`--worktree`,
`--todo-gate`, `--agent`, etc.), arity changes, and new subcommands (e.g. `dashboard`).

A failed fetch is advisory (exit 0) unless `--fail-on-critical` is passed.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.grok`):
   flag arities, the `--permission-mode` / `--effort` / `--output-format` enums,
   and freeform passthrough flags (e.g. `--sandbox`) live here.
2. **Add a conformance fixture** proving the new accept/reject behaviour
   (mirror the existing `grok-*` fixtures).
3. **If a source URL or watch category changed**, update `upstreamMetadata` and
   mirror it into `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` and `npm test`.

## Grok-specific notes (see the contract for exact rules)

- Tested against grok 0.2.101 (5bc4b5dfad). Grok has a native ACP entrypoint (`grok agent stdio`); `grok_request` accepts `transport:"acp"` and `provider-acp://grok` reports the negotiated capability set (fails closed unless `[acp]` and the provider `runtime_enabled` gate are set).
- `--sandbox` is freeform passthrough (no `values` enum) per `grok --help`; `--permission-mode` / `--effort` / `--output-format` are closed enums.
- `--allow` / `--deny` / `--rules` repeat once per rule.
- `--fullscreen` persists UI configuration, so track it as acknowledged upstream
  surface rather than gateway request argv. `setup --json` is a diagnostic form
  of setup; `wrap` runs an arbitrary local command and must remain catalogued,
  unexposed execution.
- Continuity is real via `--resume` / `--continue`; auth must be set up first (`grok login` OAuth or `XAI_API_KEY`).
- No cache statistics are surfaced by the Grok CLI.
- `dashboard` subcommand is tracked (read_only risk, inspect tier, tracked_only exposure) in the subcommand catalog and `--probe-installed` drift detection. It opens the central Agent Dashboard view (grok 0.2.60 (474c2bbfc)+). Example:
  ```
  provider_subcommand_contract({provider:"grok", commandPath:["dashboard"]})
  ```
  Use `provider_subcommands_list` / `provider_subcommand_drift` for discovery and drift checks.
