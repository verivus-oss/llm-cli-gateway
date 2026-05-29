# Test-veracity audit — slice λ (gateway-owned worktree lifecycle)

> **Status: APPROVED 2026-05-28.** Architectural pivot to the gateway-owned
> model confirmed; scope = all 5 CLIs; recommendations on path location /
> auto-.gitignore / startup sweep accepted. This spec is the implementation
> guide AND the post-implementation audit anchor (same dual role as
> [slice κ](slice-kappa.spec.md)).

## 0. Architectural decisions (locked)

The Phase-4 audit grouped this slice as *"wire `-w/--worktree` on Claude /
Gemini / Grok"*. Live `--help` probes (claude 2.1.152, gemini 0.42.0, grok
0.1.210) confirmed uniform `-w` shape on those three, but inspection of
`Session.metadata` (present, mutable via `updateSessionMetadata`) and
`executor.executeCli` (already spawns children, just needs `cwd` threading)
showed a stronger model is available:

**The gateway pre-creates worktrees via `git worktree add`, then spawns
the child CLI with `cwd: <worktree-path>`. `-w` is NEVER emitted to any
CLI.** Decisions:

| # | Decision |
|---|---|
| Q1 | Gateway-owned model ✅ (not `-w` passthrough). |
| Q2 | Scope = **all 5 CLIs** (Claude / Codex / Gemini / Grok / Vibe). |
| Q3 | Worktree placement = `<repo-root>/.worktrees/<name>` (in-tree). |
| Q4 | Auto-`.gitignore` of `.worktrees/` = **no** (document in tool description). |
| Q5 | Startup sweep of orphaned worktrees = **deferred** (TTL eviction covers the common case). |

This satisfies Werner's 2026-05-27 design call verbatim ("gateway owns the
worktree lifecycle. Disconnected/dead agents reconnect to the gateway and
pick up worktree details from persistent session state. Cleanup only on
explicit `session_delete` or stale-TTL."). The model is universal across
all 5 CLIs without per-CLI flag wiring; `upstream-contracts.ts` is
unchanged.

---

## Scope

You will be auditing the **veracity of the tests** added across the
commits on branch `feat/phase-4-slice-lambda` of
`/srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway`. Master sits at
v1.14.0 (`ecaa556`).

The branch ships as v1.15.0. This audit answers: **do the new tests
prove what they claim, and would they go red if the feature broke?**

Slice λ adds a `worktree` parameter to all five `*_request` / `*_request_async`
tools. When set, the gateway:

1. Creates a fresh git worktree under `<repo-root>/.worktrees/<name>`
   via `git worktree add` (branched from HEAD by default, or `ref` if given).
2. Spawns the child CLI with `cwd: <worktree-path>` — the CLI sees a clean
   checkout and operates inside it.
3. Persists `worktreePath` on `Session.metadata`, so subsequent requests
   on the same session reuse the worktree without re-creating it.
4. On `session_delete` (or session TTL eviction), runs
   `git worktree remove --force <worktree-path>` before deleting the
   session record.

The gateway never emits `-w` / `--worktree` to any CLI (see §0). The
existing slice-ζ working-dir flags (`-C` / `--cwd` / `--workdir` /
`--add-dir` / `--include-directories`) remain unchanged.

**Out of scope (explicitly deferred — not in slice λ):**

- Grok's `worktree` subcommand (`grok worktree create/list/remove`) — a
  CLI management surface, not a request-path flag. The gateway exposes
  request-path features only.
- Claude's `--tmux` (requires `--worktree`, interactive/TUI-only).
- Startup sweep of orphaned `.worktrees/*` entries without matching
  session records (Q5 above).
- Worktree `ref` validation beyond `git rev-parse` (the user owns the
  semantics of the ref).
- Multi-repo / git-submodule worktree semantics.

## Files under review

```
src/worktree-manager.ts                                   # NEW: createWorktree / removeWorktree / sanitizeName helpers
src/session-manager.ts                                    # MODIFIED: deleteSession + evictExpiredSessions call worktree cleanup hook
src/executor.ts                                           # MODIFIED: executeCli accepts optional cwd override
src/async-job-manager.ts                                  # MODIFIED: startJobWithDedup threads cwd through to executor
src/index.ts                                              # MODIFIED: 5× *_request + 5× *_request_async gain `worktree` Zod field; handler resolves cwd before spawn; result includes worktreePath when applicable
src/upstream-contracts.ts                                 # UNCHANGED (gateway-owned model; no per-CLI flag wiring)
src/__tests__/worktree-manager.test.ts                    # NEW: unit tests for worktree-manager helpers
src/__tests__/test-veracity-regressions-slice-lambda.test.ts  # NEW: REGRESSIONS Lα–Lη (mutation-probe-friendly)
docs/plans/slice-lambda.spec.md                           # NEW: this spec
```

## Reproducibility commands (run these — do not trust the spec)

```bash
cd /srv/repos/internal/verivusai-labs/rvwr/llm-cli-gateway
git log --oneline master..HEAD
git diff master..HEAD --stat
git diff master..HEAD -- src/worktree-manager.ts src/session-manager.ts src/executor.ts src/index.ts

# What every reviewer must replicate:
npm run build
npm test
npm run format:check
```

## Implementation surface to verify

### 1. `src/worktree-manager.ts` (new module)

Exports three pure-ish functions plus a typed result:

```ts
export interface WorktreeHandle {
  name: string;       // sanitized
  path: string;       // absolute, ends in `<repo>/.worktrees/<name>`
  ref: string;        // resolved git ref (commit SHA after rev-parse)
  createdAt: string;  // ISO timestamp
}

export interface CreateWorktreeOptions {
  repoRoot: string;             // gateway resolves caller's cwd's repo
  name?: string;                // sanitized; UUID4 if absent
  ref?: string;                 // default: "HEAD"; resolved via rev-parse
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle>;
export async function removeWorktree(handle: Pick<WorktreeHandle, "path">): Promise<void>;
export function sanitizeWorktreeName(input: string): string; // throws on invalid
```

**Sanitization rules** (mirror git-ref validity + path-traversal defense):
- accepts `[A-Za-z0-9._-]{1,64}`
- rejects: empty, `..`, leading `.`, leading `-`, contains `/` or `\` or
  null bytes or whitespace
- truncates UUID4 generation to 32 chars (no hyphens) for default names

**`createWorktree` flow** (each step has a regression in §Test surfaces):
1. `name = opts.name ? sanitizeWorktreeName(opts.name) : randomUUID().replace(/-/g, "")`.
2. `worktreePath = path.join(opts.repoRoot, ".worktrees", name)`.
3. Validate `worktreePath` starts with `opts.repoRoot + "/.worktrees/"`
   via `path.resolve` (path-traversal defense — even though sanitize blocks
   `/`, defense-in-depth matches the slice-β realpath pattern).
4. `resolvedRef = (await git("rev-parse", "--verify", opts.ref ?? "HEAD")).trim()`.
5. If `worktreePath` already exists (`fs.existsSync`):
   - If a matching `git worktree list --porcelain` entry exists at that path
     → reuse (return handle); this is the resume / session-reuse case.
   - Otherwise → throw `WorktreeCollisionError` (a stale directory with no
     git registration).
6. `await git("worktree", "add", "-b", `gateway/${name}`, worktreePath, resolvedRef)`.
   - The `-b` creates a new branch from the ref so the worktree is on a
     dedicated branch (avoids accidentally mutating master / current branch).
   - Branch name is namespaced under `gateway/` to make cleanup orderly.
7. Return `{ name, path: worktreePath, ref: resolvedRef, createdAt }`.

**`removeWorktree` flow**:
1. `await git("worktree", "remove", "--force", handle.path)`.
2. `await git("branch", "-D", `gateway/${handle.name}`)` — best-effort,
   ignore non-zero exit (branch may already be gone if user merged it).
3. Errors during remove are logged via `logger.warn` but DO NOT throw —
   `session_delete` must always succeed for the caller.

All git invocations use `child_process.spawn` with `cwd: opts.repoRoot`,
inherited PATH, captured stdio, and a 10s timeout. No `git` library
dependency — direct exec only.

### 2. `src/session-manager.ts` modifications

- New optional dependency in `FileSessionManager` constructor:
  `worktreeCleanup?: (path: string) => Promise<void>`. When provided, called
  before deleting a session record (`deleteSession`) or evicting an expired
  session (`evictExpiredSessions`). When absent (existing tests + libs that
  don't care about worktrees), no-op — preserves backward compat.
- `Session.metadata.worktreePath` reads/writes via the existing
  `updateSessionMetadata` helper. No new fields on the `Session` interface
  itself — `metadata` is the extension point by design.

### 3. `src/executor.ts` modifications

- `executeCli` signature gains optional `cwd?: string`. When set, passed
  to `spawn` as `options.cwd`. When absent → existing behaviour (inherits
  parent cwd).
- The 50MB output cap, SIGTERM→SIGKILL termination, PATH extension all
  unchanged.

### 4. `src/async-job-manager.ts` modifications

- `startJobWithDedup` accepts optional `cwd` and threads it to
  `executeCli`. The dedup-hash MUST include `cwd` in its input — two
  identical prompts in different worktrees are NOT duplicates.

### 5. `src/index.ts` modifications

Each of the 10 tools (`claude_request`, `codex_request`, `gemini_request`,
`grok_request`, `mistral_request` + 5 `*_async`) gains an identical Zod
field:

```ts
worktree: z
  .union([
    z.boolean(),
    z.object({
      name: z.string().min(1).max(64).optional(),
      ref: z.string().min(1).max(255).optional(),
    }).strict(),
  ])
  .optional()
  .describe("Run this request inside a dedicated git worktree…"),
```

Handler resolution flow (shared helper `resolveWorktreeForRequest`):

1. If `worktree` is `undefined` / `false` → return `cwd: undefined`,
   `worktreePath: undefined`. No worktree side effect.
2. If session exists and has `metadata.worktreePath` AND the path still
   points at a registered worktree → return that path (resume reuse).
3. Otherwise create a new worktree:
   - `name = worktree === true ? undefined : worktree.name`
   - `ref = worktree === true ? undefined : worktree.ref`
   - `handle = await createWorktree({ repoRoot, name, ref })`
   - If a session exists, `updateSessionMetadata(sessionId, { worktreePath: handle.path })`.
   - If no session exists yet → the worktree is **request-scoped** only
     (not persisted; gateway cleans it up at end of request unless caller
     also provides `sessionId`). Document this in the tool description.
4. Pass `cwd: handle.path` to `executeCli` / `startJobWithDedup`.
5. On success, the tool result includes `worktreePath: handle.path` in the
   structured-content portion so the caller can read/write files into it.

Tool-result contract: when `worktreePath` is returned, the caller can
`Bash(cd <path> && …)`, `Read <path>/file`, etc. The path is stable across
all requests on the same session until `session_delete`.

### 6. `src/upstream-contracts.ts`

**Unchanged.** No per-CLI flag is wired. The contract gate operates on
emitted argv; argv is identical to non-λ behaviour (slice ζ flags only).
If any future contributor wires `-w` to a CLI by mistake, the contract
gate will catch it (unregistered flag → REGRESSIONS F failure).

## Test surfaces — REGRESSIONS Lα–Lη (mutation-probe-friendly)

Located at `src/__tests__/test-veracity-regressions-slice-lambda.test.ts`.
Each block follows the slice-ζ / slice-κ template: a **falsifiability
preamble** comment naming the exact mutation that turns the test red, then
mechanical assertions.

### Lα — `sanitizeWorktreeName` rejects path traversal
**Mutation probe**: change `sanitizeWorktreeName` to skip the `..` /
slash checks. Lα MUST go red.
Assertions: `sanitizeWorktreeName("../etc")`, `"foo/bar"`, `"foo\\bar"`,
`".hidden"`, `"-flag"`, `"name with space"`, `""` all throw.
`sanitizeWorktreeName("alpha_beta-1.0")` returns `"alpha_beta-1.0"`.

### Lβ — `createWorktree` resolves the ref before passing to `git worktree add`
**Mutation probe**: change `createWorktree` to pass `opts.ref ?? "HEAD"`
directly to `git worktree add` instead of the rev-parsed SHA. Lβ MUST go
red.
Setup: mock `git` exec to record argv. Assertion: when `ref: "HEAD"`, the
4th positional to `git worktree add` is a 40-char SHA, NOT the literal
`"HEAD"`. (Rationale: pinning the ref at request time avoids "HEAD moved
between rev-parse and add" races, even if rare.)

### Lγ — Worktree path is recorded on session metadata
**Mutation probe**: remove the `updateSessionMetadata(sessionId, { worktreePath })`
call. Lγ MUST go red.
Setup: real `FileSessionManager` against tmp dir + mocked git. Assertion:
after a request with `worktree: true` and an active session, the
session's `metadata.worktreePath` equals `handle.path`.

### Lδ — Subsequent requests on the same session reuse the worktree
**Mutation probe**: in `resolveWorktreeForRequest`, always call
`createWorktree` (skip the reuse branch). Lδ MUST go red.
Assertion: mock `git` exec; call the tool twice with the same `sessionId`
and `worktree: true`. `git worktree add` is called exactly once.

### Lε — `session_delete` removes the worktree before deleting the record
**Mutation probe**: comment out the `worktreeCleanup` invocation in
`session-manager.deleteSession`. Lε MUST go red.
Assertion: with a session whose `metadata.worktreePath` is set, calling
`session_delete` triggers `removeWorktree` (verified via cleanup-hook spy)
before the session row disappears from storage.

### Lζ — `executor.executeCli` honors the `cwd` argument
**Mutation probe**: drop `cwd` from the `spawn` options object in
`executor.executeCli`. Lζ MUST go red.
Assertion: spawn is invoked with `options.cwd === <expected path>`
(spawn-spy pattern from existing executor tests). When `cwd` is omitted,
spawn is invoked WITHOUT a `cwd` key (preserves backward compat).

### Lη — No CLI receives `-w` or `--worktree` in emitted argv
**Mutation probe**: in `prepareClaudeRequest` (or any other prepare fn),
add `args.push("-w")`. Lη MUST go red.
Assertion: for each of the 5 CLIs, call `prepareXRequest({ ...,
worktree: true })`; the emitted argv contains neither `"-w"` nor
`"--worktree"`. Also asserts the contract gate
(`validateUpstreamCliArgs`) succeeds with the emitted argv — the
contract-table-as-second-oracle pattern from slice δ.

### Lθ — Dedup hash includes cwd (async job dedup correctness)
**Mutation probe**: omit `cwd` from the input to the dedup-hash function
in `async-job-manager.startJobWithDedup`. Lθ MUST go red.
Assertion: two `claude_request_async` calls with identical prompts but
different `worktree.name` produce different dedup hashes (so both
actually execute, vs the buggy world where the second one returns the
first's cached result).

## Reviewer checklist — confirm by running, not by reading

Per slice-ζ / slice-θ / slice-κ protocol, every reviewer MUST:

1. Reproduce all 8 mutation probes above. For each, observe the cited test
   goes RED (and only the cited tests — collateral damage is fine to
   report but not blocking). Restore the tree (`git checkout -- src/`)
   before the next probe.
2. Run `npm run build && npm test && npm run format:check` on a clean
   tree — all three green.
3. Run the gateway's contract gate
   (`validateUpstreamCliArgs("claude", emittedArgv)` etc.) with manually
   constructed argv that includes `-w` — expect contract violation.
4. Verify `git worktree list --porcelain` shows only `gateway/<name>`
   branches after a test run that creates worktrees (no leftover
   detached worktrees).
5. (Optional but recommended — slice-η lesson) Run reviews in an
   isolated worktree (`git worktree add /tmp/lambda-audit-<reviewer>`)
   to avoid concurrent-mutation stomping.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| `.worktrees/` directory pollutes user repo | High (by design) | Document in tool description; recommend `.gitignore` entry. |
| Worktree created but git-add to branch fails | Low | createWorktree uses `git worktree add -b` atomically; failure leaves no partial state (`git worktree add` is transactional). |
| `git worktree remove` fails (locked, in-use) | Med | Use `--force`; log warn; don't block `session_delete`. Stale worktrees collected on next gateway start (deferred — see §0 Q5). |
| Race: concurrent requests on same session both create worktree | Low | `resolveWorktreeForRequest` is single-threaded per request; if two parallel requests on the same session both miss the metadata check, the second `git worktree add` fails (path exists) and falls into the reuse branch on retry. Acceptable for v1; add a per-session async-mutex in λ.1 if dogfood shows it. |
| Worktree branch `gateway/<name>` collides with user branch | Negligible | `gateway/` prefix + UUID name; sanitization blocks user-provided collisions. |
| Slice-ζ `--add-dir` + worktree interaction (caller passes both) | Low | They compose cleanly: worktree sets cwd; `--add-dir` adds extras within it. Document; add an integration test in Lε's suite. |

## Generalizable lessons to encode (for the post-release memory update)

- "Gateway-owned" architectural pattern: when an audit groups several
  per-CLI flags but the gateway can implement the feature itself in one
  place (e.g. via `cwd`), prefer the gateway-owned route. It's universal,
  has fewer contract-gate surfaces, and avoids per-CLI behavior drift.
  Worktree is a clean example — `--worktree` is "make a checkout and
  chdir into it" which is a primitive the gateway has via `git worktree
  add` + `spawn({ cwd })`.
- `Session.metadata` is a stable extension point. Future per-session
  state (e.g. background-prefetch handles, named output schemas, etc.)
  should land there before considering Session schema changes.
- The contract-as-negative-oracle pattern (Lη asserts argv does NOT
  contain `-w`) is the dual of the contract-as-positive-oracle pattern
  from slice δ. Both deserve representation in any new slice that
  intentionally diverges from a "wire this CLI flag" audit recommendation.

---

**Pre-coding checklist (all checked 2026-05-28):**
- [x] §0 architectural pivot approved by Werner.
- [x] Q2 scope confirmed: all 5 CLIs.
- [x] Q3 worktree placement confirmed: `<repo-root>/.worktrees/<name>`.
- [x] Q4 auto-`.gitignore`: no.
- [x] Q5 startup sweep: deferred.
- [ ] Branch `feat/phase-4-slice-lambda` cut from master at v1.14.0.
