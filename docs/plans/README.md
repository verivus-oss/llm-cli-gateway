# docs/plans index

35 `*.dag.toml` implication maps plus supporting drafts, prompts and workflows.

**Read this before treating any DAG as intent.** Only 3 of the 32 pre-existing DAGs have any node
marked `done`, 17 carry no `status` field at all, and a dozen still show nodes as
`planned` whose code shipped months ago. **A `planned` node is not evidence that
something is unimplemented.** Check the code, then this table.

Classification assessed 2026-08-18 at HEAD `801950d` by reading each DAG's named
modules and symbols against `src/`. It is dated evidence, not a live signal.
Re-check before relying on a row.

## Live: read these before changing the surface they map

| DAG | Surface | Notes |
| --- | --- | --- |
| `validation-launch-surface.dag.toml` | Validation provider launch, cursor trust | The only machine-checked DAG (`npm run dag:launch-surface:check`, inside `npm run check`). Real TypeScript AST caller analysis. Caveat: it validates that `affects` is a non-empty string list but never resolves the targets, and `node_count` is pinned in the checker, so the map cannot grow without a checker edit. |
| `gateway-passthrough-policy.dag.toml` | **Governing rule for the provider surface** | The installed binary is the authority; the gateway never refuses what it accepts. Supersedes the removal auto-apply policy, which was deleting capability from customers who changed nothing. Read this before touching any provider contract, schema or validation path. Where another plan disagrees, this one wins. |
| `durable-state-lifecycle.dag.toml` | Retention, finalization, telemetry capture | What is written, what is bounded, what leaks. Read before adding a durable table or status value. Evidence: `docs/evidence/durable-state-2026-08-18.md`. |
| `durable-state-remediation.dag.toml` | The fix program for the above | Five phases, six invariants. P0 ships in 3.1.0. Operator decisions on receipt retention and ACP approval are recorded in its header. |
| `acp-permission-decision.md` | ACP permission gating (exploration, not a DAG) | Why `ApprovalManager` is the wrong instrument for ACP, why path containment cannot be a real control while the gateway never sees the syscall, and what the category gate actually guarantees. |
| `request-pipeline-tier-b-t4-driver.dag.toml` | Tier-B handler envelope | Genuinely unimplemented: no `HandlerEnvelope` or `terminalEnvelope` anywhere in `src/`. |
| `request-pipeline-tier-b-t5a-gemini.dag.toml` | Tier-B gemini slice | Blocked on T4 above. |


## Completed: the code shipped, the DAG was never marked

Treat these as history. They are accurate about design intent and stale about
status.

`cross-llm-validation-receipts` (merged 2026-06-29) ·
`issue-139-orphan-recovery` (instance-lease recovery live) ·
`issue-130-backpressure-followup-fixes` · `http-session-async-backpressure-hardening` ·
`least-cost-routing` (shipped dormant behind `[least_cost].enabled`) ·
`mistral-kit-provider` · `supply-chain-guard` · `cache-awareness` ·
`async-flight-recorder` (26 status fields, 0 `done`) ·
`remote-connector-oauth-workspaces` · `remote-http-oauth-ux-improvements` ·
`local-stdio-remote-http-workspace-gating` · `worktrees-on-postgres-sessions` ·
`provider-owned-sessions` · `provider-subcommands-scope-expansion` ·
`provider-tool-capabilities-full-coverage` · `provider-workflow-assets` ·
`session-manager-postgres-migration` · `session-store-test-isolation`

## Superseded: premise no longer holds

| DAG | Why |
| --- | --- |
| `provider-contract-removal-autoapply.dag.toml` | Its `removal_policy = "auto_apply"` is **withdrawn** by `gateway-passthrough-policy.dag.toml`. It was deleting capability from customers who never touched their CLI. The lock-step analysis, the `hiddenFromHelp` escape hatch and the residual-reference reporting remain accurate; the policy does not. |
| `grok-0.2.33-contract-sync.dag.toml` | Targets grok 0.2.33; live is 1.0.4. Premise entirely superseded. |
| `provider-contract-drift-rc3.dag.toml` | Its rc.3-era version targets were replaced by the rc.8 rebaseline. The decision sections remain useful and are the best statement of the pass-through principle in the repo. |
| `first-class-acp-gateway-extension.dag.toml` | `status = "native_smoke_passed"` overstates: the smoke harness has zero production callers and `smoke_on_startup` is parsed and never read. Several observability and async claims describe events and metrics that do not exist. |
| `full-featured-cli-acp-provider-integrations.dag.toml` | Still `status = "draft"` against a stale feature branch; names four modules that do not exist; its `must_cover_cli_flags` lists were frozen at older CLI versions and can only assert listed flags exist, never that new upstream flags got listed. |
| `cursor-first-class-provider.dag.toml` | Cursor shipped (27 references in `provider-definitions.ts`) yet all 13 nodes are still `planned`, and it names five modules that do not exist. The one genuinely open item is `cursor-parser.ts`: nobody has captured what `cursor-agent --output-format stream-json` actually emits. |
| `acp-provider-transport-research.dag.toml` | Research premise falsified by production: ACP has five requests in the flight recorder ever, four of them failures. |

## Never started

| DAG | Why |
| --- | --- |
| `xstate-store-integration.dag.toml` | Zero xstate packages in `dependencies` or `devDependencies`; both modules it names are absent. Never begun. |
| `outstanding-work-fix.dag.toml` | `release_version = "1.17.2"`, dated 2026-05-31. |
| `hybrid-multi-agent-playbook-evolution.dag.toml` | Untracked host-local artifact that happens to live here. |

## Conventions

- **The DAG comes before the change.** Represent multi-step work here first, then
  execute. Do not narrate completed work into a DAG afterwards.
- **`affects` is traversed transitively.** Before changing a mapped node, follow
  `affects` to the leaves; every node on that path is a place the change must be
  considered.
- **A rule added to one caller is the recurring defect in this repo.** When a gate
  has two callers, delete the second path rather than copying the rule into it.
  `validation-launch-surface.dag.toml` exists because four consecutive review
  rounds each found that same defect one layer further out.
- **Never remove a provider capability to make a test green.** If the rebaseliner
  strips a contract entry and a handler test goes red, restore the entry and mark
  the version boundary. Deleting the request parameter is how three capabilities
  were taken from customers in 3.1.0. See `gateway-passthrough-policy.dag.toml`.
- **Mark nodes `done` when they ship.** The Completed section above is what happens
  otherwise, and it costs every later reader a code check to resolve.
