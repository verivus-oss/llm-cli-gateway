# Provider Tool Capabilities Phase 4 Review

## Phase / Unit

Grok CLI, optional `grok_api`, and Mistral/Vibe provider coverage group.

## Changed Files

- `src/provider-tool-capabilities.ts`
- `src/__tests__/provider-tool-capabilities.test.ts`
- `docs/reviews/provider-tool-capabilities-phase-4.md`

## Verification

- `npx vitest run src/__tests__/provider-tool-capabilities.test.ts`
  - Result: passed, 10 tests (including new feature assertions); rerun after
    Prettier formatting also passed.
- `npm run build`
  - Result: passed.
- `npm test`
  - Result: reported passed by Gemini reviewer during review-assisted verification.

## Reviewer Prompt Scope

Reviewers are asked to inspect code and tests directly. Scope:

- Grok CLI coverage for request tools, allow/deny aliases, allowed/disallowed
  tools, alwaysApprove, permission/approval controls, agents/subagents,
  web-search disable, memory/planning controls, prompt controls, output format,
  sandbox/workingDir/workspace/worktree/nativeWorktree, session/restore/leader
  controls, maxTurns/effort/reasoning/compaction controls, and mcpServers
  approval-tracking-only semantics.
- `grok_api` coverage as an API provider distinct from Grok CLI: request tool
  only when xAI provider is enabled, reasoning/max tokens/sampling/timeout/
  session controls, no local skills/tool allow-deny/workspace/Image route, and
  no API key value leakage.
- Mistral/Vibe coverage for enabled-tool allowlist, ignored disallowedTools,
  permission/agent modes, output format, trust, cost/loop limits, workingDir/
  addDir/workspace/worktree, session controls, mcpServers approval-tracking-only,
  and unsupported effort/reasoningEffort.

## Reviewer Findings

- **Claude review (`85001f19-bc65-4918-be61-ff4793bb6140`)**: NOT APPROVED initially.
  - Found that the `features` map contradicted supported provider `controls`.
  - Grok was missing `toolAllowDenyControls`, `structuredOutput`, `promptControl`, and `compactionControls` feature coverage.
  - Mistral was missing `enabledToolAllowlist`, `trustControl`, and allowlist feature coverage.
  - Requested tests for provider feature flags.
- **Gemini review (`ca1a0bff-60e4-4337-9f23-926d1fe92ce0`)**: APPROVED after applying fixes in the workspace.
  - Independently identified missing feature overrides and added focused test assertions.
- **Mistral review (`fb46bc74-3cf2-4d19-8398-c4d81c490395`)**: NOT APPROVED initially.
  - Requested explicit tests for Grok `outputFormat`, `workspace`, and `session` controls.
  - Requested explicit tests for `grok_api` unsupported `allowedTools/disallowedTools` and `workspace/worktree`.
  - Requested explicit tests for Grok and Mistral feature flags already present in implementation.
- **Grok review (`fa61bc66-3330-4294-b332-7a7a63773749`)**: blocked by provider worker startup failure before inspection.
  - Stderr: `unexpected server response: expect initialized, accepted, when process initialize response`; then `Max turns reached`.
- **Re-review, Claude (`1652a535-22af-4099-84d2-d699ad63bcf9`)**:
  APPROVED.
  - Verified Grok CLI, `grok_api`, and Mistral/Vibe controls, feature flags,
    unsupported inputs, and test coverage directly against code and tests.
- **Re-review, Gemini (`cd4249fc-8fdb-4d81-9bb2-66153728cd87`)**:
  APPROVED.
  - Verified focused provider capability tests, integration tests, doctor/MCP
    tests, upstream scan, and build during review.
  - Noted one Prettier wrap issue in the provider capability test; fixed with
    `npx prettier --write src/__tests__/provider-tool-capabilities.test.ts`.
  - Antigravity rejected non-interactive `allowedTools` and `mcpServers`
    request fields during reviewer dispatch; final Gemini run used its
    supported approval surface.
- **Re-review, Mistral (`76ff9d14-fdd3-4dab-9017-ee55f2431f79`)**:
  APPROVED.
  - Verified the previously missing test assertions for Grok controls,
    `grok_api` unsupported inputs, Mistral feature flags, and API key
    non-leakage.
- **Re-review, Grok (`45041867-b7db-4cdb-aef2-af542c86e38d`)**:
  blocked again before inspection.
  - Stderr reported Grok agent building failure:
    `auto_background_on_timeout requires enabled_background to be true`.
- **Gaps identified in initial implementation of feature definitions (Minor/Medium severity)**:
  - In `src/provider-tool-capabilities.ts`, several feature capability overrides specified by the implementation plan (`docs/plans/provider-tool-capabilities-full-coverage.dag.toml`) were omitted in the static provider capability maps, resulting in them defaulting to `false`:
    - `toolAllowDenyControls: true` was missing for `claude` and `grok` features.
    - `webSearchControl: true`, `memoryControl: true`, `promptControl: true`, and `compactionControls: true` were missing for `grok` features.
    - `enabledToolAllowlist: true` and `trustControl: true` were missing for `mistral` features.
  - The test suite did not verify the status of these specific feature flags.
- **Accurate schema and specifications mapping**:
  - Other aspects of the schema, including Grok CLI control structures, `grok_api` request tool exclusion when disabled, absence of local skills/image routes in `grok_api`, key/credential leakage protection, and Mistral Vibe support for enabled-tool allowlist / ignored disallowed tools, were correctly implemented.

## Fixes Applied

- Modified `src/provider-tool-capabilities.ts` to add the missing overrides in the static configurations:
  - Enabled `toolAllowDenyControls` for `claude` and `grok`.
  - Enabled `webSearchControl`, `memoryControl`, `promptControl`, and `compactionControls` for `grok`.
  - Enabled `enabledToolAllowlist` and `trustControl` for `mistral`.
- Extended the test cases in `src/__tests__/provider-tool-capabilities.test.ts` to assert that all these feature fields are correctly reported as `supported: true` for the respective providers.
- Extended the Grok/grok_api/Mistral test case with explicit assertions for Grok output/workspace/session controls and `grok_api` unsupported allow/deny and workspace/worktree inputs.
- Formatted modified files using Prettier to maintain project code style.
- Verified successfully using `npx vitest run src/__tests__/provider-tool-capabilities.test.ts` and `npm run build`.

## Final Approval Status

APPROVED by Claude, Gemini, and Mistral after fixes. Grok review could not run
to inspection because of repeated provider startup/configuration failures.

## Unresolved Blockers

Grok review remains externally blocked by provider-worker startup failures in
both attempts. No code blocker remains from the reviewers that completed
inspection.
