# Provider CLI release targets

This file records exact upstream CLI versions used for gateway release
validation and explicitly labelled pending contract probes. It is evidence, not
a dependency lock.

## Meaning of "target/probed version"

`target/probed version` means the upstream CLI version installed in the release
validation environment when the gateway release was checked. It is the version
agents should treat as the concrete behavior baseline for flags, session
continuity, output formats, approval modes, native tool discovery, and
provider-specific setup guidance.

It does **not** mean:

- a minimum supported version,
- a maximum supported version,
- a version that the gateway installs for users,
- or a claim that every older or newer upstream CLI has identical behavior.

`artifact SHA-256` records the exact local upstream artifact used for the probe.
For native CLIs, hash the native payload that ultimately executes. For CLIs
launched through a script or package entry point, hash the deepest stable
provider-owned payload available and name that artifact explicitly. If only a
wrapper or installed package manifest is available, say so in `Artifact hashed`.

If a provider CLI is not installed in the release validation environment, record
`not installed` and say which contract-only checks were run instead. Do not
claim installed-binary compatibility for that provider in the release notes.

## Current contract refresh baseline

### Post-v2.17.0 contract refresh - 2026-07-13

This is a pending contract-maintenance probe, not retrospective release
evidence for v2.17.0. The values and hashes record the installed provider
artifacts used to prepare the next contract update. Copy or re-probe this table
for a release candidate before labelling it a release baseline.

| Provider           | Gateway surface                                              | Executable     | Target/probed CLI version         | Artifact hashed           | Artifact SHA-256                                                   | Validation status                  | Notes for agents                                                                                                                      |
| ------------------ | ------------------------------------------------------------ | -------------- | --------------------------------- | ------------------------- | ------------------------------------------------------------------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | `claude_request`, `claude_request_async`                     | `claude`       | `2.1.207 (Claude Code)`           | native Claude executable  | `85e7e988a392d859f90802ca21fb26e89d3c9ab527f5ed0b08df3955e34d5c83` | installed; version and help probed | No native ACP entrypoint. `manual` is an upstream permission mode; gateway `default` emits no upstream permission flag.               |
| Codex CLI          | `codex_request`, `codex_request_async`, `codex_fork_session` | `codex`        | `codex-cli 0.144.3`               | native Codex payload      | `37e6f5953f191b04f7b62cb07dae90f51d0947ad89f0355665b421fbde28700b` | installed; version and help probed | No native ACP entrypoint. Gateway resume IDs must be real Codex session UUIDs.                                                        |
| Gemini/Antigravity | `gemini_request`, `gemini_request_async`                     | `agy`          | `agy 1.1.1`                       | native `agy` executable   | `32e394fc0e63a41ed4e7ac05304224678d3e062d707effdc3bbff868767659f9` | installed; version and help probed | No native ACP entrypoint. This version adds upstream `--agent`, `agent`, and `agents` surface.                                        |
| Grok CLI           | `grok_request`, `grok_request_async`                         | `grok`         | `grok 0.2.99 (b1b49ccb71)`        | native Grok payload       | `9fccba400d3808ec34a991892096b34c6f5846b2b118d355001601fd5428445c` | installed; version and help probed | Native `grok agent stdio` ACP entrypoint. `--fullscreen` persists local UI configuration; `wrap` executes an arbitrary local command. |
| Mistral Vibe       | `mistral_request`, `mistral_request_async`                   | `vibe`         | `vibe 2.19.1`                     | Vibe console entry point  | `d4fa095cd807d7ddfcb134f4bd9a8914c5ac6b9acd8339ca1d5c36e0b200d29f` | installed; version and help probed | Native `vibe-acp` entrypoint. Gateway defaults to `accept-edits`; `auto-approve` is explicit opt-in.                                  |
| Devin CLI          | `devin_request`, `devin_request_async`                       | `devin`        | `devin 3000.1.27 (0d4bf12e)`      | native Devin payload      | `6c0a5345055781da752b982c77b3179b5ece1b1bf1a38433156dad9564e2f079` | installed; version and help probed | Native `devin acp` entrypoint. `accept-edits` is an upstream permission mode.                                                         |
| Cursor Agent CLI   | `cursor_request`, `cursor_request_async`                     | `cursor-agent` | `cursor-agent 2026.07.09-a3815c0` | Cursor Agent entry module | `856d7247e0ea94dff89c482ddb26360622f8d1b8f8846af0a3c827b9a6fb9355` | installed; version and help probed | Native `cursor-agent acp` entrypoint. Keep interactive and administrative root commands catalog-only unless separately approved.      |

Additional ACP wrapper evidence: `vibe-acp` console entry point SHA-256
`fde63f4648257bf80e234c82af3de7b7f38e05c7de560ed83eda76666883f016`.

## Latest recorded release baseline

### v2.11.1 - 2026-06-22

Provider-contract maintenance release. The scanner and installed binary probes
were run against the current local provider CLI set; this release also switches
the Mistral upstream source tracker from the volatile GitHub HTML releases page
to the stable latest-release API endpoint.

| Provider           | Gateway surface                                              | Executable | Target/probed CLI version    | Artifact hashed          | Artifact SHA-256                                                   | Validation status        | Notes for agents                                                                                                                                                |
| ------------------ | ------------------------------------------------------------ | ---------- | ---------------------------- | ------------------------ | ------------------------------------------------------------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code        | `claude_request`, `claude_request_async`                     | `claude`   | `2.1.185 (Claude Code)`      | local executable wrapper | `e1246338699f04ee0e627dee3f6d4ed7a0bab48e0514bde69c6dad43bc303952` | installed and probed     | ACP remains adapter-mediated/deferred; no native entrypoint at this target version.                                                                             |
| Codex CLI          | `codex_request`, `codex_request_async`, `codex_fork_session` | `codex`    | `codex-cli 0.141.0`          | local executable wrapper | `d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406` | installed and probed     | ACP remains adapter-mediated/deferred; session IDs must be real Codex session UUIDs.                                                                            |
| Gemini/Antigravity | `gemini_request`, `gemini_request_async`                     | `agy`      | `1.0.10`                     | local executable wrapper | `3c9d88067e3ab6e5c59139ccb4fd7e8650aa39264e2548fc99fe2f700a271f96` | installed and probed     | Antigravity `agy` remains an ACP absent-watchlist item; legacy Gemini CLI ACP evidence does not transfer.                                                       |
| Grok CLI           | `grok_request`, `grok_request_async`                         | `grok`     | `grok 0.2.60 (474c2bbfc)`    | local executable wrapper | `ef3e4a8ea61d2272fb214f3cecfab6b7ec98f93705247b040f4264560fb5253f` | installed and ACP-probed | Native ACP entrypoint `grok agent stdio` was reachable via read-only probe.                                                                                     |
| Mistral Vibe       | `mistral_request`, `mistral_request_async`                   | `vibe`     | `vibe 2.17.1`                | local executable wrapper | `e9ae14c61b133d566292521d2f68ec253d6e1db2d02128c022f08da949c9db41` | installed and ACP-probed | Native ACP entrypoint `vibe-acp` was reachable via read-only probe; `vibe-acp` wrapper hash `0843d357ac8203e6d3ba69e08d8da8798cf3e0a4ddb3e3238fce40c941a1640f`. |
| Devin CLI          | `devin_request`, `devin_request_async`                       | `devin`    | `devin 2026.7.23 (3bd47f77)` | local executable wrapper | `6ee4303c159fe8234f462ba6a04dd2294db709e234cc1be952bef8afc475c2d5` | installed and ACP-probed | Native ACP entrypoint `devin acp` was reachable via read-only probe.                                                                                            |

### v2.10.0 - 2026-06-15

A security-only release (per-principal isolation on the `*_request` handlers,
workspace/worktree resolvers, and `sessions://*` resources). No provider CLI
changed between 2.9.0 and 2.10.0, so the 2.9.0 table below — itself byte-identical
to the 2.8.0 baseline — remains the authoritative provider-compatibility baseline
for 2.10.0.

### v2.9.0 - 2026-06-14

Re-probed from the local release validation environment for the
`llm-cli-gateway@2.9.0` candidate. Every provider CLI version **and** artifact
SHA-256 is byte-identical to the 2.8.0 baseline below — no provider CLI changed
between 2.8.0 and 2.9.0 (a security-remediation release), so the 2.8.0 table is
the authoritative baseline for 2.9.0 as well. Re-verified on this host:

| Provider           | Executable | Probed CLI version        | Artifact SHA-256                                                   |
| ------------------ | ---------- | ------------------------- | ------------------------------------------------------------------ |
| Claude Code        | `claude`   | `2.1.177 (Claude Code)`   | `ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7` |
| Codex CLI          | `codex`    | `codex-cli 0.139.0`       | `0729aedf4fe72971d81ef6803c817b850d711254d3c82ecc756a52f3b533c9f8` |
| Gemini/Antigravity | `agy`      | `1.0.8`                   | `945f02621361c8fae77c1edab68f0d5f9f74bf9010e39f2d2573df90ff0be41b` |
| Grok CLI           | `grok`     | `grok 0.2.51 (f4f85a649)` | `52916267aa2f7868c23a6dd7847dfe066e39a52b8ffd216380186397ea7d0075` |
| Mistral Vibe       | `vibe`     | `vibe 2.14.1`             | `d12d6f5ede1b6618fcb1548ce3d17a8233cc4d2b4e27d4ca69d1a820811b3651` |

Launcher / wrapper evidence (also unchanged from 2.8.0): Codex JS launcher
`d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406`; Mistral Vibe
console entry point `9be660837475ac2f83bc8e64e9a0b471d2b79a1f24a3aa968a1d78103c1b84e0`.

### v2.8.0 - 2026-06-14

Collected with `llm-cli-gateway doctor --json` from the local release
validation environment after building the `llm-cli-gateway@2.8.0` release
candidate.

| Provider           | Gateway surface                                              | Executable | Target/probed CLI version | Artifact hashed            | Artifact SHA-256                                                   | Validation status           | Notes for agents                                                                                                                                       |
| ------------------ | ------------------------------------------------------------ | ---------- | ------------------------- | -------------------------- | ------------------------------------------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code        | `claude_request`, `claude_request_async`                     | `claude`   | `2.1.177 (Claude Code)`   | native `claude` payload    | `ff41753634b20c869ef6a32a20863521b33d4186ac0d6a49379ab48a48395ee7` | installed and authenticated | Use Claude-specific controls only after checking `provider_tool_capabilities`; the contract still documents older help-surface anchors where relevant. |
| Codex CLI          | `codex_request`, `codex_request_async`, `codex_fork_session` | `codex`    | `codex-cli 0.139.0`       | native platform payload    | `0729aedf4fe72971d81ef6803c817b850d711254d3c82ecc756a52f3b533c9f8` | installed and authenticated | Session IDs must be real Codex session UUIDs; `codex_fork_session` is Codex-only.                                                                      |
| Gemini/Antigravity | `gemini_request`, `gemini_request_async`                     | `agy`      | `1.0.8`                   | native `agy` payload       | `945f02621361c8fae77c1edab68f0d5f9f74bf9010e39f2d2573df90ff0be41b` | installed and authenticated | The gateway targets Google Antigravity CLI, not the legacy Gemini CLI. Unsupported Gemini parity fields remain schema-visible but rejected.            |
| Grok CLI           | `grok_request`, `grok_request_async`                         | `grok`     | `grok 0.2.51 (f4f85a649)` | native `grok` payload      | `52916267aa2f7868c23a6dd7847dfe066e39a52b8ffd216380186397ea7d0075` | installed and authenticated | Grok native tool discovery is informational; invoke Grok through the gateway request tools, not by copying provider-native tool names.                 |
| Mistral Vibe       | `mistral_request`, `mistral_request_async`                   | `vibe`     | `vibe 2.14.1`             | installed package `RECORD` | `d12d6f5ede1b6618fcb1548ce3d17a8233cc4d2b4e27d4ca69d1a820811b3651` | installed; login unknown    | Vibe uses `VIBE_ACTIVE_MODEL` for model selection and current Vibe defaults session logging to enabled.                                                |

Additional 2.8.0 launcher evidence:

- Codex JS launcher SHA-256:
  `d3be844c45c4fd89392536e56e1010963f94785592596b50cd0c45bb8a341406`.
- Mistral Vibe console entry point SHA-256:
  `9be660837475ac2f83bc8e64e9a0b471d2b79a1f24a3aa968a1d78103c1b84e0`.

The 2.8.0 release gate also ran `npm run check` and
`npm run upstream:contracts`. `npm run upstream:contracts` is still the
offline, mechanical contract gate; installed versions above are the concrete
runtime baseline for this release.

## Release checklist

Before cutting a release:

1. Install the release candidate locally and run `llm-cli-gateway doctor --json`.
2. Run `npm run upstream:contracts`.
3. For changed, vendor-distributed, or fast-moving providers, run
   `npm run upstream:scan -- --provider <provider> --probe-installed --fail-on-critical`.
4. Hash the exact probed provider artifact with SHA-256 and record what was
   hashed. Prefer native payloads over wrappers; record wrapper/package-manifest
   hashes only when that is the stable provider-owned artifact available.
5. Update this file with the exact CLI versions, artifact SHA-256 values,
   executable names, validation status, and any provider-specific agent notes.
6. Add a changelog note that the provider CLI target matrix was updated.

Release notes may summarize the table, but this file is the durable source for
provider CLI target precision.
