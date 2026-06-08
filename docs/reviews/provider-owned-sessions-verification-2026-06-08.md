# Provider-Owned Sessions Verification - 2026-06-08

## Objective And Invariant

Implement provider-owned stored gateway sessions end to end.

Core invariant: when a request receives a `sessionId` and that ID already exists
in the gateway session store, the stored row's `cli` value is authoritative. The
request must reject the ID unless `session.cli === expectedProvider`. If no
stored row exists, provider-native session ID behavior is preserved.

Wrong-provider stored IDs must fail before `awaitJobOrDefer`,
`AsyncJobManager.startJob`, `updateSessionUsage`, `updateSessionMetadata`, and
`resolveWorktreeForRequest`.

## Review Scope

Diff range: working tree diff in
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`.

Read-first inputs:

- `CLAUDE.md`: unavailable in this checkout; `rg --files -g CLAUDE.md` returned no matches.
- `AGENTS.md`: read.
- `docs/plans/provider-owned-sessions.dag.toml`: read.
- `docs/plans/provider-owned-sessions.audit.md`: read.
- Current git status/diff: inspected before edits.

Files touched in this implementation pass:

- `src/index.ts`
- `src/resources.ts`
- `src/__tests__/provider-owned-sessions.test.ts`
- `docs/reviews/provider-owned-sessions-verification-2026-06-08.md`

Dirty tracked files in the working tree at report creation:

- `migrations/001_initial_schema.sql`
- `package.json`
- `src/__tests__/grok-handler.test.ts`
- `src/__tests__/migration-pg.test.ts`
- `src/__tests__/persistence-config.test.ts`
- `src/__tests__/session-manager-pg.test.ts`
- `src/__tests__/session-manager.test.ts`
- `src/__tests__/setup.ts`
- `src/config.ts`
- `src/flight-recorder.ts`
- `src/index.ts`
- `src/metrics.ts`
- `src/migrate-sessions.ts`
- `src/resources.ts`
- `src/session-manager-pg.ts`
- `src/session-manager.ts`

Untracked files in the working tree at report creation:

- `docs/plans/grok-0.2.33-contract-sync.dag.toml`
- `docs/plans/grok-api-provider-design.draft.md`
- `docs/plans/provider-owned-sessions.audit.md`
- `docs/plans/provider-owned-sessions.dag.toml`
- `docs/plans/provider-subcommands-scope-expansion.dag.toml`
- `docs/reviews/provider-subcommands-plan-review-2026-06-08.md`
- `migrations/003_provider_type_sessions.sql`
- `scripts/host-upgrade.sh`
- `scripts/systemd/`
- `src/__tests__/grok-api-provider.test.ts`
- `src/__tests__/provider-owned-sessions.test.ts`
- `src/xai-api-provider.ts`

## Implementation Claims

1. Shared provider ownership helper added.
   - `src/index.ts`: `getExistingSessionForProvider(...)` reads an existing
     session by ID, returns `null` when absent, returns the matching row when
     `cli` matches, and throws
     `Session <id> belongs to provider '<actual>', not '<expected>'` when
     stored ownership differs.

2. `grok_api_request` uses shared ownership validation.
   - `src/index.ts`: `handleGrokApiRequest(...)` validates the supplied
     `sessionId` before API key/config checks, flight recording, API calls,
     `resolveGrokApiSession`, `updateSessionMetadata`, or `updateSessionUsage`.
   - `src/index.ts`: `resolveGrokApiSession(...)` also uses the helper before
     creating or reading API session metadata.

3. Sync CLI handlers validate stored session ownership before worktree/spawn.
   - `src/index.ts`: `handleGeminiRequest(...)` validates resumed Gemini IDs
     before `resolveWorktreeForRequest` and `awaitJobOrDefer`.
   - `src/index.ts`: `handleGrokRequest(...)` uses the shared helper before
     `resolveWorktreeForRequest` and `awaitJobOrDefer`.
   - `src/index.ts`: `handleMistralRequest(...)` validates resumed Mistral IDs
     before `resolveWorktreeForRequest` and `awaitJobOrDefer`.
   - `src/index.ts`: `claude_request` validates the effective Claude session ID
     after active-session resolution and before `updateSessionUsage`,
     `resolveWorktreeForRequest`, and `awaitJobOrDefer`.
   - `src/index.ts`: `codex_request` validates user-supplied stored IDs before
     `resolveWorktreeForRequest` and `awaitJobOrDefer`.
   - `src/index.ts`: `codex_fork_session` validates user-supplied stored IDs
     before preparing/spawning `codex fork`.

4. Async handlers validate stored session ownership before mutation/job start.
   - `src/index.ts`: `handleGeminiRequestAsync(...)`,
     `handleGrokRequestAsync(...)`, `handleMistralRequestAsync(...)`,
     `handleCodexRequestAsync(...)`, and `claude_request_async` validate before
     `updateSessionUsage`, `resolveWorktreeForRequest`, and
     `AsyncJobManager.startJob`.
   - Existing absent-row behavior is preserved by the helper's `null` return.

5. Session tool/store provider ownership remains intact.
   - Existing dirty-tree changes already widen session provider types through
     `ProviderType` and `SESSION_PROVIDER_VALUES`.
   - `session_create`, `session_list`, `session_set_active`, and
     `session_clear_all` use `SESSION_PROVIDER_ENUM`, now backed by all
     `PROVIDER_TYPES`.
   - File and PostgreSQL session managers still reject cross-provider
     `setActiveSession` assignment by checking the stored row's `cli`.

6. `sessions://all` includes API-backed providers.
   - `src/resources.ts`: `sessions://all` builds active-session output from
     `PROVIDER_TYPES`, including `grok-api`.

7. Focused regression coverage added.
   - `src/__tests__/provider-owned-sessions.test.ts` covers wrong-provider
     stored sessions for `claude_request`, `codex_request`,
     `codex_fork_session`, `gemini_request`, `grok_request`,
     `mistral_request`, `grok_api_request`, and all five async request
     handlers.
   - The tests assert the error text and assert no `startJob`,
     `updateSessionUsage`, or `updateSessionMetadata` calls occur.
   - The same file covers `sessions://all` reporting active `grok-api`.

## Verification Commands

Completed so far:

- `npx vitest run src/__tests__/provider-owned-sessions.test.ts`
  - Result: passed, 1 test file, 13 tests.
- `npm run build`
  - Result: passed.
- `npx vitest run src/__tests__/session-manager.test.ts src/__tests__/session-manager-pg.test.ts`
  - Result: passed, 1 reported test file, 49 tests. PostgreSQL-specific tests
    are gated by the repo's existing test setup.
- `npx vitest run src/__tests__/grok-api-provider.test.ts src/__tests__/grok-handler.test.ts`
  - Result: passed, 2 test files, 25 tests.
- `npx prettier --write src/index.ts src/resources.ts src/__tests__/provider-owned-sessions.test.ts docs/reviews/provider-owned-sessions-verification-2026-06-08.md`
  - Result: completed. Only `src/__tests__/provider-owned-sessions.test.ts`
    changed.
- Re-run after formatting:
  - `npx vitest run src/__tests__/provider-owned-sessions.test.ts`: passed, 1
    test file, 13 tests.
  - `npm run build`: passed.
- `npm test`
  - Result: passed, 67 test files, 1124 tests.
- `npm run lint`
  - Result: passed with warnings only. Warnings are existing ignored-test-file
    notices plus one warning in `src/__tests__/setup.ts`.
- `npm run format:check`
  - Result: passed.
- `npm pack --dry-run --json`
  - Result: passed. Reported package `llm-cli-gateway-2.3.0.tgz`, 106
    entries, size 247019 bytes, unpacked size 1075888 bytes.

Pending final verification:

- Multi-LLM review and any required fix/re-review iterations.

## Known Limitations

- `CLAUDE.md` was requested but is absent from this checkout. `AGENTS.md` was
  read and followed.
- The working tree had substantial pre-existing dirty tracked and untracked
  files. This pass avoided reverting them.
- This report is for a working-tree diff, not a commit range.

## Review Iterations

- Iteration 0: implementation complete locally. Focused tests and build passed.
  Final local verification passed.
- Review dispatch 1:
  - Claude job `00f288b4-b1d5-4648-8ac3-40b78a4fb5f0` started with
    correlation `provider-owned-sessions-review-claude-20260608`.
  - Gemini initial MCP-managed dispatch was denied by approval policy because
    the gateway scored unavailable ref/exa MCPs plus bypass-style access as too
    high risk.
  - Grok initial MCP-managed dispatch was denied for the same reason.
- Review dispatch 2:
  - Gemini job `edcc9519-f904-4ec3-a6c2-34d9277f6f1c` started with
    correlation `provider-owned-sessions-review-gemini-r2-20260608`, using the
    available `sqry` MCP under legacy approval.
  - Grok job `fbca2db7-4645-4b2c-ad50-e37c50a57dc2` started with correlation
    `provider-owned-sessions-review-grok-r2-20260608`, using the available
    `sqry` MCP under legacy approval.
- Review outcomes:
  - Claude: `APPROVED`. The reviewer verified the helper semantics, all 12
    guard placements, session tool/store behavior, `sessions://all`, focused
    tests, and re-ran verification commands. No findings requiring change.
  - Gemini: `APPROVED`. The reviewer verified guard definition/placement,
    cross-provider active-session protection, provider enum support,
    `sessions://all`, and regression coverage. No findings requiring change.
  - Grok: `APPROVED`. The reviewer inspected the working tree directly,
    verified all handler ordering, session tools/stores, resource behavior,
    tests, and command evidence. No findings requiring change.
  - An unrelated accidental Claude `noop` async job
    `ef073c7d-f660-427f-b436-51e7fdcd446a` completed and was not used as review
    evidence.
