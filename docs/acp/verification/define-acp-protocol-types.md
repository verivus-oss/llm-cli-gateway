# Verification report: `define-acp-protocol-types`

- **Step id**: `define-acp-protocol-types`
- **DAG**: `docs/plans/first-class-acp-gateway-extension.dag.toml` (steps block lines 581-606)
- **depends_on**: `build-json-rpc-stdio-transport`
- **Implementation commit under test**: `be98e60` (`feat(acp): add Zod-backed ACP protocol type schemas`), branch `feat/acp-phase-b`
- **Files in scope**: `src/acp/types.ts` (implementation), `src/__tests__/acp-types.test.ts` (tests), `src/acp/errors.ts` (redaction surface relied on by the redaction test)
- **Verdict**: PASS — every validation row and the relevant `test_matrix.unit.schemas` rows are satisfied by cited code + test; mutation-probe audit found zero vacuous tests.

This is an independent verification. No claim in the implementer's commit message was trusted; every assertion below is backed by a `file:line` citation, a named test, and a command-output digest I produced.

---

## 1. Validation clause

> Schema tests cover valid Mistral and Grok smoke responses captured from local
> validation, missing required fields, provider-specific extra fields, and
> unknown notification variants.

| Validation sub-claim | Code (file:line) | Proving test (name) | Result |
|---|---|---|---|
| Valid Mistral smoke response parses, nested `agentInfo` preserved | `src/acp/types.ts:153-167` (`InitializeResponseSchema`, `agentInfo` passthrough at :162) | `acp types — initialize > parses the captured Mistral initialize response and keeps nested agentInfo` (`acp-types.test.ts:77`) | PASS |
| Valid Grok smoke response parses, provider-specific extras tolerated | `src/acp/types.ts:153-167` (`.passthrough()` at :167) | `acp types — initialize > parses the captured Grok initialize response and tolerates provider-specific extra fields` (`acp-types.test.ts:84`) | PASS |
| Missing required field rejected | `src/acp/types.ts:155` (`protocolVersion: ProtocolVersionSchema`, no `.optional()`) | `acp types — initialize > rejects an initialize response missing the required protocolVersion` (`acp-types.test.ts:96`) | PASS |
| Wrong-typed required field rejected | `src/acp/types.ts:56` (`z.number().int()`) | `acp types — initialize > rejects an initialize response with a non-numeric protocolVersion` (`acp-types.test.ts:102`) | PASS |
| Provider-specific extra fields survive (general) | `.passthrough()` on every response object, e.g. `:167`, `:198`, `:259` | `acp-types.test.ts:84`, `:126`, `:159` | PASS |
| Unknown notification variant preserved, not thrown | `src/acp/types.ts:365-380` (`SessionUpdateSchema.superRefine`, `if (!known) return` at :370-372) | `acp types — session/update notification variants > preserves an unknown forward-compatible session/update variant instead of throwing` (`acp-types.test.ts:240`) | PASS |

Captured smoke fixtures live in the test at `acp-types.test.ts:48-66` (Mistral nested `agentInfo.{name,version}` = `@mistralai/mistral-vibe` 2.14.1; Grok flat `agentVersion` 0.2.50 + `mcpCapabilities` bag), reproducing the documented provider divergence.

---

## 2. `test_matrix.unit.schemas` rows (lines 333-340)

These are the rows that belong to THIS step. Each is covered:

| Matrix row | Proving tests (file:line) | Result |
|---|---|---|
| initialize request and response | request: `acp-types.test.ts:69`; response valid (Mistral/Grok): `:77`, `:84`; reject: `:96`, `:102`; client-cap default-safe: `:108` | PASS |
| session/new request and response | request + mcpServers default: `:116`; empty cwd reject: `:122`; responses: `:126`; missing/empty sessionId reject: `:136`, `:140` | PASS |
| session/load request and response | request: `:146`; missing sessionId reject: `:155`; response extras: `:159` | PASS |
| session/prompt request and response | request: `:166`; unknown content-block tolerance: `:174`; empty prompt reject: `:182`; missing-type reject: `:186`; response stopReason: `:192`; missing stopReason reject: `:197` | PASS |
| session/update notification variants used by target providers | `agent_message_chunk`: `:203`; `tool_call`: `:215`; `usage_update`: `:232`; unknown variant preserved: `:240`; known-not-unknown: `:254`; missing sessionId reject: `:260`; missing discriminator reject: `:269`; missing content reject: `:275` | PASS |
| permission callback request and response | valid request: `:286`; no-options reject: `:302`; missing toolCall reject: `:311`; selected/cancelled responses: `:320`, `:327`; selected-missing-optionId reject: `:332`; unknown outcome reject: `:338` | PASS |

Minimal HostServices file-request **schemas** (`fs/read_text_file`, `fs/write_text_file`) are also defined here (`types.ts:462-498`) and exercised at `acp-types.test.ts:345-372`. The step action (DAG :596) only asks for "minimal HostServices requests" as schema definitions, and that is what types.ts provides.

### Scope note — rows NOT owned by this step

`test_matrix.unit.host_services` (lines 341-347: "denies filesystem writes by default", "denies terminal by default", "resolves read paths under workspace root", "rejects path traversal", "routes permission decisions through ApprovalManager") and `test_matrix.unit.session_map` (lines 348-353) describe **enforcement / behaviour** that requires a HostServices module and a session-map module. Those modules do not exist at commit `be98e60` (`src/acp/` contains only `errors.ts`, `json-rpc-stdio.ts`, `provider-registry.ts`, `types.ts`). `types.ts` defines the request *shapes* but contains no allow/deny logic, no workspace-root resolution, and no ApprovalManager routing. Those matrix rows belong to later DAG steps (the client / process-manager / host-services steps) and are therefore out of scope for `define-acp-protocol-types`. The prompt's suggested mutations ("make HostServices allow writes by default", "let a raw JSON-RPC body reach the flight recorder", "drop a fail-closed branch") target those later steps; the closest in-scope analogue available here — and the one actually exercised — is the redaction-discipline path (mutation M4), audited below.

---

## 3. Security invariant: no stdout / no raw payloads

- `grep -nE 'console\.(log|info|warn|error)|process\.stdout' src/acp/types.ts` → only the doc-comment reference on line 36; **no executable stdout write**. Digest: single match, line 36 (a comment).
- Parse failures throw `AcpProtocolError` with debug limited to method + Zod issue **paths** (not values): `src/acp/types.ts:521-530`. `parseAcp` builds `issuePaths` from `issue.path` / `issue.code` only (`:521-524`) and never attaches the raw `value`. Proven by `acp types — redaction discipline on parse failure > does not embed the rejected payload` (`acp-types.test.ts:375`).

---

## 4. Release-gate commands (digests)

| Command | Output digest |
|---|---|
| `node -e "...smol-toml...parse(dag.toml)"` (release_gates.local_commands[0]) | `TOML_PARSE_OK` (exit 0) |
| `npx vitest run src/__tests__/acp-types.test.ts` | `Test Files 1 passed (1)` / `Tests 40 passed (40)` |
| `npx tsc -p tsconfig.build.json` (production build) | exit 0; artifact `dist/acp/types.js` present (9747 bytes) |
| `npx tsc --noEmit` filtered to `src/acp/` | zero errors in `src/acp/*` (pre-existing TS errors elsewhere in the test harness are unrelated to this step and do not touch `acp/types.ts` or `acp-types.test.ts`) |

The full per-test verbose digest (40 ✓, 0 ✗) was captured; all 40 tests map to the schema/permission/host-file paths listed above.

---

## 5. Mutation-probe audit (test-veracity)

Performed in a throwaway detached worktree (`git worktree add -d /tmp/acp-mutate-wt HEAD`, base `be98e60`), `node_modules` symlinked, baseline = 40/40 green. Each mutation targets a distinct key code path the new tests claim to cover; after each, only `src/acp/types.ts` was mutated and the suite re-run, then reverted. Worktree removed and pruned afterward (`git worktree list` confirms it is gone).

| # | Mutation (code path) | Expected guardian test | Observed |
|---|---|---|---|
| M1 | `InitializeResponseSchema.protocolVersion` → `.optional()` (drop required-field strictness) — `types.ts:155` | `rejects an initialize response missing the required protocolVersion` (`:96`) | **FAILED as expected** — 1 failed / 39 passed |
| M2 | `InitializeResponseSchema` closing `.passthrough()` → `.strip()` (drop provider-extra tolerance) — `types.ts:167` | `parses the captured Grok initialize response and tolerates provider-specific extra fields` (`:84`) | **FAILED as expected** — 1 failed / 39 passed |
| M3 | `SessionUpdateSchema` unknown-discriminator branch `if (!known) return` → `ctx.addIssue(...)` (drop forward-compat tolerance) — `types.ts:370-372` | `preserves an unknown forward-compatible session/update variant instead of throwing` (`:240`) | **FAILED as expected** — 1 failed / 39 passed |
| M4 | `parseAcp` debug → add `rawValue: value` (let the rejected raw payload reach the error/log sink) — `types.ts:526-529` | `does not embed the rejected payload (prompt text / values) in the thrown error` (`:375`) | **FAILED as expected** — `SUPER_SECRET_PROMPT_TEXT_DO_NOT_LEAK` appeared in `error.debug`; 1 failed / 39 passed. (Confirms `redactAcpDebug` only redacts sensitive-named keys; an un-sanitised raw payload leaks and the test catches it.) |
| M5 | `SessionIdSchema` `z.string().min(1)` → `z.string()` (allow empty session id) — `types.ts:59` | `rejects a session/new response with an empty sessionId` (`:140`) | **FAILED as expected** — 1 failed / 39 passed |
| M6 | `MessageChunkUpdate.content` → `.optional()` (drop known-variant required-field strictness) — `types.ts:284` | `rejects an agent_message_chunk notification missing required content` (`:275`) | **FAILED as expected** — 1 failed / 39 passed |

**vacuousTests: none.** Every mutation produced a failing guardian test. M4 is the in-scope analogue of the prompt's "let a raw JSON-RPC body reach the flight recorder" probe: it demonstrates the redaction discipline at the type-parser boundary is genuinely tested, not asserted vacuously.

Worktree teardown digest: `git worktree remove --force /tmp/acp-mutate-wt` + `git worktree prune` → `/tmp/acp-mutate-wt` no longer listed; no drift left in `src/acp/types.ts` (`git status --short` clean for the step files).

---

## 6. Conclusion

- All validation-clause sub-claims: backed by cited code + named passing test.
- All in-scope `test_matrix.unit.schemas` rows: covered.
- `host_services` / `session_map` matrix rows: correctly out of scope for this step (no enforcement module exists yet); flagged for the downstream steps that own them.
- Mutation probe: 6/6 mutations caught; zero vacuous tests.

**validationPassed = true.**
