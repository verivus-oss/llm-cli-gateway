# ACP provider transport feasibility

Date: 2026-06-12.
Status: initial research task and evidence report.

## Scope

This report scopes ACP for `llm-cli-gateway` provider CLIs. The user phrase was
"Agent Communication Protocol", but the coding-agent CLI/editor ecosystem uses
ACP to mean **Agent Client Protocol**: a client/editor to coding-agent protocol,
commonly JSON-RPC over stdio for local agents. Agent-to-agent "Agent
Communication Protocol" is not the target for this task unless a provider CLI
explicitly documents that meaning.

The corresponding research DAG is
`docs/plans/acp-provider-transport-research.dag.toml`.

## Initial conclusion

ACP is worth researching, but implementation must be staged and evidence-gated.
At the current target versions, Mistral Vibe has a confirmed local native ACP
entrypoint (`vibe-acp`), and Grok has a local `grok agent stdio` transport
candidate that still needs a JSON-RPC/ACP handshake probe. Claude and Codex
appear to have adapter-mediated ACP paths in the broader ACP ecosystem. Legacy
Gemini CLI has ACP evidence, but the gateway target is Google Antigravity
`agy`, whose installed help does not expose `--acp`.

The first safe implementation slice should be capability/contract/reporting
only, followed by a read-only ACP smoke harness. Write-capable ACP sessions
should wait for HostServices and governance chokepoints.

## Local evidence

Target versions come from `llm-cli-gateway doctor --json` and
`docs/upstream/release-targets.md`:

| Provider           | Target CLI       | Local ACP evidence                                                         | Initial status             |
| ------------------ | ---------------- | -------------------------------------------------------------------------- | -------------------------- |
| Claude Code        | `claude` 2.1.175 | `claude --help` shows MCP-related flags/subcommands, not native ACP.       | adapter-mediated candidate |
| Codex CLI          | `codex` 0.139.0  | `codex --help` shows MCP server/app/exec-server surfaces, not native ACP.  | adapter-mediated candidate |
| Gemini/Antigravity | `agy` 1.0.7      | `agy --help` has no `--acp`; gateway test rejects `--acp` for Antigravity. | absent at target           |
| Grok CLI           | `grok` 0.2.50    | `grok agent stdio --help` exists and says it runs the agent over stdio.    | native candidate           |
| Mistral Vibe       | `vibe` 2.14.1    | `vibe-acp --version` reports 2.14.1; `vibe-acp --help` says ACP mode.      | native candidate           |

Important false-positive guardrails:

- MCP server mode is not ACP.
- Provider session resume is not ACP.
- Legacy Gemini CLI support does not imply Antigravity `agy` support.
- Zed/third-party adapters are adapter-mediated support, not native provider
  CLI support.

## External source baseline

Primary or near-primary sources to carry into the research task:

- Agent Client Protocol docs and registry: `https://agentclientprotocol.com/`.
- ACP agent registry lists Claude Agent via Zed's SDK adapter, Codex CLI via
  Zed's adapter, Gemini CLI, and Mistral Vibe.
- ACP repository: `https://github.com/agentclientprotocol/agent-client-protocol`.
- Codex adapter: `https://github.com/zed-industries/codex-acp`.
- Claude Agent adapter: `https://github.com/agentclientprotocol/claude-agent-acp`.
- Mistral Vibe install docs say the installer makes both `vibe` and `vibe-acp`
  available.
- Mistral Vibe ACP setup:
  `https://github.com/mistralai/mistral-vibe/blob/main/docs/acp-setup.md`.
- Legacy Gemini CLI ACP docs:
  `https://geminicli.com/docs/cli/acp-mode/`.
- Antigravity ACP absence is currently supported by local `agy --help` evidence
  plus community issue evidence; do not treat community issues as official
  support or official roadmap.

## Gateway architecture implications

ACP should be additive:

- MCP remains the inbound gateway API.
- Provider request tools remain prompt execution surfaces.
- ACP support should be represented as provider capability metadata before any
  runtime behavior changes.
- Upstream contracts should track ACP entrypoints and safe help probes
  separately from prompt request argv allowlists.
- A future `src/acp/` layer should act as a controlled client/host boundary, not
  a direct arbitrary subprocess tunnel.
- HostServices must mediate file, terminal, environment, and permission side
  effects before write-capable ACP sessions.
- Gateway sessions, provider-native sessions, and ACP sessions need explicit
  mapping; do not reuse provider-native or ACP IDs as gateway IDs without a
  typed mapping layer.

## Proposed implementation slices

1. Capability-only slice: add ACP status fields to `provider_tool_capabilities`
   and `provider-tools://*`.
2. Contract-only slice: add ACP entrypoint/help metadata and drift probes for
   `vibe-acp`, `grok agent stdio`, and future native/adapter entrypoints.
3. Read-only smoke harness: start an ACP process, run initialize/session probe,
   terminate, and assert no file writes.
4. HostServices slice: file/terminal/env/approval boundary.
5. Native pilots: Mistral Vibe `vibe-acp` first, then Grok `agent stdio` only
   after a safe JSON-RPC/ACP handshake confirms protocol shape.
6. Adapter pilots: Codex/Claude only after adapter versioning, provenance,
   licensing, auth, and maintenance responsibilities are accepted.
7. Watchlist: Antigravity stays prompt-tool only until native or maintained
   adapter evidence exists.

## Multi-LLM validation jobs

Dispatched through `llm-cli-gateway` on 2026-06-12:

| Role                             | Provider           | Correlation ID                                          | Job ID                                 | Status                        | Verdict                     |
| -------------------------------- | ------------------ | ------------------------------------------------------- | -------------------------------------- | ----------------------------- | --------------------------- |
| architecture and governance fit  | Claude             | `acp-research-claude-architecture-2026-06-12`           | `1c60ec34-fd8d-4b6f-b6d1-8057dd00bf01` | completed; readback truncated | inconclusive                |
| codebase and DAG mapping         | Codex              | `acp-research-codex-codebase-map-2026-06-12`            | `e2e71e35-4376-4596-b53f-cbe91f69c0f7` | completed                     | APPROVED                    |
| current provider/source evidence | Gemini/Antigravity | `acp-research-gemini-current-provider-facts-2026-06-12` | `6ca2d9c5-b135-421b-aeb3-5f533b42139f` | completed                     | APPROVED                    |
| adversarial false-positive check | Grok               | `acp-research-grok-independent-validation-2026-06-12`   | `10bdd70a-3214-416b-871a-dd1c0dcd9337` | completed                     | NOT APPROVED, broad framing |
| Vibe/vibe-acp validation         | Mistral Vibe       | `acp-research-mistral-vibe-validation-2026-06-12`       | `a5e02888-1ff2-4b05-b0aa-c19cec707344` | completed                     | APPROVED                    |

Material reviewer findings:

- Codex approved creating the research task and recommended a read-only DAG
  with terminology classification, safe provider evidence capture, code-surface
  mapping, transport risk review, and a redacted report.
- Gemini approved the task and reinforced that Agent Client Protocol is the
  relevant ACP meaning for coding-agent CLI/editor interoperability.
- Grok rejected the broad framing of "moving all eligible provider CLI agents"
  because it risks conflating MCP, native sessions, adapters, and ACP. This
  report and DAG therefore use a narrower evidence-gated framing: document
  native candidates, adapter-mediated candidates, absent surfaces, and required
  smoke probes before implementation.
- Mistral approved the Vibe-first research direction and confirmed the relevant
  protocol meaning is Agent Client Protocol. It emphasized that Vibe's
  `vibe-acp` is a separate stdio JSON-RPC entrypoint and that ACP support must
  not be assumed for other providers.
- Reviewer disagreement: Gemini identified Grok as native via `grok agent
stdio`; Mistral treated Grok as MCP-only. Local `grok agent stdio --help`
  confirms a stdio agent candidate exists, but this report requires a safe ACP
  initialize/session handshake before classifying it as supported.
- Claude completed but persisted readback was too large/truncated to extract a
  reliable final verdict, so it is recorded as inconclusive rather than used as
  approval evidence.

## Open questions

- Should the gateway be an ACP client to provider agents, expose ACP outward to
  editors, or support both as separate frontends?
- Which ACP methods are enough for a non-writing smoke harness?
- Can HostServices mediate provider-owned file edits if the ACP agent expects
  the client/editor to apply edits?
- How do ACP permission prompts map to the existing approval-manager?
- Which supply-chain policy applies to `codex-acp` and `claude-agent-acp` if
  adapter-mediated support is accepted?
- How should the gateway track native ACP version drift independently from
  normal provider prompt CLI drift?
