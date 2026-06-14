# Provider CLI release targets

This file records the exact upstream CLI versions a gateway release was
validated against. It is release evidence, not a dependency lock.

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

## Current release baseline

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
