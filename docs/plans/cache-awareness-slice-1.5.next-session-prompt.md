# Next-session prompt — cache-awareness slice 1.5 (async-path FR + codex parser)

Paste the block below into a fresh Claude Code session opened from
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. It is
self-contained; do not paste this header.

---

## Task

Ship the **two tactical follow-ups** to cache-awareness phase 1 (v1.6.0
already published) that were explicitly deferred out of scope at the time
and called out in the blog post's "What's next" section. Together they close
the telemetry-completeness gap for the existing `cache_state://` observability
surface so slice 4 (cache-aware multi-LLM routing) has clean data to build on.

The two pieces of work:

1. **Async-path flight-recorder integration.** `src/async-job-manager.ts` has
   zero flight-recorder calls today. The v3 `stable_prefix_hash` /
   `stable_prefix_tokens` columns therefore stay NULL on async-job rows even
   when `promptParts` was supplied. Wire `safeFlightStart` (and
   `safeFlightComplete` on terminal status — completed / failed / orphaned)
   into the async-job lifecycle, mirroring the sync-path pattern at
   `src/index.ts` around the `claude_request` / `codex_request` etc. sync
   handlers. The async job manager already has all the data it needs
   (`prep.stablePrefixHash`, `prep.stablePrefixTokens`, `prep.effectivePrompt`,
   `prep.resolvedModel`, `sessionId`); the work is plumbing, not architecture.
   Watch the async test fixtures — `src/__tests__/async-job-manager*.test.ts`
   are extensive and the new writes need to be opt-out-able for tests that
   inject `flightRecorder: new NoopFlightRecorder()`.

2. **Codex parser fix for `cached_input_tokens`.** `src/codex-json-parser.ts`
   currently reads Anthropic-style `cache_read_input_tokens` /
   `cache_creation_input_tokens` (lines ~69-77). Live smoke-tested on
   2026-05-26: Codex CLI 0.133.0+ emits `cached_input_tokens` instead. Update
   the parser to accept BOTH names (prefer `cached_input_tokens` when both
   are present), so cache_read_tokens stops being NULL on codex rows. The
   field-name divergence is documented in
   `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` under "Codex — field name
   divergence" with the smoke-test invocation quoted.

Both ship together as **v1.7.0** (minor — observability surface materially
expands; new flight-recorder data appears where previously empty).

## Read first

- `docs/plans/cache-awareness.dag.toml` — the v1.6.0 plan. Lines around
  step `slice1-wire-prompt-parts-into-request-helpers` point 5 explicitly
  defer async-path FR integration to "a follow-up plan
  (`docs/plans/async-flight-recorder.dag.toml`)". That follow-up plan does
  not exist yet — write it as part of this slice.
- `docs/plans/cache-awareness.pr-body.md` — the v1.6.0 PR description. The
  "Intentionally NOT shipped" section names exactly these two items.
- `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md` — for the codex field-name
  divergence section and the per-model Anthropic cache-token thresholds.
- `CHANGELOG.md` — the `[1.6.1]` and `[1.6.0]` entries are the most recent
  context for what shipped.
- `/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` (one directory above
  the gateway repo) — the project-root invariant source. "No conversation
  content in session storage" still applies. The async-path write goes to
  the existing flight recorder (`~/.llm-cli-gateway/logs.db`, which already
  stores prompts/responses for audit), NOT to the session manager.
- `docs/guides/BEST_PRACTICES.md` — gateway-level guidance.

## Working environment

- Repo: `/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`
- Branch model: code lives in `verivusai-labs/llm-cli-gateway` (private,
  `master`) and is mirrored to `verivus-oss/llm-cli-gateway` (public, `main`).
  Push pattern is `git push origin master` (as `werner_veriai`) then
  `gh auth switch --user verivusOSS-releases && git push public master:main`.
- Currently on `master` at `1fb6955` (just past `chore(release): 1.6.1`).
- Create a feature branch: `git checkout -b feat/cache-awareness-slice-1.5`.

## Hard rules (these are non-negotiable)

1. **NO `Co-Authored-By: Claude` trailer in commit messages.** See the saved
   memory at
   `/home/werner/.claude/projects/-srv-repos-internal-verivusai-labs-rvwr-llm-cli-gateway/memory/feedback_no_coauthored_by_trailer.md`.
   Match the repo's commit style; the git author field is the canonical
   attribution surface.

2. **Multi-LLM review per slice via `gtwy` MCP.** Codex + Gemini + Grok +
   Mistral, async, with the permission flags below. Unanimous approval
   required before commit lands on `master`. Verdict format is a single JSON
   block at the end of each review (verdict, summary, findings,
   unconditional_approval_blockers).

   - `mcp__gtwy__codex_request_async`: `dangerouslyBypassApprovalsAndSandbox: true`,
     `sandboxMode: "danger-full-access"`, `mcpServers: ["sqry", "ref_tools", "exa"]`,
     `idleTimeoutMs: 1800000`. Do NOT pass `askForApproval` or `search: true`.
   - `mcp__gtwy__gemini_request_async`: `approvalMode: "yolo"`,
     `mcpServers: ["sqry", "ref_tools", "exa"]`, `idleTimeoutMs: 1800000`.
   - `mcp__gtwy__grok_request_async`: `permissionMode: "bypassPermissions"`,
     `alwaysApprove: true`, `mcpServers: ["sqry"]` only (ref/exa cause auth
     failures in grok), `idleTimeoutMs: 1800000`.
   - `mcp__gtwy__mistral_request_async`: `permissionMode: "auto-approve"`,
     `mcpServers: ["sqry", "ref_tools", "exa"]`, `idleTimeoutMs: 1800000`.

   Polling: ≥90s cadence. `orphaned` is transient (different gateway
   instance picks up). Async results > token limit save to a file; extract
   via the python slice command.

3. **Preserve the session-storage invariant.** `~/.llm-cli-gateway/sessions.json`
   stays content-free. New flight-recorder writes are fine (the flight
   recorder already stores prompts/responses for audit).

4. **`npm run check` must exit 0 before commit.** That is build + lint +
   format:check + test:ci + security:audit. The local pre-commit standard
   matches public-CI.

5. **Skip CI iteration cost by running these locally before pushing:**
   actionlint, zizmor, gitleaks, osv-scanner, ruff, bandit, typos. Recipes
   are in `.github/workflows/security.yml`.

## Slice design — please write a dag.toml first

Create `docs/plans/async-flight-recorder.dag.toml` modeled on
`docs/plans/cache-awareness.dag.toml`. Minimum steps:

1. `research-async-job-lifecycle` — read `src/async-job-manager.ts`,
   `src/job-store.ts`, and `src/__tests__/async-job-manager*.test.ts` end to
   end. Document the lifecycle states (start / running / completed / failed
   / orphaned) and identify the exact callsites where `safeFlightStart` and
   `safeFlightComplete` should fire. Output: a short markdown research note
   under `docs/personal-mcp/ASYNC_FLIGHT_RECORDER_SURFACES.md`.

2. `extend-async-job-manager-deps` — give `AsyncJobManager` a
   `FlightRecorderLike` constructor dependency (defaulted to
   `NoopFlightRecorder` for backwards compat in tests). Thread the existing
   `prep` fields (`stablePrefixHash`, `stablePrefixTokens`, `effectivePrompt`,
   `resolvedModel`) through `startJob()` so the FR write has the data.

3. `wire-flight-start-on-startjob` — call `safeFlightStart` at the top of
   `startJob` with the correct entry shape (mirror the sync-path call at
   `src/index.ts`'s claude/codex/gemini/grok/mistral_request handlers).

4. `wire-flight-complete-on-terminal` — call `safeFlightComplete` from the
   three terminal-state code paths: success, failure, orphaned-recovery.

5. `codex-parser-cached-input-tokens` — small targeted edit to
   `src/codex-json-parser.ts` to also accept `cached_input_tokens` as a
   source for `cache_read_tokens`. Prefer the new name when both are
   present (CLI version detection is not necessary; both fields cannot
   co-exist in a real Codex emit).

6. `add-tests` — new tests:
   - `src/__tests__/codex-json-parser.test.ts` covers the new field name.
   - `src/__tests__/async-job-manager-flight-recorder.test.ts` (new file)
     verifies that an async job written through a `CapturingFlightRecorder`
     (pattern already used in `src/__tests__/prompt-parts-tool-wiring.test.ts`)
     produces FR rows with `stable_prefix_hash` populated on `start`,
     `cache_read_tokens` populated on `complete` for codex/claude rows, and
     `status = "orphaned"` on the restart-orphan code path.

7. `verify-cache-state-now-includes-async` — extend
   `src/__tests__/cache-state-resources.test.ts` (or add a new test) to
   verify that `cache_state://global` and `cache_state://prefix/{hash}`
   correctly aggregate async-job rows after the wiring lands.

8. `update-docs-and-changelog` — `PROVIDER_CACHE_SURFACES.md` "Implications
   for slice 2" paragraph (which currently says codex `cache_read_tokens`
   stays null) is now wrong; update it. CHANGELOG `[1.7.0]` entry covers
   both pieces of work explicitly. Blog-cache-awareness "What's next"
   section gets a follow-up note saying these landed.

9. `release-readiness-check` — `npm run check` clean, all 5 review units
   approved, draft PR body in `docs/plans/async-flight-recorder.pr-body.md`,
   then cut `chore(release): 1.7.0` and follow the release flow.

## Review cycle per step group

Group the 9 steps into ~3 review units:
- **Unit A** = research + dag.toml + extend-async-job-manager-deps (foundation).
- **Unit B** = wire-flight-start + wire-flight-complete + codex-parser-fix +
  tests (implementation).
- **Unit C** = verify-cache-state + docs/CHANGELOG + release-readiness
  (release).

Run each unit through all 4 reviewers in parallel (single message, 4 tool
calls). On request_changes, fix and re-review with verbatim round-1 finding
+ per-finding response (FIXED + diff summary, or DISAGREE + file:line
evidence). Never respond with assertion alone.

## Memory references (full file paths)

- `/home/werner/.claude/projects/-srv-repos-internal-verivusai-labs-rvwr-llm-cli-gateway/memory/MEMORY.md` — index
- `…/memory/feedback_no_coauthored_by_trailer.md` — commit-message style rule
- `…/memory/feedback_multi_llm_review_gate.md` — review gate behaviour
- `…/memory/reference_llm_cli_gateway_release_flow.md` — release pipeline
- `…/memory/project_provider_modernisation_phases.md` — broader plan

## Release sequencing reminder

After all 3 review units approve and master is green:
1. Bump `package.json`, `package-lock.json` (`npm version 1.7.0 --no-git-tag-version --allow-same-version`), and `integrations/llm-plugin/pyproject.toml` to `1.7.0`.
2. Add `## [1.7.0] - <YYYY-MM-DD> — async-path flight recorder + codex parser fix` to CHANGELOG.
3. Commit `chore(release): 1.7.0` (no trailer).
4. Push origin master, then mirror to public/main, watch CI + security green.
5. `gh release create v1.7.0 --repo verivus-oss/llm-cli-gateway --title "..." --notes-file <path> --target main` (gh auth as `verivusOSS-releases`).
6. Watch the three publish workflows (`npm-publish.yml`, `publish.yml`, `release-installer.yml`) all exit 0.
7. Verify on npmjs + pypi + GitHub release page.

## After this slice ships

The natural next slice is **slice 4 (cache-aware multi-LLM routing)**. That
needs 24+ hours of `cache_state://global` dogfooding data from real use, so
do not start it the same day as v1.7.0 ships. Note it in
`docs/plans/cache-awareness.dag.toml`'s comments as "blocked on observability
data" and leave it for the next session.

Slice 5 (explicit Claude `cache_control` injection via stream-json — Branch A)
is a separate plan; it requires a live smoke test against the Anthropic API
with a real account, which is a human-in-the-loop step.

## Done definition

- New files: `docs/plans/async-flight-recorder.dag.toml`,
  `docs/plans/async-flight-recorder.pr-body.md`,
  `docs/personal-mcp/ASYNC_FLIGHT_RECORDER_SURFACES.md`,
  `src/__tests__/async-job-manager-flight-recorder.test.ts`.
- Modified files: `src/async-job-manager.ts`, `src/codex-json-parser.ts`,
  `src/index.ts` (constructor wiring), `src/__tests__/codex-json-parser.test.ts`,
  `src/__tests__/cache-state-resources.test.ts`, `CHANGELOG.md`,
  `docs/personal-mcp/PROVIDER_CACHE_SURFACES.md`,
  `docs/launch/blog-cache-awareness.md` (small "what's next" follow-up note).
- `npm run check` exits 0.
- All 5 review units (or 3 grouped units) unanimously approve.
- v1.7.0 published to npm + PyPI + GitHub release with installer artefacts.
- CI + security workflows green on the release commit.

Start by reading the four context files at the top, then write the
`async-flight-recorder.dag.toml` plan, then run Unit A review on it before
implementing.
