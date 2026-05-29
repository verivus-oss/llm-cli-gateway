---
name: provider-codex
description: Track and maintain the upstream OpenAI Codex CLI contract. Use when OpenAI ships a Codex release, when a `codex exec` flag/sandbox/approval/resume behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.0"
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

- argv must start with `exec`; `exec resume` enters resume context.
- `--last` is resume-only; `--sandbox` / `--ask-for-approval` / `--full-auto` / `--search` are forbidden on resume.
- `--output-schema` and `-c key=value` are accepted on resume (codex-cli 0.133.0+).
- Sandbox and approval values are closed enums — extend the enum in the contract.
- Continuity is real via `codex exec resume <UUID>` / `--last`; `sessionId` must be a real Codex UUID (gateway `gw-*` IDs rejected).
