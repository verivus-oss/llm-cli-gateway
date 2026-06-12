# Provider Tool Capabilities Phase 5 Review

## Phase / Unit

Resources, tool wiring, doctor compact summary, README/setup guidance, and
focused tests.

## Changed Files

- `src/doctor.ts`
- `setup/status.schema.json`
- `src/__tests__/doctor.test.ts`
- `src/__tests__/provider-tool-capabilities.test.ts`
- `README.md`
- `setup/assistants/ASSISTANT_CONTRACT.md`
- `setup/assistants/universal-install-prompt.md`
- Existing earlier-phase wiring under `src/index.ts`, `src/resources.ts`,
  `src/__tests__/integration.test.ts`, and
  `src/__tests__/mcp-surface-usability.test.ts`

## Verification

- `npx vitest run src/__tests__/provider-tool-capabilities.test.ts src/__tests__/doctor.test.ts src/__tests__/mcp-surface-usability.test.ts src/__tests__/integration.test.ts`
  - Result: passed, 37 tests across 3 executed test files.
- `npm run build`
  - Result: passed.
- `npx prettier --write src/doctor.ts src/__tests__/doctor.test.ts src/__tests__/provider-tool-capabilities.test.ts setup/status.schema.json README.md setup/assistants/ASSISTANT_CONTRACT.md setup/assistants/universal-install-prompt.md docs/reviews/provider-tool-capabilities-phase-4.md`
  - Result: completed; only the provider capability test needed formatting.

## Reviewer Prompt Scope

Reviewers should verify directly against code, tests, docs, and resources:

- `provider_tool_capabilities` tool schema and query options:
  `cli`, `includeSkills`, `includeProviderTools`, `includeUnsupported`,
  `includePaths`, `refresh`.
- MCP resources:
  `provider-tools://catalog` and every per-provider resource
  `provider-tools://claude`, `provider-tools://codex`,
  `provider-tools://gemini`, `provider-tools://grok`,
  `provider-tools://grok_api`, and `provider-tools://mistral`.
- `doctor --json` compact `provider_capabilities` summary:
  schema version, tool/resource pointers, cache TTL, provider kind, CLI/API
  availability, gateway request tool names, supported feature names,
  unsupported input names, config-surface count, discovered counts, and
  warnings without raw local paths.
- `setup/status.schema.json` matches the emitted doctor report.
- README and assistant setup guidance explain the capability tool/resource and
  instruct assistants to rely on `doctor.provider_capabilities`.

## Reviewer Findings

- **Claude (`64e4a590-f391-4afb-96f5-84e96f442ec8`)**: APPROVED.
  - Verified the `provider_tool_capabilities` Zod schema and query option
    threading in `src/index.ts`.
  - Verified `provider-tools://catalog` and per-provider resource parsing in
    `src/resources.ts`, including `grok_api`.
  - Verified `doctor.provider_capabilities` emits a compact summary without
    raw paths and that `setup/status.schema.json` matches the live report.
  - Non-blocking observations: `doctor.ts` hardcodes `cache_ttl_ms: 60_000`
    rather than importing the capability cache constant; the per-provider
    resource description is generic for `grok_api`.
- **Gemini (`af0c7a5f-5de3-41cd-8197-4c655a44a605`)**: APPROVED.
  - Verified tool schema/options, resource wiring, doctor summary, schema,
    README/setup guidance, focused tests, integration tests, and build.
  - Gemini was run with its supported approval surface because Antigravity
    rejects non-interactive `allowedTools` and `mcpServers` fields.
- **Mistral (`b8a71597-5ac2-4970-847b-2ed179ea844c`)**: APPROVED.
  - Verified all phase-5 scope items against code, tests, docs, and resources.
- **Grok (`0174ce6a-a3c4-4612-a7c2-391400c5548b`)**: blocked before
  inspection.
  - Stderr reported Grok agent-building failure:
    `auto_background_on_timeout requires enabled_background to be true`.

## Fixes Applied

- Added top-level `doctor.provider_capabilities` compact summary in
  `src/doctor.ts`.
- Updated `setup/status.schema.json` to require and validate the new doctor
  block.
- Added doctor tests for the compact summary, resource URIs, `grok_api`, feature
  names, unsupported input names, and path-redaction expectations.
- Extended provider resource tests to read every `provider-tools://{provider}`
  URI.
- Updated README and setup assistant guidance to document
  `provider_tool_capabilities`, `provider-tools://...`, and
  `doctor.provider_capabilities`.

## Final Approval Status

APPROVED by Claude, Gemini, and Mistral. Grok review could not run to
inspection because of repeated provider startup/configuration failures.

## Unresolved Blockers

Grok review remains externally blocked by provider startup/configuration
failure. No completed reviewer identified a code blocker.
