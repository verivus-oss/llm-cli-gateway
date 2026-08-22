# Changelog (draft entry for 3.2.0)

Consolidates the 3.1.0 candidate line, the post-rc.8 release-blocker fixes and
the storage-unification programme into one release entry. The cross-LLM review
fixes (#269 through #272) and the grok 1.0.4 / devin 3000.4.25 contract
rebaseline shipped in rc.8, so they are no longer a separate "after rc.7" set.
The number moves to 3.2.0 because the storage programme lands on top of that
line; `package.json` is already at `3.2.0-rc.1`.

Verified against the code, not against the candidate notes. Every claim in the
three entries at the head of `### Fixed` was re-checked mechanically before this
was written: contract state by enumerating declarations per provider, binary
behaviour by probing the installed CLIs with a control that proves the probe can
detect the thing it is looking for, and telemetry claims against a month of
production flight-recorder rows. The storage entries were re-checked the same
way, against `src/storage/`, `src/flight-recorder.ts`,
`migrations/022_flight_recorder_transcripts.sql`, `setup/status.schema.json` and
the recorded node status in `docs/plans/storage-unification.dag.toml`, rather
than against the programme's own summary.

Commit count is taken at `1dbc8d6`, the tip of `fix/p0-release-blockers` (PR
#281), and must be re-taken when the stable is cut, since the merge commit will
move it.

## [3.2.0] - 2026-08-22: provider contracts that maintain themselves, one storage port under all three subsystems

500 commits since 3.0.0. The gateway now notices when a provider CLI has moved
underneath it, applies the upstream deprecation instead of queueing it for a
human, and stops treating an absence of provider output as evidence that a job
is stuck. It no longer treats an absence of reviewer output as agreement
either. And `[persistence]` stops being a setting that governs one subsystem out
of three: the job store, the session store and the flight recorder now sit on
one storage port with a SQLite driver and a PostgreSQL driver under it, so a
request's two halves can finally live in one engine.

Read the two limits before assuming they do. Request history follows
`[persistence].backend` **only where the database can be proven local**, and
when it does, **nothing already written is migrated**. Both are stated in full
under Changed, and both are visible on `llm_process_health`.

Candidate history, since it is not a straight line. rc.1, rc.2, rc.6, rc.7 and
rc.8 were published to npm as 3.1.0 candidates. rc.3 and rc.4 exist in
`package.json` history and carry no surviving tag in either repository. rc.5 was
tagged, never published (see the publishing note under Security), and
additionally disabled gateway-managed worktrees on Postgres-backed hosts. There
will be no 3.1.0 stable; the first candidate under the new number is
3.2.0-rc.1, and anyone on any 3.1.0 candidate should move to it.

### Added

- **A storage port, with a SQLite driver and a PostgreSQL driver, under all
  three durable subsystems.** `src/storage/` defines one `StorageDriver`
  (`withConnection`, `transaction`, `close`), and the job store, the session
  store and the flight recorder now reach their database through it instead of
  each owning its own connection handling and its own dialect. Every operation
  declares what class of work it is, as data rather than as a literal at the
  call site: `write`, `transcript_read`, `analytics_read`, `retention`. The
  driver routes each class to a runtime role: `app`, `reader`, `analytics`,
  `retention`. `migrate` is deliberately not a runtime role, because a
  long-running gateway process holding owner-equivalent credentials would be a
  privilege regression; DDL stays with `npm run migrate`. Placeholder
  translation lives in the PostgreSQL driver and never in a caller.

- **`[persistence.roles]` in `~/.llm-cli-gateway/config.toml`**, so a deployment
  that has separated its database credentials can give each class its own DSN.
  It is a strict table: `reader`, `analytics` and `retention` only. `app` always
  comes from `[persistence].dsn`, and `app` and `migrate` are refused by name if
  written here. A misspelled role is refused outright rather than silently
  degrading a reader onto `app` while the operator believes separation is in
  force, and the whole table is refused unless `backend = "postgres"`. The role
  DSNs reach both driver sites, the job store and the session store. The startup
  `Storage:` block says whether separation is in force, partial or absent, and
  names any role that degraded.

  One call site changed role: job-store eviction now runs as `retention`, which
  is what lets `llmgw_app` hold no `DELETE` on `jobs`. Job-store reads
  deliberately stay on `app`, because `llmgw_reader` is scoped to the transcript
  tables and holds no grant on `jobs`; routing them to it would ask a credential
  for tables it cannot see. SQLite is unchanged by that, checked in code rather
  than assumed by symmetry: `READ_ONLY_OPERATIONS` in
  `src/storage/drivers/sqlite.ts` is `{transcript_read, analytics_read}`, so
  `retention` still resolves to the writable handle.

- **A PostgreSQL transcript schema**,
  `migrations/022_flight_recorder_transcripts.sql`. `requests` and
  `gateway_metadata` had only ever existed in SQLite, so this is new authorship
  rather than a translation, and the types were decided against `pg`'s measured
  behaviour rather than against the SQL standard. `DOUBLE PRECISION` not
  `NUMERIC`, and `INTEGER` not `BIGINT`, because `pg` returns both of those as
  strings: the "better" type would silently turn `cost_usd` and every token
  counter into a string at every reader. `datetime_utc` stays `TEXT` because
  `TIMESTAMPTZ` comes back as a `Date`, and `COUNT(*)` is cast to `::int` for
  the same reason. The bootstrap DDL and the migration are held identical by a
  control that applies both to real schemas and diffs `information_schema`.

- **A whole-operation transaction deadline**, `STORAGE_TRANSACTION_DEADLINE_MS`
  (60,000 ms), on `driver.transaction` for both engines from one constant. It
  ends the operation rather than abandoning it, which is the whole difference
  between a deadline and a `Promise.race`: rejecting a wrapper leaves the client
  running and the connection busy, and tells the caller a mutation failed that
  may still commit, which is precisely the ambiguity these timeouts exist to
  remove. PostgreSQL destroys the pinned client, so `COMMIT` can no longer be
  sent and the transaction cannot land. SQLite cannot use a timer at all, since
  a contended statement blocks for the full `busy_timeout` and a timer armed
  first only runs after it, so it reads the clock at each statement boundary and
  rolls back. The deadline is disarmed and checked in one synchronous block
  before `COMMIT`, because firing there is the only case that would manufacture
  the ambiguity. Bootstrap DDL and `withConnection` are deliberately unbounded
  and say so. Residual, measured rather than assumed: PostgreSQL does not notice
  a dead client mid-statement, so the backend survives the destroy until its
  statement ends, bounded by `statement_timeout`.

- **A `storage` block in `doctor --json`, at `schema_version` 1.1.** The report
  carried no storage health at all before this, so a corrupt or unreadable
  transcript database produced a report byte-identical to a quiet one. The block
  covers recorder state, file and WAL bytes, schema version, row counts,
  retention state and co-resident tables, and a corrupt recorder now sets
  `ok: false`. `null` in it means NOT MEASURED rather than zero, and
  `scanned: false` marks a caller that ran no asynchronous scan.
  `setup/status.schema.json` forbids unspecified fields, so it moves to 1.1 with
  the block required. Any consumer pinning `schema_version` to `"1.0"` must
  move.

- **`provider_version_guard`, a read-only tool that compares installed provider
  CLI versions against the contract the gateway carries.** The comparison
  itself is offline: `src/provider-version-guard.ts` reads only
  `PROVIDER_TARGET_VERSIONS` in `src/provider-definitions.ts` and a supplied
  version map. Version strings are normalised first, because the seven CLIs
  disagree about whether to print their own product name and where to put it: on
  the current contract a naive equality check reports drift on two of seven
  correct installs (claude and cursor). States are `match`,
  `drift`, `not-installed` and `unknown`; only `drift` fails the summary. The
  tool is registered unconditionally, and it does spawn one `--version` probe
  per provider, so "read-only" means it mutates nothing, not that it is inert.
  This is the only new tool in the release (`site/tools.md` moves from 63 to
  64).

- **The same comparison runs once at gateway start, on both transports, and is
  silent unless something has drifted.** `runStartupVersionCheck` in
  `src/startup-version-check.ts` is fired and not awaited, so readiness is not
  delayed, and a failure inside it is logged at debug and cannot take the server
  down. Disable it with `LLM_GATEWAY_DISABLE_STARTUP_VERSION_CHECK` set to `1`,
  `true` or `yes`; any other value, including `0` and `false`, leaves it on.
  **Default-on.** The variable is currently documented only here and in the
  source.

- **`doctor` reports the version comparison rather than telling a human to go
  run it.** New `upstream.version_guard` section in the JSON report, schema in
  `setup/status.schema.json`. It is derived from the installed-version map the
  report already builds, so it spawns nothing extra and runs on every `doctor`
  invocation without `--probe-upstream`. `upstream.recommendation` now names the
  drifted providers.

- **Upgrade availability for provider CLIs, off by default.**
  `src/provider-upgrade-availability.ts` reports whether a newer version has
  been published: the npm registry for Claude and Codex, PyPI for Mistral, and
  Grok's own structured update check. Gemini, Devin and Cursor report `unknown`
  with a stated reason, because none of them exposes a check that is guaranteed
  not to install as a side effect. A probe that fails reports `unknown`; it
  never reports `current`. Network access is `node:https`, never `fetch`, which
  keeps the packed `dist/` clean for the release audit's fetch gate. It is
  reached only through `provider_version_guard` with `checkUpgrades: true`
  (**default false**), and `doctor` does not call it at all.

- **`npm run providers:rebaseline` and `npm run providers:rebaseline:apply`.**
  `scripts/rebaseline-provider-contracts.mjs` probes the installed binaries and
  rewrites the recorded contract in place: target versions in
  `src/provider-definitions.ts`, acknowledgements and subcommand entries in
  `src/upstream-contracts.ts`, and generation-table entries in
  `src/provider-codegen.ts`. Exit codes are the whole signal for a scheduled
  run: `0` clean, `2` drift that this tool rebaselined (or could, in report
  mode), `3` the gateway still references a flag the installed binary dropped.
  `scripts/provider-drift-check.sh` and
  `setup/systemd/gateway-provider-drift.{service,timer}` run it daily at 04:00
  with a 45 minute jitter, deliberately offset from the autoupgrade timer.
  **Entirely opt-in operator setup**: nothing installs or enables the units, the
  unit's `ExecStart` is a placeholder path, and neither `scripts/` nor
  `setup/systemd/` is inside `package.json#files`, so none of it reaches the npm
  tarball.

- **Mistral joins the Personal Agent Config Kit.** `mistral_request` and
  `mistral_request_async` are now Kit-capable alongside Claude and Codex, behind
  the existing `[personal_config].enabled` gate (**default false**, local
  callers only). Vibe has no bare flag and no prompt-inspection surface, so
  `src/mistral-kit-isolation.ts` builds the environment it reads instead: `HOME`
  and `VIBE_HOME` redirected into a fresh per-attempt directory whose exact file
  manifest is asserted before launch (`.vibe` and `.vibe/config.toml` required,
  `.agents`, `.vibe/skills`, `.vibe/agents` and `.vibe/tools` forbidden, and
  nothing else at the top level), a gateway-written `config.toml` with a
  match-nothing skill allowlist, an untrusted working folder, every ambient
  `VIBE_*` key deleted rather than overridden plus eight bare-name variables
  scrubbed, and a context prefix whose SHA-256 digest is bound to the isolation
  plan. Isolation plans are capability-tracked in a module-private `WeakSet` and
  are not a forgeable request surface. The redirected home has no keyring, so a
  Kit turn requires `MISTRAL_API_KEY` in the gateway process environment; it
  fails closed before any Kit session claim or job admission. Native continuity
  resumes from a stable gateway-owned session directory keyed by scope root plus
  config stamp. `config_recover_kit_attempt` accepts `provider: "mistral"`.

- **Per-provider Kit eligibility on three surfaces, all derived from one
  registry fact.** `doctor` gains `personal_config.provider_eligibility` for
  every provider (Kit support, isolation model, the required credential
  environment variable by name, and a blocker list), `config_status` gains
  `kitProviders`, and `provider_tool_capabilities` gains a `personalConfigKit`
  feature. All three read `personalConfigKit` in `src/provider-definitions.ts`,
  which is also what the admission gates read, so no surface can advertise a
  provider the gates reject. Credential state is presence-only; no value is ever
  reported, and a test pins that by setting a recognisable secret and asserting
  it is absent from the serialised status.

- **`outputDiscipline` on every provider in the registry.** It declares whether
  a provider's stdout advances while a job runs, whether the CLI flushes on
  SIGTERM, and carries the probe evidence for the claim. Under the default
  gateway argv, gemini, mistral, devin and cursor emit nothing until they exit;
  claude, codex and grok stream. Claude is the only one that flushes after
  SIGTERM. Surfaced on the provider capability rows as `outputStreaming` and
  `flushesOnSigterm`.

- **`workingDir` on `cursor_request` and `gemini_request`, sync and async.**
  Neither provider emits a cwd flag of its own, so the child cwd is the entire
  scoping contract for them, and neither tool previously had any input capable
  of changing it: an unscoped call ran in the neutral private cwd rather than
  the caller's repository. All 14 request tools now expose the field, through
  the same shared resolver, so remote containment and local canonicalisation
  behave identically. Cursor rejects a `workspace` absolute path that disagrees
  with an explicit `workingDir` rather than silently ranking them, and rejects
  `workingDir` outright on `transport: "acp"`.

- **`scripts/check-consumer-tree.mjs`**, a bidirectional tripwire over a fresh
  consumer's `npm ls --all --json`, replacing a bare exit-code check in
  `scripts/verify-registry-install.sh`.

- **`scripts/backfill-prompt-derivations.mjs`**, which fills the new
  flight-recorder derivation columns for pre-migration rows. Dry run by default,
  `--apply` to write, idempotent and resumable.

- **A real `/install` page and site-wide navigation on llm-cli-gateway.dev.**
  Seven secondary pages previously rendered with no navbar or footer and were
  dead ends, and the top nav pointed humans at raw markdown. Note this deploys
  only on a stable, highest release, so it is not live until 3.1.0 publishes.

- **Skill coverage for `llm_request_result` and `provider_version_guard`**,
  neither of which any shipped skill mentioned.

### Changed

- **`[persistence].backend` now selects the engine for request history as well,
  on a LOCAL deployment only, and migrates nothing.** Until this release the
  flight recorder was always SQLite regardless of `[persistence]`, so on a
  Postgres host the two halves of one request sat in two engines. The recorder
  now takes that decision at one point, `flightRecorderEngineDecision`, and
  there are two limits on it that matter more than the capability does.

  **The gate is deployment shape, and it fails closed.** `backend = "postgres"`
  is honoured only when the DSN can be PROVEN to reach a database running as
  this same OS user: a unix socket whose `.s.PGSQL.<port>` file this uid owns,
  or a loopback literal (`127.0.0.0/8`, `::1`, or their IPv4-mapped forms) or
  the bare name `localhost`, with a listener on that port whose uid in
  `/proc/net/tcp{,6}` equals this process's effective uid. A wildcard bind
  counts, because the reference rootless-podman deployment publishes through a
  userspace forwarder and a checker demanding a literal loopback bind would
  refuse the exact shape this rule exists to admit. Any other host name is
  refused WITHOUT resolution, because the decision is read by surfaces that
  cannot await one; write `127.0.0.1` if it is loopback. An unreadable `/proc`,
  an unparseable DSN, a platform with no effective uid: all refused. Anything
  refused stays on SQLite and says why, on `llm_process_health`, on
  `health://status` and in the startup `Storage:` block. A refusal is not a
  failure; the recorder keeps working.

  **There is NO data migration, in either direction.** A host that switches
  backend starts writing transcripts to the new engine, and the rows already in
  `~/.llm-cli-gateway/logs.db` stay exactly where they are. They are not
  backfilled, not dual-written and not read from. `llm_process_health` and the
  startup block both report the split, because the previous cutover in this
  project abandoned 31,895 rows in place and nothing said so. The lossless
  restartable backfill is a separate, human-supervised run, held by operator
  decision.

  **Disclosed and not fixed:** a loopback SSH tunnel or a `socat` forwarder
  defeats the check. It presents as a local listener owned by this user while
  the database is remote, and the check admits it. Closing that needs a
  server-side fact, and this decision has to be synchronous, so it cannot go and
  get one. Related: the uid the check proves is the LISTENER's, not the
  PostgreSQL backend's, and under rootless podman those differ by design.

  **Not exercised end to end.** No live gateway has been switched to
  `backend = "postgres"` and run through. The path is covered by the suite and
  by the `*-pg` suites against a real server, which is not the same claim.

  On a shared or remote PostgreSQL nothing changes: transcripts remain gated on
  steps 3 through 8 of `docs/plans/postgres-security-hardening.md`, and the
  refusal names that document.

- **The async job store runs on the storage port, and the PostgreSQL worker
  thread is gone.** `PostgresJobStore` used to run its work in
  `src/postgres-job-store-worker.ts` and block on each result, because the
  `JobStore` interface was synchronous. The interface is asynchronous now, the
  worker thread and its sync-over-async bridge are deleted, and Postgres job
  work runs on the driver's pool like everything else.

  Two consequences an operator can see. `canAdmitDurableJobs()` is a
  synchronous snapshot that several fail-closed gates read, and an asynchronous
  store cannot finish registering inside its constructor the way the synchronous
  one did; inside that startup window the first Kit request would be refused
  `kit_busy`, the API sync path would run inline and skip dedup, and
  `llm_process_health` would report async jobs disabled. `main()` now awaits
  `whenStartupSettled()` before connecting a transport, and the job manager
  awaits it at every public entry point that observes durable state. And
  `jobStore.close()` is awaited in shutdown, which it was not: the bounded drain
  defeated itself.

  The conversion cost is recorded rather than glossed. Eighteen regressions
  landed on the branch invisible to both the suite and the assertion-parity
  gate, found only by diffing two complete runs, and five more in review, two of
  them durability defects: terminal persistence became re-entrant so the
  late-output rescue disarmed itself, and shutdown stopped waiting for non-Kit
  terminal writes.

- **The session store runs on the storage port, and `src/db.ts` no longer builds
  a second connection pool.** It had been constructing its own `pg.Pool` from
  `DATABASE_URL`, so a Postgres host ran two independent pools against one
  database with two different configurations. Twelve hand-rolled transactions
  are the driver's now, and no `pg` import survives outside
  `src/storage/drivers/`.

  A blocker recorded earlier in this line turned out to be wrong and is
  withdrawn: four drifted `CHECK (cli IN ...)` lists in `migrations/001` and
  `003` were said to reject devin and cursor on a Postgres host. The drift is
  real, the consequence is not. `migrations/005` already drops both enumerated
  constraints for a format regex and `006` never carried them, so a database at
  head admits every provider, proven by applying the real migrations with the
  pre-005 rejection as the control. They also cannot be corrected:
  `POSTGRES_IMMUTABLE_MIGRATION_SHA256` pins each file and the runner refuses a
  mismatch, so editing one byte would brick migration for every installation
  that has already run it. They are frozen with a pinned count instead, and the
  provider domain is asserted from `PROVIDER_TYPES` in a test.

- **`DATABASE_URL` precedence is durable data, not only a boot warning.**
  `resolveDatabaseUrlPrecedence` is the one place the rule lives, and the
  outcome is reported on `llm_process_health` as `deprecatedInputs`, so an
  operator who missed the startup line can still find out that the variable was
  ignored and why. Warn-and-refuse stays the behaviour rather than becoming a
  startup abort: a conflict is already fully determined and resolves to what the
  config file says, so aborting would protect nothing and would take down a
  mid-migration host over a variable the gateway ignores.

- **`backend = "none"` still does not silence the flight recorder**, and the
  startup block now says so out loud. Two subsystems, two switches:
  `[persistence].backend` governs async job persistence, and
  `LLM_GATEWAY_LOGS_DB=none` is the recorder's own switch, on either engine.
  This is unchanged behaviour made visible, not a behaviour change.

- **BREAKING: `grok_request` and `grok_request_async` no longer accept `bestOfN`
  or `check`.** Grok's CLI moved from `0.2.101` to `1.0.4` and stopped
  advertising `--best-of-n` and `--check`. The gateway passes through what the
  installed binary supports and nothing else, so both parameters are gone from
  the schemas, the argv builder, the generation tables and the capability
  surface. Calls that set them now fail schema validation instead of producing a
  request the provider rejects at argument parsing.

- **BREAKING: `devin_request` no longer accepts `agentConfig`.** Devin dropped
  `--agent-config`. Same rationale; the removal touched 22 references in
  `src/index.ts`, none of which spell the flag.

- **BREAKING for hosts already on Postgres: the session store now follows
  `[persistence]`.** It previously had a selector of its own, `DATABASE_URL`,
  and nothing set it, so `createSessionManager` took the file branch on hosts
  whose `[persistence].backend` was `"postgres"` and the sessions stayed in
  `~/.llm-cli-gateway/sessions.json` while every other subsystem was on
  Postgres.

  There is no opt-in step and no automatic migration. On upgrade, a host with
  `backend = "postgres"` reads sessions from Postgres; the existing
  `sessions.json` is not read, not migrated and not deleted, so prior sessions
  become invisible until backfilled. `src/migrate-sessions.ts` performs the
  backfill and is a manual `node dist/migrate-sessions.js` invocation, not an
  npm script. If the database was created by the job-store path and
  `npm run migrate` was never run against it, the `sessions` table may not
  exist: the gateway will start and the first session operation will throw with
  the migration command in the message. `doctor` does not detect an orphaned
  file store.

  **The cutover also removes a retention bound.** The file session store evicts
  on a 30-day TTL (`DEFAULT_SESSION_TTL_SECONDS`, applied by
  `FileSessionManager.evictExpiredSessions`). The PostgreSQL store has no
  equivalent: `createSessionManager` computes `sessionTtlMs` and passes it only
  on the file branch, and `PostgreSQLSessionManager` has no TTL, no `isExpired`
  and no eviction. A `cleanup_expired_sessions(max_age_days)` function is
  defined in `migrations/001` and `migrations/009` but is never invoked from
  `src/`, so it runs only if an operator calls it by hand. After this upgrade,
  and after `migrate-sessions` imports the file backlog, the `sessions` table
  grows without bound. On the reference dev host that is 1728 rows accumulating
  at 300 to 450 per week, 82% of which are never used again after creation.
  Prune out of band until a reaper ships. Tracked in
  `docs/plans/durable-state-lifecycle.dag.toml`.

  `DATABASE_URL` remains as a deprecated override that warns once. It is refused
  when it disagrees with `[persistence].dsn`, and refused when
  `[persistence].backend` is explicitly written as `"sqlite"`, `"memory"` or
  `"none"`, because honouring it would put sessions in one database and jobs in
  another. It is still honoured when no `[persistence]` block is configured at
  all, which is the one remaining case where sessions and jobs can differ; that
  is the pre-`[persistence]` behaviour of deployments that never adopted the
  config file, and refusing it would silently move their sessions to an empty
  file store.

  On its own this did not complete the single-store goal, and an earlier draft
  of this entry said prompt and response bodies stay in SQLite behind a
  deliberate gate. That gate has since been re-drawn: on a deployment the
  gateway can prove local, transcripts follow `[persistence]` too. See the
  entry at the head of this section for the shape of that proof and for what it
  does not cover.

- **The idle timeout is derived from the registry, and terminal-burst providers
  get a total-runtime bound instead.** A hand-maintained table gave gemini,
  mistral and cursor a 600,000 ms *idle* timeout with comments asserting they
  "stream in real-time", which their own probed evidence contradicts. The timer
  never reset, so healthy work was killed at ten minutes: a real cross-LLM
  review job was terminated at exactly 600000 ms of "inactivity" having produced
  precisely the zero bytes its own registry entry predicts. `resolveIdleTimeout`
  now reads `outputDiscipline` and returns `TERMINAL_BURST_RUNTIME_CAP_MS`
  (3,600,000 ms, the schema maximum) for gemini, mistral, devin and cursor.
  **Behaviour change**: the default kill time for those four moves from ten
  minutes to one hour, and devin gains a bound where it previously had none. The
  bound is kept rather than removed because `checkStalledJobs` only warns and
  never kills, so this timer is the sole protection against a hung child. An
  explicit caller `idleTimeoutMs` still wins.

  Cursor is the documented exception: with `outputFormat: "stream-json"` it does
  stream, so the same value behaves as a genuine idle window there.
  `resolveIdleTimeout` does not distinguish the two modes.

- **`npm run providers:rebaseline` applies upstream flag removals instead of
  reporting them.** When an installed CLI stops advertising a flag the contract
  declares, `--apply` deletes it from `src/upstream-contracts.ts` and from the
  contract-derived generation tables in `src/provider-codegen.ts` in the same
  run, together with the comments that described it, and drops stale
  `acknowledgedUpstreamFlags` on the same pass. This supersedes the 3.0.0
  behaviour where removals were reported for a human. `hiddenFromHelp` on a flag
  contract remains the way to declare "real but deliberately undocumented", and
  the writer refuses to remove such a flag.

  The hand-written argv emission in `src/index.ts` is reported with `file:line`
  rather than rewritten, because it is not derivable from a flag string. Exit
  code 3 changes meaning accordingly, from "a human must judge an upstream
  change" to "the gateway still references a flag the installed binary dropped",
  which is a defect in code this project owns. The JSON result drops
  `manualActionRequired` in favour of `residualReferences` and
  `staleAcknowledgements`.

  Note that `scripts/provider-drift-check.sh` and the systemd unit description
  still carry the pre-rc.4 wording and claim removals are never auto-applied.

- **All seven provider contracts rebaselined against installed binaries:**
  claude `2.1.212` to `2.1.233`, codex-cli `0.144.5` to `0.147.0`, Antigravity
  `agy 1.1.3` to `1.1.13`, grok `0.2.101` to `1.0.4`, vibe `2.20.0` to `2.24.1`,
  devin `3000.1.27` to `3000.4.25`, cursor-agent `2026.07.16` to `2026.08.11`.
  New upstream flags are acknowledged rather than emitted where the gateway has
  no corresponding input, including Antigravity's `--effort`, `--json-schema`
  and `--output-format`. Newly discovered root commands (`claude import`,
  `grok du`, `mistral mcp`, `cursor bedrock`) are catalogued with a conservative
  risk default and marked unverified pending maintainer review. `grok import`
  was replaced upstream by a read-only `grok doctor`; `devin shell` is gone.

- **Least-cost routing no longer reads prompt bodies.** `loadLcrPriorRows` bulk
  read `requests.prompt` on every load. It was the only production query that
  read a prompt body in bulk, and the blocker for encrypting the body columns at
  rest. `estimateInputTokens` touches its text in exactly two ways, `text.length`
  and `classifyContent(text)`, so those two signals are persisted at write time
  and the estimate is reconstructed from them. The tokenizer-family multiplier
  and the calibration factor are applied at read time from live values, so a
  change to either does not invalidate anything already stored. A property test
  over 2000 random inputs asserts the reconstruction is exactly equal to the
  original estimator, with a negative control showing that a mislabelled content
  class diverges.

  Flight-recorder migration v11 adds `derived_prompt_chars`,
  `derived_content_class` and `derivation_version` to the `requests` table.
  Signals are derived after redaction. Rows written before v11 keep NULL and are
  skipped for calibration rather than treated as zero, which would bias the
  ratios. `LcrPriorRow.prompt` is replaced by `LcrPriorRow.derivation`.

  Least-cost routing itself remains **dormant by default** behind
  `[least_cost].enabled` in `~/.llm-cli-gateway/config.toml`, which defaults to
  `false` and cannot be enabled by any environment variable.

- **`codex_fork_session` returns the reason it cannot run instead of spawning a
  child that cannot succeed.** `codex fork` is an interactive subcommand
  requiring a controlling terminal, and provider children are spawned with
  pipes, so every call failed with `exit code 1: Error: stdin is not a
  terminal`. Codex exposes no non-interactive equivalent. The tool now names the
  route that works (`codex_request` with a session UUID or `resumeLatest`). The
  availability check is deliberately evaluated after workspace resolution and
  argv admission, so a remote caller without a registered workspace still gets
  the containment error, and an oversized argv still surfaces
  `input_too_large` first.

- **A live Grok model catalogue now outranks the config file.** `ModelSource`
  priority is `fallback < observed < config < live < env`, so a freshly probed
  catalogue wins over a drifting `[models].default`, and an explicit environment
  override still wins over everything. Only Grok is bridged today. Grok also
  now skips the capability cache seed, so each resolve attempts a fresh probe.

- **`content-type` and `type-is` are no longer direct dependencies**, and
  `body-parser` moves from `2.2.2` to `2.3.0`. The `content-type` pin existed
  only so `body-parser` could reach the `^2.0.0` it requires, which npm already
  satisfies on its own; as a global override it also substituted a major into
  `@modelcontextprotocol/sdk` and `express`, which both declare `^1.0.5`. That
  substitution was not behaviour-neutral: `content-type` 2.x parses leniently
  where 1.x threw, and it inverted duplicate-parameter precedence, which changes
  the charset the SDK hands to its request-body reader.

- `client_config.vibe_session_logging` in the doctor report gained a `kit_note`
  recording that a Mistral Kit turn never reads `~/.vibe/config.toml`.

- The Kit scope-selection error message is derived from the provider's declared
  scope rule instead of a Claude-or-Codex branch.

### Fixed

- **A corrupt or unreadable `logs.db` looked exactly like a recorder the
  operator had switched off.** `createFlightRecorder` returned the same no-op
  recorder from two different situations, deliberate disablement and a failed
  open, and that no-op returns a successful empty result for every read. So an
  unreadable transcript database presented to `llm_process_health` as
  `LLM_GATEWAY_LOGS_DB=none` and to `doctor` as normal zero-valued data. That is
  the silent empty-success symptom of the June 2026 `logs.db` corruption, still
  present two releases later. An asynchronous schema-bootstrap failure was a
  third state again: it logged, and the real recorder object stayed installed.

  The recorder now carries five named states, `disabled`, `unavailable`,
  `initialising`, `degraded` and `active`, and ONE function owns the operator
  sentence for each, so no surface authors its own claim about why history is
  missing. They reach `llm_process_health`, `health://status`,
  `metrics://process-health`, the startup `Storage:` block, the new `doctor
  --json` storage block, and both request-history read tools, whose hints
  previously named `LLM_GATEWAY_LOGS_DB` as the only cause an empty answer could
  have. The health read is a synchronous snapshot, so it reports `initialising`
  rather than `active` for a recorder whose bootstrap has not settled.

  Degrading rather than crashing is deliberate and unchanged. Only the
  visibility changed. The faults were injected against real files rather than a
  stubbed flag: a truncated database and a garbage-header file both open
  successfully and then fail every operation, an unopenable path throws at
  construction, and a second writer dropping a table gives both a read and a
  write failure after a successful open. `RLIMIT_FSIZE` and a real 200 KB tmpfs
  produced `disk I/O error` and `ENOSPC` outside the test process.

- **Four durable writes were safe only because the store was synchronous and the
  next line could not yield.** Making the port asynchronous broke all four, and
  all four are now fixed with a control that fails on the unfixed code and was
  run in both states.

  `recordOutput` is fenced on an expected-status set the job manager decides
  once, on both engines, so an orphaned row stops absorbing this instance's
  output while its monotonic status hides the move, and the routine flush and
  the late-output write cannot disagree. A rejected write is now reported rather
  than discarded by a `void` return. The SQLite instance heartbeat is one
  transaction, as Postgres already was, so the orphan sweep cannot slot between
  the instance row and the job leases, and it returns an outcome, so a
  garbage-collected instance row is re-registered rather than heartbeated into
  nothing forever. A validation receipt, its run status and the read-back land
  in one transaction, so a run that cannot be finalised rolls the receipt back
  with it, and `stored ?? record` no longer reports `minted` for something that
  was never stored. And `sessions.last_used_at` comes off the client clock: it
  is `GREATEST(last_used_at, clock_timestamp())`, the database's own clock,
  chosen because the store is shared across instances and a wall clock on one of
  them is not an ordering.

- **Two concurrent turns on one session could leave the earlier turn's provider
  handle in the row, and both callers were told they had won.** Reproduced
  through the real request path against a real PostgreSQL server rather than
  inferred: 3 of 200 concurrent pairs, 9 to 38 of 200 at a synthetic 9
  microsecond dispatch gap, 1 to 7 of 30 with the pool saturated, and 0 of 50
  when the turns were awaited. Fixed with a compare-and-set on the metadata the
  turn actually read, chosen over a timestamp fence for the same reason as
  above. The semantics change and are worth knowing: the first committer owns
  the thread, and the loser is TOLD, through `sessionContinuityPersisted`,
  instead of a `void` return swallowing the loss.

- **An expiring file session deleted itself out from under a successful
  response.** `updateSessionMetadata` and `updateSessionUsage` ran the TTL check
  and evicted, on the one path that PROVES the session is in use, while the
  response reported success and handed the id back. The write is honoured now,
  and `lastUsedAt` is refreshed only where the row had actually expired.
  Honouring rather than refusing was chosen because the PostgreSQL store never
  carried the expiry check at all, so this makes the two engines agree instead
  of inventing a third rule. `updateSessionUsage` returns a boolean rather than
  `void`, so a lost write reaches the caller.

- **Every ACP flight-recorder write was being dropped in silence, and no lint
  rule could see it.** `AcpFlightSink` declared `logStart(entry): void`. Once
  the recorder became asynchronous its promises were absorbed by the TYPE, not
  by a missing `await` at any one call site, so nothing floated and nothing
  warned. The sink returns `Promise<void>` now, and the test checks the class of
  declaration rather than the site.

- **`logStart(x)` immediately followed by `close()` lost the row to the very
  call meant to save it.** `close()` drained the driver's queue but not the gap
  between an operation being called and reaching that queue. Related, and on the
  same shutdown path: `performShutdown` awaited the HTTP gateway, the server and
  the job store, but not `flightRecorder.close()`, which was harmless only while
  the recorder was synchronous.

- **Twenty places where a call stopped throwing and started rejecting, inside a
  `try` whose `catch` could therefore no longer fire.** Eleven of them lost a
  control rather than a log line, including `recordStartOrFailClosed` inverting
  on the path every async job takes. Graded, nine of them defects: one security,
  four durability, four correctness. Two of the mechanisms are worth naming
  because neither is visible to an ordinary review. Making a method `async`
  silently disarms every condition written against the synchronous one, because
  `!promise` is always false; seven such conditions had stopped being evaluated,
  among them an ownership guard and two terminal-write guards. And a shutdown
  drain bounded by `Promise.race` against a timer is not bounded at all when the
  queue starves the timer: measured running 2,598 ms past a 2,000 ms bound,
  rejecting nothing.

  Type-aware lint catches only the unawaited half. It reports nothing at all for
  a promise consumed as a `||` operand, verified as zero messages on the line.
  `npm run promise:conditions:check` is the type-checker gate built for the
  other half, it runs inside `npm run check`, and it found the ninth defect.
  `npm run storage:port:check` is the companion structural ratchet: SQL confined
  to the storage-owning modules, no `PRAGMA` or `VACUUM` outside them, and no
  new caller of the caller-supplies-the-SQL read that used to serve seven
  production sites with SQLite placeholders PostgreSQL does not accept. Its
  `PRAGMA` rule had been cited by name in the design since the port was proposed
  and was wired to nothing; when it was finally written it scanned template
  literals only, while every `PRAGMA` in the tree sits in a quoted string.

- **The gateway refused grok effort levels the binary accepts.** grok 1.0.4
  declares `--reasoning-effort <EFFORT>` with `[aliases: --effort]` and **no**
  possible-values set. The contract enum-locked the ALIAS with an invented
  five-level list and left the canonical spelling unenforced. Because `values`
  is a rejection list enforced by `validateUpstreamCliArgs`, the gateway
  actively refused input grok parses, which is the exact inversion of the
  pass-through principle the rest of this release is built on.

  Settled by experiment rather than by reading, with a control that proves the
  probe can detect an enum at all:

  ```
  grok --permission-mode bogus  ->  invalid value 'bogus' [possible values: ...]
  grok --reasoning-effort bogus ->  accepted (falls through to the prompt error)
  grok --effort bogus           ->  accepted
  ```

  The control is load bearing: clap reports enum violations in preference to the
  missing-value error, so the ABSENCE of an enum message is the signal.

  Three further defects sat with it. `grok_request_async` hand-declared the same
  enum while `grok_request` derived it, a repeat of the `outputFormat`
  divergence fixed earlier in this line; both derive now. The comment justifying
  the enum cited a `[possible values: ...]` help line the binary has never
  printed. And `--effort` / `--reasoning-effort` are one upstream option, so
  passing both emitted it twice and grok silently last-won; they are now
  mutually exclusive.

  Deliberately NOT changed, because the same probe gives the opposite answer:
  `--compaction-mode` and `--compaction-detail` also accept out-of-list values
  at parse, but they are `hiddenFromHelp` and the binary DOES document their
  value sets. `strings` on the executable recovers the text verbatim and both
  lists match the contract exactly. Parse acceptance alone does not distinguish
  an invented enum from a documented one.

- **Gemini was published as a cost-reporting provider and reports nothing.**
  Its least-cost-routing telemetry tier was T2, meaning "token counts present,
  cost derived", surfaced through `doctor --json`, the `routing://` MCP resource
  and `provider_tool_capabilities`. The Antigravity `agy` headless path emits
  text only and `prepareGeminiRequest` rejects `json` / `stream-json` before
  spawn, so the gemini arm of `extractUsageAndCost` and the whole of
  `gemini-json-parser` are unreachable code. Measured against a month of
  production traffic: 0 of 2241 gemini flight-recorder rows carry token counts.
  Now T4, matching devin and cursor.

- **Thirteen tool descriptions spelled the provider list by hand, and one set
  had drifted.** The `session_*` tools advertised six providers in prose while
  the Zod enum in the same schema object accepted eight, and that prose is
  published verbatim to `site/tools.fixture.json` and shown to every MCP client.
  Devin and cursor were invisible to anyone reading the tool surface despite
  both exposing a sessions resource. The CLI's own `--cli=` usage text omitted
  them too. All now derive from `CLI_TYPES`.

  `provider:surfaces:check` could not see any of it: the ratchet scans for
  hand-maintained provider ARRAYS, and these were words in a sentence. It now
  also rejects a piped provider run in prose, which is what found nine of the
  thirteen.

- **A reviewer that exited 0 with no output was counted as agreement (#269).**
  `normalizeJobResult` mapped an empty completed job to `verdict: null`,
  `summarizeDisagreement` filtered null verdicts out of the verdict set, the set
  stayed at size one, and `hasMaterialDisagreement` came out false. A silent
  reviewer and an approving reviewer were indistinguishable, in a gate whose
  only purpose is to surface disagreement.

  Observed rather than hypothetical: three mistral review jobs on 2026-08-15
  exited 0 with zero bytes after 10.7s, 60.5s and 35.1s. The operator was
  already working around it by hand, and the report was affected in a way that
  was not visible to them.

  The normaliser now records `emptyOutput` on a COMPLETED job with no output,
  reusing the field name the sync path already used. A failed empty job is
  deliberately not marked: that is already a terminal problem, and this flag is
  specifically about the deceptive case of success with nothing to show for it.
  `summarizeDisagreement` excludes those results from the agreement set, counts
  them toward `hasMaterialDisagreement`, and names the provider that went quiet
  rather than only reporting that something did.

  The same seat also had to be kept out of judge evidence one layer down.
  `startJudgeSynthesis` would otherwise tell the judge that a provider
  participated and hand it an empty contribution. Empty results are preserved in
  the report and omitted as evidence, and the synthesis note says how many.

- **Cursor and devin failed on every review seat, for different reasons
  (#270).** Neither failure was predictable from the gateway's own state.

  Cursor's review argv carried `--print`, `--mode plan` and `--sandbox enabled`,
  and never included `--trust`, so cursor refused with "Workspace Trust
  Required". This became deterministic rather than incidental once
  unscoped children started receiving a fresh neutral temp directory, because
  such a directory can never appear in cursor's `trusted_folders.toml`.

  Devin emitted `--sandbox` unconditionally for review and resolves it through
  bubblewrap, so on a host without `bwrap` every seat failed at spawn with
  "sandbox resolution failed", and nothing in the tree probed for it. The
  prerequisite is now checked before launch and the seat degrades to `skipped`
  with that reason. `--sandbox` is still emitted: the review asked for
  isolation, and silently running unsandboxed is not a smaller failure than not
  running.

  Trust is not granted unconditionally. `review-prompt.ts` fences the reviewed
  repository's evidence as untrusted data, never instructions, and `--trust`
  makes cursor load project rules, `AGENTS.md`/`CLAUDE.md` and project MCP
  configuration FROM THAT SAME REPOSITORY, which would let a reviewed repository
  instruct its own reviewer through a channel outside that fence. So `--trust`
  is emitted only where the operator already made that decision: the cwd is a
  registered `[[workspaces.repos]]` path whose `providers` include cursor, or a
  gateway worktree beneath one, or the caller passed the new
  `trustCursorWorkspace` on `review_changes`. It fails closed, and containment
  is nearest-match, so a narrower registration can withhold a provider its
  parent allows. Note this covers instruction loading only: cursor does not
  attach the repository's MCP servers on trust alone, which needs
  `--approve-mcps`, a flag this gateway never emits.

  That consent lives on the durable `ReviewRunAuthorization` rather than on the
  call, because the judge is started by `synthesize_validation`, a later tool
  call that cannot see `review_changes` arguments. The roster and the judge read
  one field and cannot disagree.

  Structurally, `launchProviderSeat` is now the only caller of
  `dispatchProviderJob`, computes both gates itself, and serves the roster and
  the judge alike. Four consecutive review rounds had found the same defect
  class in this file, a rule added to one caller while a second caller silently
  kept the old behaviour, so the second launch path was removed rather than
  patched again. `docs/plans/validation-launch-surface.dag.toml` maps the
  surface and `scripts/check-launch-surface-dag.mjs` verifies that map against
  the code as part of `npm run check`.

- **One provider missing from a workspace aborted the whole validation call
  (#271).** `resolveWorkspaceForProvider` throws when a provider is absent from
  the selected workspace's `providers` list. The orchestrator's catch handled
  `CliInputAdmissionError` and rethrew everything else, so a single unlisted
  reviewer took down an entire multi-provider validation. The blast radius was
  inverted: the least important participant could stop every other one from
  reporting.

  Easy to hit rather than theoretical. The ask-path validation tools
  (`validate_with_models`, `second_opinion`, `compare_answers`,
  `red_team_review`, `consensus_check`, `ask_model`) expose no `workingDir` or
  workspace input, unlike `review_changes` and `synthesize_validation`, so their
  cwd comes solely from the default workspace lookup and the caller has no way
  to influence it or to see why it failed. On the host this was found on, every `[[workspaces.repos]]` entry
  listed `["claude", "codex", "gemini", "grok", "mistral"]`, so any call
  including cursor or devin failed outright.

  A provider missing from a workspace is a configuration fact about that
  provider, not an error in the call, so it now takes the same path an admission
  error already took and is reported as `skipped` with a reason that names the
  remedy. Any OTHER workspace error is also reported as `skipped`, but carries
  its own message rather than the providers-list advice, which would be wrong
  guidance for it. An error that is not a workspace error at all still stays
  fatal.

- **`allow_unregistered_working_dir` was parsed and never read (#272).** The key
  validated, round-tripped through the config loader, and was documented as a
  setting, while no production code path consulted it. Setting it changed
  nothing and leaving it unset implied a restriction that was not enforced,
  which is the failure mode of a dead config key that reads as a security
  control.

  The loader now warns when the key is present. The warning splits by transport,
  because that is what actually decides: a remote HTTP caller always requires a
  registered workspace and is validated inside it, while a local caller passing
  an explicit `workingDir` gets that directory, except where a tool canonicalises
  it further, as `review_changes` does by promoting it to the containing Git
  repository root. The accompanying test walks all of `src/` and reports the
  offending file and line, so a production read added anywhere would fail it
  rather than quietly make the warning untrue. `README.md` and the three `docs/personal-mcp/` pages no longer
  describe the key as a live setting.

- **Gateway-managed worktrees work on Postgres-backed hosts.** 3.0.0 refused
  them outright when sessions were Postgres-backed, and rc.5 made that refusal
  bite for the first time by moving the session store onto `[persistence]`, so
  `worktree: true` failed closed on every Postgres host. The gate was an engine
  check standing in for the property that actually matters. A git worktree is a
  local filesystem artefact owned by exactly one host, and the hazard with a
  shared store is an instance on another host adopting or deleting a directory
  that only exists here. That hazard was already covered independently of the
  storage engine: reuse requires `worktreeOwnerHostname === hostname()` plus a
  live Git validation of the on-disk worktree, and cleanup runs with
  `expectedOwnerHostname` and `requireOwnerMetadata`, so a foreign-owned
  worktree is skipped rather than removed. `PostgreSQLSessionManager` now
  implements the cleanup-tombstone surface for real rather than returning `[]`
  and `false`, with the hostname filter applied in the SQL so another host's
  rows never enter this process. Recovery stays lazy and instance-scoped; there
  is no blanket startup sweep. Scoping is by host and not by process instance
  deliberately, because the instance id is a fresh UUID per process and
  requiring instance equality would break worktree reuse across an ordinary
  restart.

- **`migrate-sessions` discarded every source timestamp.**
  `FileSessionMigrationRecord` carried no `createdAt` or `lastUsedAt`, so the
  import stamped `new Date()` for both and collapsed a month of history into a
  single window. The damage was silent and downstream: ordering by
  `last_used_at` becomes arbitrary, and most-recent-session resolution picks
  effectively at random. (An earlier draft of this entry also cited expiry
  cleanup failing to reap sessions it thinks are minutes old. That consequence
  is moot: `cleanup_expired_sessions` is never invoked by the gateway, so
  nothing was reaping them either way. The ordering and resolution damage is
  real and is why the fix was made.) The
  source timestamps are now carried and written by the INSERT, and a row whose
  timestamps are not parseable is rejected rather than imported with the clock's
  value. `session_generation` is still regenerated on import, deliberately: it
  is a concurrency fence, and a fresh fence invalidates any stale holder.

- **`LLM_GATEWAY_LOGS_DB` or `LLM_GATEWAY_JOBS_DB` silently rewrote an explicit
  `[persistence].backend`.** Setting either forced the backend to `sqlite`, so
  an operator with `backend = "postgres"` could be moved off Postgres by a
  variable named for a different subsystem. An explicitly configured backend now
  wins and the override is refused with a warning naming the variable. The
  literal value `none` is exempt and still overrides, because it is a documented
  kill switch.

- **Provider output flushed during shutdown is no longer lost.** Cancellation,
  idle timeout and the output cap all commit a job's terminal row at the moment
  the signal is requested, but the child lives on through the SIGTERM grace and
  can still write. Both durable surfaces refused those bytes: the job store's
  completion write is fenced to non-terminal rows, so the close-time replay
  matched nothing, and the flight-recorder write was single-shot. Claude flushes
  between 1.9 KB and 8.3 KB after SIGTERM, and all of it was being dropped. Late
  output now lands through an unfenced output write that touches only stdout,
  stderr and the truncation flag, leaving status and error owned by the fenced
  terminal write, and the flight-recorder response is refreshed once the process
  is genuinely gone.

- **Late output cannot overwrite a terminal result whose completion write this
  gateway did not win.** `recordComplete` now returns whether the completion
  guard admitted the write, on all three job-store backends, and only an
  admitted completion licenses a post-terminal unfenced output write, on every
  path that reaches one, including the routine throttled flush. On a shared
  PostgreSQL store this prevents one instance's output from clobbering a result
  another instance had already committed.

- **The dead-process sweep no longer finalises a flight-recorder row early.** A
  vanished pid is not a drained pipe: Node still delivers buffered stdout before
  emitting `close`. Finalisation now waits for the close event rather than the
  sweep's speculative signal.

- **A sync handler could write a second flight-recorder completion after the
  async manager had been armed to own it.** When a job reached a terminal status
  during the sync deadline's poll sleep, the handler transferred completion to
  the manager,
  then a rejecting worktree cleanup landed in a catch that unconditionally wrote
  an inline completion anyway. Completion ownership is now explicit (`Mode A`
  handler-owned, `Mode B` manager-owned after deferral) and the inline write is
  a no-op once ownership has transferred.

- **Probing provider CLI versions no longer freezes the gateway.** Collecting
  the seven providers' versions ran up to two `spawnSync` calls each, so the
  work completed before the enclosing async function reached its first `await`
  and blocked the event loop for roughly five seconds, stalling every other
  in-flight request. All three callers (the startup check, the
  `provider_version_guard` handler and the `cli_versions` tool) now probe
  asynchronously and concurrently.

- **A `DEP0190` deprecation warning on every startup.** Executable lookup
  spawned `command -v` with an argument array and the shell option enabled,
  which Node deprecates and which printed into stderr, the MCP log channel, on
  every start. The lookup now walks the extended PATH directly with no child
  process.

- **An unactionable ERROR on every startup.** A legacy orphaned-artefact row
  with no captured scope can never acquire one, so the message recurred forever
  with no action available. It is now a single WARN per process that says so.

- **`routing://decisions` and `routing://priors` were unreachable in every
  configuration.** `index.ts` builds the live resource surface from explicit
  registration calls and never registered them, so they were absent from
  `resources/list` and answered `-32602` on read even with least-cost routing
  enabled. Both are now registered, gated on the same condition as the
  `route_request` tools (`leastCost.enabled` and the Personal Agent Config Kit
  not enabled), so the Kit withholds the observability surface exactly as it
  withholds the routing tools.

- **The test suite wrote into the user's live flight recorder, and later into
  the live session store.** `src/__tests__/setup.ts` deleted
  `LLM_GATEWAY_LOGS_DB` with a comment claiming that kept tests off the real
  database; it did the opposite, because the resolver falls back to the real
  file when the variable is unset. Sessions had the same defect class with no
  variable to pin: `FileSessionManager` resolved its default from `homedir()`,
  and because the manager evicts expired sessions on load, a test that merely
  constructed one deleted real rows. `resolveDefaultSessionStorePath()` now
  honours `LLM_GATEWAY_SESSIONS_FILE`, and the harness pins both variables per
  process. The sessions variable is not test-only scaffolding: an operator
  running two gateway instances on one host needs the same separation.

- **The documented Codex `sandboxMode` default was wrong on every surface that
  stated it.** Three schema descriptions, the `codex-request` plugin command,
  the dev.to tutorial and the supply-chain-guard runbook all said that omitting
  `sandboxMode` yields read-only. The gateway emits no `--sandbox` flag when the
  field is omitted, and Codex then resolves the policy from its own
  configuration, project trust and an internal fallback: the fallback is
  read-only, but a trusted project can resolve to `workspace-write`. Inspection
  should pass `sandboxMode: "read-only"` explicitly rather than relying on
  omission. The resume half is also corrected: `sandboxMode` cannot select a
  posture on a resumed request, and the resulting posture is not guaranteed to
  be inherited either, so establish it on the first request and verify it when
  it matters.

- **The documented Codex resume contract was wrong about the working directory
  and about which session `--last` selects.** Every surface said a resumed
  session keeps its original cwd and that `workingDir` cannot retarget it.
  Neither holds: `codex exec resume --last` is cwd-filtered upstream unless
  `--all` is passed, which the gateway never emits, so `workingDir` also
  determines which session `resumeLatest` picks, and although `-C`, `--cd` and
  `--add-dir` are filtered out of the resume argv the child is still spawned
  with the gateway-resolved cwd. Whether the code or the contract is the defect
  is a live question, so every surface now carries neutral interim guidance:
  do not rely on the resumed working directory or on which session `--last`
  selects; verify, or start a fresh session when the target must be certain.

- **Agent-facing guidance that contradicted the `workingDir` and
  `codex_fork_session` changes**, across four separate distribution surfaces:
  the npm-packaged skills, `README.md`, `provider_tool_capabilities` discovery
  text, and the Claude plugin skills under `skills/` declared by
  `.claude-plugin/plugin.json`.

- **Installing the package no longer leaves a consumer's dependency tree
  reporting `content-type` as out of range**, and concurrent gateway worktree
  cleanup no longer emits a spurious "not the expected Git worktree" warning for
  the losing claimant.

### Security

- **Publishing authority is separated from repository execution.** Until this
  release a single npm-publish job held `id-token: write`, checked out the
  repository, and then executed repository-controlled build, test, audit and
  packaging code. That is the same trust shape as the keyv/cacheable incident,
  where compromised source published a valid-provenance package through a
  legitimate workflow. The workflow is now two jobs: a `build` job with
  `contents: read` only, no OIDC identity and no registry credentials, which
  produces a tarball and its SHA-256; and a `publish` job that holds the
  identity, checks out nothing, runs no repository script, downloads the
  artefact and refuses it unless the digest matches. `release-site-contract.test.mjs`
  pins the split, including that the publish job matches neither `npm ci` nor
  `npm run`.

- **A release created by the tag-publish workflow does not start npm
  publishing.** The release is authored by `github-actions[bot]` using
  `GITHUB_TOKEN`, and GitHub deliberately does not start new workflow runs from
  `GITHUB_TOKEN` events. A comment claimed otherwise, and 3.1.0-rc.5 was created
  that way and silently never published. The workflow now says so in its job
  summary and names the manual dispatch command.

- **The committed lockfile is scored before any dependency code runs.** The
  supply-chain scan moved ahead of `npm ci` in both CI and the release build. A
  new `--allow-missing-dist` flag narrows only the fetch-in-dist invariant for
  that pre-install position; a present `dist/` is still walked in full, the
  strict form remains the default, and the pack job re-runs it after its build.

- **The registry-fidelity gate verifies the consumer dependency tree against a
  reviewed exception list instead of a bare `npm ls` exit code.** `overrides` is
  a root-only field, so a security pin that lifts a transitive past the range
  its parent declares always reads as `invalid` to consumers; treating that as a
  blanket failure gave no way to distinguish it from real tree corruption. The
  check is bidirectional: an unreviewed out-of-range package fails the release,
  and so does the disappearance of a reviewed pin, which is what silently
  shipping an unpatched transitive would look like. The one current entry is the
  `@hono/node-server` pin for GHSA-frvp-7c67-39w9, with its exit condition
  recorded beside it.

- **That gate is itself fail-closed now.** Its entry-point guard compared two
  spellings of the same path, so it skipped its whole body and exited 0 having
  verified nothing whenever the script path contained a URL-escaped character or
  was reached through a symlink, the second of which is reachable from the
  release script's own logical `pwd`. Both sides are canonicalised, the caller
  requires a positive whole-line marker rather than trusting an exit code, and
  the checker runs with `NODE_OPTIONS` and `NODE_PATH` cleared so an inherited
  preload cannot emit that marker before any classification has happened.

- **Advisories cleared in the shipped dependency closure**: `body-parser` to
  2.3.0 (GHSA-v422-hmwv-36x6 / CVE-2026-12590), `@hono/node-server` to 2.0.11
  (GHSA-frvp-7c67-39w9, GHSA-9mqv-5hh9-4cgg), `fast-uri` to 3.1.5
  (GHSA-7p8r-x3mc-p8w7), `hono` to 4.12.34 (GHSA-54fx-42gc-7vw4,
  GHSA-79qm-7rj5-m7r9, GHSA-8j4g-w8fx-2239, GHSA-f23p-vx2j-j53r), `ip-address`
  to 10.3.1 (GHSA-22jq-vg5j-6vgg, GHSA-4xrf-jv44-h6hh, GHSA-mwp4-54f8-5fhr).
  Dev-only: `brace-expansion` 5.0.9, `nanoid` 3.3.18 (GHSA-2v37-7h3g-55p8),
  `postcss` 8.5.23. Ten packages move version; nothing was added to or dropped
  from the graph.

  The `ip-address` review is worth reading in full: the published 10.2.0
  artefact does not match its own git tag, three of five sources disagree, and
  one of the disagreements is a URL regex that was hardened at the tag and never
  reached the tarball. None of it is a named advisory and none of it is
  reachable here, but 10.3.1 is the first artefact in this closure whose
  contents match the source it claims to be built from.

- **The Go bootstrapper installer builds on Go 1.26.6**, clearing GO-2026-5026,
  GO-2026-5972, GO-2026-6089, GO-2026-6090 and GO-2026-6218, which govulncheck
  rates reachable rather than merely present. Four workflows pin the toolchain
  independently and all moved in lock-step.

- **The provider-surface ratchet gained two patterns**: a hand-written Kit
  request-tool roster, and a two-way provider-label ternary. Both mislabel or
  omit every provider outside the pair, and both survived the Mistral Kit
  admission in `src/index.ts` reachable by no test, because the messages are
  redacted before any caller can observe them. A static gate is the only thing
  that can catch them.

- **`src/__tests__/skill-packaging.test.ts` enforces the shipped-skill boundary
  in both directions**, so a workflow skill cannot be silently dropped and a
  maintainer `provider-*` skill cannot be silently packaged. It compares against
  `git ls-files`, not the filesystem, because `npm pack` and a directory listing
  both see untracked files a consumer never receives.

---

Also in this release, and worth one line each rather than a section:

- **`devin_request` and `cursor_request` now emit terminal log lines.** The
  seven synchronous handlers were refactored onto one shared terminal envelope
  (`runKitTerminalEnvelope`, with `RequestTerminalLedger` and `FlightOwnership`
  underneath it; four of the five non-Kit async handlers moved onto
  `runAsyncEnqueueEnvelope`, mistral async did not). The envelope logs the three
  terminal lines unconditionally, and those two providers previously logged
  none, so anyone parsing gateway stderr for them will see new records.
  Otherwise the refactor is behaviour-preserving apart from the
  double-completion fence recorded under Fixed. It accounts for roughly 85% of
  the churn in `src/index.ts`.

- **Materially expanded test coverage.** `src/__tests__` grows from 228 to 258
  files and from roughly 3,208 to 3,493 tests, including per-provider
  terminal-state and net-output suites for all seven providers, async handler
  suites for four, cancel-and-output-retention suites driving real spawned
  children, and script-level suites for the contract rebaseliner and the
  consumer-tree gate.
