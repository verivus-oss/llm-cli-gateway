import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod/v3";
import { CLI_TYPES, type CliType } from "./session-manager.js";
import { defaultGatewayConfigPath } from "./config.js";
import type { Logger } from "./logger.js";
import { logWarn, noopLogger } from "./logger.js";

const ALIAS_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const DENIED_NAMES = new Set([
  ".llm-cli-gateway",
  ".ssh",
  ".aws",
  ".azure",
  ".config",
  ".gnupg",
  ".kube",
  ".password-store",
]);

const WorkspaceRepoSchema = z
  .object({
    alias: z.string().min(1),
    path: z.string().min(1),
    providers: z.array(z.enum(CLI_TYPES)).default([...CLI_TYPES]),
    allow_worktree: z.boolean().default(true),
    allow_add_dir: z.boolean().default(false),
    kind: z.enum(["git", "folder"]).default("git"),
    operator_entry: z.boolean().default(true),
  })
  .strict();

const WorkspaceAllowedRootSchema = z
  .object({
    alias: z.string().min(1).optional(),
    path: z.string().min(1),
    allow_register_existing_git_repos: z.boolean().default(false),
    allow_create_directories: z.boolean().default(false),
    allow_init_git_repos: z.boolean().default(false),
    max_create_depth: z.number().int().min(1).max(8).default(2),
  })
  .strict();

const WorkspacesSchema = z
  .object({
    default: z.string().optional(),
    allow_unregistered_working_dir: z.boolean().default(false),
    repos: z.array(WorkspaceRepoSchema).default([]),
    allowed_roots: z.array(WorkspaceAllowedRootSchema).default([]),
  })
  .strict();

export interface WorkspaceRepo {
  alias: string;
  path: string;
  providers: CliType[];
  allowWorktree: boolean;
  allowAddDir: boolean;
  kind: "git" | "folder";
  operatorEntry: boolean;
}

export interface WorkspaceAllowedRoot {
  alias: string;
  path: string;
  allowRegisterExistingGitRepos: boolean;
  allowCreateDirectories: boolean;
  allowInitGitRepos: boolean;
  maxCreateDepth: number;
}

export interface WorkspaceRegistry {
  enabled: boolean;
  defaultAlias: string | null;
  allowUnregisteredWorkingDir: boolean;
  repos: WorkspaceRepo[];
  allowedRoots: WorkspaceAllowedRoot[];
  sources: { configFile: string | null };
}

export interface EffectiveWorkspace {
  alias: string;
  root: string;
  cwd: string;
  worktreePath?: string;
  repo: WorkspaceRepo;
}

export interface CreateWorkspaceInput {
  alias: string;
  rootAlias: string;
  slug: string;
  kind: "folder" | "git";
  setDefault?: boolean;
  configPath?: string;
  logger?: Logger;
}

export class WorkspaceRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRegistryError";
  }
}

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? path.join(homedir(), p.slice(2)) : p;
}

function readToml(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const require = createRequire(import.meta.url);
  const TOML = require("smol-toml");
  return TOML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeToml(configPath: string, data: Record<string, unknown>): void {
  const require = createRequire(import.meta.url);
  const TOML = require("smol-toml");
  const dir = path.dirname(configPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.config.toml.tmp.${process.pid}.${Date.now()}`);
  writeFileSync(tmp, TOML.stringify(data), { mode: 0o600 });
  const fd = openSync(tmp, "r+");
  closeSync(fd);
  renameSync(tmp, configPath);
  chmodSync(configPath, 0o600);
}

export function validateWorkspaceAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias) || alias === "." || alias === ".." || alias.includes("..")) {
    throw new WorkspaceRegistryError(
      `Invalid workspace alias "${alias}" (allowed: A-Z a-z 0-9 . _ -, must start with a letter)`
    );
  }
  return alias;
}

function defaultRootAlias(rootPath: string, existing: Set<string>): string {
  const base = path.basename(rootPath).replace(/[^A-Za-z0-9._-]/g, "-") || "root";
  let candidate = ALIAS_PATTERN.test(base) ? base : `root-${base}`;
  let i = 2;
  while (existing.has(candidate)) {
    candidate = `${base}-${i}`;
    i += 1;
  }
  return candidate;
}

function assertNotDeniedPath(realPath: string): void {
  const names = realPath.split(path.sep).filter(Boolean);
  for (const name of names) {
    if (DENIED_NAMES.has(name)) {
      throw new WorkspaceRegistryError(`Workspace path targets denied directory "${name}"`);
    }
  }
}

function realExistingPath(p: string): string {
  if (!path.isAbsolute(p)) {
    throw new WorkspaceRegistryError(`Workspace path must be absolute: ${p}`);
  }
  if (!existsSync(p)) {
    throw new WorkspaceRegistryError(`Workspace path does not exist: ${p}`);
  }
  const real = realpathSync(p);
  assertNotDeniedPath(real);
  return real;
}

function isGitRepo(p: string): boolean {
  return existsSync(path.join(p, ".git"));
}

function isUnder(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function normalizeSlug(slug: string, maxDepth: number): string[] {
  if (path.isAbsolute(slug)) {
    throw new WorkspaceRegistryError("Workspace slug must be relative");
  }
  const normalized = path.normalize(slug).replace(/\\/g, "/");
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new WorkspaceRegistryError("Workspace slug must not traverse outside the allowed root");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.length > maxDepth) {
    throw new WorkspaceRegistryError(`Workspace slug must contain 1-${maxDepth} path segment(s)`);
  }
  for (const segment of segments) {
    if (
      segment === "." ||
      segment === ".." ||
      segment.startsWith(".") ||
      segment.includes("..") ||
      !SAFE_SEGMENT_PATTERN.test(segment) ||
      DENIED_NAMES.has(segment)
    ) {
      throw new WorkspaceRegistryError(`Workspace slug segment "${segment}" is not allowed`);
    }
  }
  return segments;
}

export function loadWorkspaceRegistry(
  logger: Logger = noopLogger,
  configPath = defaultGatewayConfigPath()
): WorkspaceRegistry {
  const sourcePath = existsSync(configPath) ? configPath : null;
  let parsed: Record<string, unknown>;
  try {
    parsed = readToml(configPath);
  } catch (err) {
    logWarn(logger, "Invalid gateway config; workspace registry disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return disabledRegistry(sourcePath);
  }
  const raw = (parsed.workspaces as Record<string, unknown> | undefined) ?? {};
  const result = WorkspacesSchema.safeParse(raw);
  if (!result.success) {
    logWarn(logger, "Invalid [workspaces] config; workspace registry disabled", {
      error: result.error.message,
    });
    return disabledRegistry(sourcePath);
  }
  try {
    const rootAliases = new Set<string>();
    const allowedRoots = result.data.allowed_roots.map(root => {
      const real = realExistingPath(expandHome(root.path));
      const alias = validateWorkspaceAlias(root.alias ?? defaultRootAlias(real, rootAliases));
      rootAliases.add(alias);
      return {
        alias,
        path: real,
        allowRegisterExistingGitRepos: root.allow_register_existing_git_repos,
        allowCreateDirectories: root.allow_create_directories,
        allowInitGitRepos: root.allow_init_git_repos,
        maxCreateDepth: root.max_create_depth,
      };
    });
    const aliases = new Set<string>();
    const repos = result.data.repos.map(repo => {
      const alias = validateWorkspaceAlias(repo.alias);
      if (aliases.has(alias))
        throw new WorkspaceRegistryError(`Duplicate workspace alias "${alias}"`);
      aliases.add(alias);
      const real = realExistingPath(expandHome(repo.path));
      if (repo.kind === "git" && !isGitRepo(real)) {
        throw new WorkspaceRegistryError(`Workspace "${alias}" is not a Git repository`);
      }
      return {
        alias,
        path: real,
        providers: repo.providers,
        allowWorktree: repo.allow_worktree,
        allowAddDir: repo.allow_add_dir,
        kind: repo.kind,
        operatorEntry: repo.operator_entry,
      };
    });
    if (result.data.default && !repos.some(repo => repo.alias === result.data.default)) {
      throw new WorkspaceRegistryError(
        `[workspaces].default references unknown alias "${result.data.default}"`
      );
    }
    return {
      enabled: repos.length > 0 || allowedRoots.length > 0,
      defaultAlias: result.data.default ?? null,
      allowUnregisteredWorkingDir: result.data.allow_unregistered_working_dir,
      repos,
      allowedRoots,
      sources: { configFile: sourcePath },
    };
  } catch (err) {
    logWarn(logger, "Invalid [workspaces] config; workspace registry disabled", {
      error: err instanceof Error ? err.message : String(err),
    });
    return disabledRegistry(sourcePath);
  }
}

function disabledRegistry(sourcePath: string | null): WorkspaceRegistry {
  return {
    enabled: false,
    defaultAlias: null,
    allowUnregisteredWorkingDir: false,
    repos: [],
    allowedRoots: [],
    sources: { configFile: sourcePath },
  };
}

export function getWorkspace(registry: WorkspaceRegistry, alias: string): WorkspaceRepo {
  validateWorkspaceAlias(alias);
  const repo = registry.repos.find(candidate => candidate.alias === alias);
  if (!repo) throw new WorkspaceRegistryError(`Unknown workspace alias "${alias}"`);
  return repo;
}

export function resolveWorkspaceForProvider(
  registry: WorkspaceRegistry,
  provider: CliType,
  requestedAlias?: string,
  sessionMetadata?: Record<string, unknown>
): EffectiveWorkspace {
  const sessionAlias =
    typeof sessionMetadata?.workspaceAlias === "string"
      ? sessionMetadata.workspaceAlias
      : undefined;
  const alias = requestedAlias ?? sessionAlias ?? registry.defaultAlias;
  if (!alias) {
    throw new WorkspaceRegistryError(
      "No workspace selected. Configure [workspaces].default or pass a registered workspace alias."
    );
  }
  const repo = getWorkspace(registry, alias);
  if (!repo.providers.includes(provider)) {
    throw new WorkspaceRegistryError(`Workspace "${alias}" does not allow provider "${provider}"`);
  }
  return { alias: repo.alias, root: repo.path, cwd: repo.path, repo };
}

export function validatePathInsideWorkspace(
  workspace: EffectiveWorkspace,
  candidate: string,
  policy: "workingDir" | "addDir"
): string {
  if (path.isAbsolute(candidate) && policy === "workingDir") {
    throw new WorkspaceRegistryError("Absolute workingDir is not allowed for remote workspaces");
  }
  if (path.isAbsolute(candidate) && policy === "addDir" && !workspace.repo.allowAddDir) {
    throw new WorkspaceRegistryError("Absolute addDir is not allowed for this workspace");
  }
  const resolved = path.isAbsolute(candidate)
    ? realExistingPath(candidate)
    : realExistingPath(path.join(workspace.root, candidate));
  if (!isUnder(workspace.root, resolved)) {
    throw new WorkspaceRegistryError(`${policy} must stay inside workspace "${workspace.alias}"`);
  }
  return resolved;
}

export function createWorkspace(input: CreateWorkspaceInput): WorkspaceRepo {
  const logger = input.logger ?? noopLogger;
  if (input.kind !== "folder" && input.kind !== "git") {
    throw new WorkspaceRegistryError("Workspace kind must be folder or git");
  }
  const configPath = input.configPath ?? defaultGatewayConfigPath();
  const raw = readToml(configPath);
  const registry = loadWorkspaceRegistry(logger, configPath);
  const alias = validateWorkspaceAlias(input.alias);
  if (registry.repos.some(repo => repo.alias === alias)) {
    throw new WorkspaceRegistryError(`Workspace alias "${alias}" already exists`);
  }
  const root = registry.allowedRoots.find(candidate => candidate.alias === input.rootAlias);
  if (!root) throw new WorkspaceRegistryError(`Unknown allowed root "${input.rootAlias}"`);
  if (!root.allowCreateDirectories) {
    throw new WorkspaceRegistryError(`Allowed root "${input.rootAlias}" does not permit creation`);
  }
  if (input.kind === "git" && !root.allowInitGitRepos) {
    throw new WorkspaceRegistryError(`Allowed root "${input.rootAlias}" does not permit git init`);
  }
  const segments = normalizeSlug(input.slug, root.maxCreateDepth);
  const target = path.resolve(root.path, ...segments);
  if (!isUnder(root.path, target)) {
    throw new WorkspaceRegistryError("Workspace target escapes the allowed root");
  }
  const parent = path.dirname(target);
  const parentReal = realExistingPath(parent);
  if (!isUnder(root.path, parentReal)) {
    throw new WorkspaceRegistryError("Workspace parent escapes the allowed root");
  }
  if (existsSync(target)) {
    const stat = statSync(target);
    if (!stat.isDirectory()) {
      throw new WorkspaceRegistryError("Workspace target exists and is not a directory");
    }
    if (readdirSync(target).length > 0) {
      throw new WorkspaceRegistryError("Workspace target exists and is not empty");
    }
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const targetReal = realpathSync(target);
  if (!isUnder(root.path, targetReal)) {
    rmSync(target, { recursive: true, force: true });
    throw new WorkspaceRegistryError("Workspace target escapes the allowed root");
  }
  assertNotDeniedPath(targetReal);
  if (input.kind === "git") {
    const init = spawnSync("git", ["init"], { cwd: targetReal, encoding: "utf8" });
    if (init.status !== 0) {
      throw new WorkspaceRegistryError(`git init failed: ${init.stderr || init.stdout}`);
    }
  }

  const workspaces = ((raw.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const repos = (Array.isArray(workspaces.repos) ? workspaces.repos : []) as Array<
    Record<string, unknown>
  >;
  repos.push({
    alias,
    path: targetReal,
    providers: [...CLI_TYPES],
    allow_worktree: input.kind === "git",
    allow_add_dir: false,
    kind: input.kind,
    operator_entry: false,
  });
  workspaces.repos = repos;
  if (input.setDefault) workspaces.default = alias;
  raw.workspaces = workspaces;
  writeToml(configPath, raw);
  return {
    alias,
    path: targetReal,
    providers: [...CLI_TYPES],
    allowWorktree: input.kind === "git",
    allowAddDir: false,
    kind: input.kind,
    operatorEntry: false,
  };
}

export function registerExistingWorkspace(input: {
  alias: string;
  repoPath: string;
  setDefault?: boolean;
  configPath?: string;
  logger?: Logger;
}): WorkspaceRepo {
  const logger = input.logger ?? noopLogger;
  const configPath = input.configPath ?? defaultGatewayConfigPath();
  const raw = readToml(configPath);
  const registry = loadWorkspaceRegistry(logger, configPath);
  const alias = validateWorkspaceAlias(input.alias);
  if (registry.repos.some(repo => repo.alias === alias)) {
    throw new WorkspaceRegistryError(`Workspace alias "${alias}" already exists`);
  }
  const real = realExistingPath(input.repoPath);
  if (!isGitRepo(real)) throw new WorkspaceRegistryError("Existing workspace must be a Git repo");
  const root = registry.allowedRoots.find(candidate => isUnder(candidate.path, real));
  if (!root?.allowRegisterExistingGitRepos) {
    throw new WorkspaceRegistryError("No allowed root permits registering this Git repo");
  }
  const workspaces = ((raw.workspaces as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const repos = (Array.isArray(workspaces.repos) ? workspaces.repos : []) as Array<
    Record<string, unknown>
  >;
  repos.push({
    alias,
    path: real,
    providers: [...CLI_TYPES],
    allow_worktree: true,
    allow_add_dir: false,
    kind: "git",
    operator_entry: false,
  });
  workspaces.repos = repos;
  if (input.setDefault) workspaces.default = alias;
  raw.workspaces = workspaces;
  writeToml(configPath, raw);
  return {
    alias,
    path: real,
    providers: [...CLI_TYPES],
    allowWorktree: true,
    allowAddDir: false,
    kind: "git",
    operatorEntry: false,
  };
}

export function createTempWorkspaceConfig(contents: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "workspace-registry-test-"));
  const configPath = path.join(dir, "config.toml");
  writeFileSync(configPath, contents, { mode: 0o600 });
  return configPath;
}

export function describeWorkspace(repo: WorkspaceRepo): Record<string, unknown> {
  let branch: string | null = null;
  let dirty = false;
  if (repo.kind === "git") {
    const branchResult = spawnSync("git", ["branch", "--show-current"], {
      cwd: repo.path,
      encoding: "utf8",
    });
    branch = branchResult.status === 0 ? branchResult.stdout.trim() || null : null;
    const status = spawnSync("git", ["status", "--porcelain"], {
      cwd: repo.path,
      encoding: "utf8",
    });
    dirty = status.status === 0 && status.stdout.trim().length > 0;
  }
  return {
    alias: repo.alias,
    path: repo.path,
    kind: repo.kind,
    providers: repo.providers,
    allow_worktree: repo.allowWorktree,
    allow_add_dir: repo.allowAddDir,
    branch,
    dirty,
  };
}
