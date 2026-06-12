# Provider Tool Capabilities Phase 1 Review

## Phase / Unit

Schema, query options, `grok_api` provider identity, resource parsing, and short-lived capability cache.

## Changed Files

- `src/provider-tool-capabilities.ts` (new in this working tree)
- `src/resources.ts`
- `src/index.ts`
- `src/__tests__/provider-tool-capabilities.test.ts` (new in this working tree)
- `src/__tests__/integration.test.ts`

Existing unrelated or earlier-slice local changes are present in `README.md`,
`socket.yml`, and `src/__tests__/mcp-surface-usability.test.ts`; this phase did
not intentionally modify them.

## Verification

- `npx vitest run src/__tests__/provider-tool-capabilities.test.ts`
  - Result: passed, 5 tests.
- `npm run build`
  - Result: passed.

## Reviewer Prompt Scope

Reviewers are asked to inspect the code and tests directly, not rely on this
summary. Scope:

- v2 top-level schema fields:
  `schemaVersion`, `generatedAt`, `cli`, `providerKind`,
  `gatewayRequestTools`, `modelInfo`, `controls`, `features`,
  `discoveredSkills`, `discoveredProviderTools`, `configSurfaces`,
  `unsupportedInputs`, `warnings`.
- Query options:
  `cli`, `includeSkills`, `includeProviderTools`, `includeUnsupported`,
  `includePaths`, `refresh`.
- `grok_api` must be distinct from Grok CLI and represented as an API provider.
- Path output must be redacted by default and raw paths gated by
  `includePaths=true`.
- Cache TTL is 60 seconds, with `refresh=true` bypassing cache.
- Capability discovery must remain read-only and bounded.

## Reviewer Findings

- Claude (`provider-capabilities-phase1-review-claude-rerun`,
  job `a3e1a7bf-d4d3-4958-bf1d-d3f05ed01076`): APPROVED.
  - Low, non-blocking: cached capability objects are returned by reference, so
    a mutating caller could affect the cache during the 60 second TTL. Current
    callers stringify immediately.
  - Low, non-blocking: `generatedAt` is the cached-build timestamp inside the
    TTL, not the current call time.
  - Note, out of this unit's scope: frontmatter hardening for `>-` / `|-` and
    provider known-tool confidence belongs to the next discovery phase.
- Gemini (`provider-capabilities-phase1-review-gemini`,
  job `2bfb6fe3-768e-4752-8818-368c2accb5ad`): APPROVED.
  - Verified schema, query options, path gating, cache, `grok_api` filtering,
    resources, read-only behavior, and no stdout logging. Gemini also ran
    `npm run build`, the provider capability test, lint, and full Vitest suite
    during review and reported them passing.
  - First Gemini dispatch with `mcpServers` failed because the gateway rejects
    that input for Antigravity; the rerun omitted `mcpServers` and completed.
- Mistral (`provider-capabilities-phase1-review-mistral`,
  job `9421a93f-9c0d-48bc-868d-7b806d5c625b`): APPROVED.
  - Verified v2 schema, `grok_api`, query defaults, redaction, cache,
    `provider-tools://grok_api`, bounded reads, Zod boundary, explicit return
    types, and no stdout logging.
  - First Mistral dispatch with full bypass plus external MCP servers was
    denied by MCP-managed approval policy; the rerun with local MCP servers and
    default permission mode completed.
- Grok:
  - App connector dispatch failed with `UNAVAILABLE; McpServerError:
    Connection failed`.
  - Gateway job `96780436-cb0f-452f-ad4c-52fbc90fdb19` and rerun job
    `7ca89600-18ef-4a90-8b07-b5be2092499a` both failed before review with
    `worker quit with fatal: unexpected server response: expect initialized,
    accepted, when process initialize response`. Both jobs later reported as
    already completed when cancellation was attempted. No Grok review verdict
    was produced.

## Fixes Applied

No code fixes were required by blocking reviewer findings in this phase.
Claude's two low-severity notes are documented for possible hardening in a
later pass; they are not blockers for the schema/query/cache unit.

## Final Approval Status

- Claude: APPROVED.
- Gemini: APPROVED.
- Mistral: APPROVED.
- Grok: blocked by provider-worker initialization failure before review could
  inspect code.

## Unresolved Blockers

Grok review could not be completed because the local Grok worker failed during
initialization on two gateway attempts and the app connector path was
unavailable. This is an infrastructure/provider availability blocker rather
than a code finding from the phase-1 implementation.
