# Slice 0.5 — kickoff prompt

Paste the block below into a fresh session to implement Slice 0.5 of the
API-endpoint-routing plan. It defers detail to the plan docs, pins the Slice 0.5
boundary, and bakes in the review process + the stdio `gtwy` gotchas learned
during planning (2026-06-15).

Companion docs:
- [api-endpoint-routing-implementation-plan.md](api-endpoint-routing-implementation-plan.md)
- [api-endpoint-routing-scoping.md](api-endpoint-routing-scoping.md)

---

```
Implement Slice 0.5 of the API-endpoint-routing plan in this repo
(/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway).

SOURCE OF TRUTH — read these first, in full, before touching code:
- docs/plans/api-endpoint-routing-implementation-plan.md  (Slice 0.5 is the scope; read the
  whole doc for context + the "Cross-LLM review outcome" section)
- docs/plans/api-endpoint-routing-scoping.md  (locked decisions)

SCOPE — Slice 0.5 only: "provider-identity widening" under the LOCKED decision (B) ARBITRARY
PROVIDER NAMES. Concretely, make any [providers.<name>] key a valid provider id of kind:"api":
  1. Open-string provider typing: relax the closed ProviderType enum (session-manager.ts:22-42)
     so api providers are any string tagged kind:"api", WITHOUT widening LlmCli (CLI call sites
     stay narrow). Keep the existing 5 CLIs + "grok-api" working unchanged.
  2. Postgres CHECK-constraint migration: new migration relaxing the session-provider CHECK in
     migrations/001_initial_schema.sql and migrations/003_provider_type_sessions.sql (drop the
     enum CHECK for kind:"api" rows or move provider validation to the app layer). This is the
     highest-risk task — do it first and test the migration round-trip.
  3. Update every closed-enum touchpoint the plan's Slice 0.5 lists in lockstep: metrics.ts (~1-40),
     flight-recorder.ts start-row cli (~30-35), resources.ts models://+sessions:// parsers/catalogs
     (~105-273, 417-461), cache-stats.ts (~148-156), provider-tool-capabilities.ts ProviderCapabilityId
     +PROVIDER_CAPABILITY_IDS+TOOL_CONTROLS+ACP_CONTRACT (~24,427,459+).
  DO NOT implement Slice 0/1/2+ here (no ApiProvider adapter, no HttpJobRunner, no tools). Slice 0.5
  is pure identity-layer widening that ships dormant — no api provider is registered yet.
  Verify each touchpoint against the REAL current code before editing; line numbers in the plan are
  hints, not gospel — confirm them.

PROCESS (follow exactly):
- Work on a branch, not master. Land via PR (2 checks), never admin bypass. Match repo commit style;
  do NOT add a Claude/Co-Authored-By attribution trailer.
- After each meaningful change: `npm run build` && `npm run lint` && `npm test` must pass. Add tests
  for new behaviour (AAA, ≥80% coverage); each test cleans up after itself.
- Test-veracity mutation-probe audit before declaring any sub-task done: for the new tests, confirm
  they actually fail when the behaviour is broken (mutate the code, watch the test go red), per the
  standing strict-evidence audit protocol. No plan-compliance approvals — inspected evidence only.

CROSS-LLM REVIEW GATE (use the cross-llm-review skill) — adversarial, evidence-based, via the stdio
gtwy MCP (tool prefix mcp__gtwy__*; if absent try mcp__llm-cli-gateway__*):
- Reviewers: Codex (read-only) + Grok + Mistral. SKIP Gemini (hard-refuses audit/review tasks).
  NEVER give a same-repo claude_request reviewer write access (session-bleed self-commit hazard).
- Give reviewers FULL filesystem access + the sqry MCP so they read the REAL files, not your summary:
    * codex_request: model gpt-5.4, dangerouslyBypassApprovalsAndSandbox:true,
      sandboxMode:"danger-full-access", mcpServers:["sqry"]
    * grok_request: model grok-build, permissionMode:"bypassPermissions", alwaysApprove:true,
      mcpServers:["sqry"]  (grok-build REJECTS reasoningEffort/effort — omit it)
    * mistral_request: trust:true, mcpServers:["sqry"]  (do NOT pass permissionMode — "explore"/"chat"
      are invalid agent modes on this install and error out; the default is fine)
  * CRITICAL: do NOT pass workingDir/workspace (absolute paths are rejected in remote-workspace mode).
    Put the absolute repo root in the prompt and tell each reviewer to read the files itself with full
    access. (Registering the repo as a gateway workspace needs LLM_GATEWAY_WORKSPACE_ADMIN=1 +
    workspace:admin scope, which you won't have — the full-access path above is the workaround.)
- Hand reviewers the real diff (`git diff master..HEAD`) + the plan section + the test/mutation-probe
  evidence, and instruct: verify every claim against the code, approve ONLY on inspected code (not
  intent/plan-compliance/"should be"), and either give unconditional approval or one concrete blocker.
- Sync calls auto-defer at ~45s. Grants are NOT durable, so poll llm_job_status ONCE every 90s (use
  ScheduleWakeup, don't busy-poll); collect with llm_job_result when status=completed. For codex, the
  raw stdout is a JSONL event stream — read the clean final answer back via llm_request_result with the
  request's correlationId.
- Iterate until unconditional approval from all three or a concrete unresolvable blocker. Fix findings,
  re-run build/lint/test + mutation-probe, re-dispatch to the same reviewers.

DELIVERABLE: Slice 0.5 implemented, all checks green, mutation-probe-audited, cross-LLM-approved, on a
PR. Report the consolidated reviewer verdict with cited evidence. Then stop — do not start Slice 0/1.
```
