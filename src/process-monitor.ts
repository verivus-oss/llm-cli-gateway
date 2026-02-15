/**
 * On-demand process health monitoring via /proc (Linux).
 * Gracefully degrades on non-Linux platforms.
 */

import { readFileSync } from "fs";
import type { Logger } from "./logger.js";
import { noopLogger } from "./logger.js";

export interface ProcessHealth {
  pid: number;
  alive: boolean;
  state: string | null;       // R=running, S=sleeping, Z=zombie, D=disk sleep, T=stopped, null=unknown
  cpuPercent: number | null;
  memoryRssKb: number | null;
  sampledAt: string;
}

export interface JobHealth {
  jobId: string;
  cli: string;
  status: string;
  processHealth: ProcessHealth | null;
  isDead: boolean;    // PID doesn't exist but job status is "running"
  isZombie: boolean;  // Process state is Z
  runningForMs: number;
}

/**
 * Parse /proc/[pid]/stat safely.
 * The `comm` field (field 2) is in parentheses and may contain spaces,
 * so we find the LAST ')' and parse remaining fields from there.
 */
export function parseProcStat(content: string): {
  state: string;
  utime: number;  // clock ticks (field 14)
  stime: number;  // clock ticks (field 15)
} | null {
  const lastParen = content.lastIndexOf(")");
  if (lastParen === -1) return null;
  const afterComm = content.slice(lastParen + 2); // skip ") "
  const fields = afterComm.split(" ");
  // fields[0] = state, fields[11] = utime (14-3), fields[12] = stime (15-3)
  if (fields.length < 13) return null;
  return {
    state: fields[0],
    utime: parseInt(fields[11], 10),
    stime: parseInt(fields[12], 10),
  };
}

/**
 * Parse VmRSS from /proc/[pid]/status.
 * Returns RSS in kilobytes (already in kB in /proc/[pid]/status).
 */
export function parseVmRss(content: string): number | null {
  const match = content.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Read total system CPU jiffies from /proc/stat.
 * Used to normalize per-process CPU into a percentage.
 */
function getTotalCpuJiffies(): number | null {
  try {
    const content = readFileSync("/proc/stat", "utf-8");
    const cpuLine = content.split("\n")[0]; // "cpu  user nice system idle ..."
    const fields = cpuLine.split(/\s+/).slice(1).map(Number);
    return fields.reduce((a, b) => a + b, 0);
  } catch {
    return null;
  }
}

export class ProcessMonitor {
  // Previous samples for CPU delta calculation
  private prevSamples = new Map<number, { utime: number; stime: number; totalJiffies: number; timestamp: number }>();

  constructor(private logger: Logger = noopLogger) {}

  /** Clear all cached CPU samples */
  reset(): void {
    this.prevSamples.clear();
  }

  sampleProcess(pid: number): ProcessHealth {
    const now = new Date().toISOString();

    // 1. Existence check
    let alive = false;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err: any) {
      if (err.code === "ESRCH") {
        return { pid, alive: false, state: null, cpuPercent: null, memoryRssKb: null, sampledAt: now };
      }
      // EPERM = process exists but we can't signal it
      if (err.code === "EPERM") {
        alive = true;
      }
    }

    // 2. Parse /proc/[pid]/stat for state + CPU ticks
    let state: string | null = null;
    let cpuPercent: number | null = null;
    try {
      const statContent = readFileSync(`/proc/${pid}/stat`, "utf-8");
      const parsed = parseProcStat(statContent);
      if (parsed) {
        state = parsed.state;

        // CPU delta calculation
        const totalJiffies = getTotalCpuJiffies();
        const prev = this.prevSamples.get(pid);
        if (prev && totalJiffies !== null) {
          const processJiffiesDelta = (parsed.utime + parsed.stime) - (prev.utime + prev.stime);
          const totalJiffiesDelta = totalJiffies - prev.totalJiffies;
          if (totalJiffiesDelta > 0) {
            cpuPercent = (processJiffiesDelta / totalJiffiesDelta) * 100;
          }
        }
        // Store for next delta
        if (totalJiffies !== null) {
          this.prevSamples.set(pid, {
            utime: parsed.utime, stime: parsed.stime,
            totalJiffies, timestamp: Date.now()
          });
        }
      }
    } catch {
      // /proc not available (non-Linux) — degrade gracefully
    }

    // 3. Parse /proc/[pid]/status for VmRSS
    let memoryRssKb: number | null = null;
    try {
      const statusContent = readFileSync(`/proc/${pid}/status`, "utf-8");
      memoryRssKb = parseVmRss(statusContent);
    } catch {
      // Non-Linux or process exited between checks
    }

    return { pid, alive, state, cpuPercent, memoryRssKb, sampledAt: now };
  }

  checkJobHealth(jobs: { jobId: string; cli: string; status: string; pid: number | null; startedAt: string }[]): JobHealth[] {
    return jobs.map(job => {
      const runningForMs = Date.now() - new Date(job.startedAt).getTime();

      if (!job.pid) {
        return {
          jobId: job.jobId, cli: job.cli, status: job.status,
          processHealth: null, isDead: false, isZombie: false, runningForMs
        };
      }

      const health = this.sampleProcess(job.pid);
      return {
        jobId: job.jobId, cli: job.cli, status: job.status,
        processHealth: health,
        isDead: job.status === "running" && !health.alive,
        isZombie: job.status === "running" && health.state === "Z",
        runningForMs
      };
    });
  }

  /** Clean up stale samples for PIDs that no longer exist */
  cleanupSamples(activePids: Set<number>): void {
    for (const pid of this.prevSamples.keys()) {
      if (!activePids.has(pid)) {
        this.prevSamples.delete(pid);
      }
    }
  }
}
