import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { getExtendedPath, killProcessGroup, registerProcessGroup, unregisterProcessGroup } from "./executor.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";
import { ProcessMonitor, type JobHealth } from "./process-monitor.js";

export type LlmCli = "claude" | "codex" | "gemini";
export type AsyncJobStatus = "running" | "completed" | "failed" | "canceled";

const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000; // 1 hour
const EVICTION_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes

interface AsyncJobRecord {
  id: string;
  cli: LlmCli;
  args: string[];
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
  process: ChildProcess;
  exited: boolean;
  metricsRecorded: boolean;
  outputFormat?: string;
  resetIdleTimer?: () => void;
  clearIdleTimer?: () => void;
  cleanupGroup?: () => void;
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

function truncateText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return {
    text: value.slice(value.length - maxChars),
    truncated: true
  };
}

export class AsyncJobManager {
  private jobs = new Map<string, AsyncJobRecord>();
  private evictionTimer: ReturnType<typeof setInterval> | null = null;
  private processMonitor: ProcessMonitor;

  constructor(
    private logger: Logger = noopLogger,
    private onJobComplete?: (cli: LlmCli, durationMs: number, success: boolean) => void
  ) {
    this.processMonitor = new ProcessMonitor(logger);
    this.evictionTimer = setInterval(() => this.evictCompletedJobs(), EVICTION_INTERVAL_MS);
    // Allow the process to exit even if the timer is active
    if (this.evictionTimer.unref) {
      this.evictionTimer.unref();
    }
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
      if (job.status === "running" && job.process.pid) {
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
            this.logger.error(`Job ${id} process ${job.process.pid} no longer exists, marking as failed`);
            this.emitMetrics(job);
          }
          // EPERM: process exists but we can't signal it — ignore
        }
      }
      // Check for exited flag mismatch (close handler may have fired but status wasn't updated)
      if (job.status === "running" && job.exited) {
        job.status = "failed";
        job.error = "Process exited without proper status transition";
        job.finishedAt = job.finishedAt || new Date().toISOString();
        if (job.process.pid) unregisterProcessGroup(job.process.pid);
        this.logger.error(`Job ${id} has exited flag but was still in running state, marking as failed`);
        this.emitMetrics(job);
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
      this.logger.debug(`Evicted ${evicted} completed jobs`);
    }
  }

  startJob(cli: LlmCli, args: string[], correlationId: string, cwd?: string, idleTimeoutMs?: number, outputFormat?: string): AsyncJobSnapshot {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const child = spawn(cli, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: getExtendedPath() }
    });

    if (child.pid) registerProcessGroup(child.pid);
    child.unref();

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
      cleanupGroup
    };

    this.jobs.set(id, job);
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
        killProcessGroup(job.process, "SIGTERM");
        this.logger.info(`Job ${id} killed due to inactivity (${idleTimeoutMs}ms)`, { correlationId });
        this.emitMetrics(job);
        setTimeout(() => {
          if (!job.exited) killProcessGroup(job.process, "SIGKILL");
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
        job.status = job.canceled ? "canceled" : "failed";
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
        this.logger.error(`Job ${id} error: ${error.message}`, { correlationId });
        this.emitMetrics(job);
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
        job.exitCode = code ?? job.exitCode;
        if (!job.finishedAt) {
          job.finishedAt = new Date().toISOString();
        }
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
    });

    return this.snapshot(job);
  }

  getJobSnapshot(jobId: string): AsyncJobSnapshot | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }
    return this.snapshot(job);
  }

  getJobResult(jobId: string, maxChars = 200000): AsyncJobResult | null {
    const job = this.jobs.get(jobId);
    if (!job) {
      return null;
    }

    const stdout = truncateText(job.stdout, maxChars);
    const stderr = truncateText(job.stderr, maxChars);

    return {
      ...this.snapshot(job),
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated
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

    job.canceled = true;
    job.status = "canceled";
    job.finishedAt = new Date().toISOString();
    job.clearIdleTimer?.();
    killProcessGroup(job.process, "SIGTERM");
    this.logger.info(`Job ${jobId} canceled`, { correlationId: job.correlationId });

    setTimeout(() => {
      if (!job.exited) killProcessGroup(job.process, "SIGKILL");
      job.cleanupGroup?.();
    }, 5000);

    return { canceled: true };
  }

  getRunningJobs(): { jobId: string; cli: string; status: string; pid: number | null; startedAt: string }[] {
    const result = [];
    for (const [id, job] of this.jobs) {
      if (job.status === "running") {
        result.push({
          jobId: id, cli: job.cli, status: job.status,
          pid: job.process.pid ?? null, startedAt: job.startedAt
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
      jobs: health
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
      exited: job.exited
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
        killProcessGroup(job.process, "SIGTERM");
        this.logger.info(`Job ${job.id} killed due to output overflow`, { correlationId: job.correlationId });
        this.emitMetrics(job);
        setTimeout(() => {
          if (!job.exited) killProcessGroup(job.process, "SIGKILL");
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
  }
}
