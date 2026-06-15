# Security FIX verification report — 2.9.0 per-principal isolation (request handlers)

**This document is the corrective-program spec under adversarial cross-LLM review.**
Verify every claim against the ACTUAL CODE and the ACTUAL DIFF. Do not accept this summary as
evidence. Approve only on inspected code + tests you confirmed pass.

## Exact review target

- Repo: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`
- Branch: `fix/principal-isolation-request-handlers`
- Base (unfixed): `079947e804d085be55af566a01a5991500c01748`
- Fix commit (HEAD): `9e7428c936c4f96cb628f0a2d6d200a428e06d9a`
- Diff under review: `git diff 079947e..9e7428c` (equivalently `git show 9e7428c`)
- Changed files: `src/index.ts`, `src/resources.ts`,
  `src/__tests__/f3b-request-handler-isolation.test.ts`,
  `docs/reviews/security-review-2.9.0-principal-isolation-2026-06-15.md` (the prior finding spec).

## What was broken (confirmed HIGH findings, cross-LLM-approved 2026-06-15)

- **F1 IDOR / cross-principal session takeover.** `getExistingSessionForProvider` checked provider
  type only; the `*_request`/`*_request_async` handlers resumed a caller-supplied `sessionId` with no
  ownership check. No-guess vectors: the global-per-cli active-session pointer and the unfiltered
  `sessions://*` resources.
- **F2 workspace-isolation bypass.** `resolveWorkspaceAndWorktreeForRequest` / `resolveWorktreeForRequest`
  drove workspace + worktree cwd from the referenced session's metadata with no ownership check, so the
  remote "registered workspace" gate was satisfiable by a victim's session metadata.

## The implemented fix (verify each against the diff)

All in `src/index.ts` unless noted. Line numbers are post-fix.

1. **Shared ownership primitive + own-or-not-found helpers** (new, ~3612–3672):
   - `callerCanAccessSession(session)` = `principalCanAccess(session.ownerPrincipal, resolveOwnerPrincipal(getRequestContext()))`.
   - `getCallerOwnedSession(sm, sessionId)` → returns the session only if the caller may access it, else `null`.
   - `getCallerOwnedActiveSession(sm, provider)` → owner-filtered active pointer.
2. **`getExistingSessionForProvider` now throws on a foreign id** (~3674): ownership checked
   **before** the provider-type comparison (so a foreign session never leaks its `cli`). This is the
   choke point for all handlers that route caller `sessionId` through it (claude sync ~5891, claude
   async ~7596, codex sync ~6358, grok-api ~3675/3727, gemini, grok, mistral, codex_fork). Throwing is
   the same failure contract those call sites already handled for the provider-mismatch case.
3. **Active-pointer adoption owner-filtered** at all five request-handler sites: grok-api (~3695),
   codex async (~5314), claude sync (~5875), codex sync usage-tracking (~6459), claude async (~7587).
4. **codex async caller-supplied id validated** (~5325): this path does not route through
   `getExistingSessionForProvider`, so it now calls it explicitly before `updateSessionUsage`/resume;
   the foreign-id throw is caught by the existing outer catch (~5475 → `createErrorResponse`).
5. **Workspace/worktree resolvers ignore foreign sessions**: `resolveWorktreeForRequest` (~953) and
   `resolveWorkspaceAndWorktreeForRequest` (~1010) fetch via `getCallerOwnedSession`, so a foreign
   session's `workspaceAlias`/`worktreePath` cannot select the workspace or become the spawn cwd, and
   the remote-workspace gate (~1035) can no longer be satisfied by foreign metadata.
6. **`src/resources.ts`**: new `ownedSessions()` + `ownedActiveId()` helpers; `sessions://all` and the
   five per-provider `sessions://<cli>` resources are owner-filtered (rows + active pointer). Resource
   reads run inside `runWithRequestContext` (http-transport.ts:268/290 wrap `handleRequest`), so
   `getRequestContext()` resolves the caller principal.

## Behavioural notes (verify these are intended, not regressions)

- Default stdio / single static-bearer deployments collapse to one principal (`"local"` or
  `"gateway-bearer"`), so `principalCanAccess` is always true and there is **no behaviour change** —
  confirmed by the full suite still passing.
- A caller resuming a *foreign* id gets an error (`Session <id> is not accessible`); a caller
  supplying a *non-existent* id still creates an owned session (unchanged); a caller resuming their
  *own* id is unaffected.

## Verification evidence (reproduce these)

- `npm run build` → clean (0 TS errors).
- `npm run lint` (CI gate, `eslint src/**/*.ts`) → 0 errors. (Direct `eslint src/index.ts` surfaces 8
  PRE-EXISTING errors at lines 115/116/792/3110/4175/4294/5427/6450 — none in the changed ranges.)
- `npx vitest run` → **1515 passed** (92 files); was 1506 + 9 new.
- New regression suite `src/__tests__/f3b-request-handler-isolation.test.ts` (9 tests — 8 deny/leak-hiding
  checks + 1 owner-not-blocked positive check) proves:
  claude_request / codex_request / codex_request_async refuse a foreign session id; no provider-leak on
  a foreign id; the owner is NOT blocked on their own id; `sessions://all` and `sessions://claude` hide
  another principal's ids; the active pointer is hidden cross-principal; the local principal sees
  legacy-unowned + local rows only. These tests FAIL against base `079947e` (pre-fix) and PASS at HEAD.

## Reviewer task

Read `git show 9e7428c` and the cited code. For each fix item (1–6) state CONFIRMED or REFUTED with
file:line you inspected. Specifically check: (a) is there any remaining `*_request`/`*_request_async`
path that resumes/usage-bumps/reads-metadata for a caller-supplied or active-pointer session without an
ownership check? (b) does the ordering in `getExistingSessionForProvider` actually prevent a provider
leak? (c) are all six `sessions://*` resources filtered, and does the resource path actually have the
request context? (d) any new correctness regression for the legitimate owner / single-principal path?
Run the build + tests yourself if you can. Give UNCONDITIONAL APPROVAL or ONE concrete blocker with
file:line. Do not approve on intent or "should be fixed" language.
