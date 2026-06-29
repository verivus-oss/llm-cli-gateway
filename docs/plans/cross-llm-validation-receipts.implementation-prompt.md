# Cross-LLM Validation Receipts: implementation kickoff prompt

You are implementing the cross-LLM validation receipts feature for the
llm-cli-gateway MCP server. Work strictly from the code-grounded artifacts in
this repo, not from memory.

## Read first (in order)

1. `docs/plans/cross-llm-validation-receipts.draft.md`: the corrective-program
   spec. Every design decision and every code citation lives here. This is the
   source of truth for WHAT and WHY.
2. `docs/plans/cross-llm-validation-receipts.dag.toml`: the executable plan.
   Each `[[steps]]` block is a unit of work with `depends_on`, an `action`, and a
   `validation` clause. Execute in dependency order. The DAG is the source of
   truth for HOW and IN WHAT ORDER.
3. `CLAUDE.md`: repository conventions (snake_case tool names, Zod validation,
   stderr-only logging, explicit return types, 80% coverage, atomic writes, the
   `node:sqlite` adapter rule).

## Ground rules

- The validation surface is asynchronous fan-out, not synchronous deliberation.
  A run has no answers at kickoff. Do not mint a receipt at kickoff.
- Run identity (`validationId`) is not durable today. Phase 0 makes it durable;
  nothing else can be built until it lands.
- All new SQLite access goes through `src/sqlite-driver.ts`. The release security
  audit hard-fails if `node:sqlite` is referenced anywhere else.
- The job store does NOT use the flight recorder's `_migrations` system. Follow
  the job store's own idempotent `CREATE TABLE IF NOT EXISTS` + `PRAGMA
  table_info` pattern in its constructor.
- Durability gate is config-AND-runtime: `persistence.backend === "sqlite"` AND
  a job store that attached at runtime. Do NOT gate on
  `persistence.asyncJobsEnabled` (it is true for `memory` and `postgres`, which
  are not durable here). The receipt tool/resource and the receipt/run tables are
  absent under non-durable backends, by construction.
- Ownership is own-or-not-found, mirroring `llm_request_result`
  (`resolveOwnerPrincipal` + `principalCanAccess`). A run or job owned by another
  principal returns not-found, never another principal's data.
- v1 ships exactly the fields `validation-report.v1` already produces. No
  `key_points`, `evidence_cited`, `uncertainty_signals`, or numeric per-model
  confidence; there is no extraction source for them. Signing and hash-chaining
  are NOT implemented; the columns are reserved (NULL) and the canonical byte
  definition is fixed now.

## Execution protocol

1. Run `audit-validation-surface` first and write the inventory into
   `docs/plans/cross-llm-validation-receipts.verification.md` under a Phase 0
   baseline heading, including the current changed-file list and the exact
   file:line evidence for each seam. Confirm or correct every spec citation.
2. Implement each step. After each, run its `validation` clause. Add tests under
   `src/__tests__/` following the AAA pattern with complete mocks for isolation.
   Record changed files, implementation notes, and validation results per phase
   in the verification notes.
3. Do not advance a step whose `depends_on` predecessors are not green.
4. At `verification-gate`, run `npm run build && npm test && npm run lint && npm
   run format:check && npm run check` and capture exact commands + results.
5. At `cross-llm-review-gate`, dispatch Codex, Gemini, and Grok per
   `docs/plans/cross-llm-validation-receipts.review-packet.md`. Iterate until
   each gives unconditional approval or a concrete unresolvable blocker. Respond
   to every finding with code/doc evidence, never assertion.

## Definition of done

- All DAG `validation` clauses pass.
- `npm run check` is green; new SQLite access routes only through
  `src/sqlite-driver.ts`.
- A terminal validation run mints exactly one immutable, owner-scoped receipt
  with a deterministic `canonical_sha256`; all `validation_receipt` status
  branches are covered by tests; the §5a `job_status` / `job_result` owner check
  is in place with a regression test.
- Codex, Gemini, and Grok have each given unconditional approval based on
  inspected code, tests, and docs, recorded in the verification notes.
