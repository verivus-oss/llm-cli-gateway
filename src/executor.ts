import { spawn } from "child_process";
import { homedir } from "os";
import { join, dirname } from "path";
import { readdirSync, existsSync } from "fs";

export interface ExecuteOptions {
  timeout?: number;
  cwd?: string;
}

export interface ExecuteResult {
  stdout: string;
  stderr: string;
  code: number;
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

  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: extendedPath }
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });

    proc.on("error", (err) => {
      reject(err);
    });
  });
}
