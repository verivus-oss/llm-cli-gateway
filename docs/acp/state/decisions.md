# ACP gateway extension — resolved decisions

Slice: `first-class-acp-gateway-extension-2026-06-12`
Branch: `feat/acp-gateway-extension`
Source plan: `docs/plans/first-class-acp-gateway-extension.dag.toml`

This document resolves every `[open_questions]` entry in the source DAG using the
documented defaults already encoded elsewhere in the plan (the `[config.example.acp]`
section, `[architecture.module_plan]`, `[host_services.phases]`, `[non_goals]`, and
`[session_model]`). Decisions here are the binding answers for implementation; any
later change requires a new plan revision.

Protocol target is **Agent Client Protocol** (the JSON-RPC protocol between
editors/clients and coding agents). Agent-to-agent "Agent Communication Protocol"
work is explicitly out of scope.

---

## 1. provider_process_reuse

**Question:** Should ACP provider processes be per request, per gateway session, per
workspace, or pooled by provider/workspace?

**Decision: per gateway-session, with idle reaping.**

- An ACP provider process is bound to a single gateway ACP session (the `gw-*` row
  that owns `metadata.acp.sessionId`). `initialize` runs once per process; the
  process then services `session/new`, `session/prompt`, and `session/cancel` for
  that one gateway session.
- The process is reaped when idle. The reaper honours
  `[acp].process_idle_timeout_ms` (default `600000` ms / 10 min, matching the
  `[config.example.acp]` default and the existing gateway idle-timeout convention).
  Idle is measured from the last completed ACP request on that process.
- Not per request: re-spawning and re-`initialize` for every prompt is wasteful and
  loses provider-native session continuity needed for `resume_policy`.
- Not per workspace and not pooled-by-provider/workspace: a shared process would
  multiplex multiple gateway sessions' prompts and host-service callbacks through one
  stdio pair, which breaks the deny-by-default HostServices isolation boundary and
  complicates redaction, cancellation, and quarantine. Pooling is explicitly deferred;
  it can be revisited in a later plan if smoke/pilot data shows spawn cost is a
  problem.
- Read-only smoke (`smoke-harness`) is exempt: it spawns a short-lived process,
  runs `initialize` + `session/new` in a disposable cwd, captures
  `protocolVersion`/`agentInfo`, and terminates immediately. Smoke processes are
  never session-bound and never reused.
- Process lifecycle (spawn without shell, cwd control, env isolation incl. Grok
  leader-socket isolation, idle-timeout kill, shutdown kill, crash quarantine) is
  owned by `src/acp/process-manager.ts` per the module plan.

## 2. host_filesystem_contract

**Question:** Which ACP filesystem methods are required by `vibe-acp` and
`grok agent stdio` before prompt routing is useful?

**Decision: none are required for the first runtime pilots.**

- Per `[host_services.phases]`, the first runtime pilots (Mistral phase-1, Grok
  phase-2 in `[rollout]`) operate at **phase-0 (read-only smoke)** and **phase-1
  (read-only files)** boundaries only. Phase-0 exposes no filesystem services at all;
  phase-1 exposes at most workspace-scoped read-only filesystem methods.
- Therefore prompt routing ships **without** mandating any provider filesystem
  method. HostServices filesystem methods stay **deny-by-default** (write disabled,
  terminal disabled), and any read method is available only when phase-1 is reached
  and resolves strictly through the existing workspace registry + worktree manager
  with path-traversal rejection.
- The concrete set of read methods `vibe-acp` and `grok agent stdio` actually
  invoke will be captured empirically by the mock-agent integration tests and the
  installed-provider smoke during implementation, then documented in
  `docs/acp/verification/`. Until that evidence exists, unsupported filesystem
  requests are returned to the provider as valid ACP "denied/unsupported"
  JSON-RPC responses — never process crashes.
- Write and terminal filesystem services remain gated behind
  `[acp].allow_write_host_services` / `[acp].allow_terminal_host_services`
  (both default `false`) and the ApprovalManager bridge (phase-2+), which is not
  required for the first pilots.

## 3. permission_granularity

**Question:** Can provider permission callbacks be mapped cleanly to existing
ApprovalManager request types, or is a new approval kind needed?

**Decision: route through the existing ApprovalManager; no new approval kind in
this slice.**

- `permission_callbacks_route_through_approval_manager = true` and
  `approval_manager_required_for_provider_permissions = true` are fixed decisions in
  the DAG. ACP permission callbacks map onto the existing ApprovalManager request
  surface: provider permission request type + target path/command + summary become an
  approval request, preserving both provider and gateway session context.
- Because the first pilots run at phase-0/phase-1 (permissions = `deny`), the
  permission bridge is **deny-by-default** and is not exercised for write/terminal in
  the initial runtime pilots. The bridge is implemented and tested
  (`implement-permission-bridge` step) so phase-2 can light up later without a
  redesign, but write/terminal approvals stay disabled unless the corresponding
  `allow_*_host_services` config category is enabled.
- A dedicated new ApprovalManager "kind" is **deferred**: it is introduced only if
  phase-2 mapping work proves the existing request types cannot represent an ACP
  permission cleanly. That determination is made during `implement-permission-bridge`
  and recorded in `docs/acp/verification/` if it occurs; it is out of scope for the
  initial pilot ship.

## 4. streaming_shape

**Question:** Which ACP `session/update` variants need to map to current sync
responses versus async job logs?

**Decision: accumulate final text for sync; stream all updates into async job logs.**

- The `event-normalizer` (`src/acp/event-normalizer.ts`) converts ACP
  `session/update` notifications into gateway shapes as follows:
  - **Sync requests** (`*_request`): accumulate streamed message/content updates into
    a single final text payload returned when the prompt completes. Intermediate
    updates are not surfaced piecewise to the sync caller (matching current sync CLI
    behaviour where the caller gets one final response, and respecting the 45 s
    sync-auto-defer boundary).
  - **Async jobs** (`*_request_async`): stream every `session/update` into the async
    job log as progress events, preserving structured tool/permission event variants
    where useful.
- Variants in scope for the first pilots are exactly those the target providers emit
  during a normal prompt: assistant message/content updates (text), tool-call /
  tool-status updates, and permission-request events. These are captured from local
  Mistral/Grok validation and asserted by schema + mock-prompt tests.
- File-content and terminal-output event payloads are **redacted or summarised**
  before they reach sync responses, async logs, or the flight recorder
  (`acp_json_rpc_bodies_must_be_redacted_before_flight_recorder = true`). Unknown
  notification variants are parsed tolerantly and recorded as redacted summaries
  rather than rejected.

## 5. adapter_install_story

**Question:** Should adapter-mediated providers ever be bundled, discovered, or left
entirely user-installed?

**Decision: left entirely user-installed; adapter-mediated support remains deferred.**

- `adapter_mediated_support_deferred = true` and the
  `run_adapter_mediated_providers_by_default` / `wrap_every_provider_immediately`
  non-goals fix this. Codex (`codex-cli 0.139.0`) and Claude (`claude 2.1.175`) are
  `adapter_mediated_deferred`: the gateway **does not bundle** any ACP adapter and
  does **not auto-discover or auto-install** adapters in this slice.
- Adapter-mediated support requires a separate threat model
  (`adapter_support_requires_separate_threat_model = true`) plus resolved adapter
  ownership, permission bridging, and install story before any runtime support — none
  of which ship here. Adapter candidates remain tracked as documentation/watchlist
  evidence only and are never labelled native gateway ACP support.
- If/when adapter support is pursued, it starts as **user-installed** (the user
  provides the adapter executable + argv via the same `command`/`args` config shape),
  never bundled into the gateway package. Bundling/discovery is explicitly a future
  decision behind its own plan.

## 6. default_transport_future

**Question:** What evidence would justify changing provider defaults from `cli` to
`acp`?

**Decision: `default_transport` stays `cli`; no default flip in this slice.**

- `default_transport = "cli"`, `selector_default = "cli"`,
  `release_must_preserve_existing_cli_behavior = true`, and
  `implicit_fallback` (ACP is never used implicitly until a later release explicitly
  changes `default_transport`) fix the current behaviour: omitting `transport` or
  passing `transport = "cli"` uses the existing CLI path byte-for-byte.
- Flipping any provider's default to `acp` is explicitly `[rollout].phase_4` and
  **requires a new plan**. It is out of scope here.
- Evidence that a future plan must present before proposing a flip (recorded now so
  the bar is explicit):
  1. The native provider runtime pilot (Mistral, then Grok) has passed the full
     `[test_matrix]` including async parity and crash/cancel/timeout failure modes.
  2. ACP prompt success/latency metrics (`acp_prompt_success_total`,
     `acp_request_timeout_total`, `acp_process_restart_total`) over a sustained
     window are at least at parity with the CLI path, with no redaction or
     stdout-boundary regressions.
  3. The permission bridge and HostServices have been exercised at phase-2+ with an
     audit trail, proving deny-by-default safety holds under real write/terminal
     requests.
  4. Agent-facing docs and fallback semantics are stable, and public-mirror CI has
     been green across releases with ACP runtime enabled opt-in.
- Until all of the above exist and a new plan ratifies the change, the default
  remains `cli`.

---

## Decision summary

| open_question            | resolution                                                        |
|--------------------------|-------------------------------------------------------------------|
| provider_process_reuse   | per gateway-session, idle-reaped at `process_idle_timeout_ms`      |
| host_filesystem_contract | none required for pilots; phase-0/1 read-only, deny-by-default     |
| permission_granularity   | reuse existing ApprovalManager; new kind deferred to phase-2       |
| streaming_shape          | sync = accumulated final text; async = streamed update log         |
| adapter_install_story    | entirely user-installed; adapter support deferred, never bundled   |
| default_transport_future | stays `cli`; flip is phase-4 and needs a new plan + listed evidence|
