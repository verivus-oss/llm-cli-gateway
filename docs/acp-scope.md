# ACP Scope

Status: planning note, implementation pending.

This document captures the working scope for adding an Agent Communication
Protocol (ACP) layer to `llm-cli-gateway` while retaining MCP as the frontend
for existing clients. The goal is not to replace the gateway's current MCP tool
surface. The goal is to add an agent-host execution path, shared context, and a
runtime governance layer around the existing multi-provider conductor.

## Scope Statement

`llm-cli-gateway` becomes the runtime control plane for hosted agent work:

- MCP remains the public coordination frontend for current clients.
- ACP becomes the full-duplex agent transport for hosted agents.
- HostServices becomes the execution boundary for filesystem, terminal, and
  other side effects.
- A shared context hierarchy carries organization, project, task, and run
  intent into every provider request.
- Agent-assurance governance wraps the orchestrator and HostServices as a
  runtime chokepoint.

The gateway must stay a conductor and runtime. It must not redefine ACP,
DAG-TOML, agent-assurance kinds, or provider-specific upstream contracts.

## Decided Direction

### 1. Keep MCP

MCP remains the gateway's primary integration surface for local and remote
clients. Existing request tools, async jobs, sessions, validation tools,
readback, model listing, and upstream contract tools stay available through MCP.

ACP is additive. It gives hosted agents a richer bidirectional runtime channel,
but it does not remove MCP clients or force the existing tool schema through an
ACP-only abstraction.

### 2. Add An ACP Agent Host

The ACP layer hosts agents rather than acting as a thin proxy. A hosted agent
gets a run context, bounded capabilities, streaming updates, and a controlled
HostServices surface. ACP sessions should map onto gateway job/session
bookkeeping without requiring provider-native session IDs to become gateway
IDs.

Expected package shape:

```text
src/acp/
  client-driver.ts       # ACP and legacy driver boundary
  host-services.ts       # file, terminal, and environment side-effect surface
  protocol.ts            # ACP request/response/event types
  sessions.ts            # hosted-agent session mapping
  stream.ts              # full-duplex event plumbing
```

### 3. Retain Provider CLIs As Backends

Provider CLIs remain the execution backends. ACP does not bypass the existing
Claude, Codex, Gemini, Grok, Mistral, and Grok API routing logic. The ACP host
should call the same provider preparation, sandbox, session, worktree, retry,
circuit-breaker, and flight-recorder paths as MCP request tools wherever
possible.

The gateway already has the key advantage ACP needs: it can broker across
multiple independent model providers from one runtime.

### 4. Make Context Mandatory And Hierarchical

Context should be layered and non-relaxable from the top down:

- organization architecture and security rules;
- workspace and repository rules;
- task requirements and threat model;
- implementation DAG node context;
- provider-specific request details.

Lower layers can add detail, but they cannot weaken mandatory higher layers.
This context hierarchy becomes the input floor for both provider calls and
governance decisions.

### 5. Treat Governance As The Spine

Agent-assurance/DAG-TOML SPEC-layer validation deliberately stops at structural
data. The repeated contract is that SPEC-layer validation must not verify
hashes, signatures, chains, adapter execution, runtime artifacts, or provider
attribution. Those concerns are RUNTIME-SPEC.

The gateway is the runtime. Governance is therefore not documentation text or a
cosmetic post-process. It must wrap the actual chokepoints:

```text
MCP / ACP-agent frontend
  -> GovernanceController
       -> identity
       -> phase router
       -> policy engine
       -> ledger
       -> gate issuer
  -> Orchestrator run/fanOut
  -> ClientDriver + HostServices
```

Every run, fan-out, and HostServices side effect passes through governance.
Ledger or policy unavailability denies the action.

### 6. Make INV06 Mechanical

The decisive agent-assurance invariant for this gateway is INV06:

```text
A self-modification gate-decision MUST be decided by a model whose provider_id
AND model_family_id both differ from the proposer's.
```

That is a multi-provider broker requirement. The gateway can satisfy it by
construction because it routes across Anthropic, OpenAI, Google, xAI, and
Mistral providers. A self-modification gate is not complete unless the gateway
records proposer attribution, chooses a decider from a different provider and
model family, records decider attribution, and denies the gate if the inequality
cannot be satisfied.

## Runtime Governance Mapping

| Agent-assurance concept  | Gateway home                                   | Notes                                                                                                           |
| ------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Trust ladder             | HostServices and ClientDriver capability gates | INTERN begins read-only; higher trust unlocks writes, terminal, orchestration, and deploy capabilities.         |
| Phase gates              | async job lifecycle and readiness gates        | A task is a readiness gate backed by gate-decision artifacts. Implementation DAG nodes map to jobs.             |
| gate-decision            | validation fan-out and review tools            | Verdict is `pass` only when there are no failed constraints. Rationale is evidence, not an extra verdict field. |
| INV06                    | model registry and provider routing            | Cross-provider and cross-family decider selection is enforced before issuing self-modification decisions.       |
| adapter-contract         | update normalizer and validators               | The normalizer converts raw provider/tool output into assertion evidence.                                       |
| assertion-bundle         | validation output sealing                      | Evidence cohorts are hashed and tied to adapter version/digest.                                                 |
| assertion-log-record     | governance ledger                              | New append-only Merkle stream over durable storage.                                                             |
| Fail-closed              | GovernanceController default                   | Policy, ledger, identity, or validator unavailability denies governed actions.                                  |
| Break-glass              | MCP tool plus approval-manager                 | Human-only override, time-boxed, ledgered, followed by attestation.                                             |
| Deployment tiers         | config contract declaration                    | Tier config selects signer thresholds, witness requirements, and mirror behavior.                               |
| DID identity and signing | governance identity module                     | Per-agent identity signs assertion-log records and artifacts.                                                   |
| Mandatory context floors | context hierarchy                              | Organization/security context sets non-relaxable trust caps.                                                    |

## Self-Modification Gate Flow

When a hosted agent proposes a change to the gateway's own source, harness,
policies, validators, or governance runtime:

1. Governance classifies the subject as `self-modification`.
2. The proposer attribution is captured: provider ID, model family ID, model
   ID, and gateway provider type.
3. Evidence is produced through review, validation, smoke tests, or other
   configured gates.
4. Assertion bundles are sealed and linked to their adapter/runtime evidence.
5. A decider model is selected with both a different provider ID and different
   model family ID from the proposer.
6. The gate-decision is emitted with a mechanical verdict.
7. A signed assertion-log-record and policy-decision-log entry are appended.
8. The readiness gate flips only after the ledger write succeeds.

If any step cannot complete, the gate denies by default.

## Proposed Modules

```text
src/governance/
  controller.ts     # identity -> phase -> policy -> ledger -> gate chokepoint
  trust.ts          # trust ladder and capability sets
  gates.ts          # gate-decision issuance and INV06 routing
  ledger.ts         # append-only assertion and policy logs
  identity.ts       # agent DID/key material and artifact signing
  dagtoml.ts        # conformant kind IO and published validator integration
  breakglass.ts     # time-boxed human override and attestation
  tiers.ts          # deployment-tier contract loading
```

Governance should land after HostServices exists, because HostServices gives it
the side-effect chokepoints to guard. Existing validation fan-out can then be
retrofitted to emit gate-decisions and assertion bundles.

## Boundaries

- Do not reimplement SPEC-layer structural validation in the gateway. Invoke or
  embed the published validators and Go validator.
- Do not add ad-hoc fields to agent-assurance kinds. Gateway-specific metadata
  must use the spec extension model, such as profile metadata, `_meta`, or a
  gateway-owned namespace.
- Do not let skill text substitute for runtime enforcement. Governance belongs
  at run, fan-out, driver, and HostServices chokepoints.
- Do not treat legacy transport fallback as a policy fallback. LegacyDriver may
  keep compatibility, but it remains policy-gated.
- Do not store provider credentials, OAuth secrets, bearer tokens, or private
  key material in emitted governance artifacts.

## Open Implementation Questions

- Which local representation should bind MCP jobs, ACP sessions, implementation
  DAG nodes, and readiness gates without duplicating state?
- Which signing backend is acceptable for solo, group, and enterprise tiers?
- Which validator integration path is preferred: subprocess, embedded package,
  or both with parity tests?
- How should policy decisions reference flight-recorder rows without copying
  sensitive request/response content into the governance ledger?
- What is the minimum self-modification subject classifier for the first slice:
  source changes only, or source plus config, tests, CI, validators, and release
  scripts?
