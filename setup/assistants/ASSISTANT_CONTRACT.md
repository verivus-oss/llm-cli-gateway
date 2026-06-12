# Assistant Setup Contract

Status: Layer 1 contract  
Applies to: ChatGPT, Claude, Claude Desktop, Codex, Gemini, Grok, Mistral Vibe, and other assistants helping a user install `llm-cli-gateway`.

## Purpose

Assistant instructions are product surface. An assistant may guide setup, explain diagnostics, and generate safe copy/paste commands, but it must not invent provider support, ask for secrets, or require the user to hand-edit code.

## What Assistants May Ask For

Ask only for:

- operating system and CPU architecture;
- desired inbound clients, such as ChatGPT, Claude web, Claude Desktop, Codex, Gemini CLI, Gemini web, or Grok;
- desired outbound validation providers, such as Claude Code, Codex CLI, Gemini CLI, Grok CLI/API, or Mistral Vibe CLI;
- gateway `doctor --json` output;
- generated setup packet or client snippet produced by the gateway;
- non-secret error messages from the setup UI, doctor output, or provider CLI.

When generated setup output is unavailable, assistants may adapt sanitized samples from `setup/assistants/mcp-config-samples.md`. Generated snippets remain preferred.

For HTTPS endpoint exposure, assistants may also ask whether the user wants the managed Cloudflare Quick Tunnel path or a persistent/BYO HTTPS endpoint, and whether the selected provider's connector UI is available in the user's account or workspace.

If the user has not provided `doctor --json`, request it before giving provider-specific next steps.

## What Assistants Must Not Ask For

Never request:

- provider account passwords;
- raw provider credential files;
- OAuth refresh tokens or API keys pasted into chat;
- bearer tokens for the gateway unless the user explicitly accepts the risk of pasting a token into a remote chat;
- unrelated config files;
- screenshots or logs that include authorization headers, bearer tokens, tunnel tokens, provider credentials, or private keys.

If a user shares a secret accidentally, tell them to rotate it using the provider's official flow and continue only with redacted diagnostics.

## Setup Flow

1. Confirm OS and desired clients/providers.
2. Ask the user to run the gateway installer or bootstrapper command exactly as documented.
3. Ask for `doctor --json`.
4. Read `doctor --json` and choose the next safe step.
5. If the user selected a web-hosted MCP client and endpoint exposure is not ready, follow `setup/assistants/endpoint-exposure-agent-runbook.md`.
6. Use generated snippets from the gateway rather than hand-written JSON/TOML; if a sample is needed, adapt `setup/assistants/mcp-config-samples.md`.
7. After each step, ask for fresh `doctor --json`.
8. Stop when the selected client can call a validation tool or when diagnostics identify a concrete blocker.

Verification must happen through doctor JSON after every setup step. Prose such as "it should be fixed now" is not sufficient.

## Provider Role Rules

Distinguish these roles:

- Inbound MCP host: a client that can connect to the gateway endpoint.
- Outbound validation provider: a runtime the gateway can call for model responses.
- Installer assistant: a chat or CLI that can guide the user but may not be able to connect as an inbound MCP host.

A provider can be useful as an installer assistant without being an inbound MCP host. For example, Gemini web may help a user follow instructions, but it remains unsupported as an inbound MCP host until provider-support evidence verifies custom MCP support in that product. Mistral Vibe is currently an outbound-only validation provider; do not offer inbound connector setup for it.

## Doctor Report Notes (v1.6.0)

`doctor --json` always emits a top-level `cache_awareness` block. Its
presence is structural, not a configuration signal: all `[cache_awareness]`
flags default off in 1.x, and an empty `enabled_features` list with zeroed
`last_24h` aggregates is the expected default. Assistants may surface the
block when the user explicitly asks about cache awareness, but must not
treat its presence (or its zeroed defaults) as a missing-config blocker
during install.

`doctor --json` also emits a top-level `provider_capabilities` block. Use it
as the compact source of truth for outbound provider request tools, supported
feature names, unsupported/degraded inputs, and `provider-tools://...` resource
URIs. Do not infer support for provider-specific request fields from provider
branding or from another provider's CLI surface.

## Support-Status Rules

Before giving client-specific setup instructions:

- Check the provider support matrix.
- If a target is `must_confirm_before_release`, say setup docs are gated by provider-support verification.
- If a target is `deferred_until_confirmed`, explain that the assistant can help with setup but should not claim inbound support.
- If a target is outbound-only, configure it only as a validation provider, not as the client connected to the gateway.

Do not convert a known limitation into a workaround unless the gateway's current setup artifacts explicitly support it.

## Safe Command Rules

Commands must be:

- idempotent;
- copy/paste safe;
- scoped to the gateway install directory or provider's official CLI flow;
- free of raw secrets;
- paired with verification through `doctor --json`;
- reversible, with backups before config writes.

Do not tell the user to edit source code. Generated client snippets may be written by the bootstrapper or setup UI, but not by manual code editing.

For HTTPS endpoint exposure on behalf of a user, assistants must follow `setup/assistants/endpoint-exposure-agent-runbook.md`. A command-capable local assistant may run the documented commands after user permission. A remote chat assistant must give one command or UI action at a time and verify with fresh redacted `doctor --json`.

## Failure Handling

When setup fails:

- quote the failing diagnostic field, not the user's secret material;
- suggest the next smallest verification step;
- ask for fresh `doctor --json`;
- label unsupported provider capabilities as unsupported or deferred;
- stop rather than guessing if provider docs or diagnostics do not support the next step.

## Assistant Output Shape

Prefer this shape:

```text
Current state:
- ...

Next step:
<one command or one UI action>

After it runs:
Run doctor --json and paste the redacted JSON output.
```

Never include raw bearer tokens in a remote-chat prompt unless the user has explicitly accepted that risk.
