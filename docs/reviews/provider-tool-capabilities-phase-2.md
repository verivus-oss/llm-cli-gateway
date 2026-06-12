# Provider Tool Capabilities Phase 2 Review

## Phase / Unit

Hardened skill/frontmatter/provider-tool extraction and redacted provider config-surface discovery.

## Changed Files

- `src/provider-tool-capabilities.ts`
- `src/__tests__/provider-tool-capabilities.test.ts`
- `docs/reviews/provider-tool-capabilities-phase-1.md`
- `docs/reviews/provider-tool-capabilities-phase-2.md`

This phase builds on the existing local first slice in `src/index.ts`,
`src/resources.ts`, `src/__tests__/integration.test.ts`, and the new v2 schema
module/tests. Existing unrelated local changes in `README.md`, `socket.yml`,
and `src/__tests__/mcp-surface-usability.test.ts` are still present.

## Verification

- `npx vitest run src/__tests__/provider-tool-capabilities.test.ts`
  - Initial result: passed, 7 tests.
  - After indentation fix: passed, 7 tests.
- `npm run build`
  - Initial result: passed.
  - After indentation fix: passed.

## Reviewer Prompt Scope

Reviewers are asked to inspect code and tests directly. Scope:

- YAML-ish frontmatter parsing for `name`, `description`, and
  `metadata.short-description`.
- Folded (`>`, `>-`) and literal (`|`, `|-`) scalar handling.
- Provider-native tool extraction with bounded counts, confidence, and reason.
- Grok known native tool allow-list including Imagine tools and local agent
  tools.
- Noise filtering for values such as `file:line`, `name:`, `max_results`, and
  `session_id`.
- Bounded, read-only config discovery for Claude, Codex, Gemini/Antigravity,
  Grok, Mistral/Vibe, and `grok_api`.
- Config output must be boolean/count/name-only by default, with raw paths
  gated by `includePaths=true`, and no command/env/auth/secret values emitted.

## Reviewer Findings

- Claude (`provider-capabilities-phase2-review-claude`,
  job `bfc58555-c96c-4918-8e8d-5d8530fcc5ba`): APPROVED.
  - Non-blocking: tool extraction capped before sorting, making the retained
    set insertion-order-dependent for skills declaring more than 50 tools.
  - Non-blocking: `low-confidence` extraction reason is declared but not
    produced by current extraction paths.
- Gemini (`provider-capabilities-phase2-review-gemini`,
  job `77ef4112-a5d8-4124-afd9-ec083e6e5186`): NOT APPROVED.
  - **Medium**: `extractBlockScalar` checks if a line starts with
    non-whitespace to terminate block scalar parsing, but does not check
    indentation level. As a result, indented sibling properties in YAML
    frontmatter can be consumed as part of the block scalar description.
- Mistral (`provider-capabilities-phase2-review-mistral`,
  job `0d194869-42a6-478f-a908-beae6988dbda`): APPROVED.
  - Low: frontmatter end detection assumes a `\n---` pattern.
  - Low: tool section identifier pattern is lowercase-only.
- Grok (`provider-capabilities-phase2-review-grok`,
  job `9c8efc33-fe75-4ede-90ae-4977b56c841e`): failed before review with the
  same provider-worker initialization error seen in phase 1:
  `worker quit with fatal: unexpected server response: expect initialized,
  accepted, when process initialize response`.
- Re-review after fixes:
  - Gemini (`provider-capabilities-phase2-rereview-gemini`,
    job `d084eaf0-83da-47b1-88e4-7f7f9491b366`): APPROVED. Verified the
    indentation blocker is fixed and no new issues were introduced.
  - Claude (`provider-capabilities-phase2-rereview-claude`,
    job `5305da21-e771-4dc5-bd51-41e0e535a094`): APPROVED. Verified the
    indentation fix, the nested regression fixture, and deterministic
    sort-before-cap behavior.
  - Mistral (`provider-capabilities-phase2-rereview-mistral`,
    job `bc2bc825-0231-41c4-9719-7db823aca451`): APPROVED. Verified the
    indentation fix, deterministic sort, and regression test.
  - Grok (`provider-capabilities-phase2-rereview-grok`,
    job `382569dd-bc7b-481e-b2bd-3e2ce0525e3f`): APPROVED. The job still
    emitted the provider-worker initialization stderr seen previously, but it
    recovered and produced an approving review verdict.

## Fixes Applied

- Fixed `extractBlockScalar` to terminate when indentation returns to the
  scalar key's indentation level or lower.
- Added a regression fixture where `metadata.short-description: |-` is followed
  by an indented sibling key; the sibling is no longer consumed into the
  description.
- Sorted extracted tool entries before applying `MAX_PROVIDER_TOOLS_PER_SKILL`
  so capped output is deterministic.

## Final Approval Status

- Claude: APPROVED.
- Gemini: APPROVED.
- Mistral: APPROVED.
- Grok: APPROVED.

## Unresolved Blockers

None for this phase. Grok emitted a provider-worker initialization stderr line
during re-review but completed and approved.
