import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import os from "os";
import { hrtime } from "process";
import {
  createProcessGroupTerminationFence,
  envWithExtendedPath,
  getExtendedPath,
  killProcessGroup,
  providerCommandName,
  spawnCliProcess,
  unregisterProcessGroup,
} from "./executor.js";
import {
  type ChildStdinDelivery,
  CHILD_STDIN_INCOMPLETE_EXIT_CODE,
  CHILD_STDIN_INCOMPLETE_MESSAGE,
  ChildStdinIncompleteError,
  ChildStdinWriteFailedError,
  isChildStdinDeliveryIncomplete,
  normalizeChildStdinDeliveryError,
  writeAndCloseChildStdin,
} from "./child-stdin.js";
import type { Logger } from "./logger.js";
import { noopLogger, logWarn } from "./logger.js";
import { ProcessMonitor, type JobHealth } from "./process-monitor.js";
import {
  JobStore,
  computeRequestKey,
  isValidationRunStore,
  type AcknowledgedKitAttemptRelease,
  type JobRecord,
  type KitAttemptFenceResult,
  type ValidationJobAdmission,
} from "./job-store.js";
import {
  NoopFlightRecorder,
  type FlightLogResult,
  type FlightRecorderLike,
} from "./flight-recorder.js";
import { codexFrResponse } from "./codex-json-parser.js";
import {
  getClaudeMcpArtifactScopeForPath,
  isClaudeMcpArtifactPath,
  removeClaudeMcpArtifact,
} from "./claude-mcp-config.js";
import { assertMcpArtifactAdmissionInvariant } from "./mcp-artifact-admission.js";
import {
  createPersonalKitTerminalMetadata,
  extractProviderOutputMetadata,
  redactKnownProviderSessionId,
  type PersonalKitTerminalMetadata,
} from "./provider-output-metadata.js";
import type {
  JobTransport,
  OrphanedJobSnapshot,
  PendingMcpArtifactCleanup,
  PendingKitFinalization,
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
import {
  cloneKitExecutionRef,
  personalKitJobRequestKey,
  type KitExecutionRef,
} from "./personal-config-types.js";
import {
  JobProgressTracker,
  parseStoredJobProgress,
  type JobProgressCapability,
  type JobProgressKind,
  type JobProgressPhase,
  type JobProgressSnapshot,
} from "./job-progress.js";
import {
  CLI_INVALID_INPUT_CATEGORY,
  CLI_INPUT_TOO_LARGE_CATEGORY,
  normalizeCliInputAdmissionError,
} from "./cli-input-limits.js";

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
 * A transient store outage must not leave this process permanently quiesced.
 * Require several healthy lease writes before re-admitting work, then
 * re-register the instance atomically with its current process metadata.
 */
const MIN_CONSECUTIVE_HEARTBEAT_SUCCESSES_TO_RECOVER = 3;

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
export type AsyncJobErrorCategory =
  typeof CLI_INPUT_TOO_LARGE_CATEGORY | typeof CLI_INVALID_INPUT_CATEGORY;

export function isAsyncJobInProgress(status: AsyncJobStatus): boolean {
  return status === "queued" || status === "running";
}

const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory retention; durable store has its own (longer) retention
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const OUTPUT_FLUSH_INTERVAL_MS = 1000; // Throttle DB writes for streaming stdout/stderr
const TERMINAL_HOOK_WAIT_TIMEOUT_MS = 30_000;
const PERSONAL_KIT_OUTPUT_WITHHELD =
  "Personal Agent Config Kit provider output is withheld from durable job history";
const PERSONAL_KIT_FAILURE_WITHHELD =
  "Personal Agent Config Kit provider execution failed; detailed output is withheld";

function parsePersistedJobArgs(argsJson: string): string[] {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

/** Capability follows the provider's actual wire format, not its presentation mode. */
function resolveJobProgressCapability(
  cli: string,
  args: readonly string[],
  outputFormat: string | undefined,
  transport: JobTransport
): JobProgressCapability {
  if (transport === "http") return "lifecycle_only";
  if (cli === "codex") {
    const endOfOptions = args.indexOf("--");
    const options = endOfOptions >= 0 ? args.slice(0, endOfOptions) : args;
    return options.includes("--json") ? "structured" : "activity_only";
  }
  if (cli === "claude" && outputFormat === "stream-json") return "structured";
  if (cli === "grok" && outputFormat === "streaming-json") return "structured";
  return "activity_only";
}

/**
 * Return the one generated `--mcp-config` argument only when the durable argv
 * is structurally unambiguous. Durable rows are recovery input, not authority
 * to delete arbitrary paths, so malformed or repeated flags are rejected.
 */
function parseClaudeMcpArtifactArg(argsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || !parsed.every(arg => typeof arg === "string")) {
    return null;
  }

  let configPath: string | null = null;
  for (let index = 0; index < parsed.length; index++) {
    if (parsed[index] !== "--mcp-config") continue;
    const value = parsed[index + 1];
    if (configPath !== null || typeof value !== "string") return null;
    configPath = value;
    index++;
  }
  return configPath;
}

/**
 * A cleanup pin is accepted only for a Claude argv whose one `--mcp-config`
 * value is the same generated path. This keeps a generic caller-supplied
 * artifact flag from becoming a durable retention pin.
 */
function resolvePersistedClaudeMcpArtifactPath(
  cli: LlmCli,
  args: string[],
  requestedPath: string | undefined
): string | null {
  if (!requestedPath) return null;
  if (cli !== "claude") {
    throw new Error("Only Claude jobs can persist an MCP artifact cleanup obligation");
  }
  const argvPath = parseClaudeMcpArtifactArg(JSON.stringify(args));
  if (argvPath !== requestedPath || !isClaudeMcpArtifactPath(requestedPath)) {
    throw new Error("Claude MCP artifact provenance does not match the launched argv");
  }
  return requestedPath;
}

/**
 * Persist the scope captured by the config writer, not a newly observed scope.
 * A directory replacement between artifact creation and admission must fail
 * closed before a child launches or a retention pin is written.
 */
function resolvePersistedClaudeMcpArtifactScope(
  artifactPath: string | null,
  requestedScope: string | undefined
): string | null {
  if (!artifactPath) {
    if (requestedScope !== undefined) {
      throw new Error("Claude MCP artifact scope requires an artifact path");
    }
    return null;
  }
  if (!requestedScope) {
    throw new Error("Claude MCP artifact cleanup obligation requires a captured artifact scope");
  }
  let observedScope: string;
  try {
    observedScope = getClaudeMcpArtifactScopeForPath(artifactPath);
  } catch (error) {
    throw new Error("Claude MCP request artifact directory changed before durable admission", {
      cause: error,
    });
  }
  if (observedScope !== requestedScope) {
    throw new Error("Claude MCP request artifact directory changed before durable admission");
  }
  return requestedScope;
}

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

export class DurableJobAdmissionError extends Error {
  constructor(
    readonly provider: string,
    cause: unknown
  ) {
    super(`Durable job admission failed for ${provider}: the job store rejected recordStart`, {
      cause,
    });
    this.name = "DurableJobAdmissionError";
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
): {
  exitCode: number;
  message: string;
  errorCategory: AsyncJobErrorCategory | null;
  retryable: boolean | null;
} {
  const inputAdmission = normalizeCliInputAdmissionError(error, {
    provider: cli,
    inputName: "argv",
  });
  if (inputAdmission) {
    return {
      exitCode: 126,
      message: inputAdmission.message,
      errorCategory: inputAdmission.errorCategory,
      retryable: inputAdmission.retryable,
    };
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT") {
    return {
      exitCode: 127,
      message: `The '${cli}' command was not found. Install the ${cli} CLI and make sure it is on PATH. (${error.message})`,
      errorCategory: null,
      retryable: null,
    };
  }
  return {
    exitCode: 126,
    message: `Failed to launch ${cli} CLI: ${error.message}`,
    errorCategory: null,
    retryable: null,
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

const PERSONAL_KIT_FLIGHT_PROMPT_WITHHELD =
  "Personal Agent Config Kit prompt is withheld from durable history";

/**
 * The manager is the final flight-recorder boundary for every durable Kit
 * execution. Handler-level callers may retain a caller task for non-Kit jobs,
 * but a Kit record receives only this fixed marker and narrow operational
 * metadata so a new call site cannot persist a compiled context by accident.
 */
function redactPersonalKitFlightRecorderEntry(
  entry: AsyncJobFlightRecorderEntry | undefined,
  kitExecution: KitExecutionRef | null
): AsyncJobFlightRecorderEntry | undefined {
  if (!entry || !kitExecution) return entry;
  return {
    model: entry.model,
    prompt: PERSONAL_KIT_FLIGHT_PROMPT_WITHHELD,
    optimizationApplied: entry.optimizationApplied,
  };
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
  /**
   * Cost basis label (provider-reported | derived-from-tokens |
   * pre-flight-estimate) for the recorded cost. Set by the index.ts handoff so a
   * T2 provider's derived-from-tokens backfill lands on the async/deferred
   * completion path, not just the sync routed path (LCR phase_1).
   */
  costBasis?: string;
};

/**
 * Terminal lifecycle signal for gateway-owned state such as Kit release pins.
 * It is deliberately distinct from `artifactCleanup`: the latter releases a
 * request-local temp resource and must also run immediately on dedup reuse.
 */
export interface AsyncJobTerminalEvent {
  snapshot: AsyncJobSnapshot;
  /** Durable owner of the job. Lifecycle hooks must restore this principal before touching owned state. */
  ownerPrincipal: string | null;
  kitExecution: KitExecutionRef | null;
  /** Gateway-owned Kit session that must receive terminal lifecycle finalization. */
  kitSessionId: string | null;
  /** Validated provider continuation fact, never raw stdout/stderr. */
  terminalMetadata: PersonalKitTerminalMetadata | null;
}

export type AsyncJobTerminalHook = (event: AsyncJobTerminalEvent) => void | Promise<void>;

/** Durable restart-reconciliation payload for a terminal Kit job. */
export type AsyncKitTerminalFinalization = PendingKitFinalization;
export type AsyncAcknowledgedKitAttemptRelease = AcknowledgedKitAttemptRelease;

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
  errorCategory: AsyncJobErrorCategory | null;
  retryable: boolean | null;
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
  /** A process has been signalled but has not reached its close event yet. */
  terminationRequested?: boolean;
  /** The provider closed stdin before the complete request reached its pipe. */
  stdinDeliveryIncomplete?: boolean;
  /** A non-closure stdin write failed with its native details discarded. */
  stdinDeliveryFailed?: boolean;
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
  /** Exact Claude MCP artifact still awaiting durable cleanup acknowledgement. */
  mcpArtifactPath: string | null;
  /** Durable installation-and-filesystem scope for the exact MCP artifact. */
  mcpArtifactScope: string | null;
  /** Immutable Kit execution identity, null for disabled/legacy requests. */
  kitExecution: KitExecutionRef | null;
  /** Gateway-owned Kit session which is eligible for durable reconciliation. */
  kitSessionId: string | null;
  /** Set only after the terminal hook's session update was durably acknowledged. */
  kitTerminalFinalized: boolean;
  /** Process-local validated continuation fact, never a durable job value. */
  kitTerminalMetadata?: PersonalKitTerminalMetadata | null;
  /** False only for a row hydrated after a process restart. */
  kitOutputAvailableInMemory?: boolean;
  /** True only after recordComplete has durably recorded this terminal result. */
  terminalPersistenceAcknowledged?: boolean;
  /** Bounded-backoff retry timer for a failed durable terminal write. */
  terminalPersistenceRetryTimer?: ReturnType<typeof setTimeout>;
  terminalPersistenceRetryDelayMs?: number;
  /** Privacy-projected, bounded live progress. Raw provider content never enters this tracker. */
  progress: JobProgressTracker;
  progressDirty: boolean;
  lastProgressFlushAt: number;
  /** True only for a projection reconstructed from the shared durable store. */
  hydratedFromStore?: boolean;
  resetIdleTimer?: () => void;
  clearIdleTimer?: () => void;
  cleanupGroup?: () => void;
  /** Signal the whole provider group and retain ownership through escalation. */
  terminateProcessGroup?: (signal?: NodeJS.Signals, graceMs?: number) => void;
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
  /** Request-local artifact cleanup, including the legacy `onComplete` alias. */
  artifactCleanup?: () => void;
  artifactCleanupFired?: boolean;
  /** Durable lifecycle callback, never fired for a dedup-reused caller. */
  onTerminal?: AsyncJobTerminalHook;
  onTerminalFired?: boolean;
  /**
   * Resolves when this instance has finished the terminal lifecycle callback.
   * It is intentionally in-memory only: a restarted instance must reconcile a
   * durable Kit job rather than assume its former callback completed.
   */
  terminalHookCompletion?: Promise<boolean>;
  resolveTerminalHookCompletion?: (success: boolean) => void;
  terminalHookOutcome?: boolean;
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
  /** Stable public classification for typed gateway failures. */
  errorCategory?: AsyncJobErrorCategory;
  /** Whether retrying the same unchanged request can succeed. */
  retryable?: boolean;
  exited: boolean;
  progress: JobProgressSnapshot;
}

/**
 * Recovery callers must distinguish a missing durable row from an unavailable
 * store. Treating both as null lets a transient database error release a Kit
 * native-session lease while its provider process may still be alive.
 */
export type AsyncJobSnapshotLookup =
  | {
      state: "found";
      snapshot: AsyncJobSnapshot;
      kitExecution: KitExecutionRef | null;
      kitSessionId: string | null;
      kitTerminalFinalized: boolean;
    }
  | { state: "not_found" }
  | { state: "unavailable" };

export interface AsyncJobResult extends AsyncJobSnapshot {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Character offset of this stdout page in the captured stream. */
  stdoutOffsetChars: number;
  /** Total captured stdout length in UTF-16 code units. */
  stdoutTotalChars: number;
  /** Next stdout offset, or null when this page reaches the end of the stream. */
  stdoutNextOffsetChars: number | null;
  /** Character offset of this stderr page in the captured stream. */
  stderrOffsetChars: number;
  /** Total captured stderr length in UTF-16 code units. */
  stderrTotalChars: number;
  /** Next stderr offset, or null when this page reaches the end of the stream. */
  stderrNextOffsetChars: number | null;
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
function canonicaliseEnvForKey(env?: NodeJS.ProcessEnv): string {
  if (!env) return "";
  const entries = Object.entries(env)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [k, String(v)] as [string, string]);
  if (entries.length === 0) return "";
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify(entries);
}

/**
 * Kit output must always be tied to a gateway session before a job can be
 * admitted. Without that binding a terminal provider handle would be durable
 * but unrecoverable after a gateway restart, so reject the request up front.
 */
function normalizeKitSessionId(
  kitExecution: KitExecutionRef | null,
  kitSessionId: string | undefined
): string | null {
  if (!kitExecution) {
    if (kitSessionId !== undefined) {
      throw new Error("kitSessionId requires kitExecution");
    }
    return null;
  }
  if (typeof kitSessionId !== "string") {
    throw new Error("Kit async jobs require a gateway kitSessionId");
  }
  const normalized = kitSessionId.trim();
  const containsControlCharacter = Array.from(normalized).some(character => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if (!normalized || normalized.length > 512 || containsControlCharacter) {
    throw new Error("Kit async jobs require a valid gateway kitSessionId");
  }
  return normalized;
}

function normalizeReservedKitJobId(
  kitExecution: KitExecutionRef | null,
  jobId: string | undefined
): string | null {
  if (!kitExecution) {
    if (jobId !== undefined) throw new Error("jobId reservation requires kitExecution");
    return null;
  }
  if (jobId === undefined) return null;
  const normalized = jobId.trim();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)
  ) {
    throw new Error("Kit jobId reservation must be a UUID");
  }
  return normalized;
}

/**
 * Kit argv contains compiled private instructions for Codex. An invalid argv
 * containing NUL must also never become durable evidence. A persisted job
 * cannot restart either vector, so retain only an audit marker and keep the
 * exact live argv in memory until launch admission finishes.
 */
const INVALID_ARGV_REDACTION_MARKER = "[invalid argv redacted]";
const INVALID_ARGV_FLIGHT_MODEL = "invalid-input";

function containsInvalidCliArg(args: readonly string[]): boolean {
  return args.some(argument => argument.includes("\0"));
}

function persistableJobArgs(args: string[], kitExecution: KitExecutionRef | null): string[] {
  if (kitExecution) return ["[personal-config-kit arguments redacted]"];
  if (containsInvalidCliArg(args)) {
    return [INVALID_ARGV_REDACTION_MARKER];
  }
  return [...args];
}

/**
 * A NUL-bearing argv is not a provider request and must never create a second
 * durable copy of the rejected vector through flight-recorder metadata. Keep a
 * bounded audit row while dropping every caller-derived flight field. Valid
 * jobs retain their exact existing flight-recorder behavior.
 */
function redactInvalidArgvFlightRecorderEntry(
  entry: AsyncJobFlightRecorderEntry | undefined,
  invalidArgv: boolean
): AsyncJobFlightRecorderEntry | undefined {
  if (!entry || !invalidArgv) return entry;
  return {
    model: INVALID_ARGV_FLIGHT_MODEL,
    prompt: INVALID_ARGV_REDACTION_MARKER,
    optimizationApplied: entry.optimizationApplied,
  };
}

function createTerminalHookCompletion(): {
  promise: Promise<boolean>;
  resolve: (success: boolean) => void;
} {
  let resolve!: (success: boolean) => void;
  const promise = new Promise<boolean>(settle => {
    resolve = settle;
  });
  return { promise, resolve };
}

function pageText(
  value: string,
  maxChars: number,
  requestedOffsetChars: number
): {
  text: string;
  truncated: boolean;
  offsetChars: number;
  totalChars: number;
  nextOffsetChars: number | null;
} {
  const offsetChars = Math.min(Math.max(0, requestedOffsetChars), value.length);
  const endOffsetChars = Math.min(value.length, offsetChars + maxChars);
  return {
    text: value.slice(offsetChars, endOffsetChars),
    truncated: endOffsetChars < value.length,
    offsetChars,
    totalChars: value.length,
    nextOffsetChars: endOffsetChars < value.length ? endOffsetChars : null,
  };
}

/**
 * Redact every overlap between a known provider-native identifier and one
 * captured-output page. `offsetChars` is measured in the original stream, so
 * a secret split across two caller-selected pages is redacted on both pages
 * instead of escaping a whole-string replacement performed after pagination.
 */
function redactKnownTextPage(
  page: string,
  offsetChars: number,
  fullText: string,
  secret: string
): string {
  if (!page || !secret) return page;
  const pageEnd = offsetChars + page.length;
  let matchOffset = fullText.indexOf(secret);
  let cursor = 0;
  let redacted = "";
  while (matchOffset !== -1) {
    const matchEnd = matchOffset + secret.length;
    const overlapStart = Math.max(offsetChars, matchOffset);
    const overlapEnd = Math.min(pageEnd, matchEnd);
    if (overlapStart < overlapEnd) {
      const localStart = overlapStart - offsetChars;
      const localEnd = overlapEnd - offsetChars;
      redacted += page.slice(cursor, localStart);
      redacted += "[redacted-session-id]";
      cursor = localEnd;
    }
    matchOffset = fullText.indexOf(secret, matchOffset + secret.length);
  }
  return cursor === 0 ? page : redacted + page.slice(cursor);
}

export interface StartJobOptions {
  cwd?: string;
  idleTimeoutMs?: number;
  outputFormat?: string;
  /** Bypass dedup and force a fresh CLI run even if a recent matching job exists. */
  forceRefresh?: boolean;
  /**
   * Canonical argv used only to calculate dedup identity. The launched and
   * persisted argv remain `args`. This supports request-local artifact paths
   * whose random filename must not defeat otherwise identical dedup requests.
   */
  dedupArgs?: string[];
  /**
   * Redacted argv written to durable storage while `args` remains the exact
   * launch vector. Intended for bounded retained evidence such as code-review
   * prompts that must not also be copied into args_json.
   */
  persistedArgs?: string[];
  /** Optional retained non-secret process input, evicted with the job row. */
  payloadJson?: string;
  /**
   * Extra environment variables to inject when spawning the child CLI.
   * Used by Mistral Vibe to pass `VIBE_ACTIVE_MODEL` (Vibe has no `--model` flag).
   *
   * IMPORTANT: env vars participate in the dedup key (canonicalised by sorted
   * keys + JSON-stringified). Two requests that differ only in env (e.g. two
   * Mistral requests with the same prompt but different VIBE_ACTIVE_MODEL)
   * therefore do NOT collide on dedup.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Optional gateway-owned UTF-8 payload to pipe into the child stdin. Claude
   * uses it for cache-control streams. Every Codex new/resume request uses it
   * with the literal `-` prompt marker; Kit requests prepend private context to
   * that payload. It participates in dedup, so matching argv with different
   * stdin never collide. `codex_fork_session` remains argv-bound. When absent,
   * stdio[0] remains "ignore".
   */
  stdin?: string;
  /**
   * Legacy alias for `artifactCleanup`. It releases request-local resources
   * (such as output-schema temp files) on terminal completion or immediately
   * when the request dedups onto an existing job.
   */
  onComplete?: () => void;
  /** Explicit name for the request-local cleanup hook. */
  artifactCleanup?: () => void;
  /**
   * Exact gateway-generated Claude MCP config path. The manager validates that
   * it is the one launched in argv before making durable retention depend on
   * its origin-host cleanup acknowledgement.
   */
  mcpArtifactPath?: string;
  /**
   * Scope captured by the config writer for `mcpArtifactPath`. It is required
   * for a durable cleanup obligation so a later directory lookup cannot bind a
   * request file to a replacement installation.
   */
  mcpArtifactScope?: string;
  /** Exactly-once terminal lifecycle signal for the newly-created job only. */
  onTerminal?: AsyncJobTerminalHook;
  /** Immutable Kit context persisted for session fencing and release pinning. */
  kitExecution?: KitExecutionRef | null;
  /** Gateway-owned Kit session. Required whenever `kitExecution` is supplied. */
  kitSessionId?: string;
  /**
   * Caller-reserved durable id for a Kit job. The Kit session records this id
   * before admission, closing the session-to-job crash gap.
   */
  jobId?: string;
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
  /** Hold a newly admitted queued job until the caller releases the launch gate. */
  deferLaunch?: boolean;
  /** Durable review-run link committed atomically with the queued job row. */
  validationAdmission?: ValidationJobAdmission;
}

export interface DeferredJobLaunch {
  release(): void;
  cancel(): boolean;
}

export interface StartJobOutcome {
  snapshot: AsyncJobSnapshot;
  /** Set to the existing job's id when the request was de-duplicated. */
  deduped: boolean;
  /** Set when deduped — the original job's correlation id, useful for logging. */
  originalCorrelationId?: string;
  /** Present only when deferLaunch admitted a fresh job behind a launch gate. */
  deferredLaunch?: DeferredJobLaunch;
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
  private consecutiveHeartbeatSuccesses = 0;
  private lastHeartbeatFailureAt: string | null = null;
  private lastHeartbeatRecoveryAt: string | null = null;
  private lastHeartbeatErrorName: string | null = null;
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
    // ctor returns, so it always follows a live instance row). A failed initial
    // registration remains fail-closed, but heartbeat/reaper timers still run
    // so a transient durable-store outage can recover without a process restart.
    this.durableAdmission = false;
    if (this.store) {
      this.restoreDurableAdmission("startup");
      this.startHeartbeat();
      this.startReaper();
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
   * Prompt-free durable-store state for health surfaces. Keep diagnostic detail
   * to timestamps and error class, never a raw database error that could expose
   * query data or connection material.
   */
  getDurableAdmissionHealth(): {
    storeAttached: boolean;
    admitting: boolean;
    consecutiveHeartbeatFailures: number;
    consecutiveHeartbeatSuccesses: number;
    lastHeartbeatFailureAt: string | null;
    lastHeartbeatRecoveryAt: string | null;
    lastHeartbeatErrorName: string | null;
  } {
    return {
      storeAttached: this.store !== null,
      admitting: this.canAdmitDurableJobs(),
      consecutiveHeartbeatFailures: this.consecutiveHeartbeatFailures,
      consecutiveHeartbeatSuccesses: this.consecutiveHeartbeatSuccesses,
      lastHeartbeatFailureAt: this.lastHeartbeatFailureAt,
      lastHeartbeatRecoveryAt: this.lastHeartbeatRecoveryAt,
      lastHeartbeatErrorName: this.lastHeartbeatErrorName,
    };
  }

  /**
   * #139: throw a fail-closed admission error when a durable store is attached
   * but this instance cannot prove its own liveness. A null-store manager
   * (isolate-mode / tests without persistence) is unaffected.
   */
  private assertDurableAdmission(provider: string): void {
    if (this.disposed) {
      throw new Error(`Async admission is disabled for ${provider}: gateway is shutting down.`);
    }
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
   * Idempotent; a null-store (isolate-mode) manager still stops live local work
   * but has no instance row to deregister.
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

    // (3) terminalize queued work before signalling running work. A released
    // permit can otherwise grant a queued job while shutdown is in progress.
    const queued = [...this.jobs.values()].filter(job => job.status === "queued");
    for (const job of queued) {
      job.queueCancel?.();
      this.failQueuedJob(job, "Gateway is shutting down before execution", 1);
    }

    // Terminal Kit writes may already be waiting on an unref retry timer. Make
    // one immediate attempt while dispose still owns the store and includes the
    // result in its drain fence.
    for (const job of this.jobs.values()) {
      this.retryTerminalPersistenceNow(job);
    }

    // (4) abort/kill active owned jobs. Mark the shutdown fence before the
    // signal: SIGTERM is only a request, and the close event is the proof that
    // the provider can no longer mutate its native session.
    const deadline = Date.now() + timeoutMs;
    const killEscalationDelayMs =
      timeoutMs <= 50 ? 0 : Math.max(25, Math.min(1_000, Math.floor(timeoutMs / 3)));
    const active = [...this.jobs.values()].filter(job => job.status === "running");
    for (const job of active) {
      try {
        job.terminationRequested = true;
        job.exitCode = 1;
        job.error = "Gateway shutdown requested before provider process reached close";
        job.clearIdleTimer?.();
        if (job.transport === "http") {
          job.abort?.abort();
        } else if (job.process) {
          if (job.terminateProcessGroup) {
            job.terminateProcessGroup("SIGTERM", killEscalationDelayMs);
          } else {
            // Defensive compatibility for an unusual live record created
            // before the per-launch termination fence was installed.
            killProcessGroup(job.process, "SIGKILL");
            job.cleanupGroup?.();
          }
        }
      } catch (err) {
        this.logger.error(`#139 dispose: failed to signal job ${job.id}`, err);
      }
    }
    // Drain (bounded): wait for the killed jobs to reach a terminal state, for
    // any Kit terminal persistence retry to be acknowledged, and for tracked
    // asynchronous terminal hooks to settle.
    while (Date.now() < deadline) {
      const stillActive = [...this.jobs.values()].some(job => isAsyncJobInProgress(job.status));
      const hasPendingTerminalPersistence = this.hasPendingTerminalPersistence();
      if (!stillActive && !hasPendingTerminalPersistence && this.pendingWrites.size === 0) break;
      const delay = new Promise<void>(resolve => setTimeout(resolve, 50));
      // Promise.allSettled([]) resolves in a microtask. Racing that empty
      // promise against the timer would spin until the deadline and starve an
      // unref terminal-persistence retry from ever running.
      if (this.pendingWrites.size > 0) {
        await Promise.race([Promise.allSettled([...this.pendingWrites]), delay]);
      } else {
        await delay;
      }
    }

    const stillActive = [...this.jobs.values()].some(job => isAsyncJobInProgress(job.status));
    const hasPendingTerminalPersistence = this.hasPendingTerminalPersistence();
    if (stillActive || hasPendingTerminalPersistence || this.pendingWrites.size > 0) {
      // (5) do NOT deregister while jobs are still finalizing: let the lease
      // expire so another instance recovers them correctly rather than a
      // mid-write orphan. This includes terminal Kit rows whose captured output
      // has not yet reached durable storage and terminal lifecycle hooks that
      // have not settled.
      logWarn(
        this.logger,
        "#139 dispose timed out with unfinished owned job finalization; skipping deregister and letting the lease expire"
      );
      return;
    }
    if (!this.store) return; // isolate-mode / no durable state: nothing to deregister.
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
      if (!this.durableAdmission) {
        this.consecutiveHeartbeatSuccesses++;
        if (this.consecutiveHeartbeatSuccesses >= MIN_CONSECUTIVE_HEARTBEAT_SUCCESSES_TO_RECOVER) {
          this.restoreDurableAdmission("heartbeat recovery");
        }
      }
    } catch (err) {
      this.consecutiveHeartbeatFailures++;
      this.consecutiveHeartbeatSuccesses = 0;
      this.lastHeartbeatFailureAt = new Date().toISOString();
      this.lastHeartbeatErrorName = err instanceof Error ? err.name : typeof err;
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
          this.consecutiveHeartbeatSuccesses = 0;
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
      if (!this.store || this.disposed || !this.durableAdmission) return;
      try {
        this.store.gcInstances(this.lease.instanceGcMs);
      } catch (err) {
        this.logger.error("#139 gateway_instances GC failed", err);
      }
    }, this.lease.orphanSweepIntervalMs);
    if (this.sweepTimer.unref) this.sweepTimer.unref();
  }

  /**
   * Register before enabling admission. This is used both at startup and after
   * a sustained heartbeat outage, so an UPDATE that happened to affect zero
   * rows can never be mistaken for proof that this instance is live.
   */
  private restoreDurableAdmission(reason: "startup" | "heartbeat recovery"): void {
    if (!this.store || this.disposed) return;
    try {
      this.store.registerInstance({
        instanceId: this.instanceId,
        role: this.lease.role ?? "gateway",
        hostname: this.hostname,
        pid: this.instancePid,
      });
      this.store.heartbeat(this.instanceId);
      const wasDisabled = !this.durableAdmission;
      this.durableAdmission = true;
      this.consecutiveHeartbeatFailures = 0;
      this.consecutiveHeartbeatSuccesses = 0;
      this.lastHeartbeatRecoveryAt = new Date().toISOString();
      if (wasDisabled && reason === "heartbeat recovery") {
        this.logger.info(
          "#139 durable heartbeat recovered; re-enabled async admission and orphan sweeping"
        );
      }
      // Startup and recovery both use the same guarded per-job lease sweep.
      this.runOrphanSweep();
      this.reconcileLocalOrphanedClaudeMcpArtifacts();
    } catch (err) {
      this.durableAdmission = false;
      this.consecutiveHeartbeatSuccesses = 0;
      this.lastHeartbeatFailureAt = new Date().toISOString();
      this.lastHeartbeatErrorName = err instanceof Error ? err.name : typeof err;
      this.logger.error(
        `#139 ${reason} register/heartbeat failed; durable async admission remains disabled`,
        err
      );
    }
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
    let candidates: SweepCandidate[];
    let liveConfirmedIds: string[];
    try {
      candidates = this.store.selectStaleProcessCandidates(leaseTtl, httpGrace);
      liveConfirmedIds = this.confirmLiveProcessCandidates(candidates);
    } catch (err) {
      this.logger.error("#139 selecting stale process candidates failed", err);
      // Without the candidate read, this instance cannot preserve the one-shot
      // same-host PID grace. Skipping this cycle is safer than sweeping every
      // expired lease as if no live process had been found.
      return;
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
    const candidatesById = new Map(candidates.map(candidate => [candidate.id, candidate]));
    for (const orphan of orphaned) {
      this.persistOrphanProgress(orphan.id);
      this.cleanupConfirmedOrphanClaudeMcpArtifact(orphan.id, candidatesById.get(orphan.id));
      try {
        this.flightRecorder.logComplete(orphan.correlationId, this.buildOrphanFlightResult(orphan));
      } catch (err) {
        this.logger.error(`#139 FR logComplete for orphaned job ${orphan.id} failed`, err);
      }
    }
  }

  /**
   * Append an orphan terminal event without racing a late live completion. The
   * status-guarded write is a no-op if the row has already advanced beyond the
   * orphaned state.
   */
  private persistOrphanProgress(jobId: string): void {
    if (!this.store?.recordProgressIfStatus) return;
    try {
      const row = this.store.getById(jobId);
      if (!row || row.status !== "orphaned") return;
      const tracker = new JobProgressTracker(
        row.cli,
        row.outputFormat ?? undefined,
        parseStoredJobProgress(row.progressJson),
        row.startedAt,
        resolveJobProgressCapability(
          row.cli,
          parsePersistedJobArgs(row.argsJson),
          row.outputFormat ?? undefined,
          row.transport
        )
      );
      if (!tracker.snapshot().events.some(event => event.kind === "terminal")) {
        tracker.emit("failed", "terminal", "Job orphaned after its gateway lease expired");
      }
      this.store.recordProgressIfStatus(jobId, "orphaned", tracker.serialize());
    } catch (err) {
      this.logger.error(`#192 failed to persist terminal progress for orphaned job ${jobId}`, err);
    }
  }

  /**
   * A shared store may be swept by a different workstation. When this host
   * later starts, reconcile only rows whose durable owner hostname matches this
   * host. There is no globbing or remote-path cleanup: every row is validated
   * again by the same strict artifact predicate below.
   */
  private reconcileLocalOrphanedClaudeMcpArtifacts(): void {
    if (!this.store || this.disposed || !this.durableAdmission) return;
    // Legacy rows predate exact-path provenance, so retain the old orphan-only
    // projection for their best-effort cleanup. New rows use the durable
    // pending/ack projection below, which also covers terminal cleanup retries.
    const selectCandidates = this.store.selectOrphanedProcessCandidates;
    if (typeof selectCandidates === "function") {
      try {
        const candidates = selectCandidates.call(this.store, this.hostname);
        for (const candidate of candidates) {
          this.cleanupConfirmedOrphanClaudeMcpArtifact(candidate.id, candidate);
        }
      } catch (err) {
        this.logger.error("#139 selecting local orphaned MCP artifact candidates failed", err);
      }
    }

    // A row remains retention-pinned until the originating host has handled
    // its exact path. New scopes are per-request-directory identities, so the
    // selector deliberately returns same-host candidates and the shared
    // remover compares each row's captured scope after it has opened that
    // candidate's directory. This remains a database projection, not a
    // directory scan.
    const selectPending = this.store.selectPendingMcpArtifactCleanups;
    if (typeof selectPending !== "function") return;
    try {
      const pending = selectPending.call(this.store, this.hostname);
      for (const candidate of pending) {
        this.cleanupPendingClaudeMcpArtifact(candidate);
      }
    } catch (err) {
      this.logger.error("#139 selecting pending local MCP artifact cleanups failed", err);
    }
  }

  /**
   * Reclaim a request-scoped Claude MCP config only after the durable sweep
   * atomically changed its job row to `orphaned`. A local, stale process
   * candidate is required as an additional guard. A candidate may be queued
   * with no pid, in which case no child was started. A shared store may contain
   * remote jobs whose argv paths are meaningful only on their owner host.
   */
  private cleanupConfirmedOrphanClaudeMcpArtifact(
    jobId: string,
    candidate: SweepCandidate | undefined
  ): void {
    if (
      !this.store ||
      !candidate ||
      candidate.transport !== "process" ||
      candidate.hostname !== this.hostname
    ) {
      return;
    }

    let row: JobRecord | null;
    try {
      row = this.store.getById(jobId);
    } catch (err) {
      this.logger.error(`#139 failed to read orphaned job ${jobId} for MCP artifact cleanup`, err);
      return;
    }
    if (
      !row ||
      row.status !== "orphaned" ||
      row.cli !== "claude" ||
      row.transport !== "process" ||
      row.ownerInstance !== candidate.ownerInstance ||
      row.ownerHostname !== candidate.hostname
    ) {
      return;
    }

    // A retained artifact without its captured scope cannot safely be
    // reclaimed. This applies to legacy unpinned rows too: their argv remains
    // recovery input, never authority to delete a current local path.
    if (!row.mcpArtifactScope) {
      this.logger.error(
        `#139 orphaned Claude MCP artifact cleanup has no captured scope for job ${jobId}; retaining artifact path`
      );
      return;
    }
    const artifactPath = row.mcpArtifactPath ?? parseClaudeMcpArtifactArg(row.argsJson);
    if (!artifactPath) return;
    const result = removeClaudeMcpArtifact(artifactPath, row.mcpArtifactScope);
    if (result !== "removed") {
      this.logger.error(
        `#139 orphaned Claude MCP artifact cleanup ${result} for job ${jobId}; retaining durable acknowledgement pending`
      );
      return;
    }
    if (
      row.mcpArtifactCleanupPending &&
      row.mcpArtifactPath === artifactPath &&
      row.mcpArtifactScope
    ) {
      this.acknowledgeMcpArtifactCleanup(
        jobId,
        candidate.hostname,
        row.mcpArtifactScope,
        artifactPath
      );
    }
  }

  /**
   * Reconcile a path explicitly recorded at admission. The extra row checks
   * turn the selector into a narrow hint only: the acknowledgement remains a
   * compare-and-set against the same job id, host, and artifact path.
   */
  private cleanupPendingClaudeMcpArtifact(candidate: PendingMcpArtifactCleanup): void {
    if (!this.store || candidate.hostname !== this.hostname) return;
    let row: JobRecord | null;
    try {
      row = this.store.getById(candidate.id);
    } catch (err) {
      this.logger.error(`#139 failed to read pending MCP artifact job ${candidate.id}`, err);
      return;
    }
    if (
      !row ||
      row.cli !== "claude" ||
      row.transport !== "process" ||
      row.ownerHostname !== candidate.hostname ||
      row.ownerInstance !== candidate.ownerInstance ||
      row.mcpArtifactScope !== candidate.artifactScope ||
      row.mcpArtifactPath !== candidate.artifactPath ||
      !row.mcpArtifactCleanupPending ||
      (row.status !== "completed" &&
        row.status !== "failed" &&
        row.status !== "canceled" &&
        row.status !== "orphaned")
    ) {
      return;
    }
    const result = removeClaudeMcpArtifact(candidate.artifactPath, candidate.artifactScope);
    if (result !== "removed") {
      this.logger.error(
        `#139 pending Claude MCP artifact cleanup ${result} for job ${candidate.id}; retaining durable acknowledgement pending`
      );
      return;
    }
    this.acknowledgeMcpArtifactCleanup(
      candidate.id,
      candidate.hostname,
      candidate.artifactScope,
      candidate.artifactPath
    );
  }

  private acknowledgeMcpArtifactCleanup(
    jobId: string,
    hostname: string,
    artifactScope: string,
    artifactPath: string
  ): boolean {
    const acknowledge = this.store?.acknowledgeMcpArtifactCleanup;
    if (typeof acknowledge !== "function") return false;
    try {
      const acknowledged = acknowledge.call(
        this.store,
        jobId,
        hostname,
        artifactScope,
        artifactPath
      );
      if (!acknowledged) {
        this.logger.error(
          `#139 Claude MCP artifact cleanup acknowledgement did not match pending job ${jobId}`
        );
      }
      return acknowledged;
    } catch (err) {
      this.logger.error(
        `#139 Claude MCP artifact cleanup acknowledgement failed for job ${jobId}`,
        err
      );
      return false;
    }
  }

  /**
   * Normal terminal cleanup has already proved the local child is gone. If a
   * wrapper cleanup failed, retry only the exact persisted artifact here; never
   * scan the directory. A failed durable acknowledgement stays pinned and is
   * retried by the origin-host startup reconciliation.
   */
  private finalizeMcpArtifactCleanup(job: AsyncJobRecord): void {
    const artifactPath = job.mcpArtifactPath;
    const artifactScope = job.mcpArtifactScope;
    if (!artifactPath || !artifactScope) return;
    // removeClaudeMcpArtifact performs the same pre-unlink scope proof and
    // turns an unsafe or unreadable replacement directory into a retained-pin
    // result rather than allowing terminal lifecycle handling to throw.
    const result = removeClaudeMcpArtifact(artifactPath, artifactScope);
    if (result !== "removed") {
      this.logger.error(
        `#139 Claude MCP artifact terminal cleanup ${result} for job ${job.id}; retaining durable acknowledgement pending`
      );
      return;
    }
    if (this.acknowledgeMcpArtifactCleanup(job.id, this.hostname, artifactScope, artifactPath)) {
      job.mcpArtifactPath = null;
      job.mcpArtifactScope = null;
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
    if (!this.store || (input.validationAdmission && !isValidationRunStore(this.store))) {
      if (!input.validationAdmission) return;
      if (acq.state === "granted") acq.permit.release();
      else acq.cancel();
      this.jobs.delete(job.id);
      throw new DurableJobAdmissionError(
        job.cli,
        new Error("Validation job admission requires a healthy validation-run store")
      );
    }
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
      throw new DurableJobAdmissionError(job.cli, err);
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
    let transitioned: boolean;
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
    if (orphan.isPersonalConfigKit) {
      return {
        response: "Personal Agent Config Kit provider output is withheld",
        durationMs,
        retryCount: 0,
        circuitBreakerState: "closed",
        optimizationApplied: false,
        exitCode: orphan.exitCode ?? 1,
        httpStatus: orphan.transport === "http" ? (orphan.httpStatus ?? undefined) : undefined,
        errorMessage: "Personal Agent Config Kit job was orphaned; detailed output is withheld",
        status: "failed",
      };
    }
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

    // Sweep the durable store only while this instance can prove its lease.
    // After sustained heartbeat failure, every write is likely to fail and the
    // conservative state is deliberately quiescent until recovery succeeds.
    if (this.store && this.durableAdmission) {
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
   * Compute the dedup key for a non-Kit job. Stable across re-issues of the same
   * request, which is exactly what allows agents to safely retry without
   * restarting the run. Kit jobs always force a fresh run and use their
   * pre-reserved durable UUID as an opaque request key instead.
   *
   * U22 fix: env vars participate in the key via a deterministic canonicalisation
   * (sorted keys → JSON-stringified). This prevents two Mistral requests with the
   * same argv but different `VIBE_ACTIVE_MODEL` from deduping onto each other.
   */
  private buildRequestKey(
    cli: LlmCli,
    args: string[],
    env?: NodeJS.ProcessEnv,
    stdin?: string,
    cwd?: string,
    outputFormat?: string,
    compressResponse?: boolean
  ): string {
    // stdin participates in the dedup key. Two process requests with identical
    // argv but different cache-control payloads would otherwise collide
    // and return the wrong response. The legacy no-stdin path keeps its prior
    // empty marker shape.
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
    artifactCleanup?: () => void
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
      if (artifactCleanup) {
        try {
          artifactCleanup();
        } catch (err) {
          this.logger.error("dedup artifact cleanup threw", err);
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
    /** Legacy alias for artifactCleanup. */
    onComplete?: () => void;
    artifactCleanup?: () => void;
    onTerminal?: AsyncJobTerminalHook;
    kitExecution?: KitExecutionRef | null;
    kitSessionId?: string;
    writeFlightStart?: boolean;
    flightRecorderEntry?: AsyncJobFlightRecorderEntry;
    extractUsage?: AsyncJobUsageExtractor;
    deferLaunch?: boolean;
    validationAdmission?: ValidationJobAdmission;
  }): StartJobOutcome {
    const {
      provider,
      apiRequest,
      correlationId,
      forceRefresh,
      onComplete,
      artifactCleanup,
      onTerminal,
      kitExecution,
      kitSessionId,
      writeFlightStart,
      flightRecorderEntry,
      extractUsage,
      deferLaunch,
      validationAdmission,
    } = params;
    const stableKitExecution = kitExecution ? cloneKitExecutionRef(kitExecution) : null;
    const stableKitSessionId = normalizeKitSessionId(stableKitExecution, kitSessionId);
    if (stableKitExecution) {
      throw new Error("Personal Agent Config Kit jobs must use the durable CLI execution path");
    }
    const requestKey = this.buildHttpRequestKey(provider.name, apiRequest);
    const cleanup = artifactCleanup ?? onComplete;

    if (validationAdmission && !forceRefresh) {
      throw new Error("Validation review jobs require forceRefresh");
    }
    if (validationAdmission && (!isValidationRunStore(this.store) || !this.durableAdmission)) {
      throw new DurableJobAdmissionError(
        provider.name,
        new Error("Validation job admission requires a healthy validation-run store")
      );
    }
    if (!forceRefresh) {
      const reused = this.tryReuseDedupedJob(requestKey, correlationId, provider.name, cleanup);
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
    const terminalHookCompletion = createTerminalHookCompletion();

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
      errorCategory: null,
      retryable: null,
      process: null,
      transport: "http",
      abort,
      httpStatus: null,
      payloadJson,
      exited: false,
      metricsRecorded: false,
      ownerPrincipal,
      mcpArtifactPath: null,
      mcpArtifactScope: null,
      kitExecution: stableKitExecution,
      kitSessionId: stableKitSessionId,
      kitOutputAvailableInMemory: stableKitExecution !== null,
      kitTerminalFinalized: false,
      terminalPersistenceAcknowledged: stableKitExecution === null,
      progress: new JobProgressTracker(provider.name, undefined, null, startedAt, "lifecycle_only"),
      progressDirty: true,
      lastProgressFlushAt: Date.now(),
      artifactCleanup: cleanup,
      artifactCleanupFired: false,
      onTerminal,
      onTerminalFired: false,
      terminalHookCompletion: terminalHookCompletion.promise,
      resolveTerminalHookCompletion: terminalHookCompletion.resolve,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
      flightRecorderEntry,
      extractUsage,
      flightRecorderComplete: false,
      flightCompleteArmed: writeFlightStart === true,
    };

    job.progress.emit("queued", "lifecycle", "Job queued");

    this.jobs.set(id, job);

    // Issue #130: fire the outbound request only once a limiter permit is held.
    const launch = (permit: LimiterPermit): void => {
      job.limiterPermit = permit;
      job.queueCancel = undefined;
      if (this.disposed && job.status === "queued") {
        this.failQueuedJob(job, "Gateway is shutting down before execution", 1);
        return;
      }
      // Canceled/aborted while queued before this grant landed: return the permit.
      if (job.status !== "queued") {
        this.releaseJobPermit(job);
        return;
      }
      job.status = "running";
      this.emitProgress(job, "starting", "lifecycle", "Provider request started");
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

    let launchReleased = deferLaunch !== true;
    let heldPermit: LimiterPermit | null = null;
    const grantOrHold = (permit: LimiterPermit): void => {
      job.queueCancel = undefined;
      if (!launchReleased) {
        heldPermit = permit;
        job.limiterPermit = permit;
        return;
      }
      launch(permit);
    };

    const acq = this.limiter.acquire(
      provider.name,
      permit => grantOrHold(permit),
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
      ownerHostname: this.hostname,
      transport: "http",
      payloadJson,
      kitExecution: stableKitExecution,
      kitSessionId: stableKitSessionId,
      validationAdmission,
    });
    this.maybeFlushProgress(job, true);
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
      if (deferLaunch) {
        heldPermit = acq.permit;
        job.limiterPermit = acq.permit;
        this.logger.info(`Job ${id} prepared for ${provider.name} (http)`, { correlationId });
      } else {
        this.logger.info(`Job ${id} started for ${provider.name} (http)`, { correlationId });
        launch(acq.permit);
      }
    } else {
      job.queueCancel = acq.cancel;
      this.logger.info(`Job ${id} queued for ${provider.name} (http, limiter saturated)`, {
        correlationId,
      });
    }

    const deferredControl: DeferredJobLaunch | undefined = deferLaunch
      ? {
          release: () => {
            if (launchReleased) return;
            launchReleased = true;
            if (job.status !== "queued") return;
            const permit = heldPermit;
            heldPermit = null;
            if (permit) launch(permit);
          },
          cancel: () => {
            if (launchReleased) return false;
            launchReleased = true;
            heldPermit = null;
            return this.cancelJob(id).canceled;
          },
        }
      : undefined;
    return { snapshot: this.snapshot(job), deduped: false, deferredLaunch: deferredControl };
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
    if (job.terminationRequested) {
      job.status = "failed";
      job.exitCode = job.exitCode ?? 1;
      job.error ??= "Gateway shutdown requested before provider request settled";
      if (error) job.stderr = error.message;
    } else if (result) {
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

  private settleTerminalHook(job: AsyncJobRecord, success: boolean): void {
    if (job.terminalHookOutcome !== undefined) return;
    // The session-side terminal hook must finish before the job row can lose
    // its durable finalization pin. A failed hook remains pending for restart
    // reconciliation instead of being acknowledged optimistically.
    if (success && job.kitExecution && job.kitSessionId) {
      success = job.kitTerminalFinalized || this.markKitTerminalFinalized(job.id, job.kitSessionId);
      if (!success) {
        this.logger.error(
          `Kit terminal-finalization acknowledgement failed for job ${job.id}; retaining it for reconciliation`
        );
      }
    }
    job.terminalHookOutcome = success;
    const resolve = job.resolveTerminalHookCompletion;
    job.resolveTerminalHookCompletion = undefined;
    resolve?.(success);
  }

  private fireOnComplete(job: AsyncJobRecord): void {
    const liveProcessMayStillReadArtifacts =
      job.transport === "process" && job.process !== null && !job.exited;
    // A signal request is not death proof. In particular, a child can ignore
    // SIGTERM while still mutating a provider-native session. Only the close
    // handler (or a definitive child error) may hand a Kit attempt to its
    // terminal session callback.
    if (job.kitExecution && liveProcessMayStillReadArtifacts) return;
    if (job.kitExecution && !job.terminalPersistenceAcknowledged) {
      this.scheduleTerminalPersistenceRetry(job);
      return;
    }
    // Issue #130: releasing the running slot is the FIRST thing every terminal
    // transition does. fireOnComplete is invoked at every terminal site
    // (completed/failed/canceled/orphaned/idle-timeout/output-overflow), and
    // releaseJobPermit is idempotent, so the permit is released exactly once
    // regardless of which callback fires first or how many fire.
    this.releaseJobPermit(job);
    if (job.onTerminal) {
      if (!job.onTerminalFired) {
        job.onTerminalFired = true;
        try {
          const terminalResult = job.onTerminal({
            snapshot: this.snapshot(job),
            ownerPrincipal: job.ownerPrincipal ?? null,
            kitExecution: job.kitExecution ? cloneKitExecutionRef(job.kitExecution) : null,
            kitSessionId: job.kitSessionId,
            terminalMetadata: this.kitTerminalMetadata(job),
          });
          if (terminalResult && typeof (terminalResult as Promise<void>).then === "function") {
            const completion = Promise.resolve(terminalResult)
              .then(() => {
                this.settleTerminalHook(job, true);
                return true;
              })
              .catch(err => {
                this.logger.error(`Job ${job.id} async onTerminal hook threw`, err);
                this.settleTerminalHook(job, false);
                return false;
              });
            this.trackPendingWrite(completion);
          } else {
            this.settleTerminalHook(job, true);
          }
        } catch (err) {
          this.logger.error(`Job ${job.id} onTerminal hook threw`, err);
          this.settleTerminalHook(job, false);
        }
      }
    } else {
      // A non-Kit job has no terminal state to persist. A Kit job without its
      // required hook must remain unsuccessful so a caller cannot mistake it
      // for a finalized durable continuation.
      this.settleTerminalHook(job, !job.kitExecution);
    }
    if (!liveProcessMayStillReadArtifacts) {
      // The durable MCP path must perform its own confirmed unlink before the
      // generic request cleanup hook. A hook that removes the file first would
      // leave only ENOENT, which intentionally cannot acknowledge a pin.
      this.finalizeMcpArtifactCleanup(job);
    }
    // A process can keep reading a request-scoped schema/MCP config after a
    // cancellation, idle timeout, or output-overflow SIGTERM. Keep that file
    // until `close` (or a definitive no-PID error) proves the child is gone.
    // Queued jobs and HTTP requests have no live process, so they clean up on
    // their first terminal transition as before.
    if (!liveProcessMayStillReadArtifacts && !job.artifactCleanupFired && job.artifactCleanup) {
      job.artifactCleanupFired = true;
      try {
        job.artifactCleanup();
      } catch (err) {
        this.logger.error(`Job ${job.id} artifact cleanup hook threw`, err);
      }
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
    const isKit = Boolean(job.kitExecution);
    // Token and cost telemetry fingerprint the size of a compiled Kit context.
    // Keep ordinary job telemetry intact, but do not persist that derivative for
    // a Kit execution.
    const flightUsage = isKit ? {} : usage;
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
    if (isKit) {
      response = PERSONAL_KIT_OUTPUT_WITHHELD;
    } else if (job.transport === "process" && job.cli === "codex") {
      const codexText = codexFrResponse(job.outputFormat, job.stdout);
      response = isFailure ? job.stderr || codexText : codexText;
    } else {
      response = isFailure ? job.stderr || job.stdout : job.stdout;
    }
    const exitCode = job.exitCode ?? (finalStatus === "completed" ? 0 : 1);
    const errorMessage = isFailure
      ? isKit
        ? PERSONAL_KIT_FAILURE_WITHHELD
        : (overrideErrorMessage ?? job.error ?? job.stderr ?? `Exit code ${exitCode}`)
      : undefined;

    // Preserve provider-minted terminal metadata in the private flight
    // recorder for every process outcome. Completed jobs use it for local
    // resume; failed/canceled output still needs the known value so remote
    // persisted-result readback can redact it. HTTP jobs carry the
    // continuation handle in apiResponseId instead.
    const providerMeta =
      !isKit && job.transport === "process"
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
        inputTokens: flightUsage.inputTokens,
        outputTokens: flightUsage.outputTokens,
        cacheReadTokens: flightUsage.cacheReadTokens,
        cacheCreationTokens: flightUsage.cacheCreationTokens,
        costUsd: flightUsage.costUsd,
        // LCR phase_1: the process extractUsage handoff labels cost_basis (T2
        // derived-from-tokens backfill); http/{} usage carries none.
        costBasis: (flightUsage as { costBasis?: string }).costBasis,
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
   * flight-recorder usage shape. LCR phase_2b: ApiUsage now carries
   * cacheCreationTokens (Anthropic `cache_creation_input_tokens`), threaded here
   * so the `cache_creation_tokens` column is populated for Anthropic-API rows;
   * providers that never report it leave it undefined (FR row stays NULL).
   */
  private httpUsage(job: AsyncJobRecord): ReturnType<AsyncJobUsageExtractor> {
    const u = job.apiUsage;
    if (!u) return {};
    return {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheCreationTokens: u.cacheCreationTokens,
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
    // A Kit provider can echo the full compiled instruction context from stdin.
    // Keep process output in memory until terminal metadata has been extracted;
    // never stream that raw material to the durable job store.
    if (job.kitExecution) return;
    const now = Date.now();
    if (!force && now - job.lastOutputFlushAt < OUTPUT_FLUSH_INTERVAL_MS) return;
    job.outputDirty = false;
    job.lastOutputFlushAt = now;
    this.safeStoreCall("recordOutput", () =>
      this.store!.recordOutput(job.id, job.stdout, job.stderr, job.outputTruncated)
    );
  }

  private emitProgress(
    job: AsyncJobRecord,
    phase: JobProgressPhase,
    kind: JobProgressKind,
    message: string,
    source: "gateway" | "provider" = "gateway"
  ): void {
    this.progressTracker(job).emit(phase, kind, message, source);
    job.progressDirty = true;
    this.maybeFlushProgress(job);
  }

  private maybeFlushProgress(job: AsyncJobRecord, force = false): void {
    if (!this.store || !job.progressDirty) return;
    const now = Date.now();
    if (!force && now - job.lastProgressFlushAt < OUTPUT_FLUSH_INTERVAL_MS) return;
    job.lastProgressFlushAt = now;
    try {
      const serialized = this.progressTracker(job).serialize();
      const written = this.store.recordProgressIfStatus
        ? this.store.recordProgressIfStatus(job.id, job.status, serialized)
        : (this.store.recordProgress(job.id, serialized), true);
      if (!written) return;
      job.progressDirty = false;
    } catch (err) {
      // Keep progressDirty set so the next output chunk or terminal flush retries.
      this.logger.error("JobStore.recordProgress failed", err);
    }
  }

  private ensureTerminalProgress(job: AsyncJobRecord): void {
    if (job.status === "running" || job.status === "queued") return;
    const current = this.progressTracker(job).snapshot();
    if (current.events.some(event => event.kind === "terminal")) return;
    if (job.status === "completed") {
      this.emitProgress(job, "completed", "terminal", "Job completed");
    } else {
      this.emitProgress(job, "failed", "terminal", `Job ${job.status}`);
    }
  }

  private persistComplete(job: AsyncJobRecord): boolean {
    if (!this.store) return !job.kitExecution;
    // Never persist a non-terminal job as complete. "queued" (issue #130) is
    // pre-execution, exactly like "running": neither has a terminal row to write.
    if (job.status === "running" || job.status === "queued") return false;
    if (!job.finishedAt) return false;
    this.ensureTerminalProgress(job);
    this.maybeFlushProgress(job, true);
    // Make sure the latest output is captured in the same row update.
    job.outputDirty = false;
    const isKit = Boolean(job.kitExecution);
    try {
      this.store.recordComplete({
        id: job.id,
        status: job.status,
        exitCode: job.exitCode,
        stdout: isKit ? "" : job.stdout,
        stderr: isKit ? "" : job.stderr,
        outputTruncated: job.outputTruncated,
        error: isKit && job.status !== "completed" ? PERSONAL_KIT_FAILURE_WITHHELD : job.error,
        errorCategory: job.errorCategory,
        retryable: job.retryable,
        finishedAt: job.finishedAt!,
        httpStatus: job.httpStatus,
        progressJson: this.progressTracker(job).serialize(),
      });
      job.terminalPersistenceAcknowledged = true;
      return true;
    } catch (err) {
      this.logger.error(`JobStore.recordComplete failed for ${job.id}`, err);
      if (job.kitExecution) this.scheduleTerminalPersistenceRetry(job);
      return false;
    }
  }

  /**
   * Extract the provider-derived fact needed by this process's terminal hook.
   * Raw output and the derived native handle remain process-local and never
   * cross a durable-store or flight-recorder boundary.
   */
  private kitTerminalMetadata(job: AsyncJobRecord): PersonalKitTerminalMetadata | null {
    if (!job.kitExecution) return null;
    if (job.kitTerminalMetadata !== undefined) return job.kitTerminalMetadata;
    job.kitTerminalMetadata =
      job.status === "completed"
        ? createPersonalKitTerminalMetadata(job.cli, job.stdout, job.outputFormat)
        : null;
    return job.kitTerminalMetadata;
  }

  /**
   * Retain the Kit session attempt while a terminal durable write is retried.
   * The exponential delay is bounded, but retries continue while this gateway
   * lives so a transient store outage cannot turn a known terminal process into
   * an unrecoverable running row.
   */
  private scheduleTerminalPersistenceRetry(job: AsyncJobRecord): void {
    if (
      !job.kitExecution ||
      job.terminalPersistenceAcknowledged ||
      job.terminalPersistenceRetryTimer ||
      !job.finishedAt
    ) {
      return;
    }
    const delayMs = job.terminalPersistenceRetryDelayMs ?? 100;
    job.terminalPersistenceRetryDelayMs = Math.min(delayMs * 2, 30_000);
    job.terminalPersistenceRetryTimer = setTimeout(() => {
      job.terminalPersistenceRetryTimer = undefined;
      if (!this.persistComplete(job)) return;
      const flightStatus = job.status === "completed" ? "completed" : "failed";
      const override = job.status === "canceled" ? "canceled by caller" : undefined;
      this.writeFlightComplete(job, flightStatus, override);
      this.fireOnComplete(job);
    }, delayMs);
    job.terminalPersistenceRetryTimer.unref?.();
  }

  /** True when a terminal Kit result is still only resident in this process. */
  private hasPendingTerminalPersistence(): boolean {
    return [...this.jobs.values()].some(
      job =>
        Boolean(job.kitExecution) &&
        !job.terminalPersistenceAcknowledged &&
        job.finishedAt !== null &&
        !isAsyncJobInProgress(job.status)
    );
  }

  /**
   * Dispose must not trust an unref retry timer to keep terminal Kit output
   * alive. Retry once synchronously while the manager still owns its store;
   * ordinary bounded backoff resumes if the store remains unavailable.
   */
  private retryTerminalPersistenceNow(job: AsyncJobRecord): void {
    if (
      !job.kitExecution ||
      job.terminalPersistenceAcknowledged ||
      job.finishedAt === null ||
      isAsyncJobInProgress(job.status)
    ) {
      return;
    }
    if (job.terminalPersistenceRetryTimer) {
      clearTimeout(job.terminalPersistenceRetryTimer);
      job.terminalPersistenceRetryTimer = undefined;
    }
    if (!this.persistComplete(job)) return;
    const flightStatus = job.status === "completed" ? "completed" : "failed";
    const override = job.status === "canceled" ? "canceled by caller" : undefined;
    this.writeFlightComplete(job, flightStatus, override);
    this.fireOnComplete(job);
  }

  /**
   * Reconstitute an in-memory AsyncJobRecord from a durable row, so subsequent
   * getJobSnapshot/getJobResult calls hit the in-memory cache.
   * The reconstituted record has process=null — it represents historical data only.
   */
  private hydrateFromStore(jobId: string): AsyncJobRecord | null {
    if (!this.store) return null;
    let row: JobRecord | null;
    try {
      row = this.store.getById(jobId);
    } catch (err) {
      this.logger.error("JobStore.getById failed", err);
      return null;
    }
    if (!row) return null;

    return this.hydrateJobRecord(row);
  }

  private hydrateJobRecord(row: JobRecord): AsyncJobRecord {
    const args = parsePersistedJobArgs(row.argsJson);

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
      errorCategory:
        row.errorCategory === CLI_INPUT_TOO_LARGE_CATEGORY
          ? CLI_INPUT_TOO_LARGE_CATEGORY
          : row.errorCategory === CLI_INVALID_INPUT_CATEGORY
            ? CLI_INVALID_INPUT_CATEGORY
            : null,
      // Retry guidance is an independent durable field. Some terminal states,
      // such as incomplete child stdin delivery, intentionally carry no public
      // error category while still being definitively non-retryable.
      retryable: typeof row.retryable === "boolean" ? row.retryable : null,
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
      mcpArtifactPath: row.mcpArtifactPath,
      mcpArtifactScope: row.mcpArtifactScope,
      kitExecution: row.kitExecution ? cloneKitExecutionRef(row.kitExecution) : null,
      kitSessionId: row.kitSessionId,
      // Hydrated rows intentionally have no native continuation metadata.
      // A gateway restart must retire a Kit provider handle rather than resume it.
      kitTerminalMetadata: null,
      kitOutputAvailableInMemory: !row.kitExecution,
      kitTerminalFinalized: row.kitTerminalFinalized,
      terminalPersistenceAcknowledged: row.status !== "queued" && row.status !== "running",
      progress: new JobProgressTracker(
        row.cli,
        row.outputFormat ?? undefined,
        parseStoredJobProgress(row.progressJson),
        row.startedAt,
        resolveJobProgressCapability(row.cli, args, row.outputFormat ?? undefined, row.transport)
      ),
      progressDirty: false,
      lastProgressFlushAt: Date.now(),
      hydratedFromStore: true,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
    };
    this.jobs.set(row.id, reconstituted);
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

  /** Durable Kit context for internal continuation checks, never tool-projected. */
  getJobKitExecution(jobId: string): KitExecutionRef | null | undefined {
    let job = this.jobs.get(jobId);
    if (!job) job = this.hydrateFromStore(jobId) ?? undefined;
    if (!job) return undefined;
    return job.kitExecution ? cloneKitExecutionRef(job.kitExecution) : null;
  }

  /**
   * Return terminal Kit outputs that survived a process restart before their
   * provider metadata was attached to the bound gateway session.
   */
  getPendingKitFinalizations(): AsyncKitTerminalFinalization[] {
    if (!this.store) return [];
    try {
      return this.store.getPendingKitFinalizations().map(entry => ({
        ...entry,
        kitExecution: cloneKitExecutionRef(entry.kitExecution),
      }));
    } catch (err) {
      this.logger.error("Kit terminal-finalization query failed", err);
      return [];
    }
  }

  /**
   * Return terminal Kit rows that were acknowledged before a crash prevented
   * their exact session attempt from being released. This is internal-only
   * maintenance metadata and never reaches an MCP tool response.
   */
  getAcknowledgedKitAttemptReleases(): AsyncAcknowledgedKitAttemptRelease[] {
    if (!this.store) return [];
    try {
      return this.store.getAcknowledgedKitAttemptReleases().map(entry => ({
        ...entry,
        kitExecution: cloneKitExecutionRef(entry.kitExecution),
      }));
    } catch (err) {
      this.logger.error("Kit acknowledged-attempt release query failed", err);
      return [];
    }
  }

  /**
   * Acknowledge a successfully reconciled terminal Kit output. The durable
   * compare-and-set includes the gateway session id, so a stale caller cannot
   * clear a pending result for another session.
   */
  markKitTerminalFinalized(jobId: string, kitSessionId: string): boolean {
    if (!this.store) return false;
    try {
      const marked = this.store.markKitTerminalFinalized(jobId, kitSessionId);
      if (marked) {
        const job = this.jobs.get(jobId);
        if (job && job.kitSessionId === kitSessionId) {
          job.kitTerminalFinalized = true;
        }
      }
      return marked;
    } catch (err) {
      this.logger.error(`Kit terminal-finalization mark failed for job ${jobId}`, err);
      return false;
    }
  }

  /**
   * Release-GC query. Durable store rows are authoritative across restarts;
   * scan memory too in case a test/ephemeral backend has not exposed the query.
   */
  getPinnedKitReleaseIds(): string[] {
    const releases = new Set<string>();
    try {
      for (const releaseId of this.store?.getPinnedKitReleaseIds?.() ?? []) {
        releases.add(releaseId);
      }
    } catch (err) {
      this.logger.error("Kit release-pin query failed", err);
    }
    for (const job of this.jobs.values()) {
      if (job.kitExecution && (isAsyncJobInProgress(job.status) || !job.kitTerminalFinalized)) {
        releases.add(job.kitExecution.releaseId);
      }
    }
    return [...releases].sort();
  }

  getReferencedKitReleaseIds(): string[] {
    return this.getPinnedKitReleaseIds();
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
    env?: NodeJS.ProcessEnv,
    onComplete?: () => void,
    flightRecorderEntry?: AsyncJobFlightRecorderEntry,
    extractUsage?: AsyncJobUsageExtractor,
    writeFlightStart?: boolean,
    stdin?: string,
    compressResponse?: boolean,
    kitExecution?: KitExecutionRef | null,
    onTerminal?: AsyncJobTerminalHook,
    kitSessionId?: string,
    jobId?: string,
    dedupArgs?: string[],
    mcpArtifactPath?: string,
    mcpArtifactScope?: string
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
      kitExecution,
      onTerminal,
      kitSessionId,
      jobId,
      dedupArgs,
      mcpArtifactPath,
      mcpArtifactScope,
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
      artifactCleanup,
      onTerminal,
      kitExecution,
      kitSessionId,
      jobId,
      flightRecorderEntry,
      extractUsage,
      writeFlightStart,
      compressResponse,
      dedupArgs,
      persistedArgs,
      payloadJson,
      mcpArtifactPath: requestedMcpArtifactPath,
      mcpArtifactScope: requestedMcpArtifactScope,
      deferLaunch,
      validationAdmission,
    } = opts;
    const stableKitExecution = kitExecution ? cloneKitExecutionRef(kitExecution) : null;
    const stableKitSessionId = normalizeKitSessionId(stableKitExecution, kitSessionId);
    const invalidArgv = containsInvalidCliArg(args);
    const durableFlightRecorderEntry = redactInvalidArgvFlightRecorderEntry(
      redactPersonalKitFlightRecorderEntry(flightRecorderEntry, stableKitExecution),
      invalidArgv
    );
    const reservedKitJobId = normalizeReservedKitJobId(stableKitExecution, jobId);
    assertMcpArtifactAdmissionInvariant({
      cli,
      transport: "process",
      ownerHostname: this.hostname,
      mcpArtifactPath: requestedMcpArtifactPath ?? null,
      mcpArtifactScope: requestedMcpArtifactScope ?? null,
      kitExecution: stableKitExecution,
    });
    const durableMcpArtifactPath = resolvePersistedClaudeMcpArtifactPath(
      cli,
      args,
      requestedMcpArtifactPath
    );
    const durableMcpArtifactScope = resolvePersistedClaudeMcpArtifactScope(
      durableMcpArtifactPath,
      requestedMcpArtifactScope
    );
    assertMcpArtifactAdmissionInvariant({
      cli,
      transport: "process",
      ownerHostname: this.hostname,
      mcpArtifactPath: durableMcpArtifactPath,
      mcpArtifactScope: durableMcpArtifactScope,
      kitExecution: stableKitExecution,
    });
    let requestKey: string;
    if (stableKitExecution) {
      if (!isValidationRunStore(this.store) || !this.durableAdmission) {
        throw new Error("Personal Agent Config Kit requires a healthy durable job store");
      }
      if (!reservedKitJobId || !forceRefresh) {
        throw new Error("A Kit job requires a reserved durable id and forceRefresh");
      }
      // Kit jobs are forced fresh and their durable row must not fingerprint the
      // private compiled context, argv, stdin, or environment. The caller has
      // already reserved this UUID, so it is a stable opaque key for this one job.
      requestKey = personalKitJobRequestKey(reservedKitJobId);
    } else {
      requestKey = this.buildRequestKey(
        cli,
        dedupArgs ?? args,
        extraEnv,
        stdin,
        cwd,
        outputFormat,
        compressResponse
      );
    }
    const cleanup = artifactCleanup ?? onComplete;

    if (validationAdmission && !forceRefresh) {
      throw new Error("Validation review jobs require forceRefresh");
    }
    if (validationAdmission && (!isValidationRunStore(this.store) || !this.durableAdmission)) {
      throw new DurableJobAdmissionError(
        cli,
        new Error("Validation job admission requires a healthy validation-run store")
      );
    }
    if (!forceRefresh) {
      const reused = this.tryReuseDedupedJob(requestKey, correlationId, cli, cleanup);
      if (reused) return reused;
    }

    // #139: fail-closed admission gate (see startHttpJob).
    this.assertDurableAdmission(cli);

    const id = reservedKitJobId ?? randomUUID();
    if (this.jobs.has(id) || this.store?.getById(id)) {
      throw new Error(`Job id ${id} is already in use`);
    }
    const startedAt = new Date().toISOString();

    // F3: ownership principal from the request context ambient at job creation
    // (synchronous with the tool handler). stdio / boot-time paths → "local".
    const ownerPrincipal = resolveOwnerPrincipal(getRequestContext());
    const terminalHookCompletion = createTerminalHookCompletion();
    const job: AsyncJobRecord = {
      id,
      cli,
      ownerPrincipal,
      // Retain the exact vector only in the launch closure. A queued job needs
      // it until admission runs, but the long-lived job record must not keep a
      // rejected NUL-bearing vector through its completed-memory TTL.
      args: invalidArgv ? persistableJobArgs(args, stableKitExecution) : [...args],
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
      errorCategory: null,
      retryable: null,
      process: null,
      transport: "process",
      abort: null,
      httpStatus: null,
      exited: false,
      metricsRecorded: false,
      outputFormat,
      compressResponse: compressResponse ?? null,
      mcpArtifactPath: durableMcpArtifactPath,
      mcpArtifactScope: durableMcpArtifactScope,
      kitExecution: stableKitExecution,
      kitSessionId: stableKitSessionId,
      kitOutputAvailableInMemory: stableKitExecution !== null,
      kitTerminalFinalized: false,
      terminalPersistenceAcknowledged: stableKitExecution === null,
      progress: new JobProgressTracker(
        cli,
        outputFormat,
        null,
        startedAt,
        resolveJobProgressCapability(cli, args, outputFormat, "process")
      ),
      progressDirty: true,
      lastProgressFlushAt: Date.now(),
      artifactCleanup: cleanup,
      artifactCleanupFired: false,
      onTerminal,
      onTerminalFired: false,
      terminalHookCompletion: terminalHookCompletion.promise,
      resolveTerminalHookCompletion: terminalHookCompletion.resolve,
      outputDirty: false,
      lastOutputFlushAt: Date.now(),
      flightRecorderEntry: durableFlightRecorderEntry,
      extractUsage,
      flightRecorderComplete: false,
      // R2 Codex-Unit-B F1: pure async path arms now (writeFlightStart=true
      // means the manager is the only FR writer). Sync-deferred path
      // arrives with writeFlightStart=false and arms later via
      // armFlightCompleteForDeferral when awaitJobOrDefer decides to defer.
      flightCompleteArmed: writeFlightStart === true,
    };
    job.progress.emit("queued", "lifecycle", "Job queued");
    this.jobs.set(id, job);

    // Issue #130: spawn + wire the child process. Run inline when the limiter
    // grants a permit immediately, or from the limiter's onGrant callback when
    // the job first had to queue. Never spawns before a permit is held.
    const launch = (permit: LimiterPermit): void => {
      job.limiterPermit = permit;
      job.queueCancel = undefined;
      if (this.disposed && job.status === "queued") {
        this.failQueuedJob(job, "Gateway is shutting down before execution", 1);
        return;
      }
      // If the job was canceled/failed while queued (e.g. queue timeout, or a
      // client cancel) before this grant landed, do not spawn; hand the permit
      // straight back.
      if (job.status !== "queued") {
        this.releaseJobPermit(job);
        return;
      }
      job.status = "running";
      this.emitProgress(job, "starting", "lifecycle", "Provider process started");
      try {
        this.launchProcessJob(job, { cli, args, cwd, stdin, extraEnv, idleTimeoutMs });
      } catch (err) {
        const launchError = describeProcessLaunchError(cli, err as Error);
        job.status = "failed";
        job.exitCode = launchError.exitCode;
        job.error = launchError.message;
        job.errorCategory = launchError.errorCategory;
        job.retryable = launchError.retryable;
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

    let launchReleased = deferLaunch !== true;
    let heldPermit: LimiterPermit | null = null;
    const grantOrHold = (permit: LimiterPermit): void => {
      job.queueCancel = undefined;
      if (!launchReleased) {
        heldPermit = permit;
        job.limiterPermit = permit;
        return;
      }
      launch(permit);
    };

    const acq = this.limiter.acquire(
      cli,
      permit => grantOrHold(permit),
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
      args: invalidArgv
        ? persistableJobArgs(args, stableKitExecution)
        : persistableJobArgs(persistedArgs ?? args, stableKitExecution),
      outputFormat,
      compressResponse,
      startedAt,
      pid: null,
      ownerPrincipal,
      ownerInstance: this.instanceId,
      ownerHostname: this.hostname,
      mcpArtifactPath: durableMcpArtifactPath,
      mcpArtifactScope: durableMcpArtifactScope,
      // payloadJson is an optional second retained representation of process
      // input. Suppress it when argv admission is already known to fail so a
      // caller cannot bypass the invalid-vector redaction via that column.
      payloadJson: stableKitExecution || invalidArgv ? null : (payloadJson ?? null),
      kitExecution: stableKitExecution,
      kitSessionId: stableKitSessionId,
      validationAdmission,
    });
    this.maybeFlushProgress(job, true);
    // Slice 1.5: only opt-in callers (pure async handlers) write logStart
    // here. The sync-deferred path passes writeFlightStart=false because
    // the upstream sync handler already wrote a logStart row keyed on the
    // same correlationId; a duplicate INSERT would crash on the PK.
    if (writeFlightStart && durableFlightRecorderEntry) {
      try {
        this.flightRecorder.logStart({
          correlationId,
          cli,
          model: durableFlightRecorderEntry.model,
          prompt: durableFlightRecorderEntry.prompt,
          sessionId: durableFlightRecorderEntry.sessionId,
          asyncJobId: id,
          stablePrefixHash: durableFlightRecorderEntry.stablePrefixHash,
          stablePrefixTokens: durableFlightRecorderEntry.stablePrefixTokens,
          cacheControlBlocks: durableFlightRecorderEntry.cacheControlBlocks,
          cacheControlTtlSeconds: durableFlightRecorderEntry.cacheControlTtlSeconds,
        });
      } catch (err) {
        this.logger.error("Async-path flight recorder logStart failed", err);
      }
    }

    if (acq.state === "granted") {
      if (deferLaunch) {
        heldPermit = acq.permit;
        job.limiterPermit = acq.permit;
        this.logger.info(`Job ${id} prepared for ${cli}`, { correlationId });
      } else {
        this.logger.info(`Job ${id} started for ${cli}`, { correlationId });
        launch(acq.permit);
      }
    } else {
      job.queueCancel = acq.cancel;
      this.logger.info(`Job ${id} queued for ${cli} (limiter saturated)`, { correlationId });
    }

    const deferredControl: DeferredJobLaunch | undefined = deferLaunch
      ? {
          release: () => {
            if (launchReleased) return;
            launchReleased = true;
            if (job.status !== "queued") return;
            const permit = heldPermit;
            heldPermit = null;
            if (permit) launch(permit);
          },
          cancel: () => {
            if (launchReleased) return false;
            launchReleased = true;
            heldPermit = null;
            return this.cancelJob(id).canceled;
          },
        }
      : undefined;
    return { snapshot: this.snapshot(job), deduped: false, deferredLaunch: deferredControl };
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
      extraEnv?: NodeJS.ProcessEnv;
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
    let durableMarkFailure: Error | null = null;
    try {
      this.markRunningDurable(job, child.pid ?? null, true);
    } catch (err) {
      durableMarkFailure = err instanceof Error ? err : new Error(String(err));
      // Keep the record running until `close` proves the just-spawned child is
      // gone. Finalizing now would release a Kit continuation while an OS
      // process may still be consuming it.
      job.terminationRequested = true;
      job.exitCode = 1;
      job.error = `Durable job transition failed: ${durableMarkFailure.message}`;
      job.stderr = job.error;
    }
    // Single cleanup flag to prevent double-unregister
    let groupCleaned = false;
    const cleanupGroup = () => {
      if (groupCleaned) return;
      groupCleaned = true;
      if (child.pid) unregisterProcessGroup(child.pid);
    };
    job.cleanupGroup = cleanupGroup;
    const terminationFence = createProcessGroupTerminationFence(child, cleanupGroup);
    job.terminateProcessGroup = (signal, graceMs): void => {
      terminationFence.request(signal, graceMs);
    };
    let stdinDelivery: ChildStdinDelivery | null = null;

    // Idle timeout: kill process if no output activity for idleTimeoutMs
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      if (!idleTimeoutMs || idleTimeoutMs <= 0) return;
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        if (job.status !== "running" || job.terminationRequested) return;
        job.terminationRequested = true;
        job.exitCode = 125;
        job.error = `Process killed after ${idleTimeoutMs}ms of inactivity`;
        if (!job.kitExecution) {
          job.status = "failed";
          job.finishedAt = new Date().toISOString();
        }
        terminationFence.request();
        this.logger.info(`Job ${id} killed due to inactivity (${idleTimeoutMs}ms)`, {
          correlationId,
        });
        if (!job.kitExecution) {
          this.emitMetrics(job);
          this.persistComplete(job);
          this.writeFlightComplete(job, "failed");
          this.fireOnComplete(job);
        }
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
      // A ChildProcess error does not by itself prove death after spawn. For
      // example, a failed signal delivery can emit `error` while the provider
      // process continues using its native session. Only a no-PID spawn failure
      // is definitive here; every spawned child remains owned until `close`.
      if (child.pid) {
        this.logger.error(`Job ${id} process error while awaiting close`, {
          error,
          correlationId,
        });
        return;
      }
      job.exited = true;
      stdinDelivery?.cleanup();
      job.clearIdleTimer?.();
      terminationFence.cleanupAfterLeaderExit();
      if (job.status === "running") {
        const launchError = job.terminationRequested
          ? {
              exitCode: job.exitCode ?? 1,
              message:
                job.error ?? "Gateway shutdown requested before provider process reached close",
              errorCategory: job.errorCategory,
              retryable: job.retryable,
            }
          : describeProcessLaunchError(cli, error);
        job.status = job.canceled ? "canceled" : "failed";
        job.exitCode = launchError.exitCode;
        job.error = launchError.message;
        job.errorCategory = launchError.errorCategory;
        job.retryable = launchError.retryable;
        job.stderr = job.stderr ? `${job.stderr}\n${launchError.message}` : launchError.message;
        job.finishedAt = new Date().toISOString();
        this.logger.error(`Job ${id} error: ${launchError.message}`, { correlationId });
        this.emitMetrics(job);
        this.persistComplete(job);
        this.writeFlightComplete(job, "failed");
        this.fireOnComplete(job);
      }
    });

    child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
      job.exited = true;
      const stdinDeliveryIncomplete = isChildStdinDeliveryIncomplete(stdinDelivery);
      stdinDelivery?.cleanup();
      job.clearIdleTimer?.();
      // Close is the positive death proof for every process termination path.
      // Release its process-group bookkeeping here, never merely because a
      // SIGTERM/SIGKILL request was sent.
      terminationFence.cleanupAfterLeaderExit();
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

      const rawExitCode = code ?? (signal ? 1 : 0);
      if (signal && !job.canceled && !job.terminationRequested) {
        job.terminationRequested = true;
        job.exitCode = 1;
        job.error ??= `Process terminated by ${signal}`;
      }
      const launchExit =
        !job.stdout && !job.stderr ? describeWindowsLaunchExit(cli, rawExitCode) : null;
      if (!job.terminationRequested || job.exitCode === null) {
        job.exitCode = launchExit?.exitCode ?? rawExitCode;
      }
      if (launchExit) {
        job.error = launchExit.message;
        job.stderr = launchExit.message;
      }
      job.finishedAt = new Date().toISOString();

      if (job.canceled) {
        job.status = "canceled";
      } else if (job.stdinDeliveryFailed && code !== null && code !== 0) {
        // A real provider nonzero exit remains authoritative when it races a
        // stdin failure. Never replace provider diagnostics with pipe state.
        job.status = "failed";
        job.exitCode = code;
        job.error = null;
        job.errorCategory = null;
        job.retryable = null;
      } else if (job.terminationRequested) {
        // Idle/output termination retains the diagnostic captured when the
        // signal was requested, regardless of the process's eventual code.
        job.status = "failed";
        if (job.stdinDeliveryFailed) {
          const deliveryError = new ChildStdinWriteFailedError();
          job.exitCode = 1;
          job.error = deliveryError.message;
          job.errorCategory = null;
          job.retryable = deliveryError.retryable;
          job.stderr = job.stderr ? `${job.stderr}\n${job.error}` : job.error;
        }
      } else if (job.exitCode !== 0) {
        // Preserve the provider's own nonzero exit and diagnostics.
        job.status = "failed";
      } else if (job.stdinDeliveryIncomplete || stdinDeliveryIncomplete) {
        job.status = "failed";
        job.exitCode = CHILD_STDIN_INCOMPLETE_EXIT_CODE;
        job.error = CHILD_STDIN_INCOMPLETE_MESSAGE;
        job.errorCategory = null;
        job.retryable = false;
        job.stderr = job.stderr ? `${job.stderr}\n${job.error}` : job.error;
      } else {
        job.status = "completed";
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

    if (!durableMarkFailure && stdin !== undefined) {
      const failStdinWrite = (error: Error): void => {
        if (job.exited || job.canceled || job.terminationRequested) return;
        const deliveryError = normalizeChildStdinDeliveryError(error);
        // Keep closed-pipe errors out of process-level handlers and never
        // retain their native message. The close path lets cancellation,
        // timeout, and provider nonzero exit take precedence, but rejects an
        // otherwise-successful exit because its request was incomplete.
        if (deliveryError instanceof ChildStdinIncompleteError) {
          job.stdinDeliveryIncomplete = true;
          return;
        }
        job.terminationRequested = true;
        job.stdinDeliveryFailed = true;
        job.exitCode = 1;
        job.errorCategory = null;
        job.retryable = null;
        this.logger.error(`Job ${id} failed to write stdin payload`, {
          error: deliveryError,
          correlationId,
        });
        terminationFence.request();
      };

      if (child.stdin) {
        stdinDelivery = writeAndCloseChildStdin(child.stdin, stdin, failStdinWrite);
      } else {
        failStdinWrite(new ChildStdinWriteFailedError());
      }
    }

    if (durableMarkFailure) {
      try {
        terminationFence.request("SIGKILL", 0);
      } catch {
        // The close handler remains the terminal ownership boundary.
      }
    }
  }

  /**
   * Issue #130: terminate a job that is still waiting in the limiter queue
   * (never spawned a process / made a request). Used for queue-wait timeout.
   * Marks the job failed with a deterministic saturation/timeout error and
   * runs the standard terminal path (metrics, persist, flight-complete,
   * onComplete). Holds no permit, so releaseJobPermit is a no-op.
   */
  private failQueuedJob(job: AsyncJobRecord, reason: string, exitCode = 75): void {
    if (job.status !== "queued") return;
    job.queueCancel = undefined;
    job.status = "failed";
    // EX_TEMPFAIL (75): a deterministic "temporary failure, safe to retry" code
    // distinct from spawn/timeout/idle exit codes already in use.
    job.exitCode = exitCode;
    job.error = exitCode === 75 ? `Gateway is at capacity for ${job.cli}: ${reason}` : reason;
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

  getJobSnapshot(
    jobId: string,
    options: { afterProgressSeq?: number; progressLimit?: number } = {}
  ): AsyncJobSnapshot | null {
    let job = this.jobs.get(jobId);
    if (job) {
      job = this.refreshOpenHydratedJob(jobId, job) ?? undefined;
      if (!job) return null;
    } else {
      job = this.hydrateFromStore(jobId) ?? undefined;
      if (!job) return null;
    }
    return this.snapshot(job, options.afterProgressSeq ?? 0, options.progressLimit ?? 32);
  }

  /**
   * Fail-closed durable lookup for Kit attempt recovery. Unlike
   * getJobSnapshot(), a database exception is not collapsed into "not found".
   */
  lookupJobSnapshot(jobId: string): AsyncJobSnapshotLookup {
    const inMemory = this.jobs.get(jobId);
    if (inMemory) {
      return {
        state: "found",
        snapshot: this.snapshot(inMemory),
        kitExecution: inMemory.kitExecution ? cloneKitExecutionRef(inMemory.kitExecution) : null,
        kitSessionId: inMemory.kitSessionId,
        kitTerminalFinalized: inMemory.kitTerminalFinalized,
      };
    }
    if (!this.store) return { state: "unavailable" };
    let row: JobRecord | null;
    try {
      row = this.store.getById(jobId);
    } catch (err) {
      this.logger.error(`JobStore.getById failed during Kit recovery for ${jobId}`, err);
      return { state: "unavailable" };
    }
    if (!row) return { state: "not_found" };
    const job = this.hydrateJobRecord(row);
    return {
      state: "found",
      snapshot: this.snapshot(job),
      kitExecution: job.kitExecution ? cloneKitExecutionRef(job.kitExecution) : null,
      kitSessionId: job.kitSessionId,
      kitTerminalFinalized: job.kitTerminalFinalized,
    };
  }

  /**
   * Permanently fence a Kit attempt that has no durable job row. The store
   * performs the insert-if-absent in the same namespace used by normal Kit
   * recordStart, so a gateway paused before admission cannot later launch the
   * old provider turn after its session lease is explicitly released.
   */
  fenceUnadmittedKitAttempt(input: {
    attemptId: string;
    cli: LlmCli;
    kitExecution: KitExecutionRef;
    kitSessionId: string;
  }): KitAttemptFenceResult {
    if (!this.store || !this.durableAdmission) {
      throw new Error("Durable Kit attempt fencing is unavailable");
    }
    return this.store.fenceUnadmittedKitAttempt({
      attemptId: input.attemptId,
      cli: input.cli,
      kitExecution: cloneKitExecutionRef(input.kitExecution),
      kitSessionId: input.kitSessionId,
      ownerPrincipal: resolveOwnerPrincipal(getRequestContext()),
      fencedAt: new Date().toISOString(),
    });
  }

  /**
   * Wait for this instance's terminal lifecycle hook. A hook closure is not
   * durable, so an unknown or restart-hydrated job returns false and must use
   * the durable reconciliation path instead.
   */
  async awaitTerminalHook(jobId: string): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    if (job.terminalHookOutcome !== undefined) return job.terminalHookOutcome;
    if (!job.terminalHookCompletion) return false;
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), TERMINAL_HOOK_WAIT_TIMEOUT_MS);
      timer.unref?.();
      void job.terminalHookCompletion!.then(outcome => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });
  }

  getJobSnapshots(jobIds: string[]): Record<string, AsyncJobSnapshot | null> {
    return Object.fromEntries(jobIds.map(jobId => [jobId, this.getJobSnapshot(jobId)]));
  }

  getJobResult(
    jobId: string,
    maxChars = 200000,
    options: {
      stdoutOffsetChars?: number;
      stderrOffsetChars?: number;
      redactProviderSessionIds?: boolean;
    } = {}
  ): AsyncJobResult | null {
    let job = this.jobs.get(jobId);
    if (job) {
      job = this.refreshOpenHydratedJob(jobId, job) ?? undefined;
      if (!job) return null;
    } else {
      job = this.hydrateFromStore(jobId) ?? undefined;
      if (!job) return null;
    }

    const durableKitResult = Boolean(job.kitExecution) && job.kitOutputAvailableInMemory === false;
    const fullStdout = durableKitResult ? PERSONAL_KIT_OUTPUT_WITHHELD : job.stdout;
    const fullStderr = durableKitResult ? "" : job.stderr;
    // Parse from the full captured stream, not from a page, so remote redaction
    // can cover an identifier that happens to straddle a page boundary.
    const providerMeta =
      !job.kitExecution && job.transport === "process"
        ? extractProviderOutputMetadata(job.cli, job.stdout, job.outputFormat)
        : undefined;
    // A native session id is resumable only after a successful completion, but
    // remote redaction must use the parsed value for every captured outcome.
    const resumableProviderMeta = job.status === "completed" ? providerMeta : undefined;
    const stdout = pageText(fullStdout, maxChars, options.stdoutOffsetChars ?? 0);
    const stderr = pageText(fullStderr, maxChars, options.stderrOffsetChars ?? 0);
    const sessionId = options.redactProviderSessionIds ? providerMeta?.sessionId : undefined;
    // `snapshot.error` is caller-visible too. It is not paged, so scrub it in
    // full before returning the object rather than relying on the stdout/stderr
    // page redactor below.
    const snapshot = this.snapshot(job);
    const error =
      sessionId && snapshot.error !== null
        ? redactKnownProviderSessionId(snapshot.error, sessionId)
        : snapshot.error;

    return {
      ...snapshot,
      error,
      stdout: sessionId
        ? redactKnownTextPage(stdout.text, stdout.offsetChars, fullStdout, sessionId)
        : stdout.text,
      stderr: sessionId
        ? redactKnownTextPage(stderr.text, stderr.offsetChars, fullStderr, sessionId)
        : stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      stdoutOffsetChars: stdout.offsetChars,
      stdoutTotalChars: stdout.totalChars,
      stdoutNextOffsetChars: stdout.nextOffsetChars,
      stderrOffsetChars: stderr.offsetChars,
      stderrTotalChars: stderr.totalChars,
      stderrNextOffsetChars: stderr.nextOffsetChars,
      ...(resumableProviderMeta?.sessionId
        ? { providerSessionId: resumableProviderMeta.sessionId }
        : {}),
      ...(resumableProviderMeta?.stopReason
        ? { stopReason: resumableProviderMeta.stopReason }
        : {}),
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
      // A deferred-launch roster can hold an already-granted permit while the
      // job deliberately remains queued. Release it before terminalizing.
      this.releaseJobPermit(job);
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
    job.terminationRequested = Boolean(job.kitExecution);
    if (!job.kitExecution) {
      job.status = "canceled";
      job.finishedAt = new Date().toISOString();
    }
    job.clearIdleTimer?.();
    if (job.terminateProcessGroup) {
      job.terminateProcessGroup();
    } else {
      killProcessGroup(job.process, "SIGKILL");
      job.cleanupGroup?.();
    }
    this.logger.info(`Job ${jobId} canceled`, { correlationId: job.correlationId });
    if (!job.kitExecution) {
      this.persistComplete(job);
      this.writeFlightComplete(job, "failed", "canceled by caller");
      this.fireOnComplete(job);
    }

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
      if (job.status === "running" && !job.terminationRequested) {
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
    if (this.disposed) {
      return Promise.reject(
        new JobSaturationError(provider, "Gateway is shutting down; retry after it restarts")
      );
    }
    return new Promise((resolve, reject) => {
      const acq = this.limiter.acquire(
        provider,
        permit => {
          if (this.disposed) {
            permit.release();
            reject(
              new JobSaturationError(provider, "Gateway is shutting down; retry after it restarts")
            );
            return;
          }
          resolve(permit);
        },
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

  /**
   * Refresh a queued/running row that this process only hydrated from shared
   * storage. The owning instance may append progress or finish it at any time;
   * caching that projection forever makes cross-instance status and watch stale.
   */
  private refreshOpenHydratedJob(jobId: string, job: AsyncJobRecord): AsyncJobRecord | null {
    if (
      !this.store ||
      job.hydratedFromStore !== true ||
      (job.status !== "queued" && job.status !== "running") ||
      job.process !== null ||
      job.abort !== null
    ) {
      return job;
    }
    try {
      const row = this.store.getById(jobId);
      if (!row) {
        this.jobs.delete(jobId);
        return null;
      }
      this.jobs.delete(jobId);
      return this.hydrateJobRecord(row);
    } catch (err) {
      this.logger.error(`JobStore.getById failed while refreshing shared job ${jobId}`, err);
      return job;
    }
  }

  /** Lazily backfill progress for legacy in-memory embedder records. */
  private progressTracker(job: AsyncJobRecord): JobProgressTracker {
    if (!job.progress) {
      job.progress = new JobProgressTracker(
        job.cli,
        job.outputFormat,
        null,
        job.startedAt,
        resolveJobProgressCapability(job.cli, job.args, job.outputFormat, job.transport)
      );
      job.progressDirty = true;
      job.lastProgressFlushAt = Date.now();
    }
    return job.progress;
  }

  private snapshot(
    job: AsyncJobRecord,
    afterProgressSeq = 0,
    progressLimit = 32
  ): AsyncJobSnapshot {
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
      error: job.kitExecution && job.error ? PERSONAL_KIT_FAILURE_WITHHELD : job.error,
      ...(job.errorCategory ? { errorCategory: job.errorCategory } : {}),
      ...(job.retryable !== null ? { retryable: job.retryable } : {}),
      exited: job.exited,
      progress: this.progressTracker(job).snapshot(afterProgressSeq, progressLimit),
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
        job.terminationRequested = true;
        job.exitCode = 126;
        job.error = overflowMsg;
        if (!job.kitExecution) {
          job.status = "failed";
          job.finishedAt = new Date().toISOString();
        }
        job.clearIdleTimer?.();
        if (job.terminateProcessGroup) {
          job.terminateProcessGroup();
        } else if (job.process) {
          killProcessGroup(job.process, "SIGKILL");
          job.cleanupGroup?.();
        }
        this.logger.info(`Job ${job.id} killed due to output overflow`, {
          correlationId: job.correlationId,
        });
        if (!job.kitExecution) {
          this.emitMetrics(job);
          this.persistComplete(job);
          this.writeFlightComplete(job, "failed", overflowMsg);
          this.fireOnComplete(job);
        }
        if (!job.process) {
          job.cleanupGroup?.();
        }
      }
      return;
    }

    job.resetIdleTimer?.();
    this.progressTracker(job).ingest(stream, chunk);
    job.progressDirty = true;
    this.maybeFlushProgress(job);

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
