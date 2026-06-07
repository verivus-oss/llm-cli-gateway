# Test-veracity mutation-probe audit - 2.3.0 release gate

Scope: the rewritten annotation invariant in
`src/__tests__/mcp-surface-usability.test.ts`, covering the 2.3.0 MCP tool
annotation slice. The test now verifies annotation presence and title length
for every registered tool, rejects read-only plus destructive contradictions,
pins the exact 37-tool count, and pins exact read-only, open-world, and
destructive tool sets.

Baseline (clean tree at `b1a1e3c`, 2026-06-08):

- `npx vitest run src/__tests__/mcp-surface-usability.test.ts`: 5/5 pass.
- `npm run upstream:contracts`: contracts-check OK for 5 providers.

Protocol: each probe used a fresh detached worktree at `b1a1e3c`, linked to
the root `node_modules`, asserted the mutation target text was actually
changed, then ran
`./node_modules/.bin/vitest run src/__tests__/mcp-surface-usability.test.ts`.
A probe kills when the focused test fails under the mutation.

## Probes

| # | Mutation | Assertion killed | Result |
|---|----------|------------------|--------|
| P1 | Blank `llm_process_health` annotation title (`"Gateway process health"` -> `""`) | per-tool display title length | KILL |
| P2 | Mark `session_get` both read-only and destructive | readOnly+destructive contradiction ban | KILL |
| P3 | Mark `session_create` as read-only | exact read-only tool set | KILL |
| P4 | Remove `openWorldHint` from `cli_upgrade` | exact open-world tool set | KILL |
| P5 | Remove `destructiveHint` from `llm_job_cancel` | exact destructive tool set | KILL |
| P6 | Add temporary `dummy_probe` tool registration | exact 37-tool count | KILL |

Observed focused failures:

- P1: `llm_process_health has a display title: expected 0 to be greater than 2`.
- P2: `session_get readOnly+destructive contradiction: expected true to be false`.
- P3: read-only set gained one unexpected member.
- P4: open-world set lost one expected member.
- P5: destructive set lost one expected member.
- P6: `expected 38 to be 37`.

Runner integrity note: an initial discarded batch failed before test execution
because detached worktrees did not have `node_modules`, then a second discarded
batch exposed a runner bug that edited the first worktree for every probe. No
startup failure or unmutated-worktree result was counted. The final batch above
used per-probe file paths and produced six real focused test failures.

Verdict: 6/6 probes kill; the rewritten invariant is non-tautological across
the shape checks, contradiction guard, exact membership sets, and exact tool
count.
