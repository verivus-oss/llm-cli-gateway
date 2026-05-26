# Mistral Vibe Setup

## Support Status

Mistral Vibe is a verified outbound validation provider via the local `vibe`
CLI. It is not currently exposed as an inbound MCP host (Vibe is a coding
agent, not an MCP client surface). Treat Vibe as the fifth provider that the
gateway can call for model responses alongside Claude Code, Codex, Gemini, and
Grok.

## Human Instructions

1. Install the Vibe CLI through one of the supported installers (Vibe does
   not self-update; the gateway's `cli_upgrade` dispatches to whichever
   installer it detects):
   - `pip install vibe-cli`
   - `uv tool install vibe-cli`
   - `brew install mistral-vibe`
2. Sign in to Mistral through Vibe's official auth flow (`vibe auth login`).
   Do not paste API keys, OAuth tokens, or `~/.vibe/credentials` files into a
   remote chat.
3. Enable `[session_logging] enabled = true` in `~/.vibe/config.toml`.
   Without it, Vibe does not persist sessions and `mistral_request --resume`
   / `--continue` cannot work. Run `vibe config set session_logging.enabled
   true` (or edit the file directly) and verify with `doctor --json`.
4. Run `llm-cli-gateway doctor --json` and confirm:
   - `providers.mistral.cli_available` is `true`
   - `client_config.vibe_session_logging.session_logging_enabled` is `true`
5. (Optional) Pick a non-default model by exporting `VIBE_ACTIVE_MODEL` in
   the environment that runs the gateway, e.g.
   `export VIBE_ACTIVE_MODEL=mistral-medium-3.5`. Vibe has no `--model`
   flag; the gateway injects the active model via this env var.

## Assistant Instructions

Use copy/paste-safe commands. Never request Mistral passwords, OAuth tokens,
API keys, or `~/.vibe/credentials`. If `providers.mistral.cli_available` is
`false`, point the user at the install commands above and ask for fresh
doctor JSON.

When `client_config.vibe_session_logging.session_logging_enabled` is `false`,
walk the user through enabling it before attempting any session-continuity
request — the gateway will surface this in `next_actions` with the exact fix
command. The gateway never writes to `~/.vibe/config.toml`; this is a
human-on-the-loop step.

## Config Snippet

```bash
# Install
pip install vibe-cli            # or: uv tool install vibe-cli / brew install mistral-vibe

# Sign in
vibe auth login

# Enable session persistence (required for --continue / --resume)
vibe config set session_logging.enabled true

# Optional: pin a specific model for the gateway to inject
export VIBE_ACTIVE_MODEL=mistral-medium-3.5
```

Keep `VIBE_ACTIVE_MODEL` scoped to the shell/service-unit that launches the
gateway; do not paste it into a remote chat.

## Approval Mode

The gateway defaults to `--agent auto-approve` for programmatic Mistral
callers because Vibe's own default may be interactive. Override per-request
with the `permissionMode` parameter on `mistral_request`.

## Verification

In any connected client (or directly via `mistral_request`), ask:

```text
validate this sentence with two other models: gateway setup works.
```

## Doctor Field Cross-Reference

| Setup step | Doctor field |
| --- | --- |
| Vibe CLI installed | `providers.mistral.cli_available` |
| Vibe login complete | `providers.mistral.login_present` |
| Session continuity available | `client_config.vibe_session_logging.session_logging_enabled` |
| Actionable fix when session logging is off | `next_actions[]` entry beginning `mistral:` |

## Known Limitations

- Vibe does not surface token/cost usage in its stdout/stream-json output;
  per-request usage in gateway metrics is therefore `null` until a future
  unit reads `~/.vibe/logs/session/<id>/metadata.json`.
- Vibe has no `--model` flag. Model selection only works through
  `VIBE_ACTIVE_MODEL` (env) or `[model] active = "..."` in
  `~/.vibe/config.toml`.
- Vibe accepts allow-listed tools via `--enabled-tools` but has no
  deny-tool flag; the gateway accepts `disallowedTools` in the request
  schema for caller symmetry but ignores it for Mistral.
- Vibe is outbound-only for now. Do not configure it as an inbound MCP
  host.
