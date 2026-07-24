# Mistral Kit M3 review brief (evidence-cite against the code, not this summary)

Branch `feature/mistral-kit-m3`, HEAD commit `4ab4f4b`, in repo
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Diff: `git show 4ab4f4b`
(or `git diff master...feature/mistral-kit-m3`). Plan: `docs/plans/mistral-kit-provider.dag.toml`
(step `M3-union-widen-gate-flip-wire`). M3 wires the mistral provider into the
Personal Agent Config Kit (M0-M2 were dormant groundwork).

## What changed (verify each against the files)

1. Gate flip: `rejectUnsupportedKitProvider` (src/index.ts) admits mistral.
   `validateKitRequestSurface` (src/personal-config.ts) already admitted mistral (M2).
2. M2 conflict-list correction: the mistral schema defaults `transport:"cli"`, so
   `"transport"` as a plain conflict field rejected EVERY Kit request. Now only
   `transport:"acp"` is a conflict (special-case, like `approvalStrategy:"mcp_managed"`),
   and the handler's ACP branch is rejected when Kit is enabled (isolation bypass).
3. Union widening across the Kit machinery + reconcile guards + session label +
   `recoverUnadmittedPersonalKitAttempt` + its `z.enum` + async terminal-metadata dispatch.
4. `handleMistralRequest` Kit path (src/index.ts): context resolve, M1 isolation build
   (fail-closed on missing `MISTRAL_API_KEY`), durable lease claim (gateway-managed
   continuity; caller session args conflict-rejected), prompt-prefix context delivery with
   `assertMistralKitContextPrefix` digest check, forced `accept-edits`, kit-aware
   flight/FR/envelope/awaitJobOrDefer + `finalizeKit` (disk native capture) + retry disabled.
5. `mistralKitSpawnEnvFragment` (src/mistral-kit-isolation.ts): the executor-merge
   projection (delete ambient `VIBE_*`/scrub, apply only gateway levers); gateway
   `VIBE_ACTIVE_MODEL` re-applied after the strip. Env-contract allowlist extended.
6. Async native capture: process-local `kitNativeCaptureHome` on the job so the deferred
   terminal path uses `createVibeKitTerminalMetadata(home)` (disk), never stdout.

## HEADLINE QUESTION (please adjudicate against the code + installed vibe)

Mistral Kit conflict-rejects `sessionId`/`createNewSession`, so continuity is fully
gateway-managed: every 2nd+ request auto-continues the active Kit session and thus sets
`resume=true` -> emits `vibe --resume <uuid>`. BUT `createMistralKitIsolationPlan`
`mkdtempSync`-es a FRESH `VIBE_HOME` per request (src/mistral-kit-isolation.ts:164), and
`vibe --resume <uuid>` reads the session from `VIBE_HOME/.vibe/logs/session/`. The prior
request's session logs live in the PRIOR ephemeral home, not the new one.

- Does `vibe --resume <missing-uuid-in-this-home>` HARD-FAIL, or start a fresh session
  gracefully? (Mistral: please check the installed vibe source / behavior.)
- If it breaks continuity: is the right fix (a) a stable gateway-owned `VIBE_HOME` per Kit
  execution scope with a relaxed manifest that still forbids ambient skills/agents/tools;
  (b) relocating only the session/log dir to a stable path (e.g. a gateway-set save-dir)
  while keeping the config home fresh+isolated; or (c) accept no cross-request native
  continuity for M3 (kit context is re-injected via the prompt prefix each request) and
  defer stable-home continuity to a follow-up?
- Whatever the answer, is the CAPTURE + `--resume` wiring itself correct?

## Other review lenses

- Isolation-boundary: does `mistralKitSpawnEnvFragment` + the re-applied `VIBE_ACTIVE_MODEL`
  produce a child env with no ambient `VIBE_*`/skill leakage, and does routing the fragment
  (not `applyMistralKitIsolationEnv`'s full env) through the merge-executor preserve the
  isolation guarantee AND the extended PATH?
- Native-id guard: disk capture gated on `isVibeNativeSessionId`; process-local; null after
  restart. Correct + no cross-attribution?
- Fail-closed: missing auth, ambient leak (M1 manifest), conflict fields, ACP-under-Kit,
  digest drift, durable-store-unavailable.
- Principal isolation: no caller `sessionId`/`workingDir`/`worktree` threaded; the Kit
  session lease owns rollback.
- Generic-machinery correctness: attempt lease claim/finalize, deferred terminal event,
  recovery fence, no durable persistence of native handles or the capture home.
