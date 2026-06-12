# Agent-Assurance Runtime Conformance

Status: planning checklist, implementation pending.

This document tracks the RUNTIME-SPEC obligations that `llm-cli-gateway` must
implement when it acts as the agent-assurance runtime control plane.

DAG-TOML SPEC-layer validators check structural conformance. They intentionally
do not perform runtime enforcement. The gateway must consume and emit conformant
kinds, run the published validators for SPEC-layer checks, then add the runtime
checks listed here at the orchestration and HostServices chokepoints.

## Principle

SPEC-layer validation stops at data shape and declared references. Runtime
conformance starts where the spec says validators must not act:

- hash verification;
- signature verification;
- chain monotonicity;
- adapter execution;
- runtime artifact verification;
- provider attribution;
- constraint re-evaluation;
- rollback execution;
- identity issuance and signing.

If runtime policy, identity, validators, or the ledger are unavailable, governed
actions fail closed.

## Conformance Checklist

| Source kind          | Runtime obligation                                 | Gateway implementation target                        | Status  |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------- | ------- |
| gate-decision        | Record provider attribution at decision time.      | `governance/gates.ts`, model registry                | Planned |
| gate-decision        | Verify `evidence_root` against sealed evidence.    | `governance/gates.ts`, `governance/ledger.ts`        | Planned |
| gate-decision        | Verify override signatures.                        | `governance/identity.ts`, `governance/breakglass.ts` | Planned |
| gate-decision        | Re-evaluate referenced constraints before verdict. | `governance/controller.ts`, validators               | Planned |
| gate-decision        | Enforce INV06 for self-modification gates.         | `governance/gates.ts`                                | Planned |
| adapter-contract     | Execute the adapter.                               | normalizer plus HostServices sandbox                 | Planned |
| adapter-contract     | Enforce hermeticity during adapter execution.      | HostServices, worktree sandbox                       | Planned |
| adapter-contract     | Verify runtime artifact digests.                   | `governance/dagtoml.ts`                              | Planned |
| adapter-contract     | Dereference fixtures.                              | `governance/dagtoml.ts`, validators                  | Planned |
| assertion-bundle     | Verify bundle hash against contents.               | `governance/gates.ts`                                | Planned |
| assertion-bundle     | Verify bundle origin from cited adapter.           | normalizer, adapter registry                         | Planned |
| assertion-log-record | Verify index monotonicity.                         | `governance/ledger.ts`                               | Planned |
| assertion-log-record | Verify previous hash and Merkle linkage.           | `governance/ledger.ts`                               | Planned |
| assertion-log-record | Verify signatures.                                 | `governance/identity.ts`, `governance/ledger.ts`     | Planned |
| assertion-log-record | Corroborate timestamps.                            | `governance/ledger.ts`                               | Planned |
| profile overview     | Issue identities, such as DIDs.                    | `governance/identity.ts`                             | Planned |
| profile overview     | Sign artifacts.                                    | `governance/identity.ts`                             | Planned |
| profile overview     | Execute rollbacks.                                 | `governance/controller.ts`, HostServices             | Planned |

## INV06 Requirements

For a self-modification gate-decision, the gateway must capture at least:

- proposing provider ID;
- proposing model family ID;
- proposing model ID;
- proposing gateway provider type;
- deciding provider ID;
- deciding model family ID;
- deciding model ID;
- deciding gateway provider type.

The gate passes the INV06 routing check only when:

```text
proposing.provider_id != deciding.provider_id
AND
proposing.model_family_id != deciding.model_family_id
```

If no eligible decider is available, the gate denies. A same-provider or
same-family fallback is not allowed for self-modification.

## Runtime Log Streams

The gateway already has a flight recorder for build/run request telemetry. Agent
assurance needs a second append-only stream:

- assertion-log-record stream for signed evidence and gate artifacts;
- policy-decision-log stream for allow, deny, break-glass, and rollback
  decisions.

Both streams must be append-only and tamper-evident. A detected chain break,
signature failure, index regression, or impossible timestamp transition is a
runtime stop condition for governed actions.

## Break-Glass

Break-glass is a human override path, not an agent self-approval path.

Minimum runtime requirements:

- out-of-band human authorization;
- bounded duration, initially no more than four hours;
- explicit scope of bypassed constraints;
- `BREAK_GLASS` ledger event;
- follow-up attestation, initially within twenty-four hours;
- no reuse after expiry.

Break-glass must not disable INV06 permanently. At most it can approve a
specific time-boxed action under ledgered human authority.

## SPEC-Layer Integration

The gateway should not duplicate the published structural validators. It should
provide an integration layer that can:

- invoke or embed the repository validators;
- invoke or embed the Go validator;
- pin validator version or digest in emitted evidence;
- fail closed on validator execution errors;
- keep gateway extensions in the spec-approved extension namespace.

Runtime checks happen after SPEC-layer conformance succeeds.

## First Slice Exit Criteria

The first governance slice is conformant enough to build on when it can:

- classify a self-modification task;
- capture proposer attribution;
- choose an INV06-compliant decider;
- run a validator-backed evidence pass;
- emit a gate-decision with a mechanical pass/fail verdict;
- append a signed ledger record;
- deny the task if policy, validator execution, decider selection, or ledger
  append fails.

This is intentionally narrower than the full checklist. It proves the core
product claim: cross-provider independent review becomes a mechanical runtime
guarantee rather than an instruction in a prompt.
