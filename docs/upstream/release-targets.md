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

If a provider CLI is not installed in the release validation environment, record
`not installed` and say which contract-only checks were run instead. Do not
claim installed-binary compatibility for that provider in the release notes.

## Current release baseline

### v2.7.0 - 2026-06-12

Collected with `llm-cli-gateway doctor --json` from the local release
validation environment after installing `llm-cli-gateway@2.7.0`.

| Provider           | Gateway surface                                              | Executable | Target/probed CLI version | Validation status           | Notes for agents                                                                                                                                       |
| ------------------ | ------------------------------------------------------------ | ---------- | ------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Claude Code        | `claude_request`, `claude_request_async`                     | `claude`   | `2.1.175 (Claude Code)`   | installed and authenticated | Use Claude-specific controls only after checking `provider_tool_capabilities`; the contract still documents older help-surface anchors where relevant. |
| Codex CLI          | `codex_request`, `codex_request_async`, `codex_fork_session` | `codex`    | `codex-cli 0.139.0`       | installed and authenticated | Session IDs must be real Codex session UUIDs; `codex_fork_session` is Codex-only.                                                                      |
| Gemini/Antigravity | `gemini_request`, `gemini_request_async`                     | `agy`      | `1.0.7`                   | installed and authenticated | The gateway targets Google Antigravity CLI, not the legacy Gemini CLI. Unsupported Gemini parity fields remain schema-visible but rejected.            |
| Grok CLI           | `grok_request`, `grok_request_async`                         | `grok`     | `grok 0.2.50 (cadf94855)` | installed and authenticated | Grok native tool discovery is informational; invoke Grok through the gateway request tools, not by copying provider-native tool names.                 |
| Mistral Vibe       | `mistral_request`, `mistral_request_async`                   | `vibe`     | `vibe 2.14.1`             | installed; login unknown    | Vibe uses `VIBE_ACTIVE_MODEL` for model selection and current Vibe defaults session logging to enabled.                                                |

The 2.7.0 release gate also ran `npm run check` and
`npm run upstream:contracts`. `npm run upstream:contracts` is still the
offline, mechanical contract gate; installed versions above are the concrete
runtime baseline for this release.

## Release checklist

Before cutting a release:

1. Install the release candidate locally and run `llm-cli-gateway doctor --json`.
2. Run `npm run upstream:contracts`.
3. For changed, vendor-distributed, or fast-moving providers, run
   `npm run upstream:scan -- --provider <provider> --probe-installed --fail-on-critical`.
4. Update this file with the exact CLI versions, executable names, validation
   status, and any provider-specific agent notes.
5. Add a changelog note that the provider CLI target matrix was updated.

Release notes may summarize the table, but this file is the durable source for
provider CLI target precision.
