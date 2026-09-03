/**
 * Which directory a dispatched job ran in, and how that directory was chosen.
 *
 * Issue #296: the working directory decides which AGENTS.md or CLAUDE.md the
 * provider loaded, and nothing durable recorded it. `args_json` carries it for
 * a fresh codex session only, because CODEX_RESUME_FILTERED_FLAGS strips `-C`
 * from a resume.
 *
 * The SCOPE is the load-bearing half, not the path. An unscoped job runs in a
 * fresh neutral directory that `createNeutralExecutionWorkspace` removes when
 * the process closes, so its path names nothing after the fact; that the job
 * was unscoped, and therefore reached no repository instruction file, is the
 * durable fact and it is what makes #190's contamination class visible in the
 * record rather than only in the output.
 */

/**
 * `unknown` is NOT MEASURED: a directory was chosen and this call site did not
 * say how. It exists so a caller that cannot describe its resolution writes an
 * honest gap instead of a plausible guess.
 */
export type JobCwdScope = "caller" | "workspace" | "worktree" | "neutral" | "unknown";

export interface JobCwdRecord {
  scope: JobCwdScope;
  /** Null for `neutral` by construction: that directory no longer exists. */
  path: string | null;
  /** A path is not a workspace identity; a binding can be repointed. */
  workspaceAlias: string | null;
}

/** The parts of a resolved request scope this decision reads. */
export interface JobCwdResolution {
  worktreePath?: string;
  effectiveWorkingDir?: string;
  workspaceAlias?: string;
}

export function describeJobCwd(
  cwd: string | undefined,
  resolution?: JobCwdResolution
): JobCwdRecord {
  if (cwd === undefined) return { scope: "neutral", path: null, workspaceAlias: null };
  const workspaceAlias = resolution?.workspaceAlias ?? null;
  if (!resolution) return { scope: "unknown", path: cwd, workspaceAlias: null };
  if (resolution.worktreePath !== undefined) {
    return { scope: "worktree", path: cwd, workspaceAlias };
  }
  // A caller-supplied workingDir inside a registered workspace is still the
  // CALLER's selection; the alias records the binding it was validated against.
  if (resolution.effectiveWorkingDir !== undefined && resolution.effectiveWorkingDir === cwd) {
    return { scope: "caller", path: cwd, workspaceAlias };
  }
  return { scope: workspaceAlias === null ? "unknown" : "workspace", path: cwd, workspaceAlias };
}

const SCOPES: readonly string[] = ["caller", "workspace", "worktree", "neutral", "unknown"];

/** Read a persisted value back. A legacy row has none and stays null. */
export function parseJobCwdScope(value: unknown): JobCwdScope | null {
  return typeof value === "string" && SCOPES.includes(value) ? (value as JobCwdScope) : null;
}
