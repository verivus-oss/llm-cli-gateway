import { ChildProcess, spawn } from "child_process";
import { randomUUID } from "crypto";
import { getExtendedPath } from "./executor.js";

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

  constructor() {
    this.evictionTimer = setInterval(() => this.evictCompletedJobs(), EVICTION_INTERVAL_MS);
    // Allow the process to exit even if the timer is active
    if (this.evictionTimer.unref) {
      this.evictionTimer.unref();
    }
  }

  private evictCompletedJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (job.status !== "running" && job.finishedAt) {
        const finishedMs = new Date(job.finishedAt).getTime();
        if (now - finishedMs > JOB_TTL_MS) {
          this.jobs.delete(id);
        }
      }
    }
  }

  startJob(cli: LlmCli, args: string[], correlationId: string, cwd?: string): AsyncJobSnapshot {
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
      process: child
    };

    this.jobs.set(id, job);

    child.stdout?.on("data", (chunk: Buffer) => {
      this.appendOutput(job, "stdout", chunk);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      this.appendOutput(job, "stderr", chunk);
    });

    child.on("error", (error: Error) => {
      if (job.status === "running") {
        job.status = job.canceled ? "canceled" : "failed";
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
      }
    });

    child.on("close", (code: number | null) => {
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
    job.process.kill("SIGTERM");

    setTimeout(() => {
      if (!job.process.killed) {
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
      error: job.error
    };
  }

  private appendOutput(job: AsyncJobRecord, stream: "stdout" | "stderr", chunk: Buffer): void {
    const totalBytes = Buffer.byteLength(job.stdout) + Buffer.byteLength(job.stderr) + chunk.length;
    if (totalBytes > MAX_OUTPUT_SIZE) {
      job.outputTruncated = true;
      return;
    }

    const text = chunk.toString();
    if (stream === "stdout") {
      job.stdout += text;
    } else {
      job.stderr += text;
    }
  }
}
