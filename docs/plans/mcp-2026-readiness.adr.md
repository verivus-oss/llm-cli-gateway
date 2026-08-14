# ADR: MCP 2026-07-28 readiness, not migration

Date: 2026-08-08
Status: **ACCEPTED**
Supersedes: the "Goal", "Non-goals" and "Proposed slicing" sections of
`mcp-2026-07-28-protocol-compatibility.spec.md`, which is now retitled
`mcp-2026-07-28-ground-truth.md` and demoted to evidence.

## Decision

**The gateway will not ship dual-era MCP support in this release train.** We will
instead carry out readiness work that keeps modern support reachable on short
notice, and we will not change production wire behaviour until a named client
requires it.

Readiness means three things, in this order:

1. Split the process-lifetime gateway runtime from request-lifetime MCP server
   construction. This is worth doing on v1 today and is the precondition for any
   v2 work later.
2. Introduce a protocol-neutral surface catalogue so the tool and resource
   surface is defined once and installed onto either SDK generation.
3. Add the v2 packages as devDependencies with executable harnesses in CI, so
   modern-era behaviour stays continuously verified without shipping it.

Nothing here changes what the gateway serves. The HTTP and stdio endpoints keep
speaking the 2025 era exactly as they do now.

## Context

Revision `2026-07-28` makes the MCP core stateless, adds `server/discover`,
replaces the standalone GET stream with `subscriptions/listen`, requires
`Mcp-Method` / `Mcp-Name` headers and `ttlMs` / `cacheScope` result fields, and
deprecates Roots, Sampling, Logging, HTTP+SSE and OAuth DCR under a twelve-month
minimum lifecycle policy. Full detail, all of it executed rather than read, is in
`mcp-2026-07-28-ground-truth.md`.

Three facts frame the decision.

**There is no deadline.** The deprecation policy guarantees a minimum
twelve-month window, so the earliest removal of a deprecated surface is the first
revision on or after 2027-07-28. Four of the six deprecations cost this gateway
nothing at all. The policy governs protocol features and does not promise that
new clients keep speaking a 2025 revision, so this is a readiness need rather
than an absence of one, but it is not an emergency.

**There is no demand.** Ten rounds of review established in detail how to
implement modern protocol mechanics. None established who needs them. The
clients that actually drive this gateway are 2025-shaped today, and the official
TypeScript client still defaults `versionNegotiation` to `'legacy'`. Building a
dual-era production surface now means paying most of the cost and all of the
risk in advance of any caller.

**The cost is an architecture programme, not a dependency bump.** It is a package
split and supply-chain event, conversion of 69 tool registrations, re-baselined
wire schemas, a new HTTP front door and request classifier, a new stdio serving
entry, cache policy across the whole dynamic surface, replacement of the issue
#130 session caps whose subject disappears, plus rollout, rollback, mixed-fleet
deployment and operations for two wire eras on one endpoint.

### The architectural finding that decides the sequencing

Ten rounds of defect-hunting never surfaced the thing that matters most. Both
independent systems reviewers found it immediately and separately.

Under v2, the HTTP serving entry invokes a **server factory per request**. The
gateway's factory is not a factory in that sense. `createGatewayServer` resolves
a runtime, can construct a `PersonalConfigManager`, can load the workspace
registry, installs cleanup observers, starts Personal Agent Config maintenance
when enabled, derives configuration-dependent surface availability, registers
every tool and dynamic resource, and replaces the server's close method. That was
a reasonable shape for one server per stdio connection or one per legacy HTTP
session. It is the wrong shape entirely for one per request.

This is a correctness and isolation problem, not the latency number the old
slicing asked us to measure:

- `tools/list` and `tools/call` can be built from different mutable configuration
  snapshots.
- Requests that never invoke a gateway tool, including malformed ones, still pay
  most of the construction cost, which makes authenticated denial of service
  cheap.
- Maintenance work is launched on construction and merely stopped on close, so
  the first run has already started.
- The obvious mitigation, caching and reusing one server, would violate the
  per-request era and identity assumptions the protocol now depends on.

Splitting process-lifetime state from request-lifetime protocol facade is
therefore the first slice under any strategy, including this one. It also pays
for itself immediately on v1, because HTTP session creation gets cheaper.

## Options considered

| Option | What it buys | What it costs |
|---|---|---|
| Ship dual-era now | Modern clients work on both transports | Maximum blast radius: couples a day-zero SDK major, 69 registrations, both transports, cache policy, capacity redesign, rollout and operations into one change, for no known caller |
| Wait passively | Nothing to do today | Knowledge rots; a client flip becomes a fire drill |
| **Readiness (chosen)** | Ground truth stays executable, architecture debt gets paid, modern is reachable on short notice | Small continuous cost; modern clients still unsupported until we decide otherwise |
| Modern HTTP canary | Real compatibility behind a gate | Still needs the full architecture work plus rollout, rollback and conformance, ahead of demand |

The canary option is the right *next* one if the reopen triggers fire. It is not
the right one now, and choosing it now would freeze whatever dual-era shape we
invent against a day-zero SDK major into production for the eleven months the
clock still has.

## Reopen triggers

Any one of these reopens the decision and promotes the canary option:

1. A named client we care about requires `2026-07-28`, with a date.
2. A release gate, security posture or hosting change forces the HTTP+SSE
   lineage or OAuth DCR off before the deprecation clock expires.
3. We reach roughly one release train from 2027-07-28 and still need to serve
   legacy clients.
4. An intermediate revision appears that changes the cost calculation.

Review date if none of these fire: **2027-02-01**.

## Consequences

Accepted:

- Modern-only clients cannot use this gateway. That is a deliberate, dated
  choice, not an oversight, and it should be stated in the compatibility
  documentation rather than left implicit.
- We carry the v2 packages as devDependencies and owe them the same upgrade
  discipline as the upstream CLI contracts: pinned, probed, harnessed in CI.
- The readiness work touches `createGatewayServer`, which is exported at the
  public `./gateway-server` subpath. Any signature change there is a public API
  change and needs its own versioning decision even though no wire behaviour
  moves.

Deliberately not done, and not to be reintroduced without reopening this ADR:

- Modern stdio.
- `subscriptions/listen` in any form beyond a recorded position.
- Tasks, MRTR, CIMD migration, MCP Logging, Roots, Sampling, elicitation.
- Replacing OAuth DCR.
- Per-resource TTL optimisation. If cache fields are ever emitted, the
  compatibility-safe default is `ttlMs: 0` with `cacheScope: "private"`, and any
  public scope needs a separate privacy review.
- Converting the legacy HTTP path from sessionful to stateless.
- Removing v1.
- Any further adversarial review round aimed at residual-list completeness.

## Provenance

This ADR replaces a ten-round review programme that was structurally unable to
terminate. Each round asked reviewers for "unconditional approval or one concrete
blocker", which optimises for precision against a fixed target and cannot return
"the strategy does not converge", because that is not a file:line defect.

The decision rests on four independent systems reviews commissioned on
2026-08-07 (two seats each on this document and on the supply-chain assessment)
which were explicitly told that concluding the plan should be restructured, cut
or abandoned was a preferred answer over another verified defect. Both spec seats
independently recommended staged readiness over migration, and both independently
identified the per-request factory problem described above.

The ten rounds were not wasted. They produced ground truth that is executed
rather than read, and that survives this decision intact. They were simply asked
the wrong question.
