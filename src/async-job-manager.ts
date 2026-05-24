import { ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import {
  getExtendedPath,
  killProcessGroup,
  spawnCliProcess,
  unregisterProcessGroup,
} from "./executor.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { ProcessMonitor, type JobHealth } from "./process-monitor.js";
import { JobStore, computeRequestKey } from "./job-store.js";

export type LlmCli = "claude" | "codex" | "gemini" | "grok" | "mistral";
export type AsyncJobStatus = "running" | "completed" | "failed" | "canceled" | "orphaned";

const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour in-memory retention; durable store has its own (longer) retention
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const OUTPUT_FLUSH_INTERVAL_MS = 1000; // Throttle DB writes for streaming stdout/stderr

function describeProcessLaunchError(cli: LlmCli, error: Error): { exitCode: number; message: string } {
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
    text: value.slice(value.length - maxChars),
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
   * Optional hook fired exactly once when the job reaches a terminal state.
   * Used by callers that own per-request resources (outputSchema temp files,
   * etc.) that must persist for the lifetime of the spawned CLI process.
   */
  onComplete?: () => void;
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
  private processMonitor: ProcessMonitor;
  private store: JobStore | null;

  constructor(
    private logger: Logger = noopLogger,
    private onJobComplete?: (cli: LlmCli, durationMs: number, success: boolean) => void,
    store: JobStore | null = null
  ) {
    this.processMonitor = new ProcessMonitor(logger);
    this.store = store;

    if (this.store) {
      try {
        const orphaned = this.store.markOrphanedOnStartup();
        if (orphaned > 0) {
          this.logger.info(`Marked ${orphaned} in-flight job(s) as orphaned after gateway restart`);
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
  private buildRequestKey(cli: LlmCli, args: string[], env?: Record<string, string>): string {
    return computeRequestKey(cli, args, canonicaliseEnvForKey(env));
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
    onComplete?: () => void
  ): AsyncJobSnapshot {
    return this.startJobWithDedup(cli, args, correlationId, {
      cwd,
      idleTimeoutMs,
      outputFormat,
      forceRefresh,
      env,
      onComplete,
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
    const { cwd, idleTimeoutMs, outputFormat, forceRefresh, env: extraEnv, onComplete } = opts;
    const requestKey = this.buildRequestKey(cli, args, extraEnv);

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
    // Mistral Vibe ships as the `vibe` binary; the gateway uses `mistral` as the
    // provider key but spawns `vibe` on the shell.
    const command = cli === "mistral" ? "vibe" : cli;
    const child = spawnCliProcess(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: getExtendedPath(), ...(extraEnv ?? {}) },
    });

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
      })
    );
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
        this.fireOnComplete(job);
        return;
      }

      job.exitCode = code ?? 0;
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
        if (job.process) killProcessGroup(job.process, "SIGTERM");
        this.logger.info(`Job ${job.id} killed due to output overflow`, {
          correlationId: job.correlationId,
        });
        this.emitMetrics(job);
        this.persistComplete(job);
        this.fireOnComplete(job);
        setTimeout(() => {
          if (!job.exited && job.process) killProcessGroup(job.process, "SIGKILL");
          job.cleanupGroup?.();
        }, 5000);
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
