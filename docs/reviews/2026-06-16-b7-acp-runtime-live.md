# Slice B7 — live ACP runtime end-to-end evidence

**Date:** 2026-06-16
**What:** the gated `transport: "acp"` runtime path (`runAcpRequest`) routing a
real prompt through each provider's native ACP process, end to end, on this host.

Method: a harness builds an in-memory `AcpConfig` (`enabled:true`,
provider `runtime_enabled:true`), a real provider spawn (no fake), and calls
`runAcpRequest` with the prompt `Reply with exactly one word: pong`. This is the
full path: spawn → initialize → session/new → prompt → `session/update` stream →
accumulated final text → process teardown.

| Provider | Entry | Result |
| --- | --- | --- |
| **Devin** | `devin acp` | ✅ PASS — protocolVersion 1, gw-* session created, response **"pong"**, ~24s, clean SIGTERM teardown |
| **Grok** | `grok agent stdio` | ✅ PASS — protocolVersion 1, gw-* session created, response **"pong"**, ~6.7s, clean teardown |
| **Mistral** | `vibe-acp` | Gateway path PASS (spawn + initialize protocolVersion 1 + session/new), but `session/prompt` returns provider JSON-RPC `-32603`. Root cause: **vibe is not authenticated** on this host (`~/.vibe/config.toml` has no API key; `initialize` advertises `browser-auth`). The gateway surfaced it as a redacted `AcpProtocolError` and tore the process down — correct failure behaviour. Resolve with `vibe-acp --setup` (a Mistral AI Studio key), then re-run. |

Conclusion: the B7 runtime is proven live. Devin and Grok complete a real prompt
round-trip; Mistral's gateway path is proven up to the provider's own auth
failure (a host setup task, not a gateway defect).

Safety during the live runs: deny-by-default host services, the ApprovalManager
permission bridge, gateway-owned gw-* sessions, and summarized flight-recorder
rows were all active. `runtime_enabled` stays **false** in the shipped default
config — these runs used an explicit opt-in config.
