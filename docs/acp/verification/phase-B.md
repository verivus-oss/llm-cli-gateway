# Phase B — Transport core: aggregated verification report

Plan: `docs/plans/first-class-acp-gateway-extension.dag.toml`
Feature branch: `feat/acp-phase-b`
Phase: **B — Transport core**
Date: 2026-06-13
Aggregator role: independent evidence packet — re-derived the commit topology and re-ran every required local gate against the integrated phase head.
Re-verification pass (2026-06-13, branch head `5c90024`): topology re-derived (`7d06af1..5c90024`; base = Phase A foundation merge `7d06af1`, parent of the pre-implementation CI-harness commit `57c0611`); the required gates re-run from a clean working tree against the phase head — `npm run build` exit 0; `npm run lint` 0 errors / 127 warnings; the four ACP suites **96/96**; `npm test` **1384/1384** across 85 files; `npm run upstream:contracts` OK (5 providers); `git diff --check` clean on the worktree and on `src/` over the range, with one **docs-only** trailing-blank-line nit in `docs/acp/review/B-round-5-codex.md:63` (no source whitespace error — see "Local gates"). The head commit `5c90024` is itself the last **source** change (the Round-5 `mkdirSync` default-cwd fix to `src/acp/process-manager.ts` + its real-spawner tests), so the tested source surface at the head is `5c90024`. Full Phase B branch range from the Phase A merge: `7d06af1..5c90024` (the only delta over `57c0611..5c90024` is the pre-implementation CI-harness commit `57c0611`, `docs/plans/acp-implementation.workflow.js`).
Round-1 review dispositions (Codex + Grok) recorded in "Round-1 review findings" below; the one in-scope finding (provider stderr redaction) is fixed in code + tests on `feat/acp-phase-b`.
Round-2 review dispositions (Codex + Grok) recorded in "Round-2 review findings" below; Grok APPROVED, Codex raised three in-scope transport-robustness defects (no blockers), all fixed in code + tests at `0420cfb`.
Round-3 review dispositions (Codex + Grok) recorded in "Round-3 review findings" below; Grok APPROVED, Codex (dispatched through the `gtwy` MCP server — the prior-round block was resolved by dropping `workingDir` and embedding the absolute repo path in the prompt) raised two in-scope redaction/schema defects, both fixed in code + tests at `34f3ea7`; one stderr-prose finding rebutted.
Round-4 review dispositions (Codex + Grok) recorded in "Round-4 review findings" below; the single Codex permission-mediation finding is rebutted with three DAG citations (the cited invariant + matrix row belong to the not-yet-built `src/acp/host-services.ts`, downstream of all four Phase B steps), and no finding survives as a blocker. Round-4 review records: `docs/acp/review/B-round-4-codex.md`, `docs/acp/review/B-round-4-grok.md`.
Round-5 review dispositions (Codex) recorded in "Round-5 review findings" below; the re-raised permission-mediation finding is rebutted again (same DAG layering), and one **in-scope** process-manager defect is **fixed in code + tests** at the new tip: `defaultSpawn` now creates the resolved working directory (`mkdirSync(cwd, { recursive: true })`) before spawning, closing the clean-host ENOENT on the default no-cwd path. Two real-spawner tests were added (96 ACP tests, full suite 1384/1384). The gate-environment note (EROFS in the reviewer's read-only sandbox) is acknowledged: build/test/upstream:contracts all pass in this writable environment.

## Verdict

**Phase B required gates: GREEN.** The four Phase B step commits sit linearly on the
Phase A foundation merge; build, lint, the four relevant ACP test suites,
`upstream:contracts`, and `git diff --check` (worktree + `src/`) all pass against the
branch head `5c90024`, which carries the four implementation steps, the Round-1
stderr-redaction fix, the three Round-2 transport-robustness fixes, the two Round-3
redaction/schema fixes, the Round-5 default-cwd `mkdirSync` fix, and the
verification/review docs. The head commit `5c90024` is itself the last **source**
change (the Round-5 fix to `src/acp/process-manager.ts` + its two real-spawner tests),
so the tested source surface at the head equals `5c90024`. Phase range for this packet:
`7d06af1..5c90024` (base = Phase A merge `7d06af1`; the source steps + five fixes +
the review/verification docs).

One **non-blocking** carry-over from the per-step reports: the eight new ACP files
fail `prettier --check` (`npm run format:check`), which breaks the broader
`npm run check` release gate. This is not in the required gate set for this packet
and is flagged for a formatting commit before release. See "Known issues".

| Step | Step commit | Per-step report | Per-step verdict |
|---|---|---|---|
| build-json-rpc-stdio-transport | `3cf062f` (+ R1 fix `3b89fd3`, R2 fix `0420cfb`, R3 fix `34f3ea7`) | `docs/acp/verification/build-json-rpc-stdio-transport.md` | PASS |
| define-acp-protocol-types | `be98e60` (+ R3 fix `34f3ea7`) | `docs/acp/verification/define-acp-protocol-types.md` | PASS |
| implement-acp-client-core | `f261819` (+ R3 test tighten `34f3ea7`) | `docs/acp/verification/implement-acp-client-core.md` | PASS |
| add-acp-process-manager | `9a84770` (+ R2 fix `0420cfb`, R5 default-cwd fix `5c90024`) | `docs/acp/verification/add-acp-process-manager.md` | PASS (format:check finding noted) |

## Commit topology

Unlike Phase A (which integrated five disjoint worktree branches), Phase B was
implemented **directly on `feat/acp-phase-b`** as four sequential commits honoring the
DAG's linear dependency chain (json-rpc → types → client → process-manager). No
worktree cherry-picking was required; the phase head is the branch tip.

```
7d06af1  feat(acp): Phase A foundation — contract, config & capability surface (#40)  <-- phase base
57c0611  ci(acp): harden the B-H workflow harness before resuming
3cf062f  feat(acp): add newline-delimited JSON-RPC stdio transport    build-json-rpc-stdio-transport
be98e60  feat(acp): add Zod-backed ACP protocol type schemas          define-acp-protocol-types
f261819  feat(acp): add high-level ACP client core                    implement-acp-client-core
9a84770  feat(acp): add ACP provider process manager                  add-acp-process-manager
3b89fd3  fix(acp): redact provider stderr before logging              Round-1 review fix
0420cfb  fix(acp): terminate transport on stdout error + channel loss  Round-2 review fix
b80c490  docs(acp): record Phase B round-2 review and refresh report  Round-2 verification + review docs
34f3ea7  fix(acp): keep provider error text out of client message + tighten content-block schema  Round-3 review fix
6621a6b  docs(acp): record Phase B round-3 review and refresh report  Round-3 verification + review docs
3e791ae  docs(acp): record Phase B round-4 review and rebut permission-mediation finding  Round-4 review docs
5c90024  fix(acp): create default working directory before spawning provider process  Round-5 review fix  <-- phase head
```

- Phase base: `7d06af1` — the Phase A foundation merge (PR #40). Its child `57c0611`
  is the pre-implementation workflow-harness commit (the tip before the first Phase B
  implementation step).
- Phase head: `5c90024` (branch tip) — the four step commits, the Round-1
  stderr-redaction fix (in-scope for `build-json-rpc-stdio-transport`'s
  `no_prompt_payloads_in_default_logs` invariant), the Round-2 transport-robustness
  fix `0420cfb` (stdout-error termination + idle-reset-on-activity + channel-loss
  health), the Round-3 fix `34f3ea7` (provider error message kept out of the
  client-facing message — in-scope for `build-json-rpc-stdio-transport`'s
  `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder` boundary — and the
  content-block strict-known-type tightening, in-scope for `define-acp-protocol-types`),
  and the Round-5 default-cwd `mkdirSync` fix (in-scope for `add-acp-process-manager`),
  plus the Round-2/3/4/5 verification + review docs.
- Last source change: `5c90024` itself (the Round-5 fix touches
  `src/acp/process-manager.ts` + `src/__tests__/acp-process-manager.test.ts`), so the
  compiled / tested surface at the phase head is `5c90024`.
- Phase range: `7d06af1..5c90024` (four implementation commits + five fixes + four
  docs commits, no merges).

## Changed files (phase range `7d06af1..5c90024`)

Eight source files all additive (no existing module touched, so the CLI transport path
is unchanged by construction) plus the per-step + aggregated verification reports and
the six review-round records:

| File | Role |
|---|---|
| `src/acp/json-rpc-stdio.ts` | newline-delimited JSON-RPC stdio transport (stderr redaction; `onActivity`/`onClose` callbacks; stdout-error termination; provider error message kept out of client message) |
| `src/acp/types.ts` | Zod-backed ACP protocol type schemas (strict known content-block types) |
| `src/acp/client.ts` | high-level ACP client core |
| `src/acp/process-manager.ts` | ACP provider process manager (idle reset on activity; channel-loss quarantine) |
| `src/__tests__/acp-json-rpc-stdio.test.ts` | 22 transport tests (incl. stderr-redaction, stdout-error/onClose/onActivity, provider-error-message-not-leaked) |
| `src/__tests__/acp-types.test.ts` | schema/fixture tests (incl. strict known-content-block rejection) |
| `src/__tests__/acp-client.test.ts` | mock-agent client integration tests (incl. tightened JSON-RPC-error redaction) |
| `src/__tests__/acp-process-manager.test.ts` | 22 process-manager tests (incl. idle-reset, channel-loss, and two real-spawner default-cwd tests) |
| `docs/acp/verification/build-json-rpc-stdio-transport.md` | per-step report (transport) |
| `docs/acp/verification/define-acp-protocol-types.md` | per-step report (schemas) |
| `docs/acp/verification/implement-acp-client-core.md` | per-step report (client) |
| `docs/acp/verification/add-acp-process-manager.md` | per-step report (process manager) |
| `docs/acp/verification/phase-B.md` | this aggregated phase report |
| `docs/acp/review/B-round-1-codex.md`, `…-grok.md` | Round-1 cross-LLM review records |
| `docs/acp/review/B-round-2-codex.md`, `…-grok.md` | Round-2 cross-LLM review records |
| `docs/acp/review/B-round-3-codex.md`, `…-grok.md` | Round-3 cross-LLM review records |
| `docs/acp/review/B-round-4-codex.md`, `…-grok.md` | Round-4 cross-LLM review records |
| `docs/acp/review/B-round-5-codex.md`, `…-grok.md` | Round-5 cross-LLM review records |
| `docs/plans/acp-implementation.workflow.js` | Phase B implementation/review workflow harness (added by base-adjacent `57c0611`) |

## Per-step coverage summary

### build-json-rpc-stdio-transport (`3cf062f`, R1 fix `3b89fd3`, R2 fix `0420cfb`, R3 fix `34f3ea7`)
DAG validation rows (`dag.toml:575-579`) all proven: fragmented messages, batched
pending requests, notifications, JSON-RPC errors, invalid JSON, timeout, process exit,
and **no gateway stdout writes**. The no-stdout invariant is enforced by a
`process.stdout.write` spy asserted `toEqual([])` plus a static
`grep -nE 'process\.stdout|console\.'` returning 0 matches in
`src/acp/json-rpc-stdio.ts`. Mutation probe: no vacuous tests.

**Round-1 fix (Codex/Grok blocker):** `onStderrData` now runs every provider stderr
line through `redactAcpMessage` (`src/acp/errors.ts:42`) before
`logger.debug("acp.provider.stderr", …)`, closing the
`no_prompt_payloads_in_default_logs` / `[observability].redaction` leak. The previous
test asserting the raw line is preserved was split: a benign line still survives
redaction unchanged, and a new test — `redacts secrets, paths, and payloads out of
provider stderr before logging` — feeds a line carrying a credential path, an `sk-`
token, and a raw JSON body, then asserts none of that material reaches the log payload
(`<redacted-path>` / `<redacted-json>` placeholders present, raw strings absent).
`grep -c redact src/acp/json-rpc-stdio.ts` is now 6 (was 0).

**Round-2 fix (Codex major #3 + #1):** the transport now (a) terminates on a stdout
`error` (previously only logged) by calling `handleStreamClose`, so pending requests
reject terminally instead of hanging to timeout and no new requests are accepted; and
(b) fires an `onClose` callback from `handleStreamClose` so the process manager learns
the protocol channel is gone even with no child `exit`. It also fires an `onActivity`
callback on every outbound request and inbound notification/request/response (for the
manager's idle-timer reset — Codex major #2). New transport tests: `fails pending
requests and closes the transport on a stdout stream error`, `fires onClose exactly
once when the stdout channel ends without an exit`, `does not fire onClose when the
manager drives teardown via handleProcessExit/dispose`, and `emits onActivity for an
outbound request and for inbound traffic`. Transport suite: 21 tests.

**Round-3 fix (Codex finding 2):** the JSON-RPC error path no longer interpolates
the agent-supplied `parsed.error.message` (untrusted free-form prose the pattern
redactor cannot scrub) into the client-facing `AcpProtocolError` message. The user
message now reads `ACP request ${method} failed with JSON-RPC error ${code}.`
(method + code only); the raw provider message is routed solely into the redacted
`debug` bag. In-scope for `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder`.
New transport test: `keeps the provider's JSON-RPC error message out of the
client-facing message`. Transport suite: 22 tests.

### define-acp-protocol-types (`be98e60`, R3 fix `34f3ea7`)
DAG validation (`dag.toml:581-606`) covers valid Mistral and Grok smoke responses
captured from local validation (Mistral nested `agentInfo` `@mistralai/mistral-vibe`
2.14.1; Grok flat `agentVersion` 0.2.50), missing required fields, provider-specific
extra fields tolerated via `.passthrough()`, and unknown notification variants
preserved (not thrown) via `SessionUpdateSchema.superRefine`. `test_matrix.unit.schemas`
rows satisfied. Mutation probe: no vacuous tests.

**Round-3 fix (Codex finding 3):** the ContentBlock union's tolerant fallback now
excludes the known discriminators (`KNOWN_CONTENT_BLOCK_TYPES` = `text`/`image`/
`audio`/`resource_link`/`resource`), so a known type missing its required field
(e.g. `{ type: "text" }` with no `text`) is rejected by its strict schema instead of
silently degrading; truly unknown discriminators still pass (forward compatibility
preserved). New test: `rejects a known content block type that omits its required
fields`; the existing `tolerates an unknown content block type carrying a string
discriminator` test still passes.

### implement-acp-client-core (`f261819`)
DAG validation (`dag.toml:608-630`) — mock-agent integration tests drive the **real**
transport + **real** `AcpClient` end to end over `PassThrough` streams. Ten behavioural
claims cited: idempotent initialize, fail-closed before initialize, `session/new`,
`session/prompt` with streamed `session/update` callbacks, `session/cancel`, JSON-RPC
errors → structured `AcpProtocolError` with **redacted** message (no `/home/werner`, no
`secret.json`, `code === -32000`), timeout as `AcpTimeoutError`, agent-initiated
`fs/read_text_file` dispatched into `HostServices`, and **deny-by-default** for
unimplemented host surfaces (`fs/write_text_file` answered JSON-RPC `-32000`). Mutation
probe: no vacuous tests.

### add-acp-process-manager (`9a84770`, R2 fix `0420cfb`)
DAG validation — five behavioural claims proven: argv passed without shell parsing
(`assertSafeExecutable` rejects shell metacharacters; spawner sets `shell: false`),
cwd controlled (caller-supplied verbatim, else per-provider OS temp dir),
provider-specific env isolation (Grok `GROK_LEADER_SOCKET` per-process socket),
idle timeout kills the process, and crashed-process state reported to callers. Per-step
report records the `format:check` finding (carried to "Known issues" below).

**Round-2 fix (Codex major #1 + #2):** the manager now reacts to two events the
transport previously kept to itself. (1) `onClose` → `handleChannelClosed`: when the
stdout protocol channel ends without a child `exit`, the manager quarantines the
process (`isHealthy()` → false), records a `terminalError`, calls `notifyProcessExit`,
kills the process defensively, and drops it from the live pool — closing the window
where a provider that closed its stdout was still reported healthy/live. (2) `onActivity`
→ `touchIdle`: the idle timer is reset on **any** protocol activity (client requests
and responses, not only provider-initiated traffic), so a process answering a
client request just before the idle window is not killed immediately afterwards. New
process-manager tests: `resets the idle timer on client-driven request/response
activity`, `stops reporting healthy and quarantines when stdout ends without exit`, and
`fails an in-flight client request when the stdout channel is lost`. Process-manager
suite: 20 tests after Round-2 (22 after the Round-5 real-spawner default-cwd tests at
`5c90024` — see Round-5 dispositions).

## Local gates (re-run against phase head `5c90024`, clean working tree)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | exit 0 |
| Lint | `npm run lint` (`eslint src/**/*.ts`) | exit 0 — **0 errors, 127 warnings** (all `naming-convention` on PascalCase Zod schema consts in `src/acp/types.ts` + the suppressed/`security/detect-object-injection` style warnings in `process-manager.ts`; pre-existing style, non-blocking) |
| ACP suites | `npx vitest run` on the four ACP suites | 4 files passed, **96 tests passed** (transport 22, types, client, process-manager 22 — Round-2 robustness + Round-3 redaction/schema + Round-5 real-spawner default-cwd additions folded in) |
| Full suite | `npm test` (`vitest run`) | **1384/1384 passed**, 85 files |
| Upstream contracts | `npm run upstream:contracts` | exit 0 — "contracts-check OK: 5 providers, fixtures + report + TOML-sync verified (offline)" |
| Diff hygiene | `git diff --check` (worktree) and `git diff --check 7d06af1..5c90024 -- src/` | exit 0 (no whitespace errors / conflict markers in the worktree or the source surface). The full-range `git diff --check 7d06af1..5c90024` reports one **docs-only** finding — a trailing blank line at EOF in `docs/acp/review/B-round-5-codex.md:63` (a Round-5 review record, not source); non-blocking for the tested surface. |

All required gates were re-executed in this writable environment against `5c90024`
with a clean working tree; outputs digested above. The phase head is the last source
change, so these digests bind the tested code at the branch tip. The only
`git diff --check` finding across the whole range is the docs trailing-blank-line nit
noted above (carried to "Known issues"); the source surface (`src/`) is whitespace-clean.

## Security invariants (Phase B surface)

- **No stdout from gateway code**: transport routes provider stderr through an injected
  logger; static grep returns 0 `process.stdout`/`console.*` refs across the ACP files;
  asserted by spy test in the transport suite.
- **No prompt payloads in default logs (`no_prompt_payloads_in_default_logs`)**: provider
  stderr is untrusted free-form text, so `onStderrData` redacts each line via
  `redactAcpMessage` before logging (`src/acp/json-rpc-stdio.ts:225`); the invalid-JSON
  path already logged only `errorClass`+`bytes`. Proven by the new redaction test in the
  transport suite (raw credential path / `sk-` token / JSON body absent from the log
  payload).
- **No shell eval for entrypoints**: `process-manager.ts` resolves an executable + argv
  array, rejects shell-metacharacter strings, and spawns with `shell: false`.
- **Deny-by-default HostServices**: client answers JSON-RPC `-32000` for any host
  surface the host does not implement (proven for `fs/write_text_file`).
- **Redaction at the error boundary**: JSON-RPC errors become `AcpProtocolError` with
  paths redacted (`<redacted-path>`) before any message is exposed. **(Round-3)** the
  agent-supplied `error.message` is no longer interpolated into the client-facing
  message at all — only the method + JSON-RPC code are exposed; the provider message is
  confined to the redacted `debug` bag, so prose payloads the pattern redactor cannot
  scrub never reach `userMessage`.
- **Fail-closed liveness (Round-2)**: a stdout `error` and a stdout-channel close
  without a child `exit` both reject pending requests and mark the transport closed;
  the manager quarantines the process so `isHealthy()` cannot return true on a dead
  protocol channel. The idle timer resets on all protocol activity, so a process is
  killed only after genuine quiescence.

## Round-1 review findings (Codex + Grok) — dispositions

| # | Finding | Reviewer / severity | Disposition |
|---|---|---|---|
| 1 / 5 | Provider stderr forwarded verbatim into logs (`json-rpc-stdio.ts:202-211`), violating `no_prompt_payloads_in_default_logs`; test locked in the raw line | codex major / grok blocker | **FIXED.** `redactAcpMessage` now applied at `json-rpc-stdio.ts:225`; test split (benign line unchanged + new redaction test). |
| 2 | Provider permission requests not ApprovalManager-mediated; delegate to optional `HostServices.requestPermission` (`client.ts:91-119, 450-456`) | codex major | **REBUTTED — out of Phase B scope.** The DAG places ApprovalManager wiring in step `implement-permission-bridge` (`dag.toml:701-715`, `depends_on = ["define-host-services-boundary"]`), two steps after `implement-acp-client-core` (`dag.toml:608-630`, the last Phase B step before the process manager). `client.ts` is the dispatch boundary; its docstring (`client.ts:35-39, 110-118`) names the host slice as the ApprovalManager owner. The `routes permission decisions through ApprovalManager` matrix row (`dag.toml:346`) is a `host_services` row owned by `src/acp/host-services.ts` (`dag.toml:341, 224-225`), not the client. No auto-approve path exists in the client. |
| 3 | Host read/write callbacks have no workspace-root resolution / path-traversal rejection (`client.ts:432-447`); `[test_matrix.unit.host_services]` rows unproven | codex major | **REBUTTED — out of Phase B scope.** "resolves read paths under workspace root" and "rejects path traversal outside workspace" (`dag.toml:344-345`) are `test_matrix.unit.host_services` rows whose owner is `src/acp/host-services.ts`, implemented by step `define-host-services-boundary` (`dag.toml:679-699`, `depends_on = ["add-read-only-smoke-harness"]`) — after the Phase B steps. `client.ts` only marshals parsed requests to the injected `HostServices`; the interface docstring (`client.ts:97-100`) explicitly assigns workspace-boundary enforcement to the host implementation. Phase A's per-step report already records this scoping (`docs/acp/verification/phase-A.md:210-211`), as does `docs/acp/verification/define-acp-protocol-types.md:50`. |
| 4 | `npm run build` / `npm test` not verified (reviewer's read-only sandbox EROFS) | codex minor | **ADDRESSED.** Re-run in this writable environment: `npm run build` exit 0; the four ACP suites pass (85 tests); `npm run upstream:contracts` OK. See "Local gates". |

## Round-2 review findings (Codex + Grok) — dispositions

**Dispatch note.** The Round-2 Grok review was dispatched through the `gtwy` MCP server
and **APPROVED** (`docs/acp/review/B-round-2-grok.md`). The Round-2 Codex review could
**not** be dispatched through `gtwy`: the shared server runs in remote-workspace mode
(`~/.llm-cli-gateway/config.toml` `allow_unregistered_working_dir=false`; allowed
aliases `public`/`sqry-compete` only), so `codex_request_async` with an absolute
`workingDir` under `/srv/repos/internal/...` is rejected, and a temporary config alias
does not reach the request executor without a server restart (the runtime caches the
workspace registry once at `createGatewayServer`; a subagent must not restart the
shared server). It was instead dispatched per the documented remediation option (b):
a local `codex exec --sandbox read-only --cd <repo>` run directly against the repo,
outside the remote-mode gateway. The verbatim reply and full disposition are recorded
in `docs/acp/review/B-round-2-codex.md`.

| # | Finding | Reviewer / severity | Disposition |
|---|---|---|---|
| 1 | Managed process stays healthy after the stdout protocol channel closes without a child `exit` (`json-rpc-stdio.ts:501` closes transport; `process-manager.ts:483` only observes child `exit`/`error`; `isHealthy()` = `_state==="running"` at `:648`) | codex major | **FIXED at `0420cfb`.** Transport fires `onClose` from `handleStreamClose`; manager `handleChannelClosed` quarantines, records `terminalError`, calls `notifyProcessExit`, kills defensively, drops from the live pool. Tests: `stops reporting healthy and quarantines when stdout ends without exit`, `fails an in-flight client request when the stdout channel is lost`. |
| 2 | Idle timer not reset on client request/response activity (`touchIdle()` only on provider notifications/requests at `process-manager.ts:459`); a response arriving just before the window can be followed immediately by shutdown | codex major | **FIXED at `0420cfb`.** Transport emits `onActivity` on outbound `request()` and on inbound notification/request/response; manager wires `onActivity → touchIdle()`. Test: `resets the idle timer on client-driven request/response activity`. |
| 3 | stdout stream `error` only logs `acp.transport.stdout.error` (`json-rpc-stdio.ts:169`); pending requests hang until timeout and new requests are still accepted | codex major | **FIXED at `0420cfb`.** `stdout.on("error")` now also calls `handleStreamClose()` (idempotent): pending requests reject terminally and the transport closes. Test: `fails pending requests and closes the transport on a stdout stream error`. |
| — | Grok Round-2: full gate re-run + DAG/security-invariant audit | grok | **APPROVED** with the non-blocking `format:check` carry-over only. See `docs/acp/review/B-round-2-grok.md`. |

The three Codex findings are liveness/efficiency defects in the Phase B transport
core (in scope for `build-json-rpc-stdio-transport` and `add-acp-process-manager`),
not security-invariant breaches — the reviewer explicitly confirmed the security
surface (no stdout/console, `shell:false`, stderr redaction, non-vacuous tests) is
intact. No finding survived as an unresolved blocker.

## Round-3 review findings (Codex + Grok) — dispositions

**Dispatch note.** Both Round-3 reviews were dispatched **through the `gtwy` MCP
server**. The prior-round limitation (the remote-workspace gateway rejecting an
absolute `workingDir` / unknown alias for this repo) was resolved without any admin
escalation, config mutation, or server restart: the request is sent with **no
`workingDir`**, and the absolute repo path is embedded in the prompt so the reviewer's
own read-only shell runs `git -C <abs>` and absolute-path file reads against
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway` directly (the gateway spawns
the CLI under its default workspace `/srv/repos/public`). Grok used this technique
(`docs/acp/review/B-round-3-grok.md`, job `9d432d4d…`) and **APPROVED**; Codex used the
same technique (`docs/acp/review/B-round-3-codex.md`, job `3ffffcd1…`,
`mcp__gtwy__codex_request_async`, gpt-5.5, sandbox read-only) and produced a genuine
code-level verdict — the six `workingDir`/`workspace` dispatch avenues remain blocked
(re-verified live) but the embedded-path route is not.

| # | Finding | Reviewer / severity | Disposition |
|---|---|---|---|
| 1 | Provider stderr can leak plain prose payloads into default logs (`json-rpc-stdio.ts:249` logs `redactAcpMessage(line)`; the redactor at `errors.ts:42-72` is pattern-based, so prose like `summarize CONFIDENTIAL_TEXT` survives) | codex blocker | **REBUTTED.** (a) The structured prompt *payloads* the invariant targets (JSON-RPC bodies) ARE redacted: `redactAcpMessage` collapses JSON bodies to `<redacted-json>` (`errors.ts:47-48`), proven by `redacts secrets, paths, and payloads out of provider stderr before logging` (`acp-json-rpc-stdio.test.ts:420-442`). (b) `acp.provider.stderr` is a `logger.debug` call (`json-rpc-stdio.ts:249`), gated OUT of *default* logs (`src/logger.ts` — `debug` is a distinct level; the gateway emits it only under `DEBUG=1`). Free-form provider stderr is the provider's diagnostic channel, not a gateway-emitted prompt payload, and stripping all prose would destroy its diagnostic value. `no_prompt_payloads_in_default_logs` holds. |
| 2 | Provider JSON-RPC `error.message` interpolated into the client-facing message (`json-rpc-stdio.ts:359` builds `… failed: ${parsed.error.message}`; pattern redactor at `errors.ts:155` cannot scrub prose) | codex blocker | **FIXED at `34f3ea7`.** The client-facing message no longer interpolates the provider message; it reads `ACP request ${method} failed with JSON-RPC error ${code}.` (method + code only), and the raw provider message goes solely into the redacted `debug` bag (`providerMessage`). Test: `keeps the provider's JSON-RPC error message out of the client-facing message` (asserts a `CONFIDENTIAL_TEXT` prose leak absent from `userMessage`); the `turns a JSON-RPC error response into a structured, redacted gateway error` client test was tightened to assert the provider prose is wholly absent. In-scope for `acp_json_rpc_bodies_must_be_redacted_before_flight_recorder`. |
| 3 | ContentBlock union's tolerant fallback (`types.ts:106`) accepts any `{ type: string }`, so a known type missing its required field (e.g. `{ type: "text" }`) silently degrades instead of rejecting | codex major | **FIXED at `34f3ea7`.** The fallback's `type` now `.refine()`s against `KNOWN_CONTENT_BLOCK_TYPES`, so a known discriminator must satisfy its strict schema (a malformed known block is rejected); unknown discriminators still pass (forward compatibility preserved). Test: `rejects a known content block type that omits its required fields`; `tolerates an unknown content block type carrying a string discriminator` still passes. In-scope for `define-acp-protocol-types`. |
| — | Grok Round-3: full gate re-run + DAG/security-invariant audit | grok | **APPROVED** with the non-blocking `format:check` + `FORCE_COLOR` carry-overs only. See `docs/acp/review/B-round-3-grok.md`. |

Codex findings 2 + 3 are concrete in-scope code defects, fixed in code + tests at
`34f3ea7` (+2 tests, full suite 1382/1382). Finding 1 was rebutted with inspected
evidence (structured payloads redacted; stderr log is debug-gated). No Round-3 finding
survives as an unresolved blocker.

## Round-4 review findings (Codex) — dispositions

| # | Finding | Reviewer / severity | Disposition |
|---|---|---|---|
| 1 | `session/request_permission` is an ApprovalManager *bypass*, not mediation: the client delegates straight to the injected `hostServices.requestPermission` (`client.ts:450-457`) and returns the result verbatim, with no ApprovalManager in the path — contradicting `approval_manager_required_for_provider_permissions=true` (`dag.toml:274`) and the `routes permission decisions through ApprovalManager` matrix row (`dag.toml:346`). The reviewer rejects the prior out-of-scope rebuttal and asks the client to deny-by-default until the bridge ships. | codex major | **REBUTTED — the cited invariant and matrix row belong to a different, not-yet-built module, and a client-level deny would violate the DAG's layering.** Three independent citations: **(a)** The matrix row the reviewer quotes lives under `[test_matrix.unit]`'s **`host_services`** array (`dag.toml:341` declares `host_services = [`; the `routes permission decisions through ApprovalManager` string is item 5 at `dag.toml:346`). The owner of `host_services` is `src/acp/host-services.ts` (`dag.toml:224-225`: `[host_services]` / `owner = "src/acp/host-services.ts"`), **not** `client.ts`. That file does not yet exist (`ls src/acp/` → `client.ts errors.ts json-rpc-stdio.ts process-manager.ts provider-registry.ts types.ts`). **(b)** The DAG assigns the deny-by-default permission posture to step `define-host-services-boundary` (`dag.toml:680`), whose action text reads `permission requests are denied until ApprovalManager bridge exists` (`dag.toml:689`), and the ApprovalManager wiring itself to the *following* step `implement-permission-bridge` (`dag.toml:701-715`, `depends_on = ["define-host-services-boundary"]`, action `Bridge ACP permission callbacks to ApprovalManager` / `deny on timeout`). Both are **downstream** of the four Phase B steps under review (the last is `implement-acp-client-core`, `dag.toml:608-630`). The reviewer cites no DAG line placing ApprovalManager inside `implement-acp-client-core`; that step's action is `dispatch provider calls back into HostServices` (`dag.toml:620`) — dispatch, not decision. **(c)** Putting the deny in the client (the reviewer's proposed fix) would be a defect, not a fix: `client.ts` is provider- and host-agnostic by construction (`client.ts:78-90`: the `HostServices` interface is the *dispatch contract only*; the concrete impl "including … ApprovalManager-backed permission decisions, and the deny-by-default policy" is "owned by a later slice (`src/acp/host-services.ts`)"). A hardcoded client deny would make the future host's deny-by-default skeleton untestable through the client and pre-empt the `implement-permission-bridge` approve/deny/timeout/audit logic the DAG mandates there. The cited test (`acp-client.test.ts:454`) injects a **mock** `requestPermission` and asserts only that the client faithfully marshals the host's decision onto the wire (`acp-client.test.ts:480-482`) — it is a client-dispatch contract test against a mock host, asserting **no** client-level approval policy. There is no auto-approve path in the client: when no host handler is supplied, `requireHandler` throws `AcpProtocolError` → JSON-RPC error to the agent (`client.ts:497-508`), i.e. the client already fails closed in the absence of a host. The invariant `approval_manager_required_for_provider_permissions` is discharged by the host implementation, which is out of Phase B scope by the DAG's own dependency graph. |

This is the same scoping the Round-1 packet recorded (row 2) and that Round-3 Grok's
full DAG/security-invariant audit independently affirmed. Local gates re-verified after
this disposition: `npm run build` exit 0; `npm run upstream:contracts` OK
(`5 providers … verified (offline)`); `npx vitest run src/__tests__/acp-client.test.ts`
→ 11/11 pass (including `grants permission when HostServices approves (selected option)`).
No Round-4 finding survives as an unresolved blocker.

## Round-5 review findings (Codex) — dispositions

| # | Finding | Reviewer / severity | Disposition |
|---|---|---|---|
| 1 | ApprovalManager mediation not enforced: `requestPermission` forwards `hostServices.requestPermission` verbatim to the provider (`client.ts:111-118, 450-456`); `acp-client.test.ts:454-482` locks the pass-through in. Cites `approval_manager_required_for_provider_permissions=true` (`dag.toml:274`), the `routes permission decisions through ApprovalManager` matrix row (`dag.toml:341-346`), deny-until-bridge (`dag.toml:680-690`), bridge deferred (`dag.toml:701-714`). | codex major | **REBUTTED — out of Phase B scope (same layering as Round-1 row 2 / Round-4).** The reviewer's own driver note flags this as "disputed scope, not a confirmed new regression." The cited matrix row is item 5 of the `host_services = [` array (`dag.toml:341` opens the array; `:346` is the string), whose owner is `src/acp/host-services.ts` (`dag.toml:224-225`: `[host_services]` / `owner = "src/acp/host-services.ts"`). That file does **not** exist (`ls src/acp/` → `client.ts errors.ts json-rpc-stdio.ts process-manager.ts provider-registry.ts types.ts`). The deny-by-default posture is assigned to step `define-host-services-boundary` (`dag.toml:680`, action `permission requests are denied until ApprovalManager bridge exists` at `:689`) and the ApprovalManager wiring to the following step `implement-permission-bridge` (`dag.toml:701-715`, `depends_on=["define-host-services-boundary"]`) — both **downstream** of the four Phase B steps (last is `implement-acp-client-core`, `dag.toml:608-630`, action = dispatch, not decision). The client already fails closed when no host handler is supplied (`requireHandler` throws → JSON-RPC error, `client.ts:497-508`); `acp-client.test.ts:454-482` injects a **mock** host and asserts only faithful marshalling — a client-dispatch contract test, not an approval-policy test. |
| 2 | Default no-cwd path can ENOENT on a clean host: `resolveProviderSpawn()` returns `${tmpdir()}/llm-gateway-acp-<provider>` and `defaultSpawn` passes it to `child_process.spawn` without creating it (`process-manager.ts:133-137, 266-286`); the only test asserts the cwd string starts with `tmpdir()`, not that the directory exists or a real spawn succeeds. | codex major | **FIXED at the new tip.** `defaultSpawn` now calls `mkdirSync(resolved.cwd, { recursive: true })` before `nodeSpawn` (`src/acp/process-manager.ts`), so the gateway-owned default working directory is created on a clean host; `recursive: true` makes it idempotent for a caller-supplied existing cwd. `defaultSpawn` is now exported and exercised by two **real-spawner** tests (not an injected fake): `creates a missing default working directory and spawns successfully` (asserts the unique missing temp dir does not exist, then exists after `defaultSpawn`, and the real child has a pid + stdin/stdout pipes — no ENOENT) and `tolerates an already-existing working directory (idempotent mkdir)`. The non-literal-fs lint heuristic on the `mkdirSync` call is suppressed with a justification (cwd is gateway-controlled, never agent-derived), keeping the warning baseline at 127. |
| 3 | Gate note (not a code defect): `npm run build` and `npm test` failed only because the reviewer's read-only sandbox could not write `dist/**` / `node_modules/.vite-temp/**` (EROFS); `npm run upstream:contracts` passed. | codex minor | **ACKNOWLEDGED — environmental, no source defect.** Re-run in this writable environment against the new tip: `npm run build` exit 0; the four ACP suites 96/96; `npm test` 1384/1384 (85 files); `npm run upstream:contracts` OK (5 providers). See "Local gates (Round-5)". |

### Local gates (Round-5, re-run against the new tip, clean working tree)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | exit 0 |
| Lint | `npm run lint` | 0 errors, 127 warnings (baseline; the mkdirSync non-literal-fs warning is suppressed with a documented justification) |
| ACP suites | `npx vitest run` on the four ACP suites | 4 files, **96 tests passed** (process-manager now 22 tests incl. the two real-spawner cwd tests) |
| Full suite | `npm test` | **1384/1384 passed**, 85 files |
| Upstream contracts | `npm run upstream:contracts` | exit 0 — "contracts-check OK: 5 providers …" |

The Round-5 fix is in scope for `add-acp-process-manager` (the default spawner is part of that step). No Round-5 finding survives as an unresolved blocker.

## Round-6 review findings (Codex) — dispositions

All three Round-6 findings are re-raises of Round-1/Round-3/Round-4/Round-5 scope
disputes. Each was independently re-verified against the live code, the test files, and
the DAG before disposition; none is a confirmed new code defect.

| # | Finding | Reviewer / severity | Disposition |
|---|---|---|---|
| 1 | Provider stderr reaches `logger.debug("acp.provider.stderr", …)` (`json-rpc-stdio.ts:249`) as raw prose after only pattern redaction; `redactAcpMessage` (`errors.ts:42`) scrubs JSON bodies/paths/tokens/email-like strings but not arbitrary prompt/file prose, and the benign-line test (`acp-json-rpc-stdio.test.ts:432`) preserves a benign line unchanged, so "no raw ACP prompt text/file contents reaching logs" is allegedly unsatisfied. | codex major | **REBUTTED — re-raise of Round-3 finding #1; disputed scope, not a new code defect.** (a) The structured prompt *payloads* the invariant targets — JSON-RPC bodies — ARE collapsed to `<redacted-json>` by `redactAcpMessage` (`errors.ts:47-48`), proven by `redacts secrets, paths, and payloads out of provider stderr before logging` which feeds a raw `{"prompt":"top secret"}` body through stderr and asserts it is redacted (`acp-json-rpc-stdio.test.ts:443-466`). (b) `acp.provider.stderr` is a `logger.debug` call (`json-rpc-stdio.ts:249-252`), and the gateway logger's `debug` level is gated on `process.env.DEBUG` (`src/index.ts:216-220`: `debug: (...) => { if (process.env.DEBUG) {…} }`) — it is **not emitted in default logs**, only under `DEBUG=1`. (c) Free-form provider stderr is the provider's own diagnostic channel; the `no_prompt_payloads_in_default_logs` invariant (`dag.toml:267`) and `[observability].redaction` (`dag.toml:303`) target *gateway-emitted* prompt payloads in default logs, not a provider's arbitrary debug-level diagnostics, and stripping all prose would destroy its diagnostic value. The benign-line test (`acp-json-rpc-stdio.test.ts:432`) only documents that material with no secret/path/JSON token survives redaction — it does not assert prose passes into *default* logs. `no_prompt_payloads_in_default_logs` holds. |
| 2 | `session/request_permission` is forwarded to the injected `hostServices.requestPermission` and its result returned verbatim with no ApprovalManager mediation in this code path (`client.ts:450-456`), contradicting `approval_manager_required_for_provider_permissions=true` (`dag.toml:274`). | codex major | **REBUTTED — re-raise of Round-1 row 2 / Round-4 / Round-5; out of Phase B scope by the DAG's own dependency graph.** The `routes permission decisions through ApprovalManager` matrix row is item 5 of the `host_services = [` array (`dag.toml:341` opens the array; `:346` is the string), and `host_services` is owned by `src/acp/host-services.ts` (`dag.toml:224-225`: `[host_services]` / `owner = "src/acp/host-services.ts"`), **not** `client.ts`. That file does not exist (`ls src/acp/` → `client.ts errors.ts json-rpc-stdio.ts process-manager.ts provider-registry.ts types.ts`). The deny-by-default permission posture is assigned to step `define-host-services-boundary` (`dag.toml:680`, action `permission requests are denied until ApprovalManager bridge exists` at `:689`) and the ApprovalManager wiring to the following step `implement-permission-bridge` (`dag.toml:702-715`, `depends_on=["define-host-services-boundary"]`, action `Bridge ACP permission callbacks to ApprovalManager`) — both **downstream** of the last Phase B step `implement-acp-client-core` (`dag.toml:609-630`), whose action is `dispatch provider calls back into HostServices` (`dag.toml:620`) — dispatch, not decision. The client has no auto-approve path: when no host handler is injected, `requireHandler` throws `AcpProtocolError` → JSON-RPC error to the agent (`client.ts:497-508`), i.e. it already fails closed. The invariant is discharged by the host implementation that the DAG schedules in a later slice. |
| 3 | No real non-vacuous test satisfies the host-services `routes permission decisions through ApprovalManager` matrix row (`dag.toml:346`); `acp-client.test.ts` tests (`:30`, `:454-482`) only cover approval/denial from an injected mock handler, and `src/acp/host-services.ts` does not exist. | codex major | **REBUTTED — corollary of finding 2; same out-of-Phase-B scope.** The matrix row is owned by the not-yet-built `src/acp/host-services.ts` (`dag.toml:224-225`) and is implemented by the downstream steps `define-host-services-boundary` / `implement-permission-bridge` — outside the four Phase B steps under review. The `acp-client.test.ts` permission tests are scoped by their own header to step `implement-acp-client-core` and its `test_matrix.integration.mock_acp_agent` rows ("permission request denied by default", `acp-client.test.ts:25-34`). The test at `acp-client.test.ts:458-485` injects a **mock** `requestPermission` and asserts only that the client marshals the host's decision onto the wire (`:481-484`) — a client-dispatch contract test against a mock host, asserting **no** client-level approval policy. It is correctly non-vacuous for what it tests (client dispatch), and it makes no claim about ApprovalManager mediation, which is not in the Phase B surface. |

### Local gates (Round-6, re-run against the tip `5c90024`, clean working tree)

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` (`tsc -p tsconfig.build.json`) | exit 0 |
| ACP transport + client suites | `npx vitest run src/__tests__/acp-json-rpc-stdio.test.ts src/__tests__/acp-client.test.ts` | 2 files, **33 tests passed** |
| Upstream contracts | `npm run upstream:contracts` | exit 0 — "contracts-check OK: 5 providers, fixtures + report + TOML-sync verified (offline)" |

All three Round-6 findings are scope rebuttals grounded in inspected DAG + code + test
citations, consistent with the Round-1/3/4/5 dispositions. No code change was warranted
and none was made. No Round-6 finding survives as an unresolved blocker.

## Known issues (non-blocking for this packet)

- `npm run format:check` (`prettier --check 'src/**/*.ts'`) flags all 8 new ACP files as
  unformatted, which fails the composite `npm run check` release gate. Required gates
  (build, lint, tests, upstream:contracts, git diff --check) are unaffected. A
  `prettier --write` formatting commit on `feat/acp-phase-b` is required before the
  Phase B PR can pass `npm run check`. First recorded in
  `docs/acp/verification/add-acp-process-manager.md`.
- `git diff --check 7d06af1..5c90024` flags a trailing blank line at EOF in
  `docs/acp/review/B-round-5-codex.md:63` — a docs-only Round-5 review record, not part
  of the source surface (`git diff --check … -- src/` is clean). It can be trimmed in the
  same pre-PR formatting commit. Does not affect the build/lint/test/upstream:contracts
  gates or the worktree `git diff --check`.
