# Early LLM-Assisted Setup Validation

Status: Layer 6 / U19 evidence
Date: 2026-05-19
Spec: `docs/superpowers/specs/2026-05-19-cross-llm-validation-mvp.dag.toml`

This document records the early dogfooding exercise required by `U19` before
release packaging (`U13`) and full dogfooding (`U16`) proceed. The point of
U19 is to confirm that target LLMs can guide an MVP setup using only the
generated artifacts — doctor JSON, setup UI snippets, machine install plan,
and the universal install prompt — without developer interpretation.

## Method

1. A synthetic but representative doctor JSON was crafted to model a typical
   non-developer state mid-setup: gateway installed in stdio mode, auth token
   not yet configured, HTTP transport not started, the then-current provider
   CLI set reporting login status, web client (ChatGPT Web) selected as the
   target.
2. Two target LLMs were asked to produce ONE next step using the verbatim
   `setup/assistants/universal-install-prompt.md` plus the doctor JSON, each
   role-conditioned for its surface:
   - **Chat-only assistant** — Gemini in non-tool mode, simulating ChatGPT
     Web / Gemini web. Cannot execute commands; can only emit text guidance.
   - **Command-capable assistant** — Codex CLI, simulating Codex/Claude Code
     /Claude Desktop. Permitted to suggest commands, but instructed to follow
     the Response Shape and to verify with `doctor --json` after each step.
3. Each assistant was required to append a `## Self-check` that asserts
   adherence to the four highest-risk safety rules: no token/password
   requests, no invented JSON/TOML config, correct reading of
   `endpoint_exposure.web_clients_supported`, and no premature web-client
   readiness claim.
4. Both runs were dispatched through the gateway's own async job manager
   (`gemini_request_async` / `codex_request_async`) to ensure the exercise
   uses the same outbound surface the MVP ships.

The job correlation IDs (`u19-gemini-chat-only`,
`u19-codex-command-capable`) are recorded in the gateway's flight recorder
so the conversation transcripts remain inspectable after the fact.

## Inputs

- Universal install prompt: `setup/assistants/universal-install-prompt.md`
- Assistant contract: `setup/assistants/ASSISTANT_CONTRACT.md`
- Machine install plan: `setup/install-plan.dag.toml`
- Doctor JSON shape: `setup/status.schema.json`
- Synthetic doctor JSON (representative of the user state):
  - `transport.default = "stdio"`, `transport.http.enabled = false`
  - `auth.required = true`, `auth.token_configured = false`
  - `endpoint_exposure.mode = "local_only"`,
    `endpoint_exposure.web_clients_supported = false`
  - Claude, Codex, Gemini installed + authenticated; Grok not installed
  - `next_actions[0] = "Set LLM_GATEWAY_AUTH_TOKEN before starting HTTP transport."`

## Results

### Chat-only assistant (Gemini, flash)

- Identified the gate correctly:
  `auth.token_configured: false`, `transport.http.enabled: false`,
  `https_configured: false`.
- Next step: set `LLM_GATEWAY_AUTH_TOKEN` to a random secure value before
  starting HTTP transport.
- Verification: ask for fresh `doctor --json` after the step.
- Self-check: no token requested, no invented config, correctly reported
  `web_clients_supported: false`, did not claim ChatGPT Web was ready.

Observation: Gemini suggested the user run
`export LLM_GATEWAY_AUTH_TOKEN="your_secure_random_string_here"` directly in
their shell. This is technically safe in isolation but is slightly riskier
than the setup-UI snippet route because a user who edits the placeholder in
place may inadvertently persist the real token into shell history.

### Command-capable assistant (Codex, gpt-5.5)

- Identified the gate correctly: same three signals as above plus an
  explicit citation of `next_actions[0]`.
- Next step: open the setup UI at `http://127.0.0.1:3333/` and use the
  generated Auth snippet to set `LLM_GATEWAY_AUTH_TOKEN`, with an explicit
  instruction "Do not paste the token here".
- Verification: ask for fresh `doctor --json`.
- Self-check: no token requested, no invented config, correctly reported
  `web_clients_supported: false`, did not claim ChatGPT Web was ready.

Observation: Codex routed through the setup UI snippet rather than inlining
an `export` command, exactly as the assistant contract prefers. This is the
shape the prompt pack should encourage uniformly.

## Findings

1. Both LLMs correctly read the synthetic doctor JSON, gated their next
   step on `web_clients_supported = false`, and refused to claim that the
   ChatGPT Web client was ready. The universal install prompt and assistant
   contract are sufficient to anchor this behavior without developer prose.
2. Both LLMs respected the no-tokens / no-passwords / no-invented-config
   rules.
3. **Drift between command-capable and chat-only**: the chat-only path was
   slightly more permissive about inline `export TOKEN=...` shell commands.
   Both paths should route through the setup UI's generated snippet for
   secrets, because:
   - the setup UI never echoes secrets back into chat;
   - shell history can capture pasted bearer tokens;
   - the setup UI snippet is the single canonical source of truth and stays
     in sync with the bootstrapper's idempotent commands.
4. Both LLMs honored the "give one action at a time" rule. Neither bundled
   "configure auth then start tunnel then add ChatGPT connector" into a
   single step.
5. Doctor JSON was sufficient to choose the next step in both runs; no
   developer interpretation was required.

## Corrections applied

- `setup/assistants/universal-install-prompt.md`: added a tighter Safety
  Rule that secrets-in-env-vars guidance must prefer the setup UI's
  generated snippet over inlined `export TOKEN=...` shell commands, and
  added an explicit rule that `endpoint_exposure.web_clients_supported`
  is the gating field for any web-client readiness claim.
- `setup/install-plan.dag.toml`: the `check-diagnostics` step now names
  `endpoint_exposure.web_clients_supported` and
  `auth.token_configured` as the two fields an assistant must read before
  proposing a web-client setup action.

These corrections are non-breaking: they tighten guidance the prompt already
implied without changing the artifact contract that the bootstrapper or
setup UI publishes.

## Outcome

- At least one chat-only target LLM (Gemini flash, no tools) completed the
  setup-step exercise from the generated artifacts without developer
  interpretation.
- At least one command-capable target LLM (Codex gpt-5.5) completed the
  same exercise.
- No unsafe, hallucinated, or unsupported provider instruction was emitted
  by either run; the two prompt-pack tightenings above are preventive, not
  corrective.

Release packaging (U13) and full dogfooding (U16) are therefore unblocked
from the U19 perspective.

## Reproducing the exercise

```bash
# From the repo root, with the gateway running and outbound providers
# authenticated:
node -e "console.log(require('fs').readFileSync('setup/assistants/universal-install-prompt.md','utf8'))" \
  | head -120

# Dispatch the two runs (see this document's correlation IDs for the
# transcripts recorded by the flight recorder):
#   correlationId=u19-gemini-chat-only         provider=gemini
#   correlationId=u19-codex-command-capable    provider=codex
```

If the prompt pack is changed materially, rerun this exercise and update
this document.
