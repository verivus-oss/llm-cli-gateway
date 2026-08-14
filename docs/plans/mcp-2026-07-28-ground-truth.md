# MCP protocol revision 2026-07-28: verified ground truth

Date: 2026-08-05. Restructured 2026-08-08.

## Status

**Evidence, not a plan.** This document records what is true about the gateway
and about MCP SDK v2, established by execution rather than by reading. It
prescribes no work.

The decision about what to do with it lives in
[`mcp-2026-readiness.adr.md`](./mcp-2026-readiness.adr.md): readiness, not
migration, with no production wire change in this release train. This file was
previously `mcp-2026-07-28-protocol-compatibility.spec.md` and carried a goal, a
non-goals list and an S0..S6 slicing. All three are superseded by that ADR and
have been removed rather than left to rot.

Every code claim was verified against the working tree at
`fix/pre-3.1.0-workingdir-and-skill-coverage` HEAD `39cca5a` (version
`3.1.0-rc.2`), clean tree, unchanged across all ten review rounds. Line anchors
are from that commit and will drift.

### How to read this

The ground truth here is unusually well tested, because ten rounds of adversarial
review attacked it and repeatedly won. Two habits are worth carrying forward, and
both were learned the expensive way:

- **Registration is not reachability.** A handler registered on a v2 server still
  answers `-32601` until a serving entry binds the protocol era. A static check
  that a route exists proves nothing about whether it is served. One reviewer
  finding accepted on registration evidence was false and cost three revisions.
- **A failed reproduction is evidence about your probe until the probe is proven
  sound.** Use a positive control. In round 8 it took three broken probes to
  reproduce a true finding, and each failure looked like a refutation.

Appendix C retains the full review history, including the records that were
themselves wrong.

## Background

MCP specification revision `2026-07-28` was released on 28 July 2026, superseding
`2025-11-25`. It is the largest revision since launch. The changes that matter to
this repository are, from the official changelog:

1. The core becomes stateless. `initialize` / `notifications/initialized` and the
   `Mcp-Session-Id` header are removed. Every request carries its protocol
   version and client capabilities in `_meta`.
2. Servers MUST implement a `server/discover` RPC.
3. The standalone HTTP GET stream and `resources/subscribe` / `unsubscribe` are
   replaced by a single long-lived `subscriptions/listen` POST-response stream.
4. `ping`, `logging/setLevel`, and `notifications/roots/list_changed` are removed.
5. Server-initiated requests (`roots/list`, `sampling/createMessage`,
   `elicitation/create`) are replaced by Multi Round-Trip Requests (MRTR). All
   results carry a required `resultType`.
6. SSE stream resumability and message redelivery (`Last-Event-ID`) are removed.
   A broken stream loses the in-flight request; the client MUST re-issue it with
   a new request ID.
7. Streamable HTTP POSTs require `Mcp-Method` and `Mcp-Name` headers.
8. List and read results require `ttlMs` and `cacheScope`; `tools/list` SHOULD be
   deterministically ordered.
9. Roots, Sampling, Logging, HTTP+SSE, `includeContext` values, and OAuth DCR are
   Deprecated under a new lifecycle policy with a minimum twelve-month window,
   so earliest removal is the first revision on or after 28 July 2027.

## Verified ground truth

This section exists so the design document and its reviewers do not have to
re-derive the starting position. Each claim is anchored.

### The gateway is entirely 2025-era

`package.json` depends on `@modelcontextprotocol/sdk@^1.29.0`. The v1 line cannot
speak `2026-07-28` at all. The v2 packages are published on npm at `2.0.0`:
`@modelcontextprotocol/server`, `@modelcontextprotocol/client`, and
`@modelcontextprotocol/node` (verified against the registry 2026-08-05; latest
v1 SDK is `1.30.0`). This is therefore a package-split migration, not a bump.

Import sites are narrow: `src/index.ts:3-4` (`McpServer`, `ResourceTemplate`,
`StdioServerTransport`), `src/http-transport.ts:3-5` (`McpServer`,
`StreamableHTTPServerTransport`, `isInitializeRequest`), plus type-only imports
in `src/validation-tools.ts:3` and `src/provider-admin-tools.ts:36`.

### Four of the six deprecations cost nothing, and which four matters

The four that are free are **Roots, Sampling, MCP-protocol Logging, and the
`includeContext` values**, because none is used. The other two are **not** free:
HTTP+SSE lineage touches the live transport, and OAuth DCR is implemented.
Rev 2 stated the count without naming the members, which invited the reader to
assume the wrong four.

There is no use of Roots, Sampling, MCP-protocol Logging, elicitation, or
`resources/subscribe` anywhere in `src/`. Greps for `sampling` match only
provider API parameters (`src/index.ts:10045` nucleus sampling `top_p`;
`src/provider-tool-capabilities.ts:1187` and `:1607` capability descriptors),
which are unrelated to MCP Sampling.

`notifications/progress` (`src/index.ts:21515`) is request-scoped and survives
the revision itself, but **it constrains an SDK option**: v2's
`responseMode: 'json'` drops mid-call notifications. `llm_job_watch` depends on
progress arriving during the call, so the design must not select `json` response
mode without either losing that behaviour or moving it. This was missed in rev 2
and is recorded as a hard constraint rather than an open question.

### The standalone GET SSE stream IS served on the sessionful path

Rev 1 claimed this stream was never served, citing
`src/http-transport.ts:440-447`. That was wrong and the error is instructive:
those lines are only reachable when there is **no** `mcp-session-id`. The
sessionful branch at `:418-437` returns first, and
`const body = req.method === "POST" ? await readBody(req) : undefined` (`:424`)
deliberately passes `undefined` for GET before calling
`entry.transport.handleRequest(req, res, body)` (`:431-433`).

The chain from there is live:

- `StreamableHTTPServerTransport` is a thin wrapper that delegates to
  `WebStandardStreamableHTTPServerTransport.handleRequest`
  (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js:10,52,128-136`).
- That handler routes GET to `handleGetRequest`
  (`webStandardStreamableHttp.js:152`, defined at `:184`), which opens
  `Content-Type: text/event-stream` (`:228`) under
  `_standaloneSseStreamId = '_GET_stream'` (`:62`).
- The official `StreamableHTTPClientTransport` opens that GET **after the server
  returns 202 to `notifications/initialized`**, not on connect:
  `start()` (`client/streamableHttp.js:256-261`) only creates an
  `AbortController`, and the SSE stream is opened from the 202 branch of `send()`
  at `:371-377` guarded by `isInitializedNotification(message)`. `Client.connect`
  sends `initialize` then `notifications/initialized`
  (`client/index.js:293-316`), which is what triggers it. Line `:56` is the
  post-auth `_authThenStart` path, not connect. The client treats a 405 as
  "server does not offer an SSE stream at GET endpoint" (`:100`).

  The timing matters here rather than being pedantry: by the time the GET is
  issued the client already holds an `mcp-session-id` from the initialize
  response, so the GET lands on the live sessionful branch. A claim that it opens
  "on connect" would imply a pre-session GET, which this gateway answers with 405
  (`src/http-transport.ts:440-443`), and would undercut the corrected finding
  that sessionful GET SSE is genuinely in use.

`src/__tests__/http-transport.test.ts` drives that real client, so the path is
exercised today.

Corrected position: **sessionless GET returns 405; sessionful GET is the 2025
standalone SSE endpoint and is in use.** Removing it is therefore not free. The
design document must decide explicitly whether the legacy branch keeps GET SSE
(it comes for free from the SDK's 2025 path) or deliberately drops it, and must
address the interaction with the idle reaper: a long-lived GET stream holds the
session open, and the `inFlight` accounting at `:203-206` / `:428-436` was
written for request/response, not for a stream that stays open indefinitely.

Adding `subscriptions/listen` on the modern path remains optional, because the
gateway emits no list-changed or resource-subscription notifications of its own.
That part of rev 1 stands.

**But "optional" does not mean "absent", corrected in rev 11.** `createMcpHandler`
serves `subscriptions/listen` itself, from a server that declares no subscription
capability and implements nothing. Executed against 2.0.0:

```
POST subscriptions/listen, no notifications filter -> 200, -32602 "'notifications' is required"
POST subscriptions/listen, valid filter            -> 200, text/event-stream,
                                                      notifications/subscriptions/acknowledged
                                                      _meta: { subscriptionId: 1 }
```

Note the first line: the method answers `-32602` (bad params), not `-32601`
(method not found). It is served, and it is reachable the moment S3 adopts the
mandated handler. Choosing not to implement it does not make it absent.

### Principal isolation does not depend on protocol sessions

`src/http-transport.ts:389-396` derives the ownership principal per request from
the OAuth client id or, behind a trusted front door, the asserted user identity
header. It never reads `mcp-session-id`. `resolveTrustedPrincipal`
(`src/auth.ts:171-183`) reads the front-door header only under `gateway_bearer`,
and `resolveOwnerPrincipal` (`src/request-context.ts:35-39`) resolves
`authPrincipal` / `gateway_bearer` / `"local"`. Job, session, and resource
isolation key on `ownerPrincipal` and `principalCanAccess`. `SessionEntry` has no
principal field. The 2.9.0 principal-isolation fix therefore survives the removal
of protocol sessions untouched.

**Known gap, surfaced in round-1 review and NOT introduced by this migration:**
the MCP transport session is itself not principal-bound. `sessions.get(...)` at
`:419` performs a bare map lookup, so any authenticated caller who knows a live
session UUID can address that transport. Today this rests on the UUID being
unguessable, which is practical safety rather than authorization. This is
orthogonal to the migration (statelessness removes the object entirely) but it
must not be described as if current code already enforces per-principal session
ownership.

### The HTTP transport is structurally sessionful

- `src/http-transport.ts:222-225`: `sessionIdGenerator: () => randomUUID()` plus
  `onsessioninitialized`.
- `:404-423`: `mcp-session-id` header routing; unknown session is a 404.
- `:407-416`: `DELETE` session teardown.
- `:450-453`: `isInitializeRequest(body)` gate, rejecting a first request that is
  not `initialize`. Under a stateless client this rejects every request.
- `:249-259`: idle session reaper.
- `:455-481`: max-sessions capacity cap returning a retryable 429.
- `:203-206`, `:428-436`, `:499-501`: in-flight refcounting so the reaper cannot
  close a session mid-request.

All of that is issue #130 backpressure work built on the session model. The
`JobLimiter` (global, per-provider, queue) is job-scoped rather than
session-scoped and is unaffected.

### The per-connection factory already exists

`src/http-transport.ts:208-244` (`createSession`) calls
`options.createGatewayServer(options.deps)` to build one `McpServer` per session,
then connects it to a fresh transport.

**Rev 3 softens rev 2's wording here.** Having a zero-argument factory is a
genuine head start, and v2 accepts one. But the *lifecycle differs*: the gateway
builds one server **per session**, whereas `createMcpHandler` invokes the factory
**per request**. `createGatewayServer` is not cheap, since it performs the full
tool and resource registration, so per-request construction is a first-class
design cost that must be measured rather than assumed away. The correct claim is
"the factory signature transfers", not "the lifecycle transfers".

Request context is already threaded per request through
`runWithRequestContext(requestContext, ...)` at `:431-433` and `:494-496`, not
captured once per session.

### stdio and HTTP do not expose the same resource surface today

`src/index.ts:23861-23870` returns early for `transportMode === "http"`, so
`registerHealthResource(activeServer)` at `:23892` runs **only on the stdio
path**. The two transports therefore differ in their resource surface before this
migration begins. Any goal phrased as "the same surface over both transports"
must first establish what the canonical, configuration-aware inventory is, rather
than assuming parity exists to be preserved.

### An existing resource has no ownership check

`src/index.ts:4529-4553` registers `cache-state://session/{sessionId}` and passes
the URI-supplied `sessionId` straight to
`runtime.resourceProvider.readCacheStateSession` (`src/resources.ts:180-187`)
with no principal comparison. On the remote HTTP surface this discloses another
principal's cache statistics (token counts, hit/miss, CLI type, savings,
timestamps, and a `distinctPrefixCount`), though not prompt text and not the
stable-prefix hash strings themselves.

This is **pre-existing and not introduced by this migration**, and it is out of
scope to fix here. It is recorded because it bears directly on P5: this resource
must be `cacheScope: "private"`, and classifying it `public` would widen an
existing leak into a shared-intermediary one. It should be raised as its own
issue.

### Surface size

18 `server.registerResource` **call sites** in `src/index.ts` (`:4403` through
`:4766`, plus `:23183` and `:23208`). 69 tool registrations: 54 in
`src/index.ts`, 12 in `src/validation-tools.ts`, 3 in
`src/provider-admin-tools.ts`.

**Call sites are not runtime cardinality.** Several sites register inside loops
or expand through `generateResourceDescriptors()`, so the number of resources a
client actually sees is larger and scales with skills and providers. Any P5
effort estimate keyed on "18" is therefore an undercount, and the design must
size it from runtime descriptors rather than registration sites.

`src/gateway-server.ts` is a thin re-export of `createGatewayServer` from
`index.js`; the real bulk stays in `src/index.ts`.

## Two repository-specific constraints on any future migration

The gateway cannot serve any client that speaks `2026-07-28`, and cannot be made
to by upgrading a dependency. Meanwhile the 2025 era it does speak is now the
previous revision, and its transport (HTTP+SSE lineage aside) rests on a session
model the specification has removed.

Two repository-specific gates block the obvious migration path, and neither is
visible from the MCP documentation.

### Blocker 1: the shipped-fetch gate

`scripts/shipped-fetch-policy.mjs` implements the release invariant enforced by
`scripts/release-security-audit.sh:294-329`. It tests `/\bfetch\b/i` against
every line of every shipped `dist/**/*.js` and `dist/**/*.d.ts`, with an
exact-match allowlist pinned to three lines in `dist/personal-config.js`.

The v2 server entry point is fetch-shaped: `createMcpHandler` returns
`{ fetch, close, notify, bus }`, and Node hosting goes through `toNodeHandler`
from `@modelcontextprotocol/node`.

**Rev 2 overstated this as an inevitability; rev 3 corrects it to a contingency.**
The documented Node integration is `toNodeHandler(handler)`, not
`toNodeHandler(handler.fetch)`, so ordinary hosting need never write the token
in our own source. `isShippedDistSourcePath` requires
`normalizedPath.startsWith("dist/")`, so tokens inside the dependency are outside
the scanner's scope entirely.

The risk is therefore real but conditional, and it has two plausible escape
routes into `dist`:

- any call site that reaches for `handler.fetch` directly, which the in-process
  test pattern does use
- declaration emit, where an exported value typed as the handler can surface a
  structural `fetch` member in `dist/**/*.d.ts` even though the `.js` is clean.
  This is exactly the `.d.ts` escape the policy was widened to catch.

Consequence for the plan: **S1 is not an unconditional prerequisite.** S0 must
run an emitted-artifact spike (compile a minimal v2 handler and inspect the
generated `dist/*.js` and `dist/*.d.ts` for the token) and S1 is required only if
that artefact actually trips the scanner. If it does, the design must choose
among:

- widen the allowlist with new exact-match entries scoped to the transport file
- change the policy from exact-line matching to a reviewed per-file rule
- isolate the fetch-shaped surface so the token does not reach shipped `dist`
- accept the Socket alert and document it in the release checklist

This gate exists because of the Socket `networkAccess` heuristic, not merely as
internal hygiene. Widening it is a supply-chain posture decision that must be
made deliberately and reviewed, not an incidental allowlist edit.

### Blocker 2: in-memory wire tests would silently stop covering the wire

**This section was wrong in revs 4, 5 and 6, and the error originated in a review
finding I accepted without testing it. Rev 7 restores the substance of rev 3.**
The full account is in the round-6 record; the settled position follows, and every
line of it was executed against the published 2.0.0 packages.

**Three facts, each established by running code, not by reading exports.**

1. **A hand-wired `Server` + `InMemoryTransport.createLinkedPair()` cannot serve the
   modern era at all.** Registering the handler is not the same as making it
   reachable. With a modern revision in `supportedProtocolVersions`, the handler is
   installed and yet dispatch still refuses the method:

   ```
   handler registered: true
   server/discover -> {"code":-32601,"message":"Method not found"}
   ```

   Dispatch selects a wire codec from the negotiated protocol version. Until an era
   is bound, that is the legacy codec, and the legacy codec rejects modern methods
   before the installed handler is ever consulted. Force the era privately and the
   same request gets past dispatch, failing later and differently
   (`-32602`, missing `_meta` envelope), which confirms the mechanism.

2. **Era binding is owned by the serving entries, and only by them.**
   `setNegotiatedProtocolVersion` is called from exactly two places in the
   published package, inside `createMcpHandler` and inside `serveStdio`. It is not
   among the 89 public exports of `@modelcontextprotocol/server`, so there is no
   supported way to bind a hand-constructed instance. `InMemoryTransport` carries
   only `authInfo` and supplies no era classification of its own.

3. **In-memory modern testing is nevertheless possible, through a serving entry.**
   `serveStdio` accepts a bring-your-own transport, so it can be handed the server
   side of a linked in-memory pair and still own the era decision. Executed:

   | Harness | Outcome |
   |---|---|
   | hand-wired `Server` + linked pair, client `{ pin: '2026-07-28' }` | `ERA_NEGOTIATION_FAILED` |
   | `serveStdio(factory, { transport })` + client `{ pin: '2026-07-28' }` | **modern**, `tools/list` and `tools/call` both succeed |
   | same harness, client default | legacy, still works |

   The modern `server/discover` reply over that harness is a full modern result:
   `{"supportedVersions":["2026-07-28"],"resultType":"complete","ttlMs":0,"cacheScope":"private"}`.

**Both halves of the pair must opt in, and they opt in through different
mechanisms.** The server side is bound by the serving entry, per the above. The
*client* opts in via `ClientOptions.versionNegotiation`, whose default is
`'legacy'`, documented as "no negotiation: the plain 2025 connect sequence,
byte-identical to a client without this option". The runtime settles that half:

```js
const DEFAULT_VERSION_NEGOTIATION_MODE = "legacy";
function resolveVersionNegotiation(options, supportedProtocolVersionsOption) {
	const mode = options?.mode ?? DEFAULT_VERSION_NEGOTIATION_MODE;
	if (mode === "legacy") return { kind: "legacy" };
	...
```

The `legacy` early-return fires **before** `supportedProtocolVersionsOption` is
read at all, so on the default path that option is unread on the client.

**Settled position.** Modern-era coverage requires a **serving entry**
(`createMcpHandler` or `serveStdio`), not merely a modern-capable `Server`. It does
*not* require HTTP: `serveStdio` over an in-memory pair reaches the modern core
wire in-process.

**The residual fetch-only list, corrected in rev 8.** Revs 6 and 7 said the
remainder was `Mcp-Method` / `Mcp-Name` headers, `isLegacyRequest` routing, and
**cache-header emission over HTTP**. That last item does not exist. Executed
against 2.0.0 with `ttlMs: 60000` and `cacheScope: "public"` set on a `tools/call`
result:

```
responseMode=auto   headers {"content-type":"application/json"}   cache-control: (ABSENT)
responseMode=json   headers {"content-type":"application/json"}   cache-control: (ABSENT)
body: {"result":{...,"ttlMs":60000,"cacheScope":"public","resultType":"complete"}}
```

`ttlMs` and `cacheScope` are **body fields**, not HTTP cache headers, so P5 is
fully coverable by the in-memory harness. The only `Cache-Control` the package
emits is on SSE streams (`no-cache, no-transform`), which is stream hygiene and
not a P5 concern. This error was mine and it was avoidable: the discover output
quoted a few paragraphs above this line already showed `ttlMs` and `cacheScope`
sitting in the response body.

**The residual list is no longer hand-maintained, because hand-maintaining it
failed four rounds running (rev 7 wrong, rev 8 incomplete, rev 9 incomplete
again).** Rev 10 replaces it with the output of a systematic walk of the published
handler's request path, performed independently by both round-9 seats and
reproduced here. The rule for anyone editing this list: **derive it by walking
`createMcpHandler.handle` → `classifyEntryRequest` → `classifyInboundRequest` →
`serveModern` → validation → invocation, plus the legacy fallback, and state that
walk.** Do not add members one blocker at a time.

**The walk has two corrections from round 10, and they change its shape rather
than just its output.**

1. **It does not terminate uniformly at invocation.** `serveModern` routes
   `subscriptions/listen` straight to `listenRouter.serve`, bypassing invocation
   entirely. A walk that stops at "invocation" misses that branch by construction,
   which is one reason four rounds of enumeration kept coming up short.
2. **It must include the auth and request-context handoff.** The fetch path
   propagates `authInfo` and the HTTP `Request` into **both** the server factory
   and the per-request invocation context. Confirmed here: the factory receives
   `{ era, requestInfo }` carrying the request URL, and a tool handler receives
   `extra.http.req` carrying the same, with an authenticated principal visible at
   both points. Excluding external Host/Origin middleware from the walk is
   reasonable; excluding this handoff is not, because **principal derivation in
   this gateway is request-scoped and auth-derived**, making it the most
   security-relevant thing the fetch path does that the in-memory harness cannot
   exercise.

Everything below is decided by HTTP-level information (headers, method, status,
content negotiation, connection shape) rather than by the JSON-RPC body, so none
of it is reachable from the `serveStdio` in-memory harness:

- **HTTP method routing** and 405 responses
- **POST `Content-Type` enforcement**, 415
- **Raw-body read / JSON parse failures**, 400
- **`MCP-Protocol-Version` header cross-check.** Its own `-32020` outcome, not a
  consequence of era routing. Executed: header `2025-11-25` against a body
  envelope of `2026-07-28` gives `-32020` header/body disagreement; header
  `2026-07-28` with no body envelope gives `-32602` missing envelope keys
- **`Mcp-Method` validation.** Required for **every** modern JSON-RPC request, not
  only the two methods rev 9 named. Executed across `tools/list`, `prompts/list`,
  `resources/list`, `server/discover` and `completion/complete`: all return 200
  with the header and 400 / `-32020` without it. Notifications do not require it,
  though a supplied mismatch is still rejected
- **`Mcp-Name` validation**, mapping `tools/call → name`, `prompts/get → name`,
  `resources/read → uri`. That mapping is correct and exhaustive
- **`Mcp-Param-*` validation** for tools declaring `x-mcp-header` (see below)
- **Legacy `Accept` negotiation**, 406. Modern requests ignore `Accept`
- **Legacy versus modern routing** and dual-era front-door selection
- **JSON versus SSE response selection**: `responseMode`, notification-triggered
  SSE upgrade, and `subscriptions/listen` always using SSE
- **SSE framing headers**: `Content-Type`, `Cache-Control`, `Connection`,
  `X-Accel-Buffering`, keepalive and cancellation
- **HTTP status semantics**: 200 results, 202 notifications, the 4xx ladder,
  abort 499, internal failure 500
- **`Request.signal` connection teardown**

Detail on `Mcp-Param-*`, kept because its declaration rules are easy to get wrong:

A property carrying `"x-mcp-header": "<RFC 9110 token>"` must be mirrored in an
`Mcp-Param-<Token>` header. Executed, with a positive control proving the tool
does run when the header is correct:

| case | HTTP | code | tool ran |
|---|---|---|---|
| correct `Mcp-Param-Tenant` | 200 | none | **yes** |
| header absent | 400 | -32020 | no |
| header disagrees with body | 400 | -32020 | no |
| header value is invalid Base64 sentinel | 400 | -32020 | no |

The declaration constraints the package enforces: `x-mcp-header` must be a
non-empty RFC 9110 token **string** (not `true`), on a property whose type is in
`PERMITTED_X_MCP_HEADER_TYPES`, statically reachable through `properties` (not
under `items` or `additionalProperties`), and case-insensitively unique.

**That permitted-type set is `{string, integer, boolean, number}`, four types, not
three.** Rev 9 said three because it copied the list out of the package's *error
message*, which names only `string, integer, boolean`. The actual `Set` includes
`number`, and round 9 confirmed it end to end: a `number` property emitted
`Mcp-Param-Amount: 42.5` and the call returned 200. Reading the human-readable
error text instead of the data structure is the same substitution of convenient
evidence for actual evidence that this document keeps making.

Note also that an *invalid* declaration is client-filtered, and the server warns
and skips `Mcp-Param` validation rather than rejecting a direct call. So a
malformed `x-mcp-header` fails open on the server side, which is worth knowing
before relying on it for anything security-shaped.

Rev 3 was therefore right that the era is not reachable by hand-wiring, and wrong
only in naming `.fetch` as the sole route. The three suites below are legacy-only
because they hand-wire, which is exactly the construction that cannot be upgraded
in place.

Three suites use it today: `src/__tests__/lcr-resources-wire.test.ts`,
`src/__tests__/codex-fork-unavailable.test.ts`, and
`src/__tests__/grok-sync-content-wire.test.ts`. After a v2 migration these keep
passing green while covering only the legacy era. That is the same vacuous-pass
failure mode as `site:generate:check` verifying stale compiled output, and it is
exactly what the test-veracity audit protocol exists to catch.

`src/__tests__/http-transport.test.ts` uses a real
`StreamableHTTPClientTransport` and `src/__tests__/integration.test.ts` uses
`StdioClientTransport`, so those exercise a real wire and are less exposed.

## Constraints and invariants

These must survive the migration and should be stated as review criteria.

1. **Principal derivation stays request-scoped and auth-derived.** No code path
   may key ownership on a protocol session identifier, in either era.
2. **`persistence.backend = "none"` still means the async tools are not
   registered.** The structural invariant that makes silent in-memory loss
   impossible by construction is independent of transport and must remain so.
3. **Backpressure must retain an equivalent.** Under a stateless core the session
   cap and idle reaper lose their subject. The design must say what replaces the
   admission-control function they served, or argue that `JobLimiter` plus body
   limits already cover it. Silently dropping the 429 capacity signal is not
   acceptable.

   Sharpened after round-1 review: `createMcpHandler`'s default is
   `legacy: 'stateless'`, which serves 2025 traffic **statelessly**. Keeping the
   issue #130 session caps and reaper for legacy clients therefore requires an
   explicit sessionful legacy branch routed by `isLegacyRequest`, not the default
   factory. The design must state which of the two it takes, because the default
   silently drops the capacity mechanism for legacy clients as well as modern
   ones.
4. **No new network egress.** The migration must not introduce an actual outbound
   HTTP client into the shipped package. A fetch-shaped server handler is not
   egress, and the design must make that distinction explicit for the Socket
   review.
5. **Both eras answer the same tool and resource surface.** A tool visible to a
   2025 client must be visible, with identical schema, to a 2026 client.

   This is an era invariant, not a transport one. It deliberately does **not**
   claim stdio and HTTP expose the same surface, because they do not today (see
   the health-resource asymmetry above). Establishing or deliberately rejecting
   transport parity is design work, not a constraint inherited from the current
   code.

6. **`node:sqlite` stays confined to `src/sqlite-driver.ts`.**

7. **The legacy session entry's authorization posture must be decided, not
   inherited by accident.** If the design keeps a sessionful legacy branch, it
   must state whether the session entry is bound to its initializing principal.
   Today it is not, and a retained legacy path would carry that forward silently.

8. **`responseMode` must preserve mid-call `notifications/progress`.** See the
   note in the ground-truth section; `llm_job_watch` depends on it.

## Required protocol behaviours

Derived from the changelog; the design document must map each to an owner
(SDK-provided or gateway-implemented) and the tests that prove it.

| # | Behaviour | Likely owner |
|---|-----------|--------------|
| P1 | `server/discover` answers with supported versions, capabilities, identity | SDK v2 |
| P2 | Per-request `_meta` envelope parsed; version mismatch returns `UnsupportedProtocolVersionError` (`-32022`) | SDK v2 |
| P3 | Every result carries `resultType` | SDK v2 |
| P4 | `Mcp-Method` / `Mcp-Name` accepted and validated; `HeaderMismatch` is `-32020` | SDK v2, front door must pass through |
| P5 | `ttlMs` + `cacheScope` on all `tools/list`, `prompts/list`, `resources/list`, `resources/read`, `resources/templates/list` results | **gateway** |
| P6 | Deterministic `tools/list` ordering | **gateway**, needs a ratchet test |
| P7 | Resource-not-found returns `-32602`, not `-32002` | SDK v2, verify |
| P8 | No reliance on stream resumability; interrupted requests are safely re-issuable | **gateway**, see below |
| P9 | Dual-era serving from one endpoint | SDK v2 `legacy: 'stateless'` + `isLegacyRequest` |

P5 is the largest mechanical change: every runtime resource plus the list
surfaces, which is more than the 18 registration sites (see the cardinality note
above). The values are a policy decision, not a constant, and the design must
propose per-surface TTLs.

Rev 2 got one of these examples wrong and rev 3 corrects it. `sessions://` **is**
principal-filtered (`ownedSessions` / `principalCanAccess`). `metrics://performance`
is **not**: `src/resources.ts:591-596` serves a process-global
`this.performanceMetrics.snapshot()` with no principal filter, aggregating
counters across all callers and providers. It is volatile but global, so it is a
`cacheScope` question about staleness, not about tenancy. Do not use it as an
example of a caller-specific surface.

`cacheScope` must be `private` for anything principal-scoped. Getting it wrong is
a cross-principal disclosure through a shared intermediary, which makes it a
security-relevant field rather than a performance hint. Round-1 review found the
rev-1 inventory incomplete: it named only `sessions://` and `metrics://`. The
design must produce a complete per-resource classification, and at minimum also
cover `routing://decisions`, `routing://priors`, any flight-recorder-derived
surface, and any per-principal metrics. The default for an unclassified resource
must be `private`, so that omission fails safe.

P8 is largely already satisfied: sync requests auto-defer at 45s into the async
job machinery, and `llm_request_result` reads any persisted request back by
`correlationId`. That is the durable-handle pattern the revision pushes towards.
The design should document this as the answer to lost streams rather than build
anything new, and should identify any tool that is neither idempotent nor
handle-backed.

## Affected surfaces

Code:

- `src/http-transport.ts` (the rewrite; session machinery, routing, capacity)
- `src/index.ts` (stdio transport wiring at `:3-4`; 18 resource registrations;
  tool registration order)
- `src/gateway-server.ts` and `createGatewayServer` (factory shape)
- `src/validation-tools.ts`, `src/provider-admin-tools.ts` (type-only imports)
- `src/endpoint-exposure.ts`, `src/auth.ts`, `src/oauth.ts` (unchanged in intent;
  verify no session coupling)

Release and supply chain:

- `package.json`, `package-lock.json`, shrinkwrap generation
- `supply-chain/prod-closure.baseline.json`, `supply-chain/prod-closure.ledger.json`
- `scripts/shipped-fetch-policy.mjs`, `scripts/shipped-fetch-policy.test.mjs`,
  `scripts/supply-chain/dep-drift-scan.test.mjs` (the three that must move
  together)
- `scripts/release-security-audit.sh`
- `scripts/check-consumer-tree.mjs`

Tests:

- `src/__tests__/http-transport.test.ts`
- `src/__tests__/lcr-resources-wire.test.ts`
- `src/__tests__/codex-fork-unavailable.test.ts`
- `src/__tests__/grok-sync-content-wire.test.ts`
- `src/__tests__/integration.test.ts`
- `src/__tests__/skill-packaging.test.ts` (only if docs or skills move)

SDK-dependent scripts, added after round-1 review. These were missed in rev 1 and
matter because two of them sit inside release gates:

- `scripts/generate-site-discovery.mjs` builds the discovery artefacts by driving
  the live tool surface over `InMemoryTransport`
  (`:2-3`, `:344`). It carries **exactly the same legacy-only degradation risk**
  as the three test suites, and it feeds `npm run site:generate:check`. If it
  keeps using the 2025 in-memory path, the published discovery artefacts silently
  describe the legacy era.
- `scripts/verify-packed-skill-pack-e2e.mjs` and `scripts/smoke/persistence.mjs`
  drive v1 stdio clients.
- `scripts/verify-registry-install.sh`, `scripts/check-consumer-tree.mjs`,
  `scripts/check-consumer-tree.test.mjs`,
  `scripts/supply-chain/dep-drift-scan.test.mjs` reference the SDK package name
  and will need updating for the package split.

Docs and generated artefacts:

- `README.md`, `site/DISCOVERY.md` (note: the file lives under `site/`, not the
  repo root), `docs/guides/BEST_PRACTICES.md`
- `site/api` and `site/openapi.json` document the GET session stream explicitly,
  so a decision to drop legacy GET SSE is a published-contract change, not an
  internal one
- `site/` discovery artefacts regenerated by `npm run site:generate` (which reads
  `dist/`, so build first)
- `CHANGELOG.md`

Out of repo:

- the Entra front door and Cloudflare tunnel must pass `Mcp-Method` and
  `Mcp-Name` and must not assume sticky routing


## Appendix A: test plan (deferred, not scheduled)

The requirements below were written for a migration that is not happening in
this release train. They are retained because they are the executable
consequences of the ground truth above, and because the readiness harnesses in
the ADR are a subset of them. Nothing here is scheduled.


The design document must expand these into named tests. At minimum:

- a modern-era client reaches every registered tool and every registered resource
- a 2025-era client reaches the same surface through the same endpoint, and
  `isLegacyRequest` routes it
- tool listing order is byte-stable across two server constructions
- every list and read result carries `ttlMs` and `cacheScope`
- no principal-scoped resource is ever returned with `cacheScope: "public"`
- **a tool that emits `notifications/progress` mid-call still delivers both that
  notification and its terminal result under the `responseMode` S3 selects.**
  Added in rev 8. Without this, `responseMode: 'json'` passes every other test
  here while dropping progress, which breaks `llm_job_watch` (constraint 6)
- **every member of the fetch-only residual list above has a fetch-driven test,
  or an explicit written statement of why it does not apply to this gateway.**
  Added rev 10. An either-or acceptance criterion, deliberately: rev 9 told S3 to
  "explicitly scope out" `Mcp-Param-*` if no tool declares `x-mcp-header`, but put
  no matching criterion here, so the scope-out branch could be satisfied by
  silence. The gateway currently declares no `x-mcp-header`, which means that
  branch is the live one and the gap was real rather than theoretical. **Neither
  branch may be satisfied by omission.**
- **`MCP-Protocol-Version` header/body disagreement returns `-32020`, and a
  modern request with no body envelope returns `-32602`.** Added rev 10; these are
  distinct outcomes and neither is implied by era routing
- a request passing another principal's **provider** `sessionId` to a
  `*_request` tool still cannot resume it, in both eras (this is the 2.9.0 IDOR
  regression test; it is about provider sessions, not the MCP transport session,
  which is not principal-bound today either way)
- protocol version mismatch produces `-32022`, not a generic error
- resource-not-found produces `-32602`
- async job admission and `persistence.backend = "none"` tool non-registration
  are unchanged in both eras, and the gate is re-evaluated on every per-request
  server construction rather than captured once
- the shipped-fetch policy test covers whatever new allowlist or rule S1 chooses,
  and still fails closed on an unrelated `fetch` token
- a test that fails if a suite intended to exercise the modern era silently
  constructs a **legacy-era** pair. The trigger is the negotiated era, not the
  transport class: `InMemoryTransport` is legitimate for modern coverage
  **provided the server side goes through a serving entry**, per Blocker 2. Two
  constructions must fail this guard: a hand-wired `Server` on the pair (which
  cannot reach modern at all), and a client left on its `'legacy'` default. Note
  that a pinned client already fails loudly by itself, so this guard's real job is
  catching suites that never pinned
- a legacy client that opens the GET SSE stream still works through the dual-era
  endpoint, or, if the design drops it, fails with the 405 that the official
  client is documented to tolerate
- an open legacy GET SSE stream does not cause the idle reaper to close a session
  out from under it, and does not pin a session open forever


## Appendix B: open questions


1. Does the v2 `McpServer` API change tool and resource registration enough to
   touch all 69 registration sites, or is `registerTool` / `registerResource`
   source-compatible? This determines whether S3 is a transport change or a
   whole-surface change, and is the single largest unknown in the estimate.
2. Where do `ttlMs` values come from: per-registration literals, a central policy
   table keyed by URI scheme, or derived from the provider registry? A central
   table is more consistent with the DRY ratchet culture.
3. Does the legacy path keep its session cap and reaper while the modern path
   gets a different admission control, or does one mechanism cover both?
4. Is `@modelcontextprotocol/client` needed in production at all, or only in
   `devDependencies` for tests? The gateway is a server; the child CLIs are the
   MCP clients. This materially affects the prod closure.
5. Should stdio migrate in the same slice as HTTP, or later? `serveStdio` is a
   connection-pinned entry and stdio is the primary local surface, so a
   regression there is more visible than an HTTP one. Round-1 review flagged that
   rev 1 raised this question but then bagged stdio into S3 anyway, which is
   inconsistent. `src/index.ts` connects `StdioServerTransport` directly
   (around `:23894`), and a hand-constructed server keeps speaking 2025 no matter
   what the SDK version is, so stdio needs its own decision and its own slice
   boundary.
6. Does the legacy branch keep GET SSE? It is free from the SDK's 2025 path, but
   it interacts with the reaper and `inFlight` accounting. Dropping it is
   permitted by the official client's 405 handling but changes behaviour for any
   2025 client that relies on server-initiated messages.
7. What is the operational story for clients that still send `ping`, which the
   revision removes? Likely SDK-owned, but it needs a documented answer.


## Appendix C: review history (closed 2026-08-08)

Ten rounds of adversarial review, retained verbatim as a record of how each
ground-truth claim was established and of which reviewer findings were later
overturned. The review programme is closed; see the ADR for why. Do not treat
these records as evidence in their own right: round 3's record was confidently
wrong, and rev 3's round-2 record claimed a fix that had never been applied.


This spec needs its own cross-LLM review before the design document is written,
per the standing gate. Reviewers must inspect directly and not accept this
document's summary:

- `src/http-transport.ts` in full
- `src/index.ts` resource and tool registration regions
- `scripts/shipped-fetch-policy.mjs` and `scripts/release-security-audit.sh`
- the three `InMemoryTransport` suites
- the published `@modelcontextprotocol/server@2.0.0` types, not only the docs
- the official `2026-07-28` changelog and the TypeScript v2 migration guide

Reviewers should specifically try to falsify these claims, because the plan rests
on them:

1. principal isolation has no dependency on `mcp-session-id`
2. the gateway uses no Roots, Sampling, MCP Logging, elicitation, or
   `resources/subscribe`
3. the corrected GET SSE position: sessionless GET is 405, sessionful GET is the
   live 2025 standalone SSE endpoint
4. the runtime resource count is larger than the 18 registration sites, so P5 is
   sized from descriptors rather than call sites

#### Round-1 record

Kept so later rounds do not re-litigate settled ground.

**Grok and Codex independently returned the same blocker**: rev 1's claim that
the GET SSE stream was never served is false. Re-verified against the SDK before
rev 2 was written. Claims 1, 2, 5, 6, 8, and 9 were confirmed by both.

Findings folded into rev 2: the GET SSE correction and its consequences; MCP
transport sessions are not principal-bound; the `createMcpHandler` stateless
default versus the issue #130 session caps; runtime resource cardinality exceeds
registration-site count; the incomplete `cacheScope` inventory; stdio being
under-specified; the SDK-dependent scripts; the stdio-only health resource; the
`cache-state://session` ownership gap; and the `site/DISCOVERY.md` path.

**One reviewer finding was checked and rejected.** Codex reported 55
`server.tool(` sites in `src/index.ts`, making 70 tools. Counting exact
occurrences with `rg -o "server\.tool\(" src/index.ts | wc -l` returns **54**,
so the total is 69 and rev 1's figure stands. Recorded because a later round
should not silently "fix" this back.

Mistral was dispatched three times and returned exit 0 with a zero-byte response
each time, including with `workingDir` set. It did not act as a seat in round 1.
That is the known Vibe empty-success failure, not a review verdict, and must not
be counted as approval.

#### Round-2 record

Two distinct blockers, one per reviewer, both verified before acceptance.

**Grok:** rev 2 stated `sessions://` and `metrics://performance` are both
caller-specific. `src/resources.ts:591-596` returns a process-global
`performanceMetrics.snapshot()` with no principal filter. Corrected in rev 3.

**Codex:** rev 2 asserted the shipped-fetch gate *will* hard-fail on v2. The
documented Node integration is `toNodeHandler(handler)` rather than
`toNodeHandler(handler.fetch)`, and `isShippedDistSourcePath` only covers
`dist/`, so dependency tokens are out of scope. The failure is contingent, not
inevitable. Rev 3 reframes it and makes S1 conditional on an S0 emitted-artifact
spike.

Also folded into rev 3: the `createMcpHandler` per-request factory lifecycle
differs from the gateway's per-session one and `createGatewayServer` is not cheap
(Grok); `responseMode: 'json'` drops mid-call notifications and would break
`llm_job_watch` progress, now a hard constraint (Grok); S4 still said "all 18
resources", reintroducing the undercount its own ground truth had corrected
(Grok); no slice owned the SDK-dependent scripts, now S1b (both); the constraint
list was misnumbered 5, 7, 6 (Grok); "four of the six deprecations" never named
which four (Grok); and the `cache-state` disclosure wording overstated prefix hashes
(Grok).

**Correction to this record, made in rev 4.** Rev 3's version of this paragraph
also listed "on connect should be after `notifications/initialized`" as folded in.
It was not: the body still said "on connect" with the wrong line cites. Round 3
caught the discrepancy and returned it as a blocker. The record asserted a fix
that had never been applied, which is a worse failure than the wording error
itself, because a later reader would have trusted the record and skipped the
check. Treat every "folded in" line here as a claim to verify against the body,
not as evidence.

Round 2 confirmed, by inspection: the GET SSE rewrite is correct and complete
with no residual dead-stream reasoning anywhere in the document; all nine
round-1 findings are accurately recorded; principal derivation has no
`mcp-session-id` dependency; no prohibited MCP primitives; the shipped-fetch
scanner behaves as described; durable jobs and validation receipts assume no
stable MCP connection; and `src/acp/` has no MCP coupling.

#### Round-3 record

Two more blockers, one per reviewer, both verified before acceptance.

**Grok:** rev 3 still said the official client "opens that GET on connect
(`client/streamableHttp.js:56`, `:78-90`)". Verified false: `start()`
(`:256-261`) only creates an `AbortController`, and the SSE stream opens from the
202 branch of `send()` at `:371-377` under `isInitializedNotification`. Line `:56`
is the post-auth path. Corrected in rev 4, along with why the timing is
load-bearing rather than pedantic.

**Codex:** rev 3 claimed modern-era wire testing requires
`createMcpHandler().fetch`. Codex extracted and read the published v2 types and
falsified it: `InMemoryTransport.createLinkedPair()` is still exported for a
Client/Server pair, `supportedProtocolVersions` admits modern revisions, and
`server/discover` is installed on a hand-constructed server that opts into one.
In-memory covers the modern core wire; only transport-shaped concerns need the
fetch handler. Rev 4 rewrites Blocker 2 and splits S2 into two harnesses.

> **OVERTURNED IN ROUND 6.** Every factual statement in the paragraph above is
> true and the conclusion drawn from them is false. `server/discover` being
> *installed* does not make it *reachable*: dispatch refuses it with `-32601`
> until a serving entry binds the era. This record is kept unedited because the
> shape of the mistake matters more than the claim. It was accepted without
> executing anything, and three revisions were built on it.

Round 3 confirmed, by inspection: both round-2 corrections are accurate and not
over-corrected in either direction; the `responseMode`, factory-lifecycle, S1b,
named-deprecations, and constraint-numbering fixes all check out; tool counts
remain 54 + 12 + 3 = 69 with the round-1 "70" rejection still correct; and no
additional false ground truth was found beyond the two blockers above.

Grok noted it could not re-verify the external v2 package claims under its
read-only constraints. Codex could and did, which is why its blocker exists.
Future rounds should ensure at least one reviewer is able to inspect the
published v2 artefacts directly.

#### Round-4 record

**Both reviewers independently returned the same blocker**, and it was an
incomplete fold-in of rev 4's own round-3 fix. The Regression tests section still
required "a test that fails if a modern-era suite is accidentally constructed
against `InMemoryTransport`". That reasserts precisely the claim round 3
falsified, contradicts the corrected Blocker 2 four hundred lines earlier, and
would have banned the modern in-memory harness S2 is meant to build. Corrected in
rev 5: the guard triggers on the negotiated **era**, not the transport class.

Grok additionally found the S2 slicing bullet still described a single harness
while Blocker 2 described two. Rev 5 rewrites S2 to name both and state what each
covers.

The lesson repeats the round-3 one in a new place. Round 3 was a record that
disagreed with the body; round 4 was a body that disagreed with itself, because a
correction was applied at its origin but not to the requirement derived from it.
**When a ground-truth claim is corrected, grep the whole document for everything
derived from it.**

Round 4 confirmed, by systematic record-versus-body audit performed by both
reviewers: every round-1 and round-2 fold-in is genuinely present in the body,
including the ten from round 1 and the nine from round 2, each checked
individually. Only the round-3 fold-in was incomplete. Both reviewers also
re-verified the GET SSE timing chain and the tool counts (54 + 12 + 3 = 69), and
neither reinstated the rejected finding.

This round Grok was able to inspect the published v2 tarballs via `npm pack`
without a project install, so both seats verified the external claims
independently. Grok additionally confirmed a detail worth keeping: `server/discover`
is installed only when modern versions are opted into via
`supportedProtocolVersions`, and the default list is still legacy-only. **That
detail is true and it is only the server half; round 5 found the client half was
missing.** See the round-5 record.

#### Round 5, rev 5 reviewed, one blocker

Split verdict. Grok gave unconditional approval after a full-document sweep for
residual consequences of both round-3 corrections and found none. Codex found the
one thing the sweep missed, and it was in the passage the sweep had just blessed.

**Codex's blocker, confirmed:** S2's in-memory modern harness specified only
`supportedProtocolVersions`. That is the server-side opt-in. The v2 client
defaults `versionNegotiation` to `'legacy'`, so the linked pair would negotiate
the 2025 era regardless. Verified directly against
`@modelcontextprotocol/client@2.0.0`: the type declaration carries
`@default 'legacy'`, and `resolveVersionNegotiation` early-returns
`{ kind: "legacy" }` before ever reading `supportedProtocolVersionsOption`.
Folded into Blocker 2 and S2, with `{ pin }` preferred over `'auto'` because
`'auto'` falls back to the legacy handshake.

**Why the two seats split, and why it is the interesting part of this round.**
Both reviewers inspected the published v2 packages. Grok verified the server side
(`server/discover` installs when modern versions are opted in) and generalised
from it; Codex checked the client side separately and found it governed by a
different option with a legacy default. Grok's evidence was real and its
conclusion did not follow from it. The approval was not careless, it was
half-scoped: for a two-sided handshake, verifying one side proves nothing about
the negotiated era.

**The round-4 lesson recurred in a new form.** Rounds 3 and 4 failed by applying a
correction at its origin but not to everything derived from it. Round 5 failed by
carrying forward a *true* fact whose scope was narrower than the use made of it.
The generalised rule for round 6: when a claim is inherited from a prior round,
re-check what it actually establishes, not just whether it is true. A verified
fact used one inference too far reads exactly like a verified fact.

Codex named only S2 as the site. The same unstated assumption was also present in
Blocker 2's corrected position, which is where S2 inherited it; both were fixed.
Applying a reviewer's blocker only at the line the reviewer cited is the round-3
failure mode, so the whole document was re-grepped for `supportedProtocolVersions`
before this record was written.

#### Round 6, rev 6 reviewed, one blocker from both seats, and it invalidates three revisions

Both reviewers blocked on the same thing, both reached it by **executing the
published packages** rather than reading them, and both independently found the
same fix. Their results were reproduced here before acceptance, and a third
reproduction agreed on every row.

**The finding.** The harness rev 6 prescribed does not work:

| Harness | Outcome |
|---|---|
| hand-wired `Server` + linked pair, client `{ pin }` (**rev 6's text**) | `ERA_NEGOTIATION_FAILED` |
| same, client `'auto'` | connects **legacy** `2025-11-25` |
| same, client default | connects **legacy** `2025-11-25` |
| `serveStdio(factory, { transport })` + client `{ pin }` | **modern**, `tools/call` works |

The mechanism, from a raw JSON-RPC probe with no client library in the path:
`server/discover` is **registered** and still answers `-32601 Method not found`,
because dispatch picks a codec from the negotiated version and the unbound default
is the legacy codec, which refuses modern methods before reaching the handler.
`setNegotiatedProtocolVersion` is called from exactly two places in the package,
inside `createMcpHandler` and `serveStdio`, and is not among the 89 public exports.

**The part worth recording is how it survived three rounds.** In round 3 a reviewer
falsified my claim that modern testing needs a serving entry. Its evidence was that
`InMemoryTransport.createLinkedPair` is still exported, that
`supportedProtocolVersions` admits modern revisions, and that `server/discover` is
installed when it does. All three statements are true. None of them establishes
that the method is *reachable*, which is the only thing that matters, and testing
reachability would have taken one `send()`.

I accepted it because it was specific, well cited, and came from the seat with the
better track record. Rounds 4, 5 and 6 were then spent propagating, completing and
refining a correction that should have been rejected on arrival. Round 5's blocker,
which was real, was a defect *inside* the false position. The generalised rule:

- **Registration is not reachability. Presence is not behaviour.** An export
  existing, a handler installing, a type admitting a value: none of these is
  evidence that a path works. Only running it is.
- **A falsification of your own correct claim deserves the same scrutiny as an
  assertion of a new one**, and more when you are inclined to defer to the source.
  The cost of accepting it wrongly is not one bad paragraph, it is every revision
  that builds on it.
- **When a reviewer's evidence is a static property and the claim is dynamic,
  that gap is the whole finding.** Ask what would have to be executed, and execute
  it.

Two rounds earlier I wrote that a verified fact used one inference too far reads
exactly like a verified fact. That was the correct diagnosis of round 5, and it
applied to round 3 the whole time without my noticing.

**What changed in rev 7:** Blocker 2 rewritten from execution results and the rev-3
substance restored (with its one genuine error corrected: `.fetch` is not the only
serving entry, `serveStdio` reaches modern in-process); S2 harness 1 rebuilt on
`serveStdio` with both known-wrong constructions named; the Regression tests guard
retargeted at the construction rather than the transport; the status block and
round-3 summary corrected to say that blocker was wrong.

#### Round 7, rev 7 reviewed, one blocker per seat, both real and different

Both seats executed the rev-7 matrix and both confirmed every row of it. Blocker 2
and S2's core, the `serveStdio` harness, the 89 exports, the two era-binding call
sites and the pin semantics all held under independent re-execution. The two
blockers landed on the parts rev 7 had *added*, which is now the third round
running where the fix introduced the next defect.

**Grok: the corrected residual list was itself wrong.** Rev 7 said
`createMcpHandler().fetch` was still needed for "cache-header emission over HTTP".
Executed: no `Cache-Control` is emitted on JSON responses in either response mode,
and `ttlMs` / `cacheScope` travel in the body. The only `Cache-Control` in the
package is SSE stream hygiene. So P5 is fully coverable in-memory, and the
residual shrinks to header requirement, era routing, and `responseMode`.

This one is worth dwelling on. The evidence that falsifies it was **already
quoted in the document**: the discover output in Blocker 2 shows
`"ttlMs":0,"cacheScope":"private"` inside the result body, a few paragraphs above
the sentence claiming those become HTTP headers. I pasted my own probe output and
did not read it against the claim it sat next to.

**Codex: nothing tested that progress survives.** `responseMode: 'json'` returns
the terminal result and silently drops mid-call notifications; `auto` streams both
over SSE. Constraint 6 requires progress to survive, so S3 could pick `json`, pass
every test this document specified, and break `llm_job_watch` for every async
caller. Verified here with a tool emitting `notifications/progress`.

**Both blockers were re-executed before acceptance**, and one of my reproductions
initially failed for my own reasons (`extra.sendNotification` does not exist in
v2; the API is `extra.mcpReq.notify`). Had I stopped there I would have "refuted"
a true finding on the strength of my own broken probe. A failed reproduction is
evidence about the probe until the probe is proven sound, which is the same
registration-is-not-reachability trap wearing the opposite jersey.

**What changed in rev 8:** the residual list corrected with the executed evidence
and `responseMode` added to it; `ttlMs` / `cacheScope` reassigned to harness 1;
the `-32020` header/body rejection named as a concrete fetch-only behaviour; a
mandatory progress-survival test added to both S2 and the minimum regression
suite.

#### Round 8, rev 8 reviewed: the oldest claim finally executed, and a third completeness failure

**Codex: `Mcp-Param-*` validation was missing from the residual list.** A tool
property declaring `"x-mcp-header": "<token>"` must be mirrored in an
`Mcp-Param-<Token>` header; both absence and disagreement are rejected `-32020`
before the tool runs. Header-shaped by construction, so the in-memory harness
cannot carry it. Reproduced here with a positive control. Folded into the residual
list, S2 harness 2, and the regression requirements.

That makes **three consecutive rounds where a completeness claim failed**: rev 7's
residual list was wrong, rev 8's corrected list was incomplete, and each time the
error was in the sentence that had just been fixed. "Correct" and "complete" are
different claims and this document keeps conflating them. Every future list-shaped
assertion needs the second one argued separately from the first.

**Grok: unconditional approval, on executed evidence**, and its findings held under
re-execution: P5 is genuinely coverable from the in-memory harness with non-default
`ttlMs` / `cacheScope` values observable; the `-32020` statement is accurate; and
the progress test constrains S3 only because it sits on harness 2, since in-memory
progress works fine via `onprogress`. That last point is a real refinement of rev
8's reasoning rather than a restatement of it.

**The oldest open claim in the document is now closed.** Both seats independently
drove a real legacy client against a real server and observed
`initialize` → `notifications/initialized` (202) → GET opening `text/event-stream`,
with GET-on-connect false and sessionless GET returning 405. That chain had
survived a round-1 correction and a round-3 correction on control-flow reading
alone. It was the last piece of "Verified ground truth" resting on existence
rather than behaviour, and it holds.

**The methodological note worth more than either finding.** Reproducing Codex's
blocker took **three** broken probes: `x-mcp-header: true` (it must be a non-empty
RFC 9110 token string), then a JSON Schema `inputSchema` (it must be Zod), before
`z.string().meta({...})` worked. Every failure looked exactly like a refutation.
Stopping at any one of them would have rejected a true finding on the strength of
a broken harness.

This also reframes the approval. Grok declared the residual "complete for S2's
job" and enumerated the extra HTTP behaviour it *had* found as non-gaps. Given how
hard the case was to construct, it most likely never built a working
`x-mcp-header` tool either, and reported completeness rather than reporting that
it could not construct the case. **A blocker names something checkable; an
approval asserts a negative over a space the approver defined.** They are not
symmetric evidence, and this document has now been saved four times by the
asymmetry.

#### Round 9, rev 9 reviewed: the residual list stops being hand-maintained

Both seats blocked on the **same list, for the fourth consecutive round**. Grok
named `MCP-Protocol-Version` header validation specifically. Codex enumerated the
whole request path and found that plus HTTP method routing, `Content-Type`/415,
body-parse/400, legacy `Accept`/406, SSE framing headers, the full status ladder
including abort 499, and `Request.signal` teardown.

**The fix is structural, not another append.** Rev 10 replaces the hand-maintained
list with the output of a stated walk of `createMcpHandler.handle` →
`classifyEntryRequest` → `classifyInboundRequest` → `serveModern` → validation →
invocation, plus the legacy fallback, and requires anyone editing it to redo that
walk. Four rounds of adding one member at a time is enough evidence that the
method was the problem, not the members.

Three further corrections, all mine:

- **`Mcp-Method` is required for every modern request**, not just `resources/list`
  and `server/discover` as rev 9 said. Confirmed across five methods with positive
  controls: 200 with the header, 400 / `-32020` without.
- **`PERMITTED_X_MCP_HEADER_TYPES` is four types, including `number`.** Rev 9 said
  three because it copied the list from the package's *error message*, which names
  only `string, integer, boolean`, rather than from the `Set`. Round 9 confirmed
  `number` end to end with `Mcp-Param-Amount: 42.5` returning 200. Reading the
  human-readable error instead of the data structure is the same substitution of
  convenient evidence for real evidence this document has made repeatedly.
- **The round-9 packet claimed `Mcp-Param-*` had been added to the regression
  requirements. It had not.** It reached the residual list and S2 and stopped
  there. Codex caught the discrepancy between the packet and the document. Rev 10
  adds a real acceptance criterion, and makes it either-or so the scope-out branch
  cannot be satisfied by silence, which matters because the gateway declares no
  `x-mcp-header` today and that branch is the live one.

**The static-versus-dynamic sweep is complete, confirmed independently by both
seats.** Every remaining "Verified ground truth" claim is an inventory, a negative
search, or a direct structural property; none uses registration or existence as
proof of reachability. That conclusion is load-bearing for the design document and
is now the one thing in here that two reviewers separately went looking to
falsify and could not.

**Also flagged, for the DAG rather than this document:** S2 needs the v2 packages
that S3 nominally introduces even though S2 precedes S3, and S4's P5/P6 work
consumes S2's harness. The design document must split out a v2 bootstrap and
record the S2 to S4 edge.

#### Round 10, rev 10 reviewed: the derivation was right in kind and wrong in scope

Grok approved, having independently re-derived the residual list and matched it to
rev 10 member for member, and having failed to break the either-or criterion by
silence. Codex blocked. Codex was right, and both of its findings are things a
member-by-member comparison could not have found, because they are properties of
the *walk*.

**1. The walk does not terminate uniformly at invocation.** `serveModern` routes
`subscriptions/listen` directly to `listenRouter.serve`. Any enumeration that ends
at "invocation" misses that branch structurally, which helps explain why four
rounds of list-patching kept coming up short.

**2. The walk omitted the auth and request-context handoff.** `authInfo` and the
HTTP `Request` reach both the server factory and the per-request invocation
context. Reproduced here: the factory receives `{ era, requestInfo }` with the
request URL and the handler receives `extra.http.req` with the same. Since
principal derivation in this gateway is request-scoped and auth-derived, this is
the most security-relevant fetch-only behaviour there is, and it was outside the
stated scope.

**3. The round-9 completeness conclusion is retracted.** Rev 10 recorded that two
seats had independently confirmed the static-versus-dynamic sweep complete. Codex
falsified it with a single execution: `createMcpHandler` serves
`subscriptions/listen` from a server declaring no subscription capability, and the
first response is `-32602` (bad params) rather than `-32601` (method not found),
which is the tell that the method exists. The non-goal "do not implement
`subscriptions/listen`" was therefore **unachievable as written**, and is restated
in rev 11 as an explicit choice between accepting the served method or rejecting
it at the front door.

**The lesson, and it is uncomfortable because it undoes a conclusion I had already
banked.** Two independent seats agreeing that a sweep is complete is weaker
evidence than one seat trying to break it. Rev 10 promoted "two reviewers looked
and found nothing" to a load-bearing conclusion for the design document. A third
reviewer, asked specifically to falsify rather than confirm, broke it on the first
try. **Agreement about the absence of something is not evidence of its absence
when nobody was hunting.** The round-10 packet asked for falsification precisely
because of this risk, and the request paid for itself immediately.

**Not blocking, recorded for the DAG:** S2 needs the v2 packages S3 nominally
introduces, and S4 consumes S2's harness.

Use Codex, Grok, and Mistral. Iterate to unconditional approval or a named,
concrete blocker.
