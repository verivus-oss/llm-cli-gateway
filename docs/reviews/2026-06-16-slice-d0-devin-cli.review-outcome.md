# Slice D0 — Devin CLI provider — cross-LLM review outcome

**Date:** 2026-06-16
**Base:** master @ `0e161d1` · **Branch:** `feat/devin-cli-provider-slice-d0`
**Artifacts:** `2026-06-16-slice-d0-devin-cli.tracked.diff`,
`2026-06-16-slice-d0-devin-cli.verification.md`

Three independent reviewers via the multi-LLM gateway, each instructed to verify
against the code (not the summary) and to approve only on inspected evidence.
Gemini/Antigravity was skipped (refuses audit-framed tasks).

## Verdicts — unanimous APPROVE

### Codex (gpt-5.5, read-only sandbox)
APPROVE. Confirmed: ACP metadata is inert (`runtimeEnabledDefault:false`,
`shipRuntimePilot:false`, `getRuntimePilotProviders()` filters
`shipRuntimePilot===true`; probe uses `devin --version`, not bare `devin acp`);
argv is array-built (no shell injection); async path calls
`assertUpstreamCliArgs` before `startJob`; allowlist rejects unknown flags and
invalid `--permission-mode` values; no secret/path leakage.
- Raised one question (could not see `awaitJobOrDefer`'s body from the inlined
  excerpt): does the **sync** path validate argv? **Resolved with code
  evidence:** `awaitJobOrDefer` itself calls `assertUpstreamCliArgs(cli,args)` +
  `assertUpstreamCliEnv(cli,env)` (src/index.ts:780-781) before spawning —
  identical to how the grok sync handler relies on it. No change needed.

### Grok (grok-build)
APPROVE. Independently read the working tree, ran build + lint + the devin /
contract / surface / ACP / session / capabilities tests, and grep-traced every
`CliType`/`CLI_TYPES`/`LlmCli` Record/switch/case across `src/`. Cited file:line
for each claim. Explicitly verified the ACP registry widening does **not** enable
runtime spawn, the allowlist enforcement on both sync and async paths, the
self-update plan in cli-updater, and the secret-free login guidance. "No switch
without devin arm that throws or takes an invalid branch on the implemented
surface."

### Mistral (default)
Initially returned **BLOCKER**: `discoverConfigSurfaces`
(src/provider-tool-capabilities.ts:1443) switch had no `devin` case — devin fell
through to `return surfaces` (an empty list). Mistral conceded the empty result
is *correct* (devin owns its own config; the gateway discovers none) but flagged
the silent fall-through.
- **Adjudication:** not a correctness bug — the switch is intentionally
  non-exhaustive (`grok_api` is also absent, returning early at line 1420) and is
  not `never`-checked, so `tsc` does not require the case; Grok inspected the
  same surface and approved. **Fixed anyway** for clarity: added an explicit
  `case "devin": break;` with a comment, mirroring the existing explicit
  `skillRoots` devin case. Behaviour unchanged (still `[]`); 1588 tests still
  pass, build + lint clean.
- **Re-review:** Mistral **APPROVE** — "blocker is resolved … converting a
  silent fall-through into an explicit no-op."

## Disposition
Gate passed (3/3 unconditional APPROVE). One reviewer finding folded in
(explicit `discoverConfigSurfaces` devin case). Proceed to PR.
