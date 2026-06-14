# Local stdio vs remote HTTP workspace gating review report

Date: 2026-06-14

Source spec: `docs/plans/local-stdio-remote-http-workspace-gating.spec.md`

DAG: `docs/plans/local-stdio-remote-http-workspace-gating.dag.toml`

## Changed files reviewed

- `src/request-context.ts`
- `src/http-transport.ts`
- `src/index.ts`
- `src/workspace-registry.ts` (confirmed unchanged)
- `src/__tests__/workspace-registry.test.ts`
- `src/__tests__/http-transport.test.ts`
- `README.md`
- `docs/personal-mcp/PRODUCT_CONTRACT.md`
- `docs/personal-mcp/ENDPOINT_EXPOSURE.md`
- `docs/personal-mcp/connect-chatgpt.md`
- `docs/personal-mcp/connect-claude.md`
- `docs/personal-mcp/connect-claude-desktop.md`
- `docs/personal-mcp/connect-codex.md`
- `docs/personal-mcp/connect-gemini-cli.md`
- `docs/personal-mcp/connect-grok.md`

Diff command supplied to reviewers:

```bash
git diff -- src/request-context.ts src/http-transport.ts src/index.ts src/workspace-registry.ts src/__tests__/workspace-registry.test.ts src/__tests__/http-transport.test.ts README.md docs/personal-mcp/PRODUCT_CONTRACT.md docs/personal-mcp/ENDPOINT_EXPOSURE.md docs/personal-mcp/connect-chatgpt.md docs/personal-mcp/connect-claude.md docs/personal-mcp/connect-claude-desktop.md docs/personal-mcp/connect-codex.md docs/personal-mcp/connect-gemini-cli.md docs/personal-mcp/connect-grok.md
```

## Local verification

- `npx vitest run src/__tests__/workspace-registry.test.ts src/__tests__/http-transport.test.ts`: pass, 40 tests.
- `npm run build`: pass.
- `npm run lint`: pass exit 0, existing warnings only.
- `npm run format`: pass.
- `npm run format:check`: pass.
- `npm test`: pass, 85 files, 1435 tests.

## Cross-LLM review gate

Reviewers were instructed to inspect the source spec, DAG, diff, code, docs, and tests directly, not to rely on implementation summaries. Each reviewer was asked to verify HTTP fail-closed behavior across bearer, OAuth, auth-disabled, and no-auth connector paths; local stdio/no-context behavior; `allow_unregistered_working_dir`; all sync/async provider tools plus `codex_fork_session`; registered workspace escape validation; workspace admin authorization; and docs.

| Reviewer | Job ID | Verdict |
| --- | --- | --- |
| Claude | `2c723574-1f0c-4c9e-b07c-300a29a75002` | APPROVED |
| Codex | `b6fc458f-8c7d-4970-b7d6-d99808b9da76` | APPROVED |
| Gemini | `eaab236e-b234-47f8-9f46-f535e0eb961f` | APPROVED |
| Grok | `5d25b542-36c4-431d-9694-84b744f5f2db` | APPROVED |
| Mistral | `cb50584a-086a-4f42-aa09-7eb7d522bed5` | APPROVED |

## Summary

All reviewers returned unconditional `APPROVED`. No concrete blockers were reported.
