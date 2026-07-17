import { chmodSync, existsSync, lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse } from "node:path";

const NEUTRAL_WORKSPACE_PREFIX = "llm-cli-gateway-neutral-";

// Keep this list to provider-native entries that are discovered from a
// descendant cwd or its project ancestors. Repository-only rule layouts do
// not belong here unless their provider performs that ancestor discovery.
//
// Two entries are deliberately excluded, because a neutral cwd cannot defend
// against them and listing them would only relocate the workspace:
//   - User-scope settings (`~/.claude/settings.json` and `~/.gemini/config`)
//     are loaded on every provider invocation regardless of cwd, so rejecting
//     a temp root beneath the home directory buys no isolation. It would also
//     reject `$HOME`-rooted temp roots on any host that configures a provider
//     at all, and fail closed where no other temp root is writable.
//   - Project entries a provider only reads after a repository root is
//     established (Grok resolves `.grok/config.toml` and `GROK.md` only once
//     `.git` marks the root) add no coverage beyond the `.git` entry above.
//
// This list cannot derive from `src/provider-definitions.ts`: the registry's
// `modelDiscovery.configSources` records where a provider reads a default
// model, not whether a path is discovered by walking cwd ancestors, and it
// spells out none of the instruction-file entries above. Deriving from it
// would import home-scoped paths as if they were ancestor markers.
const CONTEXT_BEARING_ANCESTOR_ENTRIES = [
  ".git",
  "AGENTS.md",
  "AGENTS.override.md",
  "Agents.md",
  "AGENT.md",
  "CLAUDE.md",
  "Claude.md",
  "CLAUDE.local.md",
  ".claude/CLAUDE.md",
  ".claude/rules",
  ".cursor/rules",
  ".cursorrules",
  "GEMINI.md",
  // Vibe walks cwd and every parent for a project config, independent of any
  // repository root (vibe/core/config/layers/project.py `_find_config_file`).
  ".vibe/config.toml",
] as const;

export interface NeutralExecutionWorkspace {
  /** Canonical, gateway-owned directory used as a provider process cwd. */
  cwd: string;
  /** Idempotently removes the workspace after the child process terminates. */
  cleanup: () => void;
}

const activeWorkspaces = new Map<string, () => void>();
let exitCleanupRegistered = false;

function hasRepositoryOrInstructionContext(directory: string): boolean {
  for (const entry of CONTEXT_BEARING_ANCESTOR_ENTRIES) {
    // These fixed relative entries are checked only on a canonical ancestor
    // chain.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    if (existsSync(join(directory, entry))) return true;
  }
  return false;
}

function hasContextBearingAncestor(candidate: string): boolean {
  const root = parse(candidate).root;
  let current = candidate;
  for (;;) {
    if (hasRepositoryOrInstructionContext(current)) return true;
    if (current === root) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

function neutralTempRootCandidates(): string[] {
  const candidates = [tmpdir()];
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (systemRoot) candidates.push(join(systemRoot, "Temp"));
  } else {
    candidates.push("/var/tmp", "/dev/shm", "/tmp");
  }
  return [...new Set(candidates)];
}

function assertCleanupTarget(workspace: string, tempRoot: string): void {
  if (
    dirname(workspace) !== tempRoot ||
    !basename(workspace).startsWith(NEUTRAL_WORKSPACE_PREFIX)
  ) {
    throw new Error("Refusing to remove an invalid neutral execution workspace path");
  }
}

function removeWorkspace(workspace: string, tempRoot: string): void {
  assertCleanupTarget(workspace, tempRoot);
  try {
    // The path is a direct child created by mkdtempSync and checked above.
    rmSync(workspace, { recursive: true, force: true, maxRetries: 2 });
  } catch {
    // Cleanup is best effort on process termination. The random 0o700 directory
    // remains isolated if the operating system temporarily refuses removal.
  }
}

/** Remove every fallback workspace still owned by this gateway process. */
export function cleanupNeutralExecutionWorkspaces(): void {
  for (const cleanup of [...activeWorkspaces.values()]) cleanup();
}

/** Test-only count proving admission failures did not allocate a neutral cwd. */
export function activeNeutralExecutionWorkspaceCountForTest(): number {
  return activeWorkspaces.size;
}

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once("exit", cleanupNeutralExecutionWorkspaces);
}

/**
 * Create a fresh, private cwd for one provider process when no execution cwd
 * reached the spawn boundary. A fresh directory prevents one unscoped request
 * from leaving repository instructions for another. Call cleanup after the
 * child exits; the process exit hook is a final best-effort safety net.
 */
export function createNeutralExecutionWorkspace(): NeutralExecutionWorkspace {
  // The environment-selected temp directory may itself sit inside a checkout
  // or instruction scope. Canonicalize and inspect every candidate ancestor
  // chain, then relocate to a known platform temp root when necessary. This
  // keeps unscoped execution available on hosts with a contaminated TMPDIR
  // without ever creating the supposedly neutral child beneath that context.
  let tempRoot: string | undefined;
  let created: string | undefined;
  for (const candidate of neutralTempRootCandidates()) {
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const canonicalCandidate = realpathSync(candidate);
      if (hasContextBearingAncestor(canonicalCandidate)) continue;
      const candidateWorkspace = mkdtempSync(join(canonicalCandidate, NEUTRAL_WORKSPACE_PREFIX));
      tempRoot = canonicalCandidate;
      created = candidateWorkspace;
      break;
    } catch {
      // Try the next platform temp root. If none is safe and writable, fail
      // closed below rather than falling back to the gateway process cwd.
    }
  }
  if (!tempRoot || !created) {
    throw new Error(
      "Cannot create a neutral execution workspace outside repository or instruction context"
    );
  }

  let workspace = created;
  try {
    // The path was returned by mkdtempSync and cannot be caller-controlled.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    chmodSync(created, 0o700);
    // Canonicalize once before exposing the path to the process spawner.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    workspace = realpathSync(created);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const stat = lstatSync(workspace);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Neutral execution workspace is not a real directory");
    }
    if (hasContextBearingAncestor(workspace)) {
      throw new Error(
        "Neutral execution workspace unexpectedly resolved beneath repository or instruction context"
      );
    }
    assertCleanupTarget(workspace, tempRoot);
  } catch (error) {
    removeWorkspace(created, tempRoot);
    throw error;
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    activeWorkspaces.delete(workspace);
    removeWorkspace(workspace, tempRoot);
  };
  activeWorkspaces.set(workspace, cleanup);
  registerExitCleanup();
  return { cwd: workspace, cleanup };
}
