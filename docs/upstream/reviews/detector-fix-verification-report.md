# Verification Report: Upstream Detector Fix (Grok CLI Help Surface Drift Detection)

**Date**: 2026-05-31  
**Purpose**: This document is the authoritative **corrective-program spec** for the upstream CLI change detector enhancement. Every reviewer LLM **must read this file first** (using their Read / sqry / Grep tools) and verify every claim directly against the source code, tests, generated artifacts, and documentation at the paths listed below. Do not accept any summary from the orchestrator.

**Review Scope (narrow — ignore all other dirty-tree noise)**:
The following 5 files + 2 verification artifacts constitute the complete change under review.

**Core changed files** (generate the minimal diff with):
```bash
git diff HEAD -- src/upstream-contracts.ts scripts/upstream-scan.mjs src/__tests__/upstream-contracts.test.ts docs/upstream/README.md .agents/skills/provider-grok/SKILL.md > /tmp/detector-fix.patch
```

1. `src/upstream-contracts.ts`
2. `scripts/upstream-scan.mjs`
3. `src/__tests__/upstream-contracts.test.ts`
4. `docs/upstream/README.md`
5. `.agents/skills/provider-grok/SKILL.md`

**Verification artifacts** (direct evidence that detection now works):
- `docs/upstream/snapshots/grok.json` (contains `helpSurface` with 39 discovered flags, 22 extras)
- `docs/upstream/reports/2026-05-31-grok.md` (contains the critical `installed-help-surface-drift` finding)

---

## 1. Original Problem Statement (verbatim grounding)

User query that triggered the work:
> "test the llm cli gateway, did it detect the changes to the grok cli changelog?"

Diagnosis (established via direct inspection before any code change):
- The tracked source for Grok (`https://docs.x.ai/developers/release-notes.md`) is a general xAI API/product page. It contains only a high-level "Grok Build is now available in beta" paragraph. No detailed flag, subcommand, or `--help` surface changelog.
- `probeInstalledCliContract` (pre-fix) only computed `missingFlags` via crude `!helpText.includes(flag)` against the *declared* contract keys. It never reported flags the installed binary advertises that the contract did not list.
- No snapshot for grok existed (`docs/upstream/snapshots/grok.json` was only `.gitkeep`).
- Installed `grok 0.2.14 (e0d895dcd)` (verified with `grok --version` and `--help`) supports many additional flags the contract (tuned for ~0.1.210 era) did not declare: `--worktree`, `--todo-gate`, `--best-of-n`, `--agent`/`--agents`, `--check`, `--experimental-memory`, `--no-plan`, subcommands (`mcp`, `sessions`, `worktree`, `agent`, etc.).
- Direct test (pre-fix): `validateUpstreamCliArgs("grok", ["-p", "hi", "--worktree"])` correctly rejected with "Unsupported grok CLI flag" — but the *detector* (the thing maintainers are supposed to run) gave zero warning.
- `npm run upstream:scan -- --live --provider grok` (even with the page fetch succeeding) produced no "changed" finding and no surface drift signal.

This was a clear failure of the detector to do what the multi-llm-review / secure-orchestration / provider-grok skills and the launch blog ("the next iteration of the upstream scan") described as its purpose.

---

## 2. Intended Outcomes (the Spec — must be verified claim-by-claim)

After the changes, the following **must hold** (all claims are testable via direct code inspection or re-running the documented commands):

1. The live scanner now supports `--probe-installed` (new flag parsed in `parseArgs` and `printHelp` in `scripts/upstream-scan.mjs`).
2. When `--probe-installed` is used together with `--live`, `runScan` calls the (now-richer) `probeInstalledCliContract` (loaded from the machinery), computes bidirectional diffs (extra flags in binary vs contract; missing declared flags), and emits findings with `category: "installed-help-surface-drift"` (critical) that name the extra flags and direct the reader to `src/upstream-contracts.ts` + watched categories.
3. `probeInstalledCliContract` (in `src/upstream-contracts.ts`) now:
   - Exports and uses a pure `extractDiscoveredFlags(helpText: string): readonly string[]` (long `--` regex, conservative noise filtering, lowercasing + `_`→`-` normalization).
   - Returns an `InstalledCliContractProbe` with the new fields: `extraFlags: readonly string[]`, `discoveredFlags: readonly string[]`, `helpHash?: string` (sha256 of full concatenated help), `versionHint?`, `probedAt`.
   - The success return path computes `discoveredFlags = extractDiscoveredFlags(helpText)`, `extraFlags = discoveredFlags.filter(f => !contractFlagSet.has(f))`, and the hash.
4. The offline gate (`npm run upstream:contracts` / `--contracts-check`) and plain `upstream:scan` (no `--probe-installed`) are **completely unaffected** (probe is only called inside the `if (flags.live && flags.probeInstalled)` block after the contractsCheck early return; `runContractsCheck` still calls `buildUpstreamContractReport()` with no options).
5. When `--write-snapshot` is used with `--probe-installed` on a live run for a provider whose binary is present, the written `<cli>.json` contains a top-level `helpSurface` object with `probedAt`, `available`, `flags` (the discovered list), `helpHash`, `extraVsContract`, `missingFromBinary`.
6. New unit tests for `extractDiscoveredFlags` exist in `src/__tests__/upstream-contracts.test.ts` (synthetic clap-style, noisy URL/prose, and realistic grok-style TUI help excerpts) and the full upstream test suite still passes (12 tests in the targeted run, including the 3 new ones).
7. Documentation updates:
   - `docs/upstream/README.md` now contains a "Detection channels" section explaining the dual (web page hash + installed help surface) model, updated command examples including the recommended `--probe-installed` invocation for vendor CLIs, and a clarified statement that the default gate requires neither network nor installed CLIs.
   - `.agents/skills/provider-grok/SKILL.md` now explicitly recommends `--probe-installed` for Grok because the tracked web page is high-level.
8. All 7 documented invariants (TS as sole mechanical source of truth, gate remains offline/no-binaries, live scan advisory-only, TOML scanner-input-only with strict sync test, snapshots/reports as generated artifacts only, skills point only to TS, upstreamMetadata remains descriptive pointers only) are preserved in the actual source (no new mechanical rules were added to metadata or the mjs scanner logic).

**Evidence that the implementation produced working detection** (must be re-verified by reading the artifacts):
- `npm run upstream:contracts` emitted "contracts-check OK: 5 providers...".
- Targeted test run: "12 tests" (upstream-contracts.test.ts) with the new extractor tests passing.
- Live run `node scripts/upstream-scan.mjs --live --provider grok --probe-installed` produced:
  - `[probe] EXTRA FLAGS in installed binary: --agent, --agents, --best-of-n, ... (+16 more)`
  - 1 critical finding of category `installed-help-surface-drift`.
- The written snapshot (`docs/upstream/snapshots/grok.json`) contains a `helpSurface` with 39 flags and 22 `extraVsContract`.
- The written report (`docs/upstream/reports/2026-05-31-grok.md`) contains the critical finding with the exact actionable text directing maintainers to the TS file.

---

## 3. Exact Changed-File List & How to Obtain the Minimal Diff

See the 5 files listed at the top of this report.

The orchestrator used the narrow `git diff HEAD -- <those 5 files>` command (never the full dirty tree that includes unrelated test changes, site/ artifacts, installer changes, etc.).

---

## 4. Evidence of Execution (as of 2026-05-31)

(Excerpts with paths; reviewers must re-read the live files/artifacts themselves.)

- Contracts gate: `npm run upstream:contracts` → "[upstream-scan] contracts-check OK: 5 providers, fixtures + report + TOML-sync verified (offline)."
- Test run (after adding the 3 extractor tests): 12 tests passed in `src/__tests__/upstream-contracts.test.ts`.
- Live + probe demonstration (see the generated report and snapshot for the exact 22-extra-flags critical finding and the `helpSurface` object with 39 flags / 22 extras / helpHash).
- All changes are additive or narrow extensions inside the existing advisory probe/scanner paths; no changes were made to `validateUpstreamCliArgs`, `UPSTREAM_CLI_CONTRACTS` mechanical data, the contracts-check path, or the TOML sync test.

---

## 5. Mandatory Instructions to Every Reviewer LLM (read this section last before emitting your verdict)

You have been given:
- The paths to the 5 actual source files.
- The paths to the 2 verification artifacts (`docs/upstream/snapshots/grok.json` and the report).
- This Verification Report (the corrective-program spec).
- A minimal unified diff of *only* those 5 files (or the command to generate it).

**You MUST NOT accept any summary, plan, or claim from the orchestrator (or from previous rounds) as evidence.**

Using the MCP tools you have been granted access to in this request (sqry for semantic/AST code search, Read, Grep, Glob, and any Bash/git commands needed):
1. Read this entire Verification Report file.
2. For **every numbered claim** in sections 1–4, locate the corresponding code, test, doc text, or artifact content at the listed path and quote the exact lines (with surrounding context) that confirm or refute it.
3. If any claim does not match the actual inspected source, describe the discrepancy with precise `file:line` + verbatim quote.
4. Pay special attention to the bidirectional logic (extraFlags / discoveredFlags), the placement of the probe call (must be only in the live + flag block, after the offline gate early return), the new unit tests, the snapshot augmentation being additive, and the docs changes.
5. Confirm that the 7 invariants listed in the background section of the implementation plan remain visible in the actual source (no mechanical contract rules leaked into metadata or the mjs).

End your response with **exactly one** of the following (no other closing language):

**UNCONDITIONAL APPROVED**  
(I personally inspected <list the specific files + line ranges or artifact paths I read with my tools> and confirm every claim in the Verification Report is accurate with no concrete blockers.)

or

**NOT APPROVED:**  
<one or more concrete findings, each with file:line + verbatim source quote + why it violates the spec in this report>

You have full tool access and the mcp_managed permission grant for this invocation. Use your tools aggressively to verify.

---

**End of Verification Report — this is the single source of truth for the review.**

---

## Final Review Outcome (Post Round 2)

**Date of conclusion**: 2026-05-31

### Process Summary
- **Round 1**: All five LLMs (Claude, Codex, Gemini, Grok, Mistral) were dispatched in parallel with fresh `mcp_managed` approval grants + full MCP tool access (`sqry` primary). Strict instructions required direct tool-based inspection (Read/sqry/Grep/Bash/eslint) of the actual source and artifacts. No summaries were to be accepted.
- **Blocker identified**: Claude surfaced the only concrete issue — a new hard `prefer-const` ESLint error at `src/upstream-contracts.ts:1110` inside the newly added `extractDiscoveredFlags` function (`let name` that is never reassigned). This caused `npx eslint` (part of the documented `npm run lint` / `npm run check` gate) to fail.
- **Fix applied**: One-character change (`let name` → `const name` at line 1110).
- **Fix verification** (immediate, before Round 2):
  - `npx eslint src/upstream-contracts.ts --rule 'prefer-const: error'` → No violations on or near line 1110.
  - `npm run upstream:contracts` → Still clean ("contracts-check OK").
  - Relevant test file → 12/12 passed.
- **Round 2**: Fresh `mcp_managed` grants + full tool access re-issued to all five LLMs. Prompts narrowly scoped to the one-line delta + surrounding function + the Round 2 Evidence Addendum. Reviewers were explicitly required to re-inspect the fix with their tools and re-issue verdicts.

### Round 2 Verdicts (after direct re-inspection of the fix)
- **Claude** (the reviewer who raised the blocker): **UNCONDITIONAL APPROVED**  
  Quote: "I re-inspected the exact location and re-ran the checks independently. ... `const name` now correct. ... `npx eslint ... --rule 'prefer-const: error'` → **NO prefer-const violations**. ... The one concrete blocker I raised in Round 1 is resolved, and nothing new was introduced. ... **UNCONDITIONAL APPROVED** (I re-inspected the exact one-line fix at src/upstream-contracts.ts:1110 with my tools + confirmed lint now passes on the file; all prior claims remain accurate.)"
- **Grok**: **UNCONDITIONAL APPROVED** (re-ran eslint clean + tests; confirmed no side effects and all claims hold).
- **Mistral**: **UNCONDITIONAL APPROVED**.
- **Gemini**: **UNCONDITIONAL APPROVED**.
- **Codex**: **UNCONDITIONAL APPROVED** ("fix verified").

**Result**: Unanimous **UNCONDITIONAL APPROVED** from all five LLMs with no remaining concrete blockers. The review followed the strict protocol (fresh permissions every round, 90-second polling, tool-enforced evidence only, no acceptance of summaries or "should be fixed" language).

### Scope Note
Only the five core files listed above plus this Verification Report itself were considered in scope for the minimal clean diff. All other uncommitted changes in the working tree (unrelated tests, site generation, installer work, etc.) were deliberately excluded from the review and this commit.

The detector now correctly surfaces Grok CLI (and other vendor CLI) help surface drift via the installed binary, even when the tracked web changelog is high-level or sparse. The one-line lint regression introduced by the original implementation was caught and resolved through this process.

**End of Final Outcome section.**