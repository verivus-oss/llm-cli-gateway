# Dirty Tree Stack Split Verification - 2026-06-08

## Objective

Split the current dirty working tree into a clean stacked commit/PR-ready
structure without losing tracked or untracked work.

Requested stack:

1. Provider type/schema widening
2. Direct `grok-api` provider
3. Provider-owned stored session enforcement
4. Provider subcommand planning docs
5. Host auto-upgrade ops

## Safety Evidence

- Binary tracked diff backup:
  `/tmp/llm-cli-gateway-working-tree.patch`
- Untracked-file manifest:
  `/tmp/llm-cli-gateway-untracked-files.txt`
- Initial HEAD:
  `f1844c21ce8b5be1123ac4f08dd1954389721822`
- Initial branch:
  `master`

Initial `git status --short`:

```text
 M migrations/001_initial_schema.sql
 M package.json
 M src/__tests__/grok-handler.test.ts
 M src/__tests__/migration-pg.test.ts
 M src/__tests__/persistence-config.test.ts
 M src/__tests__/session-manager-pg.test.ts
 M src/__tests__/session-manager.test.ts
 M src/__tests__/setup.ts
 M src/config.ts
 M src/flight-recorder.ts
 M src/index.ts
 M src/metrics.ts
 M src/migrate-sessions.ts
 M src/resources.ts
 M src/session-manager-pg.ts
 M src/session-manager.ts
?? docs/plans/grok-0.2.33-contract-sync.dag.toml
?? docs/plans/grok-api-provider-design.draft.md
?? docs/plans/provider-owned-sessions.audit.md
?? docs/plans/provider-owned-sessions.dag.toml
?? docs/plans/provider-subcommands-scope-expansion.dag.toml
?? docs/reviews/provider-owned-sessions-verification-2026-06-08.md
?? docs/reviews/provider-subcommands-plan-review-2026-06-08.md
?? migrations/003_provider_type_sessions.sql
?? scripts/host-upgrade.sh
?? scripts/systemd/
?? src/__tests__/grok-api-provider.test.ts
?? src/__tests__/provider-owned-sessions.test.ts
?? src/xai-api-provider.ts
```

`CLAUDE.md` check: `rg --files -g CLAUDE.md` returned no matches. `AGENTS.md`
was read.

## Classification Table

| File | State | Layer | Classification | Split notes |
| --- | --- | --- | --- | --- |
| `migrations/001_initial_schema.sql` | Modified | 1 | Provider type/schema widening | Widens `sessions.cli` and `active_sessions.cli` checks to all provider values including `grok-api`. |
| `migrations/003_provider_type_sessions.sql` | Untracked | 1 | Provider type/schema widening | Adds migration for existing PostgreSQL installations. |
| `src/session-manager.ts` | Modified | 1 | Provider type/schema widening | Introduces `API_PROVIDER_TYPES`, `PROVIDER_TYPES`, `ProviderType`; widens session APIs and active-session storage. |
| `src/session-manager-pg.ts` | Modified | 1 | Provider type/schema widening | Widens PostgreSQL session manager API/default descriptions to `ProviderType`. |
| `src/migrate-sessions.ts` | Modified | 1 | Provider type/schema widening | Casts migrated active sessions to `ProviderType`. |
| `src/metrics.ts` | Modified | 1 | Provider type/schema widening | Records performance metrics over `ProviderType`, including `grok-api`. |
| `src/flight-recorder.ts` | Modified | 1 | Provider type/schema widening | Widens flight log provider field to `ProviderType`. |
| `src/__tests__/migration-pg.test.ts` | Modified | 1 | Provider type/schema widening tests | Migrates and verifies all provider types including `grok-api`. |
| `src/__tests__/session-manager-pg.test.ts` | Modified | 1 | Provider type/schema widening tests | Verifies PostgreSQL session creation/listing for all providers. |
| `src/__tests__/session-manager.test.ts` | Modified | 1 | Provider type/schema widening tests | Verifies file session manager and MCP session enum include `grok-api`. |
| `src/__tests__/setup.ts` | Modified | 1 | Provider type/schema widening test setup | Normalizes test DB provider constraints to the widened set. |
| `package.json` | Modified | 1 | Provider type/schema widening packaging | Adds `migrations/**/*.sql` to package contents, needed because a migration is added. |
| `src/config.ts` | Modified | 2 | Direct `grok-api` provider | Adds `[providers.xai]` loader, defaults, enablement gate, and non-secret provider config shape. |
| `src/xai-api-provider.ts` | Untracked | 2 | Direct `grok-api` provider | Implements xAI Responses HTTP client, response parsing, retry/circuit breaker, and usage mapping. |
| `src/__tests__/persistence-config.test.ts` | Modified | 2 | Direct `grok-api` provider tests | Adds provider config tests and Grok API tool registration gating tests. |
| `src/__tests__/grok-api-provider.test.ts` | Untracked | 2 | Direct `grok-api` provider tests | Focused xAI API request/session/metadata tests. |
| `src/index.ts` | Modified | Mixed: 1, 2, 3 | Mixed implementation | Layer 1: provider enum import/type/export and session tool descriptions. Layer 2: provider config runtime, Grok API prep/handler/tool registration/health output. Layer 3: shared session ownership helper and guards in all handlers. |
| `src/resources.ts` | Modified | 3 | Provider-owned stored session enforcement | `sessions://all` active-session output now iterates all `PROVIDER_TYPES`, including `grok-api`. |
| `src/__tests__/provider-owned-sessions.test.ts` | Untracked | 3 | Provider-owned stored session enforcement tests | Covers wrong-provider rejection for required sync/async handlers and `sessions://all` active `grok-api`. |
| `src/__tests__/grok-handler.test.ts` | Modified | 3 | Provider-owned stored session enforcement tests | Adds Grok CLI rejection tests for `grok-api` sessions. |
| `docs/plans/provider-owned-sessions.dag.toml` | Untracked | 3 | Provider-owned stored session enforcement docs | Plan input and implementation invariant for layer 3. |
| `docs/plans/provider-owned-sessions.audit.md` | Untracked | 3 | Provider-owned stored session enforcement docs | Audit input documenting handler gaps. |
| `docs/reviews/provider-owned-sessions-verification-2026-06-08.md` | Untracked | 3 | Provider-owned stored session enforcement verification | Existing verification report for layer 3. |
| `docs/plans/grok-api-provider-design.draft.md` | Untracked | Out of requested stack | Direct provider design draft | Not requested in any required stack layer. Preserve untracked unless user approves an extra docs layer. |
| `docs/plans/grok-0.2.33-contract-sync.dag.toml` | Untracked | 4 | Provider subcommand planning docs | Plan-only file requested in layer 4. |
| `docs/plans/provider-subcommands-scope-expansion.dag.toml` | Untracked | 4 | Provider subcommand planning docs | Plan-only file requested in layer 4. |
| `docs/reviews/provider-subcommands-plan-review-2026-06-08.md` | Untracked | 4 | Provider subcommand planning docs | Plan-review file requested in layer 4. |
| `scripts/host-upgrade.sh` | Untracked | 5 | Host auto-upgrade ops | Host upgrade helper script requested in layer 5. |
| `scripts/systemd/gateway-autoupgrade.service` | Untracked | 5 | Host auto-upgrade ops | systemd service requested in layer 5. |
| `scripts/systemd/gateway-autoupgrade.timer` | Untracked | 5 | Host auto-upgrade ops | systemd timer requested in layer 5. |
| `docs/reviews/dirty-tree-stack-split-verification-2026-06-08.md` | New | Meta | Verification report | Created for this split task. Will be committed with final/meta documentation only if appropriate; otherwise left as working-tree evidence. |

## Mixed-Concern Split Strategy

`src/index.ts` is the only high-risk mixed file.

Planned split:

- Layer 1 stage only provider type/schema widening:
  `PROVIDER_TYPES`/`ProviderType` import and `SESSION_PROVIDER_VALUES =
  PROVIDER_TYPES`, `SessionProvider = ProviderType`, plus session tool
  descriptions that mention `grok-api`.
- Layer 2 stage direct API provider implementation:
  xAI config imports, runtime providers config, server instruction/tool gating,
  `GrokApiRequestParams`, prep/response/session helpers, `handleGrokApiRequest`,
  `grok_api_request` tool registration, and `llm_process_health`
  `outboundProviders`.
- Layer 3 stage ownership enforcement:
  `Session` import, shared `getExistingSessionForProvider` helper, guard calls in
  all required request handlers, and resource/test/docs changes.

Non-destructive staging method:

- Use path-specific staging and/or `git apply --cached` generated patches.
- Do not rewrite the working tree to manufacture commits.
- Verify `git diff --cached` before each commit.

## Final Stack

Created commits on `master`, oldest to newest:

1. `b990fc3 feat: widen session provider types`
2. `f517d01 feat: add direct grok api provider`
3. `35f6a18 fix: enforce provider-owned sessions`
4. `0d4ee5b docs: plan provider subcommand contracts`
5. `5426733 ops: add host auto-upgrade timer`

## Changed Files Per Stack Layer

### 1. Provider type/schema widening

Commit: `b990fc3 feat: widen session provider types`

Files:

- `migrations/001_initial_schema.sql`
- `migrations/003_provider_type_sessions.sql`
- `package.json`
- `src/__tests__/migration-pg.test.ts`
- `src/__tests__/session-manager-pg.test.ts`
- `src/__tests__/session-manager.test.ts`
- `src/__tests__/setup.ts`
- `src/flight-recorder.ts`
- `src/index.ts`
- `src/metrics.ts`
- `src/migrate-sessions.ts`
- `src/session-manager-pg.ts`
- `src/session-manager.ts`

Focused verification:

- `npx vitest run src/__tests__/session-manager.test.ts src/__tests__/session-manager-pg.test.ts src/__tests__/migration-pg.test.ts`
  - Result: passed, 1 reported test file, 49 tests. PostgreSQL-specific tests
    are gated by the repo's existing test setup.

### 2. Direct `grok-api` provider

Commit: `f517d01 feat: add direct grok api provider`

Files:

- `src/__tests__/grok-api-provider.test.ts`
- `src/__tests__/persistence-config.test.ts`
- `src/config.ts`
- `src/index.ts`
- `src/xai-api-provider.ts`

Focused verification:

- `npx vitest run src/__tests__/grok-api-provider.test.ts src/__tests__/persistence-config.test.ts`
  - Result: passed, 2 test files, 40 tests.

Note: the generic `getExistingSessionForProvider` helper is introduced in this
commit because the staged `grok_api_request` implementation needs it for
`grok-api` namespace protection. The next commit reuses that helper for all
other provider-owned session guards.

### 3. Provider-owned stored session enforcement

Commit: `35f6a18 fix: enforce provider-owned sessions`

Files:

- `docs/plans/provider-owned-sessions.audit.md`
- `docs/plans/provider-owned-sessions.dag.toml`
- `docs/reviews/provider-owned-sessions-verification-2026-06-08.md`
- `src/__tests__/grok-handler.test.ts`
- `src/__tests__/provider-owned-sessions.test.ts`
- `src/index.ts`
- `src/resources.ts`

Focused verification:

- `npx vitest run src/__tests__/provider-owned-sessions.test.ts src/__tests__/grok-handler.test.ts`
  - Result: passed, 2 test files, 32 tests.

### 4. Provider subcommand planning docs

Commit: `0d4ee5b docs: plan provider subcommand contracts`

Files:

- `docs/plans/grok-0.2.33-contract-sync.dag.toml`
- `docs/plans/provider-subcommands-scope-expansion.dag.toml`
- `docs/reviews/provider-subcommands-plan-review-2026-06-08.md`

Focused verification:

- `git diff --cached --check -- docs/plans/grok-0.2.33-contract-sync.dag.toml docs/plans/provider-subcommands-scope-expansion.dag.toml docs/reviews/provider-subcommands-plan-review-2026-06-08.md`
  - Result: passed.
- `npm run upstream:contracts`
  - Result: passed.

### 5. Host auto-upgrade ops

Commit: `5426733 ops: add host auto-upgrade timer`

Files:

- `scripts/host-upgrade.sh`
- `scripts/systemd/gateway-autoupgrade.service`
- `scripts/systemd/gateway-autoupgrade.timer`

Focused verification:

- `bash -n scripts/host-upgrade.sh`
  - Result: passed.
- `systemd-analyze verify --user scripts/systemd/gateway-autoupgrade.service scripts/systemd/gateway-autoupgrade.timer`
  - Result: passed with no output.

## Verification Commands

Full-stack verification after all five commits:

- `npm run build`
  - Result: passed.
- `npm test`
  - Result: passed, 67 test files, 1124 tests.
- `npm run lint`
  - Result: passed with warnings only. Warnings are the repo's existing ignored
    test-file warnings plus `src/__tests__/setup.ts`
    `security/detect-non-literal-fs-filename`.
- `npm run format:check`
  - Result: passed.
- `npm pack --dry-run --json`
  - Result: passed. Reported package `llm-cli-gateway-2.3.0.tgz`, 106
    entries, size 247019 bytes, unpacked size 1075888 bytes. The dry run
    includes `migrations/001_initial_schema.sql`,
    `migrations/002_session_ids_as_text.sql`, and
    `migrations/003_provider_type_sessions.sql`.

## Known Limitations Or Blockers

- No unresolved implementation blockers.
- `docs/plans/grok-api-provider-design.draft.md` was intentionally preserved as
  untracked because it was not included in any requested stack layer.
- The layer 2/3 boundary keeps the ownership helper in layer 2 for buildable API
  provider code; layer 3 applies the cross-provider enforcement guards broadly.

## Multi-LLM Review Iteration

Review dispatch policy:

- Reviewers were given the verification report as the corrective-program spec:
  `docs/reviews/dirty-tree-stack-split-verification-2026-06-08.md`.
- Reviewers were given the exact base/stack commits and required to inspect
  code/docs/tests/commits directly.
- Reviewers were told not to accept summaries or plan-compliance claims as
  evidence.
- `approvalStrategy: "mcp_managed"` and `approvalPolicy: "permissive"` were
  used. Full/bypass-style permission modes were requested where supported.
- MCP servers requested for each reviewer:
  `sqry`, `exa`, `ref_tools`, `trstr`. Claude reported only `sqry` and `trstr`
  enabled locally; `exa` and `ref_tools` were missing for that provider.

Round 1 review jobs:

- Claude:
  `ef4e5e13-54b2-4a82-9e6b-592ef00dcf86`
  (`dirty-tree-stack-review-claude-r1-20260608`)
  - Result: `APPROVED`.
  - Evidence reported: reconstructed original dirty tree from
    `/tmp/llm-cli-gateway-working-tree.patch`, verified tracked files
    byte-identical to HEAD, reconciled untracked manifest, inspected every
    commit and `src/index.ts` layer boundary, and ran build/test/focused tests.
  - Observation: test-only default-`tsconfig.json` type mismatch in
    `src/__tests__/grok-api-provider.test.ts:147`; classified as non-blocking
    in clarification.
- Gemini:
  `210cdae7-bdfb-4d03-9536-d17e4035d07b`
  (`dirty-tree-stack-review-gemini-r1-20260608`)
  - Result: `APPROVED`.
  - Evidence reported: inspected layer boundaries, implementation and docs,
    and verification commands.
- Grok initial:
  `d45bf38a-c1e9-44dc-83ad-e9120152fa70`
  (`dirty-tree-stack-review-grok-r1-20260608`)
  - Result: failed before review due upstream agent-builder/tool constraint.
- Grok retry:
  `00bf005e-e600-41f6-985f-fc75739db771`
  (`dirty-tree-stack-review-grok-r1b-20260608`)
  - Result: `APPROVED` with non-blocking observations.
  - Evidence reported: inspected current status, each commit, `src/index.ts`
    split, migrations/package contents, resources/session behavior, and ran
    verification commands.
- Mistral:
  `48ba3493-b868-49e5-b813-2511d12e8234`
  (`dirty-tree-stack-review-mistral-r1-20260608`)
  - Result: `APPROVED`.
  - Evidence reported: verified stack order, layer boundaries, file
    classification, full verification results, and current status.

Clarification jobs:

- Grok clarification:
  `21a83f68-66c8-41dd-9910-30588d6bd42a`
  (`dirty-tree-stack-review-grok-r1c-clarify-20260608`)
  - Result: unconditional `APPROVED`.
  - Evidence: re-inspected `sessions://all`/session-tool `grok-api` support,
    lack of dedicated `sessions://grok-api` resource, the ProviderType/CliType
    split, and verification evidence; found no blocker.
- Claude clarification:
  `a436b8bc-0231-4bfa-8595-c737d6aa60ba`
  (`dirty-tree-stack-review-claude-r1b-clarify-20260608`)
  - Result: unconditional `APPROVED`.
  - Evidence: verified `npm run build` uses `tsconfig.build.json` excluding
    tests, `npm test` passed, CI workflows do not invoke default
    `tsconfig.json` test typechecking, and default-config test type errors are
    non-gating and test-only.

Final multi-LLM review outcome:

- Claude: `APPROVED`
- Gemini: `APPROVED`
- Grok: `APPROVED`
- Mistral: `APPROVED`
- No concrete unresolved blockers.

## MCP Inspector Follow-Up

MCP Inspector installation and CLI smoke:

- Installed global package:
  `@modelcontextprotocol/inspector@0.22.0`.
- `HOST=127.0.0.1 mcp-inspector --cli node dist/index.js --method tools/list`
  - Result: passed.
- `HOST=127.0.0.1 mcp-inspector --cli node dist/index.js --method resources/list`
  - Result: passed.
- `HOST=127.0.0.1 mcp-inspector --cli node dist/index.js --method prompts/list`
  - Result: expected capability absence: MCP `Method not found`.
- Read-only tool calls through Inspector:
  - `llm_process_health`: passed.
  - `list_available_models`: passed.
  - `cli_versions`: passed globally and per provider.
  - `upstream_contracts`: passed with and without `probeInstalled=true`.
  - `provider_subcommands_list`: passed.
  - `provider_subcommand_contract`: passed for `grok agent headless` and
    `codex exec`.
  - `provider_subcommand_drift`: passed for Grok and all providers with
    `includeClean=true`.
  - `approval_list --tool-arg limit=5`: passed.
  - `list_models`: passed for `claude`, `codex`, `gemini`, `grok`,
    `mistral`.
  - `cli_upgrade --tool-arg dryRun=true`: passed for all five CLI providers.
  - `compare_answers`: passed.
- Session lifecycle through Inspector:
  - Created a temporary non-active `grok-api` session, read it with
    `session_get`, then deleted it with `session_delete`.
  - Result: passed and cleaned up.
- Direct xAI API provider through Inspector:
  - Current default config leaves `grok_api_request` intentionally unregistered
    because `[providers.xai]`/`XAI_API_KEY` are absent.
  - Positive smoke used a temporary `LLM_GATEWAY_CONFIG`, loopback mock xAI
    Responses API, and `XAI_API_KEY=inspector-test-key`.
  - Result: `grok_api_request` registered, returned `inspector mock ok`, and
    the loopback mock received exactly one request.

Inspector-discovered defect and fix:

- Initial exhaustive advertised-resource read found that
  `cache_state://global` and `provider_subcommands://catalog` were advertised
  but unreadable through Inspector with MCP `-32603: Invalid URL`.
- Cause: underscore characters in the URI scheme are not valid URL schemes for
  standard MCP clients/SDK URL parsing.
- Fix: advertise and generate valid hyphenated schemes:
  `cache-state://...` and `provider-subcommands://...`.
- Compatibility: `ResourceProvider.readResource` still accepts the legacy
  `provider_subcommands://...` strings for internal direct callers and tests.
  Standard MCP clients should use only the advertised hyphenated schemes because
  legacy underscore schemes are not valid URL schemes.
- Re-run result: every URI returned by `resources/list` was read successfully:
  all `skills://*`, `sessions://*`, `models://*`, `metrics://performance`,
  `cache-state://global`, `provider-subcommands://catalog`, and
  `metrics://process-health`.

Post-fix verification:

- `npm test -- src/__tests__/upstream-contracts.test.ts`
  - Result: passed, 32 tests.
- `npm test -- src/__tests__/cache-state-resources.test.ts`
  - Result: passed, 8 tests.
- `npm run build`
  - Result: passed.
- `npm test`
  - Result: passed, 67 test files, 1124 tests.
- `npm run lint`
  - Result: passed with warnings only, matching the known ignored test-file
    warnings and `src/__tests__/setup.ts`
    `security/detect-non-literal-fs-filename`.
- `npm run format:check`
  - Result: passed.
- `npm pack --dry-run --json`
  - Result: passed. Reported package `llm-cli-gateway-2.3.0.tgz`, unpacked
    size `1076065` bytes.

Inspector-discovered fix multi-LLM review:

- Review target:
  - Initial commit: `9ee61f0 fix: use valid MCP resource URI schemes`.
  - Corrective follow-up:
    `f06e502 docs: update MCP resource URI references`.
  - Final reviewed range: `1f35941..HEAD`.
  - Exact round-2 review diff:
    `/tmp/llm-cli-gateway-uri-scheme-review-stack-r2.diff`.
- Review instructions:
  - Each reviewer received this verification report plus the exact commit/diff
    or changed-file list under review.
  - Each reviewer was instructed to verify claims against code, tests, docs,
    and persistent evidence rather than relying on summary language.
  - Providers were given MCP tool access where their CLI accepted it and
    permissive/full local execution permissions through the gateway approval
    surface.
- Round 1 jobs:
  - Claude:
    `c22f1222-9665-49ac-9fe1-018924c12428`
    (`uri-scheme-fix-review-claude-20260608-r1`) - `APPROVED` with
    non-blocking docs/test observations.
  - Codex:
    `4658b5e2-51c1-4e2d-98cb-708ddac774a9`
    (`uri-scheme-fix-review-codex-20260608-r1`) - `APPROVED` with
    non-blocking docs drift observation.
  - Gemini:
    `f51a0ec8-5d61-42c5-9173-e48d9ced6cff`
    (`uri-scheme-fix-review-gemini-20260608-r1`) - `NOT APPROVED`.
  - Grok:
    `cd6cb1de-5392-4a1f-a2ad-a2653d272a49`
    (`uri-scheme-fix-review-grok-20260608-r1`) - `APPROVED` with
    non-blocking docs/asymmetry observations.
  - Mistral:
    `68f40df5-154f-45cd-8bc9-8d4a586295bb`
    (`uri-scheme-fix-review-mistral-20260608-r1`) - `APPROVED`.
- Round 1 concrete blocker:
  - Gemini found tracked docs and skills still instructing invalid
    `cache_state://` and `provider_subcommands://` resource schemes after the
    code fix.
  - I verified the finding with
    `rg -n "cache_state://|provider_subcommands://" ...`.
- Corrective action:
  - Committed `f06e502 docs: update MCP resource URI references`.
  - Updated docs and skills to instruct `cache-state://` and
    `provider-subcommands://`.
  - Left remaining invalid-scheme literals only as historical defect evidence,
    explicit legacy direct-read compatibility tests/code, or frozen flight
    recorder capture data.
- Corrective verification:
  - `npm test -- src/__tests__/upstream-contracts.test.ts src/__tests__/cache-state-resources.test.ts`
    - Result: passed, 40 tests.
  - `npm run build`
    - Result: passed.
  - `npm run format:check`
    - Result: passed.
  - `git diff --check`
    - Result: passed.
  - `npm test`
    - Result: passed, 67 test files, 1124 tests.
  - `npm run lint`
    - Result: passed with warnings only, matching known warnings.
  - `npm pack --dry-run --json`
    - Result: passed. Reported package `llm-cli-gateway-2.3.0.tgz`, unpacked
      size `1076065` bytes.
- Round 2 jobs:
  - Claude:
    `51b9e79e-81db-4a05-89a8-a39f027b51d2`
    (`uri-scheme-fix-review-claude-20260608-r2`) - `APPROVED`.
  - Codex:
    `463d5211-8e58-4c62-9888-94f8bc649837`
    (`uri-scheme-fix-review-codex-20260608-r2`) - `APPROVED`.
  - Gemini:
    `43e4a4d3-bfbd-4b9c-9d85-30cdac3206e7`
    (`uri-scheme-fix-review-gemini-20260608-r2`) - `APPROVED`.
  - Grok:
    `1092119f-8114-4a86-b5ba-3909b375fa40`
    (`uri-scheme-fix-review-grok-20260608-r2`) - `APPROVED`.
  - Mistral:
    `b268d5f4-5290-44ce-b8bd-1d3906e3e876`
    (`uri-scheme-fix-review-mistral-20260608-r2`) - `APPROVED`.
- Final review outcome:
  - Claude, Codex, Gemini, Grok, and Mistral all gave unconditional approval
    of the final two-commit URI-scheme stack.
  - No unresolved blockers remain from the Inspector-discovered fix review.

## Final Git Status

```text
?? docs/plans/grok-api-provider-design.draft.md
```
