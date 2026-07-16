import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_REVIEW_ARTIFACT_BYTES,
  ReviewScopeError,
  resolveLocalReviewRepositoryRoot,
  resolveReviewScope,
  type ReviewArtifactPayload,
} from "../review-scope.js";

const repositories: string[] = [];

function git(repository: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  }).trim();
}

function createRepository(withSeed = true): string {
  const repository = mkdtempSync(path.join(tmpdir(), "gateway-review-scope-"));
  repositories.push(repository);
  git(repository, "init", "-b", "main");
  git(repository, "config", "user.email", "review@example.invalid");
  git(repository, "config", "user.name", "Review Test");
  if (withSeed) {
    write(repository, "seed.txt", "seed\n");
    git(repository, "add", "seed.txt");
    git(repository, "commit", "-m", "seed");
  }
  return repository;
}

function write(repository: string, relativePath: string, content: string): void {
  const absolutePath = path.join(repository, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function commitAll(repository: string, message: string): string {
  git(repository, "add", "--all");
  git(repository, "commit", "-m", message);
  return git(repository, "rev-parse", "HEAD");
}

function payload(content: string): ReviewArtifactPayload {
  return JSON.parse(content) as ReviewArtifactPayload;
}

/**
 * A Git filter driver whose command records its own execution. Both the script
 * and its sentinel sit outside any worktree, so running it leaves the reviewed
 * repository byte-identical and the sentinel is the only observable.
 */
function createExternalFilter(): { marker: string; filter: string } {
  const directory = mkdtempSync(path.join(tmpdir(), "gateway-review-filter-"));
  repositories.push(directory);
  const marker = path.join(directory, "filter-executed");
  const filter = path.join(directory, "filter-command");
  writeFileSync(filter, `#!/bin/sh\nprintf executed > '${marker}'\ncat\n`);
  chmodSync(filter, 0o700);
  return { marker, filter };
}

function expectScopeError(callback: () => unknown, code: ReviewScopeError["code"]): void {
  try {
    callback();
  } catch (error) {
    expect(error).toBeInstanceOf(ReviewScopeError);
    expect((error as ReviewScopeError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ReviewScopeError with code ${code}`);
}

afterEach(() => {
  for (const repository of repositories.splice(0)) {
    rmSync(repository, { recursive: true, force: true });
  }
});

describe("resolveReviewScope", () => {
  it("promotes a selected local nested directory to its containing Git root", () => {
    const repository = createRepository();
    const nested = path.join(repository, "nested", "directory");
    mkdirSync(nested, { recursive: true });

    expect(resolveLocalReviewRepositoryRoot(nested)).toBe(repository);
  });

  it("rejects a nested authorized folder whose Git root is outside that folder", () => {
    const repository = createRepository();
    const authorizedFolder = path.join(repository, "authorized-folder");
    mkdirSync(authorizedFolder);
    write(repository, "outside-authorized-folder.txt", "must not be captured\n");

    expectScopeError(
      () =>
        resolveReviewScope({
          repositoryPath: authorizedFolder,
          maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
        }),
      "invalid_input"
    );
  });

  it("captures committed, staged, unstaged, and hostile untracked paths on a branch", () => {
    const repository = createRepository();
    const baseSha = git(repository, "rev-parse", "HEAD");
    git(repository, "checkout", "-b", "feature/review");
    write(repository, "committed.txt", "committed\n");
    commitAll(repository, "feature change");
    write(repository, "staged.txt", "staged\n");
    git(repository, "add", "staged.txt");
    write(repository, "seed.txt", "unstaged\n");
    const hostilePath = "new\n-leading.txt";
    write(repository, hostilePath, "untracked exact bytes: 🧪\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.resolvedMode).toBe("branch");
    expect(result.mergeBaseSha).toBe(baseSha);
    expect(result.hasCommittedChanges).toBe(true);
    expect(result.workingTree).toMatchObject({
      hasStagedChanges: true,
      hasUnstagedChanges: true,
      hasUntrackedChanges: true,
      untrackedCount: 1,
    });
    expect(result.files.map(file => file.path)).toEqual([
      "committed.txt",
      hostilePath,
      "seed.txt",
      "staged.txt",
    ]);
    expect(evidence.schemaVersion).toBe("review-evidence.v2");
    expect(evidence.committedPatch.paths).toEqual(["committed.txt"]);
    expect(evidence.committedPatch.content).toContain("committed.txt");
    expect(evidence.stagedPatch.paths).toEqual(["staged.txt"]);
    expect(evidence.stagedPatch.content).toContain("staged.txt");
    expect(evidence.unstagedPatch.paths).toEqual(["seed.txt"]);
    expect(evidence.unstagedPatch.content).toContain("seed.txt");
    expect(evidence.untrackedFiles).toEqual([
      expect.objectContaining({
        path: hostilePath,
        encoding: "utf8",
        content: "untracked exact bytes: 🧪\n",
      }),
    ]);
  });

  it("keeps committed and working-tree segments when a dirty edit reverses the commit", () => {
    const repository = createRepository();
    git(repository, "checkout", "-b", "feature/reversal");
    write(repository, "seed.txt", "committed value\n");
    commitAll(repository, "change seed");
    write(repository, "seed.txt", "seed\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.hasCommittedChanges).toBe(true);
    expect(result.files).toContainEqual({ path: "seed.txt", source: "tracked" });
    expect(evidence.committedPatch.content).toContain("committed value");
    expect(evidence.unstagedPatch.content).toContain("committed value");
  });

  it("keeps a staged change and its worktree-only reversal as independent evidence", () => {
    const repository = createRepository();
    write(repository, "seed.txt", "staged value\n");
    git(repository, "add", "seed.txt");
    write(repository, "seed.txt", "seed\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      mode: "uncommitted",
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.workingTree).toMatchObject({
      hasStagedChanges: true,
      hasUnstagedChanges: true,
    });
    expect(evidence.stagedPatch.paths).toEqual(["seed.txt"]);
    expect(evidence.unstagedPatch.paths).toEqual(["seed.txt"]);
    expect("workingTreePatch" in evidence).toBe(false);
    expect(evidence.stagedPatch.content).toContain("+staged value");
    expect(evidence.unstagedPatch.content).toContain("-staged value");
    expect(evidence.stagedPatch.byteLength).toBe(
      Buffer.byteLength(evidence.stagedPatch.content, "utf8")
    );
    expect(evidence.unstagedPatch.byteLength).toBe(
      Buffer.byteLength(evidence.unstagedPatch.content, "utf8")
    );
    expect(evidence.stagedPatch.sha256).toBe(
      createHash("sha256").update(evidence.stagedPatch.content).digest("hex")
    );
    expect(evidence.unstagedPatch.sha256).toBe(
      createHash("sha256").update(evidence.unstagedPatch.content).digest("hex")
    );
    expect(result.files).toEqual([{ path: "seed.txt", source: "tracked" }]);
  });

  it("overrides in-tree attributes that conceal tracked source changes as binary", () => {
    const repository = createRepository();
    write(repository, ".gitattributes", "* -diff\n");
    commitAll(repository, "concealing attributes");
    git(repository, "checkout", "-b", "feature/readable-review");
    write(repository, "seed.txt", "committed readable source\n");
    commitAll(repository, "tracked source change");
    write(repository, "seed.txt", "working tree readable source\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(evidence.committedPatch.content).toContain("+committed readable source");
    expect(evidence.unstagedPatch.content).toContain("+working tree readable source");
    expect(evidence.committedPatch.content).not.toContain("Binary files");
    expect(evidence.unstagedPatch.content).not.toContain("Binary files");
    expect(result.files).toContainEqual({ path: "seed.txt", source: "tracked" });
  });

  it.skipIf(process.platform === "win32")(
    "captures exact evidence without executing repository-configured Git filters",
    () => {
      const repository = createRepository();
      const cleanMarker = path.join(repository, "clean-filter-executed");
      const processMarker = path.join(repository, "process-filter-executed");
      const smudgeMarker = path.join(repository, "smudge-filter-executed");
      const cleanFilter = path.join(repository, "clean-filter");
      const processFilter = path.join(repository, "process-filter");
      const smudgeFilter = path.join(repository, "smudge-filter");

      write(
        repository,
        ".gitattributes",
        [
          "clean.txt filter=clean=test",
          "process.txt filter=process=test",
          "smudge.txt filter=smudge=test",
          "",
        ].join("\n")
      );
      write(repository, "clean.txt", "clean baseline\n");
      write(repository, "process.txt", "process baseline\n");
      write(repository, "smudge.txt", "smudge baseline\n");
      commitAll(repository, "filter fixtures");

      writeFileSync(cleanFilter, `#!/bin/sh\nprintf executed > '${cleanMarker}'\ncat\n`);
      writeFileSync(processFilter, `#!/bin/sh\nprintf executed > '${processMarker}'\nexit 1\n`);
      writeFileSync(smudgeFilter, `#!/bin/sh\nprintf executed > '${smudgeMarker}'\ncat\n`);
      chmodSync(cleanFilter, 0o700);
      chmodSync(processFilter, 0o700);
      chmodSync(smudgeFilter, 0o700);
      git(repository, "config", "filter.clean=test.clean", cleanFilter);
      git(repository, "config", "filter.clean=test.required", "true");
      git(repository, "config", "filter.process=test.process", processFilter);
      git(repository, "config", "filter.process=test.required", "true");
      git(repository, "config", "filter.smudge=test.smudge", smudgeFilter);
      git(repository, "config", "filter.smudge=test.required", "true");

      write(repository, "clean.txt", "clean exact bytes: 🧪\n");
      write(repository, "process.txt", "process exact bytes\n");
      write(repository, "smudge.txt", "smudge exact bytes\n");
      write(repository, "untracked/new.txt", "untracked exact bytes\n");

      const result = resolveReviewScope({
        repositoryPath: repository,
        mode: "uncommitted",
        maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
      });
      const evidence = payload(result.artifact.content);

      expect(existsSync(cleanMarker)).toBe(false);
      expect(existsSync(processMarker)).toBe(false);
      expect(existsSync(smudgeMarker)).toBe(false);
      expect(evidence.unstagedPatch.content).toContain("+clean exact bytes: 🧪");
      expect(evidence.unstagedPatch.content).toContain("+process exact bytes");
      expect(evidence.unstagedPatch.content).toContain("+smudge exact bytes");
      expect(evidence.untrackedFiles).toContainEqual(
        expect.objectContaining({ path: "untracked/new.txt", content: "untracked exact bytes\n" })
      );
    }
  );

  it.skipIf(process.platform === "win32")(
    "fails without lazy-fetching missing review blobs or invoking the configured remote",
    () => {
      const origin = createRepository();
      write(origin, "partial-blob.txt", "missing review blob bytes\n".repeat(1_000));
      commitAll(origin, "partial clone review fixture");
      git(origin, "config", "uploadpack.allowFilter", "true");
      const partialClone = mkdtempSync(path.join(tmpdir(), "gateway-review-partial-"));
      rmSync(partialClone, { recursive: true, force: true });
      execFileSync(
        "git",
        ["clone", "--filter=blob:none", "--no-checkout", `file://${origin}`, partialClone],
        { stdio: "ignore" }
      );
      repositories.push(partialClone);
      expect(() =>
        execFileSync("git", ["cat-file", "-e", "HEAD:partial-blob.txt"], {
          cwd: partialClone,
          stdio: "ignore",
          env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        })
      ).toThrow();

      const remoteMarker = path.join(partialClone, "lazy-review-remote-executed");
      const remoteCommand = path.join(partialClone, "lazy-review-remote");
      writeFileSync(remoteCommand, `#!/bin/sh\nprintf executed > '${remoteMarker}'\nexit 1\n`);
      chmodSync(remoteCommand, 0o700);
      git(partialClone, "config", "remote.origin.url", `ext::${remoteCommand}`);
      git(partialClone, "config", "protocol.ext.allow", "always");

      expectScopeError(
        () =>
          resolveReviewScope({
            repositoryPath: partialClone,
            mode: "commit",
            base: "HEAD^",
            maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
          }),
        "git_failed"
      );
      expect(existsSync(remoteMarker)).toBe(false);
    }
  );

  it("ignores inherited Git repository redirection and configuration", () => {
    const repository = createRepository();
    const decoy = createRepository();
    write(repository, "selected.txt", "selected evidence\n");
    write(decoy, "decoy.txt", "decoy evidence\n");
    const inherited = new Map<string, string | undefined>();
    const injectedEnvironment: Record<string, string> = {
      GIT_CONFIG_PARAMETERS: "'core.pager=false' 'color.ui=always'",
      GIT_DIR: path.join(decoy, ".git"),
      GIT_OBJECT_DIRECTORY: path.join(decoy, ".git", "objects"),
      GIT_WORK_TREE: decoy,
    };
    for (const [key, value] of Object.entries(injectedEnvironment)) {
      inherited.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      const result = resolveReviewScope({
        repositoryPath: repository,
        mode: "uncommitted",
        maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
      });
      expect(result.artifact.content).toContain("selected.txt");
      expect(result.artifact.content).not.toContain("decoy.txt");
    } finally {
      for (const [key, value] of inherited) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("limits uncommitted mode to HEAD while retaining dirty evidence", () => {
    const repository = createRepository();
    write(repository, "already-committed.txt", "before scope\n");
    const headSha = commitAll(repository, "prior commit");
    write(repository, "dirty.txt", "dirty\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      mode: "uncommitted",
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.baseSha).toBe(headSha);
    expect(result.hasCommittedChanges).toBe(false);
    expect(evidence.committedPatch.byteLength).toBe(0);
    expect(evidence.untrackedFiles.map(file => file.path)).toEqual(["dirty.txt"]);
    expect(result.files.map(file => file.path)).not.toContain("already-committed.txt");
  });

  it("captures only committed evidence in commit mode and honors an explicit base", () => {
    const repository = createRepository();
    const baseSha = git(repository, "rev-parse", "HEAD");
    write(repository, "one.txt", "one\n");
    commitAll(repository, "one");
    write(repository, "two.txt", "two\n");
    commitAll(repository, "two");
    write(repository, "ignored-untracked.txt", "not in commit scope\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      mode: "commit",
      base: baseSha,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.resolvedMode).toBe("commit");
    expect(result.baseSha).toBe(baseSha);
    expect(result.workingTreeIncluded).toBe(false);
    expect(result.hasCommittedChanges).toBe(true);
    expect(evidence.committedPatch.content).toContain("one.txt");
    expect(evidence.committedPatch.content).toContain("two.txt");
    expect(evidence.stagedPatch.byteLength).toBe(0);
    expect(evidence.unstagedPatch.byteLength).toBe(0);
    expect(evidence.untrackedFiles).toEqual([]);
    expect(result.files.map(file => file.path)).not.toContain("ignored-untracked.txt");
  });

  it("falls back to the latest commit in auto mode when the tree is clean", () => {
    const repository = createRepository();
    const baseSha = git(repository, "rev-parse", "HEAD");
    write(repository, "latest.txt", "latest committed evidence\n");
    const headSha = commitAll(repository, "latest commit");

    const result = resolveReviewScope({
      repositoryPath: repository,
      mode: "auto",
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.resolvedMode).toBe("commit");
    expect(result.baseSha).toBe(baseSha);
    expect(result.headSha).toBe(headSha);
    expect(result.workingTreeIncluded).toBe(false);
    expect(result.hasCommittedChanges).toBe(true);
    expect(evidence.committedPatch.content).toContain("latest.txt");
    expect(evidence.stagedPatch.byteLength).toBe(0);
    expect(evidence.unstagedPatch.byteLength).toBe(0);
    expect(evidence.untrackedFiles).toEqual([]);
  });

  it("uses the empty tree for an unborn repository", () => {
    const repository = createRepository(false);
    write(repository, "staged.txt", "staged before first commit\n");
    git(repository, "add", "staged.txt");
    write(repository, "untracked.txt", "untracked before first commit\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(result.resolvedMode).toBe("uncommitted");
    expect(result.headSha).toBeNull();
    expect(result.hasCommittedChanges).toBe(false);
    expect(evidence.stagedPatch.paths).toEqual(["staged.txt"]);
    expect(evidence.stagedPatch.content).toContain("staged.txt");
    expect(evidence.unstagedPatch.byteLength).toBe(0);
    expect(evidence.untrackedFiles.map(file => file.path)).toEqual(["untracked.txt"]);
  });

  it("applies literal path filters to committed and dirty evidence", () => {
    const repository = createRepository();
    git(repository, "checkout", "-b", "feature/filter");
    write(repository, "included/a.txt", "included\n");
    write(repository, "excluded/b.txt", "excluded\n");
    commitAll(repository, "both paths");
    write(repository, "included/dirty.txt", "included dirty\n");
    write(repository, "excluded/dirty.txt", "excluded dirty\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      paths: ["included"],
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });

    expect(result.files.map(file => file.path)).toEqual(["included/a.txt", "included/dirty.txt"]);
    expect(result.artifact.content).not.toContain("excluded/b.txt");
    expect(result.artifact.content).not.toContain("excluded/dirty.txt");
  });

  it("treats the repository-root path filter as the whole repository", () => {
    const repository = createRepository();
    write(repository, "root-filter.txt", "included\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      paths: ["."],
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });

    expect(result.files).toContainEqual({ path: "root-filter.txt", source: "untracked" });
  });

  it("records an untracked symlink as its link target instead of refusing the review", () => {
    const repository = createRepository();
    symlinkSync("seed.txt", path.join(repository, "untracked-link"));

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(evidence.untrackedFiles).toEqual([
      expect.objectContaining({
        path: "untracked-link",
        entryType: "symlink",
        encoding: "utf8",
        content: "seed.txt",
      }),
    ]);
    expect(result.files).toContainEqual({ path: "untracked-link", source: "untracked" });
  });

  it("records a broken untracked symlink without resolving its missing target", () => {
    const repository = createRepository();
    symlinkSync("missing-target", path.join(repository, "broken-untracked-link"));

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(evidence.untrackedFiles).toEqual([
      expect.objectContaining({
        path: "broken-untracked-link",
        entryType: "symlink",
        content: "missing-target",
      }),
    ]);
  });

  it("records an escaping untracked symlink as a target string without reading the target", () => {
    const repository = createRepository();
    const outside = mkdtempSync(path.join(tmpdir(), "gateway-review-outside-"));
    repositories.push(outside);
    const secret = path.join(outside, "secret.txt");
    writeFileSync(secret, "SECRET-TARGET-BYTES-MUST-NOT-BE-CAPTURED\n");
    symlinkSync(secret, path.join(repository, "escaping-link"));

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(evidence.untrackedFiles).toEqual([
      expect.objectContaining({
        path: "escaping-link",
        entryType: "symlink",
        content: secret,
      }),
    ]);
    expect(result.artifact.content).not.toContain("SECRET-TARGET-BYTES-MUST-NOT-BE-CAPTURED");
  });

  it.runIf(process.platform !== "win32")(
    "records an untracked symlink to a FIFO without opening the FIFO",
    () => {
      const repository = createRepository();
      // Git cannot track a FIFO, so it is ignored to keep the special-entry
      // refusal out of this test's way. The symlink to it stays untracked.
      write(repository, ".gitignore", "target-pipe\n");
      commitAll(repository, "ignore the pipe");
      execFileSync("mkfifo", [path.join(repository, "target-pipe")]);
      symlinkSync("target-pipe", path.join(repository, "link-to-pipe"));

      // A capture that opened the link would block forever on the FIFO.
      const result = resolveReviewScope({
        repositoryPath: repository,
        maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
      });
      const evidence = payload(result.artifact.content);

      expect(evidence.untrackedFiles).toEqual([
        expect.objectContaining({
          path: "link-to-pipe",
          entryType: "symlink",
          content: "target-pipe",
        }),
      ]);
    }
  );

  it("keeps regular untracked file evidence free of the symlink marker", () => {
    const repository = createRepository();
    write(repository, "plain.txt", "plain\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });
    const evidence = payload(result.artifact.content);

    expect(evidence.untrackedFiles).toHaveLength(1);
    expect(evidence.untrackedFiles[0]).not.toHaveProperty("entryType");
  });

  it.runIf(process.platform !== "win32")("refuses untracked FIFOs without opening them", () => {
    const repository = createRepository();
    execFileSync("mkfifo", [path.join(repository, "untracked-pipe")]);

    expectScopeError(
      () =>
        resolveReviewScope({
          repositoryPath: repository,
          maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
        }),
      "unsafe_untracked_type"
    );
  });

  it("fails closed if tracked evidence changes during the race recheck", () => {
    const repository = createRepository();
    write(repository, "seed.txt", "before recheck\n");

    expectScopeError(
      () =>
        resolveReviewScope(
          {
            repositoryPath: repository,
            maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
          },
          {
            beforeSnapshotRecheck: () => write(repository, "seed.txt", "after recheck\n"),
          }
        ),
      "snapshot_changed"
    );
  });

  it.skipIf(process.platform === "win32")(
    "suppresses a filter driver installed after the capture context was created",
    () => {
      const repository = createRepository();
      // Driver and sentinel live outside the worktree, so execution is observed
      // directly instead of as a side effect on the captured evidence.
      const { marker, filter } = createExternalFilter();

      // The attribute is present from the start; only the driver definition
      // arrives late, so there is nothing to discover when the context is built.
      write(repository, ".gitattributes", "*.txt filter=late\n");
      commitAll(repository, "attributes only");
      write(repository, "seed.txt", "worktree change that must be diffed\n");

      const result = resolveReviewScope(
        {
          repositoryPath: repository,
          mode: "uncommitted",
          maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
        },
        {
          // Fires once the capture context exists and before any evidence is
          // read: exactly the window a cached override probe would leave open.
          beforeEvidenceCapture: () => {
            git(repository, "config", "filter.late.clean", filter);
            git(repository, "config", "filter.late.required", "true");
          },
        }
      );
      const evidence = payload(result.artifact.content);

      expect(existsSync(marker)).toBe(false);
      expect(evidence.unstagedPatch.content).toContain("+worktree change that must be diffed");
    }
  );

  it.skipIf(process.platform === "win32")(
    "suppresses a filter driver that is withdrawn again before the capture returns",
    () => {
      const repository = createRepository();
      const { marker, filter } = createExternalFilter();
      write(repository, ".gitattributes", "*.txt filter=transient\n");
      commitAll(repository, "attributes only");
      write(repository, "seed.txt", "transient window change\n");

      const result = resolveReviewScope(
        {
          repositoryPath: repository,
          mode: "uncommitted",
          maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
        },
        {
          beforeEvidenceCapture: () => {
            git(repository, "config", "filter.transient.clean", filter);
            git(repository, "config", "filter.transient.required", "true");
          },
          // Withdrawn before the recheck, so a digest comparison taken at the
          // end would match and report nothing at all.
          beforeSnapshotRecheck: () => {
            git(repository, "config", "--unset", "filter.transient.clean");
            git(repository, "config", "--unset", "filter.transient.required");
          },
        }
      );

      expect(existsSync(marker)).toBe(false);
      expect(result.artifact.complete).toBe(true);
    }
  );

  it("spends one batched ignore probe per directory level instead of one per entry", () => {
    const repository = createRepository();
    // 20 sibling directories at a single depth level under one parent.
    for (let index = 0; index < 20; index++) {
      write(repository, `parent/child${index}/file.txt`, "content\n");
    }

    const commands: string[][] = [];
    resolveReviewScope(
      { repositoryPath: repository, maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES },
      { onGitCommand: args => commands.push([...args]) }
    );
    const ignoreProbes = commands.filter(args => args[0] === "check-ignore");

    // Depth is 3 (parent, child*, file.txt) and the capture runs twice, so the
    // probe count tracks depth, never the 20 entries in the wide level.
    expect(ignoreProbes.length).toBeLessThanOrEqual(8);
    for (const probe of ignoreProbes) {
      expect(probe).toContain("--stdin");
    }
  });

  it.runIf(process.platform !== "win32")(
    "batched ignore decisions match a per-path check-ignore oracle",
    () => {
      const repository = createRepository();
      write(repository, ".gitignore", "ignored-dir/\nnested/ignored-leaf/\n*.log\n");
      write(repository, "kept-dir/keep.txt", "keep\n");
      write(repository, "ignored-dir/inner/x.txt", "x\n");
      write(repository, "nested/kept-leaf/y.txt", "y\n");
      write(repository, "nested/ignored-leaf/z.txt", "z\n");
      commitAll(repository, "ignore fixture");

      // Ground truth: the per-path form this batching replaced. It must run
      // without GIT_LITERAL_PATHSPECS, which check-ignore rejects outright.
      const oracleSaysIgnored = (relativePath: string): boolean => {
        try {
          execFileSync("git", ["check-ignore", "--no-index", "--quiet", "--", relativePath], {
            cwd: repository,
            stdio: "ignore",
            env: {
              ...process.env,
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: "/dev/null",
              LC_ALL: "C",
            },
          });
          return true;
        } catch {
          return false;
        }
      };

      // A FIFO is refused only in a directory the walk actually descends into,
      // so refusal is an exact observable of the batched ignore decision.
      const directories = [
        "kept-dir",
        "ignored-dir/inner",
        "nested/kept-leaf",
        "nested/ignored-leaf",
      ];
      for (const directory of directories) {
        const fifo = path.join(repository, directory, "probe-pipe");
        execFileSync("mkfifo", [fifo]);
        let refused = false;
        try {
          resolveReviewScope({
            repositoryPath: repository,
            maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
          });
        } catch (error) {
          expect(error).toBeInstanceOf(ReviewScopeError);
          expect((error as ReviewScopeError).code).toBe("unsafe_untracked_type");
          refused = true;
        }
        rmSync(fifo, { force: true });

        const ignored = oracleSaysIgnored(`${directory}/probe-pipe`);
        expect({ directory, refused }).toEqual({ directory, refused: !ignored });
      }

      // The fixture must actually exercise both branches of that oracle.
      expect(oracleSaysIgnored("ignored-dir/inner/probe-pipe")).toBe(true);
      expect(oracleSaysIgnored("kept-dir/probe-pipe")).toBe(false);
    }
  );

  it.runIf(process.platform !== "win32")(
    "does not refuse a FIFO inside an ignored directory",
    () => {
      const repository = createRepository();
      write(repository, ".gitignore", "build/\n");
      mkdirSync(path.join(repository, "build"), { recursive: true });
      commitAll(repository, "ignore build output");
      execFileSync("mkfifo", [path.join(repository, "build", "socket-like")]);
      write(repository, "real-change.txt", "reviewable\n");

      const result = resolveReviewScope({
        repositoryPath: repository,
        maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
      });

      expect(result.files).toContainEqual({ path: "real-change.txt", source: "untracked" });
    }
  );

  it("treats an entry named like pathspec magic as a literal path", () => {
    const repository = createRepository();
    write(repository, ".gitignore", "ignored-dir/\n");
    mkdirSync(path.join(repository, "ignored-dir"), { recursive: true });
    commitAll(repository, "ignore fixture");
    // Not ignored: the literal directory name merely looks like magic for
    // "ignored-dir" anchored at the top of the tree.
    write(repository, ":(top)ignored-dir/inside.txt", "must be reviewed\n");

    const result = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });

    expect(result.files).toContainEqual({
      path: ":(top)ignored-dir/inside.txt",
      source: "untracked",
    });
  });

  it("accounts for exact UTF-8 artifact bytes and never truncates", () => {
    const repository = createRepository();
    write(repository, "unicode.txt", "界🙂".repeat(80));
    const complete = resolveReviewScope({
      repositoryPath: repository,
      maxArtifactBytes: MAX_REVIEW_ARTIFACT_BYTES,
    });

    expect(complete.artifact.byteLength).toBe(Buffer.byteLength(complete.artifact.content, "utf8"));
    expect(complete.artifact.sha256).toBe(
      createHash("sha256").update(complete.artifact.content).digest("hex")
    );
    expect(complete.artifact.complete).toBe(true);
    expectScopeError(
      () =>
        resolveReviewScope({
          repositoryPath: repository,
          maxArtifactBytes: complete.artifact.byteLength - 1,
        }),
      "artifact_too_large"
    );
  });

  it("refuses an untracked file before reading beyond the raw byte budget", () => {
    const repository = createRepository();
    write(repository, "oversized.txt", "x".repeat(2_000));

    expectScopeError(
      () => resolveReviewScope({ repositoryPath: repository, maxArtifactBytes: 1_000 }),
      "artifact_too_large"
    );
  });
});
