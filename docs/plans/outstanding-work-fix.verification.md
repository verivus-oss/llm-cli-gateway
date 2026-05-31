# Outstanding Work Fix Verification Notes

## Phase 0 Baseline

Date: 2026-05-31

Baseline scope:

- This checkout was already dirty before this implementation session began. The task was to execute the plan in the current checkout, so Phase 0 captures the current working tree state, not `HEAD`.
- Pre-existing modified files at session start included `src/doctor.ts`, `src/index.ts`, multiple tests, and other unrelated files. The only Phase 0 file added by this implementation session before review was this verification note.
- No behavior code was edited by this implementation session before the Phase 0 baseline commands and initial Phase 0 review dispatch.

Initial changed-file list captured before behavior edits:

```text
 M .gitignore
 M installer/internal/config/config.go
 M src/__tests__/executor.test.ts
 M src/__tests__/gemini-async-handler.test.ts
 M src/__tests__/integration.test.ts
 M src/__tests__/migration-pg.test.ts
 M src/__tests__/session-manager-pg.test.ts
 M src/__tests__/test-veracity-regressions-slice-kappa.test.ts
 M src/__tests__/worktree-manager.test.ts
 M src/doctor.ts
 M src/index.ts
 M src/process-monitor.ts
 M src/provider-status.ts
 M src/session-manager.ts
 M src/validation-prompts.ts
 M src/validation-tools.ts
?? .agents/skills/public-demo-session/
?? docs/launch/blog-upstreams-and-front-door.md
?? docs/plans/outstanding-work-fix.dag.toml
?? docs/plans/outstanding-work-fix.implementation-prompt.md
?? docs/plans/xstate-store-integration.dag.toml
?? docs/plans/xstate-store-integration.md
?? docs/upstream/reports/2026-05-31-grok.md
?? docs/upstream/snapshots/grok.json
?? site/
?? wrangler.toml
```

Commands:

- `npm run build`: passed.
- `npm test -- src/__tests__/doctor.test.ts src/__tests__/cli-entrypoint.test.ts src/__tests__/upstream-contracts.test.ts`: failed only in `src/__tests__/doctor.test.ts` with `doctor.upstream not in additionalProperties=false`.
- `npm run format:check`: failed for `src/__tests__/read-persisted-request.test.ts`, `src/__tests__/upstream-contracts.test.ts`, `src/doctor.ts`, and `src/index.ts`.
- `codex exec --help`: installed `codex exec` advertises `--sandbox`, `--dangerously-bypass-approvals-and-sandbox`, `-C/--cd`, `--add-dir`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--json`, and other current flags. It does not advertise `--ask-for-approval` or `--full-auto`.
- `codex exec resume --help`: resume advertises `--last`, `-c/--config`, `--enable`, `--disable`, `-i/--image`, `--strict-config`, `--model`, `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--ignore-rules`, `--output-schema`, `--json`, and `-o/--output-last-message`. It does not advertise `--ask-for-approval`, `--full-auto`, `--sandbox`, `-C/--cd`, `--add-dir`, or `--search`.
- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: exited zero but did not show probe output in offline mode.
- `npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical`: exited zero but did not show probe output in offline mode.

Decisions:

- Doctor schema result: current report emits top-level `upstream`; `setup/status.schema.json` rejects it because top-level `additionalProperties` is false and the schema has no `upstream` property.
- Codex flag policy: remove `--ask-for-approval` from emitted argv and from the mechanical contract. Keep `--sandbox` for new sessions. Treat `fullAuto` as deprecated compatibility input that maps to `--sandbox workspace-write` only; keep `useLegacyFullAutoFlag` as accepted compatibility input but do not emit unsupported `--full-auto`.
- Codex `askForApproval` compatibility: keep the MCP input temporarily so older callers do not fail schema validation, but treat it as a deprecated no-op with an explicit warning when present. Do not map it to `-c` or profiles unless a future Codex CLI documents a supported approval-policy mechanism. Any argv emitted by `prepareCodexRequest` must pass `validateUpstreamCliArgs("codex", args)`.
- Upstream scan offline probe behavior: `--probe-installed` is currently ineffective without `--live` because the installed-help probe block is nested under the live branch.
- Grok report drift: unresolved in the checked-in advisory report/snapshot at baseline. Final state must either resolve installed drift or quarantine the generated report/snapshot as advisory evidence.

## Phase 1 Doctor Schema Fix

Changed files:

- `setup/status.schema.json`
- `src/doctor.ts`

Implementation notes:

- Added top-level `upstream` to `setup/status.schema.json` `required`.
- Added a top-level `upstream` schema with strict public-envelope fields: `note`, `recommendation`, `how_to_check`, `probed`, `installed_versions`, `contracts`, and optional `probe_report`.
- Kept `contracts` and `probe_report` permissive objects because their internals are owned by `src/upstream-contracts.ts`.
- Updated `src/doctor.ts` so `probe_report` is omitted when no installed probe was requested; this keeps the TypeScript optional field and JSON schema compatible during direct object validation in `src/__tests__/doctor.test.ts`.

Validation:

- `npm test -- src/__tests__/doctor.test.ts`: passed, 20 tests.

## Phase 2 Codex Contract And Argv Fix

Changed files:

- `src/request-helpers.ts`
- `src/index.ts`
- `src/upstream-contracts.ts`
- `src/__tests__/request-helpers.test.ts`
- `src/__tests__/codex-handler.test.ts`
- `src/__tests__/upstream-contracts.test.ts`
- `src/__tests__/test-veracity-regressions.test.ts`

Implementation notes:

- Removed `--ask-for-approval` and `--full-auto` from `UPSTREAM_CLI_CONTRACTS.codex.flags`.
- Kept `askForApproval`, `fullAuto`, and `useLegacyFullAutoFlag` as MCP compatibility inputs.
- `fullAuto` now emits `--sandbox workspace-write` only.
- `askForApproval` is a deprecated no-op with a warning; it emits no argv.
- `useLegacyFullAutoFlag` is a deprecated no-op with a warning whenever present; it emits no `--full-auto`.
- `search` is also retained as a deprecated no-op with a warning because installed `codex exec` no longer accepts `--search`; it emits no argv.
- Resume-mode Codex requests log the same deprecated-input warnings, including `search`, without emitting resume-incompatible sandbox, approval, search, cwd, or add-dir argv.
- Added contract fixtures proving `--ask-for-approval` and `--full-auto` are rejected by the bundled Codex contract.
- Added contract coverage for current Codex `exec` / `exec resume` help-surface flags and resume-forbidden `-C` / `--cd` / `--add-dir`.
- Marked `--all` as resume-only and added `--cd` to the defensive resume argv filter after review found those edge cases.
- Added a real `prepareCodexRequest({ fullAuto: true })` argv test that validates the emitted argv with `validateUpstreamCliArgs("codex", args)`.

Validation:

- `npm run build`: passed.
- `npm test -- src/__tests__/request-helpers.test.ts src/__tests__/codex-handler.test.ts src/__tests__/upstream-contracts.test.ts src/__tests__/test-veracity-regressions.test.ts`: passed, 129 tests after reviewer-requested `--all` / `--cd` coverage.
- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: passed after Phase 3 made offline probing effective.

## Phase 3 Upstream Scan Offline Probe Fix

Changed files:

- `scripts/upstream-scan.mjs`
- `docs/upstream/README.md`

Implementation notes:

- Moved installed CLI help-surface probing out of the `--live` branch so `--probe-installed` works in offline mode.
- Kept network fetches gated by `--live`.
- Kept snapshot writes on the existing live snapshot path, while reports still use the normal `--write-report` gate.
- Updated upstream docs so they no longer imply `--probe-installed` requires live mode.

Validation:

- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: passed and printed `mode=offline +probe-installed`.
- `npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical`: failed non-zero with installed Grok help-surface drift, proving offline `--fail-on-critical` now works. Phase 4 resolves the Grok contract drift.

## Phase 4 Grok Upstream Drift And Public Copy

Changed files:

- `src/upstream-contracts.ts`
- `src/__tests__/upstream-contracts.test.ts`
- `README.md`
- `src/provider-login-guidance.ts`
- `site/install.md`
- `docs/upstream/snapshots/grok.json`
- `docs/upstream/reports/2026-05-31-grok.md`

Implementation notes:

- Tightened `extractDiscoveredFlags` so installed-help drift detection only reads the declaration segment of option lines and ignores prose references such as `Claude Code: --allowedTools`, including same-line descriptions.
- Added current real Grok Build help-surface flags to `UPSTREAM_CLI_CONTRACTS.grok` with a conformance fixture.
- Regenerated the Grok upstream snapshot and report; the report now has no findings and the snapshot has empty `extraVsContract` / `missingFromBinary`.
- Updated Grok Build install copy to xAI's current `curl -fsSL https://x.ai/cli/install.sh | bash` installer and `https://docs.x.ai/build/overview` docs URL across README, provider guidance, and site install copy.

Validation:

- `npm run build`: passed.
- `npm test -- src/__tests__/upstream-contracts.test.ts src/__tests__/test-veracity-regressions.test.ts`: passed, 42 tests after reviewer-requested same-line prose alias coverage.
- `npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical`: passed and printed `mode=offline +probe-installed`.
- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: passed.
- `npm run upstream:scan -- --live --provider grok --probe-installed --write-snapshot --write-report`: passed, rewrote `docs/upstream/snapshots/grok.json` and `docs/upstream/reports/2026-05-31-grok.md`.
- `npm run upstream:contracts`: passed.

## Multi-LLM Review Round 1

Dispatch:

- Codex: `00c8c308-407e-42ed-b11f-a7d00fa253fc`, `outstanding-work-review-codex-all-phases-round1`.
- Gemini: `a5163551-62d3-48dd-a82a-57863424e57f`, `outstanding-work-review-gemini-all-phases-round1`.
- Grok: `8bb07566-3387-417d-aeb5-e099631d93b2`, `outstanding-work-review-grok-all-phases-round1`.
- Mistral: `474a3ff6-21fd-488c-bac8-6c6c3856f577`, `outstanding-work-review-mistral-all-phases-round1`.
- Claude: `910ac7c7-60f1-466a-92f6-dd6c16a7ad51`, `outstanding-work-review-claude-all-phases-round1`.

Review status by phase:

- Phase 0: Gemini, Grok, Mistral, and Claude gave unconditional approval. Codex could not independently reproduce the original pre-edit baseline from the current dirty tree, but did not block Phase 0.
- Phase 1: all reviewers approved.
- Phase 2: Gemini, Grok, Mistral, and Claude approved. Codex returned `NOT APPROVED with findings` because resume-mode Codex requests could still emit `--profile`, which `codex exec resume --profile test --help` rejects with `unexpected argument '--profile'`.
- Phase 3: all reviewers approved.
- Phase 4: Grok, Mistral, and Claude approved; Gemini approved. Codex returned `NOT APPROVED with findings` because README Grok auth copy still referenced `GROK_CODE_XAI_API_KEY` while current xAI Build docs show `XAI_API_KEY`.

Fixes after Codex review:

- `src/request-helpers.ts`: added `--profile` to the defensive Codex resume flag filter and value-consuming filter.
- `src/index.ts`: resume-mode Codex requests now warn that `profile` is ignored and pass `profile: undefined` to `prepareCodexHighImpactFlags`, so `--profile` is not emitted on `codex exec resume`.
- `src/upstream-contracts.ts`: added `--profile` to Codex `resumeForbiddenFlags`.
- `src/__tests__/codex-handler.test.ts`: added resume coverage proving `profile` is dropped, a warning is logged, and the emitted resume argv passes `validateUpstreamCliArgs("codex", args)`.
- `src/__tests__/upstream-contracts.test.ts`: added contract coverage proving `exec resume --profile ...` is rejected.
- `README.md`, `src/provider-login-guidance.ts`, and `docs/launch/blog-cli-vs-api-followup.md`: replaced stale Grok API-key guidance with `XAI_API_KEY`, matching the official xAI Build overview.

Validation after fixes:

- `codex exec resume --profile test --help`: failed with `unexpected argument '--profile'`, confirming the reviewer finding.
- `codex exec resume -p test --help`: failed with `unexpected argument '-p'`.
- `codex exec resume --config foo=bar --help`: passed, confirming `--config` remains resume-safe.
- `npm run build`: passed.
- `npm test -- src/__tests__/codex-handler.test.ts src/__tests__/upstream-contracts.test.ts src/__tests__/request-helpers.test.ts`: passed, 104 tests.
- `npm run lint`: passed with existing warnings only.
- `npm run format:check`: passed.
- `npm run upstream:contracts`: passed.
- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: passed and printed `mode=offline +probe-installed`.
- `npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical`: passed and printed `mode=offline +probe-installed`.
- `npm test -- src/__tests__/doctor.test.ts src/__tests__/cli-entrypoint.test.ts src/__tests__/request-helpers.test.ts src/__tests__/codex-handler.test.ts src/__tests__/upstream-contracts.test.ts src/__tests__/test-veracity-regressions.test.ts`: passed, 153 tests.

Unresolved risks or blockers:

- No blocker remains after the Round 1 fixes. Phase completion still requires re-review of the corrected diff by the same reviewer set.

## Multi-LLM Review Round 2

Dispatch:

- Codex: `6337e295-0c0d-435f-8af0-152ea4af6814`, `outstanding-work-review-codex-all-phases-round2`.
- Gemini: `98e3e5e7-977a-4e53-8882-401e02177349`, `outstanding-work-review-gemini-all-phases-round2`.
- Grok: `11b07ad0-9fae-4326-8bed-4b2a5a252dcc`, `outstanding-work-review-grok-all-phases-round2`.
- Mistral: `a64e4a16-c0e9-43d4-a16d-3863d9ce742a`, `outstanding-work-review-mistral-all-phases-round2`.
- Claude: `646905b8-1ca1-43c5-82bd-f440bbf372db`, `outstanding-work-review-claude-all-phases-round2`.

Review status by phase:

- Phase 0: all five reviewers approved.
- Phase 1: all five reviewers approved.
- Phase 2: all five reviewers approved after verifying the Codex resume `--profile` fix.
- Phase 3: all five reviewers approved.
- Phase 4: all five reviewers approved after verifying the Grok public/auth copy uses `XAI_API_KEY`.

Round 2 reviewer endings:

- Codex: `UNCONDITIONAL APPROVAL`.
- Gemini: `UNCONDITIONAL APPROVAL`.
- Grok: `UNCONDITIONAL APPROVAL`.
- Mistral: `UNCONDITIONAL APPROVAL`.
- Claude: `UNCONDITIONAL APPROVAL`.

Final validation:

- `npm run build`: passed.
- `npm run lint`: passed with existing warnings only.
- `npm run format:check`: passed.
- `npm test -- src/__tests__/codex-handler.test.ts src/__tests__/upstream-contracts.test.ts src/__tests__/request-helpers.test.ts`: passed, 104 tests.
- `npm test -- src/__tests__/doctor.test.ts src/__tests__/cli-entrypoint.test.ts src/__tests__/request-helpers.test.ts src/__tests__/codex-handler.test.ts src/__tests__/upstream-contracts.test.ts src/__tests__/test-veracity-regressions.test.ts`: passed, 153 tests.
- `npm test`: passed, 62 files / 1024 tests.
- `npm run upstream:contracts`: passed.
- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: passed, `mode=offline +probe-installed`.
- `npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical`: passed, `mode=offline +probe-installed`.
- `git diff --check`: passed.
- xAI Build docs checked on 2026-05-31:
  - `https://docs.x.ai/build/overview` uses `Grok Build`, the `curl -fsSL https://x.ai/cli/install.sh | bash` installer, and `XAI_API_KEY` for non-browser/headless auth.
  - `https://docs.x.ai/build/enterprise` documents x.ai CLI binary downloads and npm fallback `@xai-official/grok`.

Residual risks or blockers:

- No blocker remains.
- Non-blocking residual noted by Grok was resolved before release: `skills/multi-llm-orchestration/SKILL.md` now uses `XAI_API_KEY`.

## Release Preparation

Release version: `1.17.2`

Changed files prepared for commit:

- Product/source/test/docs files from Phases 1-4.
- `CHANGELOG.md`, `package.json`, and `package-lock.json` release metadata.
- `docs/plans/outstanding-work-fix.*` persistent plan and verification artifacts.
- `docs/upstream/reports/2026-05-31-grok.md` and `docs/upstream/snapshots/grok.json` regenerated Grok upstream evidence.
- `site/install.md` public install copy updated for current Grok Build guidance.

Intentionally not committed:

- `.agents/skills/public-demo-session/` local agent skill copy.
- `docs/plans/xstate-store-integration.*` unrelated future-plan artifacts.
- `docs/launch/blog-upstreams-and-front-door.md`, the rest of `site/`, and `wrangler.toml` unrelated untracked website artifacts.

Release validation after version bump:

- `npm run format:check`: passed.
- `npm run check`: passed. Build passed, lint had warnings only, full Vitest passed 62 files / 1024 tests, and release security audit passed.
- `npm run upstream:contracts`: passed.
- `npm run upstream:scan -- --provider codex --probe-installed --fail-on-critical`: passed, `mode=offline +probe-installed`.
- `npm run upstream:scan -- --provider grok --probe-installed --fail-on-critical`: passed, `mode=offline +probe-installed`.
- `git diff --check`: passed.
