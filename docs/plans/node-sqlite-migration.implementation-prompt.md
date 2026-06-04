# Task: Implement the node:sqlite migration plan (Phase A → 1.17.9, Phase B → 2.0.0) with subagents + multi-LLM gates

## Read first
- Plan (the spec): `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway/docs/plans/node-sqlite-migration-2.0.0.md` — status APPROVED, 4/4 unconditional cross-LLM approval on both phases (review log in §9b). Treat every named acceptance artifact as a hard gate.
- Project invariants: `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` (one level above the gateway repo).
- Release flow: code lives on `origin` (verivusai-labs, master); the GitHub release is created on the `public` mirror (verivus-oss, main) and THAT triggers npm-publish. Push with the per-account helpers (`git-as werner_veriai … push origin HEAD:master`, `git-as verivusOSS-releases … push public HEAD:main`, both with `-c url.https://github.com/.pushInsteadOf=https://github.com/`), release with `gh-as verivusOSS-releases release create vX.Y.Z -R verivus-oss/llm-cli-gateway`. Commit style `chore(release): X.Y.Z`; unsigned annotated tag (`git tag -a --no-sign vX.Y.Z -m "llm-cli-gateway vX.Y.Z"`); NO Co-Authored-By trailers.
- Repo root: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`.

## Hard constraints already settled by the review — do NOT relearn or relitigate
1. `GatewayStatement.run()` returns `{ changes, lastInsertRowid }` — `job-store.ts:412,421` reads `.changes`. Never type it `void`.
2. `engines.node` → `>=24.4.0` exactly (bare-named-params default flip at 24.4; Stability-1.1 minors ≥24.4 explicitly accepted).
3. Adapter supports BOTH binding styles: bare `@name` objects (most statements) and positional `?` (`job-store.ts:278-287`).
4. better-sqlite3 MOVES to devDependencies — never deleted. `flight-recorder.test.ts:9` and `test-veracity-regressions-slice-kappa.test.ts:35` keep requiring it directly (deliberate legacy-schema seeding = standing old-engine→node:sqlite coverage). `@types/better-sqlite3` stays.
5. Engine skew is real: better-sqlite3 12.10.0 bundles SQLite 3.53.1, Node 24.15 node:sqlite is 3.51.3. The cross-engine WAL crash-recovery fixture test (both directions) gates ALL "zero migration" and rollback claims.
6. `queryRequests` write-guard becomes a dedicated `new DatabaseSync(path, { readOnly: true })` connection (engine-level enforcement; `stmt.readonly` does not exist in node:sqlite).
7. Registry behaviour MUST be tested via verdaccio — local-tarball installs silently ignore npm-shrinkwrap.json (verified empirically; npm/cli#5349/#5325 class). A passing local-tarball check proves nothing about real consumers.

## Execution structure (subagents)

You are the orchestrator. Keep cross-LLM review dispatches (gtwy MCP) and release actions in the MAIN context; delegate implementation and verification to subagents (Agent tool, `general-purpose`). One unit = one subagent + one verification pass + one cross-LLM review gate. Suggested units:

**Phase A (ship as 1.17.9 first — independently approved):**
- A-impl: `scripts/make-prod-shrinkwrap.mjs` (filter dev:true entries; delete root devDependencies field; deterministic output), rewire `pre-release.sh`/`refresh-release-lockfile.sh`, audit parity → regenerate-and-cmp, `scripts/verify-registry-install.sh` (ephemeral verdaccio; assertions per plan A3), CHANGELOG [1.17.9] including the A4 record correction ("inert" was wrong — registry installs honour the shrinkwrap).
- A-verify: full `bash scripts/pre-release.sh` (includes npm run check) + `verify-registry-install.sh` all-green.
- A-review: cross-LLM gate (below), then release 1.17.9 per the flow above.

**Phase B (2.0.0, feature branch):**
- B1-impl: `src/sqlite-driver.ts` adapter (openDatabase/openReadOnly/withTransaction; throw on nested transaction) + `src/__tests__/sqlite-driver.test.ts` per plan B8 list.
- B2-impl: migrate `flight-recorder.ts` + `job-store.ts` to the adapter; readOnly connection for queryRequests; delete local DatabaseLike interfaces.
- B3-impl: cross-engine WAL fixture tests (better-sqlite3 writer via devDep, simulated unclean stop, node:sqlite reader; and reverse).
- B4-impl: B5 dependency/policy cleanup (deps→devDeps move, drop tar-stream override, audit carve-out removal, pre-release guard removal, registry-check assertions flip to better-sqlite3-absent + npm ls exit 0) + B6 docs + B7 engines + CHANGELOG [2.0.0] BREAKING.
- B-verify: full gate + verdaccio check + `npm ci --ignore-scripts` then full suite (must pass — nothing in the prod graph needs install scripts anymore).
- B-audit: author `docs/plans/test-veracity-audit-sqlite-driver.spec.md` per the exemplar (`test-veracity-audit-slice-theta.spec.md`), run the 6 mutation probes from plan B8, record the OBSERVED failing test per probe (run, never asserted), 4–5 LLM auditors.
- B-review: cross-LLM gate, then release 2.0.0.

Subagents must return: changed-file list, gate output tail, and any deviation from the plan with file:line justification. Subagents do NOT push, release, or call gtwy.

## Cross-LLM review gate (gtwy MCP, per unit)

Reviewers: Codex + Gemini + Grok (+ Mistral for release-sized units). Exact flags that work:
- codex_request_async: `dangerouslyBypassApprovalsAndSandbox: true`, `workingDir` = repo root, `mcpServers: ["sqry","ref_tools","exa"]`
- gemini_request_async: `approvalMode: "yolo"`, `skipTrust: true`, `mcpServers: ["sqry","ref_tools","exa"]`
- grok_request_async: `alwaysApprove: true`, `workingDir` = repo root, `mcpServers: ["sqry"]` only
- mistral_request_async: `permissionMode: "auto-approve"`, `trust: true`, `workingDir` = repo root

Packet per iteration: exact diff command (`git diff <base>..HEAD`) + changed-file list, the verification report (gate output) as the corrective-program spec, plan section references, explicit instruction to verify against code/docs themselves and never accept your summary. Verdict format: UNCONDITIONAL APPROVAL or concrete blockers with file:line. Findings you dispute get rebutted with code/doc evidence only. Iterate until unconditional approval or a named unresolvable blocker. No approvals on intent, plan-compliance, or "should be fixed".

## Operational gotchas (all hit during plan review — avoid re-debugging)
- Gateway async jobs: poll `llm_job_status` every 90 s; the flight-recorder `requests` row completes BEFORE the CLI exits (do not trust it as a completion signal); a completed-looking `llm_job_result` with `exited: false` is a mid-run snapshot — re-fetch.
- Gemini/Grok/Mistral session resume across requests is unreliable (`resumable: false`): when re-dispatching a review round, send a fresh self-contained packet carrying prior context. Codex sessions DO persist (use the real session UUID from its banner).
- Grok runs the test suite with FORCE_COLOR set → 2 `cli-entrypoint.test.ts` failures that are environment-only; tell reviewers to unset it.
- Reviewers with full access leave scratch files (probe DBs, test scripts) in the repo root — `git status` and clean before committing.
- `… | tail` without `set -o pipefail` masks gate failures — always check the real exit code.
- CI `test:ci` on ubuntu-latest intermittently dies with "The runner has received a shutdown signal" — pure infra flake; `gh-as verivusOSS-releases run rerun <id> --failed`, possibly twice.
- After any overrides change, `npm install` can leave better-sqlite3's binding unbuilt (pre-release.sh has the guard; keep it until Phase B removes it).

## Definition of done
- 1.17.9 and 2.0.0 published to npm (provenance attached), mirror releases green, all workflows green.
- Registry-consumer verification: 1.17.9 → tar-stream@3.1.7 pinned, no dev deps in consumer tree; 2.0.0 → no better-sqlite3/tar-stream anywhere in consumer tree, `npm ls` exits 0, consumer count ≈ 92.
- Test-veracity audit spec on disk with observed failing test per probe.
- Plan document updated: §9b gains the implementation-review rounds; status flipped to IMPLEMENTED with release versions.
