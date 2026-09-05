import { spawn } from "child_process";
import { randomUUID } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "fs";
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "path";
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
  /**
   * Per-CREATION identity, stamped into the worktree's Git admin directory and
   * mirrored into durable session metadata. See `GATEWAY_WORKTREE_MARKER`.
   */
  token: string;
  /**
   * The Git administrative directory git gave this worktree, mirrored into
   * durable session metadata alongside the token.
   *
   * It is recorded because it answers "was this worktree removed?" without
   * reading anything the checkout owns: `git worktree remove` deletes it and
   * `git worktree move` leaves it alone, so a deleted or unreadable marker, or
   * a checkout on storage that has gone away, cannot make a live worktree look
   * removed.
   */
  adminDirectory: string;
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
  /**
   * The caller has already established that nothing live carries this session's
   * creation identity, so a refused removal against an absent path is a removal
   * that already happened rather than a worktree hiding somewhere else.
   *
   * Defaults to false: a caller that cannot prove it keeps the record.
   */
  removalProven?: boolean;
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

/**
 * A managed worktree's on-disk identity is its path and its `gateway/<name>`
 * branch, and BOTH derive from the name. Two worktrees created at the same name
 * at different times are therefore indistinguishable, which is not a
 * theoretical problem: cleanup removes the worktree before it finalizes the
 * durable tombstone that authorized the removal, so a crash in that window
 * leaves a tombstone naming a path that a later session can legitimately
 * recreate. The retry then deletes the replacement, and the replacement's
 * session survives in the store pointing at a directory that is gone.
 *
 * This marker is what tells the two apart. It is written once per creation into
 * the worktree's Git ADMIN directory rather than into the checkout, because the
 * checkout belongs to the caller and an agent working there would commit it.
 *
 * It is NOT hidden from that agent, and must not be relied on as if it were.
 * The `.git` entry in a linked worktree is a FILE containing
 * `gitdir: <admin dir>` (git-worktree(1) DETAILS), so anything in the
 * administrative directory is reachable from inside the checkout by following
 * it. This is an accident-detector for the remove-then-acknowledge window, not
 * a control against a hostile process working in the worktree.
 */
const GATEWAY_WORKTREE_MARKER = "gateway-owner.json";

/**
 * The administrative directory git ACTUALLY gave this worktree, resolved from
 * the worktree itself.
 *
 * Not `<common>/worktrees/<name>`. git-worktree(1) DETAILS says the private
 * sub-directory's name is "usually the base name of the linked worktree's path,
 * possibly appended with a number to make it unique", and the same section says
 * outright: "do not make any assumption about whether a path belongs to
 * $GIT_DIR or $GIT_COMMON_DIR ... Use `git rev-parse --git-path` to get the
 * final path." Guessing by name is what that sentence forbids, and it is not
 * theoretical: a stale `worktrees/beta` entry left by a dead worktree elsewhere
 * makes a new `.worktrees/beta` get `worktrees/beta1`, so the guess reads and
 * writes ANOTHER worktree's directory.
 *
 * Three conditions, because `rev-parse` alone is a trap. An ordinary directory
 * that merely sits inside the repository resolves UPWARD and returns the main
 * repository's `.git` with exit 0, so a naive resolver would put the gateway's
 * marker inside `.git` itself. The result is accepted only when the path is its
 * own toplevel and the resolved directory is a direct child of
 * `<git common dir>/worktrees`.
 */
async function resolveWorktreeAdminDirectory(
  worktreePath: string,
  logger: Logger
): Promise<string | null> {
  if (!existsSync(worktreePath)) return null;
  const gitDir = await execGit(worktreePath, ["rev-parse", "--absolute-git-dir"], logger);
  if (gitDir.code !== 0) return null;
  const topLevel = await execGit(worktreePath, ["rev-parse", "--show-toplevel"], logger);
  if (topLevel.code !== 0) return null;
  const commonDirectory = await canonicalGitCommonDirectory(worktreePath, logger);
  if (!commonDirectory) return null;
  try {
    const resolved = realpathSync(gitDir.stdout.trim());
    if (realpathSync(topLevel.stdout.trim()) !== realpathSync(worktreePath)) return null;
    if (dirname(resolved) !== realpathSync(join(commonDirectory, "worktrees"))) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * The outcome of asking whether a session's worktree is still alive.
 *
 * Three cases, not two, and that is the whole point. An earlier version
 * answered `string | null` and every way of FAILING to look collapsed into the
 * same `null` the caller read as "nothing found, the removal happened". Both
 * halves of this module's history are that mistake: first a failed
 * `git worktree list`, then a failed per-worktree marker read one level in.
 * Making "could not tell" a value the caller has to destructure is what stops
 * it being spelled the same way as "proven gone".
 */
type WorktreeSearchResult =
  { kind: "live"; path: string } | { kind: "removed" } | { kind: "indeterminate"; reason: string };

/** One admin directory's marker, or why it could not be established. */
type MarkerReading =
  { kind: "token"; token: string } | { kind: "none" } | { kind: "unreadable"; reason: string };

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every linked worktree's administrative directory, read from the repository
 * rather than from the checkouts.
 *
 * This is deliberately not `git worktree list` plus a walk into each checkout.
 * That walk is what made cleanup fail open: a checkout on unavailable storage,
 * or one whose marker is unreadable, answered the same way as a worktree that
 * simply is not ours. The admin directories live under the repository's common
 * directory, so they are readable exactly when the repository is, and the
 * marker survives `git worktree move` untouched.
 *
 * An absent `worktrees` directory is a real answer, not a failure: git removes
 * it along with the last linked worktree.
 */
async function listWorktreeAdminDirectories(
  repoRoot: string,
  logger: Logger
): Promise<{ directories: string[] } | { failure: string }> {
  // `execGit` REJECTS when git cannot be spawned at all, and this function's
  // contract is to answer with a failure rather than to throw one past the
  // caller: an exception escaping here would leave `cleanupSessionWorktree` to
  // reject, which is a third spelling of the same "failure read as something
  // else" defect.
  let commonDirectory: string | null;
  try {
    commonDirectory = await canonicalGitCommonDirectory(repoRoot, logger);
  } catch (error) {
    return {
      failure: `git could not resolve the common directory of ${repoRoot}: ${describeError(error)}`,
    };
  }
  if (!commonDirectory) {
    return { failure: `git could not resolve the common directory of ${repoRoot}` };
  }
  const container = join(commonDirectory, "worktrees");
  try {
    return {
      directories: readdirSync(container, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => join(container, entry.name)),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { directories: [] };
    return { failure: `${container} could not be listed: ${describeError(error)}` };
  }
}

/**
 * Read one admin directory's owner marker.
 *
 * A missing marker file means this worktree carries no gateway identity, which
 * is a fact. Anything else -- a permission error, an I/O error, a marker that
 * does not parse -- is a failure to look, and is reported as such so that no
 * caller can mistake it for a worktree that is not ours.
 */
function readAdminMarker(adminDirectory: string): MarkerReading {
  let raw: string;
  try {
    raw = readFileSync(join(adminDirectory, GATEWAY_WORKTREE_MARKER), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "none" };
    return {
      kind: "unreadable",
      reason: `${adminDirectory} owner marker could not be read: ${describeError(error)}`,
    };
  }
  try {
    const token = (JSON.parse(raw) as { token?: unknown }).token;
    if (typeof token === "string" && token.length > 0) return { kind: "token", token };
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `${adminDirectory} owner marker does not parse: ${describeError(error)}`,
    };
  }
  // The gateway writes this file, so a present-but-tokenless marker is a
  // corruption of our own record and not evidence that the worktree is
  // someone else's.
  return { kind: "unreadable", reason: `${adminDirectory} owner marker carries no token` };
}

/**
 * The checkout an admin directory currently points at.
 *
 * git-worktree(1) DETAILS: the admin directory holds a `gitdir` file naming the
 * worktree's `.git` file, and `git worktree move` rewrites exactly that. Used
 * for the operator-facing message only; a failure to read it does not change
 * any decision.
 */
function checkoutForAdminDirectory(adminDirectory: string): string | null {
  try {
    const recorded = readFileSync(join(adminDirectory, "gitdir"), "utf8").trim();
    // RESOLVED against the administrative directory, because git does not
    // promise this path is absolute. `worktree.useRelativePaths=true` is a
    // supported setting and writes `../../../.worktrees/<name>/.git`, which
    // `existsSync` then resolves against the gateway's own working directory
    // and finds nothing. An ordinary `git worktree move` was enough to make a
    // live worktree read as removed and lose its durable record.
    return dirname(resolvePath(adminDirectory, recorded));
  } catch {
    return null;
  }
}

/**
 * Is the worktree this session created still alive, wherever git now keeps it?
 *
 * A recorded path going missing does NOT establish that the worktree was
 * removed. `git worktree move` relocates the checkout and rewrites the entry's
 * `gitdir`, leaving the session's recorded path stale while the worktree is
 * alive and registered somewhere else. Treating that absence as success let
 * cleanup report a removal that never happened, and the caller then finalized
 * the durable record, so the worktree leaked with nothing left pointing at it.
 *
 * Two pieces of identity, and the admin directory is the stronger one.
 * `git worktree remove` deletes the admin directory (builtin/worktree.c,
 * `delete_git_dir`) and `git worktree move` leaves it exactly where it was, so
 * its presence answers the question directly and without reading anything that
 * a move or an unavailable volume can take away. The token is what tells a
 * recycled admin directory -- git may hand the same name to a later worktree --
 * apart from ours, and is the only identity sessions created before the admin
 * directory was recorded have.
 */
async function locateLiveWorktree(
  repoRoot: string,
  identity: { token: string | null; adminDirectory: string | null; recordedPath: string },
  logger: Logger
): Promise<WorktreeSearchResult> {
  const listing = await listWorktreeAdminDirectories(repoRoot, logger);
  if ("failure" in listing) return { kind: "indeterminate", reason: listing.failure };

  if (identity.adminDirectory !== null) {
    const recorded = canonicalPath(identity.adminDirectory);
    const match = listing.directories.find(directory => canonicalPath(directory) === recorded);
    if (!match) return { kind: "removed" };
    // The directory is still registered. It is ours unless its marker proves it
    // now belongs to a different creation, in which case ours was removed and
    // git reused the name.
    const marker = readAdminMarker(match);
    if (identity.token !== null && marker.kind === "token" && marker.token !== identity.token) {
      return { kind: "removed" };
    }
    return liveOrPrunable(match, identity.recordedPath);
  }

  if (identity.token === null) {
    return { kind: "indeterminate", reason: "session carries no worktree identity" };
  }

  const unreadable: string[] = [];
  for (const directory of listing.directories) {
    const marker = readAdminMarker(directory);
    if (marker.kind === "token" && marker.token === identity.token) {
      return liveOrPrunable(directory, identity.recordedPath);
    }
    if (marker.kind === "unreadable") unreadable.push(marker.reason);
  }
  // Not finding the token among the worktrees we could read says nothing about
  // the ones we could not.
  if (unreadable.length > 0) {
    return { kind: "indeterminate", reason: unreadable.join("; ") };
  }
  return { kind: "removed" };
}

/**
 * A registered administrative directory is a LIVE worktree only while the
 * checkout it points at is still there.
 *
 * When it is not, the entry is the stale kind `git worktree prune` exists to
 * clear, and refusing on it would be worse than useless: a retry takes the same
 * path to the same answer, so the durable record would never be resolvable by
 * the retry it is retained for, only by hand. Removal handles that case, and
 * confirms the entry is gone before reporting success.
 *
 * The cost is stated rather than hidden: a checkout that is missing because its
 * volume is unavailable, or because it was renamed outside git, is
 * indistinguishable from one that was deleted. Git has no worktree either way,
 * and the gateway reports the removal of what git knew about, not of a
 * directory tree neither of them can name any more.
 */
function liveOrPrunable(adminDirectory: string, recordedPath: string): WorktreeSearchResult {
  const checkout = checkoutForAdminDirectory(adminDirectory);
  if (checkout === null) return { kind: "live", path: adminDirectory };
  if (existsSync(checkout)) return { kind: "live", path: checkout };
  // The checkout is not there. That is only a removal when the registration
  // still names the path this session recorded, because then the removal about
  // to run targets exactly that entry and git clears it.
  //
  // When the registration points SOMEWHERE ELSE and that is missing, the
  // worktree moved and then went away, and the two reasons are
  // indistinguishable: deleted, or on a volume that is not mounted right now.
  // An earlier version finalized here on the argument that a retry would reach
  // the same answer forever. That argument is wrong when the absence is
  // temporary: restoring the checkout after the record was finalized leaves a
  // directory tree that nothing will ever clean, while refusing costs only a
  // visible pending-cleanup row naming where the worktree was last seen.
  if (canonicalPath(checkout) === canonicalPath(recordedPath)) return { kind: "removed" };
  return {
    kind: "indeterminate",
    reason: `the worktree moved to ${checkout}, which is not there now`,
  };
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolvePath(path);
  }
}

/**
 * The token this worktree was created with, or null when there is none to read.
 *
 * Null covers four different situations on purpose, and every caller must treat
 * them alike because none of them is evidence of ownership: the path is gone,
 * the path is not a managed worktree, the worktree predates this marker, or the
 * marker is unreadable. Only a token that is PRESENT and EQUAL authorises
 * anything.
 */
export async function readWorktreeOwnerToken(
  worktreePath: string,
  logger: Logger
): Promise<string | null> {
  const admin = await resolveWorktreeAdminDirectory(worktreePath, logger);
  if (!admin) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(admin, GATEWAY_WORKTREE_MARKER), "utf8"));
    const token = (parsed as { token?: unknown }).token;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
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

  // After the checkout, so a failed creation is torn down above rather than
  // leaving a marker behind for a worktree that does not exist.
  const token = randomUUID();
  let adminDirectory: string;
  try {
    const admin = await resolveWorktreeAdminDirectory(finalTarget.path, logger);
    if (!admin) {
      throw new WorktreeError(
        "Git administrative directory for the new worktree could not be resolved; refusing to create a worktree with no owner marker"
      );
    }
    writeFileSync(join(admin, GATEWAY_WORKTREE_MARKER), JSON.stringify({ token }), {
      mode: 0o600,
    });
    // READ IT BACK. `writeFileSync` returns void, so nothing above establishes
    // that the marker exists and is readable; a call whose return value is
    // never read has not been exercised. A worktree whose identity cannot be
    // read back is worse than one with no identity, because cleanup would
    // refuse it forever.
    if ((await readWorktreeOwnerToken(finalTarget.path, logger)) !== token) {
      throw new WorktreeError(
        "Owner marker for the new worktree could not be read back; refusing to create an unidentifiable worktree"
      );
    }
    adminDirectory = admin;
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
    token,
    adminDirectory,
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

/**
 * For a session with NO creation identity, is the repository certainly not
 * still holding the worktree it is asking about?
 *
 * A pre-token session cannot name its worktree, so no observation can tie a
 * surviving registration to it OR rule one out: a marked worktree might still
 * be this session's, with the marker written after the session metadata was
 * last touched. The only claim that holds is the total one. If the repository
 * registers no managed worktree at all, there is nothing left that could be it.
 *
 * This is the honest form of the question the `gateway/<name>` branch was asked
 * in an earlier version. The branch is derived from the worktree name, which is
 * the ABA weakness the marker exists to close, and both review seats walked a
 * live worktree past it by renaming the branch.
 *
 * Deliberately conservative: any other live gateway worktree in the same
 * repository makes a pre-token session refuse. That population is transient,
 * and `adoptLegacyWorktreeIdentity` clears it by giving those sessions the
 * identity that lets the ordinary token search answer properly.
 */
async function noManagedWorktreeRemains(repoRoot: string, logger: Logger): Promise<boolean> {
  const listing = await listWorktreeAdminDirectories(repoRoot, logger);
  if ("failure" in listing) return false;
  const container = join(canonicalPath(repoRoot), ".worktrees");
  for (const directory of listing.directories) {
    const checkout = checkoutForAdminDirectory(directory);
    // A worktree the user made elsewhere in the repository is not ours and
    // cannot be the one this session created; an unreadable link could be.
    if (checkout === null) return false;
    if (isDirectPathChild(container, canonicalPath(checkout))) return false;
  }
  return true;
}

/**
 * Give a pre-token session the identity it was created without.
 *
 * Every session that exists when this ships is the pre-token shape, and a
 * session with no identity can prove nothing: cleanup has to refuse, which
 * leaves a durable record only an operator can resolve. Backfilling identity
 * removes that population rather than making the refusal cheaper to live with.
 *
 * Adoption is only sound because of a property that did not exist before this
 * release: `createWorktree` writes a marker and refuses to return a worktree
 * whose marker cannot be read back. An UNMARKED live worktree therefore cannot
 * be a replacement created after this ships, which is the object the ABA hazard
 * is about. Three further conditions, each closing a way the assertion could be
 * wrong:
 *
 * - The caller must have checked ownership; this is host-local state.
 * - The path must resolve as a registered managed worktree, so an ordinary
 *   directory left at the path by an out-of-band removal is not adopted.
 * - Exactly ONE session may claim the path. Two pre-token sessions naming one
 *   path is the ABA case itself, and it cannot be resolved by picking.
 *
 * A worktree that already carries a marker is left alone: some other creation
 * owns it, and stamping over that would destroy the evidence this whole
 * mechanism rests on.
 *
 * Tombstones are NOT adoptable and this must not be called for one. A deleted
 * session plus a live unmarked worktree is exactly the shape where the worktree
 * belongs to a replacement whose own row a pre-release foreign-host deletion
 * discarded, and adopting there would authorise deleting someone's working
 * tree.
 */
export async function adoptLegacyWorktreeIdentity(
  session: { id: string; metadata?: Record<string, unknown> },
  options: { claimantsForPath: number; logger?: Logger }
): Promise<{ token: string; adminDirectory: string } | null> {
  const logger = options.logger ?? noopLogger;
  const meta = session.metadata ?? {};
  const worktreePath = typeof meta.worktreePath === "string" ? meta.worktreePath : null;
  if (worktreePath === null) return null;
  if (typeof meta.worktreeToken === "string") return null;
  if (meta.worktreeCleanupPendingDeletion === true || meta.worktreeCleanupPending === true) {
    return null;
  }
  if (options.claimantsForPath !== 1) {
    logWarn(
      logger,
      `not adopting the worktree at ${worktreePath} for session ${session.id}: ${options.claimantsForPath} sessions claim it`
    );
    return null;
  }
  if (!existsSync(worktreePath)) return null;

  const adminDirectory = await resolveWorktreeAdminDirectory(worktreePath, logger);
  if (adminDirectory === null) return null;
  const marker = readAdminMarker(adminDirectory);
  if (marker.kind !== "none") return null;

  const token = randomUUID();
  try {
    writeFileSync(join(adminDirectory, GATEWAY_WORKTREE_MARKER), JSON.stringify({ token }), {
      mode: 0o600,
    });
    // Read back, for the same reason creation does: a marker that cannot be
    // read is worse than none, because cleanup would refuse it forever.
    if ((await readWorktreeOwnerToken(worktreePath, logger)) !== token) {
      throw new WorktreeError("owner marker could not be read back");
    }
  } catch (error) {
    logWarn(
      logger,
      `could not adopt the worktree at ${worktreePath} for session ${session.id}: ${describeError(error)}`
    );
    return null;
  }
  return { token, adminDirectory };
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
  const layoutMarker = `${sep}.worktrees${sep}`;
  const markerIdx = worktreePath.lastIndexOf(layoutMarker);
  if (markerIdx === -1) {
    logWarn(
      logger,
      `worktreePath on session ${session.id} does not match the gateway layout; skipping cleanup`
    );
    return false;
  }
  const repoRoot = worktreePath.slice(0, markerIdx);

  // `git worktree remove` deletes the administrative directory
  // (builtin/worktree.c, `delete_git_dir` calls `remove_dir_recursively` on
  // it), so a SUCCESSFUL removal always destroys the marker. Checking identity
  // against an absent path therefore reads the evidence of success as evidence
  // of a foreign worktree, and an earlier version did exactly that: after a
  // crash between the removal and the durable acknowledgement, the retry
  // refused forever and the tombstone became immortal.
  //
  // But an absent recorded path is not by itself evidence of removal either.
  // `git worktree move` leaves the recorded path stale while the worktree is
  // alive elsewhere, and reporting success there made the caller finalize the
  // durable record for a worktree that still exists. Absence only means the
  // removal happened once nothing live still carries this session's token.
  const recordedToken = typeof meta.worktreeToken === "string" ? meta.worktreeToken : null;
  const recordedAdminDirectory =
    typeof meta.worktreeAdminDirectory === "string" ? meta.worktreeAdminDirectory : null;
  // Set only by a SEARCH that came back empty over this session's own identity.
  // A session with no identity never sets it, and therefore never gets the
  // benefit of the doubt when git refuses a removal.
  let removalProven = false;
  if (!existsSync(worktreePath) && (recordedToken !== null || recordedAdminDirectory !== null)) {
    const located = await locateLiveWorktree(
      repoRoot,
      { token: recordedToken, adminDirectory: recordedAdminDirectory, recordedPath: worktreePath },
      logger
    );
    if (located.kind === "live") {
      logWarn(
        logger,
        `worktree for session ${session.id} is no longer at its recorded path but is still registered at ${located.path}; not reporting a removal that did not happen`
      );
      return false;
    }
    if (located.kind === "indeterminate") {
      logWarn(
        logger,
        `cannot establish whether the worktree for session ${session.id} still exists (${located.reason}); refusing to report a removal that has not been verified`
      );
      return false;
    }
    removalProven = true;
  }

  // A session with no identity gets one narrow, non-name-derived answer: if the
  // repository registers no managed worktree at all, this one is gone.
  if (
    !existsSync(worktreePath) &&
    recordedToken === null &&
    recordedAdminDirectory === null &&
    (await noManagedWorktreeRemains(repoRoot, logger))
  ) {
    removalProven = true;
  }

  if (existsSync(worktreePath)) {
    const recorded = recordedToken;
    const onDisk = await readWorktreeOwnerToken(worktreePath, logger);

    // A session recorded before creation tokens existed cannot prove it owns
    // the live worktree at its path, so it removes nothing.
    //
    // Treating "no token on either side" as a match was the obvious
    // compatibility rule and it reopened the exact defect the token exists to
    // close: a reviewer deleted a live replacement with a stale legacy record,
    // because `null === null`. On a DESTRUCTIVE operation an unprovable claim
    // has to fail closed. The cost is bounded and visible: the worktree stays
    // on disk and the durable record is retained, so the session still appears
    // in the pending-cleanup listing for an operator to resolve by hand. The
    // cost of the alternative is someone else's working tree.
    if (recorded === null) {
      logWarn(
        logger,
        `worktree on session ${session.id} predates gateway creation tokens; refusing to remove a worktree this session cannot prove it created. Remove ${worktreePath} manually if it is stale.`
      );
      return false;
    }
    if (recorded !== onDisk) {
      logWarn(
        logger,
        `worktree on session ${session.id} no longer carries this session's creation token; skipping cleanup`
      );
      return false;
    }
  }

  return removeWorktreeWithResult({
    repoRoot,
    path: worktreePath,
    name: worktreeName,
    logger,
    removalProven,
  });
}

export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
  await removeWorktreeWithResult(opts);
}

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
  // Coalesce concurrent cleanup claims for the same managed worktree BEFORE any
  // git-mutating or git-reading work. `managedWorktreeForCleanup` is synchronous,
  // so this get/create/set runs in a single synchronous turn with no await
  // between the get and the set: the first claim registers the removal promise
  // and every
  // concurrent claim awaits that same promise as a silent no-op. The identity
  // validation lives inside the removal promise (below) so exactly one claim
  // performs it. Previously validation ran here, before the dedup check, so a
  // losing claim could validate a path the winning claim was concurrently
  // removing and emit a spurious "not the expected Git worktree" warning.
  const removalKey = `${managed.repoRoot}\0${managed.path}`;
  const existingRemoval = worktreeRemovals.get(removalKey);
  if (existingRemoval) return existingRemoval;

  const removal = (async (): Promise<boolean> => {
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
      // git refused and the recorded path is absent. That is what an ALREADY
      // COMPLETED removal looks like from a retry, and also what a worktree
      // that MOVED AWAY looks like, and nothing observable here separates them.
      //
      // Only the caller knows. `cleanupSessionWorktree` establishes identity
      // before it gets here: when it says the removal is proven, it has already
      // searched every administrative directory for this session's creation
      // token and found none, which is what a completed removal leaves behind.
      // A session with no identity to search by has proven nothing, and an
      // earlier version guessed on its behalf from the `gateway/<name>` branch.
      // That is the ABA weakness the creation token exists to close, and both
      // review seats walked a live worktree through it by renaming the branch.
      if (!opts.removalProven) {
        logWarn(
          logger,
          `git refused to remove ${managed.path} and this session cannot prove the worktree is gone; retaining it`
        );
        return false;
      }
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
