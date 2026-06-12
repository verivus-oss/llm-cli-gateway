# Provider Tool Capabilities Final Review

## Phase / Unit

Final release-gate verification and end-to-end review for the provider
tool/feature capability enhancement.

## Changed Files

Capability implementation and tests:

- `src/provider-tool-capabilities.ts`
- `src/index.ts`
- `src/resources.ts`
- `src/doctor.ts`
- `src/__tests__/provider-tool-capabilities.test.ts`
- `src/__tests__/doctor.test.ts`
- `src/__tests__/integration.test.ts`
- `src/__tests__/mcp-surface-usability.test.ts`

Documentation and setup:

- `README.md`
- `setup/status.schema.json`
- `setup/assistants/ASSISTANT_CONTRACT.md`
- `setup/assistants/universal-install-prompt.md`
- `docs/reviews/provider-tool-capabilities-phase-1.md`
- `docs/reviews/provider-tool-capabilities-phase-2.md`
- `docs/reviews/provider-tool-capabilities-phase-3.md`
- `docs/reviews/provider-tool-capabilities-phase-4.md`
- `docs/reviews/provider-tool-capabilities-phase-5.md`

Local context files already present in the working tree remain untouched where
unrelated, including `socket.yml` and research artifacts.

## Verification

- `npm run build`
  - Result: passed.
- `npm run lint`
  - Result: passed with existing ignored-test-file warnings; no errors.
- `npm run format:check`
  - Result: passed.
- `npm test`
  - Result: passed, 77 test files and 1201 tests.
- `npm run upstream:contracts`
  - Result: passed; 5 providers, fixtures, report, and TOML sync verified offline.
- `INTEGRATION_TESTS=1 npx vitest run src/__tests__/integration.test.ts`
  - Result: passed, 44 tests.
- `npx vitest run src/__tests__/provider-tool-capabilities.test.ts src/__tests__/doctor.test.ts`
  - Result: passed, 32 tests.

## Reviewer Prompt Scope

Reviewers should inspect the full provider capability enhancement directly,
including:

- v2 provider capability schema and query options.
- Read-only bounded skill/frontmatter/provider-tool extraction.
- Redacted config-surface discovery and path-gating.
- Short-lived capability cache and `refresh` behavior.
- Full per-provider coverage for Claude Code, Codex CLI, Gemini/Antigravity,
  Grok CLI, optional `grok_api`, and Mistral Vibe.
- `provider_tool_capabilities` MCP tool, `provider-tools://catalog`, and all
  per-provider resources.
- `doctor.provider_capabilities` compact summary and schema.
- README/setup guidance.
- Complete test matrix and final gate outputs above.

## Reviewer Findings

- **Claude (`4b6b8d70-fd0a-4a7f-877a-a51c4df35cd4`)**: APPROVED.
  - Independently reran `npm run build`, `npm run lint`,
    `npm run format:check`, and focused provider/doctor tests.
  - Verified v2 schema/options, bounded discovery, all six providers, tool and
    resource wiring, doctor summary, docs, and tests.
  - Noted the recurring Grok reviewer failure as external infrastructure, not a
    code finding.
- **Gemini (`14eb21c3-78f5-4279-bac7-f0b2ae582ce6`)**: APPROVED.
  - Rechecked phase artifacts, implementation, resources, doctor schema, docs,
    build, lint, format, upstream contracts, integration tests, focused tests,
    and full test suite.
  - Gemini was run with its supported approval surface because Antigravity
    rejects non-interactive `allowedTools` and `mcpServers` fields.
- **Mistral (`10fa38ad-3a9c-4e56-be73-35217cef0030`)**: APPROVED.
  - Verified v2 schema/options, bounded discovery, all six providers,
    tool/resource/doctor/docs wiring, cache behavior, and final gates.
- **Grok (`1ea52d58-8975-4c9d-8b98-a3cc6e4612de`)**: blocked before
  inspection.
  - Stderr reported Grok agent-building failure:
    `auto_background_on_timeout requires enabled_background to be true`.
- Review dispatch note: final prompts included "Do not edit files", which the
  gateway review-integrity checker flagged as tool-suppression language. The
  reviewers still received read/verify tools and inspected code/tests/docs
  directly; completed reviewers produced concrete evidence and approvals.
- **Clean final re-review, Claude
  (`67963058-25cd-4194-8b60-036fa4c7516c`)**: APPROVED.
  - Review-integrity warnings were clear.
  - Re-ran build, lint, format check, provider/doctor focused tests, and MCP
    surface usability tests; inspected code/tests/docs directly.
- **Clean final re-review, Gemini
  (`9f6cf473-7e8a-41d1-8be3-dbd97f6c3165`)**: APPROVED.
  - Used Antigravity's supported approval surface because it rejects
    non-interactive `allowedTools` and `mcpServers`.
  - Inspected code/tests/docs directly and reran build, lint, format check,
    upstream contracts, focused tests, integration tests, and MCP usability
    tests.
- **Clean final re-review, Mistral
  (`09242857-f99f-4fe2-8e1e-c3192ef6c4bc`)**: APPROVED.
  - Verified schema/options, bounded extraction, path redaction, cache, all
    providers, tool/resource/doctor/docs wiring, and final gates.
- **Clean final re-review, Grok
  (`6bc0692c-b37b-4009-b92e-31d5227de90d`)**: APPROVED.
  - Earlier Grok failures were caused by review dispatch using Claude-style
    `allowedTools` values (`Read`, `Grep`, `Glob`, `Bash`) against Grok's
    internal tool surface. Retrying with `approvalStrategy`, `permissionMode`,
    `alwaysApprove`, and MCP access intact but without the mismatched allowlist
    let Grok initialize and inspect code/tests/docs directly.
  - Re-ran the full verification matrix and found no blockers.

## Fixes Applied

- No final-review code fixes were required.
- Earlier phases applied all requested schema, query, discovery, provider
  coverage, resource, doctor, docs, and test changes.

## Final Approval Status

APPROVED by Claude, Gemini, Mistral, and Grok in the clean final re-review.

## Unresolved Blockers

None. The earlier Grok startup failure was resolved by correcting the review
dispatch for Grok's provider-specific tool surface.
