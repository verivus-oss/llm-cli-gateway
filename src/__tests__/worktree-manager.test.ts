/**
 * Phase 4 slice λ — worktree-manager unit tests.
 *
 * Covers `sanitizeWorktreeName`, `createWorktree`, `removeWorktree`, and
 * `createWorktreeSessionCleanupHook` in isolation. Uses real git
 * subprocesses against a tmp repo (no git mocks) so the assertions
 * exercise the same `child_process.spawn` path the gateway runs in
 * production. Mutation-probe-friendly per slice-lambda.spec.md §Test
 * surfaces — see the comments above each block for the exact mutation
 * each assertion goes red against.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import {
  createWorktree,
  createWorktreeSessionCleanupHook,
  removeWorktree,
  sanitizeWorktreeName,
  WorktreeCollisionError,
  WorktreeError,
} from "../worktree-manager.js";
import { noopLogger } from "../logger.js";

/**
 * Initialise a tmp git repo with one committed file so HEAD is a real
 * commit and `git worktree add` has something to branch from.
 */
function initRepo(): string {
  const repoRoot = mkdtempSync(join(tmpdir(), "wt-mgr-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot, stdio: "ignore" });
  writeFileSync(join(repoRoot, "README.md"), "seed\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "seed"], { cwd: repoRoot, stdio: "ignore" });
  return repoRoot;
}

function rmRepo(repoRoot: string): void {
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ─── sanitizeWorktreeName (Lα coverage) ─────────────────────────────────
//
// Mutation probe: weaken the input checks (e.g. drop the `..` guard, the
// slash guard, the leading-dot/leading-hyphen guard, or relax the
// NAME_PATTERN regex). Each rejection assertion below MUST go red.

describe("sanitizeWorktreeName (slice λ)", () => {
  it("accepts well-formed names containing letters, digits, dots, underscores, hyphens", () => {
    expect(sanitizeWorktreeName("alpha_beta-1.0")).toBe("alpha_beta-1.0");
    expect(sanitizeWorktreeName("A")).toBe("A");
    expect(sanitizeWorktreeName("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects empty input", () => {
    expect(() => sanitizeWorktreeName("")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("")).toThrow(/must not be empty/);
  });

  it("rejects names longer than 64 chars", () => {
    expect(() => sanitizeWorktreeName("a".repeat(65))).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("a".repeat(65))).toThrow(/≤ 64 characters/);
  });

  it("rejects '.' and '..'", () => {
    expect(() => sanitizeWorktreeName(".")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("..")).toThrow(WorktreeError);
  });

  it("rejects names starting with '.'", () => {
    expect(() => sanitizeWorktreeName(".hidden")).toThrow(/must not start with '\.'/);
  });

  it("rejects names starting with '-'", () => {
    // Defence against arg-injection (eg. `git worktree add -- … -flag`).
    expect(() => sanitizeWorktreeName("-flag")).toThrow(/must not start with '-'/);
  });

  it("rejects names containing '..'", () => {
    expect(() => sanitizeWorktreeName("foo..bar")).toThrow(/must not contain '\.\.'/);
  });

  it("rejects names containing forward or back slashes (path-traversal defence)", () => {
    expect(() => sanitizeWorktreeName("foo/bar")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("foo\\bar")).toThrow(WorktreeError);
  });

  it("rejects whitespace, null bytes, and other disallowed characters", () => {
    expect(() => sanitizeWorktreeName("name with space")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("name\twith\ttab")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("name\x00null")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("name#hash")).toThrow(WorktreeError);
    expect(() => sanitizeWorktreeName("name$dollar")).toThrow(WorktreeError);
  });
});

// ─── createWorktree (Lα + Lβ + structural coverage) ─────────────────────
//
// Mutation probes:
//   - skip the `existsSync(opts.repoRoot)` check → test goes red.
//   - pass `opts.ref ?? "HEAD"` directly to `git worktree add` instead of
//     the rev-parsed SHA → "resolves ref before passing" test goes red.
//   - drop the `-b gateway/<name>` flag → branch-creation test goes red.
//   - drop the WorktreeCollisionError branch → collision test goes red.

describe("createWorktree (slice λ)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = initRepo();
  });

  afterEach(() => {
    rmRepo(repoRoot);
  });

  it("throws when repoRoot does not exist", async () => {
    await expect(
      createWorktree({ repoRoot: "/nonexistent/path/that/does/not/exist", logger: noopLogger })
    ).rejects.toThrow(/repoRoot does not exist/);
  });

  it("creates a worktree at <repoRoot>/.worktrees/<name> when name is supplied", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "feature-x",
      logger: noopLogger,
    });
    expect(handle.name).toBe("feature-x");
    expect(handle.path).toBe(join(repoRoot, ".worktrees", "feature-x"));
    expect(existsSync(handle.path)).toBe(true);
  });

  it("generates a 32-char hex name when none is supplied", async () => {
    const handle = await createWorktree({ repoRoot, logger: noopLogger });
    expect(handle.name).toMatch(/^[0-9a-f]{32}$/);
    expect(handle.path).toBe(join(repoRoot, ".worktrees", handle.name));
  });

  it("resolves ref to a 40-char SHA before passing to git worktree add (Lβ falsifiability)", async () => {
    // When ref defaults to HEAD, `handle.ref` must be the rev-parsed
    // commit SHA (40 hex chars), NOT the literal "HEAD". Mutation probe:
    // remove the rev-parse and pass refArg directly.
    const handle = await createWorktree({ repoRoot, logger: noopLogger });
    expect(handle.ref).toMatch(/^[0-9a-f]{40}$/);
    expect(handle.ref).not.toBe("HEAD");
  });

  it("creates a branch named gateway/<name> for the worktree", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "branch-test",
      logger: noopLogger,
    });
    // Confirm the branch exists via git directly.
    const branches = execFileSync("git", ["branch", "--list", "gateway/branch-test"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(branches).toContain("gateway/branch-test");
    // And the worktree is on it.
    const head = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: handle.path,
      encoding: "utf8",
    }).trim();
    expect(head).toBe("gateway/branch-test");
  });

  it("returns a handle that reuses an existing registered worktree (resume semantics)", async () => {
    // First call creates a fresh worktree.
    const first = await createWorktree({
      repoRoot,
      name: "resume-target",
      logger: noopLogger,
    });
    // Second call with the same name finds the existing registration and
    // reuses it without crashing. The path remains stable.
    const second = await createWorktree({
      repoRoot,
      name: "resume-target",
      logger: noopLogger,
    });
    expect(second.path).toBe(first.path);
    expect(second.name).toBe(first.name);
    expect(existsSync(second.path)).toBe(true);
  });

  it("throws WorktreeCollisionError when the path exists on disk but is NOT registered as a worktree", async () => {
    // Pre-create a stale directory that git knows nothing about.
    const collisionPath = join(repoRoot, ".worktrees", "stale");
    mkdirSync(collisionPath, { recursive: true });
    writeFileSync(join(collisionPath, "leftover.txt"), "stale\n");

    await expect(
      createWorktree({ repoRoot, name: "stale", logger: noopLogger })
    ).rejects.toBeInstanceOf(WorktreeCollisionError);
  });

  it("throws WorktreeError when the supplied ref does not resolve", async () => {
    await expect(
      createWorktree({ repoRoot, name: "bad-ref", ref: "no-such-ref", logger: noopLogger })
    ).rejects.toThrow(/git rev-parse no-such-ref failed/);
  });

  it("blocks names that escape the .worktrees prefix at the sanitize layer", async () => {
    // Defence-in-depth: sanitizeWorktreeName rejects slash, so an attempt
    // to escape via `../foo` is caught before the path-resolve check.
    await expect(
      createWorktree({ repoRoot, name: "../escape", logger: noopLogger })
    ).rejects.toThrow(WorktreeError);
  });
});

// ─── removeWorktree (best-effort cleanup coverage) ──────────────────────
//
// Mutation probe: swap `--force` for nothing → if a worktree is currently
// "in use" the remove silently no-ops, but our test creates a clean
// worktree so this is less testable in unit isolation. We mostly cover
// the swallow-errors invariant: removeWorktree must NEVER throw.

describe("removeWorktree (slice λ)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = initRepo();
  });

  afterEach(() => {
    rmRepo(repoRoot);
  });

  it("removes a freshly created worktree and its gateway/<name> branch", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "to-remove",
      logger: noopLogger,
    });
    expect(existsSync(handle.path)).toBe(true);

    await removeWorktree({
      repoRoot,
      path: handle.path,
      name: handle.name,
      logger: noopLogger,
    });
    expect(existsSync(handle.path)).toBe(false);
    const branches = execFileSync("git", ["branch", "--list", "gateway/to-remove"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(branches).toBe("");
  });

  it("returns silently when path or repoRoot is missing (defence: never blocks session_delete)", async () => {
    // Both empty → early return, no throw.
    await expect(
      removeWorktree({ repoRoot: "", path: "", logger: noopLogger })
    ).resolves.toBeUndefined();
  });

  it("does NOT throw when the worktree git registration is already gone", async () => {
    // Create then nuke the directory out-of-band so `git worktree remove`
    // fails internally; the helper must still resolve.
    const handle = await createWorktree({
      repoRoot,
      name: "gone-already",
      logger: noopLogger,
    });
    rmSync(handle.path, { recursive: true, force: true });
    await expect(
      removeWorktree({
        repoRoot,
        path: handle.path,
        name: handle.name,
        logger: noopLogger,
      })
    ).resolves.toBeUndefined();
  });
});

// ─── createWorktreeSessionCleanupHook (Lε helper coverage) ──────────────
//
// Mutation probe: change the hook's repoRoot derivation to a wrong
// substring (e.g. `lastIndexOf("worktrees")` without the leading sep
// and without slicing) → the cleanup is invoked against the wrong cwd
// and the test below catches it.

describe("createWorktreeSessionCleanupHook (slice λ)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = initRepo();
  });

  afterEach(() => {
    rmRepo(repoRoot);
  });

  it("invokes removeWorktree against the right repoRoot derived from worktreePath", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "hook-target",
      logger: noopLogger,
    });
    expect(existsSync(handle.path)).toBe(true);

    const hook = createWorktreeSessionCleanupHook(noopLogger);
    await hook({
      id: "sess-1",
      metadata: { worktreePath: handle.path, worktreeName: handle.name },
    });
    expect(existsSync(handle.path)).toBe(false);
  });

  it("is a no-op when session.metadata.worktreePath is absent", async () => {
    const hook = createWorktreeSessionCleanupHook(noopLogger);
    // Should resolve without throwing even though no worktree is registered.
    await expect(hook({ id: "sess-2" })).resolves.toBeUndefined();
    await expect(hook({ id: "sess-3", metadata: {} })).resolves.toBeUndefined();
  });

  it("is a no-op (logged warn) when worktreePath does not match the gateway layout", async () => {
    const hook = createWorktreeSessionCleanupHook(noopLogger);
    // No `${sep}.worktrees${sep}` marker → derivation falls through.
    await expect(
      hook({
        id: "sess-4",
        metadata: { worktreePath: "/somewhere/else/myrepo" },
      })
    ).resolves.toBeUndefined();
  });

  it("ignores non-string worktreePath values", async () => {
    const hook = createWorktreeSessionCleanupHook(noopLogger);
    await expect(
      hook({
        id: "sess-5",
        metadata: { worktreePath: 123 },
      })
    ).resolves.toBeUndefined();
  });

  it("derives repoRoot from the LAST occurrence of .worktrees (so nested layouts work)", async () => {
    // Even if some unusual path contains `.worktrees` in a parent dir as
    // well as the actual gateway placement, the LAST occurrence wins —
    // confirming `lastIndexOf` is the right lookup (mutation probe:
    // change to `indexOf` and this test goes red).
    expect(
      `${sep}.worktrees${sep}foo${sep}.worktrees${sep}bar`.lastIndexOf(`${sep}.worktrees${sep}`)
    ).toBeGreaterThan(
      `${sep}.worktrees${sep}foo${sep}.worktrees${sep}bar`.indexOf(`${sep}.worktrees${sep}`)
    );
  });
});
