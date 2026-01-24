import { spawn } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { readdirSync, existsSync } from "fs";
import { createCircuitBreaker, withRetry } from "./retry.js";

export interface ExecuteOptions {
  timeout?: number;
  cwd?: string;
  correlationId?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  code: number;
}

const circuitBreakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();

function getCircuitBreaker(command: string) {
  const existing = circuitBreakers.get(command);
  if (existing) {
    return existing;
  }
  const circuitBreaker = createCircuitBreaker();
  circuitBreakers.set(command, circuitBreaker);
  return circuitBreaker;
}

// Extend PATH to include common locations for CLI tools
function getExtendedPath(): string {
  const home = homedir();
  const additionalPaths: string[] = [
    join(home, ".local/bin"),
    dirname(process.execPath), // Current node's bin directory
    "/usr/local/bin",
    "/usr/bin"
  ];

  // Add all nvm node version bin directories
  const nvmVersionsDir = join(home, ".nvm/versions/node");
  if (existsSync(nvmVersionsDir)) {
    try {
      const versions = readdirSync(nvmVersionsDir);
      for (const version of versions) {
        additionalPaths.push(join(nvmVersionsDir, version, "bin"));
      }
    } catch {
      // Ignore errors reading nvm directory
    }
  }

  const currentPath = process.env.PATH || "";
  return [...additionalPaths, currentPath].join(":");
}

export async function executeCli(
  command: string,
  args: string[],
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const { timeout = 120000, cwd } = options;
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

    // Set up timeout
    const timeoutId = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");

      // Force kill if process doesn't terminate
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 5000);
    }, timeout);

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      clearTimeout(timeoutId);

      if (timedOut) {
        const result = {
          stdout,
          stderr: stderr + `\nProcess timed out after ${timeout}ms`,
          code: 124 // Standard timeout exit code
        };
        const error = new Error(result.stderr) as Error & { code?: number; result?: ExecuteResult };
        error.code = 124;
        error.result = result;
        reject(error);
        return;
      }

      resolve({ stdout, stderr, code: code ?? 0 });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });

  try {
    return await withRetry(runOnce, circuitBreaker);
  } catch (error: any) {
    if (error?.result) {
      return error.result as ExecuteResult;
    }
    if (error?.cause?.result) {
      return error.cause.result as ExecuteResult;
    }
    throw error;
  }
}
