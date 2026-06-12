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
At the current target versions, Mistral Vibe and Grok Build both have external
native ACP evidence and passed a local manual JSON-RPC smoke for `initialize` and
`session/new`. Mistral exposes a local `vibe-acp` entrypoint; Grok exposes
`grok agent stdio`. Claude and Codex have adapter-mediated ACP paths in the
broader ACP ecosystem, not native provider CLI surfaces in the locally targeted
CLIs. Legacy Gemini CLI has ACP support, but the gateway target is Google
Antigravity `agy`, whose installed help does not expose `--acp`.

The first safe implementation slice should be capability/contract/reporting
only, followed by a read-only ACP smoke harness. Write-capable ACP sessions
should wait for HostServices and governance chokepoints.

## Local evidence

Target versions come from `llm-cli-gateway doctor --json` and
`docs/upstream/release-targets.md`:

| Provider           | Target CLI       | Local ACP evidence                                                         | Initial status                  |
| ------------------ | ---------------- | -------------------------------------------------------------------------- | ------------------------------- |
| Claude Code        | `claude` 2.1.175 | `claude --help` shows MCP-related flags/subcommands, not native ACP.       | adapter-mediated only           |
| Codex CLI          | `codex` 0.139.0  | `codex --help` shows MCP server/app/exec-server surfaces, not native ACP.  | adapter-mediated only           |
| Gemini/Antigravity | `agy` 1.0.7      | `agy --help` has no `--acp`; gateway test rejects `--acp` for Antigravity. | absent at target                |
| Grok CLI           | `grok` 0.2.50    | `grok agent stdio --help` exists and says it runs the agent over stdio.    | native, manual ACP smoke passed |
| Mistral Vibe       | `vibe` 2.14.1    | `vibe-acp --version` reports 2.14.1; `vibe-acp --help` says ACP mode.      | native, manual ACP smoke passed |

Important false-positive guardrails:

- MCP server mode is not ACP.
- Provider session resume is not ACP.
- Legacy Gemini CLI support does not imply Antigravity `agy` support.
- Zed/third-party adapters are adapter-mediated support, not native provider
  CLI support.

## External source baseline

Primary or near-primary sources to carry into the research task:

- Agent Client Protocol docs and registry: `https://agentclientprotocol.com/`.
- ACP protocol overview:
  `https://agentclientprotocol.com/protocol/overview`.
- ACP registry:
  `https://agentclientprotocol.com/get-started/registry`.
- ACP agent registry lists Claude Agent, Codex CLI, Gemini CLI, Grok Build, and
  Mistral Vibe. The registry description distinguishes adapter entries such as
  Codex CLI from native provider CLIs.
- ACP repository: `https://github.com/agentclientprotocol/agent-client-protocol`.
- Codex adapter: `https://github.com/zed-industries/codex-acp`.
- Claude Agent adapter: `https://github.com/agentclientprotocol/claude-agent-acp`.
- Claude Code CLI community adapters exist, but they do not prove native
  `claude` CLI ACP support.
- xAI Grok Build docs state that Grok can be used through ACP in other apps.
- xAI Grok Build docs: `https://docs.x.ai/build/overview`.
- Mistral Vibe docs state that Vibe implements ACP and is published in the ACP
  registry; install docs say the installer makes both `vibe` and `vibe-acp`
  available.
- Mistral Vibe install docs:
  `https://docs.mistral.ai/vibe/code/cli/install-setup`.
- Mistral Vibe surface comparison:
  `https://docs.mistral.ai/vibe/code/choose-cli-vscode-web-sessions`.
- Mistral Vibe ACP entrypoint:
  `https://github.com/mistralai/mistral-vibe/blob/5d2e01a6/vibe/acp/entrypoint.py`.
- Legacy Gemini CLI ACP docs:
  `https://geminicli.com/docs/cli/acp-mode/`.
- Google Gemini CLI ACP docs:
  `https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/acp-mode.md`.
- Google Antigravity CLI docs:
  `https://antigravity.google/docs/cli-using`.
- Antigravity ACP absence is supported by local `agy --help` evidence, gateway
  argv validation, and an open community feature request. A third-party
  `agy-acp` adapter exists, but it wraps `agy -p` and documents limitations such
  as no streaming and no effective cancel.
- Antigravity community feature request:
  `https://github.com/google-antigravity/antigravity-cli/issues/31`.
- Antigravity third-party adapter evidence:
  `https://github.com/openabdev/openab/pull/896`.

## Exa fact-check results

Exa was used on 2026-06-12 to check each external claim against official or
near-primary sources. Local installed-binary claims remain local evidence and are
not replaced by web sources.

| Claim                                                                                                   | Source class                                                                 | Verdict                                         | Notes                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ACP means Agent Client Protocol for this CLI/editor integration work.                                   | Official ACP protocol docs.                                                  | Confirmed.                                      | ACP docs describe client/agent methods, notifications, JSON-RPC 2.0, `initialize`, `session/new`, `session/load`, `session/prompt`, `session/update`, and `session/cancel`.    |
| ACP is not the same as MCP server mode or provider-native resume.                                       | Official ACP protocol docs plus local CLI help.                              | Confirmed.                                      | ACP has its own client/agent session lifecycle and optional client file/terminal services. MCP can be nested inside ACP initialization, but MCP mode alone is not ACP.         |
| Mistral Vibe has native ACP support.                                                                    | Official Mistral docs, Mistral repo, ACP registry.                           | Confirmed.                                      | Mistral docs state Vibe implements ACP and is in the registry. Install docs expose `vibe-acp`; repository entrypoint says "Run Mistral Vibe in ACP mode."                      |
| Grok Build has native ACP support.                                                                      | Official xAI docs, ACP registry, local `grok agent stdio --help`.            | Confirmed externally, not yet gateway-verified. | xAI docs say Grok Build can be used through ACP in other apps. The gateway still needs its own safe initialize/session smoke test against target `grok` 0.2.50.                |
| Codex has ACP support through an adapter, not native `codex --acp` in our target.                       | ACP registry, Zed `codex-acp` README, local `codex --help`.                  | Confirmed.                                      | Zed's adapter implements ACP around Codex CLI. Our local `codex` target exposes MCP/app-server surfaces, not a native ACP flag.                                                |
| Claude has ACP support through the Claude Agent SDK adapter, not native `claude` CLI ACP in our target. | ACP registry, `agentclientprotocol/claude-agent-acp`, local `claude --help`. | Confirmed with wording correction.              | The registry-backed adapter is for Claude Agent SDK. Separate community Claude Code CLI adapters exist, but they remain adapter-mediated and require provenance review.        |
| Legacy Gemini CLI supports ACP.                                                                         | Google Gemini CLI docs/repo and ACP registry.                                | Confirmed.                                      | Gemini CLI docs describe `gemini --acp` using JSON-RPC over stdio.                                                                                                             |
| Antigravity `agy` target supports native ACP.                                                           | Google Antigravity docs/repo, community issue/adapter, local `agy --help`.   | Not confirmed; current evidence says absent.    | Official Antigravity CLI docs found by Exa do not document ACP. An open issue requests ACP support, and a third-party `agy-acp` adapter wraps `agy -p` with reduced semantics. |

Fact-check corrections applied:

- Grok moved from "local native candidate" to "externally confirmed native
  candidate, pending gateway smoke verification."
- Claude wording now separates the ACP registry's Claude Agent SDK adapter from
  the gateway's target `claude` CLI.
- Antigravity wording now distinguishes official absence from community feature
  requests and third-party adapters.
- The registry list now includes Grok Build and explicitly labels adapter versus
  native interpretations.

## Local ACP smoke validation

Manual local smoke probes were run on 2026-06-12 against the installed target
CLIs. The probe sent newline-delimited JSON-RPC over stdio with:

1. `initialize` using protocol version 1, no file read/write capability, no
   terminal capability, and a gateway smoke-test client identity.
2. `session/new` with a temporary empty working directory and an empty
   `mcpServers` list.
3. No `session/prompt`, tool execution, file operations, terminal operations, or
   write-capable client services.

| Provider           | Command            | Result                                             | Observed response                                                                                                                                                                                               |
| ------------------ | ------------------ | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mistral Vibe       | `vibe-acp`         | Passed `initialize` and `session/new`.             | `agentInfo.name` was `@mistralai/mistral-vibe`, `agentInfo.version` was `2.14.1`, `protocolVersion` was `1`, `loadSession` was `true`, embedded context was supported, and `session/new` returned a session ID. |
| Grok Build         | `grok agent stdio` | Passed `initialize` and `session/new`.             | `protocolVersion` was `1`, `agentVersion` metadata was `0.2.50`, `loadSession` was `true`, embedded context was supported, HTTP/SSE MCP capabilities were advertised, and `session/new` returned a session ID.  |
| Google Antigravity | `agy --help`       | Native ACP still absent.                           | Help exposes `--print`, `--prompt-interactive`, `--continue`, `--conversation`, sandbox and plugin surfaces, but no `--acp` flag or ACP subcommand.                                                             |
| Codex CLI          | `codex --help`     | Native ACP still absent at the target CLI surface. | Help exposes `mcp-server`, `app-server`, `remote-control`, and `exec-server`; ACP remains adapter-mediated.                                                                                                     |
| Claude Code        | `claude --help`    | Native ACP still absent at the target CLI surface. | Help exposes print/stream formats and MCP configuration, but no native ACP mode.                                                                                                                                |

Validation caveats:

- The smoke validates provider-level ACP process shape, not gateway integration.
  The gateway still needs an automated harness that owns process lifecycle,
  timeouts, HostServices capability negotiation, and stderr/stdout isolation.
- `grok agent stdio` could not be smoke-tested under a fully empty environment on
  this machine because the installed Grok configuration expects managed
  credential lookup. The successful smoke used the normal user Grok
  configuration, an empty temporary cwd, and an isolated leader socket.
- `vibe-acp` could not be smoke-tested with a synthetic `HOME` because the
  installed launcher resolves its Python package from the normal user-scope
  environment. The successful smoke used normal user Python/uv paths and an empty
  temporary cwd.
- This smoke intentionally did not prove write safety, prompt-turn behavior,
  permission callbacks, terminal mediation, file edit mediation, cost/usage
  extraction, or session cleanup semantics.

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
5. Native pilots: Mistral Vibe `vibe-acp` first, then Grok `agent stdio`; both
   now have manual `initialize`/`session/new` smoke evidence, but both still need
   an automated gateway-owned harness before runtime support.
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
- Reviewer disagreement: Gemini identified Grok as native via
  `grok agent stdio`; Mistral treated Grok as MCP-only. Exa fact-checking found
  official xAI documentation for Grok Build ACP support, and a manual local ACP
  smoke confirmed `initialize` plus `session/new` against target `grok` 0.2.50.
  The remaining gap is automated gateway harnessing, not external ACP support
  evidence.
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
