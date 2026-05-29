---
name: provider-mistral
description: Track and maintain the upstream Mistral Vibe CLI contract. Use when Mistral ships a Vibe release, when a `vibe` flag/agent-mode/output-format/session-logging/env-model behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: Mistral Vibe CLI

Process guidance for keeping the gateway's Mistral (`vibe`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour — the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.mistral` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, agent modes, output formats,
the env-model rule, or resume rules here or in TOML.

## Identity

| Field | Value |
|-------|-------|
| CliType | `mistral` |
| Executable | `vibe` |
| Package | `mistral-vibe` (pypi; also uv / brew) |
| Repo | https://github.com/mistralai/mistral-vibe |
| Changelog | https://github.com/mistralai/mistral-vibe/releases |
| Watch categories | `flags`, `agent-modes`, `session-logging`, `output-formats`, `env-model` |

These values mirror `UPSTREAM_CLI_CONTRACTS.mistral.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.mistral]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- A Mistral Vibe release lands and you need to check for contract drift.
- A `mistral` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on the Vibe releases page.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider mistral
npm run upstream:scan -- --live --provider mistral --fail-on-critical
npm run upstream:scan -- --live --provider mistral --write-snapshot --write-report
```

A failed fetch is advisory (exit 0) unless `--fail-on-critical` is passed.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.mistral`):
   flag arities, the `--agent` / `--output` enums, the `--max-*` patterns, and the
   `VIBE_ACTIVE_MODEL` env contract all live here.
2. **Add a conformance fixture** proving the new accept/reject behaviour
   (mirror the existing `mistral-*` fixtures, including the env fixture).
3. **If a source URL or watch category changed**, update `upstreamMetadata` and
   mirror it into `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` and `npm test`.

## Mistral-specific notes (see the contract for exact rules)

- Model is selected via the `VIBE_ACTIVE_MODEL` env var (validated by the env contract), not a `--model` flag.
- Permission/agent modes are emitted as `--agent <mode>` from a closed enum; the gateway defaults programmatic callers to `auto-approve`.
- `--output` formats (`text`, `json`, `streaming`) are a closed enum; `--max-price` is decimal-only (no scientific notation) to match `MAX_PRICE_SCHEMA`.
- Continuity is real via `--resume` / `--continue`; current Vibe defaults session logging on, and `doctor --json` flags an explicit `[session_logging] enabled = false`.
- No cache statistics are surfaced by the Vibe CLI.
