import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import os from "os";
import { hrtime } from "process";
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
import { JobStore, computeRequestKey, isValidationRunStore } from "./job-store.js";
import {
  NoopFlightRecorder,
  type FlightLogResult,
  type FlightRecorderLike,
} from "./flight-recorder.js";
import { codexFrResponse } from "./codex-json-parser.js";
import { extractProviderOutputMetadata } from "./provider-output-metadata.js";
import type {
  JobTransport,
  OrphanedJobSnapshot,
  ValidationRunStore,
  SweepCandidate,
} from "./job-store.js";
import { getRequestContext, resolveOwnerPrincipal, principalCanAccess } from "./request-context.js";
import {
  runApiRequest,
  ApiHttpError,
  type ApiProvider,
  type ApiRequest,
  type ApiResult,
  type ApiUsage,
} from "./api-provider.js";
import {
  type JobLimitsConfig,
  DEFAULT_INSTANCE_HEARTBEAT_MS,
  DEFAULT_INSTANCE_LEASE_TTL_MS,
  DEFAULT_HTTP_JOB_GRACE_MS,
  DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  DEFAULT_INSTANCE_GC_MS,
} from "./config.js";

/**
 * #139: runtime lease/heartbeat/sweep cadences threaded into the manager. All
 * default from the config constants so the huge existing test suite (which
 * constructs managers without this) keeps working with the production defaults.
 */
export interface LeaseRuntimeConfig {
  instanceHeartbeatMs: number;
  instanceLeaseTtlMs: number;
  httpJobGraceMs: number;
  orphanSweepIntervalMs: number;
  instanceGcMs: number;
  /** Instance role label for the gateway_instances row (observability). */
  role?: string;
}

const DEFAULT_LEASE_RUNTIME_CONFIG: LeaseRuntimeConfig = {
  instanceHeartbeatMs: DEFAULT_INSTANCE_HEARTBEAT_MS,
  instanceLeaseTtlMs: DEFAULT_INSTANCE_LEASE_TTL_MS,
  httpJobGraceMs: DEFAULT_HTTP_JOB_GRACE_MS,
  orphanSweepIntervalMs: DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
  instanceGcMs: DEFAULT_INSTANCE_GC_MS,
  role: "gateway",
};

/**
 * #139: after this many consecutive heartbeat failures the instance can no
 * longer trust that its lease is being advanced, so it stops admitting durable
 * jobs and stops sweeping (prefer self-quiescence over orphaning others on a
 * stale self-view). See section 5b of the design.
 */
const MAX_CONSECUTIVE_HEARTBEAT_FAILURES = 3;

/**
 * Slice 1: pull the real HTTP status out of a (possibly circuit-breaker-wrapped)
 * runApiRequest rejection. withRetry surfaces the original ApiHttpError as
 * `.cause`, so check both the error and its cause.
 */
export function extractApiHttpStatus(error: unknown): number | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate instanceof ApiHttpError && typeof candidate.status === "number") {
      return candidate.status;
    }
    const status = (candidate as { status?: unknown })?.status;
    if (typeof status === "number") return status;
  }
  return null;
}

/**
 * Slice 1: pull the vendor error body out of a (possibly circuit-breaker-
 * wrapped) runApiRequest rejection — same `.cause` unwrap as
 * `extractApiHttpStatus`.
 */
export function extractApiErrorBody(error: unknown): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate instanceof ApiHttpError && candidate.responseText) {
      return candidate.responseText;
    }
  }
  return undefined;
}

export type LlmCli = "claude" | "codex" | "gemini" | "grok" | "mistral" | "devin" | "cursor";

/**
 * Slice 1: the record/manager-facing provider id. CLI jobs carry an `LlmCli`;
 * http jobs carry an arbitrary `[providers.<name>]` key. `LlmCli` itself stays
 * narrow so `providerCommandName`/`spawnCliProcess`/`buildProviderArgs` are
 * unaffected — only the job record widens. Every LlmCli-specific use of a job's
 * `cli` is guarded by `transport === "process"` first.
 */
export type JobProvider = LlmCli | (string & {});
export type AsyncJobStatus =
  "queued" | "running" | "completed" | "failed" | "canceled" | "orphaned";

export function isAsyncJobInProgress(status: AsyncJobStatus): boolean {
  return status === "queued" || status === "running";
}

const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory retention; durable store has its own (longer) retention
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const OUTPUT_FLUSH_INTERVAL_MS = 1000; // Throttle DB writes for streaming stdout/stderr

/**
 * Issue #130: limits used when an AsyncJobManager is constructed WITHOUT an
 * explicit limits config (e.g. `new AsyncJobManager()` in tests, or legacy
 * callers). These preserve the pre-#130 behaviour exactly: effectively
 * unbounded running/queue capacity, the historical 1h in-memory TTL, and the
 * historical 50MB output cap. Production wiring (index.ts) always passes the
 * conservative, operator-tunable [limits] config instead.
 */
const DEFAULT_MANAGER_JOB_LIMITS: JobLimitsConfig = {
  maxRunningJobs: 1_000_000,
  maxRunningJobsPerProvider: 1_000_000,
  maxQueuedJobs: 1_000_000,
  queueTimeoutMs: 10 * 60 * 1000,
  completedJobMemoryTtlMs: JOB_TTL_MS,
  maxJobOutputBytes: MAX_OUTPUT_SIZE,
};

/**
 * Issue #130: format an output-byte cap for the overflow error message. Chosen
 * so the default 50MB cap renders as "50MB" (the exact string asserted by
 * existing flight-recorder / quality-pass tests); smaller custom caps render as
 * KB or a raw byte count.
 */
function formatByteCap(bytes: number): string {
  if (bytes > 0 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MB`;
  if (bytes > 0 && bytes % 1024 === 0) return `${bytes / 1024}KB`;
  return `${bytes} bytes`;
}

/**
 * Issue #130: thrown when a new job (async, deferred-sync, or direct-sync)
 * cannot be admitted because the global/per-provider running limit is saturated
 * AND the queue is full (or the caller opts out of queueing). Carries a
 * `retryable` marker so the tool layer can render a consistent, retry-safe
 * saturation response rather than a generic spawn failure. Never wraps or
 * exposes prompt/output material.
 */
export class JobSaturationError extends Error {
  readonly retryable = true;
  constructor(
    readonly provider: string,
    readonly detail: string
  ) {
    super(`Gateway is at capacity for ${provider}: ${detail}`);
    this.name = "JobSaturationError";
  }
}

/** A granted execution slot. `release()` is idempotent. */
interface LimiterPermit {
  release(): void;
}

interface LimiterQueueEntry {
  provider: string;
  onGrant: (permit: LimiterPermit) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface JobLimiterSnapshot {
  maxRunning: number;
  maxRunningPerProvider: number;
  maxQueued: number;
  running: number;
  queued: number;
  runningByProvider: Record<string, number>;
  queuedByProvider: Record<string, number>;
  /** Cumulative counters since process start. */
  rejected: number;
  timedOut: number;
  /** True iff a further immediate acquire would have to queue or be rejected. */
  saturated: boolean;
}

/**
 * Least-cost-routing capacity helper (spec 4.3 item 2). Pure and deterministic:
 * reports whether a given provider has reached its per-provider running cap in a
 * limiter snapshot. There is no per-provider `saturated` field on the snapshot
 * (only a global one), so the router derives capacity from the already-exported
 * `runningByProvider` count and `maxRunningPerProvider` cap.
 */
export function providerAtCapacity(snapshot: JobLimiterSnapshot, provider: string): boolean {
  return (snapshot.runningByProvider[provider] ?? 0) >= snapshot.maxRunningPerProvider;
}

/**
 * Issue #130: a small in-process running-limit + FIFO queue owned by
 * AsyncJobManager. It gates BOTH process (CLI) and HTTP API job execution plus
 * the direct-sync execution fallback so no provider process or outbound request
 * is created before a permit is held.
 *
 * Fairness: `pump()` scans the queue in FIFO order and grants the first waiter
 * whose per-provider limit is not saturated, so a provider blocked on its own
 * cap never head-of-line-blocks a different, runnable provider, while same
 * provider waiters still start in arrival order.
 */
class JobLimiter {
  private runningGlobal = 0;
  private runningByProvider = new Map<string, number>();
  private queue: LimiterQueueEntry[] = [];
  private queuedByProvider = new Map<string, number>();
  private rejectedCount = 0;
  private timedOutCount = 0;

  constructor(
    private cfg: {
      maxRunningJobs: number;
      maxRunningJobsPerProvider: number;
      maxQueuedJobs: number;
      queueTimeoutMs: number;
    },
    private logger: Logger
  ) {}

  private canRunNow(provider: string): boolean {
    if (this.runningGlobal >= this.cfg.maxRunningJobs) return false;
    if ((this.runningByProvider.get(provider) ?? 0) >= this.cfg.maxRunningJobsPerProvider) {
      return false;
    }
    return true;
  }

  private grant(provider: string): LimiterPermit {
    this.runningGlobal++;
    this.runningByProvider.set(provider, (this.runningByProvider.get(provider) ?? 0) + 1);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.runningGlobal = Math.max(0, this.runningGlobal - 1);
        const n = (this.runningByProvider.get(provider) ?? 1) - 1;
        if (n <= 0) this.runningByProvider.delete(provider);
        else this.runningByProvider.set(provider, n);
        this.pump();
      },
    };
  }

  /**
   * Try to admit a job for `provider`.
   *  - "granted": a permit is returned inline; the caller may spawn immediately.
   *  - "queued":  the caller was enqueued; `onGrant` fires later when capacity
   *    frees, or `onTimeout` fires if the queue wait exceeds queue_timeout_ms.
   *    `cancel()` removes a still-queued entry (returns true iff it was removed
   *    before being granted/timed out).
   *  - "rejected": the running limit is saturated and the queue is full.
   */
  acquire(
    provider: string,
    onGrant: (permit: LimiterPermit) => void,
    onTimeout: () => void
  ):
    | { state: "granted"; permit: LimiterPermit }
    | { state: "queued"; cancel: () => boolean }
    | { state: "rejected" } {
    if (this.canRunNow(provider)) {
      return { state: "granted", permit: this.grant(provider) };
    }
    if (this.queue.length >= this.cfg.maxQueuedJobs) {
      this.rejectedCount++;
      return { state: "rejected" };
    }
    const entry: LimiterQueueEntry = {
      provider,
      onGrant,
      timer: setTimeout(() => {
        if (this.removeEntry(entry)) {
          this.timedOutCount++;
          onTimeout();
        }
      }, this.cfg.queueTimeoutMs),
    };
    if (entry.timer.unref) entry.timer.unref();
    this.queue.push(entry);
    this.queuedByProvider.set(provider, (this.queuedByProvider.get(provider) ?? 0) + 1);
    return {
      state: "queued",
      cancel: () => this.removeEntry(entry),
    };
  }

  private removeEntry(entry: LimiterQueueEntry): boolean {
    const idx = this.queue.indexOf(entry);
    if (idx < 0) return false;
    this.queue.splice(idx, 1);
    clearTimeout(entry.timer);
    const n = (this.queuedByProvider.get(entry.provider) ?? 1) - 1;
    if (n <= 0) this.queuedByProvider.delete(entry.provider);
    else this.queuedByProvider.set(entry.provider, n);
    return true;
  }

  private pump(): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (let i = 0; i < this.queue.length; i++) {
        const entry = this.queue[i];
        if (!this.canRunNow(entry.provider)) continue;
        this.removeEntry(entry);
        const permit = this.grant(entry.provider);
        try {
          entry.onGrant(permit);
        } catch (err) {
          this.logger.error("JobLimiter onGrant callback threw; releasing permit", err);
          permit.release();
        }
        progressed = true;
        break; // queue mutated and counters changed; restart the scan
      }
    }
  }

  snapshot(): JobLimiterSnapshot {
    const hasProviderBackpressure = [...this.queuedByProvider.keys()].some(
      provider => (this.runningByProvider.get(provider) ?? 0) >= this.cfg.maxRunningJobsPerProvider
    );
    const queueFullUnderPressure =
      this.queue.length > 0 && this.queue.length >= this.cfg.maxQueuedJobs;
    return {
      maxRunning: this.cfg.maxRunningJobs,
      maxRunningPerProvider: this.cfg.maxRunningJobsPerProvider,
      maxQueued: this.cfg.maxQueuedJobs,
      running: this.runningGlobal,
      queued: this.queue.length,
      runningByProvider: Object.fromEntries(this.runningByProvider),
      queuedByProvider: Object.fromEntries(this.queuedByProvider),
      rejected: this.rejectedCount,
      timedOut: this.timedOutCount,
      saturated:
        this.runningGlobal >= this.cfg.maxRunningJobs ||
        hasProviderBackpressure ||
        queueFullUnderPressure,
    };
  }
}

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
  /**
   * Native compressor PR-1 (spec C5 parity fix): the enqueue-time
   * prompt-optimization fact, threaded through so writeFlightComplete stops
   * hardcoding `optimizationApplied: false` on async completions.
   * (optimizeResponse is N/A on the async path; response compression is
   * recorded separately via recordCompressionTelemetry at read time.)
   */
  optimizationApplied?: boolean;
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
  cli: JobProvider;
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
  /**
   * Slice 1: transport family. 'process' jobs carry a live `process`/`pid` and
   * the idle/stall/process-group machinery; 'http' jobs carry an `abort` handle
   * and `httpStatus`, never a pid or process group.
   */
  transport: JobTransport;
  /** Slice 1: AbortController for http jobs (null for process jobs). */
  abort: AbortController | null;
  /** Slice 1: real HTTP status for http jobs (null for process jobs). */
  httpStatus: number | null;
  /**
   * Slice 1 (telemetry parity): structured usage from the http ApiResult,
   * captured directly in finalizeHttpJob (HTTP usage is on the parsed result,
   * NOT in stdout, so the stdout-based `extractUsage` cannot recover it).
   * IN-MEMORY ONLY — not persisted to jobs.db, so a job reconstituted from the
   * store after a restart reports no usage (acceptable for v1; a jobs-table
   * usage migration is deferred to a later slice).
   */
  apiUsage?: ApiUsage;
  /** Slice 1: xAI-style continuation handle from the http result (in-memory). */
  apiResponseId?: string | null;
  /** Slice 1: resolved model echoed by the provider (in-memory). */
  apiModel?: string;
  /** Slice 1: vendor error body (ApiHttpError.responseText) on http failure (in-memory). */
  apiErrorBody?: string;
  /** Slice 1: canonical API request JSON persisted for http jobs (null for process). */
  payloadJson?: string | null;
  exited: boolean;
  metricsRecorded: boolean;
  outputFormat?: string;
  /**
   * Native compressor PR-1 (spec 5.2): effective enqueue-time compression
   * decision. Persisted alongside output_format; NULL/undefined on legacy
   * rows means "not requested".
   */
  compressResponse?: boolean | null;
  /** F3: ownership principal that created the job (null for legacy rows). */
  ownerPrincipal?: string | null;
  resetIdleTimer?: () => void;
  clearIdleTimer?: () => void;
  cleanupGroup?: () => void;
  /**
   * Issue #130: the running-slot permit held while this job executes. Released
   * exactly once (idempotently) via releaseJobPermit on any terminal transition
   * (completed/failed/canceled/orphaned/output-overflow). Undefined while the
   * job is queued (no permit yet) or after release.
   */
  limiterPermit?: LimiterPermit;
  /**
   * Issue #130: for a job still waiting in the limiter queue (status
   * "queued"), removes it from the queue. Returns true iff it was removed
   * before the limiter granted or timed it out. Cleared once the job launches.
   */
  queueCancel?: () => boolean;
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
  cli: JobProvider;
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
  /**
   * Slice 1: structured http telemetry, present only for `transport:'http'`
   * jobs still resident in memory (captured in finalizeHttpJob). Lets the sync
   * caller (awaitApiJobOrDefer) surface usage/httpStatus in the tool response
   * for a job that completed within the sync deadline. Undefined for process
   * jobs and for http jobs reconstituted from the store.
   */
  apiUsage?: ApiUsage;
  httpStatus?: number | null;
  responseId?: string | null;
  model?: string;
  errorBody?: string;
  /**
   * Phase 7: provider-minted session id parsed from the completed job's stdout
   * (process jobs), so a deferred/async job can be polled and then resumed with
   * the real provider session id. Undefined when the provider does not emit one
   * on its transport (typed capability fact).
   */
  providerSessionId?: string;
  /**
   * Phase 7: provider terminal stop reason parsed from the completed job's
   * stdout, WHERE upstream supplies it. Undefined otherwise (capability fact).
   */
  stopReason?: string;
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
  /**
   * Native compressor PR-1 (spec 5.2): the EFFECTIVE enqueue-time
   * compression decision (request param ?? config, outputFormat and
   * output-schema guards already folded in). Persisted on the job record so
   * llm_job_result applies the identical transform at read time, and folded
   * into the dedup key so a compression-on request never dedups onto a
   * compression-off job (or vice versa).
   */
  compressResponse?: boolean;
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

  /** Issue #130: resolved host-protection limits (defaults preserve pre-#130 behaviour). */
  private readonly limits: JobLimitsConfig;
  private readonly limiter: JobLimiter;
  /** Issue #130: configurable in-memory retention + output cap (durable store keeps its own retention). */
  private readonly completedJobMemoryTtlMs: number;
  private readonly maxJobOutputBytes: number;

  // #139 durable-lease state.
  private readonly instanceId: string = randomUUID();
  private readonly hostname: string = os.hostname();
  private readonly instancePid: number = process.pid;
  private readonly lease: LeaseRuntimeConfig;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * #139: true iff this instance may admit durable async jobs. Set false when
   * registerInstance fails at construction, or after sustained heartbeat
   * failure. The tool layer / startJob* sites AND this with hasStore().
   */
  private durableAdmission: boolean;
  private consecutiveHeartbeatFailures = 0;
  /**
   * #139: set for one cycle when the heartbeat timer measured excessive
   * scheduling drift (this event loop was blocked and cannot trust its
   * wall-clock view of other instances), so the next sweep is skipped.
   */
  private skipSweepThisCycle = false;
  /** #139: monotonic expected fire time of the heartbeat timer (ms). */
  private nextHeartbeatExpectedAt = 0;
  private disposed = false;
  /**
   * #139: in-flight durable terminal writes, awaited by dispose() before
   * deregister so a job being finalized is never orphaned mid-write.
   */
  private readonly pendingWrites = new Set<Promise<unknown>>();

  constructor(
    private logger: Logger = noopLogger,
    private onJobComplete?: (cli: JobProvider, durationMs: number, success: boolean) => void,
    store: JobStore | null = null,
    flightRecorder: FlightRecorderLike = new NoopFlightRecorder(),
    limits: JobLimitsConfig = DEFAULT_MANAGER_JOB_LIMITS,
    // Issue #139: DEPRECATED and IGNORED. The durable per-job lease recovery is
    // safe to run from every instance (heartbeat and sweep serialize on the job
    // row), so no instance needs to be a designated sweep "owner". Retained only
    // to preserve the positional signature for existing callers.
    _deprecatedOwnsOrphanRecovery: boolean = true,
    // Issue #139: heartbeat/lease/sweep/GC cadences. Defaults from config so
    // existing callers/tests that omit it get the production defaults.
    leaseConfig: LeaseRuntimeConfig = DEFAULT_LEASE_RUNTIME_CONFIG
  ) {
    this.processMonitor = new ProcessMonitor(logger);
    this.store = store;
    this.flightRecorder = flightRecorder;
    this.limits = limits;
    this.lease = leaseConfig;
    this.completedJobMemoryTtlMs = limits.completedJobMemoryTtlMs;
    this.maxJobOutputBytes = limits.maxJobOutputBytes;
    this.limiter = new JobLimiter(
      {
        maxRunningJobs: limits.maxRunningJobs,
        maxRunningJobsPerProvider: limits.maxRunningJobsPerProvider,
        maxQueuedJobs: limits.maxQueuedJobs,
        queueTimeoutMs: limits.queueTimeoutMs,
      },
      logger
    );

    // #139: register this instance BEFORE any request can be admitted (the
    // register-before-admit invariant: a job row can only be written after the
    // ctor returns, so it always follows a live instance row). registerInstance
    // is fail-closed (NOT swallowed): on failure durable admission is refused
    // and no recovery runs, rather than silently admitting untracked work.
    this.durableAdmission = store !== null;
    if (this.store) {
      try {
        this.store.registerInstance({
          instanceId: this.instanceId,
          role: this.lease.role ?? "gateway",
          hostname: this.hostname,
          pid: this.instancePid,
        });
      } catch (err) {
        this.durableAdmission = false;
        this.logger.error(
          "#139 registerInstance failed; durable async admission is disabled for this instance",
          err
        );
      }
      if (this.durableAdmission) {
        // Startup recovery: the lease sweep (NOT the old blanket orphan-all).
        this.runOrphanSweep();
        this.startHeartbeat();
        this.startReaper();
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

  /** #139: true iff this instance may admit durable async jobs right now. */
  canAdmitDurableJobs(): boolean {
    return this.store !== null && this.durableAdmission;
  }

  /**
   * #139: throw a fail-closed admission error when a durable store is attached
   * but this instance cannot prove its own liveness. A null-store manager
   * (isolate-mode / tests without persistence) is unaffected.
   */
  private assertDurableAdmission(provider: string): void {
    if (this.store && !this.durableAdmission) {
      throw new Error(
        `Durable async admission is disabled for ${provider}: this gateway instance could not register or lost its heartbeat lease. Retry after the gateway recovers.`
      );
    }
  }

  /** #139: register an in-flight async terminal write so dispose() can await it. */
  private trackPendingWrite(p: Promise<unknown>): void {
    this.pendingWrites.add(p);
    void p.finally(() => this.pendingWrites.delete(p));
  }

  /**
   * #139: graceful shutdown. (1) stop admission; (2) clear all timers
   * (heartbeat, sweep, eviction, stall); (3) abort/kill this instance's active
   * owned jobs and await the terminal writes their close handlers / finalizers
   * produce (drain AFTER the kills); (4) deregister ONLY when no active owned
   * work remains, else skip deregister and let the lease expire naturally so a
   * job still being finalized is never orphaned mid-write by another instance.
   * Idempotent; a null-store (isolate-mode) manager disposes as a no-op.
   */
  async dispose(opts: { timeoutMs?: number } = {}): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 5000;
    if (this.disposed) return;
    // (1) stop admission before anything else so no new job slips in mid-dispose.
    this.disposed = true;
    this.durableAdmission = false;
    // (2) clear every timer.
    for (const t of [this.heartbeatTimer, this.sweepTimer, this.evictionTimer, this.stallTimer]) {
      if (t) clearInterval(t);
    }
    this.heartbeatTimer = null;
    this.sweepTimer = null;
    this.evictionTimer = null;
    this.stallTimer = null;

    if (!this.store) return; // isolate-mode / no durable state: nothing to deregister.

    // (3) abort/kill active owned jobs; their close handlers / finalizers run the
    // synchronous terminal recordComplete when they fire.
    const active = [...this.jobs.values()].filter(job => isAsyncJobInProgress(job.status));
    for (const job of active) {
      try {
        if (job.transport === "http") {
          job.abort?.abort();
        } else if (job.process) {
          killProcessGroup(job.process, "SIGTERM");
        }
      } catch (err) {
        this.logger.error(`#139 dispose: failed to signal job ${job.id}`, err);
      }
    }
    // Drain (bounded): wait for the killed jobs to reach a terminal state and for
    // any tracked async terminal writes to settle.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const stillActive = [...this.jobs.values()].some(job => isAsyncJobInProgress(job.status));
      if (!stillActive && this.pendingWrites.size === 0) break;
      await Promise.race([
        Promise.allSettled([...this.pendingWrites]),
        new Promise(resolve => setTimeout(resolve, 50)),
      ]);
    }

    const stillActive = [...this.jobs.values()].some(job => isAsyncJobInProgress(job.status));
    if (stillActive) {
      // (4) do NOT deregister while jobs are still finalizing: let the lease
      // expire so another instance recovers them correctly rather than a
      // mid-write orphan.
      logWarn(
        this.logger,
        "#139 dispose timed out with active owned jobs; skipping deregister and letting the lease expire"
      );
      return;
    }
    try {
      this.store.deregisterInstance(this.instanceId);
    } catch (err) {
      this.logger.error("#139 dispose: deregisterInstance failed", err);
    }
  }

  /** #139 test/observability hook: the instance id stamped on this manager's jobs. */
  getInstanceId(): string {
    return this.instanceId;
  }

  /**
   * #139: the periodic heartbeat. Advances this instance's per-job leases (the
   * authoritative fencing signal) and refreshes the observability row. Measures
   * its own scheduling drift; if the loop was blocked longer than one heartbeat
   * interval, it skips the NEXT sweep (a blocked loop cannot trust its
   * wall-clock view of other instances). Fail tracking drives fail-closed.
   */
  private startHeartbeat(): void {
    const intervalMs = this.lease.instanceHeartbeatMs;
    this.nextHeartbeatExpectedAt = Number(hrtime.bigint() / 1_000_000n) + intervalMs;
    this.heartbeatTimer = setInterval(() => this.onHeartbeatTick(intervalMs), intervalMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  private onHeartbeatTick(intervalMs: number): void {
    if (this.disposed || !this.store) return;
    // Scheduling-drift measurement (monotonic clock): if this tick fired far
    // later than scheduled, the event loop was blocked.
    const nowMonoMs = Number(hrtime.bigint() / 1_000_000n);
    const driftMs = nowMonoMs - this.nextHeartbeatExpectedAt;
    this.nextHeartbeatExpectedAt = nowMonoMs + intervalMs;
    if (driftMs > intervalMs) {
      this.skipSweepThisCycle = true;
      logWarn(
        this.logger,
        `#139 heartbeat scheduling drift ${Math.round(driftMs)}ms exceeded interval ${intervalMs}ms; skipping the next orphan sweep`
      );
    }
    try {
      this.store.heartbeat(this.instanceId);
      this.consecutiveHeartbeatFailures = 0;
    } catch (err) {
      this.consecutiveHeartbeatFailures++;
      this.logger.error(
        `#139 heartbeat failed (${this.consecutiveHeartbeatFailures}/${MAX_CONSECUTIVE_HEARTBEAT_FAILURES})`,
        err
      );
      if (this.consecutiveHeartbeatFailures >= MAX_CONSECUTIVE_HEARTBEAT_FAILURES) {
        // The failure that breaks heartbeats often breaks other writes too, so
        // prefer self-quiescence: stop admitting durable jobs and stop sweeping.
        // Other instances will recover this instance's now-stale-lease jobs
        // correctly once the lease lapses.
        if (this.durableAdmission) {
          this.durableAdmission = false;
          this.logger.error(
            "#139 sustained heartbeat failure; disabling durable admission and orphan sweeping on this instance"
          );
        }
      }
    }
  }

  /**
   * #139: run one orphan sweep synchronously. `public` only so tests can drive
   * the sweep deterministically without waiting on the reaper interval (mirrors
   * `checkStalledJobs`). Production code uses the startup call + reaper timer.
   */
  runOrphanSweepNow(): void {
    this.runOrphanSweep();
  }

  /** #139: the periodic orphan reaper. */
  private startReaper(): void {
    this.sweepTimer = setInterval(() => {
      this.runOrphanSweep();
      // Opportunistically GC long-dead observability rows.
      try {
        this.store?.gcInstances(this.lease.instanceGcMs);
      } catch (err) {
        this.logger.error("#139 gateway_instances GC failed", err);
      }
    }, this.lease.orphanSweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * #139: the fencing orphan sweep. (1) If a recent heartbeat measured a blocked
   * loop, skip this cycle. (2) If durable admission was disabled (sustained
   * heartbeat failure), do not sweep (never orphan on a stale self-view). (3)
   * Run the advisory kill(pid,0) on same-host process candidates and advance the
   * lease for the live ones (bounded grace), then (4) run the guarded store
   * sweep excluding those ids, and (5) emit a flight-recorder completion for
   * each orphaned row.
   */
  private runOrphanSweep(): void {
    if (!this.store || this.disposed || !this.durableAdmission) return;
    if (this.skipSweepThisCycle) {
      this.skipSweepThisCycle = false;
      return;
    }
    const leaseTtl = this.lease.instanceLeaseTtlMs;
    const httpGrace = this.lease.httpJobGraceMs;
    let liveConfirmedIds: string[] = [];
    try {
      const candidates = this.store.selectStaleProcessCandidates(leaseTtl, httpGrace);
      liveConfirmedIds = this.confirmLiveProcessCandidates(candidates);
    } catch (err) {
      this.logger.error("#139 selecting stale process candidates failed", err);
    }
    let orphaned: OrphanedJobSnapshot[];
    try {
      orphaned = this.store.recoverStaleJobs(leaseTtl, httpGrace, liveConfirmedIds);
    } catch (err) {
      this.logger.error("#139 recoverStaleJobs failed", err);
      return;
    }
    if (orphaned.length > 0) {
      this.logger.info(
        `#139 orphaned ${orphaned.length} stale job(s) whose owning instance is gone`
      );
    }
    for (const orphan of orphaned) {
      try {
        this.flightRecorder.logComplete(orphan.correlationId, this.buildOrphanFlightResult(orphan));
      } catch (err) {
        this.logger.error(`#139 FR logComplete for orphaned job ${orphan.id} failed`, err);
      }
    }
  }

  /**
   * #139: advisory, never-vetoing liveness confirmation. For each same-host
   * process candidate with a live pid, return its id (the caller advances its
   * lease by one leaseTtl instead of orphaning it). A dead/missing pid, or a
   * foreign/unknown-host candidate, is NOT confirmed and falls through to the
   * lease decision. Because the grace is one bounded leaseTtl, pid reuse cannot
   * hold a row hostage indefinitely.
   */
  private confirmLiveProcessCandidates(candidates: SweepCandidate[]): string[] {
    const live: string[] = [];
    for (const c of candidates) {
      if (c.transport !== "process" || c.pid == null) continue;
      // Only pid-check candidates known to be on THIS host; a pid is
      // meaningless across hosts.
      if (c.hostname !== null && c.hostname !== this.hostname) continue;
      if (c.hostname === null) continue; // unknown owner host: do not pid-check
      try {
        process.kill(c.pid, 0);
        live.push(c.id); // signal delivered (or EPERM): the pid is alive
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM") live.push(c.id); // exists but not ours: still alive
        // ESRCH (or anything else): treat as dead -> fall through to orphaning.
      }
    }
    return live;
  }

  /**
   * #139: fail-closed durable recordStart. If the durable row cannot be written,
   * the acquired running slot / queued entry is released, the in-memory job is
   * dropped, and the call throws so the request fails, rather than running an
   * in-memory-only job with no owned durable row (which the sweep could never
   * see and no other instance could recover).
   */
  private recordStartOrFailClosed(
    job: AsyncJobRecord,
    acq: { state: "granted"; permit: LimiterPermit } | { state: "queued"; cancel: () => boolean },
    input: Parameters<JobStore["recordStart"]>[0]
  ): void {
    if (!this.store) return;
    try {
      this.store.recordStart(input);
    } catch (err) {
      if (acq.state === "granted") acq.permit.release();
      else acq.cancel();
      this.jobs.delete(job.id);
      this.logger.error(
        `#139 durable recordStart failed for job ${job.id}; failing the request (fail-closed)`,
        err
      );
      throw new Error(
        `Durable job admission failed for ${job.cli}: the job store rejected recordStart`
      );
    }
  }

  /**
   * #139: durable queued -> running transition + pid stamp. `failClosed` throws
   * on failure (process launch: a spawned child must never run against a stale
   * durable 'queued' row); best-effort otherwise (http: no OS process to strand,
   * the lease keeps the row alive and the guarded recordComplete still lands).
   */
  private markRunningDurable(job: AsyncJobRecord, pid: number | null, failClosed = false): void {
    if (!this.store) return;
    let transitioned = false;
    try {
      transitioned = this.store.markRunning(job.id, { pid });
    } catch (err) {
      if (failClosed) throw err;
      this.logger.error(`#139 markRunning (best-effort) failed for job ${job.id}`, err);
      return;
    }
    // A zero-row transition means the durable row was no longer 'queued' (e.g.
    // another instance already swept it to 'orphaned' while it waited in the
    // limiter queue). For a process launch this is fail-closed: refuse to run a
    // spawned child against a recovered row. http is best-effort (no OS process
    // to strand; the guarded recordComplete still lands the terminal result over
    // the orphaned row, so a false here is harmless).
    if (!transitioned && failClosed) {
      throw new Error(
        `#139 markRunning matched no queued row for job ${job.id} (already recovered or terminal); refusing to run a child against a stale durable row`
      );
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
        // Orphans are reconstituted from the durable store, which does not
        // carry the enqueue-time optimization fact; false is the truthful
        // absent state here (spec C5).
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
      // Slice 1: an in-flight http row never settled, so httpStatus is typically
      // null here; thread it through so the orphan complete stays faithful.
      httpStatus: orphan.transport === "http" ? (orphan.httpStatus ?? undefined) : undefined,
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

  /**
   * Cross-LLM validation receipts (Phase 0): the validation-run persistence
   * surface IFF the attached store provides it. Returns null when there is no
   * store or the store is MemoryJobStore, so the receipt feature is gated by
   * capability: under a non-durable backend no run row is ever written.
   */
  getValidationRunStore(): ValidationRunStore | null {
    return this.store && isValidationRunStore(this.store) ? this.store : null;
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
      if (job.status !== "running" && job.status !== "queued" && job.finishedAt) {
        const finishedMs = new Date(job.finishedAt).getTime();
        if (now - finishedMs > this.completedJobMemoryTtlMs) {
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
    outputFormat?: string,
    compressResponse?: boolean
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
    const withFmt = cli === "codex" ? `${withCwd}|fmt:${outputFormat ?? "text"}` : withCwd;
    // Native compressor PR-1 (spec 5.2): the effective compression decision
    // participates in the key, following the codex outputFormat precedent
    // above. Normalised so absent and explicitly-off share the pre-compressor
    // key shape (no missed-dedup on upgrade); only effective-on splits off,
    // so a compression-on request never dedups onto a compression-off job's
    // stored response mode or vice versa.
    const extra = compressResponse ? `${withFmt}|compress:1` : withFmt;
    // Issue #130: scope the dedup key by the owning principal for
    // remote/authenticated callers so two distinct principals issuing identical
    // requests never collide onto (and read) one another's job. Local stdio
    // (principal "local") keeps the exact pre-#130 key shape, so local dedup and
    // any pre-upgrade store rows remain byte-compatible.
    const principal = resolveOwnerPrincipal(getRequestContext());
    const scoped = principal === "local" ? extra : `${extra}|principal:${principal}`;
    return computeRequestKey(cli, args, scoped);
  }

  /**
   * Slice 1: dedup key for an http job. Namespaced by `http:<provider>` so it is
   * disjoint from every argv (process) key, and hashed over the FULLY canonical
   * request — including topP and previousResponseId — so two xAI turns with
   * identical messages but a different continuation never dedup to one job. The
   * apiKey is deliberately excluded (it is a secret and constant across calls).
   */
  private buildHttpRequestKey(providerName: string, req: ApiRequest): string {
    // Issue #130: scope the http dedup key by the owning principal for
    // remote/authenticated callers (see buildRequestKey). Local stdio keeps the
    // exact pre-#130 canonical shape (principal key omitted) for compatibility.
    const principal = resolveOwnerPrincipal(getRequestContext());
    const canonical = {
      transport: "http",
      provider: providerName,
      baseUrl: req.baseUrl,
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? null,
      topP: req.topP ?? null,
      reasoningEffort: req.reasoningEffort ?? null,
      maxOutputTokens: req.maxOutputTokens ?? null,
      previousResponseId: req.previousResponseId ?? null,
      ...(principal === "local" ? {} : { principal }),
    };
    return computeRequestKey(`http:${providerName}`, [], JSON.stringify(canonical));
  }

  /**
   * Shared dedup-reuse path for BOTH transports: return a deduped outcome when a
   * recent matching job exists, else null. Keeps process and http dedup on one
   * runtime path (the only difference is how `requestKey` was computed).
   */
  private tryReuseDedupedJob(
    requestKey: string,
    correlationId: string,
    label: string,
    onComplete?: () => void
  ): StartJobOutcome | null {
    if (!this.store) return null;
    try {
      const existing = this.store.findByRequestKey(requestKey);
      if (!existing) return null;
      // Prefer the in-memory record if we still have it (live process/abort, timers).
      let record = this.jobs.get(existing.id);
      if (!record) record = this.hydrateFromStore(existing.id) ?? undefined;
      if (!record) return null;
      // Issue #130 (defense-in-depth): even though the dedup key is now
      // principal-scoped, never hand back a record the current caller cannot
      // access (e.g. a legacy/pre-upgrade row whose key predates scoping, or a
      // remote caller matching a legacy-unowned row it does not own). Refuse
      // reuse and fall through to a fresh run so no cross-principal result is
      // exposed.
      const caller = resolveOwnerPrincipal(getRequestContext());
      if (!principalCanAccess(record.ownerPrincipal, caller)) {
        this.logger.debug(
          `Dedup reuse refused for ${label}: caller cannot access job ${existing.id}`,
          { correlationId }
        );
        return null;
      }
      this.logger.info(`Job ${existing.id} reused via dedup for ${label}`, {
        correlationId,
        originalCorrelationId: record.correlationId,
        status: record.status,
      });
      // U26: the new request's per-request resources are not consumed by the
      // deduped job — release its cleanup now to avoid an orphaned temp file.
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
    } catch (err) {
      this.logger.error("dedup lookup failed; proceeding with fresh run", err);
      return null;
    }
  }

  /**
   * Slice 1: start an HTTP API-provider request as a first-class AsyncJobRecord.
   * The job flows through the same record map, store, snapshot, dedup, cancel,
   * orphan, and flight-recorder machinery as process jobs — it just carries an
   * `AbortController` instead of a `ChildProcess` and never arms the
   * idle/stall/process-group timers. Ships dormant (no tool calls it until
   * Slice 2).
   */
  startHttpJob(params: {
    provider: ApiProvider;
    apiRequest: ApiRequest;
    correlationId: string;
    forceRefresh?: boolean;
    onComplete?: () => void;
    writeFlightStart?: boolean;
    flightRecorderEntry?: AsyncJobFlightRecorderEntry;
    extractUsage?: AsyncJobUsageExtractor;
  }): StartJobOutcome {
    const {
      provider,
      apiRequest,
      correlationId,
      forceRefresh,
      onComplete,
      writeFlightStart,
      flightRecorderEntry,
      extractUsage,
    } = params;
    const requestKey = this.buildHttpRequestKey(provider.name, apiRequest);

    if (!forceRefresh) {
      const reused = this.tryReuseDedupedJob(requestKey, correlationId, provider.name, onComplete);
      if (reused) return reused;
    }

    // #139: fail-closed admission gate. A dedup reuse above is a read and is
    // fine, but a NEW durable job must not be admitted when this instance cannot
    // prove its own liveness (registration failed or sustained heartbeat loss).
    this.assertDurableAdmission(provider.name);

    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const abort = new AbortController();
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    // SECURITY: never persist the apiKey (a secret) to the durable jobs DB.
    // Store ONLY the canonical request fields (the same material the dedup key
    // hashes), so a logs.db leak never discloses provider credentials — mirrors
    // the config layer's secrets-stay-in-env posture.
    const payloadJson = JSON.stringify({
      baseUrl: apiRequest.baseUrl,
      model: apiRequest.model,
      messages: apiRequest.messages,
      maxOutputTokens: apiRequest.maxOutputTokens,
      temperature: apiRequest.temperature,
      topP: apiRequest.topP,
      reasoningEffort: apiRequest.reasoningEffort,
      previousResponseId: apiRequest.previousResponseId,
    });

    const job: AsyncJobRecord = {
      id,
      cli: provider.name,
      args: [],
      requestKey,
      correlationId,
      // Issue #130: created "queued"; flipped to "running" by launch() the
      // instant a limiter permit is held. No outbound request is made before
      // that point.
      status: "queued",
      startedAt,
      finishedAt: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      canceled: false,
      error: null,
      process: null,
      transport: "http",
      abort,
      httpStatus: null,
      payloadJson,
      exited: false,
      metricsRecorded: false,
      ownerPrincipal,
      onComplete,
      onCompleteFired: false,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
      flightRecorderEntry,
      extractUsage,
      flightRecorderComplete: false,
      flightCompleteArmed: writeFlightStart === true,
    };

    this.jobs.set(id, job);

    // Issue #130: fire the outbound request only once a limiter permit is held.
    const launch = (permit: LimiterPermit): void => {
      job.limiterPermit = permit;
      job.queueCancel = undefined;
      // Canceled/aborted while queued before this grant landed: return the permit.
      if (job.status !== "queued") {
        this.releaseJobPermit(job);
        return;
      }
      job.status = "running";
      // #139: flip the durable row queued -> running (http jobs have no pid).
      // Best-effort here: the row already exists (recordStart) and the lease
      // keeps it alive; an http row that fails to mark-running still carries a
      // valid lease, and finalizeHttpJob's recordComplete lands via the guarded
      // WHERE. The fail-closed contract applies to process launches (a spawned
      // pid running against a stale durable row); http has no such divergence.
      this.markRunningDurable(job, null);
      // Fire the request; settle on the shared terminal helpers. No idle/stall/
      // process-group timers are armed (those are pid-based). #139: track the
      // settle promise so dispose() can await an in-flight http finalize (and
      // its terminal recordComplete) before deregistering.
      const settle = runApiRequest(provider, apiRequest, this.logger, { signal: abort.signal })
        .then(result => this.finalizeHttpJob(job, result, null))
        .catch(error => this.finalizeHttpJob(job, null, error as Error));
      this.trackPendingWrite(settle);
    };

    const acq = this.limiter.acquire(
      provider.name,
      permit => launch(permit),
      () => this.failQueuedJob(job, "queue wait timed out before a run slot was free")
    );
    if (acq.state === "rejected") {
      this.jobs.delete(id);
      throw new JobSaturationError(
        provider.name,
        `running limit (${this.limits.maxRunningJobs} global / ${this.limits.maxRunningJobsPerProvider} per provider) reached and the queue is full (max ${this.limits.maxQueuedJobs}); retry shortly`
      );
    }

    // #139: durable recordStart is fail-closed. If the durable row cannot be
    // written, the request fails and the acquired slot / queued entry is
    // released so nothing untracked can later run.
    this.recordStartOrFailClosed(job, acq, {
      id,
      correlationId,
      requestKey,
      cli: provider.name,
      args: [],
      startedAt,
      pid: null,
      ownerPrincipal,
      ownerInstance: this.instanceId,
      transport: "http",
      payloadJson,
    });
    if (writeFlightStart && flightRecorderEntry) {
      try {
        this.flightRecorder.logStart({
          correlationId,
          cli: provider.name,
          model: flightRecorderEntry.model,
          prompt: flightRecorderEntry.prompt,
          sessionId: flightRecorderEntry.sessionId,
          asyncJobId: id,
        });
      } catch (err) {
        this.logger.error("Async-path flight recorder logStart failed", err);
      }
    }

    if (acq.state === "granted") {
      this.logger.info(`Job ${id} started for ${provider.name} (http)`, { correlationId });
      launch(acq.permit);
    } else {
      job.queueCancel = acq.cancel;
      this.logger.info(`Job ${id} queued for ${provider.name} (http, limiter saturated)`, {
        correlationId,
      });
    }

    return { snapshot: this.snapshot(job), deduped: false };
  }

  /**
   * Slice 1: settle an http job through the SAME terminal helpers as the process
   * close handler (emitMetrics → persistComplete → writeFlightComplete →
   * fireOnComplete). exitCode is 0/1 only; the real HTTP status goes to
   * `httpStatus`. A job already canceled (abort) is left terminal.
   */
  private finalizeHttpJob(
    job: AsyncJobRecord,
    result: ApiResult | null,
    error: Error | null
  ): void {
    if (job.status !== "running") return; // canceled or already settled
    if (result) {
      job.status = "completed";
      job.stdout = result.text;
      job.httpStatus = result.httpStatus;
      job.exitCode = 0;
      // Slice 1: capture structured usage/continuation directly off the result
      // so writeFlightComplete (and getJobResult) can surface them without a
      // stdout re-parse.
      job.apiUsage = result.usage;
      job.apiResponseId = result.responseId ?? null;
      job.apiModel = result.model;
    } else {
      job.status = "failed";
      const status = extractApiHttpStatus(error);
      job.httpStatus = status;
      const message = error?.message ?? "API request failed";
      job.stderr = message;
      job.error = message;
      job.exitCode = 1;
      // Slice 1: preserve the vendor error body so the deferred-completed path
      // can surface it identically to the inline path (unwraps `.cause`).
      job.apiErrorBody = extractApiErrorBody(error);
    }
    job.finishedAt = new Date().toISOString();
    job.exited = true;
    job.abort = null; // request settled — no live handle to cancel
    this.emitMetrics(job);
    this.persistComplete(job);
    this.writeFlightComplete(job, job.status === "completed" ? "completed" : "failed");
    this.fireOnComplete(job);
  }

  private fireOnComplete(job: AsyncJobRecord): void {
    // Issue #130: releasing the running slot is the FIRST thing every terminal
    // transition does. fireOnComplete is invoked at every terminal site
    // (completed/failed/canceled/orphaned/idle-timeout/output-overflow), and
    // releaseJobPermit is idempotent, so the permit is released exactly once
    // regardless of which callback fires first or how many fire.
    this.releaseJobPermit(job);
    if (job.onCompleteFired) return;
    if (!job.onComplete) return;
    job.onCompleteFired = true;
    try {
      job.onComplete();
    } catch (err) {
      this.logger.error(`Job ${job.id} onComplete hook threw`, err);
    }
  }

  /** Issue #130: release a job's running-slot permit exactly once. */
  private releaseJobPermit(job: AsyncJobRecord): void {
    const permit = job.limiterPermit;
    if (!permit) return;
    job.limiterPermit = undefined;
    permit.release();
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
    // Slice 1: http usage comes from the captured ApiResult (apiUsage), NOT the
    // stdout-based extractUsage (which is JSONL-oriented and would return {} for
    // an http job whose stdout is plain ApiResult.text). Process jobs keep the
    // extractUsage path untouched.
    const usage =
      finalStatus !== "completed"
        ? {}
        : job.transport === "http"
          ? this.httpUsage(job)
          : job.extractUsage
            ? this.safeExtractUsage(job)
            : {};
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
    // Slice 1: the codex `--json` JSONL reconstruction is process-only. An http
    // job's stdout is already ApiResult.text — never run it through codexFrResponse
    // (guard on transport so a provider that happens to be named "codex" can't trip it).
    if (job.transport === "process" && job.cli === "codex") {
      const codexText = codexFrResponse(job.outputFormat, job.stdout);
      response = isFailure ? job.stderr || codexText : codexText;
    } else {
      response = isFailure ? job.stderr || job.stdout : job.stdout;
    }
    const exitCode = job.exitCode ?? (finalStatus === "completed" ? 0 : 1);
    const errorMessage = isFailure
      ? (overrideErrorMessage ?? job.error ?? job.stderr ?? `Exit code ${exitCode}`)
      : undefined;

    // Phase 7: persist the provider-minted session id + stop reason so a
    // deferred/async job stays resumable. Process jobs parse them from stdout;
    // http jobs carry the continuation handle in apiResponseId instead.
    const providerMeta =
      finalStatus === "completed" && job.transport === "process"
        ? extractProviderOutputMetadata(job.cli, job.stdout, job.outputFormat)
        : undefined;

    try {
      this.flightRecorder.logComplete(job.correlationId, {
        response,
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        // Native compressor PR-1 (spec C5): the real enqueue-time fact,
        // not a hardcoded false. Response compression never travels through
        // logComplete (it is recorded via recordCompressionTelemetry at
        // llm_job_result read time).
        optimizationApplied: job.flightRecorderEntry.optimizationApplied ?? false,
        exitCode,
        // Slice 1: the real HTTP status lives in its own field — exitCode stays 0/1.
        httpStatus: job.transport === "http" ? (job.httpStatus ?? undefined) : undefined,
        errorMessage,
        status: finalStatus,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        costUsd: usage.costUsd,
        providerSessionId: providerMeta?.sessionId,
        stopReason: providerMeta?.stopReason,
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
   * Slice 1: project the http job's captured ApiResult usage onto the
   * flight-recorder usage shape. (ApiUsage has no cacheCreationTokens; left
   * undefined so the FR row keeps it NULL.)
   */
  private httpUsage(job: AsyncJobRecord): ReturnType<AsyncJobUsageExtractor> {
    const u = job.apiUsage;
    if (!u) return {};
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      costUsd: u.costUsd,
    };
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
    if (isAsyncJobInProgress(job.status)) return;
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
    // Never persist a non-terminal job as complete. "queued" (issue #130) is
    // pre-execution, exactly like "running": neither has a terminal row to write.
    if (job.status === "running" || job.status === "queued") return;
    if (!job.finishedAt) return;
    // Make sure the latest output is captured in the same row update.
    job.outputDirty = false;
    this.safeStoreCall("recordComplete", () =>
      this.store!.recordComplete({
        id: job.id,
        status: job.status === "running" || job.status === "queued" ? "failed" : job.status,
        exitCode: job.exitCode,
        stdout: job.stdout,
        stderr: job.stderr,
        outputTruncated: job.outputTruncated,
        error: job.error,
        finishedAt: job.finishedAt!,
        httpStatus: job.httpStatus,
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

    // Slice 1: branch on transport. http rows persist canonical request JSON in
    // payload_json (argv is meaningless), so don't treat args_json as their
    // payload; they reconstitute with process=null AND abort=null (the live
    // AbortController did not survive the restart → force-orphanable).
    const reconstituted: AsyncJobRecord = {
      id: row.id,
      cli: row.cli as JobProvider,
      args: row.transport === "http" ? [] : args,
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
      transport: row.transport,
      abort: null,
      httpStatus: row.httpStatus,
      payloadJson: row.payloadJson,
      // #139: a durable 'queued' row is not yet launched, so it has NOT exited
      // (regression against `exited = status !== "running"`, which would have
      // marked a durably-queued row exited).
      exited: row.status !== "running" && row.status !== "queued",
      metricsRecorded: true,
      outputFormat: row.outputFormat ?? undefined,
      compressResponse: row.compressResponse ?? null,
      ownerPrincipal: row.ownerPrincipal,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
    };
    this.jobs.set(jobId, reconstituted);
    return reconstituted;
  }

  /**
   * F3b: ownership principal of a job (in-memory or hydrated from the store).
   * Returns undefined when the job does not exist; null/undefined owner means a
   * legacy-unowned row. Used by the llm_job_* handlers to enforce isolation.
   */
  getJobOwner(jobId: string): string | null | undefined {
    let job = this.jobs.get(jobId);
    if (!job) job = this.hydrateFromStore(jobId) ?? undefined;
    return job?.ownerPrincipal;
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
    stdin?: string,
    compressResponse?: boolean
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
      compressResponse,
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
      compressResponse,
    } = opts;
    const requestKey = this.buildRequestKey(
      cli,
      args,
      extraEnv,
      stdin,
      cwd,
      outputFormat,
      compressResponse
    );

    if (!forceRefresh) {
      const reused = this.tryReuseDedupedJob(requestKey, correlationId, cli, onComplete);
      if (reused) return reused;
    }

    // #139: fail-closed admission gate (see startHttpJob).
    this.assertDurableAdmission(cli);

    const id = randomUUID();
    const startedAt = new Date().toISOString();

    // F3: ownership principal from the request context ambient at job creation
    // (synchronous with the tool handler). stdio / boot-time paths → "local".
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const job: AsyncJobRecord = {
      id,
      cli,
      ownerPrincipal,
      args: [...args],
      requestKey,
      correlationId,
      // Issue #130: created "queued"; flipped to "running" by launch() the
      // instant a limiter permit is held (immediately for a granted job, or
      // later when queued capacity frees).
      status: "queued",
      startedAt,
      finishedAt: null,
      exitCode: null,
      stdout: "",
      stderr: "",
      outputTruncated: false,
      canceled: false,
      error: null,
      process: null,
      transport: "process",
      abort: null,
      httpStatus: null,
      exited: false,
      metricsRecorded: false,
      outputFormat,
      compressResponse: compressResponse ?? null,
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

    // Issue #130: spawn + wire the child process. Run inline when the limiter
    // grants a permit immediately, or from the limiter's onGrant callback when
    // the job first had to queue. Never spawns before a permit is held.
    const launch = (permit: LimiterPermit): void => {
      job.limiterPermit = permit;
      job.queueCancel = undefined;
      // If the job was canceled/failed while queued (e.g. queue timeout, or a
      // client cancel) before this grant landed, do not spawn; hand the permit
      // straight back.
      if (job.status !== "queued") {
        this.releaseJobPermit(job);
        return;
      }
      job.status = "running";
      try {
        this.launchProcessJob(job, { cli, args, cwd, stdin, extraEnv, idleTimeoutMs });
      } catch (err) {
        const launchError = describeProcessLaunchError(cli, err as Error);
        job.status = "failed";
        job.exitCode = launchError.exitCode;
        job.error = launchError.message;
        job.stderr = launchError.message;
        job.finishedAt = new Date().toISOString();
        job.exited = true;
        this.logger.error(`Job ${id} failed to spawn: ${launchError.message}`, { correlationId });
        this.emitMetrics(job);
        this.persistComplete(job);
        this.writeFlightComplete(job, "failed");
        this.fireOnComplete(job);
      }
    };

    const acq = this.limiter.acquire(
      cli,
      permit => launch(permit),
      () => this.failQueuedJob(job, "queue wait timed out before a run slot was free")
    );
    if (acq.state === "rejected") {
      this.jobs.delete(id);
      throw new JobSaturationError(
        cli,
        `running limit (${this.limits.maxRunningJobs} global / ${this.limits.maxRunningJobsPerProvider} per provider) reached and the queue is full (max ${this.limits.maxQueuedJobs}); retry shortly`
      );
    }

    // Admitted (running or queued): record ONE store row + optional logStart.
    // pid is null here (unknown until spawn); markRunning stamps the real pid at
    // launch. #139: durable recordStart is fail-closed (see recordStartOrFailClosed).
    this.recordStartOrFailClosed(job, acq, {
      id,
      correlationId,
      requestKey,
      cli,
      args: [...args],
      outputFormat,
      compressResponse,
      startedAt,
      pid: null,
      ownerPrincipal,
      ownerInstance: this.instanceId,
    });
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

    if (acq.state === "granted") {
      this.logger.info(`Job ${id} started for ${cli}`, { correlationId });
      launch(acq.permit);
    } else {
      job.queueCancel = acq.cancel;
      this.logger.info(`Job ${id} queued for ${cli} (limiter saturated)`, { correlationId });
    }

    return { snapshot: this.snapshot(job), deduped: false };
  }

  /**
   * Issue #130: spawn the child CLI and wire its lifecycle for an already
   * admitted (permit-held) process job. Extracted from startJobWithDedup so it
   * can run either inline (limiter granted immediately) or deferred (limiter
   * granted after queueing). Throws if spawnCliProcess itself throws; the caller
   * finalizes the job and releases the permit in that case.
   */
  private launchProcessJob(
    job: AsyncJobRecord,
    spawn: {
      cli: LlmCli;
      args: string[];
      cwd?: string;
      stdin?: string;
      extraEnv?: Record<string, string>;
      idleTimeoutMs?: number;
    }
  ): void {
    const { cli, args, cwd, stdin, extraEnv, idleTimeoutMs } = spawn;
    const id = job.id;
    const correlationId = job.correlationId;
    const command = providerCommandName(cli);
    const baseEnv = envWithExtendedPath(process.env, getExtendedPath());
    const child = spawnCliProcess(command, args, {
      cwd,
      stdio: stdin === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
      env: { ...baseEnv, ...(extraEnv ?? {}) },
      logger: this.logger,
    });
    job.process = child;
    // #139: flip the durable row queued -> running and stamp the REAL child pid
    // (needed by the advisory kill(pid,0) sweep guard). Fail-closed: if the
    // durable transition fails we must not leave a spawned child running against
    // a stale durable 'queued' row (the sweep would treat it as never-launched).
    // Kill the child and rethrow so the launch() caller terminalizes the job and
    // releases the permit.
    try {
      this.markRunningDurable(job, child.pid ?? null, true);
    } catch (err) {
      try {
        killProcessGroup(child, "SIGKILL");
      } catch {
        /* best effort */
      }
      if (child.pid) {
        try {
          unregisterProcessGroup(child.pid);
        } catch {
          /* best effort */
        }
      }
      throw err;
    }
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
    job.cleanupGroup = cleanupGroup;

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
  }

  /**
   * Issue #130: terminate a job that is still waiting in the limiter queue
   * (never spawned a process / made a request). Used for queue-wait timeout.
   * Marks the job failed with a deterministic saturation/timeout error and
   * runs the standard terminal path (metrics, persist, flight-complete,
   * onComplete). Holds no permit, so releaseJobPermit is a no-op.
   */
  private failQueuedJob(job: AsyncJobRecord, reason: string): void {
    if (job.status !== "queued") return;
    job.queueCancel = undefined;
    job.status = "failed";
    // EX_TEMPFAIL (75): a deterministic "temporary failure, safe to retry" code
    // distinct from spawn/timeout/idle exit codes already in use.
    job.exitCode = 75;
    job.error = `Gateway is at capacity for ${job.cli}: ${reason}`;
    job.finishedAt = new Date().toISOString();
    job.exited = true;
    this.logger.info(`Job ${job.id} failed while queued: ${reason}`, {
      correlationId: job.correlationId,
    });
    this.emitMetrics(job);
    this.persistComplete(job);
    this.writeFlightComplete(job, "failed", job.error);
    this.fireOnComplete(job);
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

    // Phase 7: parse provider session id + stop reason from a completed process
    // job's stdout so the poll result carries what a resume needs. Parsed from
    // the FULL (untruncated) stdout, not the display slice above.
    const providerMeta =
      job.transport === "process" && job.status === "completed"
        ? extractProviderOutputMetadata(job.cli, job.stdout, job.outputFormat)
        : undefined;

    return {
      ...this.snapshot(job),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      ...(providerMeta?.sessionId ? { providerSessionId: providerMeta.sessionId } : {}),
      ...(providerMeta?.stopReason ? { stopReason: providerMeta.stopReason } : {}),
      // Slice 1: structured http telemetry (in-memory http jobs only).
      ...(job.transport === "http"
        ? {
            apiUsage: job.apiUsage,
            httpStatus: job.httpStatus,
            responseId: job.apiResponseId,
            model: job.apiModel,
            errorBody: job.apiErrorBody,
          }
        : {}),
    };
  }

  cancelJob(jobId: string): { canceled: boolean; reason?: string } {
    const job = this.jobs.get(jobId);
    if (!job) {
      return { canceled: false, reason: "Job not found" };
    }

    // Issue #130: a job still waiting in the limiter queue has no process or
    // in-flight request yet. Remove it from the queue (releasing the queue slot
    // and its wait timer) and mark it canceled without ever spawning.
    if (job.status === "queued") {
      job.queueCancel?.();
      job.queueCancel = undefined;
      job.canceled = true;
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      job.exited = true;
      this.logger.info(`Job ${jobId} canceled while queued`, {
        correlationId: job.correlationId,
      });
      this.emitMetrics(job);
      this.persistComplete(job);
      this.writeFlightComplete(job, "failed", "canceled by caller");
      this.fireOnComplete(job);
      return { canceled: true };
    }

    if (job.status !== "running") {
      return { canceled: false, reason: `Job is already ${job.status}` };
    }

    // Slice 1: http jobs cancel by aborting the in-flight request, not by
    // signalling a process. A reconstituted http row has no live abort handle
    // (the AbortController did not survive the restart) → refuse.
    if (job.transport === "http") {
      if (!job.abort) {
        return {
          canceled: false,
          reason: "Job has no live request (orphaned from prior gateway run)",
        };
      }
      job.canceled = true;
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
      job.abort.abort();
      this.logger.info(`Job ${jobId} canceled (http)`, { correlationId: job.correlationId });
      this.emitMetrics(job);
      this.persistComplete(job);
      this.writeFlightComplete(job, "failed", "canceled by caller");
      this.fireOnComplete(job);
      return { canceled: true };
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

  /**
   * Issue #130: acquire a running-slot permit for the DIRECT-SYNC execution
   * fallback (index.ts calls executeCli itself instead of going through a job
   * record when deferral is disabled/unavailable). Resolves with a permit the
   * caller MUST release when the process exits; rejects with a JobSaturationError
   * when the limit is saturated and the queue is full or the queue wait times
   * out. This puts the sync bypass under the exact same host-protection envelope
   * as async/deferred jobs.
   */
  acquireProcessSlot(provider: string): Promise<{ release: () => void }> {
    return new Promise((resolve, reject) => {
      const acq = this.limiter.acquire(
        provider,
        permit => resolve(permit),
        () =>
          reject(
            new JobSaturationError(
              provider,
              "queue wait timed out before a run slot was free; retry shortly"
            )
          )
      );
      if (acq.state === "granted") {
        resolve(acq.permit);
      } else if (acq.state === "rejected") {
        reject(
          new JobSaturationError(
            provider,
            `running limit (${this.limits.maxRunningJobs} global / ${this.limits.maxRunningJobsPerProvider} per provider) reached and the queue is full (max ${this.limits.maxQueuedJobs}); retry shortly`
          )
        );
      }
      // queued: resolves via onGrant (a slot freed) or rejects via onTimeout.
    });
  }

  /** Issue #130: current limiter state for /healthz and llm_process_health. */
  getLimiterSnapshot(): JobLimiterSnapshot {
    return this.limiter.snapshot();
  }

  /** Issue #130: the effective (redaction-safe) job-execution limits. */
  getConfiguredLimits(): JobLimitsConfig {
    return { ...this.limits };
  }

  getJobOutputFormat(jobId: string): string | undefined {
    return this.jobs.get(jobId)?.outputFormat;
  }

  /**
   * Native compressor PR-1 (spec 5.2): the job's persisted effective
   * compression decision. NULL/undefined (legacy or pre-compressor rows)
   * means "not requested"; llm_job_result treats only `true` as opt-in.
   */
  getJobCompressResponse(jobId: string): boolean {
    return this.jobs.get(jobId)?.compressResponse === true;
  }

  getJobCli(jobId: string): JobProvider | undefined {
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
    if (totalBytes > this.maxJobOutputBytes) {
      job.outputTruncated = true;
      if (job.status === "running") {
        // Issue #130: the cap is configurable via [limits].max_job_output_bytes;
        // the message renders "50MB" at the default cap (asserted by tests).
        const overflowMsg = `Output exceeded maximum size (${formatByteCap(this.maxJobOutputBytes)})`;
        job.status = "failed";
        job.exitCode = 126;
        job.error = overflowMsg;
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
        this.writeFlightComplete(job, "failed", overflowMsg);
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
