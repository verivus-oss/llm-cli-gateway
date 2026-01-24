import { spawn } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { readdirSync, existsSync } from "fs";
import { createCircuitBreaker, withRetry } from "./retry.js";

export interface ExecuteOptions {
  timeout?: number;
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
function getExtendedPath(): string {
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
    let outputSize = 0;
    let settled = false;

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

    const finalizeReject = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutId);
      reject(error);
    };

    const handleOutputChunk = (data: Buffer, stream: "stdout" | "stderr") => {
      outputSize += data.length;
      if (outputSize > MAX_OUTPUT_SIZE) {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) {
            proc.kill("SIGKILL");
          }
        }, 5000);
        finalizeReject(new Error("Output exceeded maximum size (50MB)"));
        return;
      }

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
      if (settled) {
        return;
      }
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
      if (settled) {
        return;
      }
      clearTimeout(timeoutId);
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
