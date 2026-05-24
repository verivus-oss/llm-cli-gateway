import { ChildProcess, spawn, spawnSync, type SpawnOptions } from "child_process";
import { homedir } from "os";
import { delimiter, join, dirname, extname, win32 } from "path";
import { readdirSync, existsSync } from "fs";
import { createCircuitBreaker, withRetry } from "./retry.js";
import type { Logger } from "./logger.js";

export interface ExecuteOptions {
  timeout?: number;
  idleTimeout?: number;
  cwd?: string;
  logger?: Logger;
  /** Extra environment variables to inject; merged after PATH. */
  env?: NodeJS.ProcessEnv;
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
      ? versions.map(version => join(nvmVersionsDir, version, "bin")).join(delimiter)
      : null;
  } catch {
    cachedNvmPath = null;
  }

  return cachedNvmPath;
}

function pathDelimiterFor(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : delimiter;
}

function pathJoinFor(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : join(...segments);
}

function dirnameFor(platform: NodeJS.Platform, path: string): string {
  return platform === "win32" ? win32.dirname(path) : dirname(path);
}

function pathValueFromEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return env.Path || env.PATH || "";
  }
  return env.PATH || "";
}

function addIfPresent(paths: string[], value: string | undefined): void {
  if (value) paths.push(value);
}

function windowsCommonCliPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const paths: string[] = [];
  addIfPresent(paths, env.APPDATA ? pathJoinFor("win32", env.APPDATA, "npm") : undefined);
  addIfPresent(
    paths,
    env.LOCALAPPDATA ? pathJoinFor("win32", env.LOCALAPPDATA, "pnpm") : undefined
  );
  addIfPresent(
    paths,
    env.LOCALAPPDATA ? pathJoinFor("win32", env.LOCALAPPDATA, "Programs", "nodejs") : undefined
  );
  addIfPresent(
    paths,
    env.LOCALAPPDATA ? pathJoinFor("win32", env.LOCALAPPDATA, "Programs", "npm") : undefined
  );
  addIfPresent(
    paths,
    env.ProgramFiles ? pathJoinFor("win32", env.ProgramFiles, "nodejs") : undefined
  );
  addIfPresent(
    paths,
    env["ProgramFiles(x86)"] ? pathJoinFor("win32", env["ProgramFiles(x86)"], "nodejs") : undefined
  );
  addIfPresent(
    paths,
    env.ProgramData ? pathJoinFor("win32", env.ProgramData, "chocolatey", "bin") : undefined
  );
  paths.push(pathJoinFor("win32", home, "AppData", "Roaming", "npm"));
  paths.push(pathJoinFor("win32", home, "AppData", "Local", "pnpm"));
  paths.push(pathJoinFor("win32", home, ".volta", "bin"));
  paths.push(pathJoinFor("win32", home, "scoop", "shims"));
  return paths;
}

export function buildExtendedPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  nodePath: string = process.execPath,
  platform: NodeJS.Platform = process.platform
): string {
  const additionalPaths: string[] = [
    pathJoinFor(platform, home, ".local", "bin"),
    dirnameFor(platform, nodePath), // Current node's bin directory
    "/usr/local/bin",
    "/usr/bin",
  ];

  if (platform === "win32") {
    additionalPaths.push(...windowsCommonCliPaths(env, home));
  }

  // Add all nvm node version bin directories
  const nvmPath = getNvmPath();
  if (nvmPath) {
    additionalPaths.push(nvmPath);
  }

  const currentPath = pathValueFromEnv(env, platform);
  return [...dedupePaths(additionalPaths, platform), currentPath]
    .filter(Boolean)
    .join(pathDelimiterFor(platform));
}

// Extend PATH to include common locations for CLI tools.
export function getExtendedPath(): string {
  return buildExtendedPath();
}

export function envWithExtendedPath(
  baseEnv: NodeJS.ProcessEnv = process.env,
  extendedPath: string = getExtendedPath(),
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const key =
    platform === "win32"
      ? Object.keys(env).find(existing => existing.toLowerCase() === "path") || "Path"
      : "PATH";
  env[key] = extendedPath;
  if (platform === "win32") {
    for (const existing of Object.keys(env)) {
      if (existing !== key && existing.toLowerCase() === "path") {
        delete env[existing];
      }
    }
  }
  return env;
}

function dedupePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const normalized = platform === "win32" ? path.toLowerCase() : path;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(path);
  }
  return result;
}

export interface ResolvedSpawnCommand {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export function resolveCommandForSpawn(
  command: string,
  args: string[],
  options: {
    envPath?: string;
    platform?: NodeJS.Platform;
  } = {}
): ResolvedSpawnCommand {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command, args };
  }

  const resolved = resolveWindowsCommandPath(command, options.envPath ?? getExtendedPath());
  if (!resolved) {
    return { command, args };
  }

  if (extname(resolved).toLowerCase() === ".ps1") {
    return {
      command: "powershell.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", resolved, ...args],
    };
  }

  if ([".cmd", ".bat"].includes(extname(resolved).toLowerCase())) {
    return {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `"${buildWindowsCmdCommand(resolved, args)}"`],
      windowsVerbatimArguments: true,
    };
  }

  return { command: resolved, args };
}

function buildWindowsCmdCommand(command: string, args: string[]): string {
  return [escapeWindowsCmdCommand(command), ...args.map(escapeWindowsCmdArgument)].join(" ");
}

const WINDOWS_CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/g;

function escapeWindowsCmdCommand(value: string): string {
  return win32.normalize(value).replace(WINDOWS_CMD_META_CHARS, "^$1");
}

function escapeWindowsCmdArgument(value: string): string {
  let arg = `${value}`;
  arg = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"');
  arg = arg.replace(/(?=(\\+?)?)\1$/, "$1$1");
  arg = `"${arg}"`;
  return arg.replace(WINDOWS_CMD_META_CHARS, "^$1");
}

function resolveWindowsCommandPath(command: string, envPath: string): string | null {
  if (/[\\/]/.test(command)) {
    return existsSync(command) ? command : null;
  }

  const hasExtension = extname(command) !== "";
  const extensions = hasExtension ? [""] : [".exe", ".cmd", ".bat", ".ps1", ""];
  for (const dir of envPath.split(pathDelimiterFor("win32")).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = pathJoinFor("win32", dir, command + extension);
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/** Registry of active detached process groups for shutdown cleanup. */
const activeProcessGroups = new Set<number>();

export function shouldDetachProviderProcess(platform: NodeJS.Platform = process.platform): boolean {
  // On Windows, detached console children can flash visible cmd/conhost windows
  // when provider CLIs are native console apps or .cmd shims. Keep them in the
  // gateway process tree and rely on hidden-window spawn plus taskkill cleanup.
  return platform !== "win32";
}

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
    if (process.platform === "win32") {
      killWindowsProcessTree(pid);
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        /* ESRCH ok */
      }
    }
  }
  return new Promise(resolve => {
    setTimeout(() => {
      for (const pid of activeProcessGroups) {
        if (process.platform === "win32") {
          killWindowsProcessTree(pid);
        } else {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* ESRCH ok */
          }
        }
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
    if (process.platform === "win32") {
      return killWindowsProcessTree(proc.pid);
    }
    try {
      process.kill(-proc.pid, signal);
      return true;
    } catch (err: any) {
      // ESRCH = process/group already dead — not an error
      if (err.code !== "ESRCH") {
        try {
          return proc.kill(signal);
        } catch {
          return false;
        }
      }
      return false;
    }
  }
  try {
    return proc.kill(signal);
  } catch {
    return false;
  }
}

function killWindowsProcessTree(pid: number): boolean {
  const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  return result.status === 0;
}

export function spawnCliProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    stdio: SpawnOptions["stdio"];
  }
): ChildProcess {
  const detached = shouldDetachProviderProcess();
  const resolved = resolveCommandForSpawn(command, args, {
    envPath: pathValueFromEnv(options.env, process.platform),
  });
  const proc = spawn(resolved.command, resolved.args, {
    cwd: options.cwd,
    detached,
    windowsHide: true,
    windowsVerbatimArguments: resolved.windowsVerbatimArguments,
    stdio: options.stdio,
    env: options.env,
  });
  if (proc.pid) registerProcessGroup(proc.pid);
  proc.unref();
  return proc;
}

export async function executeCli(
  command: string,
  args: string[],
  options: ExecuteOptions = {}
): Promise<ExecuteResult> {
  const { timeout, idleTimeout, cwd, env: extraEnv } = options;
  const extendedPath = getExtendedPath();
  const baseEnv = envWithExtendedPath(process.env, extendedPath);
  const circuitBreaker = getCircuitBreaker(command);

  const runOnce = () =>
    new Promise<ExecuteResult>((resolve, reject) => {
      const proc = spawnCliProcess(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...baseEnv, ...(extraEnv ?? {}) },
      });

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

      const timeoutMs =
        typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
          ? timeout
          : undefined;
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
      const idleMs =
        typeof idleTimeout === "number" && Number.isFinite(idleTimeout) && idleTimeout > 0
          ? idleTimeout
          : undefined;
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

      proc.stdout!.on("data", data => {
        if (settled) {
          return;
        }
        handleOutputChunk(data, "stdout");
      });

      proc.stderr!.on("data", data => {
        if (settled) {
          return;
        }
        handleOutputChunk(data, "stderr");
      });

      proc.on("close", code => {
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
            code: 124, // Standard timeout exit code
          };
          const error = new Error(result.stderr) as Error & {
            code?: number;
            result?: ExecuteResult;
          };
          error.code = 124;
          error.result = result;
          reject(error);
          return;
        }

        if (idledOut) {
          const result = {
            stdout,
            stderr: stderr + `\nProcess killed after ${idleMs}ms of inactivity`,
            code: 125,
          };
          const error = new Error(result.stderr) as Error & {
            code?: number;
            result?: ExecuteResult;
          };
          error.code = 125;
          error.result = result;
          reject(error);
          return;
        }

        let result = { stdout, stderr, code: code ?? 0 };
        if (result.code === -4058 && !stdout && !stderr) {
          result = {
            stdout,
            stderr: `The '${command}' command was not found. Install the ${command} CLI and make sure it is on PATH.`,
            code: 127,
          };
        }
        if (result.code !== 0) {
          const error = new Error(`Process exited with code ${result.code}`) as Error & {
            code?: number;
            result?: ExecuteResult;
          };
          error.code = result.code;
          error.result = result;
          reject(error);
          return;
        }

        resolve(result);
      });

      proc.on("error", err => {
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
    return await withRetry(runOnce, circuitBreaker, undefined, options.logger);
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
