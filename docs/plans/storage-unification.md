# Storage unification

Status: draft, not implemented.
Goal: one storage abstraction with one write path per operation, and a single
knob that makes a deployment genuinely Postgres-only.

Revision 4, after three adversarial review rounds (Codex, 2026-08-13): 17, 18
and 20 defects respectively, a majority of each round's defects being ones the
previous round's fixes introduced or left unresolved. Every defect was
independently verified against the code or the live deployment before being
accepted; none were contested. Corrections are marked inline where a previous
claim was wrong, because several were load bearing.

Counts here are taken with `node` or sqry's AST graph rather than a piped
`grep`, and tools are invoked by repo-local path rather than `npx`. Section 2
records why, and scopes that observation to the authoring session rather than
presenting it as a property of this repository.

## 1. The actual problem

It is not "SQLite versus Postgres". It is that the gateway has **multiple
independent persistence subsystems, each with its own engine and its own
backend-selection mechanism**, none of which agree.

The three below are the ones with distinct _engines and selectors_, and they are
what makes `[persistence].backend` meaningless. They are not the whole
inventory: section 3.1 lists further file-backed state (approvals, admin audit,
workspace registry, capability cache) that has no selector at all because it
never had an engine choice. Revision 3 said "exactly three", contradicting its
own inventory.

Measured on `workhorse3`, 2026-08-13 (counts are snapshots of a live system and
are timestamped for that reason):

| Subsystem                       | Engine in use           | Location                                            | Selected by             |
| ------------------------------- | ----------------------- | --------------------------------------------------- | ----------------------- |
| Sessions                        | JSON file, atomic write | `~/.llm-cli-gateway/sessions.json`, 1,247,140 bytes | `DATABASE_URL` (unset)  |
| Jobs, validation runs, receipts | Postgres                | `llm_cli_gateway`                                   | `[persistence].backend` |
| Requests, transcripts           | SQLite                  | `~/.llm-cli-gateway/logs.db`, 1.2 GB                | `LLM_GATEWAY_LOGS_DB`   |

Setting `[persistence].backend = "postgres"` moves exactly one of the three.

The consequences are the ones already observed: transcripts and the jobs that
produced them live in different engines and cannot be joined, and the SQLite
file grows without retention because the retention setting belongs to a
different subsystem.

**Correction (was wrong in revision 1).** Revision 1 said `llm_request_result`
"resolves only on the instance that ran the work". That is false for the current
deployment. All local instances run as the same user and default to the same
`~/.llm-cli-gateway/logs.db`, so any of them can read any transcript given a
correlation id, as `postgres-security-hardening.md` section 4.5 states. The real
limitation is **host-local and file-local**, not originating-instance-local. It
would become instance-local only across separate hosts or separate home
directories.

## 2. Root cause: the sync/async asymmetry

| Module               | Interface                | Evidence                                                                                                                                                            |
| -------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job-store.ts`       | synchronous              | 0 occurrences of `Promise<`                                                                                                                                         |
| `flight-recorder.ts` | synchronous              | 0 occurrences of `Promise<`                                                                                                                                         |
| `session-manager.ts` | **hybrid, deliberately** | `ISessionManager` (`session-manager.ts:1654`) declares methods returning `T \| Promise<T>` "so both backends satisfy the contract. Callers must always use `await`" |

**Correction (was wrong in revisions 1 and 2).** Revision 1 called
`session-manager.ts` "asynchronous, 28". Revision 2 kept the number while
disowning it, and the number was still wrong: the regex matches **33** lines,
not 28.

The cause is worth recording, with its scope stated honestly. **In the authoring
session's shell**, counts came back filtered: `grep ... | wc -l` returned 28
while the same count run through `rtk proxy`, or computed by reading the file in
`node`, returned 33. A reviewer running the same command in a normal shell gets
33, and finds `/usr/bin/grep` and Prettier 3.9.5 as expected. So this is an
**author-session observation caused by a command hook local to that
environment**, not a property of this repository, and it is not reproducible
from outside that session.

The rule it produces is environment-independent and worth keeping regardless:
**counts in this document are taken with `node` or sqry's AST graph, never a
piped `grep`, and tools are invoked by repo-local path rather than `npx`.**

The substantive point is that the interface is not asynchronous at all, it is
**explicitly hybrid**: someone already solved the two-engines-one-interface
problem here by widening the return type rather than by adding a bridge.

Postgres drivers are asynchronous. Two of the three subsystems expose
synchronous interfaces, which only an engine that is **natively synchronous
in-process** can satisfy without a bridge: SQLite (`node:sqlite`
`DatabaseSync`), a JSON file, or the in-memory driver. Postgres satisfies them
only _through_ the worker-thread bridge, which is the point.

That is why Postgres support for jobs arrived as
`postgres-job-store-worker.ts`, 1,333 lines running the `pg` client in a worker
thread while the caller blocks on the result. `job-store.ts:2703` states the
synchronous `JobStore` contract as the reason. Applying the same technique to
the flight recorder would place a worker round-trip on the hot path of every
request, since logging is two-phase on every call.

**Scoped claim.** The synchronous interface is a **proven** implementation
impediment for **jobs**, evidenced by the worker bridge and the comment at
`job-store.ts:2703`. For **transcripts it is inferred, not proven**: no
flight-recorder design artifact records why Postgres was not attempted there.
The inference is reasonable, since the same constraint applies with a worse hot
path, but it is an inference and revision 2 overstated it as proven. It is
_not_ the sole root cause of the fragmentation. The session manager is the counter-example: it
already supports awaited Postgres operations and still has its own selector, its
own schema and two separate implementations. Fragmentation therefore has at
least two independent causes, interface shape and the absence of any shared
port, and only the second explains the session manager.

## 3. Design

### 3.1 One asynchronous storage port, pluggable drivers

Introduce `src/storage/` with a single async interface and drivers beneath it:

```
src/storage/
  store.ts            # the port
  drivers/
    postgres.ts       # natively async
    sqlite.ts         # adapter over the existing node:sqlite code
    memory.ts         # for tests and backend = "memory"
```

The port must cover every subsystem that persists state today, not only the
three headline ones. Revision 1 listed only `SessionStore`, `JobStore` and
`RequestStore`, and then asked in its own open questions whether `memory`
remained a driver, which was internally inconsistent. The full inventory:

- sessions and active-session pointers
- jobs
- **validation runs** (`ValidationRunStore`, `job-store.ts:939`)
- **validation receipts**
- **Personal Agent Config Kit persistence** (`kit_active_sessions`,
  `kit_attempt_fences`, and the artifact admission/recovery surfaces)
- requests and `gateway_metadata`
- **approvals** (`~/.llm-cli-gateway/approvals.jsonl`, measured at 3.0 MB)
- **admin audit** (`admin-audit.jsonl`)
- **workspace registry** and **capability cache** (`capability-cache/`)

**Correction (revision 2 was incomplete).** Revision 2 called its list the full
inventory while omitting the last three groups, which is the same mistake in
miniature that this document exists to fix: file-backed state that no one counts
as storage. `approvals.jsonl` alone is larger than `sessions.json`.

Whether every one of these belongs _in_ the port is a real question, and
`settings.json`, `tunnel.json` and `claude-mcp.generated.json` are probably
configuration rather than state. But that determination must be made
explicitly and recorded, because anything omitted keeps its own write path,
which is the defect this document exists to remove.

**The Postgres driver cannot simply reuse the pool in `db.ts`.** That pool is
built from `this.config.database!.connectionString` (`db.ts:35`), and those
database fields are populated only when `DATABASE_URL` is set (`config.ts:58`,
`:61`). It is not wired to `[persistence].dsn`. Unifying the config (3.3) and
unifying the pool are therefore the same task.

**A single `[persistence].dsn` is not sufficient.** The security design requires
distinct `app`, `reader`, `analytics`, `retention` and `migrate` identities, so
the port needs a **credential set and an operation-to-role routing seam**, not
one connection string:

- config carries per-role credentials (DSN or certificate path) under
  `[persistence.roles]`, for `app`, `reader`, `analytics` and `retention`
- the driver holds one pool per role
- every port method declares its operation class (write, transcript read,
  analytics read, retention) and the driver routes to the matching pool
- a deployment that configures only one role still works, degraded to today's
  single-identity behaviour, so this is not a hard prerequisite for consumers

**Correction (revision 3 put migration credentials in the runtime pool set).**
`llmgw_migrate` is a member of the table-owning role and exists for
`npm run migrate` only. A long-running gateway process must not hold
owner-equivalent credentials, and DDL is not a routed runtime operation. The
migrate credential is **process-separated**: it belongs to the migration entry
point, never to the driver's pool set.

**Scope of what this separation buys.** It bounds accidental queries and limits
the damage from theft of one credential. It does **not** bound an
arbitrary-code compromise of the gateway process, which holds every runtime
credential at once. The security document must not claim otherwise.

Without that seam the security design's role separation is unimplementable, and
revision 2 left it as an open question while the security document depended on
it.

**Correction (was wrong in revision 1).** Revision 1 claimed "async-over-sync is
free". That is false as stated. `Promise.resolve(syncCall())` evaluates
`syncCall()` immediately and synchronously; it does not move SQLite I/O off the
event loop, and it adds promise and microtask overhead. The accurate and still
useful claim is narrower: **async-over-sync needs no worker thread, whereas
sync-over-async does.** That is a structural simplification, not a performance
one. Whether the added overhead matters at the recorder's call rate is
UNASSESSABLE without the benchmark specified in section 9.

### 3.2 Decision: the SQLite driver stays

**Decided 2026-08-13.** SQLite remains as a driver behind the unified port. It
is not deleted from the package, and Postgres is not made mandatory for
consumers. "Postgres only" is a deployment property achieved by config, not a
package property achieved by removal.

`[persistence].backend` defaults to `sqlite`, and the 2.0.0 migration to
`node:sqlite` was made specifically to drop native dependencies so a consumer
can `npm install` and run with no database server. Making Postgres mandatory
would break zero-config installation for every public consumer of the package.

Two different things are being unified, and only one requires deleting an
engine:

- **No dual write paths** is a property of the _code_: one implementation per
  operation, one interface, one selection mechanism. Achieved with both drivers
  present.
- **One Postgres instance** is a property of a _deployment_: a single config
  value that actually moves everything. Achieved by setting
  `backend = "postgres"` once the port exists.

Today the codebase fails the first and the deployment fails the second.

#### What the decision costs

**Correction (was wrong in revision 1).** Revision 1 presented a table of
`grep -c` counts as an "engine-specific SQL inventory" and drew a conclusion from
it. That was invalid on three grounds, and the conclusion is withdrawn:

- The single `NOTIFY` hit was `Atomics.notify(view, 0, 1)`
  (`postgres-job-store-worker.ts:59`), a JavaScript atomics call in the worker
  bridge. It is not PostgreSQL `NOTIFY`. Revision 1 counted it as one and then
  asserted in the same section that `LISTEN`/`NOTIFY` was unavailable to SQLite,
  which was self-contradictory.
- The two `FOR UPDATE` occurrences (`:636`, `:1229`) are **validation-run row
  locks**, not job claiming. Revision 1 used them to argue about job-claim
  concurrency, which they do not support.
- The scan covered only two files. `session-manager-pg.ts` contains **nine more**
  `FOR UPDATE` uses, none of which were counted.

A lexical token count is not a dialect inventory in any case. It cannot see
placeholder syntax (`$1` versus `?`), type casts, time and interval functions,
`RETURNING` semantics, upsert behaviour, transaction isolation defaults, or
error taxonomies. **A complete semantic dialect inventory is still owed and is
listed as a deliverable in section 9.** Until it exists, the claim "unifying
current behaviour is cheap" is unsupported and is withdrawn.

What remains true and does not depend on those counts, because it follows from
engine capability rather than from grep:

- **No row-level locking in SQLite.** Whatever locking the port needs must hold
  under a single-writer model on one engine and MVCC on the other.
- **No row-level security in SQLite.** See the reduced-guarantee note below.
- **No multi-host.** Correction: revision 2 said "no multi-instance", which
  contradicts section 1 of this document and the live deployment, where several
  local instances share one `logs.db` concurrently. SQLite supports multiple
  processes against one file. What it does not support is instances on
  **separate hosts**, so instance-scoped orphan recovery across a fleet is what
  becomes meaningless.

Four further costs:

1. **Two schemas that must not drift.** Postgres has `migrations/*.sql` with a
   checksum ledger; the SQLite schema is created inline in code
   (`flight-recorder.ts:430` creates `requests`). Either one source generates
   both dialects, or a drift gate is required. Covered by 3.5.
2. **Doubled test matrix.** Storage tests must run against both drivers. The
   `*-pg` suites are currently opt-in; unification makes them mandatory.
3. **Retention economics differ.** Postgres can partition and drop; SQLite needs
   `DELETE` plus `VACUUM`, which takes a long exclusive lock on a 1.2 GB file.
4. **The subtraction prize shrinks.** The worker bridge and one of the two
   session managers still go, but `sqlite-driver.ts` stays and a driver layer is
   added.

"No dual write paths" is then true at the _call_ level: one implementation per
operation, two terminations beneath it.

#### SQLite's reduced guarantee, stated accurately

SQLite's reduction is **no engine-level backstop and no multi-host**. That
is a reason to prefer Postgres for a remote-exposed deployment. It is _not_ a
reason to refuse to start one on SQLite, and the design must not gate on that.

Principal isolation for remote callers is enforced in application code:
`principalCanAccess` (`request-context.ts:51`), called from the handler at
`index.ts:21884`. That check runs identically regardless of engine, so a
SQLite-backed remote gateway is not exposed relative to a Postgres-backed one on
this axis. Postgres adds RLS as a backstop against a future handler bug.

So the argument for moving transcripts to Postgres is durability and
multi-host correctness and joinability, not principal isolation. (Not
"multi-instance": several local processes already share one SQLite file, as
section 1 records.)

### 3.3 One selection mechanism

`[persistence].backend` becomes the only thing that chooses an engine, for all
subsystems.

Demoted from _selector_ to _deprecated compatibility input_:

- `DATABASE_URL`, currently the sole switch for the session manager and for the
  `db.ts` pool, disconnected from `[persistence]`
- `LLM_GATEWAY_LOGS_DB`, currently the sole switch for the flight recorder, and
  separately overloaded to force `backend = "sqlite"` on the job store
  (`config.ts:335-353`), so setting it silently downgrades an explicit
  `backend = "postgres"`

**Correction (was wrong in revision 1).** Revision 1 called both "path overrides
with existing one-time warnings". Wrong on two counts: `DATABASE_URL` is a DSN,
not a path, and it currently emits **no** deprecation warning, unlike
`LLM_GATEWAY_LOGS_DB`. A DSN also cannot be expressed as a path override, and
neither can the per-role DSNs and TLS parameters the security plan requires.

The correct migration is therefore asymmetric and must be specified as such:

- `LLM_GATEWAY_LOGS_DB` maps to `[persistence].path` when the resolved backend
  is `sqlite`, keeping its existing warning, and must **not** be able to
  override an explicit `backend = "postgres"`.
- `DATABASE_URL` maps to `[persistence].dsn` when no dsn is configured, and
  gains a deprecation warning it does not have today.
- Conflicts between the two, or between either and the config file, must be a
  startup error rather than a silent precedence rule.

### 3.4 Write ordering and durability

**Correction (was wrong in revision 1).** Revision 1 proposed a per-correlation
in-process write queue and called it sufficient to preserve `logStart` before
`logComplete`. It is not. Verified failure modes it does not cover:

- process crash or `SIGKILL` between start and complete
- **orphan completion by a different gateway instance**, which an in-process
  queue cannot see at all
- a rejected `logStart` promise poisoning or bypassing the chain
- a status-guarded `logComplete` updating zero rows
- `recordRouting` or compression telemetry racing a missing start row
- immediate read-after-write
- correlation-id reuse, and unbounded growth of the queue map

An in-memory queue addresses only ordering within one healthy process, and
graceful-shutdown drain addresses only one of the listed modes.

**Decision (revision 2 contained a contradiction).** Revision 2 required a
durable transition and, three paragraphs later, forbade awaiting it. Those are
incompatible: a process that dies before an unawaited write reaches durable
storage loses the event, and database idempotency cannot recover something that
never arrived. Revision 2 also asserted "logging must never fail or slow a
request" as a property to preserve, which **is not a property the system has
today**: SQLite writes are synchronous and already block, and ACP call sites
such as `acp/runtime.ts:208` are not isolated from recorder exceptions.

The resolution is to state what is actually true and pick one:

- **`logStart` is awaited.** It is one insert, it already blocks today, and
  without a durable start row there is nothing for a completion to attach to.
- **`logComplete` is awaited**, with a bounded timeout, and its failure is
  captured rather than propagated. Losing a response body is precisely the
  failure that motivated this document, so best-effort is the wrong trade for
  the completion write specifically.
- The property to **establish** is therefore "logging must never _fail_ a
  request". **Correction: revision 3 called this a preserved current property,
  which contradicts its own preceding paragraph.** ACP call sites are not
  isolated from recorder exceptions, so logging _can_ fail a request today.
  This is a property the port must introduce, not one it must avoid breaking.

Four things this decision does not yet specify, and must before implementation:

- **`logStart` failure policy.** Propagating failure violates the property
  above; swallowing it leaves no durable start row for a later completion to
  attach to. One of the two must be chosen explicitly.
- **Timeout semantics.** A `Promise.race` style timeout neither cancels the
  database query nor establishes whether it committed. Durability requires
  query cancellation plus retry or outbox semantics, or an explicit
  "uncertain" state.
- **The side table needs a full definition**: owner, access policy, whether its
  contents are encrypted, what triggers reconciliation, retention, and
  protection against correlation-id reuse. A caller-controlled reused id could
  otherwise attach a stale completion to an unrelated later start.
- **The merge needs a fence, not just "last writer wins".** Without a revision
  counter or timestamp fence, a delayed first completion arriving after the
  final one would overwrite the final response, which is the same data loss the
  merge exists to prevent.

`logComplete` semantics must then be **merge, not no-op**:

- **Late second completion is deliberate and must be preserved.**
  `async-job-manager.ts:2957` documents that a terminal status can be decided
  while the child is still shutting down, so completion is called again to
  refresh `requests.response` with late output. An "already completed means
  no-op" rule silently discards those bytes. The transition must be a revision:
  last-writer-wins on `response`, monotonic on terminal status.
- **A completion with no start row cannot fabricate one.** `FlightLogResult`
  (`flight-recorder.ts:62`) carries `response`, token counts, duration, exit
  code and telemetry, but **no `cli`, `model`, `prompt` or start timestamp**,
  and those are `NOT NULL` in the schema at `flight-recorder.ts:430`. An upsert
  therefore cannot construct a valid row. Such completions must be written to a
  side table for reconciliation, never dropped and never fabricated.
- `recordRouting` and compression telemetry need their own merge rules, since
  they can arrive before or after either phase.

Two properties from the current design must survive:

**`backend = "none"` must stay structural.** `createJobStore` returns null and
`createGatewayServer` does not register the `*_request_async` / `llm_job_*`
tools. That invariant carries across unchanged.

**Reads must not be able to write.** `queryRequests` currently runs on a
read-only SQLite connection so writes fail at the engine with `SQLITE_READONLY`.
The Postgres driver needs an engine-level equivalent, not an application check.

**The generic SQL entry point must go.** `queryRequests<T>(sql, ...params)`
accepts arbitrary SQL from any caller. Today that is contained by the read-only
connection, but it is also an open door for a future bulk body query, which is
exactly what would silently break the encryption design in
`postgres-security-hardening.md` section 4.2. Column grants and a test over
today's queries prove today's behaviour and prevent nothing tomorrow.

The port replaces it with **named typed reader methods** (cache statistics, LCR
priors, routing decisions, single-request read-back), each returning a declared
shape. Raw SQL then exists only inside `src/storage/drivers/`, which is what
makes the ratchet rule below enforceable rather than advisory.

### 3.5 Structural ratchet

Add `npm run storage:surfaces:check`. Revision 1 specified it too loosely; a
blanket rule would have failed legitimate code. Scope and exemptions:

| Rule                                                                           | Exemptions                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No `node:sqlite` or `pg` import outside `src/storage/drivers/`                 | `src/migrate.ts`, `src/migrate-sessions.ts`, `scripts/` tooling, `src/__tests__/`                                                                                                                                                                        |
| No atomic-write state persistence outside the drivers                          | enumerated exactly, not inferred: `settings.json`, `tunnel.json`, `claude-mcp.generated.json` (configuration, not state). Everything else in `~/.llm-cli-gateway/` is in scope, including `approvals.jsonl`, `admin-audit.jsonl` and `capability-cache/` |
| No engine selection from an env var outside `src/config.ts`                    | none                                                                                                                                                                                                                                                     |
| No schema drift between dialects                                               | none                                                                                                                                                                                                                                                     |
| No raw SQL string outside `src/storage/drivers/` (the typed-reader rule above) | `src/migrate.ts`, `src/migrate-sessions.ts`, `src/__tests__/`                                                                                                                                                                                            |

Requirements on the implementation:

- **AST-based, not grep.** A lexical scan cannot distinguish `Atomics.notify`
  from SQL `NOTIFY`, which is exactly the error revision 1 made. The gate must
  not repeat it.
- **Schema normalisation rules** so the dialect comparison is meaningful
  (type-affinity mapping, index-name normalisation).
- **Mandatory negative control in ADD form**: the test must add a _new_
  violating symbol, and a _new_ schema difference, and confirm the gate reports
  both. Removing an entry the gate already lists is not accepted as evidence.
- **The gate's own enforcement must be tested**, not merely its output: a
  violation must fail the build with a non-zero exit, not merely print a
  warning that CI ignores. Revision 2 asked here for "guard shape" testing
  against sinks and dead branches, which was borrowed from a code-review
  protocol and matched none of the rules above; the applicable property for a
  build gate is that it actually fails.

## 4. What gets deleted

| Module                         | Lines | Fate                                            |
| ------------------------------ | ----- | ----------------------------------------------- |
| `postgres-job-store-worker.ts` | 1,333 | deleted once the port is async                  |
| `session-manager.ts`           | 1,816 | collapsed into one implementation over the port |
| `session-manager-pg.ts`        | 1,521 | collapsed, same                                 |
| `job-store.ts`                 | 3,255 | keeps logic, loses per-engine implementations   |
| `flight-recorder.ts`           | 833   | keeps logic, gains a driver it does not own     |
| `sqlite-driver.ts`             | 307   | becomes `drivers/sqlite.ts`                     |

## 5. Blast radius

**Measured, revision 3.** Revisions 1 and 2 both got this wrong: revision 1
claimed "19 call sites in three files" from a grep, and revision 2 replaced the
number with a qualitative "floor" rather than measuring it. The audit has now
been run with sqry's AST graph (`get_references`, `direct_callers`) against a
refreshed index (471 files, 147,665 nodes).

**Correction (revision 3 mixed incompatible metrics).** Revision 3 put distinct
caller functions, call expressions and declaration-inclusive references in one
"total refs" column, which is not a single measurement. The two metrics,
separated:

| Symbol          | Distinct caller functions | Actual call expressions |
| --------------- | ------------------------- | ----------------------- |
| `logStart`      | 18 (4 prod, 14 test)      | 49 (4 prod, 45 test)    |
| `logComplete`   | 16 (4 prod, 12 test)      | 40 (5 prod, 35 test)    |
| `queryRequests` | 10 (6 prod, 4 test)       | 25 (7 prod, 18 test)    |

`logComplete` has **five** production call expressions, not four:
`runAcpRequest` calls it on both the success and failure paths
(`acp/runtime.ts:315` and `:344`). That is one migration seam but two
references, which is exactly why the two metrics must not be conflated.

Production write-path callers, all four of each:

- `src/index.ts:4105` `safeFlightStart` and `:4116` `safeFlightComplete`
- `src/acp/runtime.ts:145` `runAcpRequest` (calls both)
- `src/async-job-manager.ts:2430` `startHttpJob`, `:3558` `startJobWithDedup`,
  `:1681` `runOrphanSweep`, `:2862` `writeFlightComplete`

Production read-path references: `cache-stats.ts:172` (a call, not a
declaration, as revisions 2 to 4 said), `:289`,
`:377` (x2), `:615`; `flight-recorder.ts:767`, `:800`; `resources.ts:374`;
`lcr-priors.ts:398`. Of these, **seven** are generic `queryRequests<T>` calls
outside the recorder itself; revision 2 said eight.

Three findings change the work rather than the number:

1. **`safeFlightStart` and `safeFlightComplete` already exist.** The `index.ts`
   write path is already funnelled through two wrappers, which neither previous
   revision noticed. This makes the migration **easier** than described.
2. **`runAcpRequest` calls both hooks from one function**, so ACP is one seam,
   not three.
3. **Tests dominate**: 98 of 114 actual call expressions, or 30 of 44 distinct
   caller functions. Revision 3's "48 of ~62" was a product of the metric
   mixing above and is withdrawn; the conclusion survives the correction.

**This is still not an async blast-radius audit.** Immediate references measure
the seam, not the change. Making `safeFlightStart` awaitable reaches ten
production callers, `safeFlightComplete` eight, and `writeFlightComplete`
twelve, several through enclosing APIs that are currently synchronous and would
themselves have to become async. The transitive closure is the number that
actually costs, and it has not been measured.

`scripts/generate-site-discovery.mjs` also references `queryRequests`, and site
generation reads `dist/`, so the port change must not break it.

This discharges the type-directed audit for the **FlightRecorder** surface only.
`JobStore` (32 store-method accesses in `async-job-manager.ts`: 28
`this.store.` plus four optional-chain `this.store?.` at `:1731`, `:1930`,
`:3482`, `:3666`), `ISessionManager`
and the validation stores remain unaudited, and a
proper audit of those remains a prerequisite deliverable (section 9). It must
be type-directed rather than lexical, for two independent reasons: grep cannot
match generic call syntax such as `queryRequests<T>(...)`, and counts taken
through this environment's Bash hook are silently filtered and wrong.

## 6. Sequencing

1. **Semantic dialect inventory and call-surface audit.** Both are
   prerequisites; the design cannot be costed without them.
2. **Define the port**, covering the full subsystem inventory in 3.1.
3. **Postgres driver**, with the per-role pool set and routing seam from 3.1.
4. **SQLite driver**, over the existing `node:sqlite` code.
5. **Migrate the job store.** It already has both engines, so the `*-pg` suites
   prove the port against real dual-engine behaviour.
6. **Migrate the session manager**, collapsing the two implementations.
7. **Migrate the flight recorder.** Closes the original defect.
8. **Unify config selection** per 3.3.
9. **Add the ratchet.**
10. **Cutover and backfill** per section 7.
11. Retention, expressible once for all subsystems.

**Hard gate.** Transcript bodies must not be moved into Postgres until **every**
step of `postgres-security-hardening.md` section 6 is complete, through and
including its http principal-granularity step. Revision 3 stopped the gate one
step short, at encryption, while the security document's own sequence puts
principal granularity before transcript movement. The gate now inherits that
sequence in full rather than naming a cut-off that can drift. Moving plaintext transcripts into a store reachable
in cleartext by a single superuser role would be a regression.

**Correction (revision 2 was weaker than the security document and contradicted
it).** Revision 2 required "TLS, role separation, and a resolved decision on
body encryption". Two faults:

- A _decision_ is not a control. A decision not to encrypt would have satisfied
  that wording while violating the security sequence, which requires the
  encryption itself.
- It named **TLS** unconditionally, while the security document's preferred
  transport option is a unix socket with `peer` authentication, for which TLS is
  explicitly unnecessary. The requirement is an **authenticated, confidential
  channel**, satisfied by either the socket option or the TLS option, not TLS
  specifically.

The gate therefore inherits the security document's sequence rather than
restating a subset of it, so the two cannot drift apart again.

## 7. Cutover must be lossless and restartable

**Correction (was wrong in revision 1).** Revision 1 said no file-to-Postgres
path exists and that both backfills are new work. False:

- `migrations/001_initial_schema.sql:5` **already creates the `sessions` table**.
  The live deployment lacks it because that migration family has not been
  applied there, not because the schema is missing.
- `src/migrate-sessions.ts:215` **already implements** a transactional
  `sessions.json` to Postgres migration, with rollback on active-pointer
  conflict and substantial tests.

**Correction (revision 3 was wrong, and this is the most consequential defect
found in three review rounds).** Revision 3 said only the transcript backfill is
genuinely new. That is false, and believing it would have destroyed exactly the
data this document exists to protect.

Measured in the live SQLite store on 2026-08-13:

| Table                                                              | SQLite rows |
| ------------------------------------------------------------------ | ----------- |
| `jobs`                                                             | 31,895      |
| `validation_runs`                                                  | 35          |
| `validation_receipts`                                              | 14          |
| `requests` joined to `jobs` on `requests.id = jobs.correlation_id` | **30,879**  |

Postgres holds roughly 3,305 jobs. There is **no SQLite-to-Postgres job or
validation migrator anywhere in the tree**; the earlier cutover switched the
write target and abandoned the old rows in place.

So moving transcripts alone would carry 34,000 request rows into Postgres while
leaving the 31,895 jobs that produced 30,879 of them behind in a file. The
result is the _same_ defect stated in section 1, transcripts and their jobs in
different engines and unjoinable, merely inverted. A migration that recreates
the problem it was designed to fix is worse than no migration.

Three subsystems therefore need a decision, not one:

- **transcripts**: new backfill, genuinely required
- **jobs and validation state**: either a lossless backfill of the 31,895 rows,
  or an explicit, reconciled archival-and-discard decision recorded here
- **sessions**: `migrate-sessions.ts:215` already exists

The archival option is legitimate, since much of that history may not be worth
carrying. But it must be a decision with a reconciliation record, not a silent
consequence of migrating one table.

Revision 1's sequence was also unsafe: it switched storage and config before
backfilling, and named an already-stale snapshot as the source. A correct
protocol needs, at minimum:

- a write freeze or a dual-write plus delta phase
- a high-water mark, so the copy is restartable
- an idempotency and conflict policy for re-runs
- an explicit policy for the **3,455 rows with `owner_principal IS NULL`**
  (verified in the live store), which `principalCanAccess` currently exposes to
  `local` and a naive equality RLS policy would hide
- any encryption transformation applied during the copy
- reconciliation (row counts and checksums) before cutover
- an atomic selector cutover, and a rollback path

The backup at `/srv/data/backups/llm-cli-gateway/` is a point-in-time snapshot
(34,373 rows, `integrity_check` ok). The live store had already advanced past it
during review, to 34,382 rows. It is a safety net, **not** the backfill source.

## 8. Open questions

- **Does `sessions.json` need migrating, or expiring?** `migrate-sessions.ts`
  exists, so the cost is low, but the question of whether historical sessions
  are worth carrying is still open.
- **Transaction scope across subsystems.** Once sessions, jobs and requests
  share one Postgres instance, cross-subsystem writes could become
  transactional. Decide deliberately.
- **Does the port expose a pool-routing seam?** The security plan needs distinct
  reader and analytics roles. The current generic `queryRequests` signature
  offers no seam for choosing between them.

## 9. Required evidence before implementation

Deliverables that must exist before this design can be graded as more than a
proposal:

- **Semantic dialect inventory**: every SQL construct, placeholder form, cast,
  time function, upsert and isolation assumption, per engine. Not token counts.
- **Type-directed call-surface audit** of `FlightRecorder`, `JobStore`,
  `ISessionManager` and the validation stores, including tests.
- **SQLite async-wrapping benchmark** on a representative 1.2 GB database at
  measured and worst-case request rates, reporting p50/p99 request latency,
  event-loop delay, WAL contention and shutdown drain time.
- **Write-ordering design and tests** covering every failure mode in 3.4,
  including cross-process orphan completion and crash-restart.
- **Ratchet implemented in CI**, with the ADD-form negative control.
- **Cutover rehearsal** against a copy, with reconciliation output.
