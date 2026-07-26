# Job output capture, progress, and cancellation semantics

Investigation date: 2026-07-26. Tree: `master` at `0eb325f`.

This separates what was **proved** from what was **inferred**. Three distinct
classes of evidence appear below, and they are not equally strong:

1. **Proved from the repo.** Statements about code, verifiable by reading this
   tree, and behaviour pinned by a test that fails before a change and passes
   after (each fix hunk was reverted independently to confirm this).
2. **Measured in this environment.** Every store-query result and every probe
   timing or byte count. These are real measurements against the live Postgres
   job store and the provider CLIs installed on this host. A reviewer **cannot**
   reproduce them from the repo alone, and they depend on provider CLI versions
   that drift. Treat them as dated observations, not invariants.
3. **Inferred.** Explicitly labelled at each point of use.

## Summary

Two things were wrong, and they are different in kind.

1. **A real gateway data-loss bug**, in two surfaces. Cancellation, idle timeout
   and output overflow write the job terminal at the moment the signal is
   *requested*, but the child lives on until its `close` event and may flush
   output in between. Both durable surfaces refused to record those bytes.
   Fixed, and all three paths are now covered by tests (see §4 for why the
   overflow case is subtler than it looks).
2. **A provider property that is not a gateway defect.** Four of the seven CLIs
   accumulate their whole answer internally and write it in one burst at clean
   exit. For those, a cancel genuinely has nothing to retain, because the bytes
   never left the child. Not fixable at this layer; now declared in the registry
   so callers can interpret `stdoutBytes: 0` instead of guessing.

## 1. The prior findings, re-derived

Both store queries from the prior session reproduce exactly, digit for digit
(28 rows and 11 rows respectively). *Evidence class 2*: this is a re-run against
the same live Postgres instance, not something a reader can verify from the
repo. The claims are therefore reproducible **here**, but two of the conclusions
drawn from them were wrong.

### Claim: three signals disagree. CONFIRMED, with one correction.

- `llm_request_result` (flight recorder) is strictly two-phase. `logStart`
  INSERTs (`src/flight-recorder.ts:567`) with no response column; `logComplete`
  UPDATEs `response` (`src/flight-recorder.ts:604`). Nothing writes `response`
  in between. **Proved by reading the only two statements that touch the column.**
- `llm_job_result` grows incrementally. **Proved**: the store currently holds a
  `codex | running` row with 182,925 bytes of stdout, so output *is* persisted
  mid-flight, not only at terminal.
- `llm_job_status` progress is a bounded ring. `droppedCount` increments in
  exactly two places, both bounded-buffer evictions: `prune()` when the ring
  exceeds `MAX_EVENTS = 64` or 32 KB (`src/job-progress.ts:438`), and a decoder
  carry reset past `MAX_PARTIAL_LINE_BYTES` (`src/job-progress.ts:392`).

  **Correction to the prior finding.** `droppedCount` climbing on a healthy job
  is expected ring behaviour, not "an actual loss of events an operator needed".
  The events are a lossy *projection*; the full byte stream is retained
  separately in `stdout`. No change made.

  Precision, after review: "nothing recoverable is lost" would overstate it.
  The progress ring drops only projection events, but `stdout` itself is capped
  by `max_job_output_bytes` (`outputTruncated`), so a job that overruns the cap
  genuinely does lose bytes. That is a separate, deliberate limit, not a
  `droppedCount` effect.

### Claim: `lastActivityAt` can go stale on a live job. CONFIRMED, and it matters more than stated.

`lastActivityAt` is set in `JobProgressTracker.ingest` (`src/job-progress.ts:383`)
on every chunk of either stream. It is therefore a true liveness signal **only
for a provider that emits chunks**. For the four terminal-burst providers below,
`ingest` is never called for the entire run, so `lastActivityAt` remains pinned
at job start on a perfectly healthy job that is minutes from succeeding.

This is why the prior session's fallback advice ("only `status` plus
`lastActivityAt` are meaningful for liveness") is **not sound**. On mistral,
cursor, devin and gemini, *neither* `stdoutBytes` nor `lastActivityAt` moves
until the job is over. There is no liveness signal at all for those providers,
which is precisely what the new registry fact declares.

Observed live while running this investigation's own cross-LLM review jobs,
90 seconds into three concurrent healthy jobs:

| Job | `stdoutBytes` | `lastActivityAt` | capability |
|---|---|---|---|
| codex | 631,885 | 21:02:26 (moving) | `structured` |
| grok | 533 | 21:01:38 (moving) | `activity_only` |
| **mistral** | **0** | **21:01:17 (frozen at job start)** | `activity_only` |

The mistral row is the claim, reproduced unprompted on a live job that later
completed successfully.

### Claim: the capture path is provider-agnostic. CONFIRMED.

`appendOutput` (`src/async-job-manager.ts:4495`), the `child.stdout.on("data")`
wiring (`:3846`), and `handleOutputChunk` (`src/executor.ts:739`) contain no
provider conditional, no `stdbuf`, no `PYTHONUNBUFFERED`, and no PTY allocation.
Confirmed as stated.

## 2. The bug: terminal status is committed before the child is dead

**Proved by test**, `src/__tests__/async-job-cancel-output-retention.test.ts`.

`cancelJob` (`src/async-job-manager.ts:4225`) sets `status = "canceled"` and
`finishedAt`, requests SIGTERM, and calls `persistComplete` **immediately** with
whatever stdout exists at that instant. The child then has the full
`PROCESS_GROUP_KILL_GRACE_MS = 5000` grace window to flush before SIGKILL.
Anything it writes in that window is appended to `job.stdout` in memory (proved:
the in-memory assertions in the test pass unmodified) but then hits two closed doors:

- **Job store.** The close handler calls `persistComplete` again, but
  `recordComplete` is fenced to `WHERE id = ? AND status IN ('queued','running','orphaned')`
  in all three backends (`src/job-store.ts:1257` sqlite, `:2551` memory,
  `src/postgres-job-store-worker.ts:998` postgres). The row is already
  `canceled`, so the second write matches **zero rows and is silently dropped**.
- **Flight recorder.** `writeFlightComplete` is single-shot
  (`flightRecorderComplete`, `src/async-job-manager.ts:2830`) and additionally
  clears `flightRecorderEntry`, so the close-time call returns at the first
  guard. `llm_request_result`, the documented full-response readback, keeps the
  pre-cancel snapshot.

The unfenced `recordOutput` path could in principle have rescued the store copy,
but it is throttled by `OUTPUT_FLUSH_INTERVAL_MS = 1000`
(`src/async-job-manager.ts:190`). So loss was **timing-dependent**: late output
arriving within a second of the last flush was lost, and output arriving after a
quiet second happened to survive. That non-determinism is itself the tell, and
it is why the first draft of the idle-timeout test passed before the fix and had
to be retuned under the throttle window to become discriminating.

### Who this actually cost

Measured, not assumed: **claude flushes 1,889 to 8,258 bytes after SIGTERM and
before close** (two independent probes). Those bytes were real answer content
and were being dropped. codex and grok do not flush on SIGTERM, so for them the
fix only removes the timing-dependence rather than recovering bytes.

### The fix

- `persistComplete` (`src/async-job-manager.ts:3048`): a new `terminalPersisted`
  flag, set after any **non-throwing** `recordComplete`, so a throwing call
  still retries through the existing Kit retry path while a guard-rejected one
  does not (the terminal state is settled, just not by us). Once this instance
  has committed the terminal row, later persists route their output through the
  unfenced `recordOutput`, which updates bytes without disturbing the committed
  terminal state. "Last committed terminal state wins" is preserved exactly.

  `recordComplete` now **returns whether the guard admitted the write** across
  all three backends, because the manager cannot otherwise tell "I committed
  this row" from "someone else already did". Settlement and ownership are
  tracked as two separate flags (`terminalPersisted` and `terminalRowOwned`),
  and only ownership licenses the unfenced late-output write. A first revision
  of this fix tracked one flag and refused only the IMMEDIATE write after a
  rejected guard, which still let the close-time persist overwrite the other
  writer's row. That is now pinned by a test which seeds a genuinely foreign
  terminal row and drives the full cancel-then-close sequence. Losing our copy
  beats corrupting theirs.
- `writeFlightComplete` (`:2922`): the row stays eligible for a re-write until
  `close` proves the process is gone. This works because `logComplete`'s two
  statements differ in fencing: the `requests.response` UPDATE is keyed on row
  id and **unfenced**, so the refresh lands, while the `gateway_metadata`
  UPDATE is fenced to `status = 'started'` (`src/flight-recorder.ts:629`) and
  matches no rows on the second pass. Saying the call is simply "idempotent"
  overstates it. In practice this is one write at the terminal decision plus
  one at close. Scoped to `transport === "process"`, since an http job has no
  close event to wait for.

Both are pinned by tests that fail before and pass after, verified by reverting
each fix hunk independently. Scope of that claim: it covers the two fix hunks,
the guard-rejection branch, and the cursor scoping ratchet.

At the time of the first merge it did **not** cover MemoryJobStore or
PostgresJobStore parity for the new boolean return, which was asserted only for
`SqliteJobStore`. That gap was closed in the follow-up: `job-store.test.ts` now
runs the guard-reporting parity across sqlite and memory, and
`job-store-pg.test.ts` covers Postgres, which is the backend where a wrong
`true` actually costs something because the store is shared. Each was verified
to fail when the corresponding backend is made to report the wrong answer.

### End-to-end validation against a real provider

*Evidence class 2: a single measured run, not a repeatable repo-level proof.*

Beyond the synthetic-child unit tests, the patched `dist/` build was run against
a real `claude` process: stream for ~8 s, cancel mid-flight, then compare.

```
stdoutBytes known at cancel time:      8030
in-memory stdout after close:          9406
DURABLE STORE stdout after close:      9406   <- was capped at the cancel-time value
store status:                          canceled
bytes rescued:                         1376
```

The durable store now agrees with the in-memory buffer byte for byte. Note the
caveat: 8,030 is the value the *snapshot* exposed at cancel time, and pre-fix a
lucky unthrottled `recordOutput` could sometimes have carried a little past it.
The deterministic counterfactual is the unit test, not this number.

## 3. Per-provider output discipline (the operator table)

*Evidence class 2 throughout.* Each CLI was probed under **the exact argv the gateway spawns** (recovered from
`args_json` of real completed jobs in the store), with piped stdio and its own
process group, SIGTERM mid-flight, then a 5 s grace matching the gateway's.

| Provider | Streams mid-flight? | Flushes on SIGTERM? | Cancel retains? | Evidence |
|---|---|---|---|---|
| **claude** | **Yes**, continuous | **Yes** | **Yes**, partial answer | 24 KB within 10 s; +1,889 and +8,258 B after SIGTERM |
| **codex** | **Yes**, per *event* | No | Yes, partial | 8 jsonl chunks over 0.15 s to 18.0 s (agentic) |
| **grok** | **Yes** | No | Partial, after ~7 to 10 s | 164 chunks over 9.9 s to 18.5 s |
| **gemini** | No | Only a 36 B diagnostic | **No** | one late burst; 36 B after SIGTERM |
| **mistral** | **No** | **No** | **No** | 0 bytes over a 30 s run; 0 after SIGTERM |
| **cursor** | **No** | **No** | **No** | single 8,199 B chunk at 28.5 s; 0 on cancel at 15 s |
| **devin** | **No** | **No** | **No** | single 6,415 B chunk at 13.9 s; 0 on cancel at 8 s |

### Gateway-level cancel sweep (the operator table)

*Evidence class 2 throughout: measured on this host, against the provider CLI
versions installed on 2026-07-26.*

The table above is the child-process mechanism. This one is the end-to-end
answer through the gateway itself, run on the **patched** `dist/` build: start a
job, poll `stdoutBytes` every 2.5 s, cancel at 25 s, then read the durable store.

| Provider | `stdoutBytes` advances before terminal? | Mid-flight cancel preserves? | Bytes rescued by the fix |
|---|---|---|---|
| claude | **Yes** (6,176 → 13,602 over 25 s) | **Yes**, 15,005 retained | **+1,403** |
| codex | Yes in principle, but flat at 101 on this non-agentic prompt | Yes, all 101 | 0 |
| grok | **Yes**, after a ~10 s silent phase (655 → 5,896) | **Yes**, all of it | 0 (grok does not flush on SIGTERM) |
| gemini | **No**, flat 0 for 25 s | **No**, 0 retained | 0 |
| mistral | **No**, flat 0 for 25 s | **No**, 0 retained | 0 |
| cursor | **No**, flat 0 for 25 s | **No**, 0 retained | 0 |
| devin | **No**, flat 0 for 25 s | **No**, 0 retained | 0 |

**Operator reading**: gemini, mistral, cursor and devin retain **nothing** on
cancel; their `stdoutBytes: 0` while running is normal rather than a sign of a
hung job. claude, codex and grok retain what they had emitted, with caveats
worth keeping rather than smoothing away: claude is the only one that also
flushes on SIGTERM, codex advances per *event* so a long non-agentic message can
sit at a flat low byte count (101 in this run), and grok emits nothing at all
during a roughly 7 to 10 s think phase, so a cancel inside that window still
retains nothing.

Measurement caveat: `stdoutBytes` in the snapshot is `Buffer.byteLength` (UTF-8
bytes) while the stored row length is measured in UTF-16 code units, so the two
columns are not the same unit. grok's raw delta came out at -2 for that reason,
which is agreement, not loss. Only claude's +1,403 is a real gain, and it is
corroborated by the independent single-provider run above (+1,376).

Two independent corroborations that the discipline table is right, not an
artefact of the probe harness:

- **gemini.** The probe's post-SIGTERM output is exactly **36 bytes**. The
  production store's `gemini | canceled` row has `max_len` of exactly **36**.
  Every canceled gemini job in history captured precisely that diagnostic line
  and nothing else.
- **codex.** `codex | canceled` has `min_len = 4390`, never zero, matching a
  provider that streams events continuously under agentic prompts.

**This settles the question the prior session left open.** The mechanism is (b),
not (a): these children accumulate internally and print once at clean exit. It
is not pipe block-buffering that a `stdbuf` or PTY would fix, because a
block-buffered child would still have handed *some* full buffers to the pipe
during a 30 s run, and mistral handed over zero.

So for mistral, cursor and devin the 85/85, 5/5 and 9/9 empty captures are
**correct behaviour of the gateway** faithfully recording that the child
produced nothing. Not a gateway defect, and not fixable at this layer.

### The grok 3,079 s outlier

Called out in the brief for individual inspection. grok's empty group contains
one job that ran 51 minutes and captured nothing. Given grok's measured 7 to 10 s
silent think phase, that is far too long to be the same mechanism. This is
consistent with the already-documented grok worker-handshake flake (agentic runs
exiting with empty stdout). **Inferred, not proved**: reproducing a specific
51-minute hang was out of scope.

### Does the registry already know this?

No, and this was worth checking before adding a field. `streamingFormats`
describes formats the CLI is *capable* of streaming, not the discipline of the
invocation the gateway makes, and it misclassifies two of seven providers:

- **grok** streams plain text while its only declared streaming format is `json`.
- **cursor** declares `stream-json` but the gateway invokes it with `--print`
  (text), under which it buffers to a single chunk.

Deriving from it would have been wrong. Hence a new fact,
`ProviderOutputDiscipline`, on `src/provider-definitions.ts` (the single source
of truth), projected to the capability surface via
`generateProviderCapabilityRows`, and pinned by
`src/__tests__/provider-output-discipline.test.ts` as a static ratchet, because
the behaviour it describes lives in a child process that no unit test can drive.

## 4. Other questions from the brief

- **SIGTERM grace.** Yes, cancellation is SIGTERM with a 5 s grace before SIGKILL
  (`PROCESS_GROUP_KILL_GRACE_MS`, `src/executor.ts:396`, via
  `createProcessGroupTerminationFence`). **A longer grace would not have helped
  in any run measured here** (evidence class 2, not a proof): the four
  terminal-burst providers were still writing nothing after a full 5 s, and
  claude, the one provider that does flush, completed its flush inside the
  current window. Lengthening it would delay every cancel for a benefit not
  observed. This is an argument from measurement, not from the repo, and a
  future provider version could invalidate it.
- **`outputTruncated` / 50 MB cap / `max_job_output_bytes`.** The overflow path
  **does** share the late-output loss, and the fix rescues it.

  This point was got wrong twice and is worth recording honestly. A second draft
  claimed overflow could never accumulate late bytes, reasoning that once the
  cap trips every later chunk must also cross it. That is false: `appendOutput`
  rejects only the chunk that would cross the cap and never appends it, so the
  in-memory total does not grow, and a later **smaller** chunk still fits and is
  appended. One reviewer (codex) reproduced this; another (grok) accepted the
  incorrect reasoning. It was settled by direct experiment rather than by
  counting votes, with a 10-byte cap:

  ```
  11-byte chunk  -> crosses the cap, dropped, job terminalized (exit 126)
  1-byte SIGTERM flush -> still fits, appended, and now persisted
  durable row: status=failed outputTruncated=true stdout="X"
  ```

  That case is now pinned by a test rather than by an argument.

## 5. Residual limitations

Items 2 and 7 were picked up as follow-ups after the first merge and are
annotated in place. The rest remain deliberately unfixed, with the reason.

1. **Under the DEFAULT argv, mistral, cursor and devin cannot be cancelled with
   any output retained.** The bytes never leave the child. Fixing this needs a
   provider-side change or a different invocation mode, not a gateway change.
   Declared as `terminal-burst` / `flushesOnSigterm: false` so callers can see
   it. Scope matters here: residual 2 below shows cursor DOES retain output when
   a caller opts into `outputFormat: "stream-json"`, so this statement is about
   the default invocation, not about the cursor CLI.
2. **cursor buffers only under the DEFAULT argv; its streaming modes work.**
   Follow-up measurement, 2026-07-26. `cursor_request` forwards
   `--output-format stream-json` when a caller sets `outputFormat`
   (`src/index.ts:13550`), and cursor also accepts `--stream-partial-output`.
   Probed on the same prompt and a 25 s cancel:

   | cursor mode | first byte | chunks | bytes before cancel | reachable via gateway? |
   |---|---|---|---|---|
   | `text` (gateway default) | never | 0 | **0** | yes, the default |
   | `--output-format stream-json` | 4.1 s | 10 | 1,922 | **yes**, via `outputFormat` |
   | `stream-json --stream-partial-output` | 4.0 s | 1,923 | 351,663 | **no** |

   So cursor's `terminal-burst` classification is a fact about the *default*
   invocation, not the CLI. None of the three flushes on SIGTERM, so a cancel
   still loses the tail, but under the streaming mode a caller keeps everything
   already streamed.

   **The last row is a direct-CLI experiment only.** `cursor_request` exposes
   `outputFormat` and the argv builder emits nothing but `--output-format`
   (`src/index.ts:13550`); `--stream-partial-output` appears only in the
   upstream-contract help probe, never in a spawn. So the gateway-accessible
   improvement is 1,922 bytes over 10 chunks, not 351 KB. Including that row
   without this caveat overstated what a caller can actually get, which the
   codex reviewer caught.

   **Still not changed here**: the gateway's default remains `text`, because
   switching it rewrites cursor's output parsing end to end (the reply would
   arrive as a JSON event stream rather than plain text) and that belongs in its
   own slice with its own review. What has changed is that the registry now
   records the measurement instead of calling it unmeasured, so the upgrade path
   is documented rather than guessed at.

3. **codex streams per event, not per token.** A single long non-agentic message
   still emits nothing until it completes, so `stdoutBytes` can sit at 0 on a
   healthy codex job too. Classified `incremental` because that is what it is
   under the agentic prompts the gateway actually issues; the nuance is in the
   evidence string rather than a third enum value.
4. **The grok 3,079 s empty job is attributed, not proved** (see above).
5. **`droppedCount` growth is left as is.** It is correct bounded-ring
   behaviour; changing it would trade a harmless projection gap for unbounded
   memory.
6. **A canceled row never records the child's exit code.** `cancelJob` writes
   the terminal row before the process is reaped, so `exit_code` is null, and
   the late `recordOutput` path deliberately does not write it (writing exit
   status through the unfenced path would undermine the very fence this change
   respects). Measured: **all 164 canceled rows in the store have
   `exit_code IS NULL`**. This is pre-existing and unchanged here. Left as is
   because `status = 'canceled'` already carries the meaning, and a killed
   child's exit code is not independently informative. Raised by the grok
   reviewer.
7. **The dead-process (ESRCH) detector finalized the flight row early. FIXED.**
   That path set `exited = true` the moment `kill(pid, 0)` reported ESRCH and
   finalized the flight-recorder row, so the job store still picked up late
   bytes at close but `llm_request_result` did not. The root confusion was using
   `exited` as a proxy for "all output delivered": a vanished pid is not a
   drained pipe, because node still delivers buffered stdout before emitting
   `close`.

   There is now a separate `closeObserved` flag meaning "no further output can
   arrive", set by the real close handler and by every path where no process
   output is possible (never spawned, spawn failure, http settled) but
   deliberately NOT by the speculative ESRCH sweep. The flight finalization
   gates on that instead. The ESRCH sweep still writes the row exactly as
   before, and it stays eligible for one refresh if `close` arrives.

   Precision, after review: "nothing regresses if `close` never arrives" would
   overstate it. In that case the row keeps its ESRCH-time content, which is the
   old behaviour, but `flightRecorderComplete` stays false so
   `flightRecorderEntry` / `extractUsage` are not cleared early. That retention
   is **bounded**, not permanent: the record is terminal with a `finishedAt`, so
   the sweep drops it after `completedJobMemoryTtlMs` (1 h by default). Raised
   by the codex reviewer.

   Note also what this rules out. Setting `closeObserved` in the ESRCH branch,
   which the mistral reviewer proposed as a blocker, would reinstate exactly the
   bug being fixed: the row would finalize on the speculative signal and could
   never pick up the buffered bytes. Its premise, that no `close` can follow
   ESRCH, does not hold. The sweep observes a vanished pid on a timer, while
   node delivers `exit` and then `close` once the stdio pipes drain, which is
   the ordinary ordering. The only case where `close` genuinely may not arrive
   is a descendant holding the pipes open, and that is the bounded-retention
   case above.

   Pinned by a test that points the manager's process handle at a pid that
   cannot exist, drives the real sweep, and then lets the live child flush.
   With the old `!exited` guard it times out waiting for the refresh.

8. **The late-output write is still unfenced, but is now only used on rows this
   instance owns.** `recordOutput` has never carried an owner or version
   predicate, for any caller. An earlier revision of this fix wrote late output
   even when the completion guard had **rejected** our terminal write, which is
   precisely the case where another writer owns the row. The codex reviewer
   rejected that as a shared-Postgres hazard and was right: it was a new
   exposure, not an inherited one. It took THREE attempts to close, and each
   round found a route the previous fix had missed: first the immediate write,
   then the close-time write, then the ordinary throttled flush in
   `maybeFlushOutput`, which reaches the same unfenced `recordOutput` by its own
   path once the 1 s window lapses. Every route now consults one predicate,
   `mayWriteOutputFor`, so the rule is stated once: never write output to a row
   whose terminal transition another writer won. Each route is pinned by a test
   that fails with the guard removed. What remains is the pre-existing property
   that `recordOutput` has no owner predicate of its own, which is what made
   the rule necessary in the manager.
9. **API providers.** Only one `openai` row exists in the store (4 bytes,
   completed), so there is no cancellation history to analyse. The http path
   does not spawn a child and cancels by aborting the request
   (`cancelJob`, transport `"http"`), so the fence bug did not apply to it; the
   flight-recorder fix is explicitly scoped away from it for that reason.
