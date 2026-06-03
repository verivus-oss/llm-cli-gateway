# XState Store v4 integration — plan summary (for human review)

Companion prose for `docs/plans/xstate-store-integration.dag.toml`. The DAG is
the authoritative, executable plan; this document is the human-facing rationale,
phasing, and decision-point summary.

## Problem

`llm-cli-gateway` already has two stateful surfaces:

- **Sessions** (`session-manager.ts`) — CLI continuity (Claude `--continue`,
  Codex `exec resume`, etc.). Deliberately stores *no* conversation content.
- **Flight recorder** (`flight-recorder.ts`) — append-only request/response
  telemetry in `~/.llm-cli-gateway/logs.db`.

Neither is a place for an orchestrating agent to keep **small, structured,
evolving workflow state** — "which step am I on", "have I run review yet", a
bounded set of counters/flags/enums — in a way that (a) survives a gateway
restart, (b) is readable as a snapshot, (c) only changes through explicit,
schema-validated events, and (d) can refuse invalid transitions. Today an agent
has to smuggle that into prompts or external files.

`@xstate/store` v4 is a good fit: explicit events, strong schemas (Standard
Schema / Zod), `.can` guards, pure `transition()` previews, and `.with(...)`
extensions. It gives LLMs a small, inspectable, versionable state object to
reason about.

## What I verified about `@xstate/store` v4

Confirmed against the official v4 docs (`stately.ai/docs/xstate-store`, the v4
migration guide, the persist and validate-schemas pages) on 2026-05-30:

- **Package**: `@xstate/store`; needs TypeScript ≥ 5.4 (repo runs TS 6.x — fine).
- **Store creation is config-object form ONLY in v4**:
  `createStore({ context, on, schemas })`. The legacy two-arg
  `createStore(context, transitions)` was **removed** in v4. (The user's sketch
  used the removed form.)
- **Snapshot**: `store.getSnapshot()` / `store.get()`, with `.context`.
  `store._snapshot` was removed.
- **Dispatch**: `store.send({ type, ...payload })` and
  `store.trigger.<event>(payload)`. `xstate_send({event, payload})` maps to
  `store.send`.
- **Guards**: `store.can.<event>(payload) → boolean`. NOT the single-arg
  `.can(event)` from the user's sketch. A transition returning `undefined`
  marks the event as not allowed.
- **Pure preview**: `store.transition(snapshot, event) → [nextState, effects]`
  without mutating — used for the Phase 4 consensus dry-run.
- **Schemas/Zod**: v4 accepts Standard Schema libraries (Zod included). By
  default schemas are types/metadata only; **runtime validation is opt-in** via
  `validateSchemas()` from `@xstate/store/validate`, attached with `.with(...)`.
- **Extensions are real** and attach via `.with(...)`: `undoRedo()`,
  `persist()`, `reset()`, `validateSchemas()`.

What I could **not** verify / flagged:

- **"~1kb minified+gzipped"** is the publisher's marketing claim for the *core*
  package only. Tarball inspection shows the core ESM ~2.3KB packed and an
  internal chunk ~20KB unminified; the `persist` extension is a separate ~19KB
  chunk. Operationally irrelevant for a headless Node server, but the README
  must not repeat "~1kb" as fact.
- **The `persist` extension is browser/RN-oriented** (localStorage,
  sessionStorage, AsyncStorage, IndexedDB, BroadcastChannel). There is **no
  first-party SQLite adapter**. So the design does **not** use `persist` for
  durability — the gateway serializes snapshots to SQLite itself.
- The exact published v4 patch version is **not pinned** in the plan (PLAN-only
  constraint); the research step pins it and re-checks every API against the
  installed `.d.ts` before any code is written.

## Proposed surface

Grounded in real extension points in the codebase:

- **New module `src/xstate-store-engine.ts`** — the only file importing
  `@xstate/store` (mirrors how `flight-recorder.ts` is the sole
  `better-sqlite3` importer). Wraps a definition→instance→snapshot model.
- **Tools** (snake_case, Zod at the boundary, structured `createErrorResponse`):
  `xstate_send`, `xstate_get_snapshot`, `xstate_can`, plus (durable, gated)
  `xstate_create_store` and `xstate_delete_store`.
- **Resources** (read-only; state, never content): `agent_state://catalog` and
  `agent_state://{storeId}`, registered in `registerBaseResources` next to the
  existing `cache_state://*` resources, served through `ResourceProvider`.
- **Config**: a new `[agent_state]` block loaded by a separate
  loader/schema in `src/config.ts` (mirrors `loadCacheAwarenessConfig` so a
  malformed block can't break persistence loading), threaded through
  `GatewayServerRuntime` exactly like `cacheAwareness`.
- **Persistence**: `src/store-persistence.ts` with
  `SqliteStorePersistence` / `MemoryStorePersistence` / `PostgresStorePersistence`
  (stub) + `createStorePersistence(config)` returning `null` for
  `backend="none"` — a 1:1 mirror of `job-store.ts`. New tables
  (`agent_state_definitions`, `agent_state_instances`) live in the **same**
  `logs.db` file, so there is one durable artifact to back up.

### Security cornerstone

`@xstate/store` transitions are JS functions. Agents must **never** supply
executable code. Definitions are **declarative, data-only**: a restricted DSL
(`set`/`inc`/`dec`/`push`/`pop`/`setEnum` with optional guards) that the gateway
compiles into real transitions. This mirrors `review-integrity.ts`'s posture of
refusing to trust orchestrator-supplied capability.

### Storage-invariant preservation

The store holds structured state (counters, flags, enums, small JSON), **not**
prompt/response text. Enforced by a context-size cap (default 16 KB) and a
"no long free-text" rule on every write. Snapshots are structurally redacted
(no `prompt`/`response`/`system`/`task` field by construction).

## Phasing (incremental, easiest → most powerful)

1. **Phase 1 — read-only resource + dispatch (ephemeral).** In-memory registry,
   `xstate_send`/`get_snapshot`/`can`, `agent_state://` resources. Fastest path
   to a usable surface; ships and soaks first as its own minor release.
2. **Phase 2 — durability + config gate.** `[agent_state]` config, SQLite-backed
   `StorePersistence`, and the **structural invariant**: with `backend="none"`
   (or `enabled=false`) the durable/authoring tools are not registered at all —
   the exact mirror of `persistence.asyncJobsEnabled`.
3. **Phase 3 — authoring + skill memory.** `xstate_create_store`, and a
   `SKILL.md` → `store.toml` binding so a distilled skill ships its
   (operator-authored, version-controlled) state definition and allowed events;
   the gateway becomes the runtime executor — without trusting agent code.
4. **Phase 4 — consensus gate (opt-in).** `requireConsensus` on `xstate_send`:
   compute a no-mutation `transition()` preview, route a *state-only* prompt
   through the gateway's existing `consensus_check`/validation tools, commit
   only on pass. Short-circuits on `.can=false` before any model spend.

Each phase is independently config-gated and revertable. Phase 4 ships last.

## Risks and trade-offs

- **Arbitrary-code risk** from JS transitions → neutralized by the data-only
  DSL; agent JS is never eval'd.
- **Storage-invariant erosion** (context as a backdoor content store) →
  size/length caps + structural redaction.
- **API divergence** from the user's sketch (removed two-arg `createStore`,
  single-arg `.can`) → design uses the verified v4 shapes; research step
  re-pins the version.
- **Bespoke persistence layer** instead of the `persist` extension → mitigated
  by mirroring the proven `job-store.ts` pattern 1:1.
- **Surface bloat** — a third stateful surface could confuse agents about where
  state belongs.
- **Consensus cost/latency** (Phase 4) — strictly opt-in.

## Decision points needing a human call

1. **Storage-invariant strictness (Q1):** is "16 KB context cap + per-field
   length cap" a strong-enough structural guarantee, or do we want an
   allow-listed value-type policy (scalars/enums only)?
2. **Trusted operator JS definitions (Q2):** should there ever be an
   operator-authored (disk-loaded, reviewed) JS-transition path, like skills?
   Agent-authored JS stays a hard no regardless.
3. **`xstate_send` tier when persistence is off (Q3):** read-tier (works
   against the ephemeral default store) or write-tier (gated)? Plan default:
   available but flagged `durable: false` in the response.
4. **Is the surface worth it?** Does the agent-state engine justify a third
   stateful surface, or should it ship behind a louder "experimental" flag?
5. **Consensus defaults (Phase 4):** should any transitions default to
   consensus, or must it always be caller-explicit?

## Constraints honored

snake_case tool names; Zod at boundaries; explicit return types; stderr-only
logging; no conversation content in storage; structural gate-on-config (disabled
backend registers no tools); DRY single-importer module; ≥ 80% coverage plus the
standing strict-evidence mutation-probe veracity audit and multi-LLM review gate.
This document and the DAG are a **plan only** — no source, `package.json`, or
dependencies were changed.
