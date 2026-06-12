# Verification report — Issue #1 structuredContent mirror + contract-driven grok provider codegen

Date: 2026-06-10. Base commit: `e11b5cf` (master). Working tree, uncommitted.

This report is the corrective-program spec for the cross-LLM review gate. Every
claim below is independently verifiable against the working tree (code, tests,
docs) and the saved diff. **Reviewers must verify each claim against the actual
code/tests, not against this summary.** The saved tracked-file diff is
`docs/reviews/2026-06-10-issue1-provider-codegen.tracked.diff`; new files are
listed in §0 and must be read directly.

## 0. Review scope (files changed THIS work; verify with `git status`)

In scope (produced by this work):
- `src/index.ts` — Issue #1 mirror (3 sites) + grok argv cutover + grok schema cutover + `GROK_GENERATED_SHAPE`.
- `src/provider-codegen.ts` (NEW) — generators + grok generation table.
- `src/__tests__/grok-sync-content-wire.test.ts` (NEW) — Issue #1 wire-level test.
- `src/__tests__/provider-codegen-grok-parity.test.ts` (NEW) — argv/schema parity.
- `src/__tests__/grok-argv-golden.test.ts` (NEW) + snapshot — argv byte-parity baseline.
- `src/__tests__/grok-schema-golden.test.ts` (NEW) + snapshot — schema fidelity baseline.

Explicitly OUT of scope (pre-existing uncommitted work, not produced here; do NOT
review as part of this gate): `src/async-job-manager.ts` (Issue #21 stall
telemetry), `src/upstream-contracts.ts` grok-0.2.38 contract sync,
`src/__tests__/async-stall-telemetry.test.ts`, `src/__tests__/grok-sync-content.test.ts`
(the pre-existing Issue #1 localisation test), `CHANGELOG.md`,
`docs/launch/blog-2-4-feature-update.md`, `docs/acp-scope.md`,
`docs/agent-assurance-runtime-conformance.md`.

## 1. Issue #1 — reply mirrored into structuredContent

CLAIM 1.1: `grok_request` (and the other `*_request` tools) register with NO MCP
`outputSchema`. Verify: `src/index.ts` `server.tool("grok_request", desc, shape,
annotations, cb)` is the 5-arg form (no outputSchema). MCP SDK
`node_modules/@modelcontextprotocol/sdk/dist/cjs/server/mcp.js` `validateToolOutput`
is a no-op when `!tool.outputSchema` (returns at the `if (!tool.outputSchema)` guard).

CLAIM 1.2: The reply text is mirrored into `structuredContent.response` in all
three response builders:
- `buildCliResponse` → `response: finalStdout` (`src/index.ts:3307`).
- `buildGrokApiToolResponse` → `response: text` (`src/index.ts:3521`).
- `createErrorResponse` → `response: errorMessage` (`src/index.ts:1309`).
`content[0].text` is unchanged at each site (still `finalStdout` / `text` /
`errorMessage`).

CLAIM 1.3: A real MCP `Client` ↔ `McpServer` round-trip over `InMemoryTransport`
returns the reply in BOTH `content[0].text` AND `structuredContent.response`.
Verify by running `grok-sync-content-wire.test.ts` (drives `client.callTool`,
which parses via the SDK `CallToolResultSchema`). It also asserts
`tools/list` reports `grok_request` with `outputSchema === undefined`.

## 2. Grok argv cutover (contract-driven)

CLAIM 2.1: `prepareGrokRequest`'s flag-argv block emits the 30 covered flags via
`buildArgvFromGeneration` over run-segments (`src/index.ts:2994,3000,3027,3042,3043`),
interleaved with the 5 hand-written special flags (`--model`, permission,
`--agents`, `--prompt-json`, `--worktree`) at their original positions.

CLAIM 2.2: The cutover is BYTE-IDENTICAL to the prior hand-written argv. Verify:
`grok-argv-golden.test.ts` snapshots `prepareGrokRequest(...).args` for requests
that interleave covered + every special flag; the snapshot
(`__snapshots__/grok-argv-golden.test.ts.snap`) was captured against the
hand-written block and still matches. Falsifiability: changing a hand-written
conditional (e.g. `--allow` repeat) changes the snapshot.

CLAIM 2.3: `buildArgvFromGeneration(grokContract, GROK_FLAG_GENERATION, params)`
reproduces `prepareGrokRequest`'s covered-flag output for a param matrix. Verify:
`provider-codegen-grok-parity.test.ts` compares the generator against the real
`prepareGrokRequest` output (covered tail). 9 ungenerated flags are documented in
`UNGENERATED_GROK_FLAGS` (`src/provider-codegen.ts`).

## 3. Grok schema cutover (lossless)

CLAIM 3.1: `grok_request` registers its 30 covered fields via
`...GROK_GENERATED_SHAPE` (`src/index.ts:6779`), where `GROK_GENERATED_SHAPE =
deriveZodShapeFromGeneration(UPSTREAM_CLI_CONTRACTS.grok, GROK_FLAG_GENERATION)`
(`src/index.ts:517`). The 30 hand-written field definitions were removed.

CLAIM 3.2: The derived schema is LOSSLESS vs the prior hand-written schema:
identical `.describe()` text, `.min(1)` on the 8 string fields, and
`MAX_TURNS_SCHEMA` bounds (`int/positive/safe/max 10000`) on `maxTurns`/`bestOfN`.
Verify: `grok-schema-golden.test.ts` — the describe snapshot was captured from the
hand-written schema and still matches post-cutover; validation assertions
(min(1) rejects empty, enums reject out-of-enum, numeric bounds) hold; one test
asserts the derived shape equals the registered schema field-for-field.
Falsifiability: mutating a `describe` fails the snapshot; dropping a `minLength`
fails the min(1) test (both demonstrated, then reverted).

CLAIM 3.3: `src/provider-codegen.ts` imports `z` from `"zod/v3"` to match
`src/index.ts`; mixing zod v4 fields into the tool shape throws "Mixed Zod
versions detected in object shape" at registration (this was hit and fixed).

CLAIM 3.4: Enum values for derived fields come from `contract.flags[*].values`
(single source), and `EFFORT_LEVELS` in `upstream-contracts.ts` equals the prior
hand-written effort enum `["low","medium","high","xhigh","max"]`.

## 4. Build / test / lint evidence (reproduce these)

- `npm run build` → clean (tsc, no errors).
- `npm test` → 1184 passed, 76 files (run it).
- `npx eslint src/provider-codegen.ts` → 0 errors.
- `npx eslint src/index.ts` → exactly 5 errors, ALL pre-existing (lines ~728,
  4005/4124 `effectiveSessionId` prefer-const, 5253 no-useless-catch, 6273
  no-useless-assignment) — none introduced by this work. Verify by checking each
  flagged line is unrelated to the mirror/cutover edits.

## 5. Known limitations / non-claims

- This work does NOT remove the grok callback destructure/forward boilerplate
  (still hand-written); only the schema field DEFINITIONS and argv are generated.
- The generation metadata lives in a co-located table in `provider-codegen.ts`,
  not yet folded into `CliFlagContract` — by design, to keep contract
  validation/drift/serialisation paths untouched this slice.
- Only the grok provider is cut over; claude/codex/gemini/mistral are unchanged.
- `GROK_GENERATED_SHAPE` is cast `as unknown as Record<GrokGeneratedField, ...>`
  (`src/index.ts:517`) so the spread keeps typed keys for the callback; runtime
  values are the contract-derived shape (CLAIM 3.2 proves equivalence).
