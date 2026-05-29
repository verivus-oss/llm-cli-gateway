## Slice λ test-veracity audit by Grok (round 1)

**Worktree:** `.worktrees/audit-grok` (detached @ c4293bb3d9047aa74fee9a6c81ec66355dc2c92a, feat/phase-4-slice-lambda tip)  
**Baseline (pre-mutation, post-all-reverts):** 49/49 (worktree-manager + regressions); full suite 989/989  
**Date:** 2026-05-28 (audit executed in isolated worktree per spec)

### Mutation probe results

All 9 probes executed in order (Lα → Lψ). Each used `search_replace` (state mutation), targeted `npx vitest run <file> -t "<substring>"`, observed RED counts + exact failing assertions, `git checkout -- <file>`, and green confirmation before next. All cited tests went RED on the exact mutations specified in slice-lambda.spec.md and the test file preambles. Collateral failures (other guards) noted where they occurred but did not affect verdict.

- **Lα** (remove `..` / slash / leading-dot guards in `sanitizeWorktreeName`):  
  Ran `worktree-manager.test.ts` + `test-veracity-regressions-slice-lambda.test.ts` -t "sanitizeWorktreeName|REGRESSIONS Lα".  
  **Observed:** 7 failed (6 in worktree-mgr + 1 in regressions).  
  Failing assertions (exact):  
  - `worktree-manager.test.ts:77`: `expect(() => sanitizeWorktreeName(".")).toThrow(WorktreeError);` → "expected function to throw an error, but it didn't"  
  - `worktree-manager.test.ts:95`: `expect(() => sanitizeWorktreeName("foo/bar")).toThrow(WorktreeError);` (slashes) + `foo\\bar` → same "didn't throw"  
  - `test-veracity-regressions-slice-lambda.test.ts:119` (Lα-1): `expect(() => sanitizeWorktreeName("..")).toThrow(WorktreeError);` + 7 more cases (../etc, foo/bar, .hidden, -flag, space, "") → "expected function to throw an error, but it didn't"  
  Revert + green (11 passed) confirmed.

- **Lβ** (pass refArg directly to `git worktree add`, skip rev-parse in `createWorktree`):  
  Ran targeted -t "resolves ref to a 40-char SHA|REGRESSIONS Lβ".  
  **Observed:** 2 failed (Lβ-1 in both files).  
  Failing assertions (exact):  
  - `worktree-manager.test.ts:156`: `expect(handle.ref).toMatch(/^[0-9a-f]{40}$/); expect(handle.ref).not.toBe("HEAD");` → "expected 'HEAD' to match /^[0-9a-f]{40}$/"  
  - `test-veracity-regressions-slice-lambda.test.ts:153` (Lβ-1): identical failure on returned handle.ref === "HEAD" instead of SHA.  
  Revert + green (3 passed) confirmed.

- **Lγ** (comment out `updateSessionMetadata` in `resolveWorktreeForRequest`, src/index.ts):  
  Ran -t "REGRESSIONS Lγ".  
  **Observed:** 1 failed (Lγ-1).  
  Failing assertion (exact):  
  - `test-veracity-regressions-slice-lambda.test.ts:199`: `expect(after.metadata?.worktreePath).toBe(resolution.worktreePath);` → "expected undefined to be '/tmp/lambda-reg-.../.worktrees/...'" (Lγ-2/3 unaffected).  
  Revert + green (3 passed) confirmed.

- **Lδ** (drop session-metadata reuse branch in `resolveWorktreeForRequest`):  
  Ran -t "REGRESSIONS Lδ".  
  **Observed:** 1 failed (Lδ-1).  
  Failing assertion (exact):  
  - `test-veracity-regressions-slice-lambda.test.ts:276`: `expect(second.worktreePath).toBe(first.worktreePath);` + list equality → "expected '/tmp/.../17c...' to be '/tmp/.../a21...'" (different UUID generated; afterList diverged).  
  Revert + green (2 passed) confirmed.

- **Lε** (comment out `this.invokeCleanupHook(session)` in `FileSessionManager.deleteSession`):  
  Ran -t "REGRESSIONS Lε".  
  **Observed:** 1 failed (Lε-1).  
  Failing assertion (exact):  
  - `test-veracity-regressions-slice-lambda.test.ts:328`: `expect(hook).toHaveBeenCalledTimes(1);` → "expected "vi.fn()" to be called 1 times, but got 0 times" (storage snapshot assert would also fail). Lε-2/3 unaffected.  
  Revert + green (3 passed) confirmed.

- **Lζ** (drop `cwd` from spawn options in `executor.executeCli`):  
  Ran `executor.test.ts` + regressions -t "working directory|should use specified...|REGRESSIONS Lζ".  
  **Observed:** 2 failed.  
  Failing assertions (exact):  
  - `executor.test.ts:266`: `expect(result.stdout.trim()).toBe("/tmp");` (with {cwd:"/tmp"}) → "expected '/srv/.../audit-grok' to be '/tmp'"  
  - `test-veracity-regressions-slice-lambda.test.ts:376` (Lζ-1): `expect(result.stdout.trim()).toBe(tmp);` → "expected '/srv/.../audit-grok' to be '/tmp/lambda-reg-cwd-...'"  
  Revert + green (3 passed) confirmed.

- **Lη** (`args.push("-w")` near argv emit in `prepareClaudeRequest` + all 4 other prepare* fns):  
  Ran -t "REGRESSIONS Lη".  
  **Observed:** 5 failed (Lη-1..5, one per CLI).  
  Failing assertions (exact, all identical pattern):  
  - Lη-1 (claude): `expect(prep.args).not.toContain("-w");` → "expected [ '-p', 'hello', ... ] to not include '-w'"  
  - Lη-2 (codex), Lη-3 (gemini), Lη-4 (grok), Lη-5 (mistral): same "to not include '-w'" (with their argv arrays).  
  Revert + green (5 passed) confirmed.

- **Lθ** (omit `cwd` from key in `async-job-manager.buildRequestKey`):  
  Ran -t "REGRESSIONS Lθ".  
  **Observed:** 1 failed (Lθ-1).  
  Failing assertion (exact):  
  - `test-veracity-regressions-slice-lambda.test.ts:437`: `expect(b.deduped).toBe(false);` → "expected true to be false" (second job deduped despite different cwd="/tmp/wt-B"). Lθ-2/3 unaffected.  
  Revert + green (3 passed) confirmed.

- **Lψ** (change prefix literal in `formatWorktreePrefix`):  
  Ran -t "REGRESSIONS Lψ".  
  **Observed:** 1 failed (Lψ-1).  
  Failing assertion (exact):  
  - `test-veracity-regressions-slice-lambda.test.ts:474`: `expect(formatWorktreePrefix("/tmp/wt-1")).toBe("[gateway] worktree=/tmp/wt-1\n");` → "expected '[wt] /tmp/wt-1\n' to be '[gateway] worktree=/tmp/wt-1\n'"  
  Lψ-2 unaffected. Revert + green (2 passed) confirmed.

All 9 probes: 100% of cited assertions produced RED failures matching the spec's "Should turn RED" column. 0 false-negatives (no test passed under its mutation).

### Build/test/format/oracle/worktree-list

- `npm run build`: exit 0 (tsc -p tsconfig.build.json clean)
- `npm test`: exit 0 → "Test Files 59 passed (59) / Tests 989 passed (989)" (Duration ~40s)
- `npm run format:check`: exit 0 → "All matched files use Prettier code style!"
- Negative oracle (post-build, via `node --input-type=module` on dist/):  
  `validateUpstreamCliArgs("claude", ["-p", "hello", "-w", "foo"])` → `{ ok: false, violations: [ { cli: 'claude', arg: '-w', ... 'Unsupported claude CLI flag "-w" for bundled upstream contract' }, ... ] }`  
  (Exactly the contract-gate violation expected for the gateway-owned model; no -w ever reaches CLIs.)
- `git worktree list --porcelain` (post-run, from audit worktree):  
  Shows main + pre-existing audit worktrees (audit-codex/gemini/mistral + /tmp/* + claude agent lock + gemini tmp).  
  No test-induced pollution: tests use isolated `mkdtempSync` git repos under /tmp; all created `.worktrees/*` + `gateway/*` branches inside those tmp repos are rmTree'd in afterEach. Main repo `.worktrees/` contains only the 4 audit-* dirs (as expected). No stray detached worktrees or unpruned gateway/ branches from λ test runs.

### Findings

- **Evidence of veracity:** Every single mutation probe (Lα–Lψ) caused precisely the named tests/its in the spec and regression file (plus the supporting unit tests in worktree-manager.test.ts and executor.test.ts) to fail with the exact assertion text that the spec said must go RED. Reverts restored green every time. This is strict falsifiability — the tests are not theater; they pin the implementation details (sanitization, ref resolution before add, session metadata write + reuse, cleanup hook timing, cwd threading to spawn + dedup, no -w emission, prefix literal shape).
- The 23 REGRESSIONS tests (Lα-1/2 ... Lψ-1/2) + supporting units form a complete mutation-probe matrix for the slice. Lη's 5-way coverage + negative oracle on the contract gate is particularly strong evidence that the "gateway-owned, never emit -w" decision is locked.
- No discrepancies found between implementation (worktree-manager.ts:277, index.ts resolver/prepare/format/executor handoff, session-manager delete + hook, async-job-manager key) and the claims in docs/plans/slice-lambda.spec.md or the test preambles.
- Post-run hygiene (worktree list, no leaked git state) and full pipeline (build + 989 tests + format) all green.
- The 9 commits on the branch (a591bd6 spec → c4293bb tests) are correctly exercised by this audit harness.

### Approval

**UNCONDITIONAL APPROVE**

No concrete blockers. All required evidence (mutation probes turning the exact cited assertions RED, full pipeline green, negative oracle violation, clean worktree list) was observed directly in the isolated worktree. The tests on `feat/phase-4-slice-lambda` (v1.15.0) rigorously pin the gateway-owned worktree lifecycle for all 5 CLIs.

Smallest possible "fix" if any future drift: none required for this round.

---

**Commit of this report:** (will be captured below)  
**Grok (round 1) — strict-evidence test-veracity audit complete.**
