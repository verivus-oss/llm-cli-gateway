---
name: provider-codex
description: Track and maintain the upstream OpenAI Codex CLI contract. Use when OpenAI ships a Codex release, when a `codex exec` flag/sandbox/approval/resume/subcommand behaviour changes, or when an upstream scan flags drift. Process guidance only; `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.2"
---

# Provider: OpenAI Codex CLI

Process guidance for keeping the gateway's Codex (`codex`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour; the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.codex` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, sandbox/approval modes, or
resume rules here or in TOML.

## Identity

| Field            | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| CliType          | `codex`                                                                       |
| Executable       | `codex`                                                                       |
| Package          | `@openai/codex` (npm)                                                         |
| Repo             | https://github.com/openai/codex                                               |
| Release API      | https://api.github.com/repos/openai/codex/releases/latest                     |
| Changelog RSS    | https://learn.chatgpt.com/docs/changelog/rss.xml                              |
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
4. Prefer `sandboxMode:"workspace-write"` when Codex needs a writable
   workspace. `fullAuto:true` is the deprecated compatibility shorthand. Use
   `approvalStrategy:"legacy"`: Codex rejects `mcp_managed` before launch
   because its ambient MCP configuration cannot be isolated, and
   `approvalPolicy` has no effect for Codex.
5. Do not pass Claude-style `allowedTools` or `disallowedTools`; Codex does not
   expose those request fields through the gateway. Codex owns its MCP
   configuration, and a gateway `mcpServers` list is descriptive metadata, not
   an enforceable allowlist.
6. Use `sandboxMode`, `profile`, `configOverrides`, `oss`, images,
   `outputFormat`, and `outputSchema` only as reported by
   `provider_tool_capabilities`. `askForApproval` and
   `useLegacyFullAutoFlag` are deprecated compatibility inputs: current Codex
   emits no corresponding argv and the gateway returns a warning. `fullAuto:true`
   remains a compatibility shorthand for `sandboxMode:"workspace-write"`.
   These are provider-native legacy controls, not inputs to the Claude-only
   gateway approval boundary.
7. Codex continuity is real through `codex exec resume`: pass a real Codex UUID
   from `~/.codex/sessions/`, or `resumeLatest:true`. Gateway `gw-*` IDs are not
   Codex sessions. Resumed Codex sessions retain their provider-native posture;
   `sandboxMode` and its deprecated `fullAuto:true` shorthand are dropped on
   resume. `resumeLatest` selects Codex's globally latest session, inherits that
   session's original cwd, and is not scoped by `workingDir`.
   The provider-native `workingDir` and `addDir` flags scope new sessions only;
   the gateway accepts but omits those fields on resume. A verified `workspace`
   or gateway `worktree` can still select the child process launch cwd and bind
   gateway tracking, but it does not retarget the resumed Codex session. Every
   resume form, including a direct UUID resume, inherits the original native
   session cwd.
8. Codex new and resume requests send the exact prompt through stdin with the
   native `-` marker. They do not consume the platform's single-argv prompt
   allowance and are never truncated. `codex_fork_session` uses the distinct
   `codex fork` contract, remains argv-bound, and rejects oversized UTF-8 prompts
   as non-retryable `input_too_large`. An otherwise unscoped child still runs in
   a fresh neutral temporary cwd, not the gateway repository. All other
   caller-controlled argv values are admitted in their final encoded form
   before spawn. Embedded NUL bytes return non-retryable `invalid_input`
   without exposing the rejected value. New and resumed stdin requests complete
   only after the full payload write callback succeeds; a clean child exit with
   closed or pending delivery is a fixed non-sensitive failure.

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

- Tested against codex-cli 0.144.5. Codex advertises mcp-server / app-server transports, not a native ACP entrypoint, so `provider-acp://codex` reports `native:false` (no methods, no adapter-as-native masquerade) and `codex_request` exposes no `transport:"acp"` selector.
- argv must start with `exec`; `exec resume` enters resume context.
- `--last` is resume-only. In resume context, `--sandbox`, `-C`, `--cd`,
  `--add-dir`, and `--profile` are forbidden (per `resumeForbiddenFlags`).
  `--ask-for-approval`, `--full-auto`, and `--search` are unsupported by the
  current `codex exec` command on every path.
- `--output-schema`, `-c key=value`, `--ephemeral`, safety bypasses (on review), `--json` etc. are accepted on resume/review (codex-cli 0.144.5). Example (resume):
  ```
  codex exec resume --ephemeral --json <UUID> "follow up"
  ```
- Sandbox and approval values are closed enums; extend the enum in the contract.
- Continuity is real via `codex exec resume <UUID>` / `--last`; `sessionId` must be a real Codex UUID (gateway `gw-*` IDs rejected).
- Top-level interactive `resume` and destructive `delete` are catalogued for drift monitoring, not request argv. Keep them unexposed unless a separately reviewed gateway surface is added.
