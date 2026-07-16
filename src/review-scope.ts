import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
} from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { isAuthorizedReviewRepositoryRoot } from "./review-run-authorization.js";

export const DEFAULT_REVIEW_ARTIFACT_MAX_BYTES = 120_000;
export const MAX_REVIEW_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const REVIEW_EVIDENCE_SCHEMA_VERSION = "review-evidence.v2" as const;

const GIT_OUTPUT_HARD_LIMIT_BYTES = MAX_REVIEW_ARTIFACT_BYTES + 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

interface GitConfigOverride {
  key: string;
  value: string;
}

function gitSafetyArguments(repositoryRoot: string): string[] {
  return [
    "-c",
    "core.pager=cat",
    "-c",
    "color.ui=false",
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${NULL_DEVICE}`,
    "-c",
    `core.worktree=${repositoryRoot}`,
    "-c",
    "protocol.allow=never",
    "-c",
    "submodule.recurse=false",
  ];
}

export type ReviewScopeMode = "auto" | "uncommitted" | "branch" | "commit";

export type ReviewScopeErrorCode =
  | "invalid_input"
  | "not_a_git_repository"
  | "git_failed"
  | "git_output_too_large"
  | "base_not_found"
  | "head_not_found"
  | "default_branch_not_found"
  | "unsafe_untracked_type"
  | "unsupported_git_path_encoding"
  | "snapshot_changed"
  | "artifact_too_large";

export class ReviewScopeError extends Error {
  constructor(
    readonly code: ReviewScopeErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = "ReviewScopeError";
  }
}

export interface ReviewScopeRequest {
  /** Existing Git worktree directory to review. */
  repositoryPath: string;
  /** Scope selection. Auto is the default. */
  mode?: ReviewScopeMode;
  /** Explicit base commit/ref. It overrides automatic base selection. */
  base?: string;
  /** Optional literal, repository-relative path filters. */
  paths?: readonly string[];
  /** Exact UTF-8 byte ceiling for the serialized evidence artifact. */
  maxArtifactBytes?: number;
}

/** Test and embedding seams. */
export interface ReviewScopeHooks {
  /** Forces a mutation before the final race check. */
  beforeSnapshotRecheck?: () => void;
  /** Observes the arguments of every Git process this capture spawns. */
  onGitCommand?: (args: readonly string[]) => void;
}

export interface ReviewWorkingTreeState {
  hasStagedChanges: boolean;
  hasUnstagedChanges: boolean;
  hasUntrackedChanges: boolean;
  untrackedCount: number;
  statusSha256: string;
}

export interface ReviewEvidenceFile {
  path: string;
  source: "tracked" | "untracked";
}

export interface ReviewEncodedContent {
  encoding: "utf8" | "base64";
  byteLength: number;
  sha256: string;
  content: string;
}

export interface ReviewPatchEvidence extends ReviewEncodedContent {
  /** Sorted literal repository-relative paths represented by this exact patch. */
  paths: string[];
}

export interface ReviewUntrackedEvidence extends ReviewEncodedContent {
  path: string;
  mode: number;
  /**
   * Present only for an untracked symlink, whose `content` is the raw link
   * target rather than any file body. Regular-file evidence omits the field, so
   * every artifact this schema could already produce keeps its exact shape.
   */
  entryType?: "symlink";
}

export interface ReviewArtifactPayload {
  schemaVersion: typeof REVIEW_EVIDENCE_SCHEMA_VERSION;
  scope: {
    requestedMode: ReviewScopeMode;
    resolvedMode: Exclude<ReviewScopeMode, "auto">;
    baseRef: string | null;
    baseSha: string;
    baseTipSha: string | null;
    headSha: string | null;
    mergeBaseSha: string | null;
    workingTreeIncluded: boolean;
    hasCommittedChanges: boolean;
    paths: string[];
  };
  workingTree: ReviewWorkingTreeState;
  files: ReviewEvidenceFile[];
  /** Committed change from the resolved base to HEAD. */
  committedPatch: ReviewPatchEvidence;
  /** Staged change from HEAD (or the empty tree for an unborn branch) to the index. */
  stagedPatch: ReviewPatchEvidence;
  /** Unstaged tracked change from the index to the worktree. */
  unstagedPatch: ReviewPatchEvidence;
  untrackedFiles: ReviewUntrackedEvidence[];
}

export interface ReviewArtifact {
  content: string;
  byteLength: number;
  sha256: string;
  complete: true;
}

export interface ResolvedReviewScope {
  schemaVersion: typeof REVIEW_EVIDENCE_SCHEMA_VERSION;
  repositoryRoot: string;
  requestedMode: ReviewScopeMode;
  resolvedMode: Exclude<ReviewScopeMode, "auto">;
  baseRef: string | null;
  baseSha: string;
  baseTipSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  workingTreeIncluded: boolean;
  hasCommittedChanges: boolean;
  workingTree: ReviewWorkingTreeState;
  files: ReviewEvidenceFile[];
  artifact: ReviewArtifact;
}

interface ScopePlan {
  requestedMode: ReviewScopeMode;
  resolvedMode: Exclude<ReviewScopeMode, "auto">;
  baseRef: string | null;
  baseSha: string;
  baseTipSha: string | null;
  headSha: string | null;
  mergeBaseSha: string | null;
  workingTreeIncluded: boolean;
}

interface GitExecutionOptions {
  allowExitCodes?: readonly number[];
  input?: Buffer;
  /** Overrides the context environment. Defaults to the literal-pathspec one. */
  env?: NodeJS.ProcessEnv;
}

interface CapturedUntrackedFile {
  evidence: ReviewUntrackedEvidence;
  fingerprint: string;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareDeterministicStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateByteLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_REVIEW_ARTIFACT_BYTES) {
    throw new ReviewScopeError(
      "invalid_input",
      `maxArtifactBytes must be a positive safe integer no greater than ${MAX_REVIEW_ARTIFACT_BYTES}`
    );
  }
  return value;
}

function validateMode(value: ReviewScopeMode): ReviewScopeMode {
  if (!["auto", "uncommitted", "branch", "commit"].includes(value)) {
    throw new ReviewScopeError("invalid_input", "Unsupported review scope mode");
  }
  return value;
}

function validateRef(ref: string, field: string): string {
  if (!ref || ref.startsWith("-") || ref.includes("\0") || /[\r\n]/.test(ref)) {
    throw new ReviewScopeError(
      "invalid_input",
      `${field} must be a non-empty Git ref that does not start with '-' or contain control separators`
    );
  }
  return ref;
}

function validateLiteralPaths(paths: readonly string[] | undefined): string[] {
  const unique = new Set<string>();
  let includesRepositoryRoot = false;
  for (const candidate of paths ?? []) {
    if (
      !candidate ||
      candidate.includes("\0") ||
      path.isAbsolute(candidate) ||
      candidate.split(/[\\/]/).includes("..")
    ) {
      throw new ReviewScopeError(
        "invalid_input",
        "Review paths must be non-empty literal paths relative to the repository"
      );
    }
    const platformNormalized =
      process.platform === "win32" ? candidate.replaceAll("\\", "/") : candidate;
    const normalized = path.posix.normalize(platformNormalized);
    if (normalized === ".") {
      includesRepositoryRoot = true;
      continue;
    }
    unique.add(normalized);
  }
  if (includesRepositoryRoot) return [];
  return [...unique].sort(compareDeterministicStrings);
}

function gitEnvironment(configOverrides: readonly GitConfigOverride[]): NodeJS.ProcessEnv {
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
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NULL_DEVICE,
    GIT_CONFIG_SYSTEM: NULL_DEVICE,
    GIT_EXTERNAL_DIFF: "",
    GIT_LITERAL_PATHSPECS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    GIT_PROTOCOL_FROM_USER: "0",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
  };
}

function throwGitSpawnError(error: Error, context: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOBUFS") {
    throw new ReviewScopeError(
      "git_output_too_large",
      "Git evidence exceeded the hard capture ceiling"
    );
  }
  throw new ReviewScopeError("git_failed", context, { code: code ?? "unknown" });
}

/**
 * Discover every filter driver from repository-local config without running a
 * worktree command. The returned command-scope overrides disable clean,
 * smudge, and long-running process filters. Global, system, and inherited Git
 * config are excluded from both this inspection and the evidence command.
 */
function reviewFilterSafetyOverrides(
  repositoryRoot: string,
  onGitCommand?: (args: readonly string[]) => void
): GitConfigOverride[] {
  onGitCommand?.(["config"]);
  const result = spawnSync(
    "git",
    [
      ...gitSafetyArguments(repositoryRoot),
      "config",
      "--includes",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ],
    {
      cwd: repositoryRoot,
      env: gitEnvironment([]),
      encoding: null,
      maxBuffer: GIT_OUTPUT_HARD_LIMIT_BYTES,
      shell: false,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }
  );
  if (result.error) {
    throwGitSpawnError(result.error, "Git filter configuration could not be inspected");
  }
  if (result.status !== 0 && result.status !== 1) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim().slice(0, 500)
      : "";
    throw new ReviewScopeError("git_failed", "Git filter configuration inspection failed", {
      status: result.status ?? -1,
      stderr,
    });
  }

  const drivers = new Set<string>();
  const filterPrefix = "filter.";
  const filterSuffixes = [".clean", ".smudge", ".process", ".required"] as const;
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
  for (const key of splitNul(stdout, "Git filter configuration key")) {
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.startsWith(filterPrefix)) continue;
    const suffix = filterSuffixes.find(candidate => normalizedKey.endsWith(candidate));
    if (!suffix) continue;
    const driver = key.slice(filterPrefix.length, -suffix.length);
    if (driver) drivers.add(driver);
  }

  return [...drivers].sort(compareDeterministicStrings).flatMap(driver => [
    { key: `filter.${driver}.clean`, value: "" },
    { key: `filter.${driver}.smudge`, value: "" },
    { key: `filter.${driver}.process`, value: "" },
    { key: `filter.${driver}.required`, value: "false" },
  ]);
}

function filterOverrideSignature(overrides: readonly GitConfigOverride[]): string {
  return sha256(JSON.stringify(overrides));
}

/**
 * One Git execution context pinned to a single worktree directory. The filter
 * safety overrides are discovered exactly once when the context is built and
 * are then reused verbatim by every command issued through it, so a capture
 * costs one configuration probe rather than one probe per Git invocation.
 * `resolveReviewScope` re-verifies the discovered driver set before it returns
 * and fails closed when repository-local filter configuration changed while the
 * evidence was being captured.
 */
interface GitContext {
  /** Directory used as the Git command cwd and as the pinned core.worktree. */
  directory: string;
  /** Command-scope safety arguments derived once for this directory. */
  safetyArguments: readonly string[];
  /** Environment whose filter overrides were discovered once for this directory. */
  env: NodeJS.ProcessEnv;
  /**
   * Same environment without GIT_LITERAL_PATHSPECS, for the one command that
   * rejects literal pathspec magic outright. See `ignoredPathSubset`.
   */
  pathnameEnv: NodeJS.ProcessEnv;
  /** Digest of the discovered filter drivers, re-verified before the scope returns. */
  filterSignature: string;
  /** Test seam forwarded from ReviewScopeHooks. */
  onGitCommand?: ((args: readonly string[]) => void) | undefined;
}

function createGitContext(
  directory: string,
  onGitCommand?: (args: readonly string[]) => void
): GitContext {
  const overrides = reviewFilterSafetyOverrides(directory, onGitCommand);
  const env = gitEnvironment(overrides);
  const pathnameEnv = { ...env };
  delete pathnameEnv.GIT_LITERAL_PATHSPECS;
  return {
    directory,
    safetyArguments: gitSafetyArguments(directory),
    env,
    pathnameEnv,
    filterSignature: filterOverrideSignature(overrides),
    onGitCommand,
  };
}

function runGit(
  context: GitContext,
  args: readonly string[],
  options: GitExecutionOptions = {}
): Buffer {
  context.onGitCommand?.(args);
  const result = spawnSync("git", [...context.safetyArguments, ...args], {
    cwd: context.directory,
    env: options.env ?? context.env,
    encoding: null,
    input: options.input,
    maxBuffer: GIT_OUTPUT_HARD_LIMIT_BYTES,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throwGitSpawnError(result.error, "Git evidence command could not be executed");
  }
  const status = result.status ?? 1;
  const allowed = options.allowExitCodes ?? [0];
  if (!allowed.includes(status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim().slice(0, 500)
      : "";
    throw new ReviewScopeError("git_failed", "Git evidence command failed", {
      status,
      stderr,
    });
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
}

function runGitMaybe(context: GitContext, args: readonly string[]): Buffer | null {
  context.onGitCommand?.(args);
  const result = spawnSync("git", [...context.safetyArguments, ...args], {
    cwd: context.directory,
    env: context.env,
    encoding: null,
    maxBuffer: GIT_OUTPUT_HARD_LIMIT_BYTES,
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
  });
  if (result.error) {
    throw new ReviewScopeError("git_failed", "Git ref lookup could not be executed", {
      code: (result.error as NodeJS.ErrnoException).code ?? "unknown",
    });
  }
  if (result.status !== 0) return null;
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0);
}

function decodeUtf8Exact(value: Buffer, context: string): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw new ReviewScopeError(
      "unsupported_git_path_encoding",
      `${context} is not valid UTF-8 and cannot be represented safely`
    );
  }
  return decoded;
}

function splitNul(value: Buffer, context: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== 0) continue;
    if (index > start) parts.push(decodeUtf8Exact(value.subarray(start, index), context));
    start = index + 1;
  }
  if (start < value.length) parts.push(decodeUtf8Exact(value.subarray(start), context));
  return parts;
}

function trimAscii(value: Buffer): string {
  return value.toString("utf8").trim();
}

function resolveRepositoryPath(repositoryPath: string): string {
  if (!repositoryPath || repositoryPath.includes("\0")) {
    throw new ReviewScopeError("invalid_input", "repositoryPath must be non-empty");
  }
  try {
    const candidate = realpathSync(repositoryPath);
    if (!statSync(candidate).isDirectory()) throw new Error("not a directory");
    return candidate;
  } catch {
    throw new ReviewScopeError("not_a_git_repository", "Review repository path is unavailable");
  }
}

function resolveRepositoryRoot(
  repositoryPath: string,
  onGitCommand?: (args: readonly string[]) => void
): string {
  const root = runGitMaybe(createGitContext(repositoryPath, onGitCommand), [
    "rev-parse",
    "--show-toplevel",
  ]);
  if (!root) {
    throw new ReviewScopeError("not_a_git_repository", "Review target is not a Git worktree");
  }
  try {
    return realpathSync(trimAscii(root));
  } catch {
    throw new ReviewScopeError("not_a_git_repository", "Git worktree root is unavailable");
  }
}

/**
 * Promote an explicitly selected local directory to its canonical Git
 * worktree root before review admission. Local stdio callers are authorized to
 * select an absolute filesystem path directly, so a nested directory selects
 * the complete containing Git worktree. Registered and remote workspace
 * selectors must retain their stricter containment boundary and must not use
 * this helper.
 */
export function resolveLocalReviewRepositoryRoot(repositoryPath: string): string {
  return resolveRepositoryRoot(resolveRepositoryPath(repositoryPath));
}

function resolveCommit(context: GitContext, ref: string): string | null {
  const output = runGitMaybe(context, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  return output ? trimAscii(output) : null;
}

function emptyTreeSha(context: GitContext): string {
  return trimAscii(
    runGit(context, ["hash-object", "-t", "tree", "--stdin"], {
      input: Buffer.alloc(0),
    })
  );
}

function resolveDefaultBaseRef(context: GitContext): { ref: string; sha: string } | null {
  const symbolic = runGitMaybe(context, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  const candidates = [
    symbolic ? trimAscii(symbolic) : null,
    "refs/heads/main",
    "refs/remotes/origin/main",
    "refs/heads/master",
    "refs/remotes/origin/master",
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const sha = resolveCommit(context, candidate);
    if (sha) return { ref: candidate, sha };
  }
  return null;
}

function mergeBase(context: GitContext, left: string, right: string): string {
  const output = runGitMaybe(context, ["merge-base", left, right]);
  if (!output) {
    throw new ReviewScopeError("base_not_found", "Base and head have no merge base", {
      left,
      right,
    });
  }
  return trimAscii(output);
}

function statusBuffer(context: GitContext, paths: readonly string[]): Buffer {
  return runGit(context, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    ...(paths.length > 0 ? ["--", ...paths] : []),
  ]);
}

function summarizeStatus(value: Buffer): ReviewWorkingTreeState {
  let hasStagedChanges = false;
  let hasUnstagedChanges = false;
  let untrackedCount = 0;
  for (const record of splitNul(value, "Git status path")) {
    if (record.startsWith("? ")) {
      untrackedCount++;
      continue;
    }
    if (!record.startsWith("1 ") && !record.startsWith("2 ") && !record.startsWith("u ")) {
      continue;
    }
    const xy = record.split(" ", 3)[1] ?? "..";
    if (xy[0] && xy[0] !== ".") hasStagedChanges = true;
    if (xy[1] && xy[1] !== ".") hasUnstagedChanges = true;
  }
  return {
    hasStagedChanges,
    hasUnstagedChanges,
    hasUntrackedChanges: untrackedCount > 0,
    untrackedCount,
    statusSha256: sha256(value),
  };
}

function hasDirtyState(state: ReviewWorkingTreeState): boolean {
  return state.hasStagedChanges || state.hasUnstagedChanges || state.hasUntrackedChanges;
}

function buildScopePlan(
  context: GitContext,
  requestedMode: ReviewScopeMode,
  requestedBase: string | undefined,
  state: ReviewWorkingTreeState
): ScopePlan {
  const headSha = resolveCommit(context, "HEAD");
  const emptyTree = emptyTreeSha(context);
  const explicitBase = requestedBase ? validateRef(requestedBase, "base") : null;
  const explicitBaseSha = explicitBase ? resolveCommit(context, explicitBase) : null;
  if (explicitBase && !explicitBaseSha) {
    throw new ReviewScopeError("base_not_found", `Review base ref was not found: ${explicitBase}`);
  }

  if (requestedMode === "commit") {
    if (!headSha) {
      throw new ReviewScopeError(
        "head_not_found",
        "Commit review requires an existing HEAD commit"
      );
    }
    const parentSha = resolveCommit(context, "HEAD^") ?? emptyTree;
    return {
      requestedMode,
      resolvedMode: "commit",
      baseRef: explicitBase,
      baseSha: explicitBaseSha ?? parentSha,
      baseTipSha: explicitBaseSha,
      headSha,
      mergeBaseSha: explicitBaseSha ? mergeBase(context, explicitBaseSha, headSha) : null,
      workingTreeIncluded: false,
    };
  }

  if (requestedMode === "uncommitted") {
    return {
      requestedMode,
      resolvedMode: "uncommitted",
      baseRef: explicitBase,
      baseSha: explicitBaseSha ?? headSha ?? emptyTree,
      baseTipSha: explicitBaseSha,
      headSha,
      mergeBaseSha:
        explicitBaseSha && headSha ? mergeBase(context, explicitBaseSha, headSha) : null,
      workingTreeIncluded: true,
    };
  }

  if (requestedMode === "branch" || explicitBaseSha) {
    if (!headSha) {
      throw new ReviewScopeError(
        "head_not_found",
        "Branch review requires an existing HEAD commit"
      );
    }
    const selected = explicitBaseSha
      ? { ref: explicitBase!, sha: explicitBaseSha }
      : resolveDefaultBaseRef(context);
    if (!selected) {
      throw new ReviewScopeError(
        "default_branch_not_found",
        "Branch review could not resolve a local default branch ref; pass base explicitly"
      );
    }
    const common = mergeBase(context, selected.sha, headSha);
    return {
      requestedMode,
      resolvedMode: "branch",
      baseRef: selected.ref,
      baseSha: common,
      baseTipSha: selected.sha,
      headSha,
      mergeBaseSha: common,
      workingTreeIncluded: true,
    };
  }

  if (!headSha) {
    return {
      requestedMode,
      resolvedMode: "uncommitted",
      baseRef: null,
      baseSha: emptyTree,
      baseTipSha: null,
      headSha: null,
      mergeBaseSha: null,
      workingTreeIncluded: true,
    };
  }

  const defaultBase = resolveDefaultBaseRef(context);
  if (defaultBase) {
    const common = mergeBase(context, defaultBase.sha, headSha);
    if (common !== headSha) {
      return {
        requestedMode,
        resolvedMode: "branch",
        baseRef: defaultBase.ref,
        baseSha: common,
        baseTipSha: defaultBase.sha,
        headSha,
        mergeBaseSha: common,
        workingTreeIncluded: true,
      };
    }
  }

  if (hasDirtyState(state)) {
    return {
      requestedMode,
      resolvedMode: "uncommitted",
      baseRef: null,
      baseSha: headSha,
      baseTipSha: null,
      headSha,
      mergeBaseSha: null,
      workingTreeIncluded: true,
    };
  }

  return {
    requestedMode,
    resolvedMode: "commit",
    baseRef: null,
    baseSha: resolveCommit(context, "HEAD^") ?? emptyTree,
    baseTipSha: null,
    headSha,
    mergeBaseSha: null,
    workingTreeIncluded: false,
  };
}

function fixedDiffOptions(namesOnly: boolean): string[] {
  return [
    "--no-ext-diff",
    "--no-textconv",
    // A repository-controlled .gitattributes may mark source as `-diff` and
    // otherwise collapse readable changes to "Binary files differ". Review
    // evidence must override that self-concealing classification.
    "--text",
    "--binary",
    "--full-index",
    "--find-renames",
    ...(namesOnly ? ["--name-only", "-z"] : []),
  ];
}

function appendDiffPaths(args: string[], paths: readonly string[]): string[] {
  if (paths.length > 0) args.push("--", ...paths);
  return args;
}

function committedDiffArgs(
  from: string,
  to: string,
  paths: readonly string[],
  namesOnly: boolean
): string[] {
  return appendDiffPaths(["diff", ...fixedDiffOptions(namesOnly), from, to], paths);
}

function stagedDiffArgs(from: string, paths: readonly string[], namesOnly: boolean): string[] {
  return appendDiffPaths(["diff", ...fixedDiffOptions(namesOnly), "--cached", from], paths);
}

function unstagedDiffArgs(paths: readonly string[], namesOnly: boolean): string[] {
  const args = ["diff", ...fixedDiffOptions(namesOnly)];
  return appendDiffPaths(args, paths);
}

function captureCommittedPatch(
  context: GitContext,
  plan: ScopePlan,
  paths: readonly string[]
): Buffer {
  if (!plan.headSha || plan.baseSha === plan.headSha) return Buffer.alloc(0);
  return runGit(context, committedDiffArgs(plan.baseSha, plan.headSha, paths, false));
}

function captureStagedPatch(
  context: GitContext,
  plan: ScopePlan,
  paths: readonly string[]
): Buffer {
  if (!plan.workingTreeIncluded) return Buffer.alloc(0);
  return runGit(context, stagedDiffArgs(plan.headSha ?? plan.baseSha, paths, false));
}

function captureUnstagedPatch(
  context: GitContext,
  plan: ScopePlan,
  paths: readonly string[]
): Buffer {
  if (!plan.workingTreeIncluded) return Buffer.alloc(0);
  return runGit(context, unstagedDiffArgs(paths, false));
}

function captureCommittedPaths(
  context: GitContext,
  from: string,
  to: string,
  paths: readonly string[]
): string[] {
  return splitNul(runGit(context, committedDiffArgs(from, to, paths, true)), "Git diff path").sort(
    compareDeterministicStrings
  );
}

function captureStagedPaths(context: GitContext, from: string, paths: readonly string[]): string[] {
  return splitNul(runGit(context, stagedDiffArgs(from, paths, true)), "Git staged diff path").sort(
    compareDeterministicStrings
  );
}

function captureUnstagedPaths(context: GitContext, paths: readonly string[]): string[] {
  return splitNul(runGit(context, unstagedDiffArgs(paths, true)), "Git unstaged diff path").sort(
    compareDeterministicStrings
  );
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function encodeContent(value: Buffer): ReviewEncodedContent {
  const decoded = value.toString("utf8");
  const utf8Exact = Buffer.from(decoded, "utf8").equals(value);
  return {
    encoding: utf8Exact ? "utf8" : "base64",
    byteLength: value.length,
    sha256: sha256(value),
    content: utf8Exact ? decoded : value.toString("base64"),
  };
}

function encodePatch(value: Buffer, paths: readonly string[]): ReviewPatchEvidence {
  return {
    paths: [...paths],
    ...encodeContent(value),
  };
}

/**
 * Capture an untracked symlink as its own link-target metadata. The target is
 * read with readlink and the link itself is never opened, so evidence capture
 * cannot dereference a link that escapes the repository, dangles, or points at
 * a device node. The recorded target is attacker-controlled bytes and is only
 * ever emitted inside the untrusted evidence region fenced by review-prompt.ts.
 */
function readUntrackedSymlink(
  relativePath: string,
  candidate: string,
  before: Stats,
  remainingBytes: number
): CapturedUntrackedFile {
  // realpathSync(candidate) would resolve the link itself, so the symlinked
  // path-component guard is applied to the parent directory instead.
  const parent = path.dirname(candidate);
  const parentIsCanonical = (): boolean => {
    try {
      return realpathSync(parent) === parent;
    } catch {
      return false;
    }
  };
  if (!parentIsCanonical()) {
    throw new ReviewScopeError(
      "unsafe_untracked_type",
      "Untracked entries reached through symlinked path components are refused",
      { path: relativePath }
    );
  }
  if (before.size > remainingBytes) {
    throw new ReviewScopeError(
      "artifact_too_large",
      "Untracked evidence exceeds the remaining artifact byte budget",
      { path: relativePath, byteLength: before.size, remainingBytes }
    );
  }

  let target: Buffer;
  let after: ReturnType<typeof lstatSync>;
  try {
    target = readlinkSync(candidate, { encoding: "buffer" });
    after = lstatSync(candidate);
  } catch {
    throw new ReviewScopeError(
      "snapshot_changed",
      "Untracked symlink could not be read safely during capture",
      { path: relativePath }
    );
  }
  if (
    !after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    target.length !== before.size ||
    !parentIsCanonical()
  ) {
    throw new ReviewScopeError(
      "snapshot_changed",
      "Untracked symlink changed while its evidence was captured",
      { path: relativePath }
    );
  }

  const encoded = encodeContent(target);
  const evidence: ReviewUntrackedEvidence = {
    path: relativePath,
    mode: before.mode & 0o777,
    entryType: "symlink",
    ...encoded,
  };
  return {
    evidence,
    fingerprint: sha256(
      JSON.stringify({
        path: relativePath,
        entryType: "symlink",
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        mode: evidence.mode,
        sha256: evidence.sha256,
      })
    ),
  };
}

function readUntrackedFile(
  repositoryRoot: string,
  relativePath: string,
  remainingBytes: number
): CapturedUntrackedFile {
  if (path.isAbsolute(relativePath) || relativePath.split("/").includes("..")) {
    throw new ReviewScopeError("unsafe_untracked_type", "Untracked path escapes repository", {
      path: relativePath,
    });
  }
  const candidate = path.resolve(repositoryRoot, relativePath);
  if (!isPathInside(repositoryRoot, candidate)) {
    throw new ReviewScopeError("unsafe_untracked_type", "Untracked path escapes repository", {
      path: relativePath,
    });
  }

  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(candidate);
  } catch {
    throw new ReviewScopeError("snapshot_changed", "Untracked file disappeared during capture", {
      path: relativePath,
    });
  }
  if (before.isSymbolicLink()) {
    return readUntrackedSymlink(relativePath, candidate, before, remainingBytes);
  }
  if (!before.isFile()) {
    const kind = before.isFIFO() ? "fifo" : before.isDirectory() ? "directory" : "special";
    throw new ReviewScopeError(
      "unsafe_untracked_type",
      `Untracked ${kind} entries are refused by review evidence capture`,
      { path: relativePath, kind }
    );
  }
  let resolvedBefore: string;
  try {
    resolvedBefore = realpathSync(candidate);
  } catch {
    throw new ReviewScopeError("snapshot_changed", "Untracked file disappeared during capture", {
      path: relativePath,
    });
  }
  if (resolvedBefore !== candidate) {
    throw new ReviewScopeError(
      "unsafe_untracked_type",
      "Untracked files reached through symlinked path components are refused",
      { path: relativePath }
    );
  }
  if (before.size > GIT_OUTPUT_HARD_LIMIT_BYTES) {
    throw new ReviewScopeError(
      "git_output_too_large",
      "Untracked file exceeded the hard evidence capture ceiling",
      { path: relativePath, byteLength: before.size }
    );
  }
  if (before.size > remainingBytes) {
    throw new ReviewScopeError(
      "artifact_too_large",
      "Untracked evidence exceeds the remaining artifact byte budget",
      { path: relativePath, byteLength: before.size, remainingBytes }
    );
  }

  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let fd: number | null = null;
  try {
    fd = openSync(candidate, fsConstants.O_RDONLY | noFollow);
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new ReviewScopeError(
        "unsafe_untracked_type",
        "Untracked entry changed to a non-regular file during capture",
        { path: relativePath }
      );
    }
    const content = readFileSync(fd);
    const after = fstatSync(fd);
    const finalPath = lstatSync(candidate);
    const resolvedAfter = realpathSync(candidate);
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeMs !== after.mtimeMs ||
      content.length !== after.size ||
      !finalPath.isFile() ||
      finalPath.dev !== opened.dev ||
      finalPath.ino !== opened.ino ||
      finalPath.size !== opened.size ||
      finalPath.mtimeMs !== opened.mtimeMs ||
      resolvedAfter !== candidate
    ) {
      throw new ReviewScopeError(
        "snapshot_changed",
        "Untracked file changed while its evidence was captured",
        { path: relativePath }
      );
    }
    const encoded = encodeContent(content);
    const evidence: ReviewUntrackedEvidence = {
      path: relativePath,
      mode: opened.mode & 0o777,
      ...encoded,
    };
    return {
      evidence,
      fingerprint: sha256(
        JSON.stringify({
          path: relativePath,
          dev: opened.dev,
          ino: opened.ino,
          size: opened.size,
          mtimeMs: opened.mtimeMs,
          mode: evidence.mode,
          sha256: evidence.sha256,
        })
      ),
    };
  } catch (error) {
    if (error instanceof ReviewScopeError) throw error;
    throw new ReviewScopeError(
      "snapshot_changed",
      "Untracked file could not be opened safely during capture",
      { path: relativePath }
    );
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function captureUntracked(
  context: GitContext,
  plan: ScopePlan,
  paths: readonly string[],
  maxRawBytes: number
): CapturedUntrackedFile[] {
  if (!plan.workingTreeIncluded) return [];
  const output = runGit(context, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    ...(paths.length > 0 ? ["--", ...paths] : []),
  ]);
  const captured: CapturedUntrackedFile[] = [];
  let remainingBytes = maxRawBytes;
  for (const relativePath of splitNul(output, "Untracked Git path").sort(
    compareDeterministicStrings
  )) {
    const file = readUntrackedFile(context.directory, relativePath, remainingBytes);
    captured.push(file);
    remainingBytes -= file.evidence.byteLength;
  }
  return captured;
}

function pathIntersectsFilters(relativePath: string, paths: readonly string[]): boolean {
  if (paths.length === 0) return true;
  return paths.some(
    filter =>
      relativePath === filter ||
      relativePath.startsWith(`${filter}/`) ||
      filter.startsWith(`${relativePath}/`)
  );
}

/**
 * Resolve the ignored subset of many paths with one `check-ignore` process
 * instead of one per path. The paths are fed over stdin, so a leading '-' can
 * never be read as an option, and `-z` keeps both sides of the exchange
 * NUL-delimited and unquoted. Exit code 1 means no path was ignored, while a
 * fatal 128 is surfaced rather than being silently read as "not ignored".
 *
 * `check-ignore` is the one command here that rejects pathspec magic, including
 * the 'literal' magic that GIT_LITERAL_PATHSPECS asserts globally, so it runs
 * with that variable removed. Every path is instead prefixed with './', which
 * restores literal pathname semantics by construction: magic is only recognized
 * at the start of a pathspec, so an entry named ':(top)x' is matched as the
 * literal name rather than as a top-anchored pathspec for 'x'. Git echoes each
 * matched path back exactly as supplied, prefix included, so the prefixed form
 * is also what the returned set is keyed on.
 */
function ignoredPathSubset(context: GitContext, relativePaths: readonly string[]): Set<string> {
  if (relativePaths.length === 0) return new Set();
  const output = runGit(context, ["check-ignore", "--no-index", "-z", "--stdin"], {
    allowExitCodes: [0, 1],
    env: context.pathnameEnv,
    input: Buffer.from(relativePaths.map(candidate => `./${candidate}\0`).join(""), "utf8"),
  });
  const ignored = new Set(splitNul(output, "Git check-ignore path"));
  return new Set(relativePaths.filter(candidate => ignored.has(`./${candidate}`)));
}

/**
 * Kept as a per-path probe. `ls-files --error-unmatch` reports whether a
 * pathspec matches the index at all, which a batched `ls-files` listing cannot
 * reproduce exactly: a literal pathspec also matches index entries beneath it,
 * so set membership of the entry's own path would answer a different question.
 * Only a non-ignored special entry reaches this probe, and the first such entry
 * that is untracked throws, so the per-path cost is bounded and effectively nil.
 */
function isTrackedPath(context: GitContext, relativePath: string): boolean {
  return runGitMaybe(context, ["ls-files", "--error-unmatch", "--", relativePath]) !== null;
}

interface DirectoryEntry {
  absolutePath: string;
  relativePath: string;
  stats: Stats;
}

function enumerateDirectory(
  context: GitContext,
  directory: string,
  paths: readonly string[],
  budget: { visited: number }
): DirectoryEntry[] {
  const repositoryRoot = context.directory;
  let names: string[];
  try {
    if (realpathSync(directory) !== directory) {
      throw new Error("symlinked directory");
    }
    names = readdirSync(directory).sort(compareDeterministicStrings);
  } catch {
    throw new ReviewScopeError(
      "snapshot_changed",
      "A repository directory could not be enumerated during evidence capture"
    );
  }
  const entries: DirectoryEntry[] = [];
  for (const name of names) {
    if (directory === repositoryRoot && name === ".git") continue;
    const absolutePath = path.join(directory, name);
    const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll(path.sep, "/");
    if (!pathIntersectsFilters(relativePath, paths)) continue;
    budget.visited++;
    if (budget.visited > 100_000) {
      throw new ReviewScopeError(
        "git_output_too_large",
        "Repository filesystem enumeration exceeded the hard evidence ceiling"
      );
    }
    let stats: Stats;
    try {
      stats = lstatSync(absolutePath);
    } catch {
      throw new ReviewScopeError(
        "snapshot_changed",
        "A repository entry changed during evidence capture",
        { path: relativePath }
      );
    }
    entries.push({ absolutePath, relativePath, stats });
  }
  return entries;
}

/**
 * Git omits FIFOs, sockets, and device nodes from its untracked listing, so the
 * worktree is walked directly to refuse them. The walk is breadth-first by
 * depth level: every directory in a level is enumerated, then one batched
 * `check-ignore` answers the descend decision for the whole level. That costs
 * one Git process per depth level rather than one per directory entry, while
 * preserving the per-entry decisions exactly.
 */
function refuseUntrackedSpecialEntries(context: GitContext, paths: readonly string[]): void {
  let frontier = [context.directory];
  const budget = { visited: 0 };
  while (frontier.length > 0) {
    const entries = frontier.flatMap(directory =>
      enumerateDirectory(context, directory, paths, budget)
    );
    // Files and symlinks are never refused here, so they are left out of the
    // ignore probe entirely. Directories need it to decide whether to descend,
    // special entries need it to decide whether to refuse.
    const probed = entries.filter(
      entry => entry.stats.isDirectory() || !(entry.stats.isFile() || entry.stats.isSymbolicLink())
    );
    const ignored = ignoredPathSubset(
      context,
      probed.map(entry => entry.relativePath)
    );
    const next: string[] = [];
    for (const entry of probed) {
      if (entry.stats.isDirectory()) {
        if (!ignored.has(entry.relativePath)) next.push(entry.absolutePath);
        continue;
      }
      if (!ignored.has(entry.relativePath) && !isTrackedPath(context, entry.relativePath)) {
        const kind = entry.stats.isFIFO()
          ? "fifo"
          : entry.stats.isSocket()
            ? "socket"
            : entry.stats.isBlockDevice()
              ? "block_device"
              : entry.stats.isCharacterDevice()
                ? "character_device"
                : "special";
        throw new ReviewScopeError(
          "unsafe_untracked_type",
          `Untracked ${kind} entries are refused by review evidence capture`,
          { path: entry.relativePath, kind }
        );
      }
    }
    frontier = next;
  }
}

function sameUntracked(
  left: readonly CapturedUntrackedFile[],
  right: readonly CapturedUntrackedFile[]
): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.fingerprint === right[index]?.fingerprint &&
      JSON.stringify(entry.evidence) === JSON.stringify(right[index]?.evidence)
  );
}

function buildArtifactPayload(
  plan: ScopePlan,
  state: ReviewWorkingTreeState,
  paths: string[],
  committedPatch: Buffer,
  committedPaths: readonly string[],
  stagedPatch: Buffer,
  stagedPaths: readonly string[],
  unstagedPatch: Buffer,
  unstagedPaths: readonly string[],
  untracked: readonly CapturedUntrackedFile[]
): ReviewArtifactPayload {
  const hasCommittedChanges = committedPatch.length > 0;
  const trackedPaths = [...new Set([...committedPaths, ...stagedPaths, ...unstagedPaths])].sort(
    compareDeterministicStrings
  );
  const files: ReviewEvidenceFile[] = [
    ...trackedPaths.map(filePath => ({ path: filePath, source: "tracked" as const })),
    ...untracked.map(file => ({ path: file.evidence.path, source: "untracked" as const })),
  ].sort((left, right) =>
    compareDeterministicStrings(`${left.path}\0${left.source}`, `${right.path}\0${right.source}`)
  );
  return {
    schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
    scope: {
      requestedMode: plan.requestedMode,
      resolvedMode: plan.resolvedMode,
      baseRef: plan.baseRef,
      baseSha: plan.baseSha,
      baseTipSha: plan.baseTipSha,
      headSha: plan.headSha,
      mergeBaseSha: plan.mergeBaseSha,
      workingTreeIncluded: plan.workingTreeIncluded,
      hasCommittedChanges,
      paths,
    },
    workingTree: state,
    files,
    committedPatch: encodePatch(committedPatch, committedPaths),
    stagedPatch: encodePatch(stagedPatch, stagedPaths),
    unstagedPatch: encodePatch(unstagedPatch, unstagedPaths),
    untrackedFiles: untracked.map(file => file.evidence),
  };
}

/**
 * Resolve a stable Git review scope and return one complete, byte-accounted
 * evidence artifact. The function never truncates. It re-captures the status,
 * tracked diffs, and every untracked file before returning, then fails closed if
 * any included evidence changed during capture.
 */
export function resolveReviewScope(
  request: ReviewScopeRequest,
  hooks: ReviewScopeHooks = {}
): ResolvedReviewScope {
  const repositoryPath = resolveRepositoryPath(request.repositoryPath);
  const repositoryRoot = resolveRepositoryRoot(repositoryPath, hooks.onGitCommand);
  if (!isAuthorizedReviewRepositoryRoot(repositoryPath, repositoryRoot)) {
    throw new ReviewScopeError(
      "invalid_input",
      "Resolved Git worktree root is outside the authorized review repository path"
    );
  }
  const requestedMode = validateMode(request.mode ?? "auto");
  const paths = validateLiteralPaths(request.paths);
  const maxArtifactBytes = validateByteLimit(
    request.maxArtifactBytes ?? DEFAULT_REVIEW_ARTIFACT_MAX_BYTES
  );
  const context = createGitContext(repositoryRoot, hooks.onGitCommand);

  if (requestedMode !== "commit") refuseUntrackedSpecialEntries(context, paths);
  const initialHead = resolveCommit(context, "HEAD");
  const initialStatus = statusBuffer(context, paths);
  const state = summarizeStatus(initialStatus);
  const plan = buildScopePlan(context, requestedMode, request.base, state);
  if (plan.headSha !== initialHead) {
    throw new ReviewScopeError(
      "snapshot_changed",
      "HEAD changed while the review scope was being resolved"
    );
  }

  const committedPatch = captureCommittedPatch(context, plan, paths);
  const stagedPatch = captureStagedPatch(context, plan, paths);
  const unstagedPatch = captureUnstagedPatch(context, plan, paths);
  const committedPaths = plan.headSha
    ? captureCommittedPaths(context, plan.baseSha, plan.headSha, paths)
    : [];
  const stagedPaths = plan.workingTreeIncluded
    ? captureStagedPaths(context, plan.headSha ?? plan.baseSha, paths)
    : [];
  const unstagedPaths = plan.workingTreeIncluded ? captureUnstagedPaths(context, paths) : [];
  const trackedRawBytes = committedPatch.length + stagedPatch.length + unstagedPatch.length;
  if (trackedRawBytes > maxArtifactBytes) {
    throw new ReviewScopeError(
      "artifact_too_large",
      "Tracked evidence exceeds the artifact byte budget",
      { trackedRawBytes, maxArtifactBytes }
    );
  }
  const untracked = captureUntracked(context, plan, paths, maxArtifactBytes - trackedRawBytes);

  hooks.beforeSnapshotRecheck?.();

  const finalHead = resolveCommit(context, "HEAD");
  const finalStatus = statusBuffer(context, paths);
  const finalCommittedPatch = captureCommittedPatch(context, plan, paths);
  const finalStagedPatch = captureStagedPatch(context, plan, paths);
  const finalUnstagedPatch = captureUnstagedPatch(context, plan, paths);
  const finalCommittedPaths = plan.headSha
    ? captureCommittedPaths(context, plan.baseSha, plan.headSha, paths)
    : [];
  const finalStagedPaths = plan.workingTreeIncluded
    ? captureStagedPaths(context, plan.headSha ?? plan.baseSha, paths)
    : [];
  const finalUnstagedPaths = plan.workingTreeIncluded ? captureUnstagedPaths(context, paths) : [];
  if (plan.workingTreeIncluded) refuseUntrackedSpecialEntries(context, paths);
  const finalUntracked = captureUntracked(context, plan, paths, maxArtifactBytes - trackedRawBytes);
  // The filter overrides pinned in `context` were discovered once, before
  // capture. Re-verifying the driver set here fails closed when
  // repository-local filter configuration changed while evidence was read.
  const finalFilterSignature = filterOverrideSignature(
    reviewFilterSafetyOverrides(context.directory, hooks.onGitCommand)
  );
  if (
    context.filterSignature !== finalFilterSignature ||
    initialHead !== finalHead ||
    !initialStatus.equals(finalStatus) ||
    !committedPatch.equals(finalCommittedPatch) ||
    !stagedPatch.equals(finalStagedPatch) ||
    !unstagedPatch.equals(finalUnstagedPatch) ||
    !sameStrings(committedPaths, finalCommittedPaths) ||
    !sameStrings(stagedPaths, finalStagedPaths) ||
    !sameStrings(unstagedPaths, finalUnstagedPaths) ||
    !sameUntracked(untracked, finalUntracked)
  ) {
    throw new ReviewScopeError(
      "snapshot_changed",
      "Repository evidence changed during capture; retry against a stable worktree"
    );
  }

  const payload = buildArtifactPayload(
    plan,
    state,
    paths,
    committedPatch,
    committedPaths,
    stagedPatch,
    stagedPaths,
    unstagedPatch,
    unstagedPaths,
    untracked
  );
  const content = JSON.stringify(payload, null, 2);
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > maxArtifactBytes) {
    throw new ReviewScopeError(
      "artifact_too_large",
      `Review evidence requires ${byteLength} UTF-8 bytes, exceeding the ${maxArtifactBytes}-byte limit; narrow the path scope or raise the bounded limit`,
      { byteLength, maxArtifactBytes }
    );
  }

  return {
    schemaVersion: REVIEW_EVIDENCE_SCHEMA_VERSION,
    repositoryRoot,
    requestedMode,
    resolvedMode: plan.resolvedMode,
    baseRef: plan.baseRef,
    baseSha: plan.baseSha,
    baseTipSha: plan.baseTipSha,
    headSha: plan.headSha,
    mergeBaseSha: plan.mergeBaseSha,
    workingTreeIncluded: plan.workingTreeIncluded,
    hasCommittedChanges: payload.scope.hasCommittedChanges,
    workingTree: state,
    files: payload.files,
    artifact: {
      content,
      byteLength,
      sha256: sha256(content),
      complete: true,
    },
  };
}
