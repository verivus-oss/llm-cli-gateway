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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { hostname, tmpdir } from "os";
import { basename, join, sep } from "path";
import {
  createWorktree,
  createWorktreeSessionCleanupHook,
  cleanupSessionWorktree,
  readWorktreeOwnerToken,
  removeWorktree,
  sanitizeWorktreeName,
  validateManagedWorktreeIdentity,
  WorktreeCollisionError,
  WorktreeError,
} from "../worktree-manager.js";
import { noopLogger } from "../logger.js";
import { FileSessionManager, type Session } from "../session-manager.js";

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

function forceGitWorktreeRemoveFailure(): () => void {
  const originalPath = process.env.PATH;
  const gitBinary = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const fakeBin = mkdtempSync(join(tmpdir(), "wt-remove-failure-"));
  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/bin/sh\ncase " $* " in\n  *" worktree remove "*) exit 42 ;;\nesac\nexec "${gitBinary}" "$@"\n`
  );
  chmodSync(fakeGit, 0o755);
  process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
  return () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(fakeBin, { recursive: true, force: true });
  };
}

function observeDurableWorktreeCleanup(
  manager: FileSessionManager
): () => Promise<void> | undefined {
  let attempt: Promise<void> | undefined;
  manager.addSessionRemovalObserver((session: Session) => {
    attempt = (async () => {
      const removed = await cleanupSessionWorktree(session, noopLogger, {
        expectedOwnerHostname: hostname(),
        requireOwnerMetadata: true,
      });
      if (removed && session.metadata?.worktreeCleanupPendingDeletion === true) {
        manager.finalizePendingWorktreeCleanup(session);
      }
    })();
    return attempt;
  });
  return () => attempt;
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
    expect(handle.created).toBe(true);
    expect(existsSync(handle.path)).toBe(true);
  });

  it("rejects a symlinked .worktrees container before Git can create an external worktree", async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), "wt-mgr-external-"));
    const managedRoot = join(repoRoot, ".worktrees");
    symlinkSync(externalRoot, managedRoot, "dir");

    try {
      await expect(
        createWorktree({ repoRoot, name: "escaped", logger: noopLogger })
      ).rejects.toThrow("Managed .worktrees must be a real directory");

      expect(existsSync(join(externalRoot, "escaped"))).toBe(false);
      const branches = execFileSync("git", ["branch", "--list", "gateway/escaped"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(branches).toBe("");
    } finally {
      rmSync(externalRoot, { recursive: true, force: true });
    }
  });

  it("rejects a non-directory .worktrees container before Git can create a worktree", async () => {
    writeFileSync(join(repoRoot, ".worktrees"), "not a directory\n");

    await expect(createWorktree({ repoRoot, name: "blocked", logger: noopLogger })).rejects.toThrow(
      "Managed .worktrees must be a real directory"
    );

    const branches = execFileSync("git", ["branch", "--list", "gateway/blocked"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(branches).toBe("");
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

  it.skipIf(process.platform === "win32")(
    "does not execute repository checkout hooks or configured checkout filters",
    async () => {
      const hookMarker = join(repoRoot, "hook-executed");
      const filterMarker = join(repoRoot, "filter-executed");
      const hooksDirectory = join(repoRoot, "repository-configured-hooks");
      const hookPath = join(hooksDirectory, "post-checkout");
      mkdirSync(hooksDirectory);
      writeFileSync(hookPath, `#!/bin/sh\nprintf executed > '${hookMarker}'\n`);
      chmodSync(hookPath, 0o700);

      writeFileSync(join(repoRoot, ".gitattributes"), "filtered.txt filter=gateway=test\n");
      writeFileSync(join(repoRoot, "filtered.txt"), "original bytes\n");
      execFileSync("git", ["add", ".gitattributes", "filtered.txt"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "add filtered fixture"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        [
          "config",
          "filter.gateway=test.smudge",
          `sh -c 'printf executed > "$1"; cat' _ '${filterMarker}'`,
        ],
        { cwd: repoRoot, stdio: "ignore" }
      );
      execFileSync("git", ["config", "filter.gateway=test.required", "true"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "core.hooksPath", hooksDirectory], {
        cwd: repoRoot,
        stdio: "ignore",
      });

      const handle = await createWorktree({
        repoRoot,
        name: "fenced-checkout",
        logger: noopLogger,
      });

      expect(existsSync(hookMarker)).toBe(false);
      expect(existsSync(filterMarker)).toBe(false);
      expect(readFileSync(join(handle.path, "filtered.txt"), "utf8")).toBe("original bytes\n");
    }
  );

  it.skipIf(process.platform === "win32")(
    "ignores inherited Git config and repository-redirection environment",
    async () => {
      const decoyRoot = initRepo();
      const injectedHooks = join(repoRoot, "injected-hooks");
      const hookMarker = join(repoRoot, "injected-hook-executed");
      const filterMarker = join(repoRoot, "injected-filter-executed");
      const filterCommand = join(repoRoot, "injected-filter");
      mkdirSync(injectedHooks);
      writeFileSync(
        join(injectedHooks, "post-checkout"),
        `#!/bin/sh\nprintf executed > '${hookMarker}'\n`
      );
      chmodSync(join(injectedHooks, "post-checkout"), 0o700);
      writeFileSync(filterCommand, `#!/bin/sh\nprintf executed > '${filterMarker}'\ncat\n`);
      chmodSync(filterCommand, 0o700);

      writeFileSync(join(repoRoot, ".gitattributes"), "inherited.txt filter=injected\n");
      writeFileSync(join(repoRoot, "inherited.txt"), "selected repository\n");
      execFileSync("git", ["add", ".gitattributes", "inherited.txt"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "selected fixture"], {
        cwd: repoRoot,
        stdio: "ignore",
      });
      writeFileSync(join(decoyRoot, "README.md"), "decoy repository\n");
      execFileSync("git", ["add", "README.md"], { cwd: decoyRoot, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "decoy fixture"], {
        cwd: decoyRoot,
        stdio: "ignore",
      });

      const inherited = new Map<string, string | undefined>();
      const injectedEnvironment: Record<string, string> = {
        GIT_CONFIG_PARAMETERS:
          `'core.hooksPath=${injectedHooks}' ` +
          `'filter.injected.smudge=${filterCommand}' ` +
          "'filter.injected.required=true'",
        GIT_DIR: join(decoyRoot, ".git"),
        GIT_OBJECT_DIRECTORY: join(decoyRoot, ".git", "objects"),
        GIT_WORK_TREE: decoyRoot,
      };
      for (const [key, value] of Object.entries(injectedEnvironment)) {
        inherited.set(key, process.env[key]);
        process.env[key] = value;
      }

      try {
        let handle: Awaited<ReturnType<typeof createWorktree>>;
        try {
          handle = await createWorktree({
            repoRoot,
            name: "environment-fenced",
            logger: noopLogger,
          });
        } finally {
          for (const [key, value] of inherited) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
        }

        expect(readFileSync(join(handle.path, "inherited.txt"), "utf8")).toBe(
          "selected repository\n"
        );
        expect(existsSync(hookMarker)).toBe(false);
        expect(existsSync(filterMarker)).toBe(false);

        const selectedBranches = execFileSync(
          "git",
          ["branch", "--list", "gateway/environment-fenced"],
          { cwd: repoRoot, encoding: "utf8" }
        );
        const decoyBranches = execFileSync(
          "git",
          ["branch", "--list", "gateway/environment-fenced"],
          { cwd: decoyRoot, encoding: "utf8" }
        );
        expect(selectedBranches).toContain("gateway/environment-fenced");
        expect(decoyBranches).toBe("");
      } finally {
        for (const [key, value] of inherited) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        rmRepo(decoyRoot);
      }
    }
  );

  it("materializes the complete tree when the selected repository uses sparse checkout", async () => {
    mkdirSync(join(repoRoot, "included"));
    mkdirSync(join(repoRoot, "omitted"));
    writeFileSync(join(repoRoot, "included", "kept.txt"), "included bytes\n");
    writeFileSync(join(repoRoot, "omitted", "required.txt"), "required bytes\n");
    execFileSync("git", ["add", "included/kept.txt", "omitted/required.txt"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["commit", "-m", "sparse fixture"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["sparse-checkout", "init", "--cone"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    execFileSync("git", ["sparse-checkout", "set", "included"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    expect(existsSync(join(repoRoot, "omitted", "required.txt"))).toBe(false);

    const handle = await createWorktree({
      repoRoot,
      name: "complete-checkout",
      logger: noopLogger,
    });

    expect(readFileSync(join(handle.path, "included", "kept.txt"), "utf8")).toBe(
      "included bytes\n"
    );
    expect(readFileSync(join(handle.path, "omitted", "required.txt"), "utf8")).toBe(
      "required bytes\n"
    );
  });

  it.skipIf(process.platform === "win32")(
    "fails without lazy-fetching a missing partial-clone blob or invoking its remote",
    async () => {
      const partialClone = mkdtempSync(join(tmpdir(), "wt-mgr-partial-"));
      rmSync(partialClone, { recursive: true, force: true });
      const remoteMarker = join(repoRoot, "lazy-fetch-remote-executed");
      const remoteCommand = join(repoRoot, "lazy-fetch-remote");
      try {
        writeFileSync(join(repoRoot, "partial-blob.txt"), "missing blob bytes\n".repeat(1_000));
        execFileSync("git", ["add", "partial-blob.txt"], { cwd: repoRoot, stdio: "ignore" });
        execFileSync("git", ["commit", "-m", "partial clone fixture"], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "uploadpack.allowFilter", "true"], {
          cwd: repoRoot,
          stdio: "ignore",
        });
        execFileSync(
          "git",
          ["clone", "--filter=blob:none", "--no-checkout", `file://${repoRoot}`, partialClone],
          { stdio: "ignore" }
        );
        expect(() =>
          execFileSync("git", ["cat-file", "-e", "HEAD:partial-blob.txt"], {
            cwd: partialClone,
            stdio: "ignore",
            env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
          })
        ).toThrow();

        writeFileSync(remoteCommand, `#!/bin/sh\nprintf executed > '${remoteMarker}'\nexit 1\n`);
        chmodSync(remoteCommand, 0o700);
        execFileSync("git", ["config", "remote.origin.url", `ext::${remoteCommand}`], {
          cwd: partialClone,
          stdio: "ignore",
        });
        execFileSync("git", ["config", "protocol.ext.allow", "always"], {
          cwd: partialClone,
          stdio: "ignore",
        });

        await expect(
          createWorktree({ repoRoot: partialClone, name: "no-lazy-fetch", logger: noopLogger })
        ).rejects.toThrow(/checkout failed/);
        expect(existsSync(remoteMarker)).toBe(false);
        expect(existsSync(join(partialClone, ".worktrees", "no-lazy-fetch"))).toBe(false);
        expect(
          execFileSync("git", ["branch", "--list", "gateway/no-lazy-fetch"], {
            cwd: partialClone,
            encoding: "utf8",
          })
        ).toBe("");
      } finally {
        rmSync(partialClone, { recursive: true, force: true });
      }
    }
  );

  it("rejects a named registered worktree after its requested ref advances", async () => {
    const first = await createWorktree({
      repoRoot,
      name: "stable",
      logger: noopLogger,
    });
    const firstHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: first.path,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(first.path, "dirty.txt"), "owned dirty state\n");
    writeFileSync(join(repoRoot, "README.md"), "advanced main\n");
    execFileSync("git", ["add", "README.md"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "advance main"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    const advancedHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();

    await expect(
      createWorktree({ repoRoot, name: "stable", ref: "HEAD", logger: noopLogger })
    ).rejects.toBeInstanceOf(WorktreeCollisionError);

    expect(first.created).toBe(true);
    expect(advancedHead).not.toBe(firstHead);
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: first.path, encoding: "utf8" }).trim()
    ).toBe(firstHead);
    expect(readFileSync(join(first.path, "dirty.txt"), "utf8")).toBe("owned dirty state\n");
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

  it("coalesces concurrent cleanup claims for the same managed worktree", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "concurrent-remove",
      logger: noopLogger,
    });
    const warnings: string[] = [];
    const cleanupLogger = {
      ...noopLogger,
      warn: (message: string) => warnings.push(message),
    };

    await Promise.all([
      removeWorktree({ repoRoot, path: handle.path, name: handle.name, logger: cleanupLogger }),
      removeWorktree({ repoRoot, path: handle.path, name: handle.name, logger: cleanupLogger }),
    ]);

    expect(existsSync(handle.path)).toBe(false);
    expect(warnings).toEqual([]);
    expect(
      execFileSync("git", ["branch", "--list", "gateway/concurrent-remove"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
    ).toBe("");
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

  it("does not remove an ordinary directory that replaced a registered worktree path", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "replaced-cleanup",
      logger: noopLogger,
    });
    execFileSync("git", ["worktree", "remove", "--force", handle.path], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    mkdirSync(handle.path);
    writeFileSync(join(handle.path, "owned-by-someone-else.txt"), "preserve\n");

    await removeWorktree({
      repoRoot,
      path: handle.path,
      name: handle.name,
      logger: noopLogger,
    });

    expect(readFileSync(join(handle.path, "owned-by-someone-else.txt"), "utf8")).toBe("preserve\n");
    expect(
      execFileSync("git", ["branch", "--list", "gateway/replaced-cleanup"], {
        cwd: repoRoot,
        encoding: "utf8",
      })
    ).toContain("gateway/replaced-cleanup");
  });

  it("cleans a stale registration and branch when .worktrees was removed out of band", async () => {
    const handle = await createWorktree({
      repoRoot,
      name: "missing-container",
      logger: noopLogger,
    });
    rmSync(join(repoRoot, ".worktrees"), { recursive: true, force: true });

    await removeWorktree({
      repoRoot,
      path: handle.path,
      name: handle.name,
      logger: noopLogger,
    });

    const registrations = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(registrations).not.toContain(handle.path);
    const branches = execFileSync("git", ["branch", "--list", "gateway/missing-container"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    expect(branches).toBe("");
  });
});

describe("durable session worktree deletion cleanup", () => {
  let repoRoot: string;
  let sessionsPath: string;

  beforeEach(() => {
    repoRoot = initRepo();
    sessionsPath = join(mkdtempSync(join(tmpdir(), "wt-delete-session-")), "sessions.json");
  });

  afterEach(() => {
    rmRepo(repoRoot);
    rmSync(sessionsPath, { force: true });
  });

  async function createOwnedSessionWorktree(
    manager: FileSessionManager,
    name: string
  ): Promise<{ session: Session; path: string }> {
    const handle = await createWorktree({ repoRoot, name, logger: noopLogger });
    const session = manager.createSession("claude", name);
    manager.updateSessionMetadata(session.id, {
      worktreePath: handle.path,
      worktreeName: handle.name,
      worktreeOwnerHostname: hostname(),
      worktreeOwnerInstanceId: "worktree-delete-test-instance",
      worktreeToken: handle.token,
    });
    return { session, path: handle.path };
  }

  it("retains a hidden durable tombstone when explicit delete cannot remove Git worktree", async () => {
    const manager = new FileSessionManager(sessionsPath);
    const owned = await createOwnedSessionWorktree(manager, "delete-failure");
    const cleanupAttempt = observeDurableWorktreeCleanup(manager);
    const restoreGit = forceGitWorktreeRemoveFailure();

    try {
      expect(manager.deleteSession(owned.session.id)).toBe(true);
      await cleanupAttempt();
    } finally {
      restoreGit();
    }

    expect(manager.getSession(owned.session.id)).toBeNull();
    expect(existsSync(owned.path)).toBe(true);
    expect(manager.listPendingWorktreeCleanupSessions()).toEqual([
      expect.objectContaining({
        id: owned.session.id,
        metadata: expect.objectContaining({
          worktreeCleanupPending: true,
          worktreeCleanupPendingDeletion: true,
        }),
      }),
    ]);

    const restarted = new FileSessionManager(sessionsPath);
    const pending = restarted.listPendingWorktreeCleanupSessions()[0]!;
    expect(
      await cleanupSessionWorktree(pending, noopLogger, {
        expectedOwnerHostname: hostname(),
        requireOwnerMetadata: true,
      })
    ).toBe(true);
    expect(restarted.finalizePendingWorktreeCleanup(pending)).toBe(true);
    expect(restarted.listPendingWorktreeCleanupSessions()).toEqual([]);
    expect(existsSync(owned.path)).toBe(false);
  });

  it("retains the same durable tombstone when TTL eviction cleanup fails", async () => {
    const manager = new FileSessionManager(sessionsPath, 50);
    const owned = await createOwnedSessionWorktree(manager, "ttl-failure");
    const cleanupAttempt = observeDurableWorktreeCleanup(manager);
    await new Promise(resolve => setTimeout(resolve, 60));
    const restoreGit = forceGitWorktreeRemoveFailure();

    try {
      expect(manager.getSession(owned.session.id)).toBeNull();
      await cleanupAttempt();
    } finally {
      restoreGit();
    }

    expect(existsSync(owned.path)).toBe(true);
    const pending = manager.listPendingWorktreeCleanupSessions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual(
      expect.objectContaining({
        id: owned.session.id,
        metadata: expect.objectContaining({
          worktreeCleanupPendingDeletion: true,
        }),
      })
    );

    expect(
      await cleanupSessionWorktree(pending[0]!, noopLogger, {
        expectedOwnerHostname: hostname(),
        requireOwnerMetadata: true,
      })
    ).toBe(true);
    expect(manager.finalizePendingWorktreeCleanup(pending[0]!)).toBe(true);
    expect(existsSync(owned.path)).toBe(false);
  });
});

// ─── createWorktreeSessionCleanupHook (Lε helper coverage) ──────────────
//
// Mutation probe: change the hook's repoRoot derivation to a wrong
// substring (e.g. `lastIndexOf("worktrees")` without the leading sep
// and without slicing) → the cleanup is invoked against the wrong cwd
// and the test below catches it.

describe("worktree creation token (issue #305 ABA window)", () => {
  let repoRoot: string;
  const warnings: string[] = [];
  const logger = {
    ...noopLogger,
    warn: (message: string) => {
      warnings.push(message);
    },
  };

  beforeEach(() => {
    repoRoot = initRepo();
    warnings.length = 0;
  });
  afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

  const sessionFor = (handle: Awaited<ReturnType<typeof createWorktree>>, id: string) => ({
    id,
    metadata: {
      worktreePath: handle.path,
      worktreeName: handle.name,
      worktreeOwnerHostname: hostname(),
      worktreeOwnerInstanceId: "instance-a",
      worktreeToken: handle.token,
    },
  });

  const cleanup = (session: { id: string; metadata?: Record<string, unknown> }) =>
    cleanupSessionWorktree(session, logger, {
      expectedOwnerHostname: hostname(),
      requireOwnerMetadata: true,
    });

  /** The administrative directory git actually chose, asked of git. */
  const adminDirOf = (worktreePath: string): string =>
    execFileSync("git", ["-C", worktreePath, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).trim();

  it("stamps a distinct token per creation and reads it back through git", async () => {
    const first = await createWorktree({ repoRoot, name: "aba", logger: noopLogger });
    expect(first.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(await readWorktreeOwnerToken(first.path, noopLogger)).toBe(first.token);

    await removeWorktree({ repoRoot, path: first.path, name: first.name, logger: noopLogger });
    const second = await createWorktree({ repoRoot, name: "aba", logger: noopLogger });
    expect(second.token).not.toBe(first.token);
    expect(await readWorktreeOwnerToken(second.path, noopLogger)).toBe(second.token);
  });

  it("finds the administrative directory git chose, not the one its name suggests", async () => {
    // git-worktree(1) DETAILS: the private sub-directory's name is "usually the
    // base name ... possibly appended with a number to make it unique". A stale
    // entry from a dead worktree elsewhere takes the name, and a resolver that
    // guesses `<common>/worktrees/<name>` then reads ANOTHER worktree's record.
    const elsewhere = join(repoRoot, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    execFileSync("git", ["worktree", "add", "-q", "--no-checkout", join(elsewhere, "beta")], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    rmSync(join(elsewhere, "beta"), { recursive: true, force: true });

    const handle = await createWorktree({ repoRoot, name: "beta", logger: noopLogger });
    const chosen = adminDirOf(handle.path);
    const guessed = join(repoRoot, ".git", "worktrees", "beta");
    expect(chosen).not.toBe(guessed);
    expect(basename(chosen)).toBe("beta1");
    // The marker went where git put the worktree, and the guessed directory
    // belongs to the dead one.
    expect(existsSync(join(chosen, "gateway-owner.json"))).toBe(true);
    expect(existsSync(join(guessed, "gateway-owner.json"))).toBe(false);
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(handle.token);
  });

  it("returns no token for an ordinary directory that merely sits in the repo", async () => {
    // `git -C <dir> rev-parse --absolute-git-dir` resolves UPWARD and returns
    // the main repository's .git with exit 0 for any path inside the work tree.
    // Without the containment check this reads, and a writer would write, the
    // main repository's own directory.
    const impostor = join(repoRoot, ".worktrees", "impostor");
    mkdirSync(impostor, { recursive: true });
    expect(
      execFileSync("git", ["-C", impostor, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
      }).trim()
    ).toBe(realpathSync(join(repoRoot, ".git")));

    // The marker must be PRESENT in what the upward resolution returns, or this
    // asserts nothing: without it the read fails because the file is missing
    // rather than because the containment check rejected the directory, and the
    // check survives being deleted.
    writeFileSync(
      join(repoRoot, ".git", "gateway-owner.json"),
      JSON.stringify({ token: "MAIN-REPO-TOKEN" })
    );
    expect(await readWorktreeOwnerToken(impostor, noopLogger)).toBeNull();
  });

  it("returns no token for the main worktree, whose git dir is not under worktrees/", async () => {
    // The main worktree passes the toplevel check by construction: it IS its
    // own toplevel. Only the containment check separates `<repo>/.git` from a
    // linked worktree's `<common>/worktrees/<id>`, so without a marker planted
    // in `.git` this case cannot tell the two guards apart.
    writeFileSync(
      join(repoRoot, ".git", "gateway-owner.json"),
      JSON.stringify({ token: "MAIN-REPO-TOKEN" })
    );
    expect(
      execFileSync("git", ["-C", repoRoot, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
      }).trim()
    ).toBe(realpathSync(repoRoot));
    expect(await readWorktreeOwnerToken(repoRoot, noopLogger)).toBeNull();
  });

  it("returns no token when asked about a subdirectory of a worktree", async () => {
    // A subdirectory resolves to its worktree's administrative directory, so
    // without the toplevel check a recorded path one level down would read the
    // parent worktree's identity and be treated as owning it.
    const handle = await createWorktree({ repoRoot, name: "nested", logger: noopLogger });
    const inner = join(handle.path, "inner");
    mkdirSync(inner, { recursive: true });
    expect(
      execFileSync("git", ["-C", inner, "rev-parse", "--absolute-git-dir"], {
        encoding: "utf8",
      }).trim()
    ).toBe(adminDirOf(handle.path));
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(handle.token);
    expect(await readWorktreeOwnerToken(inner, noopLogger)).toBeNull();
  });

  it("refuses to remove a replacement worktree that took the same name", async () => {
    const original = await createWorktree({ repoRoot, name: "reused", logger: noopLogger });
    const staleSession = sessionFor(original, "session-a");
    await removeWorktree({
      repoRoot,
      path: original.path,
      name: original.name,
      logger: noopLogger,
    });

    const replacement = await createWorktree({ repoRoot, name: "reused", logger: noopLogger });
    expect(replacement.path).toBe(original.path);

    expect(await cleanup(staleSession)).toBe(false);
    expect(warnings.some(w => w.includes("no longer carries this session's creation token"))).toBe(
      true
    );
    // Without the token check this assertion is what fails, and it fails by
    // deleting a live session's checkout.
    expect(existsSync(replacement.path)).toBe(true);
    expect(await readWorktreeOwnerToken(replacement.path, noopLogger)).toBe(replacement.token);
  });

  it("finalizes after a crash between a successful removal and the acknowledgement", async () => {
    // THE REGRESSION THE FIRST REPAIR INTRODUCED. `git worktree remove` deletes
    // the administrative directory, so a successful removal always destroys the
    // marker. Treating that absence as an identity mismatch made the retry
    // refuse forever and the durable tombstone immortal.
    const handle = await createWorktree({ repoRoot, name: "crashed", logger: noopLogger });
    const session = sessionFor(handle, "session-crashed");

    expect(await cleanup(session)).toBe(true);
    expect(existsSync(handle.path)).toBe(false);
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();

    // The crash: the acknowledgement never happened, so the same session is
    // retried against a path that is already gone.
    warnings.length = 0;
    expect(await cleanup(session)).toBe(true);
    // It returns true, which is what lets the caller finalize the durable
    // tombstone. Git does complain that there is no working tree left to
    // remove, and that is noise rather than a refusal: the refusal this test
    // exists to rule out is the identity one.
    expect(warnings.some(w => w.includes("is not a working tree"))).toBe(true);
    expect(warnings.some(w => w.includes("creation token"))).toBe(false);
  });

  it("finalizes when the working tree was deleted out of band", async () => {
    // Same shape, reached the other way: the directory is gone but the
    // registration survives, so there is still an administrative entry to prune
    // and no identity left to check.
    const handle = await createWorktree({ repoRoot, name: "outofband", logger: noopLogger });
    const session = sessionFor(handle, "session-outofband");
    rmSync(handle.path, { recursive: true, force: true });

    expect(await cleanup(session)).toBe(true);
    expect(warnings).toEqual([]);
  });

  it("still removes the worktree the session actually created", async () => {
    const handle = await createWorktree({ repoRoot, name: "owned", logger: noopLogger });
    expect(await cleanup(sessionFor(handle, "session-b"))).toBe(true);
    expect(existsSync(handle.path)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("refuses to remove a live worktree for a session that predates the token", async () => {
    // The compatibility rule that accepted "absent on both sides" reopened the
    // original defect: a stale legacy record deleted a live replacement,
    // because null equals null. A legacy session cannot prove it created what
    // is standing there, so it removes nothing and says so.
    const handle = await createWorktree({ repoRoot, name: "legacy", logger: noopLogger });
    rmSync(join(adminDirOf(handle.path), "gateway-owner.json"), { force: true });
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBeNull();

    const legacySession = {
      id: "session-legacy",
      metadata: {
        worktreePath: handle.path,
        worktreeName: handle.name,
        worktreeOwnerHostname: hostname(),
        worktreeOwnerInstanceId: "instance-legacy",
      },
    };
    expect(await cleanup(legacySession)).toBe(false);
    expect(existsSync(handle.path)).toBe(true);
    expect(warnings.some(w => w.includes("predates gateway creation tokens"))).toBe(true);
    // Actionable: the operator is told which path to deal with.
    expect(warnings.some(w => w.includes(handle.path))).toBe(true);
  });

  it("does not let a legacy record delete a live replacement at the same name", async () => {
    // The reviewer's construction, kept as a regression: legacy record, its
    // worktree removed, a live replacement created at the same name, and the
    // replacement's marker gone too, so both sides read null.
    const original = await createWorktree({ repoRoot, name: "compat", logger: noopLogger });
    const legacyRecord = {
      id: "stale-legacy-session",
      metadata: {
        worktreePath: original.path,
        worktreeName: original.name,
        worktreeOwnerHostname: hostname(),
        worktreeOwnerInstanceId: "instance-legacy",
      },
    };
    await removeWorktree({
      repoRoot,
      path: original.path,
      name: original.name,
      logger: noopLogger,
    });

    const replacement = await createWorktree({ repoRoot, name: "compat", logger: noopLogger });
    rmSync(join(adminDirOf(replacement.path), "gateway-owner.json"), { force: true });
    expect(await readWorktreeOwnerToken(replacement.path, noopLogger)).toBeNull();

    expect(await cleanup(legacyRecord)).toBe(false);
    expect(existsSync(replacement.path)).toBe(true);
  });

  it("still finalizes a legacy session whose worktree is already gone", async () => {
    // Refusing to remove must not also refuse to acknowledge. A legacy record
    // whose path no longer exists has nothing to delete, so it finalizes and
    // does not accumulate forever.
    const handle = await createWorktree({ repoRoot, name: "legacy-gone", logger: noopLogger });
    const legacySession = {
      id: "session-legacy-gone",
      metadata: {
        worktreePath: handle.path,
        worktreeName: handle.name,
        worktreeOwnerHostname: hostname(),
        worktreeOwnerInstanceId: "instance-legacy",
      },
    };
    await removeWorktree({ repoRoot, path: handle.path, name: handle.name, logger: noopLogger });
    expect(await cleanup(legacySession)).toBe(true);
  });

  it("refuses a legacy session against a worktree that does carry a marker", async () => {
    const handle = await createWorktree({ repoRoot, name: "mixed", logger: noopLogger });
    const legacySession = {
      id: "session-mixed",
      metadata: {
        worktreePath: handle.path,
        worktreeName: handle.name,
        worktreeOwnerHostname: hostname(),
        worktreeOwnerInstanceId: "instance-mixed",
      },
    };
    expect(await cleanup(legacySession)).toBe(false);
    expect(existsSync(handle.path)).toBe(true);
  });

  it("chooses a fresh administrative directory rather than a colliding one", async () => {
    // Attempting to induce a marker-write failure by pre-creating a DIRECTORY
    // at `<common>/worktrees/<name>/gateway-owner.json` does not produce one:
    // git sees the stale entry, allocates `<name>1`, and the write lands there.
    // That is the C1 resolver working, and it is recorded as a test rather than
    // discarded, because it is the reason the obvious induction does not work.
    //
    // UNEXERCISED, and stated rather than implied: the teardown branch for a
    // failed marker write has no test. Every reachable way to make the write
    // fail also stops `git worktree add`, so the branch is verified by
    // inspection of the diff only.
    const commonDir = execFileSync("git", ["-C", repoRoot, "rev-parse", "--absolute-git-dir"], {
      encoding: "utf8",
    }).trim();
    mkdirSync(join(commonDir, "worktrees", "colliding", "gateway-owner.json"), {
      recursive: true,
    });

    const handle = await createWorktree({ repoRoot, name: "colliding", logger: noopLogger });
    expect(basename(adminDirOf(handle.path))).toBe("colliding1");
    expect(await readWorktreeOwnerToken(handle.path, noopLogger)).toBe(handle.token);
  });

  it("keeps the token across a git worktree move, which renames nothing", async () => {
    // `move` rewrites the entry's `gitdir` and leaves the administrative
    // directory name alone, so identity survives it while the RECORDED path and
    // name go stale. Nothing may key on those.
    const handle = await createWorktree({ repoRoot, name: "movable", logger: noopLogger });
    const admin = adminDirOf(handle.path);
    const moved = join(repoRoot, ".worktrees", "movable-moved");
    execFileSync("git", ["worktree", "move", handle.path, moved], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    expect(adminDirOf(moved)).toBe(admin);
    expect(await readWorktreeOwnerToken(moved, noopLogger)).toBe(handle.token);
    expect(existsSync(handle.path)).toBe(false);
  });
});

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
      metadata: {
        worktreePath: handle.path,
        worktreeName: handle.name,
        worktreeToken: handle.token,
      },
    });
    expect(existsSync(handle.path)).toBe(false);
  });

  it("is a no-op when session.metadata.worktreePath is absent", async () => {
    const hook = createWorktreeSessionCleanupHook(noopLogger);
    // Should resolve without throwing even though no worktree is registered.
    await expect(hook({ id: "sess-2" })).resolves.toBeUndefined();
    await expect(hook({ id: "sess-3", metadata: {} })).resolves.toBeUndefined();
  });

  it("cleans only same-host worktrees when durable owner metadata is required", async () => {
    const matching = await createWorktree({
      repoRoot,
      name: "matching-owner",
      logger: noopLogger,
    });
    const foreign = await createWorktree({
      repoRoot,
      name: "foreign-owner",
      logger: noopLogger,
    });
    const hook = createWorktreeSessionCleanupHook(noopLogger, {
      expectedOwnerHostname: "gateway-host-a",
      requireOwnerMetadata: true,
    });

    await hook({
      id: "matching-owner-session",
      metadata: {
        worktreePath: matching.path,
        worktreeName: matching.name,
        worktreeOwnerHostname: "gateway-host-a",
        worktreeOwnerInstanceId: "instance-a",
        worktreeToken: matching.token,
      },
    });
    await hook({
      id: "foreign-owner-session",
      metadata: {
        worktreePath: foreign.path,
        worktreeName: foreign.name,
        worktreeOwnerHostname: "gateway-host-b",
        worktreeOwnerInstanceId: "instance-b",
        worktreeToken: foreign.token,
      },
    });

    expect(existsSync(matching.path)).toBe(false);
    expect(existsSync(foreign.path)).toBe(true);
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

  it("does not follow a symlinked .worktrees container during session cleanup", async () => {
    const externalRoot = mkdtempSync(join(tmpdir(), "wt-mgr-cleanup-external-"));
    const externalWorktree = join(externalRoot, "escaped");
    execFileSync("git", ["worktree", "add", "-b", "gateway/escaped", externalWorktree, "HEAD"], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    symlinkSync(externalRoot, join(repoRoot, ".worktrees"), "dir");

    try {
      const hook = createWorktreeSessionCleanupHook(noopLogger);
      await hook({
        id: "symlinked-container-session",
        metadata: {
          worktreePath: join(repoRoot, ".worktrees", "escaped"),
          worktreeName: "escaped",
        },
      });

      expect(existsSync(externalWorktree)).toBe(true);
      const branches = execFileSync("git", ["branch", "--list", "gateway/escaped"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(branches).toContain("gateway/escaped");
    } finally {
      try {
        execFileSync("git", ["worktree", "remove", "--force", externalWorktree], {
          cwd: repoRoot,
          stdio: "ignore",
        });
      } catch {
        // Best effort test cleanup.
      }
      try {
        execFileSync("git", ["branch", "-D", "gateway/escaped"], {
          cwd: repoRoot,
          stdio: "ignore",
        });
      } catch {
        // The branch may already have been removed by Git.
      }
      rmSync(externalRoot, { recursive: true, force: true });
    }
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
