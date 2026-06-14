import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import {
  envWithExtendedPath,
  getExtendedPath,
  killProcessGroup,
  providerCommandName,
  spawnCliProcess,
  unregisterProcessGroup,
} from "./executor.js";
import type { Logger } from "./logger.js";
import { noopLogger, logWarn } from "./logger.js";
import { ProcessMonitor, type JobHealth } from "./process-monitor.js";
import { JobStore, computeRequestKey } from "./job-store.js";
import {
  NoopFlightRecorder,
  type FlightLogResult,
  type FlightRecorderLike,
} from "./flight-recorder.js";
import { codexFrResponse } from "./codex-json-parser.js";
import type { OrphanedJobSnapshot } from "./job-store.js";
import { getRequestContext, resolveOwnerPrincipal } from "./request-context.js";

export type LlmCli = "claude" | "codex" | "gemini" | "grok" | "mistral";
export type AsyncJobStatus = "running" | "completed" | "failed" | "canceled" | "orphaned";

const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory retention; durable store has its own (longer) retention
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const OUTPUT_FLUSH_INTERVAL_MS = 1000; // Throttle DB writes for streaming stdout/stderr

/**
 * Issue #21: silent-stall telemetry for long async jobs. A running job that
 * has produced ZERO stdout bytes after these elapsed marks is almost certainly
 * stalled (observed repeatedly on claude_request_async with evidence-heavy
 * prompts). We emit one structured warning per crossed mark so the condition is
 * measurable in the gateway logs (prompt length, model, elapsed) instead of
 * surfacing only as a vague "0-byte stdout after N minutes" after the fact.
 */
const STALL_CHECK_INTERVAL_MS = 60 * 1000; // sweep every minute for mark accuracy
const STALL_WARNING_MARKS_MS = [5, 10, 15].map(min => min * 60 * 1000);

function describeProcessLaunchError(
  cli: LlmCli,
  error: Error
): { exitCode: number; message: string } {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return {
      exitCode: 127,
      message: `The '${cli}' command was not found. Install the ${cli} CLI and make sure it is on PATH. (${error.message})`,
    };
  }
  return {
    exitCode: 126,
    message: `Failed to launch ${cli} CLI: ${error.message}`,
  };
}

function describeWindowsLaunchExit(
  cli: LlmCli,
  exitCode: number
): { exitCode: number; message: string } | null {
  if (exitCode !== -4058) {
    return null;
  }

  return {
    exitCode: 127,
    message: `The '${cli}' command was not found. Install the ${cli} CLI and make sure it is on PATH.`,
  };
}

/**
 * Slice 1.5 flight-recorder payload supplied via StartJobOptions.
 * Decomposed to primitive fields (no nested handler-locals) so retaining
 * a reference on the in-memory job record doesn't pin large promptParts
 * or attachments via closure scope.
 */
export interface AsyncJobFlightRecorderEntry {
  model: string;
  prompt: string; // assembled effective prompt
  sessionId?: string;
  stablePrefixHash?: string;
  stablePrefixTokens?: number;
  /**
   * Slice κ: count of caller-supplied prompt-parts content blocks the
   * gateway emitted with explicit Anthropic `cache_control` markers
   * (ttl='1h'). Only set for Claude requests that opt into κ; left
   * undefined elsewhere so legacy rows stay NULL.
   */
  cacheControlBlocks?: number;
  /** TTL seconds actually emitted on those cache_control markers. */
  cacheControlTtlSeconds?: number;
}

/**
 * Slice 1.5 usage-extraction callback. Closures MUST be constructed from
 * primitive locals only (e.g. const fmt = params.outputFormat; closure
 * captures fmt). Capturing the handler's full `params` object pins large
 * promptParts/attachments for JOB_TTL_MS.
 */
export type AsyncJobUsageExtractor = (stdout: string) => {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
};

interface AsyncJobRecord {
  id: string;
  cli: LlmCli;
  args: string[];
  requestKey: string;
  correlationId: string;
  status: AsyncJobStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  canceled: boolean;
  error: string | null;
  process: ChildProcess | null; // null when reconstituted from persistence (orphan/historical)
  exited: boolean;
  metricsRecorded: boolean;
  outputFormat?: string;
  resetIdleTimer?: () => void;
  clearIdleTimer?: () => void;
  cleanupGroup?: () => void;
  /**
   * U26 fix: fired exactly once when the job reaches a terminal state
   * (completed/failed/canceled/orphaned), regardless of exit path. Used to
   * release per-request resources such as outputSchema temp files that must
   * outlive the deferred sync window.
   */
  onComplete?: () => void;
  onCompleteFired?: boolean;
  outputDirty: boolean; // true if stdout/stderr changed since last DB flush
  lastOutputFlushAt: number;
  /**
   * Slice 1.5: data retained for the terminal-state flight-recorder write.
   * Cleared after writeFlightComplete succeeds so the GC can reclaim the
   * extractUsage closure's captured primitives.
   */
  flightRecorderEntry?: AsyncJobFlightRecorderEntry;
  extractUsage?: AsyncJobUsageExtractor;
  /** Set ONLY after a successful logComplete write so a thrown call retries. */
  flightRecorderComplete?: boolean;
  /**
   * Slice 1.5 (R2 Codex-Unit-B F1 fix): the manager writes logComplete
   * ONLY when this flag is true. Pure async handlers set it at startJob
   * time (writeFlightStart implies armed). The sync-deferred path
   * (awaitJobOrDefer) arms it only when the request is about to return a
   * deferred response — so a sync-inline request that completes within
   * the deadline gets its rich metadata via the sync handler's
   * safeFlightComplete, not preempted by the manager's minimal payload.
   */
  flightCompleteArmed?: boolean;
  /**
   * Issue #21: index into STALL_WARNING_MARKS_MS of the next stall mark to
   * warn on. Advanced past every mark already crossed so each mark warns at
   * most once, even if a sweep is missed. Reset to its max once the job emits
   * any stdout so a job that finally produces output stops being flagged.
   */
  stallWarnIndex?: number;
}

export interface AsyncJobSnapshot {
  id: string;
  cli: LlmCli;
  status: AsyncJobStatus;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  correlationId: string;
  outputTruncated: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  error: string | null;
  exited: boolean;
}

export interface AsyncJobResult extends AsyncJobSnapshot {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

/**
 * U22 fix: deterministic canonicalisation of an env-var map for the dedup key.
 * Returns "" when env is undefined or empty (preserves dedup key continuity for
 * pre-U22 callers that pass no env).
 */
function canonicaliseEnvForKey(env?: Record<string, string>): string {
  if (!env) return "";
  const entries = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  if (entries.length === 0) return "";
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(entries);
}

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: value.slice(0, maxChars),
    truncated: true,
  };
}

export interface StartJobOptions {
  cwd?: string;
  idleTimeoutMs?: number;
  outputFormat?: string;
  /** Bypass dedup and force a fresh CLI run even if a recent matching job exists. */
  forceRefresh?: boolean;
  /**
   * Extra environment variables to inject when spawning the child CLI.
   * Used by Mistral Vibe to pass `VIBE_ACTIVE_MODEL` (Vibe has no `--model` flag).
   *
   * IMPORTANT: env vars participate in the dedup key (canonicalised by sorted
   * keys + JSON-stringified). Two requests that differ only in env (e.g. two
   * Mistral requests with the same prompt but different VIBE_ACTIVE_MODEL)
   * therefore do NOT collide on dedup.
   */
  env?: Record<string, string>;
  /**
   * Slice κ: optional UTF-8 payload to pipe into the child's stdin.
   * Participates in the dedup key — two requests with identical argv
   * but different stdin do NOT collide. When set, stdio[0] is "pipe";
   * when unset, stdio[0] stays "ignore" (regression-protected).
   */
  stdin?: string;
  /**
   * Optional hook fired exactly once when the job reaches a terminal state.
   * Used by callers that own per-request resources (outputSchema temp files,
   * etc.) that must persist for the lifetime of the spawned CLI process.
   */
  onComplete?: () => void;
  /**
   * Slice 1.5: when true, AsyncJobManager writes a flight-recorder logStart
   * row at startJob entry using `flightRecorderEntry`. Pure async handlers
   * (handle*RequestAsync) pass true because they have no upstream
   * safeFlightStart writer. The sync-deferred path (awaitJobOrDefer) passes
   * false because the upstream sync handler already wrote logStart keyed on
   * the same correlationId — a second INSERT would crash on the PK.
   */
  writeFlightStart?: boolean;
  /** Slice 1.5: payload for the FR logStart and the terminal logComplete. */
  flightRecorderEntry?: AsyncJobFlightRecorderEntry;
  /**
   * Slice 1.5: invoked only on terminal `completed` to populate token-usage
   * fields in the FR logComplete payload. Construct from primitive locals
   * only (see AsyncJobUsageExtractor doc).
   */
  extractUsage?: AsyncJobUsageExtractor;
}

export interface StartJobOutcome {
  snapshot: AsyncJobSnapshot;
  /** Set to the existing job's id when the request was de-duplicated. */
  deduped: boolean;
  /** Set when deduped — the original job's correlation id, useful for logging. */
  originalCorrelationId?: string;
}

export class AsyncJobManager {
  private jobs = new Map<string, AsyncJobRecord>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private stallTimer: ReturnType<typeof setInterval> | null = null;
  private processMonitor: ProcessMonitor;
  private store: JobStore | null;

  private flightRecorder: FlightRecorderLike;

  constructor(
    private logger: Logger = noopLogger,
    private onJobComplete?: (cli: LlmCli, durationMs: number, success: boolean) => void,
    store: JobStore | null = null,
    flightRecorder: FlightRecorderLike = new NoopFlightRecorder()
  ) {
    this.processMonitor = new ProcessMonitor(logger);
    this.store = store;
    this.flightRecorder = flightRecorder;

    if (this.store) {
      try {
        const { count, orphaned } = this.store.markOrphanedOnStartup();
        if (count > 0) {
          this.logger.info(`Marked ${count} in-flight job(s) as orphaned after gateway restart`);
        }
        // Slice 1.5: close out the FR row for each orphaned job. The FR
        // logComplete UPDATE has WHERE status='started' so pre-1.7.0 rows
        // (where the prior gateway never wrote a logStart) silently
        // no-op. Wrapped per-orphan so a single bad row can't tank boot.
        for (const orphan of orphaned) {
          try {
            this.flightRecorder.logComplete(
              orphan.correlationId,
              this.buildOrphanFlightResult(orphan)
            );
          } catch (err) {
            this.logger.error(
              `Async-path FR logComplete for orphaned job ${orphan.id} failed`,
              err
            );
          }
        }
      } catch (err) {
        this.logger.error("markOrphanedOnStartup failed", err);
      }
    }

    this.evictionTimer = setInterval(() => this.evictCompletedJobs(), EVICTION_INTERVAL_MS);
    // Allow the process to exit even if the timer is active
    if (this.evictionTimer.unref) {
      this.evictionTimer.unref();
    }

    // Issue #21: silent-stall telemetry sweep.
    this.stallTimer = setInterval(() => this.checkStalledJobs(), STALL_CHECK_INTERVAL_MS);
    if (this.stallTimer.unref) {
      this.stallTimer.unref();
    }
  }

  private buildOrphanFlightResult(orphan: OrphanedJobSnapshot): FlightLogResult {
    const durationMs = Math.max(0, Date.now() - new Date(orphan.startedAt).getTime());
    const hasCapturedStdout = orphan.stdout.length > 0;
    const hasKnownSuccessfulExit = orphan.exitCode === 0;
    const hasCapturedResponseWithoutFailure = orphan.exitCode === null && hasCapturedStdout;

    if (hasKnownSuccessfulExit || hasCapturedResponseWithoutFailure) {
      return {
        response: orphan.stdout,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: 0,
        status: "completed",
      };
    }

    return {
      response: orphan.stderr || orphan.stdout,
      durationMs,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: orphan.exitCode ?? 1,
      errorMessage: "orphaned after gateway restart",
      status: "failed",
    };
  }

  /**
   * Issue #21: warn once per crossed mark for any running job that has emitted
   * ZERO stdout. Captures prompt length and model (from the opted-in
   * flight-recorder entry) so a recurring stall class is measurable from logs.
   * `public` only so tests can drive it deterministically without waiting on
   * the interval timer.
   */
  checkStalledJobs(now: number = Date.now()): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      // Any stdout at all means the job is alive — stop tracking it.
      if (Buffer.byteLength(job.stdout) > 0) {
        job.stallWarnIndex = STALL_WARNING_MARKS_MS.length;
        continue;
      }
      const idx = job.stallWarnIndex ?? 0;
      if (idx >= STALL_WARNING_MARKS_MS.length) continue;
      const elapsedMs = now - new Date(job.startedAt).getTime();
      if (elapsedMs < STALL_WARNING_MARKS_MS[idx]) continue;
      // Advance past every mark already crossed so a missed sweep doesn't
      // replay older marks, and each mark warns at most once.
      let newIdx = idx;
      while (
        newIdx < STALL_WARNING_MARKS_MS.length &&
        elapsedMs >= STALL_WARNING_MARKS_MS[newIdx]
      ) {
        newIdx++;
      }
      job.stallWarnIndex = newIdx;
      const crossedMarkMin = Math.round(STALL_WARNING_MARKS_MS[newIdx - 1] / 60000);
      logWarn(
        this.logger,
        `Async job ${job.id} (${job.cli}) has produced no stdout after ~${crossedMarkMin}min — possible silent stall (issue #21)`,
        {
          jobId: job.id,
          cli: job.cli,
          correlationId: job.correlationId,
          elapsedMs,
          stdoutBytes: 0,
          stderrBytes: Buffer.byteLength(job.stderr),
          model: job.flightRecorderEntry?.model,
          promptLength: job.flightRecorderEntry?.prompt?.length,
        }
      );
    }
  }

  /**
   * True iff a durable (or memory) job store is attached. The MCP-tool
   * registration layer ANDs this with persistence.asyncJobsEnabled when
   * deciding whether to register the *_request_async / llm_job_* tools.
   * Without a store, async tools must not be registered, otherwise we
   * re-open the silent in-memory loss path the structural invariant closes.
   */
  hasStore(): boolean {
    return this.store !== null;
  }

  private emitMetrics(job: AsyncJobRecord): void {
    if (job.metricsRecorded) return;
    if (job.status === "canceled") return;
    if (job.status !== "completed" && job.status !== "failed") return;
    job.metricsRecorded = true;
    const durationMs = Date.now() - new Date(job.startedAt).getTime();
    try {
      this.onJobComplete?.(job.cli, durationMs, job.status === "completed");
    } catch (err) {
      this.logger.error("onJobComplete callback threw", err);
    }
  }

  private evictCompletedJobs(): void {
    const now = Date.now();
    let evicted = 0;

    // Dead process auto-recovery: check for running jobs whose process no longer exists
    for (const [id, job] of this.jobs) {
      if (job.status === "running" && job.process && job.process.pid) {
        try {
          process.kill(job.process.pid, 0);
        } catch (err: any) {
          if (err.code === "ESRCH") {
            job.status = "failed";
            job.exitCode = job.exitCode ?? 1;
            job.error = "Process no longer exists (dead process detected)";
            job.finishedAt = new Date().toISOString();
            job.exited = true;
            unregisterProcessGroup(job.process.pid);
            this.logger.error(
              `Job ${id} process ${job.process.pid} no longer exists, marking as failed`
            );
            this.emitMetrics(job);
            this.persistComplete(job);
            this.writeFlightComplete(job, "failed");
            this.fireOnComplete(job);
          }
          // EPERM: process exists but we can't signal it — ignore
        }
      }
      // Check for exited flag mismatch (close handler may have fired but status wasn't updated)
      if (job.status === "running" && job.exited) {
        job.status = "failed";
        job.error = "Process exited without proper status transition";
        job.finishedAt = job.finishedAt || new Date().toISOString();
        if (job.process && job.process.pid) unregisterProcessGroup(job.process.pid);
        this.logger.error(
          `Job ${id} has exited flag but was still in running state, marking as failed`
        );
        this.emitMetrics(job);
        this.persistComplete(job);
        this.writeFlightComplete(job, "failed");
        this.fireOnComplete(job);
      }
    }

    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && job.finishedAt) {
        const finishedMs = new Date(job.finishedAt).getTime();
        if (now - finishedMs > JOB_TTL_MS) {
          this.jobs.delete(id);
          evicted++;
        }
      }
    }
    if (evicted > 0) {
      this.logger.debug(
        `Evicted ${evicted} completed jobs from memory (durable store retains them)`
      );
    }

    // Sweep the durable store, too. Errors are non-fatal — the job rows just stay until next sweep.
    if (this.store) {
      try {
        const removed = this.store.evictExpired();
        if (removed > 0) {
          this.logger.debug(`Evicted ${removed} expired jobs from durable store`);
        }
      } catch (err) {
        this.logger.error("durable store eviction failed", err);
      }
    }
  }

  /**
   * Compute the dedup key for a job. Stable across re-issues of the same request,
   * which is exactly what allows agents to safely retry without restarting the run.
   *
   * U22 fix: env vars participate in the key via a deterministic canonicalisation
   * (sorted keys → JSON-stringified). This prevents two Mistral requests with the
   * same argv but different `VIBE_ACTIVE_MODEL` from deduping onto each other.
   */
  private buildRequestKey(
    cli: LlmCli,
    args: string[],
    env?: Record<string, string>,
    stdin?: string,
    cwd?: string,
    outputFormat?: string
  ): string {
    // Slice κ: stdin participates in the dedup key. Two Claude requests
    // with identical argv but different cache_control content blocks
    // would otherwise collide on dedup and the second caller would get
    // the wrong response. The legacy "no stdin" code path passes
    // stdin=undefined, which serialises to the same empty marker the
    // previous version emitted — non-κ dedup is unchanged.
    // Slice λ: cwd participates similarly. Two requests with identical
    // argv but different worktrees would otherwise collide on dedup and
    // the second caller would receive a response executed in the wrong
    // worktree. cwd=undefined preserves the pre-λ key shape — non-λ
    // dedup is unchanged.
    // #44: outputFormat participates in the key FOR CODEX ONLY. Codex now emits
    // `--json` on EVERY request, so its text and json modes share identical argv
    // and would collide on dedup — the second caller would then be rendered with
    // the first job's stored outputFormat (a text caller deduping onto a json job
    // gets raw JSONL). Other CLIs already vary their argv by format, so they are
    // left untouched to preserve their exact pre-#44 key shape (avoids a new
    // missed-dedup between an omitted and an explicit-default outputFormat). For
    // codex the default is normalised (undefined === "text") so an omitted format
    // and an explicit "text" still dedup together; only "json" splits off.
    const extraEnv = canonicaliseEnvForKey(env);
    const withStdin = stdin === undefined ? extraEnv : `${extraEnv}|stdin:${stdin}`;
    const withCwd = cwd === undefined ? withStdin : `${withStdin}|cwd:${cwd}`;
    const extra = cli === "codex" ? `${withCwd}|fmt:${outputFormat ?? "text"}` : withCwd;
    return computeRequestKey(cli, args, extra);
  }

  private fireOnComplete(job: AsyncJobRecord): void {
    if (job.onCompleteFired) return;
    if (!job.onComplete) return;
    job.onCompleteFired = true;
    try {
      job.onComplete();
    } catch (err) {
      this.logger.error(`Job ${job.id} onComplete hook threw`, err);
    }
  }

  /**
   * Slice 1.5: write the terminal flight-recorder row. Mirrors sync-path
   * failure semantics (response = stderr||stdout on failure, errorMessage
   * falls back through overrideErrorMessage → job.error → job.stderr →
   * "Exit code N"). Single-shot guard set only on SUCCESSFUL write so a
   * thrown logComplete can be retried by a later terminal callback; the
   * FR's WHERE status='started' UPDATE guard remains the actual
   * idempotency mechanism for the common "retry succeeds, original
   * succeeded too" case.
   */
  private writeFlightComplete(
    job: AsyncJobRecord,
    finalStatus: "completed" | "failed",
    overrideErrorMessage?: string
  ): void {
    if (!job.flightRecorderEntry) return; // never opted in
    // R2 Codex-Unit-B F1: only write when armed. Sync-inline requests are
    // NOT armed at startJob — the sync handler owns the rich-metadata
    // safeFlightComplete write. Pure async + sync-deferred ARE armed.
    if (!job.flightCompleteArmed) return;
    if (job.flightRecorderComplete) return; // already wrote successfully
    const durationMs = Math.max(0, Date.now() - new Date(job.startedAt).getTime());
    const usage = finalStatus === "completed" && job.extractUsage ? this.safeExtractUsage(job) : {};
    const isFailure = finalStatus === "failed";
    // #44: codex always runs with `--json`, so a codex job's stdout is a raw
    // JSONL event stream on BOTH success and failure. Never persist it raw as the
    // FR response in text mode (read back by llm_request_result / cache-stats) —
    // run it through the same codexFrResponse() helper the sync handler uses so
    // the persisted value is identical and is the reconstructed reply (== text
    // mode) / parsed error, never raw JSONL. On failure prefer stderr, falling
    // back to that helper (the JSONL's turn.failed/error text or ""), mirroring
    // the sync failure path which stores `stderr || ""`. `job.stdout` itself
    // stays raw for usage extraction (above) and llm_job_result's own conversion.
    let response: string;
    if (job.cli === "codex") {
      const codexText = codexFrResponse(job.outputFormat, job.stdout);
      response = isFailure ? job.stderr || codexText : codexText;
    } else {
      response = isFailure ? job.stderr || job.stdout : job.stdout;
    }
    const exitCode = job.exitCode ?? (finalStatus === "completed" ? 0 : 1);
    const errorMessage = isFailure
      ? (overrideErrorMessage ?? job.error ?? job.stderr ?? `Exit code ${exitCode}`)
      : undefined;

    try {
      this.flightRecorder.logComplete(job.correlationId, {
        response,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode,
        errorMessage,
        status: finalStatus,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
      });
      // Only mark complete on successful write so a thrown logComplete
      // can be retried by the next terminal callback.
      job.flightRecorderComplete = true;
      // Clear retained references so the GC can reclaim anything the
      // extractUsage closure captured.
      job.flightRecorderEntry = undefined;
      job.extractUsage = undefined;
    } catch (err) {
      this.logger.error("Async-path flight recorder logComplete failed", err);
    }
  }

  private safeExtractUsage(job: AsyncJobRecord): ReturnType<AsyncJobUsageExtractor> {
    try {
      return job.extractUsage?.(job.stdout) ?? {};
    } catch (err) {
      this.logger.error(`Job ${job.id} extractUsage threw`, err);
      return {};
    }
  }

  /**
   * R2 Codex-Unit-B F1: awaitJobOrDefer calls this when returning a
   * deferred response. From this point on the sync handler will not write
   * its own safeFlightComplete, so the manager takes over.
   *
   * Race mitigation: if the job already terminated between the sync
   * deadline expiring and this method firing, write logComplete
   * synchronously here so the previously-skipped terminal callback's
   * write isn't lost.
   */
  armFlightCompleteForDeferral(jobId: string): void {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if (job.flightCompleteArmed) return; // pure async already armed
    job.flightCompleteArmed = true;
    if (job.status === "running") return;
    // Job already terminal — the close handler's writeFlightComplete
    // saw flightCompleteArmed=false and skipped. Write now to recover.
    const finalStatus = job.status === "completed" ? "completed" : "failed";
    const override = job.canceled ? "canceled by caller" : undefined;
    this.writeFlightComplete(job, finalStatus, override);
  }

  private safeStoreCall(label: string, fn: () => void): void {
    if (!this.store) return;
    try {
      fn();
    } catch (err) {
      this.logger.error(`JobStore.${label} failed`, err);
    }
  }

  /**
   * Flush in-memory stdout/stderr to the durable store if anything changed
   * since the last flush. Throttled by OUTPUT_FLUSH_INTERVAL_MS to avoid
   * pounding sqlite on every chunk of streaming output.
   */
  private maybeFlushOutput(job: AsyncJobRecord, force = false): void {
    if (!this.store) return;
    if (!job.outputDirty) return;
    const now = Date.now();
    if (!force && now - job.lastOutputFlushAt < OUTPUT_FLUSH_INTERVAL_MS) return;
    job.outputDirty = false;
    job.lastOutputFlushAt = now;
    this.safeStoreCall("recordOutput", () =>
      this.store!.recordOutput(job.id, job.stdout, job.stderr, job.outputTruncated)
    );
  }

  private persistComplete(job: AsyncJobRecord): void {
    if (!this.store) return;
    if (job.status === "running") return;
    if (!job.finishedAt) return;
    // Make sure the latest output is captured in the same row update.
    job.outputDirty = false;
    this.safeStoreCall("recordComplete", () =>
      this.store!.recordComplete({
        id: job.id,
        status: job.status === "running" ? "failed" : job.status,
        exitCode: job.exitCode,
        stdout: job.stdout,
        stderr: job.stderr,
        outputTruncated: job.outputTruncated,
        error: job.error,
        finishedAt: job.finishedAt!,
      })
    );
  }

  /**
   * Reconstitute an in-memory AsyncJobRecord from a durable row, so subsequent
   * getJobSnapshot/getJobResult calls hit the in-memory cache.
   * The reconstituted record has process=null — it represents historical data only.
   */
  private hydrateFromStore(jobId: string): AsyncJobRecord | null {
    if (!this.store) return null;
    let row;
    try {
      row = this.store.getById(jobId);
    } catch (err) {
      this.logger.error("JobStore.getById failed", err);
      return null;
    }
    if (!row) return null;

    const args: string[] = (() => {
      try {
        const parsed = JSON.parse(row.argsJson);
        return Array.isArray(parsed) ? parsed.map(String) : [];
      } catch {
        return [];
      }
    })();

    const reconstituted: AsyncJobRecord = {
      id: row.id,
      cli: row.cli as LlmCli,
      args,
      requestKey: row.requestKey,
      correlationId: row.correlationId,
      status: row.status as AsyncJobStatus,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      exitCode: row.exitCode,
      stdout: row.stdout,
      stderr: row.stderr,
      outputTruncated: row.outputTruncated,
      canceled: row.status === "canceled",
      error: row.error,
      process: null,
      exited: row.status !== "running",
      metricsRecorded: true,
      outputFormat: row.outputFormat ?? undefined,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
    };
    this.jobs.set(jobId, reconstituted);
    return reconstituted;
  }

  /**
   * Backwards-compatible entry point. Equivalent to startJobWithDedup({...}).snapshot.
   * Existing callers keep working unchanged; forceRefresh is exposed as a trailing
   * optional param for the dedup-aware path.
   */
  startJob(
    cli: LlmCli,
    args: string[],
    correlationId: string,
    cwd?: string,
    idleTimeoutMs?: number,
    outputFormat?: string,
    forceRefresh?: boolean,
    env?: Record<string, string>,
    onComplete?: () => void,
    flightRecorderEntry?: AsyncJobFlightRecorderEntry,
    extractUsage?: AsyncJobUsageExtractor,
    writeFlightStart?: boolean,
    stdin?: string
  ): AsyncJobSnapshot {
    return this.startJobWithDedup(cli, args, correlationId, {
      cwd,
      idleTimeoutMs,
      outputFormat,
      forceRefresh,
      env,
      stdin,
      onComplete,
      flightRecorderEntry,
      extractUsage,
      writeFlightStart,
    }).snapshot;
  }

  /**
   * Start a job, with optional dedup against recent identical requests.
   * Returns `{ snapshot, deduped }` so callers can log/report the short-circuit.
   *
   * Dedup is keyed on (cli, args). If a job with the same key was started within
   * the dedup window (default 1h) and is still running or completed, its snapshot
   * is returned without spawning a new process. forceRefresh skips dedup entirely.
   */
  startJobWithDedup(
    cli: LlmCli,
    args: string[],
    correlationId: string,
    opts: StartJobOptions = {}
  ): StartJobOutcome {
    const {
      cwd,
      idleTimeoutMs,
      outputFormat,
      forceRefresh,
      env: extraEnv,
      stdin,
      onComplete,
      flightRecorderEntry,
      extractUsage,
      writeFlightStart,
    } = opts;
    const requestKey = this.buildRequestKey(cli, args, extraEnv, stdin, cwd, outputFormat);

    if (!forceRefresh && this.store) {
      try {
        const existing = this.store.findByRequestKey(requestKey);
        if (existing) {
          // Prefer the in-memory record if we still have it (live process, idle timers, etc).
          let record = this.jobs.get(existing.id);
          if (!record) {
            record = this.hydrateFromStore(existing.id) ?? undefined;
          }
          if (record) {
            this.logger.info(`Job ${existing.id} reused via dedup for ${cli}`, {
              correlationId,
              originalCorrelationId: record.correlationId,
              status: record.status,
            });
            // U26 fix: the caller's per-request resources (e.g. outputSchema temp
            // file) are NOT consumed by the deduped job, which reuses its own
            // original resources. Release the new request's cleanup immediately
            // to avoid an orphaned temp file. The original job's onComplete (if
            // any) remains attached to that original job record.
            if (onComplete) {
              try {
                onComplete();
              } catch (err) {
                this.logger.error("dedup onComplete cleanup threw", err);
              }
            }
            return {
              snapshot: this.snapshot(record),
              deduped: true,
              originalCorrelationId: record.correlationId,
            };
          }
        }
      } catch (err) {
        this.logger.error("dedup lookup failed; proceeding with fresh run", err);
      }
    }

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const command = providerCommandName(cli);
    const baseEnv = envWithExtendedPath(process.env, getExtendedPath());
    const child = spawnCliProcess(command, args, {
      cwd,
      stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: { ...baseEnv, ...(extraEnv ?? {}) },
    });
    if (stdin !== undefined && child.stdin) {
      try {
        child.stdin.write(stdin);
      } catch (err) {
        this.logger.error(`Job ${id} failed to write stdin payload`, err);
      }
      child.stdin.end();
    }

    // Single cleanup flag to prevent double-unregister
    let groupCleaned = false;
    const cleanupGroup = () => {
      if (groupCleaned) return;
      groupCleaned = true;
      if (child.pid) unregisterProcessGroup(child.pid);
    };

    const job: AsyncJobRecord = {
      id,
      cli,
      args: [...args],
      requestKey,
      correlationId,
      status: "running",
      startedAt,
      finishedAt: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      canceled: false,
      error: null,
      process: child,
      exited: false,
      metricsRecorded: false,
      outputFormat,
      cleanupGroup,
      onComplete,
      onCompleteFired: false,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
      flightRecorderEntry,
      extractUsage,
      flightRecorderComplete: false,
      // R2 Codex-Unit-B F1: pure async path arms now (writeFlightStart=true
      // means the manager is the only FR writer). Sync-deferred path
      // arrives with writeFlightStart=false and arms later via
      // armFlightCompleteForDeferral when awaitJobOrDefer decides to defer.
      flightCompleteArmed: writeFlightStart === true,
    };

    this.jobs.set(id, job);
    this.safeStoreCall("recordStart", () =>
      this.store!.recordStart({
        id,
        correlationId,
        requestKey,
        cli,
        args: [...args],
        outputFormat,
        startedAt,
        pid: child.pid ?? null,
        // F3: stamp the ownership principal from the request context that is
        // ambient at job creation (synchronous with the tool handler). stdio /
        // boot-time orphan paths have no context → "local".
        ownerPrincipal: resolveOwnerPrincipal(getRequestContext()),
      })
    );
    // Slice 1.5: only opt-in callers (pure async handlers) write logStart
    // here. The sync-deferred path passes writeFlightStart=false because
    // the upstream sync handler already wrote a logStart row keyed on the
    // same correlationId; a duplicate INSERT would crash on the PK.
    if (writeFlightStart && flightRecorderEntry) {
      try {
        this.flightRecorder.logStart({
          correlationId,
          cli,
          model: flightRecorderEntry.model,
          prompt: flightRecorderEntry.prompt,
          sessionId: flightRecorderEntry.sessionId,
          asyncJobId: id,
          stablePrefixHash: flightRecorderEntry.stablePrefixHash,
          stablePrefixTokens: flightRecorderEntry.stablePrefixTokens,
          cacheControlBlocks: flightRecorderEntry.cacheControlBlocks,
          cacheControlTtlSeconds: flightRecorderEntry.cacheControlTtlSeconds,
        });
      } catch (err) {
        this.logger.error("Async-path flight recorder logStart failed", err);
      }
    }
    this.logger.info(`Job ${id} started for ${cli}`, { correlationId });

    // Idle timeout: kill process if no output activity for idleTimeoutMs
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        if (job.status !== "running") return;
        job.status = "failed";
        job.exitCode = 125;
        job.error = `Process killed after ${idleTimeoutMs}ms of inactivity`;
        job.finishedAt = new Date().toISOString();
        if (job.process) killProcessGroup(job.process, "SIGTERM");
        this.logger.info(`Job ${id} killed due to inactivity (${idleTimeoutMs}ms)`, {
          correlationId,
        });
        this.emitMetrics(job);
        this.persistComplete(job);
        this.writeFlightComplete(job, "failed");
        this.fireOnComplete(job);
        setTimeout(() => {
          if (!job.exited && job.process) killProcessGroup(job.process, "SIGKILL");
          job.cleanupGroup?.();
        }, 5000);
      }, idleTimeoutMs);
    };
    job.resetIdleTimer = resetIdleTimer;
    job.clearIdleTimer = () => {
      if (idleTimerId) clearTimeout(idleTimerId);
    };
    resetIdleTimer();

    child.stdout?.on("data", (chunk: Buffer) => {
      this.appendOutput(job, "stdout", chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      this.appendOutput(job, "stderr", chunk);
    });

    child.on("error", (error: Error) => {
      job.exited = true;
      job.clearIdleTimer?.();
      job.cleanupGroup?.();
      if (job.status === "running") {
        const launchError = describeProcessLaunchError(cli, error);
        job.status = job.canceled ? "canceled" : "failed";
        job.exitCode = launchError.exitCode;
        job.error = launchError.message;
        job.stderr = job.stderr ? `${job.stderr}\n${launchError.message}` : launchError.message;
        job.finishedAt = new Date().toISOString();
        this.logger.error(`Job ${id} error: ${launchError.message}`, { correlationId });
        this.emitMetrics(job);
        this.persistComplete(job);
        this.writeFlightComplete(job, "failed");
        this.fireOnComplete(job);
      }
    });

    child.on("close", (code: number | null) => {
      job.exited = true;
      job.clearIdleTimer?.();
      // Unregister process group on clean exit (no kill was issued)
      if (!job.canceled && job.status === "running") {
        job.cleanupGroup?.();
      }
      if (job.status !== "running") {
        job.exitCode = job.exitCode ?? code ?? null;
        if (!job.finishedAt) {
          job.finishedAt = new Date().toISOString();
        }
        // Ensure terminal state reaches the durable store (idle-timeout/output-overflow already persisted).
        this.persistComplete(job);
        // Slice 1.5: retry the FR complete write iff the earlier terminal
        // callback's logComplete threw. The single-shot guard in
        // writeFlightComplete makes this a no-op in the common case.
        const fallbackFlightStatus = job.status === "completed" ? "completed" : "failed";
        const fallbackOverride = job.status === "canceled" ? "canceled by caller" : undefined;
        this.writeFlightComplete(job, fallbackFlightStatus, fallbackOverride);
        this.fireOnComplete(job);
        return;
      }

      const rawExitCode = code ?? 0;
      const launchExit =
        !job.stdout && !job.stderr ? describeWindowsLaunchExit(cli, rawExitCode) : null;
      job.exitCode = launchExit?.exitCode ?? rawExitCode;
      if (launchExit) {
        job.error = launchExit.message;
        job.stderr = launchExit.message;
      }
      job.finishedAt = new Date().toISOString();

      if (job.canceled) {
        job.status = "canceled";
      } else if (job.exitCode === 0) {
        job.status = "completed";
      } else {
        job.status = "failed";
      }
      this.emitMetrics(job);
      this.persistComplete(job);
      this.writeFlightComplete(
        job,
        job.status === "completed" ? "completed" : "failed",
        job.status === "canceled" ? "canceled by caller" : undefined
      );
      this.fireOnComplete(job);
    });

    return { snapshot: this.snapshot(job), deduped: false };
  }

  getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = this.hydrateFromStore(jobId) ?? undefined;
      if (!job) return null;
    }
    return this.snapshot(job);
  }

  getJobSnapshots(jobIds: string[]): Record<string, AsyncJobSnapshot | null> {
    return Object.fromEntries(jobIds.map(jobId => [jobId, this.getJobSnapshot(jobId)]));
  }

  getJobResult(jobId: string, maxChars = 200000): AsyncJobResult | null {
    let job = this.jobs.get(jobId);
    if (!job) {
      job = this.hydrateFromStore(jobId) ?? undefined;
      if (!job) return null;
    }

    const stdout = truncateText(job.stdout, maxChars);
    const stderr = truncateText(job.stderr, maxChars);

    return {
      ...this.snapshot(job),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
    };
  }

  cancelJob(jobId: string): { canceled: boolean; reason?: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { canceled: false, reason: "Job not found" };
    }

    if (job.status !== "running") {
      return { canceled: false, reason: `Job is already ${job.status}` };
    }

    // Reconstituted (orphaned) jobs have no live process to signal — refuse cancel.
    if (!job.process) {
      return {
        canceled: false,
        reason: "Job has no live process (orphaned from prior gateway run)",
      };
    }

    job.canceled = true;
    job.status = "canceled";
    job.finishedAt = new Date().toISOString();
    job.clearIdleTimer?.();
    killProcessGroup(job.process, "SIGTERM");
    this.logger.info(`Job ${jobId} canceled`, { correlationId: job.correlationId });
    this.persistComplete(job);
    this.writeFlightComplete(job, "failed", "canceled by caller");
    this.fireOnComplete(job);

    setTimeout(() => {
      if (!job.exited && job.process) killProcessGroup(job.process, "SIGKILL");
      job.cleanupGroup?.();
    }, 5000);

    return { canceled: true };
  }

  getRunningJobs(): {
    jobId: string;
    cli: string;
    status: string;
    pid: number | null;
    startedAt: string;
  }[] {
    const result = [];
    for (const [id, job] of this.jobs) {
      if (job.status === "running") {
        result.push({
          jobId: id,
          cli: job.cli,
          status: job.status,
          pid: job.process?.pid ?? null,
          startedAt: job.startedAt,
        });
      }
    }
    return result;
  }

  getJobHealth(): { runningJobs: number; deadJobs: number; zombieJobs: number; jobs: JobHealth[] } {
    const running = this.getRunningJobs();
    const health = this.processMonitor.checkJobHealth(running);

    // Clean up stale CPU samples for PIDs that are no longer running
    const activePids = new Set(running.map(j => j.pid).filter((p): p is number => p !== null));
    this.processMonitor.cleanupSamples(activePids);

    return {
      runningJobs: running.length,
      deadJobs: health.filter(h => h.isDead).length,
      zombieJobs: health.filter(h => h.isZombie).length,
      jobs: health,
    };
  }

  getJobOutputFormat(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.outputFormat;
  }

  getJobCli(jobId: string): LlmCli | undefined {
    return this.jobs.get(jobId)?.cli;
  }

  private snapshot(job: AsyncJobRecord): AsyncJobSnapshot {
    return {
      id: job.id,
      cli: job.cli,
      status: job.status,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      correlationId: job.correlationId,
      outputTruncated: job.outputTruncated,
      stdoutBytes: Buffer.byteLength(job.stdout),
      stderrBytes: Buffer.byteLength(job.stderr),
      error: job.error,
      exited: job.exited,
    };
  }

  private appendOutput(job: AsyncJobRecord, stream: "stdout" | "stderr", chunk: Buffer): void {
    const totalBytes = Buffer.byteLength(job.stdout) + Buffer.byteLength(job.stderr) + chunk.length;
    if (totalBytes > MAX_OUTPUT_SIZE) {
      job.outputTruncated = true;
      if (job.status === "running") {
        job.status = "failed";
        job.exitCode = 126;
        job.error = "Output exceeded maximum size (50MB)";
        job.finishedAt = new Date().toISOString();
        job.clearIdleTimer?.();
        if (job.process) {
          killProcessGroup(job.process, "SIGTERM");
        }
        this.logger.info(`Job ${job.id} killed due to output overflow`, {
          correlationId: job.correlationId,
        });
        this.emitMetrics(job);
        this.persistComplete(job);
        this.writeFlightComplete(job, "failed", "Output exceeded maximum size (50MB)");
        this.fireOnComplete(job);
        if (job.process) {
          setTimeout(() => {
            if (!job.exited && job.process) killProcessGroup(job.process, "SIGKILL");
            job.cleanupGroup?.();
          }, 5000);
        } else {
          job.cleanupGroup?.();
        }
      }
      return;
    }

    job.resetIdleTimer?.();

    const text = chunk.toString();
    if (stream === "stdout") {
      job.stdout += text;
    } else {
      job.stderr += text;
    }
    job.outputDirty = true;
    this.maybeFlushOutput(job);
  }
}
