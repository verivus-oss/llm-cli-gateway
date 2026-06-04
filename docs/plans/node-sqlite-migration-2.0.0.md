# Plan: prod-only shrinkwrap (1.17.9) + node:sqlite migration (2.0.0)

Status: APPROVED — 4/4 unconditional cross-LLM approval, BOTH phases
(Codex gpt-5.5, Gemini, Grok, Mistral Vibe; final round 2026-06-04 — §9b)
Author: gateway release engineering, 2026-06-04
Reviewers: Codex, Gemini, Grok, Mistral (adversarial, evidence-based — see §9)

## 0. Motivation (evidence)

Every supply-chain incident across 1.17.6 → 1.17.8 traces to `better-sqlite3`'s
install path, not its runtime:

- Socket P0: transitive `tar-stream@2.2.0` via `better-sqlite3 → prebuild-install
  (deprecated, unmaintained) → tar-fs@2` (CHANGELOG [1.17.7]).
- `package.json#overrides` pins the repo tree only; overrides do not propagate
  to dependents (verified 2026-06-04 against the live registry).
- The 1.17.8 shrinkwrap pins consumers' `tar-stream@3.1.7` — but ONLY for
  registry installs (packument `hasShrinkwrap`); local-tarball installs
  ignore it. Citation precision [round-1: Codex]: npm/cli#7977 documents the
  shrinkwrap-ignored class for a remote (GitHub) registry package and notes
  local-tarball behaviour as a separate case — the local-tarball ignore is
  OUR OWN live reproduction on this host (npm 11.12.1, 2026-06-04: nested
  shrinkwrap present in tarball, 128/129-package flat install, tar-stream
  2.2.0 at top level), reproducible via the A3 script's tarball mode. Side
  effects: dev deps reified into consumer trees
  (npm/cli#4323; 316 vs 128 packages) and consumer `npm ls` exits ELSPROBLEMS
  because tar-stream 3.1.7 is outside tar-fs's `^2.1.4` range.
- Native-binding failure mode: `npm install` after an overrides change re-laid
  the better-sqlite3 subtree without running its install script → 82 test
  failures ("Could not locate the bindings file") during 1.17.7 prep.

`node:sqlite` (built into Node, Stability 1.2 release candidate as of Node
25.7, unflagged since 22.13) eliminates the entire class: no install scripts,
no prebuilt-binary download, no tar chain, no bindings.

Two phases. Phase A is shippable independently and immediately (1.17.9);
Phase B is the breaking change (2.0.0).

---

## Phase A — 1.17.9: prod-only shrinkwrap

### A1. Generator: `scripts/make-prod-shrinkwrap.mjs` (new)

Pure, deterministic filter from `package-lock.json` → `npm-shrinkwrap.json`:

- Drop every `packages` entry whose metadata has `dev === true`.
- Keep `optional` and prod entries unchanged (prod installs include optionals).
- In the root `""` entry, delete the `devDependencies` field (prevents npm
  attempting registry re-resolution of dev deps absent from the pruned tree —
  the SAP/ui5 workaround for npm/cli#4323).
- Preserve `name`/`version`/`lockfileVersion: 3`/`requires` verbatim; preserve
  key insertion order (JSON.stringify of the filtered object of the same
  source is byte-deterministic for identical input).

### A2. Pipeline changes

- `scripts/pre-release.sh` and `scripts/refresh-release-lockfile.sh`: replace
  `cp package-lock.json npm-shrinkwrap.json` with
  `node scripts/make-prod-shrinkwrap.mjs`.
- `scripts/release-security-audit.sh` "shrinkwrap presence + lockfile parity"
  gate: byte-identity (`cmp -s`) no longer holds. New parity rule: regenerate
  the expected shrinkwrap from `package-lock.json` via the same generator into
  a temp file and `cmp -s` against the shipped `npm-shrinkwrap.json`.
  (Determinism makes this exact; no semantic diffing needed.)

### A3. Registry-fidelity verification: `scripts/verify-registry-install.sh` (new)

Local-tarball installs ignore shrinkwraps (our live repro on npm 11.12.1,
2026-06-04 — see §0; npm/cli#7977 covers the adjacent remote-registry class,
with #5349/#5325 tracking local tarballs), so the existing
packed-consumer-install audit CANNOT observe what real consumers get. New
script, run by `pre-release.sh` (and manually before any release):

1. Start ephemeral verdaccio (`npx verdaccio`) on a random port with a config
   allowing anonymous publish to a throwaway storage dir.
2. `npm publish --registry http://localhost:<port>` the current tree.
3. Fresh consumer dir: `npm install llm-cli-gateway --registry ...`.
4. Assert: (a) `node_modules/llm-cli-gateway/node_modules/tar-stream/package.json`
   version is `3.1.7` (Phase A) — i.e. the shrinkwrap pin is honoured;
   (b) NO dev-dep markers present (`vitest`, `typescript`, `eslint`,
   `prettier` absent from the nested tree) — i.e. npm/cli#4323 bloat is gone;
   (c) `./node_modules/.bin/llm-cli-gateway --version` prints the version;
   (d) `node -e "require('better-sqlite3')"` from the nested package dir loads
   (binding built through the pinned tar chain).
5. Tear down verdaccio; temp dirs removed.

CI: not added to `ci.yml` in Phase A (verdaccio needs a port + npm cache
writes; runner flakiness budget is already spent on the test:ci shutdown
flake). Pre-release-gate only. Revisit after Phase B.

### A4. Record correction

CHANGELOG [1.17.9] must correct the [1.17.8] claim that the shrinkwrap is
"inert": it is honoured for REGISTRY installs (the real distribution channel)
and ignored only for local-tarball installs. Known residuals documented:
consumer `npm ls` ELSPROBLEMS (inherent to out-of-range pin; disappears in
Phase B), local-tarball installs still resolve tar-stream@2.2.0 (advisory
carve-out in the audit stays until Phase B).

### A5. Acceptance gate (Phase A)

- `npm run check` green (build, lint, format:check, full test suite,
  security:audit with regenerated-parity rule).
- `verify-registry-install.sh` passes all four assertions.
- Cross-LLM review (Codex+Gemini+Grok minimum) — unconditional approval on
  inspected code.

---

## Phase B — 2.0.0: node:sqlite behind a thin driver adapter

### B1. Current surface (verified inventory)

| Call site | Usage |
|---|---|
| `src/flight-recorder.ts:195` | lazy `createRequire`-based `require("better-sqlite3")` |
| `src/job-store.ts:186` | same |
| `db.exec` | 12× (DDL, pragmas: WAL, foreign_keys, synchronous=NORMAL) |
| `db.prepare(...).run/get/all` | 16 persistent statements (20 total `.prepare(` incl. 3 PRAGMA probes + 1 dynamic in `queryRequests`); MOST bind `@name` named params bare (`{id: ...}`), but `markOrphanedStmt`/`deleteExpiredStmt` use positional `?` (`job-store.ts:278-287`) — adapter must support both styles [round-2: Grok] |
| `db.transaction(fn)` | 2× — `flight-recorder.ts:302,347` (two-phase logging) |
| `db.close` | 2× |
| `stmt.readonly` | 1× — `flight-recorder.ts:404` writer-disguised-as-reader guard in `queryRequests` |
| `stmt.run().changes` | 2× — `job-store.ts:412` (markOrphaned count), `job-store.ts:421` (evictExpired count); job-store's `StatementLike.run` returns `any`, flight-recorder's returns `void` — the looser job-store contract hid this dependency [round-1 finding: Grok] |
| `PRAGMA table_info(requests)` via `prepare().all()` | 3× idempotent column migrations |

No STRICT tables, no FTS, no RETURNING in production SQL, no user-defined
functions, no `db.pragma()` API (audit enforces that), no `iterate`.
Both files already type against structural `DatabaseLike`/`StatementLike`
interfaces (`flight-recorder.ts:65-75`, `job-store.ts:31-40`) — the adapter
implements those shapes.

### B2. Adapter: `src/sqlite-driver.ts` (new)

Single shared module; both consumers import from it. Exports:

```ts
export interface GatewayStatement {
  // node:sqlite StatementSync.run() returns { changes, lastInsertRowid } —
  // job-store.ts:412,421 reads .changes (orphan-mark and eviction counts),
  // so the contract MUST surface it. Do NOT type as void. [round-1: Grok]
  run(...args: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get?(...args: unknown[]): unknown;
  all?(...args: unknown[]): unknown[];
}
export interface GatewayDatabase {
  exec(sql: string): void;
  prepare(sql: string): GatewayStatement;
  withTransaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void;
  close(): void;
}
export function openDatabase(dbPath: string): GatewayDatabase;
export function openReadOnly(dbPath: string): GatewayDatabase; // see B4
```

Implementation notes:

- `import { DatabaseSync } from "node:sqlite"` via the same lazy
  `createRequire`/dynamic-import pattern currently used, preserving the
  flight recorder's graceful-degradation path (constructor failure → recorder
  disabled, gateway still runs).
- `withTransaction` replaces better-sqlite3's `db.transaction`: wraps
  `BEGIN` / `COMMIT` with `ROLLBACK` on throw (deferred BEGIN — matches
  better-sqlite3's default). Nested-transaction use does not exist in the
  codebase (2 call sites, never nested) — assert/throw on nesting rather than
  emulating savepoints.
- Named parameters: node:sqlite's `allowBareNamedParameters` default (true)
  accepts the existing bare `{id: ...}` bind objects for `@id` placeholders —
  no SQL or bind-site changes.
- Integers: all numeric columns (tokens, durations, exit codes, timestamps as
  TEXT) are within `Number.MAX_SAFE_INTEGER`; default number mode is correct.
  `readBigInts` not used.

### B3. Consumer changes

- `flight-recorder.ts` / `job-store.ts`: replace the two `require("better-sqlite3")`
  blocks with `openDatabase(dbPath)`; replace `this.db.transaction(...)` with
  `withTransaction(...)`; delete the local `DatabaseLike` interfaces in favour
  of the adapter's exported types. SQL, schema, migrations, and pragmas are
  unchanged — `PRAGMA table_info` via `prepare().all()` works identically.
- Data compatibility: no schema migration, but NOT assumption-free
  [round-1: Grok]. Engine version skew is real: better-sqlite3@12.10.0
  bundles SQLite **3.53.1**; Node 24.15.0's node:sqlite is **3.51.3** — the
  upgrade path (1.17.8 → 2.0.0) opens databases last written by a NEWER
  engine with an OLDER one, including possible `-wal`/`-shm` recovery after
  unclean shutdown. The schema uses plain DDL (no `user_version` coupling),
  which lowers risk but does not prove it. REQUIRED acceptance artifact
  (added to B8): a cross-engine WAL fixture test — create + populate
  logs.db/jobs.db under better-sqlite3 with WAL files left behind (simulated
  unclean stop), then open read/write under node:sqlite and run the full
  flight-recorder + job-store suites against it; mirror fixture for the
  rollback direction. "Zero migration" is claimed ONLY once that test is
  green.

### B4. The `stmt.readonly` guard (security-relevant change)

node:sqlite's `StatementSync` does not expose better-sqlite3's `.readonly`
flag, which `queryRequests` (`flight-recorder.ts:404`) uses to block
writer-disguised-as-reader SQL (finding codex-r1/F3). Replacement is
STRONGER, not emulated: `queryRequests` runs on a dedicated read-only
connection — `new DatabaseSync(path, { readOnly: true })` — so write attempts
fail at the SQLite engine level (SQLITE_READONLY), not via a JS property
check. The existing behavioural test ("non-readonly SQL throws") must keep
passing with at most an error-message assertion update. WAL mode permits one
writer + concurrent readers across connections in-process.

### B5. Dependency & policy cleanup (the payoff)

- `package.json`: MOVE `better-sqlite3` from `dependencies` to
  `devDependencies` [round-2: Grok] — it is retained at dev time
  DELIBERATELY: (a) `src/__tests__/flight-recorder.test.ts:9` and
  `src/__tests__/test-veracity-regressions-slice-kappa.test.ts:35` require
  it directly to seed legacy-schema DB files (simulating databases written
  by older gateway versions — that realism is the point; do not port them
  to the adapter), and (b) the B3/B8 cross-engine WAL fixture needs a
  better-sqlite3 writer. `@types/better-sqlite3` (package.json:106) stays in
  devDependencies for the same reason. The PROD graph must be clean:
  acceptance = packed tarball's prod dependency graph contains no
  better-sqlite3 (asserted by the A3 registry-fidelity check: absent from
  the consumer tree) and `npm test` is green with better-sqlite3 absent
  from `dependencies`. Remove the `tar-stream` entry from `overrides` (keep
  `type-is`/`content-type` pins — unrelated to this chain);
  `engines.node` → `>=24.4.0` (see §B7).
- `scripts/release-security-audit.sh`: delete the `consumerAdvisory`
  carve-out and the tar-stream blocklist advisory branch (the chain no longer
  exists in any tree — blocklist entries stay as hard-fail tripwires); delete
  the better-sqlite3 pragma-API scan or repoint it at the adapter.
- `scripts/pre-release.sh`: delete the better-sqlite3 binding sanity guard;
  `npm ls tar-stream` step becomes an absence assertion
  (`! npm ls tar-stream` after install, or grep the lockfile).
- `verify-registry-install.sh` assertions update: tar-stream and
  better-sqlite3 must be ABSENT from the consumer tree; consumer `npm ls`
  must exit 0 (no out-of-range pins remain → ELSPROBLEMS gone).
- Shrinkwrap: KEEP (prod-only, from Phase A) — it still pins the full
  transitive tree for registry consumers, now without any out-of-range entry.
- Consumer tree shrinks by the better-sqlite3 prod subtree (**~32 packages**,
  traced from the committed lockfile). Corrected arithmetic [round-1:
  Mistral]: the v1.17.8 lockfile holds 123 prod + 192 dev entries (+ root).
  Phase A (prod-only shrinkwrap) takes registry consumers from 316 reified
  entries to ~124; Phase B takes them to **~92**. Exact numbers asserted in
  the registry-fidelity check after implementation.

### B6. Docs (grep-verified mention list [round-1: Mistral])

In-repo files that mention better-sqlite3 and need updating:
`README.md` — specifically the security-audit table rows at README.md:1183
(better-sqlite3 PRAGMA-helper scanner — that audit check itself changes in
B5) and README.md:1184 (dependency-ownership row citing `bindings` via
better-sqlite3) [round-1: Codex]; `socket.yml` (documented
child_process/native notes); `package.json` (description untouched;
deps/overrides per B5); `docs/personal-mcp/RELEASE_READINESS.md`.
`docs/guides/BEST_PRACTICES.md` EXISTS (round-1 conflict resolved: Codex
right on path, Mistral wrong on existence) but contains zero better-sqlite3
mentions — re-verify at implementation, no content change expected.
Historical plan docs
(`docs/plans/cache-awareness.implementation-prompt.md`,
`docs/plans/xstate-store-integration.md`, `docs/plans/slice-kappa-captures/README.md`)
are records of past work — leave unmodified. `.cursorrules` exists but has no
better-sqlite3 mention (re-verify at implementation). `BEST_PRACTICES.md` and
a repo-root `CLAUDE.md` do NOT exist in this repo — the agent-guidance
CLAUDE.md that names better-sqlite3 lives OUTSIDE the published repo at
`/srv/repos/internal/verivusai-labs/rvwr/CLAUDE.md` (workspace level); update
it in the same change but note it is not part of the npm artifact.
CHANGELOG [2.0.0] with explicit BREAKING section (engines).

### B7. Engines decision

Proposed: `>=24.4.0` [floor raised from 24.0.0 in round 1: Codex].
- Node 20 is EOL (April 2026 — already past).
- **`allowBareNamedParameters` defaults to `true` only from Node 24.4** —
  on 24.0–24.3 the bare `{id: ...}` binding style used throughout
  `flight-recorder.ts`/`job-store.ts` (e.g. flight-recorder.ts:288,
  job-store.ts:233) would need `setAllowBareNamedParameters(true)` per
  statement. Floor 24.4 makes the default safe; the adapter ALSO gets a unit
  test asserting bare-name binding works, so a regression in either
  direction is caught (verified working on this host's 24.15).
- Stability note: node:sqlite is Stability 1.1 (active development) in
  24.0/24.4 docs and 1.2 (release candidate) in later doc sets. This plan
  ACCEPTS Stability-1.1 Node 24 minors ≥24.4 explicitly: the adapter pins
  our API surface to 7 methods, and the driver test suite gates observable
  behaviour — doc-stability label changes without behavioural change cannot
  break us undetected.
- The installer bundles the build host's Node 24; CI runs 24.
- Alternative `>=22.13.0` widens reach at the cost of a second CI matrix
  lane, pre-default bare-params handling, and an older bundled SQLite
  (extra B3 risk). OPEN QUESTION for review: is Node 22.x reach worth that?
  Default answer in this plan: no — 2.0.0 targets >=24.4.0.

### B8. Tests + standing test-veracity audit

- New: `src/__tests__/sqlite-driver.test.ts` — adapter unit tests: open/exec/
  prepare/run/get/all/close, withTransaction commit + rollback-on-throw +
  nesting-throws, bare named params, read-only connection rejects writes,
  WAL pragma effective (`PRAGMA journal_mode` returns `wal`), missing-directory
  creation, open-failure degradation path.
- Existing: most regression suites construct the real classes against temp
  DB files and transparently exercise the new driver. CORRECTION [round-2:
  Grok — the earlier "run unchanged" claim was false]: two suites require
  better-sqlite3 DIRECTLY for legacy-schema seeding
  (`flight-recorder.test.ts:9`, `test-veracity-regressions-slice-kappa.test.ts:35`,
  usage through ~377 and 435–540 respectively). These are NOT ported to the
  adapter: they intentionally keep writing seed files with devDependency
  better-sqlite3, simulating databases produced by pre-2.0.0 gateways —
  which makes them standing cross-engine coverage (old-engine writer →
  node:sqlite production reader) in every CI run, complementing the B3
  crash-recovery fixture. Acceptance: full `npm test` green with
  better-sqlite3 in devDependencies only.
- New: cross-engine WAL fixture test (see B3) — better-sqlite3-written DB
  (incl. live `-wal`/`-shm` from a simulated unclean stop) opened and
  exercised under node:sqlite, and the reverse for rollback.
- **Standing test-veracity audit (per the ε protocol, format per the
  exemplar specs — e.g. `docs/plans/test-veracity-audit-slice-theta.spec.md`)**:
  before release, the NEW test additions get a strict-evidence
  mutation-probe audit — spec authored on disk as
  `docs/plans/test-veracity-audit-sqlite-driver.spec.md`, 4–5 LLM auditors,
  ≥90 s polling cadence. Per the exemplar format, every probe row must
  record the **observed** failing test (run, not asserted) at audit time
  [round-1: Mistral]. Minimum probe set with candidate detectors (final
  names fixed when the tests exist):
  (1) sabotage `withTransaction` to skip ROLLBACK → expected detector:
  `sqlite-driver.test.ts` "withTransaction rolls back on throw";
  (2) drop `readOnly: true` from the queryRequests connection → expected:
  flight-recorder suite "queryRequests refuses non-readonly SQL";
  (3) break bare-named-param binding → expected: driver test "binds bare
  @name objects" plus broad flight-recorder/job-store failures;
  (4) swap WAL pragma to DELETE journal → expected: driver test "journal_mode
  is wal";
  (5) return `{changes: 0}` unconditionally from `run()` → expected:
  `job-store.test.ts` orphan-count and eviction-count assertions
  (`job-store.test.ts:257,295` today);
  (6) corrupt the cross-engine fixture handling → expected: the B3 fixture
  test. Probes that fail to kill any test are audit findings, per protocol.
- B4 connection-lifecycle tests [round-1: Codex]: read-only connection
  open/close lifecycle (no fd leak across recorder close), write rejection
  on the RO connection, busy/timeout behaviour with a concurrent writer,
  and the documented visibility semantics (separate-connection reader does
  NOT see uncommitted writer rows — verified acceptable: all queryRequests
  callsites are post-commit cache/readback paths).

### B9. CI

- `ci.yml`: matrix stays `[24]` per §B7 (or gains 22.13 if the open question
  resolves the other way).
- `npm ci --ignore-scripts` everywhere keeps working and now produces a fully
  functional tree (no postinstall needed by anything in the prod graph —
  verified at implementation by running the suite after an
  `--ignore-scripts` install; add that as a one-off check in pre-release).

### B10. Release sequencing & rollback

1. Ship Phase A as 1.17.9 (small, independently reviewable, corrects the
   1.17.8 record).
2. Phase B on a feature branch; full gate + registry-fidelity + test-veracity
   audit + cross-LLM review; ship as 2.0.0 via the standard mirror flow
   (release on verivus-oss triggers npm-publish with provenance).
3. Rollback 2.0.0 → re-add better-sqlite3 + tar-stream override + advisory
   carve-out (single revert commit). DB-file compatibility in both
   directions is exactly what the B3/B8 cross-engine fixture tests prove —
   the rollback claim inherits that gate and is NOT asserted independently
   of it [round-2: Grok].

---

## 9. Review protocol for this plan

VERIFIABLE against artifacts today: §0 (CHANGELOG 1.17.7/1.17.8, audit
script, registry behaviour reproducible), §B1 inventory (file:line cited),
§B2-B5 feasibility claims about current code structure, A1-A3 npm semantics
(npm/cli#7977, #4323; verdaccio approach).
UNASSESSABLE (no artifact yet): the adapter code itself, the generator
script, the new tests, exact consumer package counts post-B5, node:sqlite
behaviour differences not exercised by our API surface. Reviewers: critique
assumptions/risks/missing requirements for these and name the artifact that
would make each assessable — do not approve them.

## 9b. Review log (persistent evidence)

**Round 1 (2026-06-04, full-access reviewers: Codex gpt-5.5, Gemini, Grok,
Mistral Vibe — all read the repo and external sources themselves):**

- Gemini: UNCONDITIONAL APPROVAL. Independently probed B4 bypass vectors on
  Node 24.15: ATTACH on a readOnly connection cannot write
  ("attempt to write a readonly database"); `PRAGMA writable_schema=1` +
  sqlite_master UPDATE rejected. Verified chmodSync 0o600 retention
  (flight-recorder.ts:282, job-store.ts:224) and graceful degradation
  (createFlightRecorder try/catch → NoopFlightRecorder).
- Grok: BLOCKERS (all accepted and fixed in this revision):
  (1) `run(): void` contract false — job-store.ts:412,421 reads `.changes`
  → B1 row + B2 contract corrected; mutation probe 5 added.
  (2) "zero data migration" unevidenced across engine skew (better-sqlite3
  12.10.0 = SQLite 3.53.1 vs Node 24.15 node:sqlite = 3.51.3, newer→older
  open direction) → B3 rewritten, cross-engine WAL fixture test added (B8).
  (3) inventory wording (16 persistent vs 20 total prepares) → corrected.
  Also requested per-phase approval splitting — adopted (§9c).
- Mistral: BLOCKERS (all accepted and fixed in this revision):
  (1) B6 docs list wrong (BEST_PRACTICES.md / repo-root CLAUDE.md don't
  exist; real mention list grep-verified) → B6 rewritten.
  (2) consumer-count arithmetic (316→~58 / "~70 packages" unsupported;
  lockfile = 123 prod + 192 dev; better-sqlite3 subtree ≈ 32) → corrected
  to ~124 (Phase A) and ~92 (Phase B).
  (3) B8 probes lacked the protocol's observed-failing-test requirement →
  rewritten per exemplar spec format with candidate detectors.
- Codex: BLOCKERS (all accepted and fixed in this revision):
  (1) `run()` void contract (independent confirmation of Grok's finding,
  with job-store.ts:412,421 citations) → fixed as above.
  (2) **engines floor vs bare named params**: `allowBareNamedParameters`
  defaults true only from Node 24.4; 24.0–24.3 need the per-statement
  setter → B7 floor raised to `>=24.4.0` + driver unit test.
  (3) stability-label inconsistency (24.0/24.4 docs = Stability 1.1; RC
  label later) → B7 now explicitly accepts 1.1 minors ≥24.4 with rationale.
  (4) npm/cli#7977 citation imprecise for the local-tarball case (issue
  body covers a remote-registry package; local tarball noted as separate)
  → §0 rewritten to cite our own live repro as the local-tarball evidence.
  (5) BEST_PRACTICES.md exists at docs/guides/ (resolving Mistral's
  non-existence claim) with zero better-sqlite3 mentions; README.md:1183-84
  rows added to B6.
  (6) B4 read-visibility semantics change (separate-connection reader)
  verified harmless for current callsites; connection-lifecycle/busy tests
  added to B8.
  Codex independently confirmed: B1 otherwise complete (no iterate/pluck/
  raw/pragma()/backup/UDF/lastInsertRowid in production), prod-filter leaves
  124 entries incl. root with no devOptional in the current lockfile, and
  reproduced the local-tarball shrinkwrap-ignore on this host.

**Round 2 (same day; Codex via persistent session r2+r3, others fresh
sessions with full round-1 context):**

- Codex r2: BLOCKERS — three internal-consistency nits (stale `>=24.0.0` in
  B5 and §10 vs corrected B7; stale #7977 wording in A3); fixed.
  Codex r3: **UNCONDITIONAL APPROVAL, Phase A and Phase B** (verified all
  three fixes; scanned for stale references; none found).
- Gemini r2: **UNCONDITIONAL APPROVAL, Phase A and Phase B** (independently
  re-verified engine-skew versions and bare-params default on 24.15; judged
  the B4/B8 test list complete and the read-only-connection posture strictly
  stronger; recommended keeping engines >=24.4.0 and narrowing the adapter
  interface — both adopted as defaults).
- Mistral r2: **UNCONDITIONAL APPROVAL, Phase A and Phase B** (re-grepped
  B6 list, re-derived B5 arithmetic, confirmed B8 exemplar compliance).
- Grok r2: Phase A **UNCONDITIONAL APPROVAL**; Phase B BLOCKERS (both
  accepted and fixed in this revision):
  (1) "existing tests run unchanged" was FALSE — flight-recorder.test.ts:9
  and slice-kappa:35 require better-sqlite3 directly for legacy-schema
  seeding → B8 corrected: those suites deliberately stay on devDependency
  better-sqlite3 as standing old-engine→node:sqlite coverage.
  (2) cross-engine fixture needs a better-sqlite3 writer but B5 removed the
  dependency entirely → B5 now moves it to devDependencies (with
  @types/better-sqlite3), prod-graph cleanliness asserted via the A3
  registry check. Nits also fixed: B10 rollback claim now inherits the B8
  gate; B1 notes the positional-`?` statements (job-store.ts:278-287).

**Final round (same day):**

- Grok r3: **Phase B UNCONDITIONAL APPROVAL** — re-verified all five
  round-2 dispositions against the repo (line-exact: seeding usage through
  377 and 435–540; package.json:90/:106; A3-gate linkage; no stale
  `>=24.0.0` anywhere). Non-blocking nit recorded: B2 prose documents bare
  named params, positional `?` covered by B1 + variadic `run(...args)`.
- Codex r4 (delta): **approval stands — UNCONDITIONAL** (one-line evidence
  per edited section; confirmed both test files require better-sqlite3
  directly).
- Gemini (delta): **approval confirmed**; security question answered with
  evidence — devDependencies do not install transitively for consumers, and
  the A3 registry check + prod-only shrinkwrap assert the prod artifact
  stays clean, so devDep retention reintroduces no consumer exposure.
- Mistral (delta): **approval confirmed**; corrected B8 satisfies the
  test-veracity exemplar format; packed-consumer audit remains meaningful
  under the devDep policy.

**FINAL: Phase A 4/4 unconditional; Phase B 4/4 unconditional.**

## 9c. Approval granularity

Per-phase approval (requested by Grok): Phase A and Phase B are approved
separately. Phase A may ship as 1.17.9 once Phase A sections have
unconditional reviewer approval, independent of Phase B's status.

## 10. Open questions (for review)

1. Engines floor: `>=24.4.0` (default — bare-named-params default flip; see
   B7) vs `>=22.13.0` + CI lane + per-statement setter?
2. Should `verify-registry-install.sh` enter CI in Phase B (verdaccio on
   ubuntu-latest) or remain a pre-release-gate-only check?
3. Keep the structural `DatabaseLike` interfaces exported from the adapter,
   or narrow to exactly the used surface (proposed: narrow)?
4. node:sqlite is Stability 1.2 (RC). Acceptable for 2.0.0, or gate Phase B
   on it reaching Stable? (Default: acceptable — API frozen across 3 majors,
   and the adapter isolates us if it shifts.)
