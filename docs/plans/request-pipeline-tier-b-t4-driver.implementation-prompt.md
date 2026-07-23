# T4 terminal-envelope driver: end-to-end implementation orchestration prompt

Paste this whole file as the opening instruction of a FRESH Claude Code session
started inside `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway` on branch
`feature/prep-pipeline-tier-b-t4`. It drives the Tier-B T4 slice to a
production-ready, review-approved PR using a controller + sub-agent topology with
iterative cross-LLM validation.

---

## 0. Mission (non-negotiable)

Implement Tier-B T4 exactly as specified by the two source-of-truth artifacts,
end to end, to as close to production quality as this repo ships:

- PLAN (authoritative step list + validation clauses):
  `docs/plans/request-pipeline-tier-b-t4-driver.dag.toml`
- DESIGN (authoritative behaviour + preservation matrix):
  `docs/plans/request-pipeline-tier-b-t4-driver.design.md` (rev 3)
- SPEC being amended:
  `docs/plans/request-pipeline-tier-b-handler-envelope.spec.md`

Both artifacts already passed a 3/3 unconditional cross-LLM gate. The DAG carries
VERIFIED current-HEAD anchors (the design's own `~NNNN` numbers are ~235 lines
stale vs `e94ae13`; trust the DAG's `refresh-anchors-audit` table, and re-verify
against live code before every edit).

### Hard constraints (a failure of any of these fails the task)

1. **No deferral of any kind.** No `TODO`, `FIXME`, `XXX`, "deferred", "follow-up",
   "later", "will be", "for now", stubbed/mocked/faked product code, `it.skip`,
   `it.todo`, `@ts-ignore`/`@ts-expect-error` used to paper over a real error, or
   `any`-casts hiding a real type gap, introduced anywhere in shipped `src/**`.
   Tests may use fakes for isolation only where the existing suite already does.
   One PR delivers: the driver, BOTH handler rewrites, ALL boundary tests, and the
   spec amendment. Nothing is left for a "T4 follow-up".
2. **Byte-behaviour preservation.** Every path in the design's section-4
   preservation matrix must hold for both providers. The existing characterization
   nets (`claude-handler-terminal-net`, `codex-handler-terminal-net`,
   `claude-handler`, `codex-handler`, `*-kit-preadmission`, `claude-prep-parity`,
   `claude-mcp-config`, `claude-argv-golden`, `sync-terminal-failure-redaction`,
   `personal-config-flight-recorder-privacy`, `async-job-manager-flight-recorder`)
   stay GREEN and UNMODIFIED.
3. **Documentation lands and is approved BEFORE the code it describes** (Phase A
   before Phase B; see section 3).
4. **Cross-LLM validation uses ONLY the local stdio gateway** (`gtwy` /
   `llm-cli-gateway`) with FULL access (reviewers get the same read/exec reach you
   have). See section 4. **Every review iteration is a FRESH session** (new
   `correlationId` + `createNewSession: true`, no `sessionId` reuse) so reviewers
   re-derive from current code with no carried-over bias.
5. **Iterate to a hard stop:** unconditional 3/3 approval, or a concrete named
   blocker you cannot resolve in scope (then stop and report it, do not ship past
   it).
6. Repo conventions: no em dash anywhere; no `Co-Authored-By` trailer; snake_case
   tool names; stderr-only logging; no `node:sqlite` outside `src/sqlite-driver.ts`;
   no new `fetch` token in `dist/**/*.js`; explicit return types on exported fns.

---

## 1. Topology (controllers + token-efficient sub-agents)

You are the **Orchestrator**. You own the DAG state, enforce dependency order and
parallelism, dispatch sub-agents, and aggregate their CONCLUSIONS (not their file
dumps). You do minimal editing yourself; you delegate. Keep your own context lean:
sub-agents read files and return findings; you keep the findings.

Spawn these agent roles (via the Agent tool). Match the agent TYPE to the job to
stay token-efficient:

| Role | Agent type | Scope (keep prompts bounded) |
|------|-----------|------------------------------|
| **Anchor auditor** | `Explore` (read-only) | Verify the DAG's anchor table against live `src/index.ts`; return a corrected table only. Reads excerpts, not whole files. |
| **Step-controller** | `fork` (inherits this context) | Owns ONE DAG step (or one parallel branch) end to end: implement, self-verify, drive its review loop, report. Use `fork` so it already knows the plan; give it the step id + its validation clause. |
| **Implementer** | `general-purpose` | Applies a BOUNDED edit to a named line range with the exact target behaviour. Give it the specific anchors + the design section, never "read the whole handler". |
| **Test author** | `general-purpose` | Writes the boundary tests for one provider; given the exact tuple assertions from DAG `boundary-tests`. |
| **Verifier** | `general-purpose` | Runs build/lint/format/targeted tests, returns pass/fail + the failing lines only. Fresh verifier per verification round (no memory of why it "should" pass). |
| **Reviewer dispatcher** | `fork` or inline | Drives the cross-LLM loop in section 4 (dispatch, 90s poll, collect, classify). Reviewers are EXTERNAL (gtwy), so this costs little Claude context. |

External reviewers (NOT Claude sub-agents): gtwy **Codex + Grok + Mistral** over
local stdio. Do NOT use `claude_request` as a reviewer with write access (session
bleed / self-commit hazard). Gemini/Antigravity may refuse correctness-flavoured
review; the sanctioned trio is Codex+Grok+Mistral.

**Parallelism rule for same-file edits:** `wire-claude-handler` and
`wire-codex-handler` both mutate `src/index.ts`. Do NOT run two implementers
editing that file concurrently (they clobber). Options: (i) serialize the two edits
under one step-controller, then parallelize their REVIEWS; or (ii) run each in an
isolated `git worktree` (`isolation: "worktree"`) and reconcile. Default to (i),
which is simpler and the edits are in disjoint line ranges. Everything ELSE that is
independent (the audit, the spec amendment, the two review loops, verification
sub-tasks) runs in parallel.

---

## 2. Dependency + parallelism map (from the DAG)

```
refresh-anchors-audit --+--> introduce-driver --+--> wire-claude-handler --+
   (doc / evidence)      |      (driver types)    |    (edit src/index.ts)   |
                         |                         +--> wire-codex-handler --+--> boundary-tests --+
                         |                              (same file: edits serialized)              |
                         +--> spec-amendment -------------------------------------------------------+--> verification-gate --> cross-llm-review-gate --> open-pr
        (doc)
```

- **Phase A (documentation, do first):** `refresh-anchors-audit` + `spec-amendment`.
  Both are doc/evidence only. Run in parallel. Gate each through the DOC review
  loop (section 4) to 3/3 unconditional before any code lands.
- **Phase B (implementation):** `introduce-driver` then `wire-claude-handler`
  then `wire-codex-handler` (serialized edits, same file) then `boundary-tests`.
  Gate the assembled code diff through the IMPL review loop (section 4).
- **Phase C (gates + PR):** `verification-gate` then `cross-llm-review-gate`
  (final, whole-diff, fresh sessions) then `open-pr`.

---

## 3. Per-step lifecycle (apply to every step)

For each step, the step-controller runs this loop and does NOT advance until the
step's DAG `validation` clause is satisfied WITH EVIDENCE:

1. **Re-verify anchors** against live `src/index.ts` (a prior step may have shifted
   lines). Never edit a stale anchor.
2. **Do the work** exactly per the DAG `action` + the cited design section. Keep
   edits bounded; preserve surrounding code idiom.
3. **Self-verify** (Verifier sub-agent, fresh): `npm run build`, `npm run lint`,
   `./node_modules/.bin/prettier --check <touched files>` (bypass RTK, which masks
   real prettier output), and the targeted tests for the step. Capture exact output.
4. **Review loop** (section 4): docs-phase steps use the DOC packet; code-phase
   steps use the IMPL packet. Fresh session each round. Iterate to 3/3 unconditional
   or a concrete blocker.
5. **Record** the evidence (commands + results + reviewer dispatch ids + verdicts)
   into `docs/plans/request-pipeline-tier-b-t4-driver.verification.md` (create it;
   append per step).

**Fresh-agent discipline:** each verification round and each review round starts
with a NEW sub-agent / NEW gateway session. Do not let the agent that wrote the
code also be the one that "confirms" it: spawn a fresh Verifier and fresh external
reviewers so nothing is rubber-stamped from memory of intent.

---

## 4. Cross-LLM review sub-protocol (reused everywhere)

Every review round, for BOTH the doc loop and the impl loop:

1. **Build the packet** (hand reviewers artifacts, never your summary):
   - The exact artifact under review, by ABSOLUTE path (the DAG file, the design,
     the spec, or the changed-file list + diff).
   - The corrective-program spec = the design doc (+ this prompt's constraints).
   - For code: the precise diff. Pre-commit run `git --no-pager diff` (+ `git status
     --porcelain`), or per-file `git --no-pager diff -- src/index.ts`; name base
     (`e94ae13`) and head. For new untracked files, give the path + note it is new.
   - The exact code ranges to verify (claude `9706..`, codex `10499..`, ledger
     class, and any moved anchors).
   - Explicit instruction: "Read the files yourself. Verify every claim against the
     code and docs, not my summary. Approve ONLY on inspected evidence, never on
     intent, plan-compliance, or 'should be fixed'. End with UNCONDITIONAL APPROVAL
     or ONE concrete blocker (file:line or named contradiction)."
2. **Dispatch to the local stdio gateway, FULL access, FRESH session:**
   - `mcp__gtwy__codex_request`: `dangerouslyBypassApprovalsAndSandbox: true`,
     `sandboxMode: "danger-full-access"`, `model: "gpt-5.5"`,
     `createNewSession: true`, unique `correlationId` (e.g.
     `t4-<step>-codex-r<N>`). Codex over-reads on broad diffs; give it the FOCUSED
     changed range.
   - `mcp__gtwy__grok_request`: `alwaysApprove: true`,
     `permissionMode: "bypassPermissions"`, `effort: "high"`, `model: "grok-4.5"`,
     `workingDir` = repo root, `createNewSession: true`, unique `correlationId`.
   - `mcp__gtwy__mistral_request`: `permissionMode: "auto-approve"`, `trust: true`,
     `model: "latest"`, `workingDir` = repo root, `createNewSession: true`, unique
     `correlationId`.
   - Give absolute paths IN THE PROMPT (do not use `workspace`/remote-workspace
     fields, which shadow local stdio). All three share your local FS reach.
3. **Poll every 90s** (grants are non-durable; each round is a fresh job). Use
   `mcp__gtwy__llm_job_status`; between polls do other useful work, do not spin.
   Prefer `ScheduleWakeup { delaySeconds: 90 }` for the cadence.
4. **Collect on completion** with `mcp__gtwy__llm_job_result`. Codex's job result
   can be a truncated interim line; read the FULL verdict via
   `mcp__gtwy__llm_request_result { correlationId }`. If Grok returns ~1 byte /
   empty (known handshake flake), re-dispatch with a reworded prompt; never treat
   empty as approval.
5. **Classify each finding:** (a) valid, fix it; (b) contestable, rebut with
   file:line / doc quote / test output, and ask them to re-check that artifact;
   (c) approval on bad grounds (intent / plan-compliance / "should be"), reject and
   re-ask for an evidence-based verdict.
6. **Re-run** self-verification after any fix, regenerate the diff, and **start a
   NEW fresh-session round** with all three. Repeat until all three give
   UNCONDITIONAL approval, or one names a concrete unresolvable blocker.
7. **Record** dispatch ids, per-round findings, rebuttals/fixes, and final verdicts
   in the verification notes.

---

## 5. Step-specific notes (read alongside the DAG action clauses)

- **refresh-anchors-audit** (doc): confirm the DAG's anchor table against live code;
  correct any line that moved; confirm the scaffold is absent (grep
  `runKitTerminalEnvelope|KitTerminalEnvelope|KitStageOutcome|KitTerminalHooks` = 0
  in `src/`). No product edit. DOC review loop.
- **spec-amendment** (doc): replace the spec's "driver replays states 0..12" wording
  (spec sections ~190 / ~266) with the design's "owns the terminal envelope"
  framing; cite the design doc. Docs-only. `./node_modules/.bin/prettier`/format
  check. DOC review loop.
- **introduce-driver** (code): add `KitStageOutcome`, `KitTerminalEnvelope`,
  `KitTerminalHooks<TFacts>`, and `runKitTerminalEnvelope` verbatim to design
  2.1-2.4, near the ledger/flight classes. Define the three referenced-but-
  undeclared types: `KitTerminalExecuteResult = InlineJobResponse |
  DeferredJobResponse`, `KitTerminalInlineResult = InlineJobResponse`,
  `KitTerminalFailure = ReturnType<typeof buildTerminalCliFailure>` (confirm exact
  names during the audit). Driver is dead-but-compiling after this step.
- **wire-claude-handler** (code): states 4..8 INSIDE `runInsideTerminalTry`; managers
  usage/failure = `deps.sessionManager`, exception = `runtime.sessionManager`,
  `fireRequestCleanupInCatch = true`; `computeSuccessFacts` = no-op `() => undefined`
  (parse AFTER finalize). Pre-`awaitJobOrDefer` state-9 setup moves into `execute`.
- **wire-codex-handler** (code, edit AFTER claude on the same file): states 4..8
  OUTSIDE via passthrough hook; keep the three front-half catches byte-exact (all
  fire the base `prepCleanup`, which `=== ledger.requestCleanup` pre-`installWorktree`);
  managers usage/failure = `runtime.sessionManager`, exception = `deps.sessionManager`,
  `fire = false`; `computeSuccessFacts` extracts usage/cost/meta BEFORE finalize.
- **boundary-tests** (code): all 8 state-4..8 tests (4 per provider) asserting the
  exact tuple, terminal parity for both providers, codex facts-order-throw. Existing
  nets stay green + unmodified.
- **verification-gate**: `npm run build && npm run lint && npm run format:check &&
  npm test && npm run check`. `npm run check` is authoritative (it builds first, so
  `site:generate` reads fresh `dist/`). ALSO run the CI-only gates that are NOT in
  `npm run check`: gitleaks + typos (allowlist any legitimate hits in `.gitleaks.toml`
  / `_typos.toml` first). Document any unavailable optional service (e.g. Postgres).
- **cross-llm-review-gate**: final whole-diff review, fresh sessions, D1/D2/D3
  ratified against code (section 8 of the design).
- **open-pr**: one PR `feature/prep-pipeline-tier-b-t4` to `master` via `werner_veriai`
  (gh-as/git-as; `--merge` not `--squash` on the internal repo). PR body: no em dash,
  no attribution trailer, links the design + verification notes.

---

## 6. Done criteria (the task is complete only when ALL hold)

- [ ] Every DAG step's `validation` clause satisfied, with evidence recorded in
      `docs/plans/request-pipeline-tier-b-t4-driver.verification.md`.
- [ ] Both handlers end in `return runKitTerminalEnvelope(env, hooks)`; neither has
      a second try/finally around `execute`.
- [ ] All existing characterization nets green + UNMODIFIED; all new boundary tests
      present + green; test count rose by the new tests.
- [ ] `npm run check` green; gitleaks + typos green.
- [ ] Anti-deferral grep is clean: no new `TODO|FIXME|XXX|@ts-ignore|it.skip|it.todo|
      \bdeferred\b|follow-up|for now|will be implemented` in the shipped `src/**` diff.
- [ ] Design section-4 preservation matrix holds for every path (asserted by tests).
- [ ] 3/3 UNCONDITIONAL cross-LLM approval on the DOCS (Phase A) and on the
      IMPLEMENTED DIFF (Phase C), each from fresh sessions, evidence-based, recorded.
- [ ] PR open against master with green required checks; no admin bypass.

If you hit a concrete unresolvable blocker at any gate, STOP, record it with
evidence, and report it. Do not ship past an open blocker or downgrade a review to
conditional.

---

## 7. Repo gotchas checklist (fold into sub-agent prompts)

- `npm run build` BEFORE `site:generate*`; those read `dist/`, not `src/` (a stale
  build passes the site check vacuously). `npm run check` is safe (builds first).
- RTK proxies `git`, `prettier`, and other CLIs and can MASK real output (prints a
  canned success while the exit code leaks). For prettier/CLIs, invoke
  `./node_modules/.bin/<tool>` directly; after a git stash/round-trip, verify with
  plain `git status`/`git diff`.
- Codex job result may be a truncated interim line; read full via
  `llm_request_result` by `correlationId`. Grok can silently emit empty output;
  re-dispatch, never trust a ~1-byte result.
- Reviewers: local stdio only, absolute paths in-prompt, NO `workspace`/workingDir
  remote fields that shadow stdio; poll every 90s; never give a same-repo
  `claude_request` reviewer write access.
- Internal repo push/PR/merge via `werner_veriai` (GH_CONFIG_DIR=~/.config/gh-werner_veriai;
  git local credential helper override on this branch). `--merge`, not `--squash`.
- The upstream-contracts meta-test enforces destructure-and-forward in every tool
  closure; do not introduce an `(args) => handler(deps, args)` shortcut.
- Keep a running verification-notes file; it is the corrective-program spec the
  final review grades against.

Begin with Phase A. Report a short status after each phase (what landed, the
review verdicts, what is next) so the human can interrupt.
