---
name: provider-grok
description: Track and maintain the upstream xAI Grok CLI contract. Use when xAI ships a Grok CLI release, when a `grok` flag/permission-mode/sandbox/output-format/resume behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: xAI Grok CLI

Process guidance for keeping the gateway's Grok (`grok`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour — the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.grok` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, permission modes, sandbox, or
resume rules here or in TOML.

## Identity

| Field | Value |
|-------|-------|
| CliType | `grok` |
| Executable | `grok` |
| Distribution | vendor (no pinned npm/PyPI package recorded) |
| Changelog | https://docs.x.ai/developers/release-notes.md |
| Install docs | https://docs.x.ai/build/overview |
| Watch categories | `flags`, `permission-modes`, `session-resume`, `sandbox`, `output-formats` |

These values mirror `UPSTREAM_CLI_CONTRACTS.grok.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.grok]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- An xAI Grok CLI release lands and you need to check for contract drift.
- A `grok` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on the x.ai changelog.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider grok
npm run upstream:scan -- --live --provider grok --fail-on-critical
npm run upstream:scan -- --live --provider grok --write-snapshot --write-report
```

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

- `--sandbox` is freeform passthrough (no `values` enum) per `grok --help`; `--permission-mode` / `--effort` / `--output-format` are closed enums.
- `--allow` / `--deny` / `--rules` repeat once per rule.
- Continuity is real via `--resume` / `--continue`; auth must be set up first (`grok login` OAuth or `GROK_CODE_XAI_API_KEY`).
- No cache statistics are surfaced by the Grok CLI.
