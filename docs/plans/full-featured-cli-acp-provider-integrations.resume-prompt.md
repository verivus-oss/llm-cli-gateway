# Resume prompt: finish the full-featured CLI/ACP provider integration (phases 2-9)

Paste everything below the line into a fresh Claude Code session opened at the repo
root (`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`). It drives the
remaining DAG phases to a PR-ready state using token-lean subagents, with the repo's
per-phase gate and cross-LLM review applied.

---

## Mission

Complete `docs/plans/full-featured-cli-acp-provider-integrations.dag.toml` on branch
`feature/remote-http-oauth-ux-improvements-v2`. That DAG is the authoritative spec
(`[meta]`, `[global_full_featured_contract]`, `[runtime_self_discovery_contract]`,
`[shared_provider_registry_design]`, the per-`[providers.*]` tables, `[test_matrix.*]`,
`[validation_gates]`, and the ten `[[nodes]]`). Read it once, plus the companion brief
`docs/plans/full-featured-cli-acp-provider-integrations.prompt.md`. Do not restate them;
act on them.

**Already committed on the branch (do not redo; build on them):**
- `phase-0` baseline: installed versions synced across upstream-contracts / acp/provider-registry / provider-tool-capabilities and the DAG; limited-support ACP labels annotated `// phase-5/8: replace ...`.
- `phase-1` `src/provider-definitions.ts` = the DRY single source of truth (one `ProviderDefinition` per `CLI_TYPES` member), plus `provider-definition-assertions.ts` (compile-time exhaustiveness via `satisfies Record<CliType, ProviderDefinition>` + `assertNever`), `provider-surface-generator.ts` (nine registry projections), and `scripts/provider-surfaces-check.mjs` (a DRY ratchet wired into `npm run check` with a shrinking `LEGACY_ALLOWLIST`: `resources.ts` drained by phase-2, `index.ts` request wiring by phase-4).
- `phase-1b` runtime capability discovery + on-disk cache: `provider-help-parser.ts`, `provider-capability-discovery.ts` (injectable `ProbeRunner`; real spawn uses fixed argv, no shell interpolation of caller input), `provider-capability-cache.ts` (8-field cache key + shape-driven secret scrubber + Zod-validated read), `provider-schema-builder.ts`.

Start at **phase-2**. Confirm the base is clean first: `git log --oneline -6`, `git status`, and `npm test` should be green (about 2015 tests).

## You are the orchestrator: keep your own context lean

- Delegate all heavy reading, implementation, and verification to subagents. Your job is
  sequencing the DAG, enforcing gates, running the review loop, and holding the thread.
  Never pull large files or full diffs into your own context.
- Require every subagent to return a concise structured report (~300 words max): files
  touched, commands run with pass/fail, each acceptance item met with a one-line
  `file:line`/test citation, open risks. No raw diffs, no file dumps. If you need a detail
  later, message that agent by id rather than re-reading.
- Use **fresh `general-purpose` subagents** (or `Explore` for read-only audits) with
  **self-contained briefs**. Do NOT use `fork` for implementation: a fork inherits the
  orchestrator framing and tends to parrot "waiting" instead of doing the work.
- Ground code navigation in **sqry** (`mcp__sqry__*`, the pinned `rvwr` workspace) before
  grep/Read. Tell every subagent to reach for sqry first and only Read exact lines it edits.
- Capture provider evidence ONCE up front so subagents and reviewers never re-probe into
  your context: an `Explore`/general-purpose agent writes `<cli> --version` and the help
  outputs (`claude/codex/codex exec/agy/grok/grok agent/vibe/vibe-acp/devin/devin acp/
  cursor-agent/cursor-agent acp`) to a stable dir (for example `/tmp/ffci-help/`) with
  sha256sums. Every capability claim must trace to that installed help or a DAG docs URL.

## Execution order: sequential, in the main working tree

Respect `depends_on`. A valid sequential order that satisfies every dependency is:
`phase-2 -> phase-3 -> phase-4 -> phase-5 -> phase-6 -> phase-7 -> phase-8 -> phase-9`.

Run phases **sequentially in the main tree**, not concurrently. Concurrent agents in one
tree contaminate each other's gates (tsc/`npm test` compile the whole tree), and git
worktrees do not get `node_modules` (gitignored) so isolated agents cannot run
build/test. Sequential keeps every phase's gate verification and per-phase commit clean.
You may still run the async review jobs for a phase in parallel with each other.

## Per-phase loop (apply to every node)

1. **Implement** via one fresh general-purpose subagent, handed exactly: the node
   `description`/`files`/`acceptance`/`commands`, the DRY + security guardrails below, the
   help-evidence path, and "do not commit". Split a phase only if a node is genuinely large
   (for example phase-4 per-provider argv builders); give each split agent the same guardrails.
2. **Gate locally.** The agent runs the node `commands` PLUS `npm run build`,
   `npm run lint` (0 ERRORS; warnings are the pre-existing baseline and are fine),
   `npm run format:check`, `npm run provider:surfaces:check`, and the full `npm test`, and
   fixes-and-reruns until all green. Do not proceed on red. Independently re-run the key
   gates yourself before review (trust but verify; past impl agents mis-reported lint).
3. **Cross-LLM review** the phase diff (process below). Iterate fix rounds until every
   reviewer raises zero blockers, or a concrete unresolvable blocker remains.
4. **Commit** the phase on the branch (small per-phase commits, conventional style, no
   `Co-Authored-By`, no em dash). Drain the `LEGACY_ALLOWLIST` entry the phase retires.
5. **Unblock** the next phase.

## Cross-LLM review process (mandatory per phase)

Use the multi-LLM gateway (`gtwy` / `llm-cli-gateway` MCP). Rules that actually work here:

- **Roster:** Codex (read-only) + Grok + Mistral on every phase; add Gemini for
  non-security phases. For security-sensitive phases (phase-5 ACP host services/permission
  routing, phase-6 admin mutation/credential redaction, and any credential/redaction
  change) use Codex + Grok + Mistral only (Antigravity/Gemini hard-refuses audit tasks).
- Reviewers verify against the ACTUAL code/tests/installed-help, never your summary. Give
  each the exact changed-file absolute paths, save the diff to a file they can read, and
  the gate output. Put absolute paths in the prompt text; do NOT pass
  `workingDir`/`workspace`/`addDir` (the remote workspace shadows the local stdio FS).
  Never give a same-repo `claude_request` reviewer write access (session-bleed self-commit).
- **Round budget:** iterate until zero blockers. Convergence is slow by design here:
  implementation review can take up to ~5 rounds and the phase-8 documentation gate up to
  ~15 rounds. Never cap at 3 and commit with open blockers.
- **Tooling gotchas:** run reviewers async (`*_request_async`); poll `llm_job_status`;
  fetch the clean verdict with `llm_request_result` by correlationId (NOT `llm_job_result`,
  which returns from the start and truncates the verdict). Mistral: omit `permissionMode`
  (passing `plan` makes it only plan, not review). Grok: pass `disableWebSearch:true`; if
  its worker crashes (`tool_output_error`) retry once. Cancel a hung job
  (`llm_job_cancel`) rather than let it block. A flaky reviewer that yields no verdict must
  not block the phase; the others still gate. Codex is the most rigorous; weight its
  findings heavily but confirm each against code yourself before acting.
- Only accept a blocker after you confirm it against the code. Fix genuine ones; for an
  out-of-scope/undetectable class (for example a bare high-entropy secret with no key
  context that no regex scrubber can catch without destroying legit checksums), record a
  code-cited dismissal instead of thrashing.

## Test-veracity (standing protocol)

Every phase that adds tests must pass a mutation-probe audit before its review counts as
clean: each new test must fail when the behavior it guards is broken. Ask reviewers to name,
per new test, a concrete mutation that flips it red; reject tests that still pass against a
mutated implementation.

## Guardrails (hand these to every impl/fix agent)

DRY / self-discovery:
- Provider identity and discovery strategy live only in `provider-definitions.ts`. No other
  surface keeps its own provider list, capability matrix, or resource matrix; it imports the
  registry or a generated projection. No literal array of CLI provider names and no
  hand-spelled `if (uri === "sessions://claude")` blocks outside the registry/generator and
  test snapshots. Capability/docs/resource switches need an `assertNever`/exhaustive
  provider-definition iterator so adding a provider fails the build until every surface is
  covered. `provider:surfaces:check` must stay green (drain, do not grow, the allowlist).
- A CLI version / help-checksum / model-catalog / ACP-initialize change is a discovery
  event, not a code event. Discovered-but-unmapped flags/methods are surfaced as
  `discovered-unmapped` with evidence, never silently dropped.
- Native ACP only where upstream advertises a real stdio entrypoint (`grok agent stdio`,
  `vibe-acp`, `devin acp`). Claude, Codex, and Antigravity report NO native ACP entrypoint
  with zero adapter-as-native masquerading.

Security / correctness (non-negotiable):
- Node >= 24.4.0. `node:sqlite` only in `src/sqlite-driver.ts`; no `fetch` token in `dist/`.
- All human-readable output to stderr; stdout is MCP JSON-RPC only; no provider ACP stdout
  reaches gateway stdout. Tool names snake_case; Zod at every boundary; explicit return
  types on exported functions.
- No shell interpolation when spawning provider processes. Credentials, tokens, OAuth codes,
  bearer headers, and account ids never appear in MCP responses, docs, logs, plan files, or
  test snapshots. Principal isolation: never thread another principal's
  `sessionId`/`workingDir`/`worktree` into a handler; Codex resume needs a real Codex UUID.
  Mutating admin ops stay disabled until explicit gateway config enables them, and are audited.
- No em dash U+2014 anywhere (a PreToolUse hook blocks edits and commits containing one). No
  `Co-Authored-By` trailer.

## Documentation is a first-class deliverable (phase-8)

Update `README.md`, `CLAUDE.md`, and `.agents/skills/provider-*/SKILL.md` so the documented
surface matches what shipped. No "pilot / deferred / watchlist / not yet / todo / incomplete"
wording for native-ACP providers once full protocol support lands; no native-ACP claims for
CLI-only providers. The phase-8 `rg` check must come back clean. Refresh the provider list and
test-count facts in `CLAUDE.md` if they drift. Expect the doc review to take many rounds.

## Do not make the human babysit

After you dispatch a subagent or an async review, do NOT idle waiting for a notification.
Arm a self-resuming waiter so you continue on your own:
- For a subagent, a `Monitor` that watches the phase's files and fires once they go idle for
  ~80s (wait for edits to START before detecting idle, to avoid a stale-mtime false
  positive), or just handle its completion notification.
- For async gtwy reviews, a short background `sleep` timer (foreground sleep is blocked)
  whose completion re-invokes you to poll. If a completion notification is ever dropped,
  proactively check file mtimes / job status instead of waiting.
Report a one-line status per node as you clear it; surface only decisions that are genuinely
the human's to make.

## Definition of done

- All ten nodes' `acceptance` satisfied, each backed by a passing test or a code citation.
- Global gates green: `npm run build`, `npm run lint`, `npm run format:check`, `npm test`,
  `npm run upstream:contracts`, `npm run provider:surfaces:check`, and `npm run check`.
- Every per-phase cross-LLM review reached zero blockers, and the phase-9 full-diff review
  reached zero blockers.
- Docs and skills updated and clean.
- STOP at "PR ready for review". Do not push, open a PR, or release; do not admin-bypass.
  Report the branch, the `git diff master...HEAD --stat` inventory, and the green gate output.
