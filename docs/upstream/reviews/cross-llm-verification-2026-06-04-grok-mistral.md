# Verification report (corrective-program spec)

**Review target:** Uncommitted working tree at `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`  
**Date:** 2026-06-04  
**Installed CLIs probed:** `grok 0.2.20`, `vibe 2.12.1`

## Changed files (`git status --porcelain`)

```
 M CHANGELOG.md
 M docs/upstream/snapshots/grok.json
 M src/__tests__/grok-handler.test.ts
 M src/index.ts
 M src/upstream-contracts.ts
?? docs/upstream/reports/2026-06-03-mistral.md
?? docs/upstream/snapshots/mistral.json
```

## Corrective-program requirements (what "correct" means)

1. **Upstream contract truth:** `UPSTREAM_CLI_CONTRACTS` in `src/upstream-contracts.ts` must match installed `grok --help` and `vibe --help` for watched categories (flags, session-resume, output-formats, agent-modes/env-model).
2. **Conformance fixtures:** Every non-grandfathered contract flag must have a passing `expect: "pass"` fixture (see `src/__tests__/test-veracity-regressions.test.ts` REGRESSIONS F).
3. **MCP parameter parity:** Every entry in `mcpParameters` for `grok` must appear on `grok_request` and `grok_request_async` Zod schemas (same test file REGRESSIONS E pattern).
4. **Argv wiring:** `prepareGrokRequest` must emit CLI flags matching MCP params; `validateUpstreamCliArgs("grok", args)` must pass before spawn.
5. **Mistral contract-only flags** (`--prompt`, `--setup`, `--version`, `-v`): contract + fixtures sufficient; gateway may continue using `-p` (no MCP emission required unless intentionally exposed).
6. **Grok `--resume`:** contract arity `optional` (bare `--resume` valid per `grok --help`).
7. **Grok headless MCP params:** `agent`, `bestOfN`, `check`, `disableWebSearch`, `todoGate`, `verbatim` wired end-to-end; `verbatim` skips `optimizePrompt` when true.
8. **Probe drift:** `npm run upstream:scan -- --live --provider grok --provider mistral --probe-installed` → `extraVsContract: []` for both snapshots.
9. **Grok extended help-surface MCP params (final):** `agents`, `promptFile`, `promptJson`, `single`, `experimentalMemory`, `noAltScreen`, `noMemory`, `noPlan`, `noSubagents`, `oauth`, `restoreCode`, `nativeWorktree` in `grok.mcpParameters`, Zod schemas, `prepareGrokRequest` argv, and tests. `nativeWorktree` emits Grok CLI `--worktree`; gateway slice λ `worktree` remains separate.
10. **Mistral complete contract coverage:** All Vibe 2.12.x watched flags in contract + fixtures; programmatic gateway path via existing `mistral.mcpParameters`; `--resume` optional arity; no drift vs `vibe --help`.

## Round 2 corrective fixes (2026-06-04, post cross-LLM review)

| Finding | Fix | Evidence |
|--------|-----|----------|
| No test that `verbatim: true` skips `optimizePrompt` | Added `grok-handler.test.ts` case comparing `effectivePrompt` with/without `verbatim` while `optimizePrompt: true` | `src/__tests__/grok-handler.test.ts` — `skips gateway optimizePrompt when verbatim is true` |
| REGRESSIONS E/C gap for headless MCP params | Extended `test-veracity-regressions.test.ts` REGRESSIONS C + E for `agent`, `bestOfN`, `check`, `disableWebSearch`, `todoGate`, `verbatim` | Same file, REGRESSIONS C/E blocks |
| Mistral `--resume` arity mismatch | Contract `--resume` → `optional` + fixture `mistral-resume-bare` (Codex r2 blocker) | `src/upstream-contracts.ts` ~1064, fixture ~1203 |
| `verbatim` skipped optimization in name only | `prepareGrokRequest` now gates `optimizePrompt` with `!skipPromptOptimization` | `src/index.ts` ~2447–2451 |
| Extended Grok help-surface flags not on MCP | Added 12 params to contract + handler + Zod + tests | `upstream-contracts.ts` ~755–768, `index.ts` prepareGrokRequest + tool schemas, `grok-handler.test.ts` |

## Commands run (evidence)

```text
$ npm run build
> tsc -p tsconfig.build.json
(exit 0)

$ npm run upstream:contracts
[upstream-scan] contracts-check OK: 5 providers, fixtures + report + TOML-sync verified (offline).

$ npm test
 Test Files  62 passed (62)
      Tests  1044 passed (1044)

$ npm run upstream:scan -- --live --provider grok --probe-installed --write-snapshot
 extraVsContract: []
 missingFromBinary: []

$ npm run upstream:scan -- --live --provider mistral --probe-installed --write-snapshot
 extraVsContract: []
 missingFromBinary: []
```

## Installed help surfaces (spot-check)

**grok 0.2.20** advertises (excerpt): `--agent`, `--best-of-n`, `--check`, `--compaction-mode`, `--compaction-detail`, `--disable-web-search`, `--todo-gate`, `--verbatim`, `-r, --resume [<SESSION_ID>]`.

**vibe 2.12.1** advertises (excerpt): `-p, --prompt [TEXT]`, `--setup`, `-v, --version`, plus existing programmatic flags.

## UNASSESSABLE (no runtime spawn test in this report)

- Whether `grok` CLI actually accepts combined flag sets at runtime (contract validation only).
- Whether `bestOfN` parallel runs succeed on this host's Grok auth/subscription.

## Reviewer instructions

Read the files yourself under the repo root. Reproduce `git diff` and run the verification commands. Do **not** accept the implementer's summary as evidence. Approve only on inspected code/tests/docs with file:line citations, or name one concrete unresolvable blocker.