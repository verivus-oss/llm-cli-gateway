# Job output capture, progress, and cancellation semantics

Investigation date: 2026-07-26. Tree: `master` at `0eb325f`.

This separates what was **proved** (reproduced from code, the durable store, or
a test that fails before a change and passes after) from what was **inferred**.

## Summary

Two things were wrong, and they are different in kind.

1. **A real gateway data-loss bug**, in two surfaces. Cancellation, idle timeout
   and output overflow write the job terminal at the moment the signal is
   *requested*, but the child lives on until its `close` event and may flush
   output in between. Both durable surfaces refused to record those bytes. Fixed.
2. **A provider property that is not a gateway defect.** Four of the seven CLIs
   accumulate their whole answer internally and write it in one burst at clean
   exit. For those, a cancel genuinely has nothing to retain, because the bytes
   never left the child. Not fixable at this layer; now declared in the registry
   so callers can interpret `stdoutBytes: 0` instead of guessing.

## 1. The prior findings, re-derived

Both store queries from the prior session reproduce **exactly**, digit for digit
(28 rows and 11 rows respectively). The claims are therefore reproducible, but
two of the conclusions drawn from them were wrong.

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
  separately in `stdout`. Nothing recoverable is lost. No change made.

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
  flag, set **only after a store-acknowledged write**, so a throwing
  `recordComplete` still retries through the existing Kit retry path. Once the
  terminal row is committed, later persists route their output through the
  unfenced `recordOutput`, which updates bytes without disturbing the committed
  terminal state. "Last committed terminal state wins" is preserved exactly.
- `writeFlightComplete` (`:2922`): the row stays eligible for exactly one
  refresh until `close` proves the process is gone. `logComplete`'s UPDATE is
  keyed on row id and is idempotent. Scoped to `transport === "process"`, since
  an http job has no close event to wait for.

Both are pinned by tests that fail before and pass after (verified by reverting
each fix independently).

## 3. Per-provider output discipline (the operator table)

Each CLI was probed under **the exact argv the gateway spawns** (recovered from
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

Two independent corroborations that this table is right, not an artefact of the
probe harness:

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
  `createProcessGroupTerminationFence`). **A longer grace would not help.** The
  four terminal-burst providers were still writing nothing after a full 5 s, and
  claude, the one provider that does flush, already completes its flush inside
  the current window. Lengthening it would only delay every cancel.
- **`outputTruncated` / 50 MB cap / `max_job_output_bytes`.** No bad interaction
  found. The overflow path in `appendOutput` sets terminal status before close
  exactly like cancel, so it shared the same fence bug and is fixed by the same
  change. The cap itself is applied consistently to the in-memory buffer.

## 5. Residual limitations, deliberately not fixed

1. **mistral, cursor and devin cannot be cancelled with any output retained.**
   The bytes never leave the child. Fixing this needs a provider-side change or
   a different invocation mode, not a gateway change. Now declared as
   `terminal-burst` / `flushesOnSigterm: false` so callers can see it.
2. **cursor ships a `stream-json` mode the gateway does not use.** This is the
   one case where the residual is plausibly recoverable: invoking cursor in its
   streaming mode would likely make it incremental. Not attempted here because
   it changes cursor's output parsing end to end, which is a separate slice with
   its own review surface. Recorded in the registry evidence string.
3. **codex streams per event, not per token.** A single long non-agentic message
   still emits nothing until it completes, so `stdoutBytes` can sit at 0 on a
   healthy codex job too. Classified `incremental` because that is what it is
   under the agentic prompts the gateway actually issues; the nuance is in the
   evidence string rather than a third enum value.
4. **The grok 3,079 s empty job is attributed, not proved** (see above).
5. **`droppedCount` growth is left as is.** It is correct bounded-ring
   behaviour; changing it would trade a harmless projection gap for unbounded
   memory.
6. **API providers.** Only one `openai` row exists in the store (4 bytes,
   completed), so there is no cancellation history to analyse. The http path
   does not spawn a child and cancels by aborting the request
   (`cancelJob`, transport `"http"`), so the fence bug did not apply to it; the
   flight-recorder fix is explicitly scoped away from it for that reason.
