# Provider Subcommands Plan Review Packet — 2026-06-08

## Scope

Review only the plan/documentation changes for provider subcommand scope
expansion and Grok 0.2.33 planning:

- `docs/plans/provider-subcommands-scope-expansion.dag.toml`
- `docs/plans/grok-0.2.33-contract-sync.dag.toml`

The checkout also contains unrelated dirty work from the Grok API provider
slice. Do not treat those files as part of this review unless they create a
direct contradiction with the plan being reviewed.

## Baseline

- Repo: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`
- HEAD at review packet creation: `e7f700e66b08db12c80a6968b9ba8d2067795ab4`
- Current date in this environment: `2026-06-08`

## Verification Report

Commands already run for these plan changes:

```bash
git diff --check -- docs/plans/provider-subcommands-scope-expansion.dag.toml
npm run upstream:contracts
```

Observed result:

```text
git diff --check: passed with no output
npm run upstream:contracts:
[upstream-scan] contracts-check OK: 5 providers, fixtures + report + TOML-sync verified (offline).
```

Grok 0.2.33 investigation that informs the plan:

```text
grok --version
grok 0.2.33 (c0ddec061)

grok update --check --json
{"currentVersion":"0.2.33","latestVersion":"0.2.33","updateAvailable":false,"installer":"internal","channel":"stable","autoUpdate":false,"error":null}

npm run upstream:scan -- --provider grok --probe-installed
passed

npm run upstream:scan -- --live --provider grok --probe-installed --fail-on-critical
passed; fetched https://docs.x.ai/developers/release-notes.md with HTTP 200
```

## Review Iteration R1 Correction

Mistral R1 found a valid blocker:

- `docs/plans/provider-subcommands-scope-expansion.dag.toml` listed
  `CLAUDE.md` in `invariant_sources`, but `test -f CLAUDE.md` fails in this
  checkout.
- `docs/plans/grok-0.2.33-contract-sync.dag.toml` listed `CLAUDE.md` in
  `invariant_sources`, with the same missing-file problem.

Correction applied: removed the nonexistent `CLAUDE.md` invariant source from
both plan files. Existing provider skill docs and mechanical contract files
remain listed as invariant sources.

## Review Requirements

Reviewers must verify claims against code and docs directly. Do not approve
based on this packet, intent, plan compliance claims, or "should be fixed"
language.

Inspect at minimum:

- `docs/plans/provider-subcommands-scope-expansion.dag.toml`
- `docs/plans/grok-0.2.33-contract-sync.dag.toml`
- `src/upstream-contracts.ts`
- `scripts/upstream-scan.mjs`
- `src/__tests__/upstream-contracts.test.ts`
- `.agents/skills/provider-claude/SKILL.md`
- `.agents/skills/provider-codex/SKILL.md`
- `.agents/skills/provider-gemini/SKILL.md`
- `.agents/skills/provider-grok/SKILL.md`
- `.agents/skills/provider-mistral/SKILL.md`

Verify the plan addresses:

- all five providers: Claude, Codex, Gemini, Grok, Mistral/Vibe;
- separate subcommand/control-plane scope from existing request-tool argv
  validation;
- no arbitrary provider subcommand execution in the first slice;
- risk/exposure metadata before any future execution path;
- efficient tool tiering;
- token-efficient catalog/inspect/drift responses;
- raw help exclusion from snapshots and ordinary MCP responses;
- persistent review evidence and verification gates;
- no secret, credential-state, account-name, or local launcher-path leakage.

Reviewers should run read-only commands as needed, such as:

```bash
git status --short
git rev-parse HEAD
sed -n '1,260p' docs/plans/provider-subcommands-scope-expansion.dag.toml
sed -n '1,220p' docs/plans/grok-0.2.33-contract-sync.dag.toml
rg -n "subcommands|token|tier|raw help|provider_subcommands|validateUpstreamCli" docs/plans src scripts
npm run upstream:contracts
```

End with `APPROVED` only if approval is based on inspected files, docs, and
verification evidence. Otherwise end with `NOT APPROVED with findings` and
list concrete blockers with file/line references.
