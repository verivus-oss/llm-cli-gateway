# Phase B — Transport core: Round 2 adversarial review (lens: codex)

- Reviewer: codex (codex-cli 0.139.0, model gpt-5.5, reasoning effort high)
- Dispatch: **direct local `codex exec --sandbox read-only --cd <repo>`** — NOT via the
  `gtwy` MCP server. The shared gateway runs in remote-workspace mode
  (`allow_unregistered_working_dir=false`, allowed aliases `public` /
  `sqry-compete` only), so `codex_request_async` cannot reach
  `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. This is the
  remediation option (b) named in the Phase B round-2 driver findings: run a
  read-only codex CLI directly against the repo, outside the remote-mode
  gateway. No shared MCP server was restarted; no config was mutated.
- Codex session id: `019ebf90-6b4c-76a2-91e6-951b78e5ee97`
- Change set: commits `57c0611..3b89fd3` (HEAD at review time `3b89fd3`)
- Date: 2026-06-13
- Verdict at review time: **CHANGES_REQUIRED** (3 major, 0 blocker) — all three
  fixed at `0420cfb`.

---

## Reviewer reply (verbatim)

```
No blocker findings. Major issues below, all verified against `3b89fd3`.

1. Major — managed process stays “healthy” after protocol stdout closes
   Evidence: transport treats stdout `close`/`end` as terminal and closes itself in
   src/acp/json-rpc-stdio.ts:501, but the process manager only observes child
   `exit`/`error` in src/acp/process-manager.ts:483. `isHealthy()` only checks
   `_state === "running"` in src/acp/process-manager.ts:648.
   Impact: if the ACP stdout protocol channel closes without a child exit event,
   pending requests fail but the manager can still report the provider as healthy/live.

2. Major — idle timeout is not reset on normal request/response activity
   Evidence: idle timer is armed after initialize in src/acp/process-manager.ts:512.
   `touchIdle()` is only called for provider notifications and provider-initiated
   requests in src/acp/process-manager.ts:459, not for client requests or responses.
   The timer kills as soon as `pendingCount` is zero in src/acp/process-manager.ts:536.
   Impact: a response that arrives just before the idle timer fires can be followed
   almost immediately by shutdown, despite recent protocol activity. Current idle
   test only covers “no activity” in src/__tests__/acp-process-manager.test.ts:332.

3. Major — stdout stream `error` does not close the transport or reject pending requests
   Evidence: stdout `error` only logs `acp.transport.stdout.error` in
   src/acp/json-rpc-stdio.ts:169. By contrast, `close`/`end` reject pending requests
   via `handleStreamClose()` in src/acp/json-rpc-stdio.ts:177.
   Impact: a broken protocol stream can leave pending requests hanging until timeout
   and still accept new requests until some later close/exit path fires.

Other checked areas: no production `console.*` or gateway `process.stdout.write` found
in scoped files; default spawn uses `shell: false`; provider stderr is passed through
`redactAcpMessage` before logging; client tests and transport tests drive real
PassThrough transport/client paths rather than being vacuous. Tests were not run.
```

---

## Driver disposition

All three findings were re-verified against the cited lines and confirmed as genuine
in-scope defects in the Phase B transport core (not later-slice concerns). They are
liveness / efficiency defects, not security-invariant breaches — the reviewer
explicitly confirmed the security surface (no stdout/console, `shell:false`, stderr
redaction, non-vacuous tests) is intact. **Fixed at `0420cfb`** on `feat/acp-phase-b`.

| # | Finding | Verified evidence (at `3b89fd3`) | Fix (at `0420cfb`) |
|---|---|---|---|
| 1 | Manager reports healthy after stdout channel closes without child `exit` | `json-rpc-stdio.ts` `handleStreamClose` had no manager callback; `process-manager.ts` only wired `child.on("exit"/"error")`; `isHealthy()` = `_state === "running"` | Transport gains `onClose` fired from `handleStreamClose`; manager's `handleChannelClosed` quarantines, records `terminalError`, calls `notifyProcessExit`, kills defensively, drops from live pool. Test: `stops reporting healthy and quarantines when stdout ends without exit` + `fails an in-flight client request when the stdout channel is lost`. |
| 2 | Idle timer not reset on client request/response | `touchIdle()` only on `onNotification`/`onRequest`; client requests/responses bypassed it | Transport emits `onActivity` on outbound `request()` and on every inbound notification/request/response in `handleLine`; manager wires `onActivity → touchIdle()`. Test: `resets the idle timer on client-driven request/response activity`. |
| 3 | stdout `error` only logged; pending requests hang | `stdout.on("error")` logged `acp.transport.stdout.error` and returned | `stdout.on("error")` now also calls `handleStreamClose()` (idempotent). Test: `fails pending requests and closes the transport on a stdout stream error`. |

### Gates re-run after fix (`0420cfb`, clean tree)

- `npm run build` — exit 0
- `npx vitest run` on the four ACP suites — 4 files, **92 tests** (was 85; +7)
- `npm test` (FORCE_COLOR unset) — **1380/1380** (was 1373; +7)
- `npm run lint` — 0 errors, 127 pre-existing naming-convention warnings
- `npm run upstream:contracts` — OK (5 providers)

### Inspected (reviewer)

src/acp/json-rpc-stdio.ts; src/acp/types.ts; src/acp/client.ts; src/acp/process-manager.ts;
src/acp/errors.ts; src/__tests__/acp-json-rpc-stdio.test.ts; src/__tests__/acp-types.test.ts;
src/__tests__/acp-client.test.ts; src/__tests__/acp-process-manager.test.ts; the DAG step
blocks for `build-json-rpc-stdio-transport` / `add-acp-process-manager`. Static scans for
`console.*` / `process.stdout` / `shell:` / `redactAcpMessage`. Tests not run by the reviewer
(driver re-ran all gates, above).

### Inspected (driver, independent of reviewer)

- `json-rpc-stdio.ts:169-178` (stdout error/close/end wiring), `:500-514` (handleStreamClose),
  `:355-365` (request guards) — confirmed finding 3 + finding 1 wiring gap.
- `process-manager.ts:459-467` (transport handler wiring), `:483-484` (child exit/error only),
  `:520-550` (touchIdle/armIdleTimer), `:648-650` (isHealthy) — confirmed findings 1 + 2.
- Re-ran all five gates at `3b89fd3` (pre-fix) and `0420cfb` (post-fix).
