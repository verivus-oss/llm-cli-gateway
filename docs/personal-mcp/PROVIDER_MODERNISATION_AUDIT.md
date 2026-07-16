# Provider Modernisation Audit

Layer 10 of the cross-LLM validation MVP DAG. This document records the
rationale behind adding **Mistral Vibe** as the fifth supported provider
alongside Claude Code, Codex, Gemini, and Grok. Later provider additions
(`devin`, `cursor`, and configured HTTP API providers) extend the matrix but
do not change the original reason Mistral was added.

It is intentionally short: deeper protocol-level work (JSON parity, approval
parity, per-provider HIGH-impact features) belongs in U23–U27.

## 1. Five-vendor consensus rationale

The gateway claims to be a _multi-LLM orchestration layer_. Limiting that to
four upstream providers leaves the consensus and red-team tools (`validate_with_models`,
`consensus_check`, `red_team_review`) systematically blind to any failure mode
that only the fifth vendor catches.

Mistral was chosen as the fifth vendor because:

1. It is the highest-capability open-weight-friendly Western frontier vendor
   currently shipping a polished agentic CLI (`vibe`, packaged as `vibe-cli`
   on PyPI).
2. Its strengths (open-weights deployment, EU data residency, deterministic
   sampling) are uncorrelated with the four incumbents — so consensus across
   the original five-provider baseline is a stronger signal than across any
   four.
3. Vibe exposes a non-interactive `-p PROMPT` surface that mirrors Grok and
   Claude closely, so the orchestration shape stays uniform.

Rejected alternatives:

- **Cohere `command-r` CLI** — no headless `-p` mode in the current `cohere`
  CLI; would require a wrapping prompt-file shim per call.
- **DeepSeek CLI** — no published programmatic surface at the time of writing;
  community wrappers are unstable.
- **Local-only providers (Ollama, llama.cpp)** — already reachable through
  `claude --model` overrides via OpenRouter-style proxies; not a vendor in
  the consensus sense.

## 2. Five Vibe-specific divergences

Each divergence cites the upstream Vibe behaviour it is grounded in plus the
load-bearing gateway integration point.

### 2.1 No `--model` flag — model selection via `VIBE_ACTIVE_MODEL`

- **Upstream**: Vibe selects the active model from `VIBE_ACTIVE_MODEL` (or
  the `[model] active = "..."` block in `~/.vibe/config.toml`); there is no
  `--model` flag on the headless surface.
- **Gateway impact**: `prepareMistralRequest` returns `{ args, env }` and the
  env is plumbed through the executor / async-job-manager. See
  [`src/request-helpers.ts`](../../src/request-helpers.ts) (`prepareMistralRequest`
  helper) and [`src/async-job-manager.ts`](../../src/async-job-manager.ts)
  (`StartJobOptions.env`, command rewrite for `mistral` → `vibe`).
- **Default model**: `devstral-medium`. Set via the model registry's
  `defaultModel` (see `FALLBACK_INFO.mistral` in
  [`src/model-registry.ts`](../../src/model-registry.ts)).

### 2.2 Session logging via `~/.vibe/config.toml`

- **Upstream**: Current Vibe defaults session logging to enabled. An explicit
  `[session_logging] enabled = false` in `~/.vibe/config.toml` disables
  `--continue` / `--resume` continuity.
- **Gateway impact**: `doctor.ts` probes the config file via
  `checkVibeSessionLogging` and adds an actionable `next_actions` entry
  telling the user to edit the config before a continuity request fails
  opaquely.
- **Read-only**: the gateway never writes to `~/.vibe/config.toml`. The
  remediation is surfaced as guidance only.

### 2.3 `--agent <name>` selector (no `--always-approve`)

- **Upstream**: Vibe's agent is selected by `--agent <name>`. It accepts the
  documented built-ins (`default`, `plan`, `accept-edits`, `auto-approve`),
  install-gated agents such as `lean`, and custom agents. There is no Grok-style
  `--always-approve` boolean.
- **Gateway impact**: `permissionMode` is an arbitrary agent name in
  `mistral_request` / `mistral_request_async`; the gateway forwards it to Vibe,
  which validates availability. See `MISTRAL_BUILTIN_AGENT_MODES` and
  `prepareMistralRequest` in [`src/request-helpers.ts`](../../src/request-helpers.ts).
- **Programmatic default**: `accept-edits`. The gateway **always** emits
  `--agent` explicitly; omitting it would let Vibe pick its own default,
  which could surprise programmatic callers. `auto-approve` remains an
  explicit opt-in.

### 2.4 `--enabled-tools` and `--disabled-tools` controls

- **Upstream**: Vibe accepts repeated `--enabled-tools <tool>` and
  `--disabled-tools <tool>` entries. Disabled tools apply after enabled-tool
  filtering.
- **Gateway impact**: `allowedTools` emits one `--enabled-tools` per entry;
  `disallowedTools` emits one `--disabled-tools` per entry. See
  `prepareMistralRequest` in
  [`src/request-helpers.ts`](../../src/request-helpers.ts).

### 2.5 No self-update — `cli_upgrade` dispatches to pip/uv/brew

- **Upstream**: there is no `vibe update` command. Vibe ships as the
  `vibe-cli` PyPI package, and is distributed in the wild as `pip install
vibe-cli`, `uv tool install vibe-cli`, or `brew install mistral-vibe`.
- **Gateway impact**: `buildCliUpgradePlan("mistral", target)` calls
  `detectMistralInstallMethod` (pip → uv → brew probe) and returns a plan
  that targets the matching package manager. If none is detected, the
  builder throws with an actionable message. See
  [`src/cli-updater.ts`](../../src/cli-updater.ts).

## 3. Integration points (file:line evidence)

| Concern                      | File                               | Anchor                                                                          |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| CLI_TYPES enum               | `src/session-manager.ts`           | `CLI_TYPES` const includes `"mistral"`                                          |
| Tool registration            | `src/index.ts`                     | `server.tool("mistral_request", …)` and `mistral_request_async`                 |
| Handlers                     | `src/index.ts`                     | `handleMistralRequest`, `handleMistralRequestAsync`                             |
| Argv/env builder             | `src/request-helpers.ts`           | `prepareMistralRequest`, `resolveMistralSessionArgs`                            |
| Model registry               | `src/model-registry.ts`            | `FALLBACK_INFO.mistral`, `applyMistralOverrides`                                |
| Spawn command rewrite        | `src/async-job-manager.ts`         | `command = cli === "mistral" ? "vibe" : cli`                                    |
| Provider status probe        | `src/provider-status.ts`           | `PROVIDER_COMMANDS`, `mistralCredentialStoreStatus`                             |
| Login guidance               | `src/provider-login-guidance.ts`   | `GUIDANCE.mistral`                                                              |
| CLI upgrade dispatch         | `src/cli-updater.ts`               | `detectMistralInstallMethod`, `buildMistralUpgradePlan`                         |
| Doctor probe                 | `src/doctor.ts`                    | `checkVibeSessionLogging`, `parseVibeSessionLoggingEnabled`                     |
| MCP resources                | `src/resources.ts`, `src/index.ts` | `sessions://mistral`, `models://mistral`                                        |
| Validation routing           | `src/validation-orchestrator.ts`   | `buildProviderArgs` Mistral branch                                              |
| Approval type union          | `src/approval-manager.ts`          | `ApprovalCli` includes `"mistral"`                                              |
| Flight recorder type union   | `src/flight-recorder.ts`           | `FlightLogStart.cli`                                                            |
| Async job manager type union | `src/async-job-manager.ts`         | `LlmCli`                                                                        |
| Doctor schema                | `setup/status.schema.json`         | `providers.required` includes `"mistral"`, `client_config.vibe_session_logging` |

## 4. Documented assumptions (where Vibe upstream behaviour is uncertain)

These assumptions are deliberately conservative; future contact with the real
Vibe CLI may require revision.

1. **Headless prompt shape**: `vibe -p PROMPT` mirrors Grok's surface. If
   Vibe's headless prompt flag is actually `--prompt` or positional, the
   `args` builder in `prepareMistralRequest` is the only place to patch.
2. **`--continue` / `--resume <id>` shape**: assumed to mirror Grok. If Vibe
   uses a different flag pair, only `resolveMistralSessionArgs` needs to
   change.
3. **`session_logging.enabled` parsing**: the probe is a tiny inline TOML
   reader that accepts both `[session_logging]\nenabled = true` and the
   dotted `session_logging.enabled = true` form. Full TOML is parsed by the
   existing `toml` dep elsewhere — but doctor stays dependency-light here.
4. **Credential store paths** for the auto-authenticated heuristic:
   `~/.vibe/credentials.json`, `~/.vibe/auth.json`, `~/.config/vibe/credentials.json`.
5. **CLI binary name**: `vibe`. The gateway uses `mistral` as the _provider
   key_ and spawns `vibe` via `PROVIDER_COMMANDS` and the async-job-manager
   rewrite.
6. **Output usage/cost**: Vibe does not surface token/cost data in stdout.
   `extractUsageAndCost` reads
   `~/.vibe/logs/session/session_<...>/meta.json` best-effort when a native
   Vibe session UUID is available; otherwise it returns no usage fields.

## 5. Followups (U23–U27)

- **U23 JSON output + usage/cost parity**: Mistral's `--output-format json`
  is wired through but the parser still treats Mistral output as opaque
  text. Once Vibe's JSON envelope is documented, lift the `null` from
  `extractUsageAndCost("mistral", …)`.
- **U24 Permission/approval mode parity**: the `--agent` enum is wired but
  the cross-provider `approvalStrategy="mcp_managed"` mapping for Vibe was
  set to "force auto-approve". U24 should evaluate whether this is the
  right safety choice across all providers.
- **U25 Claude high-impact features**: `--agents`, agent fan-out — not in
  scope here.
- **U26 Codex high-impact features**: `--output-schema`, structured tool
  calls — not in scope here.
- **U27 Gemini high-impact features**: `--session-id`, IDE bridge —
  not in scope here.

## 6. Rejected designs

- **Add `--model` synthesis**: was considered (wrap Vibe in a shell that
  exports `VIBE_ACTIVE_MODEL` before invoking `vibe`). Rejected because the
  env-var path is a first-class Vibe contract and a wrapper adds latency,
  PATH ambiguity, and a per-platform shim.
- **Auto-enable `session_logging.enabled = true`**: would have made `--resume`
  "just work" out of the box. Rejected because mutating the user's
  `~/.vibe/config.toml` is unexpected side-effecting behaviour for an MCP
  gateway and could clobber unrelated config.
- **Pass `disallowedTools` through a deny-then-allow synthesis**: would have
  computed `enabled = ALL_TOOLS \ disallowedTools`. Rejected because the
  "ALL_TOOLS" set is unstable across Vibe releases and silent allow-list
  surprises are riskier than a logged warning.
- **Bundle a self-update shim that hard-codes `pip install -U vibe-cli`**:
  rejected — the gateway has no way to know whether the user installed via
  pip or uv or brew, and pip-upgrading a uv-managed tool would shadow the
  uv install on PATH.
