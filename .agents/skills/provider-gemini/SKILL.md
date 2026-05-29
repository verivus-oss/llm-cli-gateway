---
name: provider-gemini
description: Track and maintain the upstream Google Gemini CLI contract. Use when Google ships a Gemini CLI release, when a `gemini` flag/approval-mode/output-format/resume behaviour changes, or when an upstream scan flags drift. Process guidance only — `src/upstream-contracts.ts` is the mechanical source of truth.
metadata:
  author: verivus-oss
  version: "1.0"
---

# Provider: Google Gemini CLI

Process guidance for keeping the gateway's Gemini (`gemini`) integration aligned
with the upstream CLI. This skill does **not** define argv/env behaviour — the
single mechanical source of truth is `UPSTREAM_CLI_CONTRACTS.gemini` in
`src/upstream-contracts.ts`, enforced by `validateUpstreamCliArgs` /
`validateUpstreamCliEnv`. Never re-encode flags, approval modes, output formats,
or resume rules here or in TOML.

## Identity

| Field | Value |
|-------|-------|
| CliType | `gemini` |
| Executable | `gemini` |
| Package | `@google/gemini-cli` (npm) |
| Repo | https://github.com/google-gemini/gemini-cli |
| Changelogs | https://geminicli.com/docs/changelogs/ · https://github.com/google-gemini/gemini-cli/releases |
| Watch categories | `flags`, `approval-modes`, `output-formats`, `session-resume` |

These values mirror `UPSTREAM_CLI_CONTRACTS.gemini.upstreamMetadata` and
`docs/upstream/provider-sources.dag.toml` (`[providers.gemini]`). The TypeScript
metadata is authoritative; the TOML is scanner input only.

## When to use

- A Google Gemini CLI release lands and you need to check for contract drift.
- A `gemini` request fails the upstream contract check before spawn.
- `npm run upstream:scan -- --live` reports a change on either Gemini source.

## Scan for upstream change

```bash
npm run upstream:scan -- --provider gemini
npm run upstream:scan -- --live --provider gemini --fail-on-critical
npm run upstream:scan -- --live --provider gemini --write-snapshot --write-report
```

Gemini has two tracked sources (docs site + GitHub releases); both are fetched
under `--live`. A failed fetch is advisory unless `--fail-on-critical` is set.

## Update procedure when the upstream CLI changes

1. **Edit the contract** in `src/upstream-contracts.ts` (`UPSTREAM_CLI_CONTRACTS.gemini`):
   flag arities, the `--approval-mode` enum, and the `-o` output-format enum live here.
2. **Add a conformance fixture** proving the new accept/reject behaviour
   (mirror the existing `gemini-*` fixtures).
3. **If a source URL or watch category changed**, update `upstreamMetadata` and
   mirror it into `docs/upstream/provider-sources.dag.toml`.
4. **Verify**: `npm run build && npm run upstream:contracts` and `npm test`.

## Gemini-specific notes (see the contract for exact rules)

- Approval modes (`default`, `auto_edit`, `yolo`, `plan`) and `-o` formats (`json`, `stream-json`) are closed enums — extend in the contract.
- Continuity is real via `--resume`; gateway-generated `gw-*` IDs are bookkeeping only and rejected if replayed as `sessionId`.
- Check the `resumable` response field to know whether a session can continue.
