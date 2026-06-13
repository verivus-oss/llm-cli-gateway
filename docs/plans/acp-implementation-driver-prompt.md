# ACP Gateway Extension — Autonomous Implementation Driver Prompt

Paste the section below ("DRIVER PROMPT") as a single instruction to a fresh Claude
Code session at the repo root (`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`).
It implements the entire `docs/plans/first-class-acp-gateway-extension.dag.toml`
end to end, autonomously, with a hard multi-LLM review gate after every phase.

The prompt is self-contained. It is written to be run unattended: it never asks the
human a question, never pauses for approval, and only stops on a genuinely
unresolvable, documented blocker — or at the correct terminal state
(release-ready, not published).

---

## DRIVER PROMPT

You are the **orchestrator** for implementing the first-class ACP gateway
extension. Your authoritative specification is
`docs/plans/first-class-acp-gateway-extension.dag.toml` (the "DAG"). Read it once
via a subagent, not into your own context. Implement every `[[steps]]` entry in
`depends_on` order, grouped into the phases below, with each phase passing the
Review Gate before the next begins.

### 0. Prime directives (non-negotiable)

1. **Autonomous.** Never call AskUserQuestion. Never pause for human approval.
   Never use EnterPlanMode. Resolve every `[open_questions]` entry yourself using
   the documented default in §7 and record the decision on disk. The only legitimate
   stop conditions are (a) the terminal release-ready state in Phase H, or (b) a
   concrete, inspected, unresolvable blocker that you have written to the blocker
   ledger with evidence.
2. **Lean context.** You hold *state*, not *content*. Do all file reading, editing,
   test-running, and reviewing through subagents that return compact structured
   summaries (≤ ~400 tokens each). Never read a source file, test file, or full diff
   into your own context — delegate it. Persist all durable state to disk (§3) so you
   can reload minimal state instead of carrying it.
3. **Respect the DAG.** The chain is linear: do steps in `depends_on` order. Do not
   skip validation. Do not start a step whose predecessor's Review Gate has not
   returned unconditional approval.
4. **Preserve existing behavior.** `default_transport = "cli"`. ACP stays disabled by
   default. No request-tool schema change may break the existing CLI path. Every
   `[security_invariants]` entry holds.
5. **Release discipline.** Implementation lands on a feature branch via PR — never an
   admin bypass, never a direct push to master, never an auto-publish to npm. Phase H
   ends at *release-ready* (green CI, PR open, ACP off by default). Publishing is a
   separate human-dispatched step and is OUT OF SCOPE for this run.
6. **No attribution trailer.** Match repo commit style. Do not add a
   `Co-Authored-By: Claude` trailer.

### 1. Agent roster (subagents you spawn)

Spawn these as `Agent` subagents. Keep yourself (orchestrator) thin.

- **context-steward** (one long-lived background agent): owns the on-disk state
  ledger (§3). You send it deltas ("Phase B step build-json-rpc-stdio-transport:
  status=review, commit=<sha>"); it writes/updates `docs/acp/state/ledger.json` and
  `docs/acp/state/progress.md` and returns a one-line ack. Whenever you need to
  recover state, ask it for a compact summary instead of re-reading files yourself.
- **implementer** (one per step, isolation: worktree when steps could touch files in
  parallel; otherwise plain): writes the code and tests for exactly one DAG step,
  runs local gates, and returns a structured result (files changed, test names added,
  gate output digests). Give it the single `[[steps]]` block verbatim.
- **verifier** (one per step): independently runs the step's `validation` clause and
  the relevant `[test_matrix]` rows, plus a mutation-probe audit (§5), and writes the
  step's **verification report** (the corrective-program spec) to
  `docs/acp/verification/<step-id>.md`. Returns the report path + pass/fail digest.
- **reviewer-panel** (the gate; §4): the external LLMs, run via the `gtwy` MCP async
  request tools. Not Claude subagents — these are Codex/Gemini/Grok/Mistral/Claude
  reached through `mcp__gtwy__*_request_async`.

### 2. Parallelisation policy (as much as the DAG allows)

The DAG is a linear `depends_on` chain, so cross-step parallelism is constrained.
Parallelise only where there is no declared dependency and no shared-file hazard:

- **Within a step:** author independent test files concurrently; run `build`, `lint`,
  and `upstream:contracts` digests concurrently once code compiles.
- **The Review Gate is the main parallel surface:** fan out all reviewers at once
  (one async job per reviewer), then poll. Never serialise reviewers.
- **Foundation fast-path (optional, only if zero file overlap):** steps
  `add-acp-config-schema`, `extend-provider-capability-metadata`,
  `track-acp-upstream-contracts`, and `define-acp-provider-registry-and-errors` touch
  largely disjoint files. You MAY implement them in parallel worktree implementers,
  but you MUST still integrate and review them in DAG order, and if any two produce a
  merge conflict, fall back to strict sequential. Do not fast-path anything past
  `build-json-rpc-stdio-transport`.
- Everything from `build-json-rpc-stdio-transport` onward is strictly sequential.

### 3. On-disk state (so context stays lean and the run is resumable)

The context-steward maintains:

- `docs/acp/state/ledger.json` — array of `{ phase, stepId, status, commit,
  reportPath, reviewRound, verdicts: {codex, gemini, grok, mistral, claude},
  blockers: [] }`. `status` ∈ `pending|implementing|self-verified|in-review|
  approved|blocked`.
- `docs/acp/state/progress.md` — human-readable mirror, one line per step.
- `docs/acp/state/blockers.md` — append-only; each entry has stepId, the inspected
  evidence (file:line, test name, command output), why it is unresolvable, and what
  would unblock it.
- `docs/acp/verification/<step-id>.md` — the verification report per step (§4.1).
- `docs/acp/review/<step-id>-round-<n>.md` — the evidence packet sent to reviewers and
  each reviewer's returned verdict, per round.

On (re)start, ask context-steward for the ledger summary and resume at the first
non-`approved` step.

### 4. The Review Gate (runs at the end of every phase — the heart of this prompt)

A phase passes only when the reviewer panel returns **unconditional approval**, based
on inspected code/tests/docs, for the phase's cumulative diff. Procedure:

#### 4.1 Build the evidence packet (you, via verifier)

Before invoking any reviewer, the verifier produces, on disk:

- **The verification report** `docs/acp/verification/<phase>.md` — the
  corrective-program spec. For every claim ("config rejects shell-style entrypoints",
  "CLI path unchanged", "no raw JSON-RPC reaches the flight recorder"), it cites the
  exact `file:line`, the exact test name proving it, and the command output digest.
  Claims without code/test citations are not allowed in the report.
- **The exact change set**: the commit SHA(s) for the phase, the `git diff` range
  (`<base>..<head>`), and the explicit changed-file list.
- The local-gate results: `npm run build`, `npm run lint`, `npm test` (relevant
  suites), `npm run upstream:contracts`, `git diff --check`.

#### 4.2 Fan out reviewers (parallel, full access, async)

Invoke ALL of the following in one batch via `mcp__gtwy__*_request_async`. Each gets
the SAME prompt body (§4.3) plus its lens. Grant each reviewer **full read +
verification + MCP tool access** so it can independently open files, run tests/builds,
and use MCP introspection — i.e. set the gateway request to its most permissive
non-interactive mode (e.g. `alwaysApprove: true`, a non-interactive `permissionMode`,
broad `allowedTools`, and pass `mcpServers` so the reviewer can reach `gtwy`/`sqry`/
`ref` tools). Working directory = repo root (or the phase worktree).

Reviewer panel and lenses (from DAG step `validate-with-multi-llm-review`):

- **Codex** (`codex_request_async`) — codebase integration + test adequacy.
  **Read-only**: do not grant repo write/commit.
- **Gemini** (`gemini_request_async`) — provider status + agy watchlist wording +
  resource/redaction correctness.
- **Grok** (`grok_request_async`) — native ACP runtime + failure-mode + fail-closed
  behavior.
- **Mistral** (`mistral_request_async`) — vibe-acp runtime + agent-facing docs.
- **Claude** (`claude_request_async`) — safety, HostServices, permission-bridge
  review. **SAFETY GUARDRAIL: no repo write/commit/release authority.** A same-repo
  Claude reviewer with write access can self-commit/release via session bleed. Give it
  full read + verify + MCP access only. (This is the one place "full access" is
  bounded; it bounds *write*, not *verification depth*.)

For phases that add no surface a given lens can review (e.g. early transport phases
have no docs), you may omit that lens for that phase, but Codex + Grok must review
every phase, and Claude must review every phase that touches HostServices,
permissions, redaction, or session ownership.

#### 4.3 Reviewer instructions (embed verbatim in every reviewer prompt)

> You are an adversarial release reviewer for the llm-cli-gateway ACP extension.
> Attached are: (1) a verification report at `<path>`, and (2) the exact change set:
> commit `<sha>`, diff range `<base>..<head>`, changed files `<list>`.
>
> The verification report is a CLAIM, not evidence. Do not approve based on it. Open
> each cited file yourself, read the actual code and docs, and run the cited tests and
> `npm run build` / `npm test` / `npm run upstream:contracts` yourself. Confirm or
> refute each claim against the real code, tests, and docs.
>
> Approval criteria — you may return APPROVED only if ALL hold, each backed by
> something you personally inspected or executed:
>   - every claim in the report is verified against actual code/tests/docs;
>   - the relevant DAG `validation` clause and `[test_matrix]` rows are satisfied by
>     real, non-vacuous tests (tests fail if the behavior is broken);
>   - the existing CLI transport path is unchanged;
>   - every applicable `[security_invariants]` entry holds in code (no raw ACP
>     JSON-RPC / prompt text / file contents / credential paths reaching logs, flight
>     recorder, doctor, or resources; no shell eval for entrypoints; deny-by-default
>     HostServices; ApprovalManager-mediated permissions);
>   - no `console.log`/stdout writes from gateway code; stdout reserved for MCP.
>
> Do NOT approve based on intent, plan-compliance, "looks correct", or "should be
> fixed later". If something is wrong, return CHANGES-REQUIRED with: the file:line,
> what is wrong, and the inspected evidence. If you find a defect that cannot be fixed
> within this slice's scope, return BLOCKER with evidence. Return strict structured
> output: `{ verdict: APPROVED|CHANGES_REQUIRED|BLOCKER, findings: [{file, line,
> claim, evidence, severity}], inspected: [files/tests/commands you actually ran] }`.

#### 4.4 Poll, don't block

Because reviewer permission grants are not durable across the run, the gateway will
defer long reviews to async jobs. Poll each job with `mcp__gtwy__llm_job_status` **no
more often than once every 90 seconds**; pull results with `mcp__gtwy__llm_job_result`
only when a job reports done. While polling, do nothing else that advances the DAG for
this phase. Record every returned verdict to `docs/acp/review/<phase>-round-<n>.md`.

#### 4.5 Iterate to unconditional approval

- If any reviewer returns CHANGES_REQUIRED: triage each finding.
  - If the finding is correct → spawn an implementer to fix it, re-run local gates,
    regenerate the verification report, bump the commit, and start a **new review
    round** (re-fan-out, fresh diff range). Do not argue a correct finding.
  - If you believe the finding is wrong → you must **rebut with code/doc evidence**:
    reply to that reviewer (continue its session via the gateway) citing the exact
    `file:line`, test name, or doc passage that refutes it. Never rebut with
    assertion, intent, or "that's by design" without the citation. Record the rebuttal
    and the reviewer's response. The reviewer must either withdraw the finding citing
    your evidence, or escalate with counter-evidence.
- Repeat rounds until **every** reviewer returns APPROVED unconditionally, OR a
  reviewer returns a BLOCKER that, after evidence-based rebuttal, remains a concrete
  unresolvable defect. A BLOCKER is logged to `blockers.md` with full evidence; you do
  not silently proceed past it.
- "Approved with nits" is not approval. Fix the nits and re-review.

#### 4.6 Mutation-probe (test-veracity) audit — every phase that adds tests

Before declaring a phase approved, run a mutation-probe audit on the phase's new
tests: spawn a verifier to introduce, in a throwaway worktree, a targeted mutation to
each key code path the tests claim to cover (e.g. make HostServices allow writes by
default; let a raw JSON-RPC body reach the flight recorder; drop the fail-closed
branch). Confirm the corresponding test FAILS. Any mutation that leaves all tests
green = a vacuous test = a CHANGES_REQUIRED you raise on yourself; fix the test and
re-review. Discard the mutation worktree. Record probe results in the verification
report. (This satisfies the standing strict-evidence test-veracity protocol.)

### 5. Per-step execution loop (inside a phase)

For each step, in DAG order:
1. Ask context-steward for current ledger; mark step `implementing`.
2. Spawn implementer with the verbatim `[[steps]]` block. It writes code + tests,
   runs `npm run build` + relevant `npm test`, and returns a compact digest.
3. Spawn verifier: run the step `validation` clause + `[test_matrix]` rows; if green,
   mark `self-verified`. If red, loop back to implementer with the failure digest.
4. Commit the step on the feature branch with a precise message; record the SHA.
5. When the phase's last step is `self-verified`, build the evidence packet (§4.1) and
   enter the Review Gate (§4).

### 6. Phase plan (review gate after each)

Group the DAG's steps into these phases. Each ends with a full Review Gate. Map to the
DAG's `[rollout]` and `[host_services.phases]` where noted.

- **Phase A — Contract & capability surface (rollout phase_0, part 1):**
  `freeze-contract-and-non-goals`, `add-acp-config-schema`,
  `extend-provider-capability-metadata`, `track-acp-upstream-contracts`,
  `define-acp-provider-registry-and-errors`. No runtime. (Foundation fast-path allowed
  per §2.)
- **Phase B — ACP transport core:** `build-json-rpc-stdio-transport`,
  `define-acp-protocol-types`, `implement-acp-client-core`, `add-acp-process-manager`.
  Strictly sequential.
- **Phase C — Read-only smoke + HostServices deny-by-default (completes rollout
  phase_0):** `add-read-only-smoke-harness`, `define-host-services-boundary`
  (host_services phase-0-read-only-smoke). Claude lens required.
- **Phase D — Permission bridge, sessions, normalization, redaction:**
  `implement-permission-bridge`, `implement-session-map`, `normalize-session-updates`,
  `define-acp-flight-recorder-redaction`. Claude lens required; redaction
  mutation-probe is mandatory.
- **Phase E — Mistral runtime pilot (rollout phase_1):** `pilot-mistral-acp-runtime`.
  Must prove CLI path unchanged + fail-closed when ACP disabled.
- **Phase F — Grok runtime pilot (rollout phase_2):** `pilot-grok-acp-runtime`.
  Isolated leader socket; no empty-env credential assumptions.
- **Phase G — Async, resources/doctor, agent docs (rollout phase_3):**
  `integrate-async-jobs`, `integrate-resources-and-doctor`, `add-agent-facing-docs`.
  Mistral + Gemini lenses required for docs/resources/agy wording.
- **Phase H — Validation + release readiness:** `validate-with-multi-llm-review`
  (this is the DAG's own full-panel review — run it as the Phase H gate),
  `release-gate-and-publish-readiness`. Terminal state: all local gates green
  (`build`, `lint`, `test`, `upstream:contracts`), optional live smoke on installed
  `vibe-acp` / `grok agent stdio` when present, feature branch pushed, PR opened, CI
  green, `docs/upstream/release-targets.md` updated with version+SHA, ACP disabled by
  default. **Do not publish.** Stop here and report.

### 7. Default resolutions for `[open_questions]` (so you never have to ask)

- `provider_process_reuse`: per gateway-session, with idle-timeout reaping; pooled
  reuse deferred. Document the choice.
- `host_filesystem_contract`: implement only the ACP filesystem methods the Phase C/E
  mock + installed smoke actually exercise; gate the rest behind later host_services
  phases.
- `permission_granularity`: map to existing ApprovalManager request types if a clean
  mapping exists; if not, add one new approval kind and note it. Do not weaken the
  gate to force a fit.
- `streaming_shape`: sync responses accumulate final text; async jobs receive
  per-update log entries (per `normalize-session-updates`).
- `adapter_install_story`: leave Claude/Codex adapters user-installed and deferred;
  documentation only.
- `default_transport_future`: out of scope — remains `cli`; explicitly deferred to
  rollout phase_4 / a new plan.

Record each resolution in `docs/acp/state/decisions.md`.

### 8. Blocker handling

A blocker is a defect you have inspected, attempted to fix, and shown (with evidence)
cannot be resolved within this slice — or a reviewer BLOCKER that survives
evidence-based rebuttal. On a blocker: write it to `blockers.md` with full evidence,
mark the step `blocked`, and continue with any remaining work that does not depend on
the blocked step. If the blocked step is on the critical path (it usually is, given
the linear chain), stop after recording, and produce the final report describing
exactly what is blocked and what would unblock it. Do not fabricate approval. Do not
ask the human mid-run.

### 9. Final report (when Phase H reaches terminal state, or on a critical blocker)

Emit a concise summary: phases completed and approved (with reviewer verdict
references and round counts), the feature branch + PR link, CI status, the full
verification-report and review-log paths, all `[open_questions]` resolutions, any
blockers with evidence, and explicit confirmation that ACP is disabled by default and
nothing was published. Then stop.

---

## Notes for the human (not part of the prompt)

- **Reviewer write-access guardrail:** the prompt grants reviewers full read + verify
  + MCP access but withholds *write/commit/release* from the `claude_request` reviewer
  specifically, per the standing `claude_request reviewer write-access hazard`. If you
  want to override that, edit §4.2/§4.3.
- **No auto-publish:** per release-process discipline, the prompt stops at
  release-ready (PR + green CI). Publishing remains a manual `npm-publish.yml`
  dispatch by a human.
- **Linear DAG:** because every step `depends_on` its predecessor, the run is mostly
  sequential; the parallel wins are the reviewer fan-out and the optional Phase A
  foundation fast-path. Do not expect large wall-clock savings from step-level
  parallelism — there isn't any to extract without violating the DAG.
- To run it as a deterministic harness instead of a single agent loop, the phase/step
  structure maps cleanly onto a `Workflow` pipeline (one stage per step, a
  parallel reviewer barrier per phase). Ask for that variant if you want it.
