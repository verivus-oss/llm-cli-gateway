# Slice λ test-veracity audit by Mistral (round 1)

## Mutation probe results

All 9 mutation probes turned their corresponding cited assertions RED.

| Probe | Mutation | File | Tests that went RED | Observed |
|-------|----------|------|---------------------|----------|
| Lα | Removed `..` / slash / leading-dot / leading-hyphen guards from `sanitizeWorktreeName` + weakened NAME_PATTERN | `src/worktree-manager.ts` | `worktree-manager.test.ts` (6 tests: "rejects '.' and '..'", "rejects names starting with '.'", "rejects names starting with '-'", "rejects names containing '..'", "rejects names containing forward or back slashes", "rejects whitespace..."), + `test-veracity-regressions-slice-lambda.test.ts` Lα-1 | All cited tests went RED |
| Lβ | Pass `refArg` directly to `git worktree add` (skip rev-parse) | `src/worktree-manager.ts` | `worktree-manager.test.ts` "resolves ref to a 40-char SHA...", + `test-veracity-regressions-slice-lambda.test.ts` Lβ-1 | Lβ-1: `handle.ref` = "HEAD" (not 40-char SHA) |
| Lγ | Commented out `updateSessionMetadata` call in `resolveWorktreeForRequest` | `src/index.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lγ-1 | Lγ-1: `metadata.worktreePath` = undefined (expected path) |
| Lδ | Dropped session-metadata reuse branch in `resolveWorktreeForRequest` | `src/index.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lδ-1 | Lδ-1: second call returns different path (not reused) |
| Lε | Commented out `invokeCleanupHook` in `FileSessionManager.deleteSession` | `src/session-manager.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lε-1 | Lε-1: hook called 0 times (expected 1) |
| Lζ | Dropped `cwd` from spawn options in `executor.executeCli` | `src/executor.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lζ-1 | Lζ-1: pwd returns gateway cwd (not tmp) |
| Lη | Added `args.push("-w")` to all 5 prepare functions | `src/index.ts`, `src/request-helpers.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lη-1..5 | All 5 tests: args contain "-w" |
| Lθ | Omitted `cwd` from dedup key in `AsyncJobManager.buildRequestKey` | `src/async-job-manager.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lθ-1 | Lθ-1: `b.deduped` = true (expected false) |
| Lψ | Changed prefix literal in `formatWorktreePrefix` | `src/index.ts` | `test-veracity-regressions-slice-lambda.test.ts` Lψ-1 | Lψ-1: returns `[CHANGED]...` (expected `[gateway]...`) |

## Build/test/format/oracle/worktree-list

```
Build:   npm run build                     ✅ PASS
Test:    npm test                         ✅ PASS (989 tests pass)
Format:  npm run format:check              ✅ PASS
Oracle:  validateUpstreamCliArgs rejects -w ✅ PASS (contract gate catches)
Worktree: git worktree list --porcelain    ✅ audit-mistral present
```

## Findings

- All 9 mutation probes (Lα–Lθ + Lψ) successfully turned their cited test assertions RED.
- Each probe caused **only** its targeted regression tests to fail — no collateral damage observed.
- The test suite correctly pins all slice-λ features with falsifiable assertions.
- Clean tree passes all 989 tests, build, format check, and contract gate validation.

## Approval

**UNCONDITIONAL APPROVE**

All mutation probes verified. Tests are genuine pins, not cargo-cult coverage.
