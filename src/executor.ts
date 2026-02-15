import { spawn } from "child_process";
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
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: extendedPath }
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let idledOut = false;
    let exited = false;
    let outputSize = 0;
    let settled = false;

    const timeoutMs = typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : undefined;
    const timeoutId = timeoutMs
      ? setTimeout(() => {
        timedOut = true;
        proc.kill("SIGTERM");

        // Force kill if process doesn't terminate
        setTimeout(() => {
          if (!exited) {
            proc.kill("SIGKILL");
          }
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
        // Clear wall-clock timeout to prevent timedOut from overriding idledOut
        if (timeoutId) clearTimeout(timeoutId);
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) proc.kill("SIGKILL");
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
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!exited) {
            proc.kill("SIGKILL");
          }
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
