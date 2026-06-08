# Provider-Owned Sessions Audit

Date: 2026-06-08
Plan: `docs/plans/provider-owned-sessions.dag.toml`
Scope: current working tree, request/session ownership only.

## Summary

Stored gateway sessions are already provider-owned at the session-store and
`session_set_active` boundary, but request handlers enforce that ownership
inconsistently.

Covered today:

- `grok_api_request` rejects existing non-`grok-api` sessions before API
  metadata mutation.
- `grok_request` and `grok_request_async` reject existing non-`grok` sessions
  before spawning or starting async jobs.
- `session_set_active` rejects cross-provider assignment through both file and
  PostgreSQL session managers.

Gaps today:

- `claude_request`, `claude_request_async`, `codex_request`,
  `codex_request_async`, `gemini_request`, `gemini_request_async`,
  `mistral_request`, `mistral_request_async`, and `codex_fork_session` do not
  reject an existing stored session whose `cli` belongs to another provider.
- Several gap paths call `resolveWorktreeForRequest` before ownership has been
  checked, so a wrong-provider session can expose or update
  `metadata.worktreePath`.

## Request Handlers

| Surface | Provider | Status | Current behavior | Required next step |
| --- | --- | --- | --- | --- |
| `grok_api_request` | `grok-api` | Covered | `resolveGrokApiSession` rejects existing sessions whose `cli` is not `grok-api` before `updateSessionMetadata` or `updateSessionUsage`. See `src/index.ts:3233-3239`. | Replace local logic with shared helper or keep behavior while using same error contract. |
| `grok_request` | `grok` | Covered | Calls `validateExistingSessionProvider(..., "grok")` before `resolveWorktreeForRequest` and `awaitJobOrDefer`. See `src/index.ts:4018-4025`. | Keep behavior; migrate to shared helper if introduced. |
| `grok_request_async` | `grok` | Covered | Calls `validateExistingSessionProvider(..., "grok")` before pre-start session I/O, worktree resolution, and `startJob`. See `src/index.ts:4232-4239`. | Keep behavior; migrate to shared helper if introduced. |
| `gemini_request` | `gemini` | Gap | For a user-provided resume ID, resolves worktree and spawns via `awaitJobOrDefer` before any `getSession` lookup. Post-success lookup creates/updates a `gemini` row only if no row exists; it does not reject an existing wrong-provider row. See `src/index.ts:3590-3616` and `src/index.ts:3662-3673`. | Validate existing stored session as `gemini` immediately after `resolveGeminiSessionPlan` and before `resolveWorktreeForRequest` or `awaitJobOrDefer`. |
| `gemini_request_async` | `gemini` | Gap | For a resumed session, does pre-start `getSession`, may create a `gemini` row, then updates usage without checking `existing.cli`; starts job afterward. See `src/index.ts:3773-3820`. | Validate existing stored session as `gemini` before create/update usage, worktree resolution, and `startJob`. |
| `mistral_request` | `mistral` | Gap | Adds resume args, resolves worktree, and spawns before post-success `getSession`; post-success lookup does not reject an existing wrong-provider row. See `src/index.ts:4414-4438` and `src/index.ts:4517-4528`. | Validate existing stored session as `mistral` before `resolveWorktreeForRequest` and `awaitJobOrDefer`. |
| `mistral_request_async` | `mistral` | Gap | Pre-start `getSession` may observe an existing wrong-provider row, but the code neither rejects it nor creates a replacement; it then updates usage and starts the job. See `src/index.ts:4628-4677`. | Validate existing stored session as `mistral` before usage update, worktree resolution, and `startJob`. |
| `codex_request` | `codex` | Gap | `prepareCodexRequest` rejects `gw-*` native resume IDs, but the handler never checks whether a non-`gw-*` session ID is an existing gateway row for another provider. It also resolves worktree before spawning. See `src/index.ts:5863-5895` and `src/index.ts:5926-5941`. | Validate existing stored session as `codex` before `resolveWorktreeForRequest` and `awaitJobOrDefer`; preserve native Codex ID behavior when no stored row exists. |
| `codex_request_async` | `codex` | Gap | For user-provided session IDs, updates usage before checking stored provider and before `startJob`. Also resolves worktree after that update. See `src/index.ts:4815-4867`. | Validate existing stored session as `codex` before `updateSessionUsage`, worktree resolution, and `startJob`; run local cleanup on guard failure when a temp output schema exists. |
| `codex_fork_session` | `codex` | Gap | Prepares and spawns `codex fork <sessionId>` without consulting the gateway session store. `prepareCodexForkRequest` rejects `gw-*`, but not an existing non-`codex` stored row. See `src/index.ts:6099-6133`. | If `sessionId` is supplied and a stored row exists, validate it as `codex` before `awaitJobOrDefer`; preserve native Codex ID behavior when no stored row exists. |
| `claude_request` | `claude` | Gap | Active-session fallback is provider-scoped, but a user-provided stored session is not checked before `--session-id`, `updateSessionUsage`, worktree resolution, or spawn. Post-success lookup creates only if missing; it does not reject wrong-provider rows. See `src/index.ts:5364-5385`, `src/index.ts:5420-5449`, and `src/index.ts:5500-5505`. | Validate existing effective session as `claude` after active-session resolution and before TTL warning, `safeFlightStart`, usage update, worktree resolution, or `awaitJobOrDefer`. |
| `claude_request_async` | `claude` | Gap | Active-session fallback is provider-scoped, but a user-provided stored session is not checked before `--session-id`, `updateSessionUsage`, session creation, worktree resolution, or `startJob`. See `src/index.ts:7150-7210`. | Validate existing effective session as `claude` before usage update, session creation, TTL warning, worktree resolution, and `startJob`. |

## Session Tools And Stores

| Surface | Status | Notes |
| --- | --- | --- |
| `session_create` | Covered | Uses `SESSION_PROVIDER_ENUM`, now including `grok-api`, and creates the row under the requested provider. See `src/index.ts:8831-8852`. |
| `session_list` | Covered | Lists sessions by provider and active sessions across `SESSION_PROVIDER_VALUES`, including `grok-api`. See `src/index.ts:8884-8934`. |
| `session_set_active` | Covered | Delegates to `sessionManager.setActiveSession`, which rejects missing or wrong-provider sessions. See `src/index.ts:8948-8965`, `src/session-manager.ts:221-229`, and `src/session-manager-pg.ts:120-124`. |
| `session_delete` | Not applicable | Deletes by ID regardless of provider; this is intentional session lifecycle behavior. See `src/index.ts:9011-9045`. |
| `session_get` | Not applicable | Reads by ID and computes active state from the stored `session.cli`. See `src/index.ts:9074-9109`. |
| `session_clear_all` | Covered | Optional provider filter uses `SESSION_PROVIDER_ENUM`, including `grok-api`. Store deletion is by stored provider. |
| `FileSessionManager` | Covered | `setActiveSession` rejects cross-provider assignment. `updateSessionUsage` and `updateSessionMetadata` are ID-only and rely on caller-side ownership validation. |
| `PostgreSQLSessionManager` | Covered | `setActiveSession` rejects cross-provider assignment. `updateSessionUsage` and `updateSessionMetadata` are ID-only and rely on caller-side ownership validation. |

## Worktree Metadata

`resolveWorktreeForRequest` is provider-agnostic and reads/writes
`session.metadata.worktreePath` by session ID only. See `src/index.ts:843-868`.
It is therefore safe only when callers validate provider ownership before
passing an existing stored session ID.

Currently guarded before worktree resolution:

- `grok_request`
- `grok_request_async`

Currently unguarded before worktree resolution:

- `gemini_request`
- `gemini_request_async`
- `mistral_request`
- `mistral_request_async`
- `codex_request`
- `codex_request_async`
- `claude_request`
- `claude_request_async`

`grok_api_request` does not use worktree metadata.

## Validation And Review Wrappers

The validation/review tools registered through `registerValidationTools` do not
expose session IDs directly in the inspected request path. They dispatch model
calls through provider wrappers, so ownership enforcement belongs in the
underlying request handlers above.

## Adjacent Cleanup

`ResourceProvider.readResource("sessions://all")` reports active sessions for
the five CLI providers only and does not include `grok-api`. See
`src/resources.ts:250-271`. This is not a request-boundary ownership bug, but
it is inconsistent with `session_list`, which now reports all
`SESSION_PROVIDER_VALUES`.

## Implementation Notes For Next Step

Add a shared helper that returns the existing matching session or throws on
wrong provider:

```ts
async function getExistingSessionForProvider(
  sessionManager: ISessionManager,
  sessionId: string | undefined,
  provider: ProviderType
): Promise<Session | null>
```

Use it before every operation that can:

- emit provider-native resume/session args for an existing stored session,
- update session usage,
- create provider-specific metadata,
- call `resolveWorktreeForRequest`,
- call `awaitJobOrDefer`,
- call `AsyncJobManager.startJob`.

Keep nonexistent session ID behavior unchanged so provider-native session IDs
that are not gateway records still work where currently supported.
