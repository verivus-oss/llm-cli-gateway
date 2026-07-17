---
name: provider-gemini
description: Track and maintain the gateway's Gemini-compatible Google Antigravity CLI contract. Use when Google ships an Antigravity CLI release, when an `agy` flag/permission/session/subcommand behaviour changes, or when an upstream scan flags drift. Process guidance only; `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.2"
---

# Provider: Google Antigravity CLI

Process guidance for keeping the gateway's Gemini-compatible provider key
(`gemini`) aligned with Google Antigravity CLI (`agy`). This skill does **not**
define argv/env behaviour; the single mechanical source of truth is
`UPSTREAM_CLI_CONTRACTS.gemini` in `src/upstream-contracts.ts`, enforced by
`validateUpstreamCliArgs` / `validateUpstreamCliEnv`. Never re-encode flags,
permission modes, output formats, or resume rules here or in TOML.

## Identity

| Field            | Value                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| CliType          | `gemini`                                                                                          |
| Executable       | `agy`                                                                                             |
| Package          | vendor installer / self-update                                                                    |
| Repo             | https://github.com/google-antigravity/antigravity-cli                                             |
| Docs             | https://antigravity.google/docs                                                                   |
| Changelogs       | `agy changelog` · https://api.github.com/repos/google-antigravity/antigravity-cli/releases/latest |
| Watch categories | `flags`, `permissions`, `session-resume`, `subcommands`                                           |

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
4. Do not pass non-empty `allowedTools` to the current Antigravity request
   path; the gateway rejects them. Antigravity owns its MCP configuration, and
   `mcpServers` is descriptive metadata rather than an enforceable gateway
   allowlist. Do not assume old Gemini CLI allowlist semantics apply to `agy`.
5. Use `approvalStrategy:"legacy"` for every Gemini/Antigravity request.
   `mcp_managed` is Claude-only and is rejected before the Antigravity CLI
   launches because ambient MCP configuration cannot be isolated.
   `approvalPolicy` has no effect for Gemini.
6. `sandbox`, `includeDirs`, `sessionId`, `resumeLatest`,
   `createNewSession`, `project`, and `newProject` are the relevant request
   controls. `workspace` and `worktree` are gateway routing selections, not
   Antigravity-native flags. `includeDirs` is an additional read path and does
   not select cwd. Use a verified registered `workspace` to select the process
   cwd. An unscoped child uses a fresh neutral temporary cwd, not the gateway
   repository. JSON or stream-json output, attachments, policy files, admin
   policy files, and `skipTrust` are unsupported or rejected in the current
   Antigravity path.
7. For continuity, use a verified caller-owned Antigravity conversation ID or
   `resumeLatest:true`. Gateway-generated `gw-*` IDs are bookkeeping IDs and
   are rejected if replayed as Gemini session IDs; check the response
   `resumable` field. `resumeLatest:true` requires `workspace` or a configured
   default workspace so `--continue` remains bound to a stable cwd.
8. Antigravity's current print contract carries the prompt in argv. Oversized
   UTF-8 input fails before spawn as non-retryable `input_too_large`; the
   gateway never truncates instructions. All other caller-controlled argv
   values are admitted in their final encoded form before spawn. Embedded NUL
   bytes return non-retryable `invalid_input` without exposing the rejected
   value.

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

- Tested against agy 1.1.3. Antigravity (`agy`) has no native ACP entrypoint; legacy Gemini CLI ACP evidence does not transfer, so `provider-acp://gemini` reports `native:false` (no methods, no adapter-as-native masquerade) and `gemini_request` exposes no `transport:"acp"` selector.
- The public MCP tool names stay `gemini_request` / `gemini_request_async`, but
  the spawned executable is `agy`.
- Antigravity print mode uses `--print <prompt-as-positional>`, not Gemini's
  old `-p <prompt>` shape.
- agy 1.1.3 retains root `--agent` plus `agent` and `agents` commands. Track and
  acknowledge those upstream-only controls before exposing them through a
  request schema; custom agent selection can change tool and permission posture.
- `approvalMode:"auto_edit"` maps to `--mode accept-edits`,
  `approvalMode:"plan"` maps to `--mode plan`, and `yolo` maps to
  `--dangerously-skip-permissions`. Unsupported Gemini-only knobs such as
  `--approval-mode`, `-o`, policy files, MCP allowlists, and attachment tokens
  must fail before spawn unless Antigravity adds an equivalent.
- Continuity is real via `--conversation <id>` or `--continue`;
  gateway-generated `gw-*` IDs are bookkeeping only and rejected if replayed as
  `sessionId`. Continuation remains provider-native under legacy.
- Check the `resumable` response field to know whether a session can continue.
