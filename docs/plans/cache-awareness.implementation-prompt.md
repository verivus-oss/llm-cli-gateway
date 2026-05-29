# Task: Implement the cache-awareness plan with multi-LLM review per phase

## Read first
- Plan: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/cache-awareness.dag.toml`
- Project invariants: `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` (one level above the gateway repo) — especially "No conversation content in session storage" under Session State Design. This invariant MUST be preserved.
- Gateway-level guidance: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/guides/BEST_PRACTICES.md`.
- Repo root: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`.

The dag.toml has 16 steps with explicit depends_on, action bodies, and validation criteria. It was reviewed by Codex, Gemini, Grok, and Mistral over 3 rounds and unanimously approved. Treat the validation criteria as acceptance gates per step — do not consider a step done until its validation passes.

## How to execute the plan
Walk the DAG in topological order (the plan is already structured this way). For each step:
1. Read the step's action body and validation criteria.
2. Implement the changes (Edit/Write).
3. Run `npm run build && npm test` for that area before moving on.
4. **Multi-LLM review** of the step's diff via the `gtwy` MCP (see below).
5. Triage findings: agree → fix; disagree → respond with file:line or upstream-doc evidence (never assertion). Iterate until unanimous approval or a concrete unresolvable blocker.
6. Mark the step done in a running checklist, then move to the next.

Group small consecutive steps if they form one coherent diff (e.g. `define-prompt-parts-schema` + `extend-flight-recorder-stable-hash` can be one review unit). The 5 "main" review units are roughly: foundation (research + schema + flight-recorder migration + read access), slice 1 (promptParts wiring + claude cache_control + other-CLIs verification), slice 2 (cache-stats + MCP resource + session_get), slice 3 (TTL tracking + warning), and cross-cutting (config + doctor + docs).

## Multi-LLM review cycle (via `gtwy` MCP)

The MCP server is registered at user scope as `gtwy` (it wraps `/opt/nodejs/current/bin/llm-cli-gateway`). All tool calls use `mcp__gtwy__*`. For each review unit, launch all four reviewers async and **expect serialization to be necessary** (see "Gotchas" below). Use these exact permission flags:

- `mcp__gtwy__codex_request_async`:
    `dangerouslyBypassApprovalsAndSandbox: true`, `sandboxMode: "danger-full-access"`, `mcpServers: ["sqry", "ref", "exa"]`, `idleTimeoutMs: 1800000`. Do NOT pass `askForApproval` or `search: true` — both are rejected by `codex exec`.
- `mcp__gtwy__gemini_request_async`:
    `approvalMode: "yolo"`, `mcpServers: ["sqry", "ref", "exa"]`, `idleTimeoutMs: 1800000`.
- `mcp__gtwy__grok_request_async`:
    `permissionMode: "bypassPermissions"`, `alwaysApprove: true`, `mcpServers: ["sqry"]` only (ref/exa MCPs cause auth failures inside grok), `idleTimeoutMs: 1800000`.
- `mcp__gtwy__mistral_request_async`:
    `permissionMode: "auto-approve"`, `mcpServers: ["sqry", "ref", "exa"]`, `idleTimeoutMs: 1800000`.

Set a unique `correlationId` per request (e.g. `review-step-N-codex-rN`) so you can find them later.

### Review prompt template (per reviewer, per round)

```
ROLE: Critical reviewer of a diff for the llm-cli-gateway cache-awareness implementation.

ARTIFACT UNDER REVIEW
- DAG plan: /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/cache-awareness.dag.toml
- Step(s) being implemented in this diff: <STEP_IDS_FROM_DAG>
- Diff: produced by `git diff <BASE>..HEAD -- <SCOPED_PATHS>` — read with `git show` or `git diff`. Do not work from any summary.
- Repo root: /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
- Project CLAUDE.md (invariant source, one level above gateway): /srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md

INVARIANT: "No conversation content in session storage" must hold. Verify the diff does not violate it.

REVIEW MUST BE EVIDENCE-BASED
1. READ the diff and the cited dag.toml steps.
2. VERIFY against actual source (sqry/grep/Read) every claim the diff makes about existing code. Cite file:line.
3. VERIFY against upstream docs (ref/exa) every claim about provider behavior. Cite URLs.
4. VERIFY the step's validation criteria are actually met by the diff (run/inspect tests).
5. CHECK invariant preservation explicitly.

OUTPUT — single JSON block at end:

{
  "verdict": "approve" | "request_changes" | "concrete_blocker",
  "summary": "1-2 sentences",
  "findings": [
    {"id":"F1","severity":"blocker|major|minor|nit","claim_reviewed":"exact quote","issue":"...","evidence":"file:line OR URL OR 'unable to verify: <reason>'","suggested_fix":"..."}
  ],
  "unconditional_approval_blockers": ["F1"]
}

If you cannot verify a claim, set evidence = "unable to verify: <reason>" and severity = "major" minimum. Approval is unanimous across 4 reviewers; iterate until all approve or list concrete unresolvable blockers.
```

For round 2+, prepend each reviewer's verbatim round-1 findings + your per-finding response (FIXED + diff summary, or DISAGREE + file:line evidence). Never respond to a finding with assertion.

## Gotchas (learned the hard way — do not re-discover these)

1. **"orphaned" is transient, not terminal.** When polling the gateway's jobs table, jobs commonly transition orphaned → completed as a different gateway instance picks them up. Only treat `completed` or `failed` as done. Wait at least 5 minutes per job before assuming anything is wrong.

2. **Multiple gateway instances may be running.** `ps aux | grep llm-cli-gateway` may show multiple node processes. Each tracks only its own children, which is why orphaning happens. Not a bug to fix here.

3. **Sync MCP responses don't include the model output in the tool result** — they return only metadata `{cli, correlationId, durationMs, exitCode}`. The actual response is in the flight recorder. Read it via:
    ```
    node -e "const db = new (require('better-sqlite3'))(require('os').homedir() + '/.llm-cli-gateway/logs.db', {readonly: true}); console.log(db.prepare('SELECT response FROM requests WHERE id=?').get('<correlationId>').response);"
    ```
    Async job results: read `stdout` (or `stderr` if codex's recursion got stuck) from the `jobs` table by job id.

4. **Polling cadence.** Use Monitor with a 90s sleep loop, exit only when all jobs are in {completed, failed}. Don't poll faster than 90s — gateway permission state isn't durable under rapid re-grants.

5. **Codex's `--search` and `--ask-for-approval` flags are rejected by `codex exec`.** Don't set `search: true` or `askForApproval` on codex_request[_async].

6. **Grok MCP auth failures.** `ref` and `exa` MCPs sometimes auth-fail inside grok. Use `mcpServers: ["sqry"]` only for grok, fall back to Bash/curl for upstream-doc verification inside grok's prompt.

7. **Codex may recurse and stall** if its prompt mentions tools it can call into the same gateway. Keep its MCP server list scoped (sqry/ref/exa is fine; don't add gtwy itself).

8. **Direct CLI fallback.** If the gateway is misbehaving entirely, you can invoke each CLI directly via Bash:
    - `cat prompt.txt | codex exec --sandbox danger-full-access --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check > out.txt 2>&1`
    - `gemini --yolo -p "$(cat prompt.txt)" > out.txt 2>&1`
    - `grok --always-approve "$(cat prompt.txt)" > out.txt 2>&1` (or `grok agent headless` for the websocket relay form)
    - `vibe "$(cat prompt.txt)" > out.txt 2>&1`
    Run in background with `run_in_background: true` and read the output file when done.

9. **Re-anchor line citations before editing.** The dag.toml's file:line refs were accurate at planning time but the codebase moves. Run `rg` to confirm current locations before relying on any cited line number. The plan itself includes a re-anchoring instruction at the top of `release-readiness-check`.

10. **`server.registerResource()`, not `server.resource()`** — for new MCP resources in `src/index.ts`. Look at `registerBaseResources` around line 811 for the pattern.

11. **No Zod `.refine()` at tool registration boundary** — the MCP SDK rejects top-level refines. Use runtime if-checks at the top of handlers + `createErrorResponse(...)`. Precedent: `codex_fork_session` at `src/index.ts:3724-3733`.

12. **Async-path stable_prefix_hash is OUT OF SCOPE** for this slice — `src/async-job-manager.ts` has zero flight-recorder integration today. Don't expand the scope; document the deferral.

## When to stop iterating per step

Stop when either:
- All 4 reviewers return `verdict: "approve"` with `unconditional_approval_blockers: []`, OR
- A reviewer lists a concrete blocker that cannot be resolved without expanding scope beyond the current step (in which case: pause, escalate to me).

## Deliverables

- Implemented code matching the dag.toml steps, with all validation criteria met.
- A running per-step review log (which reviewer said what, what was fixed, what was rebutted with evidence).
- A draft PR description in `docs/plans/cache-awareness.pr-body.md` populated as required by the `release-readiness-check` step.
- `npm run check` exits 0.

Start by reading the dag.toml end-to-end, then begin with `research-provider-cache-surfaces` and `define-prompt-parts-schema` (both have no dependencies and can run in parallel).
