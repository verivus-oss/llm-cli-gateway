# Verification report: `extend-provider-capability-metadata`

- Verifier role: independent (do-not-trust-implementer).
- Branch: `feat/acp-gateway-extension`
- HEAD at verification: `662bfdca989761e4a50e20222e7ca8e3cace74a2`
- DAG source: `docs/plans/first-class-acp-gateway-extension.dag.toml` lines 482-507
- Result: **FAIL — step is entirely unimplemented.**

## Step under test

`[[steps]]` id `extend-provider-capability-metadata`
(`docs/plans/first-class-acp-gateway-extension.dag.toml:483`).

Action (lines 486-501) requires extending `provider_tool_capabilities` with an
ACP section per provider carrying: `status`, native-vs-adapter classification,
`targetVersion`, `entrypoint`, `runtimeEnabled`, `smokeSupported`, `smokeStatus`,
`caveats`, and a docs reference; agy must stay explicit (Antigravity agy 1.0.7,
no ACP surface).

Validation clause (lines 503-507):

> provider_tool_capabilities tests assert all five CLI providers have ACP fields.
> Codex and Claude are adapter_mediated_deferred, agy is absent_watchlist,
> Mistral and Grok are native candidates, and no adapter is labeled native.

## Validation-clause verdict: FAIL

Every behavioral claim in the validation clause is unsupported by code or tests.
No ACP-capability implementation or assertion exists anywhere in the source tree.

### Claim 1 — "provider_tool_capabilities tests assert all five CLI providers have ACP fields"

NOT SATISFIED. No ACP field exists on the capability surface or in its tests.

- Implementation file `src/provider-tool-capabilities.ts` (read in full, 1441
  lines): the `ProviderToolCapabilities` interface (`src/provider-tool-capabilities.ts:88-111`)
  has no `acp` member; the per-provider definition table
  `TOOL_CONTROLS` (`src/provider-tool-capabilities.ts:194-761`) defines no ACP
  section for `claude`, `codex`, `gemini`, `grok`, or `mistral`; the builder
  `buildOneProviderToolCapabilities` (`src/provider-tool-capabilities.ts:800-847`)
  emits no `acp` property.
  Command digest: `grep -niE "acp|adapter_mediated|absent_watchlist" src/provider-tool-capabilities.ts`
  → exit 1, zero matches.
- Test file `src/__tests__/provider-tool-capabilities.test.ts`: 10 tests, none
  referencing ACP. Test names (`grep -nE "it\(" src/__tests__/provider-tool-capabilities.test.ts`):
  - "surfaces Grok Imagine skill tools from the local Grok skill directory" (:51)
  - "reports v2 schema and gateway tool-control differences for each provider" (:87)
  - "covers Claude, Codex, and Gemini request-schema capabilities" (:115)
  - "covers Grok CLI, Grok API, and Mistral request-schema capabilities" (:193)
  - "reports grok_api request tool only when xAI provider is enabled" (:289)
  - "honors query options for filtering, omissions, and raw path inclusion" (:306)
  - "caches capability discovery and refresh bypasses stale entries" (:331)
  - "parses folded, literal, and nested frontmatter without over-reporting noise" (:346)
  - "reports redacted config surfaces without secret-bearing values" (:404)
  - "exposes provider tool capability resources" (:448)
  Command digest: `grep -niE "acp|adapter_mediated|absent_watchlist|targetVersion|entrypoint|runtimeEnabled|smokeSupported|smokeStatus" src/__tests__/provider-tool-capabilities.test.ts`
  → exit 0, zero matches.
- Test run is GREEN but vacuously so with respect to this clause — it asserts the
  pre-ACP v2 surface only.
  Command: `npx vitest run src/__tests__/provider-tool-capabilities.test.ts`
  Digest: `Test Files 1 passed (1)` / `Tests 10 passed (10)`.

### Claim 2 — "Codex and Claude are adapter_mediated_deferred"

NOT SATISFIED. No `adapter_mediated_deferred` token exists in the repository.
Command digest: `grep -rln "adapter_mediated_deferred" . --include="*.ts"` → zero matches.

### Claim 3 — "agy is absent_watchlist"

NOT SATISFIED. No `absent_watchlist` token exists in the repository.
Command digest: `grep -rln "absent_watchlist" . --include="*.ts"` → zero matches.

### Claim 4 — "Mistral and Grok are native candidates"

NOT SATISFIED. No ACP native-candidate classification field exists for any
provider (see Claim 1 file citations).

### Claim 5 — "no adapter is labeled native"

VACUOUSLY UNVERIFIABLE. Because no ACP classification field exists, there is
nothing to inspect; the property is neither established nor tested. Treated as
NOT SATISFIED for gating purposes.

## test_matrix rows owned by this step: FAIL

The step's behavioral target appears in `[test_matrix.integration].resources`
(`docs/plans/first-class-acp-gateway-extension.dag.toml:375-379`):

- "provider-tools resources include ACP fields" — NOT IMPLEMENTED. No test of
  this name or intent exists. Command digest:
  `grep -rniE "include ACP|ACP field" src/__tests__/` → exit 1, zero matches.
  The existing resources test "exposes provider tool capability resources"
  (`src/__tests__/provider-tool-capabilities.test.ts:448`) asserts only the
  pre-ACP surface and contains no ACP assertions.
- "doctor reports ACP target versions and smoke status" — NOT IMPLEMENTED.
  Command digest: `grep -niE "acp" src/__tests__/doctor.test.ts` → exit 1,
  zero matches. (`src/doctor.ts` likewise carries no ACP capability reporting
  for this step.)

## Test reality check (no mutation probe required this phase)

Per instruction, no mutation probe was run; tests were confirmed real by reading
them. The 10 tests in `src/__tests__/provider-tool-capabilities.test.ts` are
genuine behavioral assertions against `getProviderToolCapabilities` /
`getOneProviderToolCapabilities` and the `provider_tool_capabilities` resource —
they exercise live code paths (skill discovery, v2 schema shape, request-schema
control coverage, xAI gating, query options, caching, frontmatter parsing,
path redaction, resource exposure). They are not vacuous in their own scope;
they simply do not cover ACP, which this step was supposed to add. No test in
the suite is a no-op or always-true, so `vacuousTests` is empty.

## Corrective program (what an implementer must add to pass)

1. Add an `acp` member to `ProviderToolCapabilities`
   (`src/provider-tool-capabilities.ts:88`) carrying the nine required fields:
   `status`, native-vs-adapter classification, `targetVersion`, `entrypoint`,
   `runtimeEnabled`, `smokeSupported`, `smokeStatus`, `caveats[]`, `docs`.
2. Populate per-provider ACP data in `TOOL_CONTROLS`
   (`src/provider-tool-capabilities.ts:194`) with the mandated classifications:
   `claude`/`codex` = `adapter_mediated_deferred`; `gemini` (agy 1.0.7) =
   `absent_watchlist` with explicit "no ACP surface" caveat; `mistral`/`grok` =
   native candidate; assert no adapter row is labeled `native`.
3. Emit the `acp` member from `buildOneProviderToolCapabilities`
   (`src/provider-tool-capabilities.ts:800`).
4. Add assertions in `src/__tests__/provider-tool-capabilities.test.ts` covering
   all five CLI providers' ACP fields and the four classification invariants.
5. Extend the resources test and doctor reporting per the matrix rows above.
