import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import { resolve as resolvePath, join, sep } from "path";
import { logWarn, noopLogger, type Logger } from "./logger.js";

const GIT_TIMEOUT_MS = 10_000;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export interface WorktreeHandle {
  name: string;
  path: string;
  ref: string;
  createdAt: string;
}

export interface CreateWorktreeOptions {
  repoRoot: string;
  name?: string;
  ref?: string;
  logger?: Logger;
}

export interface RemoveWorktreeOptions {
  repoRoot: string;
  path: string;
  name?: string;
  logger?: Logger;
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export class WorktreeCollisionError extends WorktreeError {
  constructor(path: string) {
    super(
      `worktree path already exists and is not a registered git worktree: ${path}. ` +
        `Remove the stale directory (or pick a different worktree name) and retry.`
    );
    this.name = "WorktreeCollisionError";
  }
}

export function sanitizeWorktreeName(input: string): string {
  if (typeof input !== "string") {
    throw new WorktreeError("worktree name must be a string");
  }
  if (input.length === 0) {
    throw new WorktreeError("worktree name must not be empty");
  }
  if (input.length > 64) {
    throw new WorktreeError("worktree name must be ≤ 64 characters");
  }
  if (input === "." || input === "..") {
    throw new WorktreeError(`worktree name "${input}" is reserved`);
  }
  if (input.startsWith(".")) {
    throw new WorktreeError("worktree name must not start with '.'");
  }
  if (input.startsWith("-")) {
    throw new WorktreeError("worktree name must not start with '-'");
  }
  if (input.includes("..")) {
    throw new WorktreeError("worktree name must not contain '..'");
  }
  if (!NAME_PATTERN.test(input)) {
    throw new WorktreeError(
      `worktree name "${input}" contains disallowed characters ` +
        `(allowed: A-Z a-z 0-9 . _ -, length 1-64)`
    );
  }
  return input;
}

function generateDefaultName(): string {
  return randomUUID().replace(/-/g, "");
}

async function execGit(
  repoRoot: string,
  args: string[],
  logger: Logger
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveExec, rejectExec) => {
    const proc = spawn("git", args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // ignore — process may already be gone
      }
      rejectExec(new WorktreeError(`git ${args.join(" ")} timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    proc.stdout.on("data", chunk => stdoutChunks.push(chunk));
    proc.stderr.on("data", chunk => stderrChunks.push(chunk));
    proc.on("error", err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectExec(new WorktreeError(`git ${args.join(" ")} failed to spawn: ${err.message}`));
    });
    proc.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.debug?.(`git ${args.join(" ")} exited ${code}`);
      resolveExec({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        code: code ?? -1,
      });
    });
  });
}

async function listExistingWorktreePaths(repoRoot: string, logger: Logger): Promise<Set<string>> {
  const result = await execGit(repoRoot, ["worktree", "list", "--porcelain"], logger);
  if (result.code !== 0) {
    throw new WorktreeError(
      `git worktree list failed (code ${result.code}): ${result.stderr.trim()}`
    );
  }
  const paths = new Set<string>();
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      paths.add(line.slice("worktree ".length).trim());
    }
  }
  return paths;
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const logger = opts.logger ?? noopLogger;
  if (!opts.repoRoot || !existsSync(opts.repoRoot)) {
    throw new WorktreeError(`repoRoot does not exist: ${opts.repoRoot}`);
  }

  const name = opts.name ? sanitizeWorktreeName(opts.name) : generateDefaultName();
  const worktreesDir = join(opts.repoRoot, ".worktrees");
  const expectedPrefix = worktreesDir + sep;
  const worktreePath = resolvePath(opts.repoRoot, ".worktrees", name);

  // Defense in depth — sanitizeWorktreeName already blocks slashes, but
  // double-check that the resolved path is under <repoRoot>/.worktrees/.
  if (!worktreePath.startsWith(expectedPrefix)) {
    throw new WorktreeError(
      `resolved worktree path escapes the expected prefix: ${worktreePath} (expected under ${expectedPrefix})`
    );
  }

  const refArg = opts.ref ?? "HEAD";
  const revParse = await execGit(
    opts.repoRoot,
    ["rev-parse", "--verify", `${refArg}^{commit}`],
    logger
  );
  if (revParse.code !== 0) {
    throw new WorktreeError(
      `git rev-parse ${refArg} failed (code ${revParse.code}): ${revParse.stderr.trim()}`
    );
  }
  const resolvedRef = revParse.stdout.trim();

  const existingPaths = await listExistingWorktreePaths(opts.repoRoot, logger);
  const pathOnDisk = existsSync(worktreePath);
  const registered = existingPaths.has(worktreePath);

  if (pathOnDisk) {
    if (!registered) {
      throw new WorktreeCollisionError(worktreePath);
    }
    // Resume reuse: the worktree already exists and is registered with git.
    // Return a handle pointing at it without touching anything.
    logger.info?.(`reusing existing worktree at ${worktreePath}`);
    return {
      name,
      path: worktreePath,
      ref: resolvedRef,
      createdAt: new Date().toISOString(),
    };
  }
  if (registered) {
    // Path is registered but the directory is gone — let git prune it
    // before we recreate, so `worktree add` doesn't error on the stale
    // registration.
    const prune = await execGit(opts.repoRoot, ["worktree", "prune"], logger);
    if (prune.code !== 0) {
      logWarn(logger, `git worktree prune failed before creating ${name}: ${prune.stderr.trim()}`);
    }
  }

  const branch = `gateway/${name}`;
  const add = await execGit(
    opts.repoRoot,
    ["worktree", "add", "-b", branch, worktreePath, resolvedRef],
    logger
  );
  if (add.code !== 0) {
    throw new WorktreeError(
      `git worktree add failed (code ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`
    );
  }

  return {
    name,
    path: worktreePath,
    ref: resolvedRef,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Build a SessionCleanupHook that tears down per-session worktrees. The
 * hook reads `session.metadata.worktreePath` (recorded by
 * `resolveWorktreeForRequest`) and the optional `session.metadata.worktreeName`,
 * derives `repoRoot` from the path layout (`<repoRoot>/.worktrees/<name>`),
 * and fires `removeWorktree` asynchronously. Failures are logged by
 * `removeWorktree` itself — the hook always resolves so session deletion
 * never blocks on git.
 */
export function createWorktreeSessionCleanupHook(logger: Logger) {
  return async (session: { id: string; metadata?: Record<string, unknown> }): Promise<void> => {
    const meta = session.metadata ?? {};
    const worktreePath = typeof meta.worktreePath === "string" ? meta.worktreePath : undefined;
    if (!worktreePath) return;
    const worktreeName = typeof meta.worktreeName === "string" ? meta.worktreeName : undefined;
    // Layout invariant from createWorktree: <repoRoot>/.worktrees/<name>.
    // Strip the trailing two segments to recover repoRoot.
    const marker = `${sep}.worktrees${sep}`;
    const markerIdx = worktreePath.lastIndexOf(marker);
    if (markerIdx === -1) {
      logWarn(
        logger,
        `worktreePath on session ${session.id} does not match the gateway layout — skipping cleanup: ${worktreePath}`
      );
      return;
    }
    const repoRoot = worktreePath.slice(0, markerIdx);
    await removeWorktree({ repoRoot, path: worktreePath, name: worktreeName, logger });
  };
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  const logger = opts.logger ?? noopLogger;
  if (!opts.repoRoot || !opts.path) {
    return;
  }
  const remove = await execGit(opts.repoRoot, ["worktree", "remove", "--force", opts.path], logger);
  if (remove.code !== 0) {
    logWarn(
      logger,
      `git worktree remove --force ${opts.path} failed (code ${remove.code}): ${remove.stderr.trim()}`
    );
  }
  if (opts.name) {
    const branch = `gateway/${opts.name}`;
    const del = await execGit(opts.repoRoot, ["branch", "-D", branch], logger);
    if (del.code !== 0) {
      // Branch may already be gone (user deleted, never existed if add
      // half-failed, etc.). Demote to debug — this is best-effort cleanup.
      logger.debug?.(`git branch -D ${branch} returned code ${del.code}: ${del.stderr.trim()}`);
    }
  }
}
