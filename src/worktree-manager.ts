import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { existsSync, lstatSync, mkdirSync, realpathSync } from "fs";
import { basename, isAbsolute, join, relative, resolve as resolvePath, sep } from "path";
import { logWarn, noopLogger, type Logger } from "./logger.js";

const GIT_TIMEOUT_MS = 10_000;
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const worktreeRemovals = new Map<string, Promise<boolean>>();

const GIT_OPERATION_SAFETY_ARGS = [
  "-c",
  `core.hooksPath=${NULL_DEVICE}`,
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.sparseCheckout=false",
  "-c",
  "core.sparseCheckoutCone=false",
  "-c",
  "core.pager=cat",
  "-c",
  "color.ui=false",
  "-c",
  "extensions.worktreeConfig=false",
  "-c",
  "protocol.allow=never",
  "-c",
  "submodule.recurse=false",
] as const;

interface GitConfigOverride {
  key: string;
  value: string;
}

function gitOperationEnvironment(configOverrides: readonly GitConfigOverride[]): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_"))
  );
  const overrideEnvironment = Object.fromEntries(
    configOverrides.flatMap((override, index) => [
      [`GIT_CONFIG_KEY_${index}`, override.key],
      [`GIT_CONFIG_VALUE_${index}`, override.value],
    ])
  );
  return {
    ...inherited,
    ...overrideEnvironment,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: String(configOverrides.length),
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_EXTERNAL_DIFF: "",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

export interface WorktreeHandle {
  name: string;
  path: string;
  ref: string;
  createdAt: string;
  /** True only when this call created the worktree and branch. */
  created: boolean;
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

export interface ValidateManagedWorktreeOptions {
  repoRoot: string;
  path: string;
  name: string;
  logger?: Logger;
}

export interface WorktreeSessionCleanupOptions {
  /** Filesystem host allowed to remove the worktree. */
  expectedOwnerHostname?: string;
  /** Require both host and creating gateway instance provenance metadata. */
  requireOwnerMetadata?: boolean;
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export class WorktreeCollisionError extends WorktreeError {
  constructor(_path: string) {
    super(
      "worktree path or registration already exists. " +
        `Named worktrees are never reused by path. Resume through the caller-owned session that created it, or choose a different name.`
    );
    this.name = "WorktreeCollisionError";
  }
}

function isDirectPathChild(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromParent) &&
    !pathFromParent.includes(sep)
  );
}

function canonicalRepositoryRoot(repoRoot: string): string {
  if (!repoRoot || !existsSync(repoRoot)) {
    throw new WorktreeError(`repoRoot does not exist: ${repoRoot}`);
  }
  try {
    const canonicalRoot = realpathSync(repoRoot);
    const rootStat = lstatSync(canonicalRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new WorktreeError("repoRoot must be a real directory");
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError("Unable to resolve the repository root safely");
  }
}

/**
 * Return the canonical, gateway-owned worktree container. A symlinked
 * `.worktrees` directory would make `git worktree add` write outside its
 * selected repository before a later response-layer guard could reject it.
 */
function ensureManagedWorktreesRoot(canonicalRepoRoot: string, create = true): string {
  const expectedRoot = join(canonicalRepoRoot, ".worktrees");
  if (!existsSync(expectedRoot)) {
    if (!create) {
      throw new WorktreeError("Managed .worktrees directory is unavailable");
    }
    try {
      mkdirSync(expectedRoot, { mode: 0o700 });
    } catch {
      if (!existsSync(expectedRoot)) {
        throw new WorktreeError("Unable to create the managed .worktrees directory safely");
      }
    }
  }
  try {
    const rootStat = lstatSync(expectedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new WorktreeError("Managed .worktrees must be a real directory");
    }
    const canonicalRoot = realpathSync(expectedRoot);
    if (canonicalRoot !== expectedRoot) {
      throw new WorktreeError("Managed .worktrees must remain inside the repository");
    }
    return canonicalRoot;
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError("Unable to inspect the managed .worktrees directory safely");
  }
}

/**
 * Return the expected managed root for cleanup. A missing container is safe
 * when a prior worktree was removed out of band: Git still needs the original
 * direct-child path to discard its stale registration. An existing malformed
 * container remains unsafe and therefore fails closed.
 */
function managedWorktreesRootForCleanup(canonicalRepoRoot: string): string | null {
  const expectedRoot = join(canonicalRepoRoot, ".worktrees");
  try {
    const rootStat = lstatSync(expectedRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      return null;
    }
    return realpathSync(expectedRoot) === expectedRoot ? expectedRoot : null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return expectedRoot;
    }
    return null;
  }
}

/**
 * Validate a worktree path before invoking Git. Existing paths must be real
 * direct children of the managed container. A missing direct child is safe for
 * a new worktree creation or a best-effort cleanup of a stale registration.
 */
function validateManagedWorktreePath(
  canonicalWorktreesRoot: string,
  candidate: string
): { path: string; exists: boolean } {
  if (!isAbsolute(candidate)) {
    throw new WorktreeError("Managed worktree path must be absolute");
  }
  const resolvedPath = resolvePath(candidate);
  if (!isDirectPathChild(canonicalWorktreesRoot, resolvedPath)) {
    throw new WorktreeError("Managed worktree path must be a direct child of .worktrees");
  }
  if (!existsSync(resolvedPath)) return { path: resolvedPath, exists: false };

  try {
    const worktreeStat = lstatSync(resolvedPath);
    if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink()) {
      throw new WorktreeError("Managed worktree must be a real directory");
    }
    const canonicalPath = realpathSync(resolvedPath);
    if (!isDirectPathChild(canonicalWorktreesRoot, canonicalPath)) {
      throw new WorktreeError("Managed worktree must remain inside .worktrees");
    }
    return { path: canonicalPath, exists: true };
  } catch (error) {
    if (error instanceof WorktreeError) throw error;
    throw new WorktreeError("Unable to inspect the managed worktree safely");
  }
}

function managedWorktreeForCleanup(opts: RemoveWorktreeOptions): {
  repoRoot: string;
  path: string;
  exists: boolean;
  name?: string;
} | null {
  try {
    const canonicalRepoRoot = canonicalRepositoryRoot(opts.repoRoot);
    const worktreesRoot = managedWorktreesRootForCleanup(canonicalRepoRoot);
    if (!worktreesRoot) return null;
    const target = validateManagedWorktreePath(worktreesRoot, opts.path);
    const expectedName = basename(target.path);
    let name: string | undefined;
    if (opts.name !== undefined) {
      const sanitizedName = sanitizeWorktreeName(opts.name);
      if (sanitizedName !== expectedName) return null;
      name = sanitizedName;
    }
    return { repoRoot: canonicalRepoRoot, path: target.path, exists: target.exists, name };
  } catch {
    return null;
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
  logger: Logger,
  configOverrides: readonly GitConfigOverride[] = []
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveExec, rejectExec) => {
    const safeArgs = [...GIT_OPERATION_SAFETY_ARGS, "-c", `core.worktree=${repoRoot}`, ...args];
    const proc = spawn("git", safeArgs, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitOperationEnvironment(configOverrides),
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

/**
 * Build command-scoped overrides for every filter driver enabled by the selected
 * repository config. `git worktree add --no-checkout` establishes the worktree
 * without materializing files; these overrides then make the explicit checkout
 * copy bytes without starting repository-configured clean, smudge, or process
 * commands. Global and system config are excluded by execGit's environment.
 */
async function checkoutFilterSafetyOverrides(
  repoRoot: string,
  logger: Logger
): Promise<GitConfigOverride[]> {
  const configured = await execGit(
    repoRoot,
    [
      "config",
      "--includes",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    logger
  );
  if (configured.code !== 0 && configured.code !== 1) {
    throw new WorktreeError(
      `git config filter inspection failed (code ${configured.code}): ${configured.stderr.trim()}`
    );
  }

  const drivers = new Set<string>();
  const filterPrefix = "filter.";
  const filterSuffixes = [".clean", ".smudge", ".process", ".required"] as const;
  for (const key of configured.stdout.split("\0")) {
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.startsWith(filterPrefix)) continue;
    const suffix = filterSuffixes.find(candidate => normalizedKey.endsWith(candidate));
    if (!suffix) continue;
    const driver = key.slice(filterPrefix.length, -suffix.length);
    if (driver) drivers.add(driver);
  }

  return [...drivers].sort().flatMap(driver => [
    { key: `filter.${driver}.clean`, value: "" },
    { key: `filter.${driver}.smudge`, value: "" },
    { key: `filter.${driver}.process`, value: "" },
    { key: `filter.${driver}.required`, value: "false" },
  ]);
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
      paths.add(resolvePath(line.slice("worktree ".length).trim()));
    }
  }
  return paths;
}

interface RegisteredWorktree {
  path: string;
  branch?: string;
}

async function listRegisteredWorktrees(
  repoRoot: string,
  logger: Logger
): Promise<RegisteredWorktree[]> {
  const result = await execGit(repoRoot, ["worktree", "list", "--porcelain", "-z"], logger);
  if (result.code !== 0) {
    throw new WorktreeError(
      `git worktree list failed (code ${result.code}): ${result.stderr.trim()}`
    );
  }

  const registrations: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | undefined;
  for (const field of result.stdout.split("\0")) {
    if (field.length === 0) {
      if (current) registrations.push(current);
      current = undefined;
      continue;
    }
    if (field.startsWith("worktree ")) {
      if (current) registrations.push(current);
      current = { path: resolvePath(field.slice("worktree ".length)) };
      continue;
    }
    if (current && field.startsWith("branch ")) {
      current.branch = field.slice("branch ".length);
    }
  }
  if (current) registrations.push(current);
  return registrations;
}

async function canonicalGitCommonDirectory(
  repositoryPath: string,
  logger: Logger
): Promise<string | null> {
  const result = await execGit(repositoryPath, ["rev-parse", "--git-common-dir"], logger);
  if (result.code !== 0) return null;
  try {
    return realpathSync(resolvePath(repositoryPath, result.stdout.trim()));
  } catch {
    return null;
  }
}

/**
 * Verify durable session metadata against Git's live worktree registration.
 * A path layout alone is not ownership evidence: an out-of-band removal can
 * leave an attacker-controlled ordinary directory at the same location.
 */
export async function validateManagedWorktreeIdentity(
  opts: ValidateManagedWorktreeOptions
): Promise<boolean> {
  const logger = opts.logger ?? noopLogger;
  try {
    const repoRoot = canonicalRepositoryRoot(opts.repoRoot);
    const name = sanitizeWorktreeName(opts.name);
    const worktreesRoot = ensureManagedWorktreesRoot(repoRoot, false);
    const target = validateManagedWorktreePath(worktreesRoot, opts.path);
    if (!target.exists || basename(target.path) !== name) return false;

    const registrations = await listRegisteredWorktrees(repoRoot, logger);
    const matching = registrations.filter(registration => registration.path === target.path);
    if (matching.length !== 1 || matching[0]?.branch !== `refs/heads/gateway/${name}`) {
      return false;
    }

    const topLevel = await execGit(target.path, ["rev-parse", "--show-toplevel"], logger);
    if (topLevel.code !== 0 || realpathSync(topLevel.stdout.trim()) !== target.path) return false;

    const [repositoryCommonDirectory, targetCommonDirectory] = await Promise.all([
      canonicalGitCommonDirectory(repoRoot, logger),
      canonicalGitCommonDirectory(target.path, logger),
    ]);
    return (
      repositoryCommonDirectory !== null &&
      targetCommonDirectory !== null &&
      repositoryCommonDirectory === targetCommonDirectory
    );
  } catch {
    return false;
  }
}

export async function createWorktree(opts: CreateWorktreeOptions): Promise<WorktreeHandle> {
  const logger = opts.logger ?? noopLogger;
  const repoRoot = canonicalRepositoryRoot(opts.repoRoot);

  const name = opts.name ? sanitizeWorktreeName(opts.name) : generateDefaultName();
  const expectedWorktreesRoot = join(repoRoot, ".worktrees");
  const worktreePath = resolvePath(expectedWorktreesRoot, name);

  // Defense in depth: sanitizeWorktreeName already blocks slashes, but this
  // keeps the path rule structural instead of relying on a string prefix.
  if (!isDirectPathChild(expectedWorktreesRoot, worktreePath)) {
    throw new WorktreeError("Resolved worktree path escapes the managed .worktrees directory");
  }

  const refArg = opts.ref ?? "HEAD";
  const revParse = await execGit(repoRoot, ["rev-parse", "--verify", `${refArg}^{commit}`], logger);
  if (revParse.code !== 0) {
    throw new WorktreeError(
      `git rev-parse ${refArg} failed (code ${revParse.code}): ${revParse.stderr.trim()}`
    );
  }
  const resolvedRef = revParse.stdout.trim();

  // This must happen before `git worktree add`: Git follows a symlinked parent
  // directory, which would otherwise create a worktree outside the repository.
  const worktreesRoot = ensureManagedWorktreesRoot(repoRoot);
  const target = validateManagedWorktreePath(worktreesRoot, worktreePath);

  const existingPaths = await listExistingWorktreePaths(repoRoot, logger);
  const pathOnDisk = target.exists;
  const registered = existingPaths.has(target.path);

  // Manager-level path reuse has no caller/session ownership evidence and can
  // expose another session's stale ref or dirty state. Only
  // resolveWorktreeForRequest may reuse a worktree through caller-owned durable
  // session metadata. Every direct name/path or stale registration collision
  // therefore fails closed.
  if (pathOnDisk || registered) throw new WorktreeCollisionError(target.path);

  // Re-check both parent and target immediately before the mutating Git call.
  // A concurrent replacement is rejected rather than followed.
  const finalWorktreesRoot = ensureManagedWorktreesRoot(repoRoot);
  const finalTarget = validateManagedWorktreePath(finalWorktreesRoot, worktreePath);
  if (finalTarget.exists) {
    throw new WorktreeCollisionError(finalTarget.path);
  }

  const branch = `gateway/${name}`;
  const add = await execGit(
    repoRoot,
    ["worktree", "add", "--no-checkout", "-b", branch, finalTarget.path, resolvedRef],
    logger
  );
  if (add.code !== 0) {
    throw new WorktreeError(
      `git worktree add failed (code ${add.code}): ${add.stderr.trim() || add.stdout.trim()}`
    );
  }

  try {
    const filterSafetyOverrides = await checkoutFilterSafetyOverrides(finalTarget.path, logger);
    const checkout = await execGit(
      finalTarget.path,
      ["checkout", "--force", branch],
      logger,
      filterSafetyOverrides
    );
    if (checkout.code !== 0) {
      throw new WorktreeError(
        `git worktree checkout failed (code ${checkout.code}): ${checkout.stderr.trim() || checkout.stdout.trim()}`
      );
    }
  } catch (error) {
    await execGit(repoRoot, ["worktree", "remove", "--force", finalTarget.path], logger);
    await execGit(repoRoot, ["branch", "-D", branch], logger);
    throw error;
  }

  return {
    name,
    path: finalTarget.path,
    ref: resolvedRef,
    createdAt: new Date().toISOString(),
    created: true,
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
export function createWorktreeSessionCleanupHook(
  logger: Logger,
  options: WorktreeSessionCleanupOptions = {}
) {
  return async (session: { id: string; metadata?: Record<string, unknown> }): Promise<void> => {
    await cleanupSessionWorktree(session, logger, options);
  };
}

/** Remove the exact worktree authorized by durable session provenance. */
export async function cleanupSessionWorktree(
  session: { id: string; metadata?: Record<string, unknown> },
  logger: Logger,
  options: WorktreeSessionCleanupOptions = {}
): Promise<boolean> {
  const meta = session.metadata ?? {};
  const worktreePath = typeof meta.worktreePath === "string" ? meta.worktreePath : undefined;
  if (!worktreePath) return true;
  const ownerHostname =
    typeof meta.worktreeOwnerHostname === "string" ? meta.worktreeOwnerHostname : undefined;
  const ownerInstanceId =
    typeof meta.worktreeOwnerInstanceId === "string" ? meta.worktreeOwnerInstanceId : undefined;
  if (
    (options.expectedOwnerHostname !== undefined &&
      ownerHostname !== options.expectedOwnerHostname) ||
    (options.requireOwnerMetadata && (!ownerHostname || !ownerInstanceId))
  ) {
    logWarn(
      logger,
      `worktree on session ${session.id} is not owned by this host; skipping cleanup`
    );
    return false;
  }
  const worktreeName = typeof meta.worktreeName === "string" ? meta.worktreeName : undefined;
  // Layout invariant from createWorktree: <repoRoot>/.worktrees/<name>.
  // Strip the trailing two segments to recover repoRoot.
  const marker = `${sep}.worktrees${sep}`;
  const markerIdx = worktreePath.lastIndexOf(marker);
  if (markerIdx === -1) {
    logWarn(
      logger,
      `worktreePath on session ${session.id} does not match the gateway layout; skipping cleanup`
    );
    return false;
  }
  const repoRoot = worktreePath.slice(0, markerIdx);
  return removeWorktreeWithResult({
    repoRoot,
    path: worktreePath,
    name: worktreeName,
    logger,
  });
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  await removeWorktreeWithResult(opts);
}

/**
 * Remove a managed worktree and report whether no live gateway-owned worktree
 * remains at the path. Callers that must release durable ownership use this
 * result instead of treating best-effort logging as successful cleanup.
 */
export async function removeWorktreeWithResult(opts: RemoveWorktreeOptions): Promise<boolean> {
  const logger = opts.logger ?? noopLogger;
  if (!opts.repoRoot || !opts.path) {
    return false;
  }
  const managed = managedWorktreeForCleanup(opts);
  if (!managed) {
    logWarn(logger, "Skipping cleanup for a non-managed worktree path");
    return false;
  }
  if (
    managed.exists &&
    (!managed.name ||
      !(await validateManagedWorktreeIdentity({
        repoRoot: managed.repoRoot,
        path: managed.path,
        name: managed.name,
        logger,
      })))
  ) {
    logWarn(logger, "Skipping cleanup because the live path is not the expected Git worktree");
    return false;
  }
  const removalKey = `${managed.repoRoot}\0${managed.path}`;
  const existingRemoval = worktreeRemovals.get(removalKey);
  if (existingRemoval) return existingRemoval;

  const removal = (async (): Promise<boolean> => {
    let remove: Awaited<ReturnType<typeof execGit>>;
    try {
      remove = await execGit(
        managed.repoRoot,
        ["worktree", "remove", "--force", managed.path],
        logger
      );
    } catch (error) {
      logWarn(
        logger,
        `git worktree removal could not run: ${error instanceof Error ? error.message : String(error)}`
      );
      return false;
    }
    if (remove.code !== 0) {
      logWarn(
        logger,
        `git worktree remove --force failed (code ${remove.code}): ${remove.stderr.trim()}`
      );
      if (managed.exists && existsSync(managed.path)) return false;
    }
    if (managed.name) {
      const branch = `gateway/${managed.name}`;
      try {
        const del = await execGit(managed.repoRoot, ["branch", "-D", branch], logger);
        if (del.code !== 0) {
          // Branch may already be gone (user deleted, never existed if add
          // half-failed, etc.). Demote to debug because cleanup is best effort.
          logger.debug?.(`git branch -D ${branch} returned code ${del.code}: ${del.stderr.trim()}`);
        }
      } catch (error) {
        logWarn(
          logger,
          `git branch cleanup could not run: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return true;
  })();
  worktreeRemovals.set(removalKey, removal);
  try {
    return await removal;
  } finally {
    if (worktreeRemovals.get(removalKey) === removal) worktreeRemovals.delete(removalKey);
  }
}
