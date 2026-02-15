import { ChildProcess, spawn } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { readdirSync, existsSync } from "fs";
import { createCircuitBreaker, withRetry } from "./retry.js";

export interface ExecuteOptions {
  timeout?: number;
  idleTimeout?: number;
  cwd?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  code: number;
}

const MAX_OUTPUT_SIZE = 50 * 1024 * 1024;
const circuitBreakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();
let cachedNvmPath: string | undefined | null;

function getCircuitBreaker(command: string) {
  const existing = circuitBreakers.get(command);
  if (existing) {
    return existing;
  }
  const circuitBreaker = createCircuitBreaker();
  circuitBreakers.set(command, circuitBreaker);
  return circuitBreaker;
}

function getNvmPath(): string | null {
  if (cachedNvmPath !== undefined) {
    return cachedNvmPath;
  }

  const home = homedir();
  const nvmVersionsDir = join(home, ".nvm/versions/node");
  if (!existsSync(nvmVersionsDir)) {
    cachedNvmPath = null;
    return cachedNvmPath;
  }

  try {
    const versions = readdirSync(nvmVersionsDir);
    cachedNvmPath = versions.length
      ? versions.map((version) => join(nvmVersionsDir, version, "bin")).join(":")
      : null;
  } catch {
    cachedNvmPath = null;
  }

  return cachedNvmPath;
}

// Extend PATH to include common locations for CLI tools
export function getExtendedPath(): string {
  const home = homedir();
  const additionalPaths: string[] = [
    join(home, ".local/bin"),
    dirname(process.execPath), // Current node's bin directory
    "/usr/local/bin",
    "/usr/bin"
  ];

  // Add all nvm node version bin directories
  const nvmPath = getNvmPath();
  if (nvmPath) {
    additionalPaths.push(nvmPath);
  }

  const currentPath = process.env.PATH || "";
  return [...additionalPaths, currentPath].join(":");
}

/** Registry of active detached process groups for shutdown cleanup. */
const activeProcessGroups = new Set<number>();

export function registerProcessGroup(pid: number): void {
  activeProcessGroups.add(pid);
}

export function unregisterProcessGroup(pid: number): void {
  activeProcessGroups.delete(pid);
}

/**
 * Kill all active process groups. Called on gateway shutdown.
 * Sends SIGTERM to all groups, waits 3s, then SIGKILL survivors.
 * Returns a Promise that resolves after SIGKILL escalation completes.
 * The returned Promise keeps the event loop alive (no .unref()),
 * ensuring the process does NOT exit before SIGKILL fires.
 */
export function killAllProcessGroups(): Promise<void> {
  if (activeProcessGroups.size === 0) return Promise.resolve();

  for (const pid of activeProcessGroups) {
    try { process.kill(-pid, "SIGTERM"); } catch { /* ESRCH ok */ }
  }
  return new Promise(resolve => {
    setTimeout(() => {
      for (const pid of activeProcessGroups) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* ESRCH ok */ }
      }
      activeProcessGroups.clear();
      resolve();
    }, 3000); // No .unref() — keeps event loop alive through escalation
  });
}

/**
 * Kill an entire process group. Falls back to killing just the process
 * if the group kill fails (e.g., pid not yet assigned).
 */
export function killProcessGroup(proc: ChildProcess, signal: NodeJS.Signals): boolean {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch (err: any) {
      // ESRCH = process/group already dead — not an error
      if (err.code !== "ESRCH") {
        try { return proc.kill(signal); } catch { return false; }
      }
      return false;
    }
  }
  try { return proc.kill(signal); } catch { return false; }
}

export async function executeCli(
  command: string,
  args: string[],
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const { timeout, idleTimeout, cwd } = options;
  const extendedPath = getExtendedPath();
  const circuitBreaker = getCircuitBreaker(command);

  const runOnce = () => new Promise<ExecuteResult>((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: extendedPath }
    });

    if (proc.pid) registerProcessGroup(proc.pid);
    // Prevent detached process from keeping parent alive when not needed
    proc.unref();

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idledOut = false;
    let overflowed = false;
    let exited = false;
    let outputSize = 0;
    let settled = false;

    // Single cleanup flag to prevent double-unregister
    let groupCleaned = false;
    const cleanupProcessGroup = () => {
      if (groupCleaned) return;
      groupCleaned = true;
      if (proc.pid) unregisterProcessGroup(proc.pid);
    };

    const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
    const timeoutId = timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        killProcessGroup(proc, "SIGTERM");

        setTimeout(() => {
          if (!exited) killProcessGroup(proc, "SIGKILL");
          cleanupProcessGroup();
        }, 5000);
      }, timeoutMs)
      : undefined;

    // Idle timeout: kill process if no stdout/stderr activity for idleMs
    const idleMs = typeof idleTimeout === "number" && Number.isFinite(idleTimeout) && idleTimeout > 0
      ? idleTimeout : undefined;
    let idleTimerId: ReturnType<typeof setTimeout> | undefined;

    const resetIdleTimer = () => {
      if (!idleMs) return;
      if (idleTimerId) clearTimeout(idleTimerId);
      idleTimerId = setTimeout(() => {
        idledOut = true;
        if (timeoutId) clearTimeout(timeoutId);
        killProcessGroup(proc, "SIGTERM");
        setTimeout(() => {
          if (!exited) killProcessGroup(proc, "SIGKILL");
          cleanupProcessGroup();
        }, 5000);
      }, idleMs);
    };

    // Start idle timer immediately (covers case where process never outputs)
    resetIdleTimer();

    const finalizeReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (idleTimerId) {
        clearTimeout(idleTimerId);
      }
      reject(error);
    };

    const handleOutputChunk = (data: Buffer, stream: "stdout" | "stderr") => {
      outputSize += data.length;
      if (outputSize > MAX_OUTPUT_SIZE) {
        overflowed = true;
        killProcessGroup(proc, "SIGTERM");
        setTimeout(() => {
          if (!exited) killProcessGroup(proc, "SIGKILL");
          cleanupProcessGroup();
        }, 5000);
        finalizeReject(new Error("Output exceeded maximum size (50MB)"));
        return;
      }

      resetIdleTimer();

      const text = data.toString();
      if (stream === "stdout") {
        stdout += text;
      } else {
        stderr += text;
      }
    };

    proc.stdout.on("data", (data) => {
      if (settled) {
        return;
      }
      handleOutputChunk(data, "stdout");
    });

    proc.stderr.on("data", (data) => {
      if (settled) {
        return;
      }
      handleOutputChunk(data, "stderr");
    });

    proc.on("close", (code) => {
      exited = true;
      if (idleTimerId) {
        clearTimeout(idleTimerId);
      }
      // Unregister process group on clean exit (no kill was issued)
      if (!timedOut && !idledOut && !overflowed) {
        cleanupProcessGroup();
      }
      if (settled) {
        return;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      if (timedOut) {
        const result = {
          stdout,
          stderr: stderr + `\nProcess timed out after ${timeoutMs}ms`,
          code: 124 // Standard timeout exit code
        };
        const error = new Error(result.stderr) as Error & { code?: number; result?: ExecuteResult };
        error.code = 124;
        error.result = result;
        reject(error);
        return;
      }

      if (idledOut) {
        const result = {
          stdout,
          stderr: stderr + `\nProcess killed after ${idleMs}ms of inactivity`,
          code: 125
        };
        const error = new Error(result.stderr) as Error & { code?: number; result?: ExecuteResult };
        error.code = 125;
        error.result = result;
        reject(error);
        return;
      }

      const result = { stdout, stderr, code: code ?? 0 };
      if (result.code !== 0) {
        const error = new Error(`Process exited with code ${result.code}`) as Error & { code?: number; result?: ExecuteResult };
        error.code = result.code;
        error.result = result;
        reject(error);
        return;
      }

      resolve(result);
    });

    proc.on("error", (err) => {
      exited = true;
      if (idleTimerId) {
        clearTimeout(idleTimerId);
      }
      cleanupProcessGroup();
      if (settled) {
        return;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      settled = true;
      reject(err);
    });
  });

  try {
    return await withRetry(runOnce, circuitBreaker);
  } catch (error: any) {
    if (error?.cause?.message === "Output exceeded maximum size (50MB)") {
      throw error.cause;
    }
    const result = error?.result ?? error?.cause?.result;
    if (result) {
      return result as ExecuteResult;
    }
    throw error;
  }
}
