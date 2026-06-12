# Provider Tool Capabilities Phase 3 Review

## Phase / Unit

Claude, Codex, and Gemini/Antigravity provider coverage group.

## Changed Files

- `src/provider-tool-capabilities.ts`
- `src/__tests__/provider-tool-capabilities.test.ts`
- `docs/reviews/provider-tool-capabilities-phase-3.md`

## Verification

- `npx vitest run src/__tests__/provider-tool-capabilities.test.ts`
  - Initial result: passed, 8 tests.
  - After Gemini sandbox flag and test-coverage fixes: passed, 8 tests.
  - After reverting Gemini sandbox flag to `-s`: passed, 8 tests.
- `npm run build`
  - Initial result: passed.
  - After Gemini sandbox flag and test-coverage fixes: passed.
  - After reverting Gemini sandbox flag to `-s`: passed.

## Reviewer Prompt Scope

Reviewers are asked to inspect code and tests directly. Scope:

- Claude coverage for request tools, model info, allow/deny/tools controls,
  MCP config controls, local skills, agent/agents, JSON/stream/schema output,
  approval/permission controls, addDir/workspace/worktree, session/fork/settings
  controls, and maxTurns/maxBudgetUsd/effort/fallbackModel.
- Codex coverage for request tools including `codex_fork_session`, sandbox and
  approval controls, profile/config overrides, images, output schema, workspace
  and worktree controls, session/resume/new/ephemeral controls, and explicit
  unsupported allow/deny/MCP semantics.
- Gemini/Antigravity coverage for request tools, approval/sandbox controls,
  includeDirs/workspace/worktree/session controls, and rejected/unsupported
  fields for allowedTools, mcpServers, outputFormat json/stream-json,
  policyFiles/adminPolicyFiles/attachments/skipTrust.

## Reviewer Findings

- Claude (`provider-capabilities-phase3-review-claude`,
  job `50a411bb-128e-4749-8c13-4c3fee41c6a8`): failed before verdict with
  `Error: Reached max turns (8)`.
- Gemini (`provider-capabilities-phase3-review-gemini`,
  job `4e8ab291-7565-4141-94ed-6f378782569c`): APPROVED.
  - Low: Gemini sandbox capability listed `cliFlag: "-s"` while the gateway
    prepare logic emits `--sandbox`.
- Mistral (`provider-capabilities-phase3-review-mistral`,
  job `f9b0e16b-9c03-4813-a4d0-9944f67314d9`): APPROVED.
  - Low: test should assert `policyFiles/adminPolicyFiles/skipTrust` behavior
    is `not_supported`.
  - Low: tests should explicitly assert `gatewayRequestTools` for Claude,
    Codex (including `codex_fork_session`), and Gemini.
- Grok (`provider-capabilities-phase3-review-grok`,
  job `ad0d0a00-0e4b-4c96-ab5e-7d56988932cf`): failed before review with the
  provider-worker initialization error and max-turn failure.
- Re-review after first fixes:
  - Claude (`provider-capabilities-phase3-rereview-claude`,
    job `b5546ec0-84ee-44c0-8947-3396578e1256`): NOT APPROVED.
    - Blocker: Gemini sandbox capability was changed to `--sandbox`, but the
      live gateway helper emits `-s` and `gemini-handler.test.ts` pins `-s`.
  - Gemini (`provider-capabilities-phase3-rereview-gemini`,
    job `9dc50a94-7fef-4b79-9981-79eff0aff7dd`): APPROVED, but incorrectly
    accepted the `--sandbox` claim.
  - Mistral (`provider-capabilities-phase3-rereview-mistral`,
    job `3dff828d-d47a-4cb4-94f1-4816977cd518`): APPROVED, but incorrectly
    accepted the `--sandbox` claim.
  - Grok (`provider-capabilities-phase3-rereview-grok`,
    job `a163b3ae-5a19-492d-afb9-f0d43c395d2d`): failed before review with
    the provider-worker initialization error and max-turn failure.
- Final re-review after reverting Gemini sandbox flag to `-s`:
  - Gemini (`provider-capabilities-phase3-finalreview-gemini`,
    job `6bcc306b-5482-4944-9da4-81341ed7dcb7`): APPROVED. Verified `-s`,
    gatewayRequestTools assertions, policy/admin/skipTrust behavior, focused
    tests, build, and reported a full test suite pass during review.
  - Mistral (`provider-capabilities-phase3-finalreview-mistral`,
    job `4a40995d-6137-4d11-abd4-c73788d16257`): APPROVED.
  - Grok (`provider-capabilities-phase3-finalreview-grok`,
    job `2b110680-fc83-4481-a1c7-96b545ef32c8`): failed before review with the
    provider-worker initialization error and max-turn failure.
  - Claude (`provider-capabilities-phase3-finalreview-claude`,
    job `1db03f48-e751-4c35-a7b1-8db967ce4244`): failed with max turns before
    verdict.
  - Claude rerun (`provider-capabilities-phase3-finalreview-claude-2`,
    job `6b053e7a-3287-42ef-b8da-b078b45c6bb5`): APPROVED. Verified Gemini
    `-s` in capability and `request-helpers.ts`, and verified the test
    assertions for Claude/Codex/Gemini gatewayRequestTools and Gemini
    unsupported behavior.

## Fixes Applied

- Aligned Gemini sandbox capability `cliFlag` with the actual gateway argv:
- First attempted `--sandbox` based on an incorrect reviewer note, then
  reverted to the actual emitted flag `-s` after Claude verified
  `request-helpers.ts` and existing Gemini handler tests.
- Added test assertions for Claude, Codex, and Gemini `gatewayRequestTools`,
  including `codex_fork_session`.
- Added a test assertion that Gemini
  `policyFiles/adminPolicyFiles/skipTrust` has behavior `not_supported`.

## Final Approval Status

- Claude: APPROVED.
- Gemini: APPROVED.
- Mistral: APPROVED.
- Grok: blocked by repeated provider-worker initialization/max-turn failure
  before review.

## Unresolved Blockers

Grok review could not be completed for this phase because every phase-3 Grok
attempt failed before inspection with `worker quit with fatal: unexpected server
response: expect initialized, accepted, when process initialize response`
followed by max-turn failure. Other reviewers approved the corrected code.
