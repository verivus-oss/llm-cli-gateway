import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { getExtendedPath } from "./executor.js";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";

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
  resetIdleTimer?: () => void;
  clearIdleTimer?: () => void;
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

  constructor(private logger: Logger = noopLogger) {
    this.evictionTimer = setInterval(() => this.evictCompletedJobs(), EVICTION_INTERVAL_MS);
    // Allow the process to exit even if the timer is active
    if (this.evictionTimer.unref) {
      this.evictionTimer.unref();
    }
  }

  private evictCompletedJobs(): void {
    const now = Date.now();
    let evicted = 0;
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

  startJob(cli: LlmCli, args: string[], correlationId: string, cwd?: string, idleTimeoutMs?: number): AsyncJobSnapshot {
    const id = randomUUID();
    const startedAt = new Date().toISOString();
    const child = spawn(cli, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: getExtendedPath() }
    });

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
      exited: false
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
        job.process.kill("SIGTERM");
        this.logger.info(`Job ${id} killed due to inactivity (${idleTimeoutMs}ms)`, { correlationId });
        setTimeout(() => {
          if (!job.exited) job.process.kill("SIGKILL");
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
      if (job.status === "running") {
        job.status = job.canceled ? "canceled" : "failed";
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
        this.logger.error(`Job ${id} error: ${error.message}`, { correlationId });
      }
    });

    child.on("close", (code: number | null) => {
      job.exited = true;
      job.clearIdleTimer?.();
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
    job.process.kill("SIGTERM");
    this.logger.info(`Job ${jobId} canceled`, { correlationId: job.correlationId });

    setTimeout(() => {
      if (!job.exited) {
        job.process.kill("SIGKILL");
      }
    }, 5000);

    return { canceled: true };
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
        job.process.kill("SIGTERM");
        this.logger.info(`Job ${job.id} killed due to output overflow`, { correlationId: job.correlationId });
        setTimeout(() => {
          if (!job.exited) job.process.kill("SIGKILL");
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
