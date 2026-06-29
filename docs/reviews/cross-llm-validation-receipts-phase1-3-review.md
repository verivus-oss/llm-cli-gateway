# Cross-LLM Validation Receipts: Phases 1-3 implementation review gate

Branch: `feat/validation-receipts-phase1-3` (off `feat/validation-receipts-phase0`).
Final commit reviewed: `c72592c`. Spec: `docs/plans/cross-llm-validation-receipts.draft.md`
(§3 mint lifecycle, §4 tool, §6 canonical hash, §8 resource); plan/DAG: PR #113.

Adversarial cross-LLM gate: each reviewer ran with full access and local
filesystem + MCP tool access, given the `feat/validation-receipts-phase0...feat/validation-receipts-phase1-3`
diff, and instructed to verify every claim against the code (not a summary) and a
HARD GUARDRAIL: no package-manager installs, no tracked-file / node_modules /
lockfile mutation (after an earlier gate's reviewer `pnpm install` drifted the
toolchain). Polled at 90s.

## Outcome: UNCONDITIONAL APPROVAL from all three reviewers (commit c72592c)

- Codex (gpt-5.4): `UNCONDITIONAL APPROVAL` at round 2 (`clvr-p13-codex-r2`).
- Gemini (gemini-3-pro-preview): `UNCONDITIONAL APPROVAL` at round 2
  (`clvr-p13-gemini-r2`); independently ran the suite (1775 tests pass). Approved
  round 1 as well.
- Grok (grok-build): `UNCONDITIONAL APPROVAL` at round 2 (`clvr-p13-grok-r2`).

## Round 1 findings and resolutions (commit c72592c)

Gemini approved at round 1. Codex and Grok raised findings, all addressed:

1. (Grok, correctness) The judge `synthesis.status` was hard-coded to `completed`
   for any terminal judge job. Fixed: a non-completed terminal judge
   (failed/canceled/orphaned) now yields `synthesis.status = "skipped"` with the
   actual outcome in the note; only a genuinely completed judge is `completed`
   (`src/validation-receipt.ts` `tryMint`).
2. (Grok, divergence) `validation_runs.status` was declared mutable
   `running | finalized` but no path finalized it. Fixed: `tryMint` calls
   `setValidationRunStatus(validationId, "finalized")` on mint (idempotent), so a
   minted run is no longer left `running`.
3. (Codex + Grok, coverage) The `validation_receipt` TOOL handler's registration
   gate and `format="markdown"` branch, and the skipped-provider reconstruction
   inside the mint, were not exercised end-to-end. Fixed: added a
   "validation_receipt tool" describe driving the real registered handler via
   `createGatewayServer` (registration sqlite-vs-memory, markdown, json,
   own-or-not-found) plus skipped-reconstruction and finalized-status tests.

All findings were correctness/coverage issues on secondary branches; the core
hash, terminal detection, eager + on-read mint, own-or-not-found scoping, durable
gate, and `node:sqlite` confinement were confirmed correct throughout.

## Verification

`npm run check` green on `c72592c`: build clean, lint 0 errors (pre-existing
warnings only), format clean (pinned prettier 3.8.4), test 111 files / 1775 tests
pass, release security audit passed (all SQLite access via `src/sqlite-driver.ts`).

## Environment note

A full-access reviewer in an earlier gate ran `pnpm install`, which created stray
`pnpm-lock.yaml` / `pnpm-workspace.yaml` (this repo uses npm) and drifted
node_modules above the lockfile pins (prettier 3.8.4 -> 3.9.1). Those files were
removed and gitignored, and the pinned prettier was restored (commit `de208ec`).
This gate added a no-install / no-mutation guardrail to the reviewer prompts.
