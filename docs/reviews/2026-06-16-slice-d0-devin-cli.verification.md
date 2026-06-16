# Slice D0 — Devin CLI provider — verification report

**Date:** 2026-06-16
**Base:** master @ `0e161d1`
**Branch:** `feat/devin-cli-provider-slice-d0`
**Tracked diff:** `docs/reviews/2026-06-16-slice-d0-devin-cli.tracked.diff`

## Scope
Adds **Devin** (Cognition's `devin` CLI) as a sixth first-class `CliType`
provider alongside claude/codex/gemini/grok/mistral. New MCP tools
`devin_request` (sync, auto-defers) and `devin_request_async` (durable job)
spawn `devin -p <prompt>` in headless print mode with optional `--model`,
`--permission-mode {normal,dangerous,bypass}`, `--prompt-file`, and session
resume via `--resume <id>` / `--continue` (reusing the Grok session-arg helper).
Slice **D1** (native `devin acp` ACP runtime pilot) is out of scope: devin's ACP
status is `native_candidate` with `shipRuntimePilot:false`, `smokeStatus:not_run`.

## Closed-enum widening (compiler-enforced completeness)
`type CliType` derives from `CLI_TYPES` (session-manager.ts). Because the
touchpoints below are `Record<CliType, X>` (or a `switch` over CliType), a
passing `tsc` build is itself proof that every one carries a devin arm — TS
rejects a missing key. Widened:
CLI_TYPES; doctor's own local CliType; async-job-manager `LlmCli`;
provider-status (VERSION_ARGS, PROVIDER_COMMANDS, LOGIN_CHECKS, PROVIDERS);
provider-login-guidance (GUIDANCE); cli-updater (VERSION_ARGS, buildCliUpgradePlan,
getCliVersions); model-registry (FALLBACK_INFO, getAvailableCliInfo, buildCliInfo);
upstream-contracts (ACP_ENTRYPOINT_CONTRACTS, UPSTREAM_CLI_CONTRACTS);
acp/provider-registry (AcpProviderStatus union + ACP_PROVIDER_REGISTRY);
provider-tool-capabilities (ACP_CONTRACT.providers, ACP_CAPABILITIES,
TOOL_CONTROLS, `skillRoots` switch, `discoverConfigSurfaces` switch — explicit
`case "devin"` no-op added per Mistral review); config RESERVED_CLI_PROVIDER_NAMES.

## Results
- `npm run build` (tsc strict) — **clean**.
- `npm test` — **1588 passed / 99 files** (was 1577; +11 new `devin-handler.test.ts`).
- `npm run lint` — **0 errors**, 142 warnings (all pre-existing ACP schema
  naming-convention warnings; none in devin code).
- `npm run format` — clean (no devin files reformatted).

## Mutation probe (cp backup/restore on src/index.ts, not git)
The new `devin-handler.test.ts` was proven to catch regressions in
`prepareDevinRequest`:
| Mutation | Result |
|---|---|
| `["-p", prompt]` → `["-q", prompt]` | 3 tests fail |
| drop the empty-prompt guard | 2 tests fail |
| disable the `--model` push (`if (false && resolvedModel)`) | 1 test fails |
All three caught; source restored from backup after each.

## Safety notes confirmed against code
- **Argv builder is pure**, array-based — no shell strings, no `shell:true`.
  Empty/missing prompt returns `createErrorResponse`, never argv.
- **Allowlist enforced on both paths.** `handleDevinRequestAsync` calls
  `assertUpstreamCliArgs`/`assertUpstreamCliEnv` before `startJob`; the sync
  `handleDevinRequest` routes through `awaitJobOrDefer`, which calls the same
  asserts internally (src/index.ts:780-781) — identical to the grok sync
  handler's reliance. Unknown flags and invalid `--permission-mode` values are
  rejected by `validateUpstreamCliArgs` (negative fixtures `devin-unsupported-flag`,
  `devin-permission-mode-invalid`).
- **ACP metadata is inert.** Adding devin to the ACP registry/capabilities does
  not auto-spawn `devin acp`: `getRuntimePilotProviders()` filters
  `shipRuntimePilot===true` (excludes devin), `runtimeEnabledDefault:false`, and
  the entrypoint probe uses only `devin --version`.
- **Secret/path hygiene.** Login guidance and ACP caveats carry no home paths and
  no literal key material; they warn against pasting `cog_*` tokens.
