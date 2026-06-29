# Cross-LLM Validation Receipts (corrected spec, draft)

Status: draft, 2026-06-29. Supersedes the "Structured Deliberation Receipts"
proposal. Renamed and re-anchored after a code-grounded review (Claude) plus an
adversarial cross-LLM review gate (Codex gpt-5.4, Grok, Mistral) that verified
every claim against the source.

## 0. Why this rewrite exists

The original spec was written against a mental model the gateway does not
implement. The three load-bearing mismatches, each verified in code:

1. The "deliberative" tools are asynchronous fan-out, not synchronous
   deliberations. `consensus_check` and siblings call `startValidationRun` and
   return immediately with provider jobs still `running`; no answers exist at
   call time (`src/validation-tools.ts:206-258`,
   `src/validation-orchestrator.ts:140-188`,
   `src/validation-normalizer.ts:38-60`). Auto-generating a receipt at kickoff
   captures nothing.
2. There is no single `correlation_id` for a run. Each provider job has its own
   `correlationId` (`validation-${validationId}-${provider}`,
   `src/validation-orchestrator.ts` provider dispatch; per-result ids in
   `src/validation-report.ts:62-73`); the run is keyed by a separate
   `validationId = randomUUID()` (`src/validation-orchestrator.ts:144`).
3. `validationId` is not durably stored anywhere today. It lives only in the
   transient report returned at kickoff. Neither the job store
   (`src/job-store.ts:243-299`, keyed by job id / correlation id) nor the
   flight recorder (keyed by correlation id) persists a `validation_id`.
   "Fetch a receipt later by id" is therefore unbuildable until run identity is
   made durable. This is the foundational prerequisite and is addressed first.

Two more facts shape the design:

4. Models never see each other's output. Every reviewer prompt says "You are one
   independent reviewer ... Do not claim consensus" (`src/validation-prompts.ts:21-23`).
   There is no deliberation, only independent review plus an optional judge
   synthesis. The artifact is named accordingly: a validation receipt.
5. A structured, versioned artifact already exists: `validation-report.v1`
   (`src/validation-report.ts:26-102`) with `perModelOutputs`, `disagreements`,
   `finalRecommendation`, `confidence` (a bucket: none/low/medium/high),
   `limitations`, `jobIds`, and `humanReadable`. The receipt envelopes this; it
   does not reinvent it.

## 1. Goal and non-goals

Goal: persist and later retrieve an immutable, owner-scoped receipt of a
completed cross-LLM validation run, keyed by `validationId`, enveloping the
existing `validation-report.v1` artifact, so the run can be audited and so the
receipt can later become a signed, hash-chained record.

Non-goals (v1):
- Cryptographic signing and hash-chaining. We define the canonical serialization
  and reserve the linkage columns now (see 6 and 7), but do not implement
  signatures or chain verification.
- Semantic enrichment: per-model `key_points`, `evidence_cited`,
  `uncertainty_signals`, numeric per-model confidence. None of these have a data
  source today (`src/validation-normalizer.ts:78-120` extracts only verdict,
  truncated rationale, regex risks). Deferred to a separate enrichment slice
  with an explicit, owned extraction design (see 9).
- Quorum / policy evaluation.

## 2. Foundational prerequisite: durable validation-run identity

This is new work the original spec omitted and the gate flagged as blocking.

At kickoff, `startValidationRun` (`src/validation-orchestrator.ts:140-188`)
persists a run record before returning. This is the durable mapping from
`validationId` to the provider jobs that carry the actual outputs.

`validation_runs` (written once at kickoff, status mutable to terminal):
```
validation_id     TEXT PRIMARY KEY
owner_principal   TEXT NOT NULL        -- resolveOwnerPrincipal(getRequestContext())
intent            TEXT NOT NULL        -- validate | consensus | red_team | second_opinion | ask_model
created_at        TEXT NOT NULL        -- app-side ISO string
request_json      TEXT NOT NULL        -- question/content/focus/riskLevel/modelList/judge plan (owner-scoped)
provider_links    TEXT NOT NULL        -- JSON: [{provider, jobId, correlationId}]
judge_link        TEXT                 -- JSON {provider, jobId, correlationId} | NULL
status            TEXT NOT NULL        -- running | finalized
```

`synthesize_validation` is threaded with the optional `validationId` it lacks
today (`src/validation-tools.ts:263-269`) so the judge job can be linked back to
its run and recorded in `judge_link`.

Persistence home: the run/receipt tables live in the persistence backend that
already owns async jobs (`src/job-store.ts`), not the flight recorder.
Rationale: the provider outputs the receipt envelopes are retrieved from the job
store by `jobId`, and validation runs already depend on the async job manager.

Durability gate (corrected): do NOT gate on `persistence.asyncJobsEnabled`. That
flag is true for `memory` and `postgres` as well as `sqlite`
(`src/config.ts:327`), but `memory` is process-lifetime only
(`src/config.ts:95`, `src/job-store.ts:517`) and `PostgresJobStore` is an
unimplemented stub that throws (`src/job-store.ts:654`, `src/index.ts:458`). A
receipt that cannot outlive the process, or a store that throws, defeats the
feature. Gate the run/receipt tables and the `validation_receipt` tool
registration on an actually-durable, implemented backend, which today means
`persistence.backend === "sqlite"`. When a real Postgres store lands, extend the
gate to it. For `memory`, `postgres`, and `none`, the tables are not created and
the tool is not registered. The gate is config-AND-runtime, not config alone:
`createJobStore` can fail and `getJobStore` collapses that to `null`
(`src/index.ts:462`), after which async tools are not registered
(`src/index.ts:7055`). The receipt tool and tables follow the same rule: a
durable implemented backend AND a store that actually attached at runtime. The
tool's absence makes silent loss impossible by construction, the same invariant
the job store already follows for `*_request_async`.

Note on scope: `validationId` is still returned in every kickoff response
regardless of backend (the validation start / `job_*` tools are registered
unconditionally today, `src/index.ts:7063`). Only the DURABLE artifacts gate on
sqlite + attached store: under `memory` / `postgres` / `none` no
`validation_runs` row is written and `validation_receipt` is not registered. So
callers always get an id, but a persisted, retrievable receipt exists only under
the durable gate.

## 3. Lifecycle and mint point (resolves the idempotency conflict)

The original "if a receipt exists, return it (idempotent)" collided with a run
that evolves running -> partial -> collected -> synthesized
(`src/validation-orchestrator.ts:176-253`, `src/validation-report.ts:139-166`).
Fixed by a single defined mint point and immutability:

- A receipt is minted only when the run is terminal: every provider job is in a
  terminal state (completed | failed | canceled | orphaned | skipped) and, if a
  judge was requested, the judge job is terminal.
- Minting builds the report from the collected terminal results (reusing
  `buildValidationReport`), captures its `structuredContent`, computes the
  canonical hash (see 6), and writes one immutable `validation_receipts` row.
  Prerequisite (Phase 0): `validation-report.v1` cannot represent a terminal run
  today. Its `status` enum is only `running | partial | not_started`
  (`src/validation-report.ts:8,19`) and `buildValidationReport` derives status as
  `not_started | partial | running` only, never a completed state
  (`src/validation-orchestrator.ts:159-160`); the synthesis status enum is
  likewise `not_requested | waiting_for_provider_results | running | skipped`
  (`src/validation-orchestrator.ts:131`). Extend the report status (and synthesis
  status) with terminal values (e.g. `completed`) and teach
  `buildValidationReport` to emit them when all jobs are terminal. The receipt
  captures that terminal report. Decide whether this is a backward-compatible
  additive bump to `validation-report.v1` or a new `validation-report.v2`; the
  receipt's `schema_version` records which.
- Once minted, the receipt is immutable. Re-requesting returns the stored row
  byte-for-byte. There is no UPDATE path.
- Requesting a receipt for a run that is not yet terminal returns a `pending`
  status object reflecting current run state, explicitly NOT a frozen receipt.

Eager minting to beat job eviction (corrected): minting must not be purely
mint-on-read. Completed job rows are evicted after the retention window
(`src/job-store.ts:404,492`), so a `validation_runs` row can outlive the job
outputs needed to mint its first receipt, making the first mint silently
impossible. To prevent this, the gateway mints eagerly the first time it
observes the run reach a terminal state, which it already passes through during
result collection (`job_result`) and `synthesize_validation`. The mint reads the
linked job outputs while they are guaranteed to still exist and writes the
immutable receipt. Mint-on-read via the `validation_receipt` tool remains only
as a fallback for runs that became terminal before this logic existed; if the
linked jobs have already been evicted and no receipt was minted, the tool
returns an explicit `expired_unminted` status rather than a partial or empty
receipt. Implementation must guard the first-terminal mint against races
(INSERT-or-ignore on the `validation_id` PK).

So "idempotent" now holds precisely because it only applies to terminal,
immutable receipts.

## 4. New tool: `validation_receipt`

```ts
interface ValidationReceiptParams {
  validationId: string;            // required; the run-level id, not a correlationId
  format?: "json" | "markdown";    // default json; markdown derived on read, not stored
  includeRawResponses?: boolean;   // default false; gates inclusion of full provider answer text
}
type ValidationReceiptResult =
  // rawResponses present only when includeRawResponses=true AND the linked jobs still exist;
  // it is a read-time expansion, never persisted in the receipt, never hashed (see 6).
  | { status: "minted"; validationId: string; receipt: ValidationReceipt; mintedAt: string; rawResponses?: Array<{ provider: string; jobId: string; text: string }> }
  | { status: "pending"; validationId: string; run: ValidationRunState }    // not yet terminal
  | { status: "expired_unminted"; validationId: string }                    // terminal but jobs evicted before any mint
  | { status: "not_found"; validationId: string };                          // unknown OR not owned
```

Behavior:
- Resolve the caller principal and apply own-or-not-found: a run owned by another
  principal returns `not_found`, never another principal's data. This mirrors
  `llm_request_result` (`src/index.ts:10976-11003`,
  `principalCanAccess`/`resolveOwnerPrincipal` in `src/request-context.ts`).
- If a receipt row exists: return it (`minted`).
- Else if the run is terminal: mint, store, return (`minted`).
- Else if the run exists but is not terminal: return `pending` with current state.
- Else: `not_found`.
- `includeRawResponses` gates whether full provider answer text is inlined. This
  is a READ-TIME expansion only: raw text is pulled live from the linked job
  results per `jobId` under the same owner check, and is returned in a separate
  `rawResponses` field on the result, NOT inside `report`. It is therefore NOT
  part of `report_json` and NOT covered by `canonical_sha256` (see 6). This keeps
  the hashed receipt immutable and matches the existing design, where raw outputs
  live behind `job_result` references rather than inside the report
  (`src/validation-report.ts:163`). If the linked jobs have been evicted, the
  expansion is simply absent; the minted receipt is unaffected.

## 5. Enhancements to existing validation tools

- `startValidationRun` persists the `validation_runs` record at kickoff (2).
- `synthesize_validation` accepts an optional `validationId`, links the judge job
  into the run, and when invoked with all providers terminal may auto-mint the
  receipt (a convenience over calling `validation_receipt` explicitly).
- No `generateReceipt` flag at kickoff. The original idea of auto-generating a
  receipt on the deliberative-tool response is dropped because no outputs exist
  at that point (0.1).
- `compare_answers` is excluded entirely: it is local-only, makes no provider
  calls, and returns `status: "local_summary_only"`
  (`src/validation-tools.ts:145-171`). Nothing to receipt.

### 5a. Prerequisite security fix (surfaced by the gate)

The validation collection tools `job_status` / `job_result`
(`src/validation-tools.ts:328-372`) call `getJobSnapshot` / `getJobResult`
without the `principalCanAccess` check that the `llm_job_*` paths enforce
(`src/index.ts` job paths). This is a pre-existing cross-principal hole on the
exact surface a receipt feature reads from. Fix it as part of this work, or make
`validation_receipt` the only sanctioned read surface for completed validation
data. Either way the receipt path must apply the owner check on every linked job
it reads.

## 6. Receipt schema and canonical hash

`validation_receipts` (immutable, one row per terminal run):
```
validation_id            TEXT PRIMARY KEY REFERENCES validation_runs(validation_id)
owner_principal          TEXT NOT NULL
minted_at                TEXT NOT NULL     -- app-side ISO string
schema_version           TEXT NOT NULL     -- 'validation-receipt.v1'
report_json              TEXT NOT NULL     -- captured validation-report.v1 structuredContent (see below), immutable
canonical_sha256         TEXT NOT NULL     -- digest over the canonical serialization of report_json
prev_sha256              TEXT              -- reserved for chaining; NULL in v1
seq                      INTEGER           -- reserved for chaining; NULL in v1
signature                TEXT              -- reserved for signing; NULL in v1
models                   TEXT NOT NULL     -- denormalized JSON array for querying
has_material_disagreement INTEGER NOT NULL -- denormalized 0/1 from disagreements.hasMaterialDisagreement
confidence               TEXT NOT NULL     -- denormalized bucket: none|low|medium|high
```

What `report_json` stores (corrected for consistency): exactly the
`structuredContent` object of `validation-report.v1`, not the full
`ValidationReport` wrapper. In code `ValidationReport` is
`{ schemaVersion, humanReadable, structuredContent }` (`src/validation-report.ts:26,98`);
`humanReadable` is derived from `structuredContent` by `renderHumanReport` and is
re-derived on read (see 5, markdown not stored), so only the machine-readable
`structuredContent` is persisted. `validation-report.v1`'s `structuredContent`
has no "disagreement bucket": it carries `disagreements`
`{ hasMaterialDisagreement, summary, signals }` and a separate `confidence`
bucket `none|low|medium|high` (`src/validation-report.ts:48,54`). The two
denormalized columns above reflect that exactly.

The receipt envelope returned to callers:
```ts
// alias for validation-report.v1's structuredContent object (src/validation-report.ts:82-96)
type ValidationReportV1Content = ValidationReport["structuredContent"];

interface ValidationReceipt {
  schemaVersion: "validation-receipt.v1";
  validationId: string;
  ownerPrincipal: string;
  mintedAt: string;
  intent: string;
  models: string[];
  report: ValidationReportV1Content; // the persisted structuredContent verbatim
  humanReadable: string;             // re-derived via renderHumanReport, not stored
  canonicalSha256: string;
  // reserved, null in v1:
  prevSha256?: string | null;
  seq?: number | null;
  signature?: string | null;
}
```

Canonical serialization (defined now, because it is the hard part and chaining
later depends on it): the SHA-256 covers exactly the persisted `report_json`,
i.e. the `structuredContent` object, serialized with sorted object keys, no
insignificant whitespace, UTF-8, and a fixed field order for arrays as they
appear in `validation-report.v1`. The re-derived `humanReadable` is NOT part of
the hash input (it is a derived rendering). `canonical_sha256` is the SHA-256 of
those bytes. This gives per-row tamper detection in v1 without any signing, and
fixes the byte definition that a future hash chain (`prev_sha256` + monotonic
`seq`) and signature will build on. This is the honest version of the original
`receipt_hash?` placeholder, which on a mutable, idempotently-rewritten row was
not preparation for anything (`docs/agent-assurance-runtime-conformance.md:46-89,122-131`).

What v1 does NOT add: `key_points`, `evidence_cited`, `uncertainty_signals`,
numeric per-model confidence, `has_evidence_citations`. All require extraction
that does not exist (0, 9). The receipt carries exactly the fields
`validation-report.v1` already produces.

## 7. Migration

Create the tables in the job-store DB, which is the home per 2. Note the
job store does NOT use the flight recorder's `_migrations` system: it creates and
evolves its schema with idempotent `CREATE TABLE IF NOT EXISTS` + `PRAGMA
table_info` driven `ALTER TABLE` in its constructor (`src/job-store.ts:243`),
whereas the versioned `_migrations` table lives in the flight recorder
(`src/flight-recorder.ts:279-370`). Follow the job store's own pattern: add the
`validation_runs` and `validation_receipts` `CREATE TABLE IF NOT EXISTS`
statements to the `SqliteJobStore` schema setup, use app-side ISO timestamps via
`new Date().toISOString()`, and add an index on `owner_principal` plus the PK. Do
not hand-roll a bare `CREATE TABLE` with `DEFAULT CURRENT_TIMESTAMP` and
`AUTOINCREMENT` as the original spec did.

## 8. MCP resource (later phase)

`validation-receipt://{validationId}` exposed through `src/resources.ts`
(which today serves sessions/models/metrics only). Same own-or-not-found owner
scoping as the tool. Returns the receipt for a terminal run, or a not-found for
an unknown/unowned/not-yet-terminal id.

## 9. Deferred: semantic enrichment slice

A later slice may add `key_points`, `evidence_cited`, `uncertainty_signals`, and
a per-model confidence signal. This requires choosing, with eyes open, between:
- regex/heuristic extraction over free text (brittle; will silently emit empty
  arrays), or
- a dedicated LLM extraction pass (cost + latency, and it can fabricate a
  citation a reviewer never made, which is corrosive for an attribution
  artifact).

Whichever is chosen must be specified, tested for the empty/garbage case, and
versioned as `validation-receipt.v2`. It is out of scope here.

## 10. Phases

- Phase 0 (prerequisite, all required before any receipt can be minted):
  - extend the report status and synthesis-status enums with terminal values and
    teach `buildValidationReport` to emit them when all jobs are terminal (3);
    today neither can represent a finished run (`src/validation-report.ts:8,19`,
    `src/validation-orchestrator.ts:159-160`). A receipt cannot be minted until
    this lands, because there is no terminal report to capture.
  - durable `validation_runs` record at kickoff (2);
  - thread `validationId` through `synthesize_validation` (5);
  - add the `job_*` owner check (5a).
- Phase 1: `validation_receipts` table + migration; mint-at-terminal logic;
  `validation_receipt` tool with owner scoping; canonical hash. JSON only.
- Phase 2: markdown rendering on read (derived, not stored); auto-mint on
  `synthesize_validation`.
- Phase 3: `validation-receipt://` MCP resource.
- Phase 4+: enrichment (9); then, if pursued, chaining and signing using the
  reserved `prev_sha256` / `seq` / `signature` columns and the canonical bytes
  defined in 6.

## 11. Open questions

- Should a run record be persisted even when async jobs are enabled but the
  flight recorder is off? (Outputs come from the job store, so yes; confirm
  during implementation.)
- Retention (resolved): receipts are minted eagerly at first terminal observation
  (see 3), so they do NOT depend on job rows surviving. Once minted, a receipt is
  durable and retained independently of the job retention window: receipts
  outlive the jobs they were built from. The `validation_runs` row may be garbage
  collected after its receipt is minted. Job rows keep their existing retention
  (`src/job-store.ts:404,492`); receipts get their own (default: retained
  indefinitely until an explicit receipt-retention policy is set).
- Do we expose a `validation_runs` listing tool, or is lookup by `validationId`
  (returned at kickoff) sufficient for v1? Default: lookup only.
