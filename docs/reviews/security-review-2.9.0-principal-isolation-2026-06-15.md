# Security Review Spec — llm-cli-gateway 2.9.0 per-principal isolation

**This document is the corrective-program spec / verification report under adversarial cross-LLM review.**
You (the reviewing model) must verify every claim below against the ACTUAL CODE in this repository,
not against this summary. Open the files, read the cited line ranges, and confirm or refute each claim
with file:line evidence. Do not approve on intent, plan-compliance, or "should be fixed" grounds.

## Review target (exact)

- Repo: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`
- Branch: `master`
- HEAD commit: `079947e804d085be55af566a01a5991500c01748`
- Working tree: clean except one untracked doc (`docs/launch/social-2.9.0.md`) which is OUT OF SCOPE.
- Scope: the repository in its current state at HEAD, concentrating on the 2.9.0 remote-transport +
  per-principal ownership surface. There is no in-flight code diff; review the code as it stands.

## Threat model (the premise the findings rely on — verify it holds)

2.9.0 added remote HTTP transport (`src/http-transport.ts`) with authentication: static bearer token,
OAuth 2.0 server (`src/oauth.ts`), and a trusted-principal-header seam (`src/auth.ts`). Each remote
caller is assigned a principal (`authPrincipal = trustedPrincipal ?? auth.clientId`,
`src/http-transport.ts` ~238). The product promise is per-principal isolation: every session, job and
stored request is owned by a principal so one caller never sees another's work, and remote calls are
refused unless a workspace is registered. Isolation is enforced via `principalCanAccess` /
`resolveOwnerPrincipal` in `src/request-context.ts`.

The two findings below assert this isolation is NOT enforced on the `*_request` / `*_request_async`
execution handlers, only on the bookkeeping tools. Verify both the premise and the gap.

---

## Finding 1 (HIGH) — IDOR / cross-principal session takeover

**Claim:** The execution handlers resolve a caller-supplied `sessionId` through
`getExistingSessionForProvider` (`src/index.ts` ~3607-3620), which checks ONLY the provider type, never
the owner, then resumes the underlying CLI conversation with that id. No `principalCanAccess` check
exists anywhere in the `*_request` / `*_request_async` span, unlike the bookkeeping tools.

**Evidence to verify (read these yourself):**
1. `src/index.ts` ~3607-3620 (`getExistingSessionForProvider`): confirm it validates `existing.cli !==
   provider` only and returns `existing` with no owner/principal check.
2. `src/session-manager.ts` ~194-202 (`getSession`) and `src/session-manager-pg.ts` ~76 — confirm the
   data-layer getter does no owner filtering.
3. `src/index.ts` ~5930-5934 (claude sync `args.push("--session-id", effectiveSessionId)`), ~7596-7606
   (claude async), ~6470-6471 (codex) — confirm the caller-supplied id is used to resume the CLI.
4. Contrast: confirm the bookkeeping tools DO check ownership — `session_get` (~9618), `session_delete`
   (~9683), `session_list` (~9460), `session_set_active` (~9534), `llm_job_status/result/cancel`
   (~8620/8682/8773), `llm_request_result` (~8880). Confirm the `*_request` handlers do NOT.
5. No-guess leak paths (these make the unguessable-UUID objection moot — verify both):
   - `src/resources.ts` ~278-306 (`sessions://all` / session resource): confirm it returns session ids
     across ALL principals with no owner filtering, unlike the owner-filtered `session_list` tool.
   - `src/session-manager.ts` ~247-258 (`getActiveSession`): confirm the active-session pointer is keyed
     by `cli` only (no principal dimension), and `src/index.ts` ~5882 consumes it via `useContinue` for a
     no-arg request.

**Asserted impact:** In a multi-principal remote deployment, principal A calls
`claude_request{ sessionId: "<B's id>" }` and resumes/reads principal B's private conversation.

**Asserted fix:** Add own-or-not-found guard
(`principalCanAccess(existing.ownerPrincipal, resolveOwnerPrincipal(getRequestContext()))`) in
`getExistingSessionForProvider` and owner-filter the `sessions://*` resource provider.

**Confidence asserted: 8/10 (HIGH).**

---

## Finding 2 (HIGH) — Workspace-isolation bypass via foreign session metadata

**Claim:** Workspace/worktree selection is driven by the referenced session's stored metadata with no
ownership check, and the "remote requests require a registered workspace" gate is satisfied by the
VICTIM's metadata. So a remote caller with no registered workspace executes a CLI inside another
principal's workspace/worktree.

**Evidence to verify (read these yourself):**
1. `src/index.ts` ~1010-1024 (`resolveWorkspaceAndWorktreeForRequest`): confirm `session =
   getSession(args.sessionId)` with no owner check, and `session?.metadata?.workspaceAlias` drives
   `resolveWorkspaceForProvider`.
2. `src/index.ts` ~1035: confirm the remote-workspace gate (`if (!workspace && isRemoteTransport) throw`)
   passes because `workspace` is non-null from the victim's session metadata.
3. `src/index.ts` ~952-968 (`resolveWorktreeForRequest`): confirm `session.metadata.worktreePath` is used
   verbatim as the spawn `cwd`.
4. `src/workspace-registry.ts` ~324-345 (`resolveWorkspaceForProvider`): confirm it reads
   `sessionMetadata.workspaceAlias` with no owner argument.
5. `src/executor.ts` ~478-482: confirm `cwd` threads into `spawnCliProcess(command, args, { cwd })`, i.e.
   real file access in the victim's worktree.

**Asserted impact:** Principal A (no own workspace) calls `codex_request{ sessionId: "<B's id>",
worktree: true, prompt: "cat .env; git log -p" }` and the CLI runs with B's worktree as cwd — A reads/
writes B's repository files.

**Asserted fix:** Resolve the session for workspace/worktree selection only after the Finding-1 ownership
guard; otherwise fall back to the remote-must-register error.

**Confidence asserted: 8/10 (HIGH).** Depends on the same unowned-`sessionId` reference as Finding 1.

---

## Findings DELIBERATELY DROPPED (verify the drop rationale too)

The review ran adversarial false-positive filters and DROPPED the following. If you believe any drop is
wrong, say so with code/doc evidence.

1. **Active-session pointer not principal-scoped** (`src/session-manager.ts` ~247) — confirmed real but
   scored 7/10 (only bites in opt-in multi-tenant config); folded into Finding 1 as a no-guess vector.
2. **Claude `settings` passthrough → hooks RCE** and **remote bypass/danger flags**
   (`src/request-helpers.ts` ~739, ~393; `src/index.ts` ~2614) — DROPPED (3/10, 2/10): pre-date 2.9.0
   and grant no privilege an authenticated caller lacks via a normal `prompt` + `allowedTools:["Bash"]`
   (intended capability). One noted hardening gap: the opt-in `mcp_managed` approval gate
   (`approvalManager.decide`) does not inspect the `settings` field.
3. **secret-redaction misses quoted-JSON `"key":"value"`** and **case-sensitive `Bearer`**
   (`src/secret-redaction.ts` ~58-81) — regex gaps confirmed real but DROPPED (2/10) under the review's
   exclusions: at-rest `logs.db` is 0600-secured, the leaked value is the caller's OWN pasted secret, and
   the only verbatim-prompt readback (`llm_request_result`) is owner-gated.
4. **OAuth PKCE-downgrade for public clients, sentinel-namespace collision, `x-forwarded-proto` trust**
   (`src/oauth.ts`, `src/request-context.ts`, `src/http-transport.ts`) — 3–6/10, all require operator
   misconfiguration of non-default knobs; not default-reachable by a remote attacker.

---

## Your task as reviewer

1. Read the cited code yourself. For EACH finding (1 and 2) and EACH drop, state CONFIRMED or REFUTED
   with specific file:line evidence you personally inspected.
2. If you find the review MISSED a HIGH/MEDIUM exploitable vulnerability in the same surface, report it
   with file:line and an exploit path.
3. Give either UNCONDITIONAL APPROVAL (the review's findings + drops are correct and complete to your
   inspection) or ONE concrete, specific blocker. Do not approve on intent or plan-compliance.
