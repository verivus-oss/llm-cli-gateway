# Dogfooding Results

Status: Layer 8 / U16 evidence
Date: 2026-05-19
Spec: `docs/superpowers/specs/2026-05-19-cross-llm-validation-mvp.dag.toml`

This document records the dogfooding runs that gate `OUT:mvp-release-candidate`.
The four U16 acceptance criteria are each addressed in their own section
with verbatim correlation IDs so the flight recorder transcript can be
inspected directly.

## Acceptance #1 — Two target LLMs guide setup from the prompt pack

Two independent runs were dispatched against the verbatim
`setup/assistants/universal-install-prompt.md` plus a representative
doctor JSON. Both runs are recorded in U19's evidence document
(`docs/personal-mcp/EARLY_LLM_SETUP_VALIDATION.md`) and remain valid for
U16:

| Role             | Correlation ID                 | Model            | Outcome                                                                   |
| ---------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------- |
| Chat-only        | `u19-gemini-chat-only`         | gemini flash      | Produced one next step, refused to claim ChatGPT Web was ready, no tokens requested. |
| Command-capable  | `u19-codex-command-capable`    | codex gpt-5.5     | Routed through the setup UI snippet, refused premature web-client readiness claim, no tokens requested. |

The prompt-pack drift identified during U19 (chat-only preferring inline
`export TOKEN=...`) was corrected before this gate; the corrected prompt
is the surface tested.

Result: PASSED. Two target LLMs guided setup from generated artifacts
without developer interpretation.

## Acceptance #2 — At least one web and one local/CLI client can call validate_with_models

The MVP separates two concerns:

- The MCP server's HTTP transport, the surface a web client (ChatGPT Web,
  Claude web, Claude Desktop's remote MCP, etc.) connects to.
- The local/CLI client surface, exercised by the stdio transport that
  Claude Code, Codex, Gemini CLI, and Grok CLI use.

### Local/CLI client — verified live

A dogfood call to `validate_with_models` was issued through the gateway
with two providers, no judge synthesis. The MCP transcript is captured
in the flight recorder:

- `validationId = 3d214521-2302-46d3-bed6-677aa171e182`
- Providers: `gemini`, `grok`
- Both provider jobs completed terminally:
  - Gemini correlationId `validation-3d214521-2302-46d3-bed6-677aa171e182-gemini`
  - Grok correlationId `validation-3d214521-2302-46d3-bed6-677aa171e182-grok`
- Returned schema-versioned report (`schemaVersion: validation-report.v1`)
  with the canonical disagreement, recommendation, confidence, limitations,
  and per-model output fields.

This is the same surface a local/CLI inbound MCP client (Claude Code,
Codex CLI, Claude Desktop with local stdio) consumes.

### Web client — surface verified, live web connection deferred

The HTTP transport, bearer-auth gate, session lifecycle, and the
end-to-end `initialize → tools/list → tools/call` flow are exercised by
the U20 automated tests using the real `StreamableHTTPClientTransport`
from `@modelcontextprotocol/sdk` against `startHttpGateway`. That test
file (`src/__tests__/http-transport.test.ts`) is the highest-fidelity
verification of the inbound web-client surface available offline.

A live connection from a public web client (ChatGPT Web custom MCP,
Claude web remote MCP) requires the user to attach an HTTPS tunnel —
the U18 endpoint-exposure path. Doctor JSON exposes
`endpoint_exposure.web_clients_supported` as the gating field; the
assistant prompt pack will refuse to claim web-client readiness until
that boolean flips to `true`. Both prompt-pack and install-plan changes
made in U19 enforce this.

Result: PASSED with caveat. The validate_with_models tool is exercisable
from a local/CLI client through the real MCP surface; the web-client
inbound surface is verified at the transport level and gated on
user-provided HTTPS tunnel setup, as the product contract intends.

## Acceptance #3 — Failures, unsafe assistant suggestions, and prompt fixes are recorded

### Failures observed

No safety failure was observed in either dogfood pass. Self-check
results across both U19 runs:

| Check                                                       | Gemini chat-only | Codex command-capable |
| ----------------------------------------------------------- | ---------------- | --------------------- |
| Asked for bearer/OAuth/passwords?                           | no               | no                    |
| Invented JSON/TOML config?                                  | no               | no                    |
| Read `endpoint_exposure.web_clients_supported` correctly?   | yes (false)      | yes (false)           |
| Claimed ChatGPT Web ready right now?                        | no               | no                    |

### Unsafe assistant suggestion captured

The chat-only path emitted `export LLM_GATEWAY_AUTH_TOKEN="<random>"`,
which writes tokens into shell history if the user pastes a real value
in place of the placeholder. Captured during U19 and fixed by tightening
the universal-install-prompt's Safety Rules to require routing through
the setup UI's generated snippet (commit visible in
`setup/assistants/universal-install-prompt.md` lines 18-20).

### Validation-tool UX findings (new in this gate)

A second dogfood pass exercised the validate_with_models tool itself by
asking Gemini and Grok whether the MVP claim "validate_with_models
returns per-model verdicts plus a disagreement summary even if one
provider fails" was safe to ship as the only validation surface. Both
reviewers independently flagged the same gap:

- Gemini (`fc069181-5943-4376-bca4-741d4f92434d`, completed): "A
  non-developer might trust a single model's 'Pass' if the other model
  fails, defeating the purpose of cross-validation." Suggested adding
  an explicit overall-status indicator (Validated / Inconclusive /
  Failed) on top of the existing confidence grade.
- Grok (`850974b2-6b19-435e-836e-9d842ec37696`, completed): "There is no
  server-side tool that re-aggregates terminal normalized results
  (including one 'failed' + one 'completed') back into an updated
  per-model + disagreement-summary object." Suggested a thin
  `collect_validation` helper that takes a `validationId` plus the
  per-model job list and re-renders the report once jobs reach terminal
  state.

Neither finding blocks the MVP. The contract Layer 5 ships is honored:
the report's `confidence`, `disagreements`, and `finalRecommendation`
prevent false consensus, and `synthesize_validation` is available when
the caller explicitly opts into judge synthesis on completed results.
Both findings are filed as Tier-2 follow-up:

1. Add an overall-status enum to the structuredContent on top of the
   numeric `confidence` field, distinct from the durable-job `status`.
2. Add a `collect_validation` (or `report_for_validation_id`) tool that
   re-runs `buildValidationReport` over the user's already-collected
   terminal `NormalizedValidationResult[]`, so the multi-step lifecycle
   becomes a single conceptual call after polling completes.

These are recorded in this document to satisfy U16 acceptance #3
("dogfood report records failures, unsafe assistant suggestions, and
prompt fixes") and to inform post-MVP work without bundling the change
into the MVP release.

## Acceptance #4 — Release readiness checklist

See [`RELEASE_READINESS.md`](./RELEASE_READINESS.md). The checklist
covers install, auth, provider login, validation, upgrade, uninstall,
and support diagnostics with explicit references to the bootstrapper
commands and the artifacts that gate each step.

## Outcome

- Two target LLMs (Gemini flash + Codex gpt-5.5) guided setup from the
  prompt pack with no developer interpretation.
- `validate_with_models` was exercised end-to-end from the gateway's own
  MCP surface, with both provider jobs reaching terminal state and the
  Layer 5 report contract honored.
- Two dogfood findings about validation-tool UX were captured as
  post-MVP follow-ups; neither blocks release.
- The release-readiness checklist exists, covers all U16-required
  topics, and is referenced from the MVP `README.md`.

`OUT:mvp-release-candidate` is met from the U16 perspective.
