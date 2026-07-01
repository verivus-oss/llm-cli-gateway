# Implementation prompt: full-featured CLI and ACP provider integrations

Paste everything below the line into a fresh Claude Code session opened at the
repo root (`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`). It drives
the DAG in `docs/plans/full-featured-cli-acp-provider-integrations.dag.toml` to
completion using token-lean sub-agents, with the repo's standard documentation
and cross-LLM review gate applied per phase.

---

## Mission

Implement `docs/plans/full-featured-cli-acp-provider-integrations.dag.toml`
end-to-end on branch `feature/remote-http-oauth-ux-improvements-v2`. That DAG is
the authoritative spec: `[meta]`, the `[global_full_featured_contract]`,
`[runtime_self_discovery_contract]`, `[shared_provider_registry_design]`, the
per-`[providers.*]` tables, `[test_matrix.*]`, `[validation_gates]`, and the ten
`[[nodes]]` are binding. Read it in full once before starting. Do not restate it
back to me; act on it.

The outcome: Claude, Codex, Gemini/Antigravity, Grok, Mistral Vibe, and Devin
(all non-Cursor CLI providers) become first-class provider definitions that
drive request schemas, resources, model/session discovery, capabilities,
upstream contracts, admin subcommands, CLI plus native-ACP routing, docs, and
tests. Cursor is out of scope here (its own companion plan owns it), but Cursor
must keep working and stay covered by the shared generation.

## You are the orchestrator (keep your context lean)

- Delegate all heavy reading, implementation, and verification to sub-agents.
  Your job is sequencing the DAG, enforcing the gates, and holding the thread of
  what is done. Do not pull large files or full diffs into your own context.
- Require every sub-agent to return a concise structured report (roughly 300
  words max): files touched, commands run with pass/fail, acceptance items met
  with a one-line code/test citation each, and any open risk. No raw diffs, no
  file dumps. If you need a detail later, ask that agent via its ID rather than
  re-reading.
- Never invent capability. Every flag, subcommand, and ACP method must trace to
  installed `--help`/`--version` output or the docs URLs recorded in the DAG
  (`web_evidence_date = 2026-07-01`). Sub-agents must probe the installed CLIs
  (`local_help_commands` / `local_version_commands` in the DAG), not rely on
  model memory. If installed help and a docs URL disagree, installed help wins
  and the discrepancy is recorded as a capability fact.

## Code grounding: use sqry first

Ground every "where does X live / what calls this / what breaks if I change it"
question in **sqry** (the `mcp__sqry__*` tools) before falling back to grep or
whole-file reads. sqry parses this repo like a compiler (the `rvwr` workspace is
pinned in the sqry daemon), so it is both more accurate and far cheaper in
tokens than text search. Use it for:

- `semantic_search` to locate the current provider-list literals, manual
  `models://` / `sessions://` resource blocks, and per-provider switch
  statements the DRY phases must eliminate.
- `direct_callers` / `direct_callees` / `trace_path` to map how `index.ts`,
  `resources.ts`, `provider-tool-capabilities.ts`, `upstream-contracts.ts`, and
  the `acp/*` modules interconnect before editing shared hot spots.
- `dependency_impact` / `show_dependencies` / `find_cycles` to size the blast
  radius of the provider-definitions refactor and catch import cycles early.
- `find_unused` and `semantic_diff` to confirm old hand-maintained paths are
  actually dead after a phase migrates a surface to generated projection.

Instruct every sub-agent to reach for sqry first and only drop to grep/Read for
exact-string or non-code files. Reading a whole file into context is the last
resort, not the first move.

## Sub-agent strategy (token efficiency, production quality)

- Audits and searches (phase 0, "does X already exist" questions): use
  `Explore` or a fresh `general-purpose` agent, and tell it to ground in sqry
  (above) so its file reads never enter your context. Ask for conclusions plus
  `file:line` anchors only.
- Implementation of a phase: use a `fork` sub-agent (it inherits repo
  conventions and this brief). Give it exactly the node `description`, `files`,
  `acceptance`, `commands`, plus the DRY/security guardrails below. It must
  implement, run the node commands, self-check every acceptance item, and report.
- Independent phases run in parallel (see order below): launch them in a single
  message so they run concurrently. Isolate agents in a `worktree` when they
  would touch overlapping files. `src/index.ts` and `src/upstream-contracts.ts`
  are shared hot spots; serialize or worktree-isolate edits to those.
- One phase equals one implementation agent by default. Only split a phase if a
  node is genuinely large (for example phase-4 per-provider argv builders). If
  you split, give each agent the same guardrails and merge their reports.

## DAG execution order (respect `depends_on`)

```
phase-0  (audit/baseline)
  -> phase-1  (provider-definitions = single source of truth; adds provider:surfaces:check)
       -> phase-1b (runtime capability discovery + cache)
            -> phase-2 (generated model/session resources) -> phase-3 (live model discovery)
            -> phase-4 (complete CLI request fields)        \
            -> phase-5 (native ACP full surface)             > run 2,4,5,6 concurrently after 1b
            -> phase-6 (provider admin surfaces)            /
       phase-7 (output/event normalization)   needs 4 + 5
       phase-8 (docs + skills)                 needs 2 + 6 + 7
       phase-9 (cross-LLM review + release gate) needs 3 + 4 + 5 + 6 + 8
```

phase-0 and phase-1 are hard serial prerequisites: nothing else may start until
`provider-definitions.ts` exists and the DRY guardrails plus the
`provider:surfaces:check` script are enforced, because every later phase imports
from that source of truth.

## Per-phase loop (apply to every node)

1. Implement via the phase sub-agent.
2. Gate locally: run the node's `commands`; capture output. If red, the same
   agent fixes and re-runs until green. Do not proceed on red.
3. Cross-LLM review the phase diff (process below). Iterate until unconditional
   approval or a concrete, code-cited unresolvable blocker.
4. Commit the phase on the feature branch once review is clean (small, per-phase
   commits; conventional style already used in this repo; no `Co-Authored-By`
   trailer; no em dashes anywhere, a hook enforces this).
5. Then unblock dependents.

## Standard cross-LLM review process (mandatory per phase)

Invoke the `cross-llm-review` skill. Apply these repo rules exactly:

- Reviewers verify against the actual code/docs/tests, never against your
  summary. Give each reviewer the exact changed-file list (absolute paths) and
  the verification report (the node commands plus their output). Iterate until an
  unconditional approval or a concrete unresolvable blocker; reject
  plan-compliance or "looks right" approvals.
- Roster: Codex (read-only), Grok, and Mistral on every phase; add Gemini for
  non-security phases. For security-sensitive phases, namely phase-5 (ACP host
  services, permission routing), phase-6 (admin mutation, credential redaction),
  and any credential/redaction change, use Codex plus Grok plus Mistral only;
  Antigravity/Gemini hard-refuses audit and vuln tasks.
- Never give a same-repo `claude_request` reviewer write access; session bleed
  lets it self-commit or self-release. Use Codex read-only plus Grok plus Mistral.
- Do not pass `workingDir` / `workspace` / `addDir` to the gtwy reviewer tools;
  the remote workspace shadows the local stdio FS. Reviewers already share local
  FS, so put absolute paths in the prompt text.
- Run reviewers async and poll every 90s.

## Test-veracity audit (standing protocol)

Every phase that adds tests must pass a strict-evidence mutation-probe audit
before its review counts as clean: reviewers confirm each new test actually fails
when the behavior it guards is broken (mutation), the spec exists on disk, 4 to 5
LLMs participate, polling at least 90s. Reject tests that still pass against a
mutated implementation; they are not evidence.

## Validation gates

- Global (`[validation_gates].commands`): `npm run format:check`,
  `npm run lint`, `npm test`, `npm run build`, `npm run upstream:contracts`,
  `npm run provider:surfaces:check`.
- `provider:surfaces:check` does not exist yet. phase-1 must add it to
  `package.json` and implement it (scans for forbidden literal provider arrays
  and manual `models://` / `sessions://` blocks outside provider-definitions and
  generated snapshots, per `[shared_provider_registry_design].forbidden_patterns`).
  Wire it into `npm run check` too.
- Several referenced files are to be created, not edited: `provider-definitions.ts`,
  the `provider-*` modules in `[shared_provider_registry_design].new_or_changed_modules`,
  and `src/grok-json-parser.ts` (phase-7). Confirm-then-create. The ACP test
  infra (`src/__tests__/acp-*.test.ts`) already exists and should be extended,
  not duplicated.
- Full gate before phase-9: `npm run check` (build + lint + format:check + test +
  security:audit) must be green.

## DRY and self-discovery guardrails (hand these to every impl agent)

- Provider identity and discovery strategy live only in
  `provider-definitions.ts`. No other gateway surface may keep its own provider
  list, capability matrix, or resource matrix; it imports the registry or a
  generated projection. CI (`provider:surfaces:check` plus assertion tests) must
  prove this.
- No literal array of CLI provider names outside provider-definition modules and
  generated test snapshots. No hand-spelled `if (uri === "sessions://claude")`
  style blocks. Capability/docs switches require an `assertNever`/exhaustive
  provider-definition iterator so adding a provider fails the build until every
  surface is covered.
- A provider CLI version, help-checksum, model-catalog, or ACP-initialize change
  is a discovery event, not a code event: it invalidates the cache and reprojects
  surfaces automatically. Discovered-but-unmapped flags/methods are surfaced as
  `discovered-unmapped` with evidence, never silently dropped.
- Native ACP only where upstream advertises a real stdio entrypoint (grok agent
  stdio, vibe-acp, devin acp). Claude, Codex, and Antigravity must report no
  native ACP entrypoint with zero adapter-as-native masquerading.

## Security / correctness invariants (repo-wide, non-negotiable)

- Node `>=24.4.0`. `node:sqlite` referenced only in `src/sqlite-driver.ts`; no
  `fetch` token in `dist/` (the release audit hard-fails otherwise).
- All human-readable output to stderr; stdout is MCP JSON-RPC only. No provider
  ACP stdout ever reaches gateway stdout.
- Tool names `snake_case`; Zod at every boundary; explicit return types on
  exported functions.
- No shell interpolation when spawning provider processes. Credentials, tokens,
  OAuth codes, bearer headers, and account ids never appear in MCP responses,
  docs, logs, plan files, or test snapshots.
- Principal isolation: never thread a `sessionId` / `workingDir` / `worktree`
  from another principal's metadata into a handler. Codex resume needs a real
  Codex UUID, not a `gw-*` id. Mutating admin ops stay disabled until explicit
  gateway config enables them, and are audited.

## Documentation is a first-class deliverable (phase-8, not optional)

Update `README.md`, `CLAUDE.md`, and the provider skills under
`.agents/skills/provider-*/SKILL.md` so the documented surface matches what
shipped. No "pilot / deferred / watchlist / not yet / todo / incomplete" wording
for native-ACP providers once full protocol support lands; no native-ACP claims
for CLI-only providers. The phase-8 `rg` check in the DAG must come back clean.
Also refresh the provider list and test-count facts in `CLAUDE.md` if they drift.

## Definition of done

- All ten nodes' `acceptance` arrays satisfied, each backed by a passing test or
  a code citation.
- Global gates green, including the new `provider:surfaces:check` and
  `npm run upstream:contracts`.
- Cross-LLM review returns unconditional approval on the full diff (phase-9
  roster: Claude, Grok, Cursor, Codex per the node) after every per-phase review
  already passed.
- Docs and skills updated and clean.
- Ready to hand off as a release PR on master with 2 checks, never an admin
  bypass, never a direct release from here. Stop at "PR ready for review" and
  report the branch, the changed-file inventory, and the green gate output.

## Kickoff

1. Confirm the branch is `feature/remote-http-oauth-ux-improvements-v2` and the
   tree is clean enough to start (stash or segregate the unrelated untracked plan
   files if needed).
2. Launch phase-0 as an `Explore`/audit sub-agent grounded in sqry: capture
   installed versions, help-output checksums, docs URLs, and the current gateway
   code locations for each provider (use `semantic_search` for the provider-list
   literals and manual resource blocks, `direct_callers`/`trace_path` for the
   `index.ts`/`resources.ts`/`acp` wiring); identify the stale upstream-contract
   labels to replace. Return the baseline as a compact table with `file:line`
   anchors.
3. Proceed through the DAG per the order and per-phase loop above, reporting a
   one-line status per node as you clear it.
