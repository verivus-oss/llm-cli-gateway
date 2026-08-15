import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProviderWorkspacePath } from "../workspace-registry.js";
import type { WorkspaceRegistry, WorkspaceRepo } from "../workspace-registry.js";
import type { CliType } from "../provider-types.js";

// Issue #270: this predicate is the entire cursor review trust boundary. If it
// returns true for a directory the operator did not register for cursor, the
// design collapses back to the implicit grant it replaced.
//
// Round 3 of review (codex and grok, independently): every trust test injected
// a fake predicate, so NOTHING exercised the real one. A prefix bug, a missing
// separator, or the nested-repo over-grant would have left the whole suite
// green. These tests use real directories and real symlinks for that reason.

let dir: string;

function repo(path: string, providers: CliType[]): WorkspaceRepo {
  return {
    alias: `alias-${path.replace(/\W/g, "")}`,
    path,
    providers,
    allowAddDir: false,
  } as WorkspaceRepo;
}

function registry(repos: WorkspaceRepo[]): WorkspaceRegistry {
  return {
    enabled: true,
    defaultAlias: null,
    allowUnregisteredWorkingDir: false,
    repos,
    allowedRoots: [],
    sources: { configFile: null },
  } as WorkspaceRegistry;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gtwy-270-grant-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("issue #270: the real cursor workspace-grant predicate", () => {
  it("grants the registered root itself", () => {
    const root = join(dir, "repo");
    mkdirSync(root);
    expect(isProviderWorkspacePath(registry([repo(root, ["cursor"])]), "cursor", root)).toBe(true);
  });

  it("grants a gateway worktree beneath the registered root", () => {
    // The reason containment exists at all: a gateway worktree lives at
    // <repoRoot>/.worktrees/<uuid> and is never itself a registered path.
    const root = join(dir, "repo");
    const worktree = join(root, ".worktrees", "abc-123");
    mkdirSync(worktree, { recursive: true });
    expect(isProviderWorkspacePath(registry([repo(root, ["cursor"])]), "cursor", worktree)).toBe(
      true
    );
  });

  it("refuses a repo whose providers omit cursor", () => {
    const root = join(dir, "repo");
    mkdirSync(root);
    expect(isProviderWorkspacePath(registry([repo(root, ["claude"])]), "cursor", root)).toBe(false);
  });

  it("refuses a prefix sibling that is not actually contained", () => {
    // /x/app must not grant /x/app-evil. This is why the check appends the
    // path separator rather than using a bare startsWith.
    const root = join(dir, "app");
    const sibling = join(dir, "app-evil");
    mkdirSync(root);
    mkdirSync(sibling);
    expect(isProviderWorkspacePath(registry([repo(root, ["cursor"])]), "cursor", sibling)).toBe(
      false
    );
  });

  it("refuses a symlink pointing out of the registered root", () => {
    // Both sides are realpath-resolved, so a link inside a registered tree
    // cannot present an unregistered tree as registered.
    const root = join(dir, "repo");
    const outside = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    const link = join(root, "escape");
    symlinkSync(outside, link);
    expect(isProviderWorkspacePath(registry([repo(root, ["cursor"])]), "cursor", link)).toBe(false);
  });

  it("refuses a cwd that does not exist", () => {
    const root = join(dir, "repo");
    mkdirSync(root);
    expect(
      isProviderWorkspacePath(registry([repo(root, ["cursor"])]), "cursor", join(dir, "gone"))
    ).toBe(false);
  });

  it("ignores a registered repo whose own path cannot be resolved", () => {
    // One unreadable registration must not abort the scan and hide a later
    // legitimate match.
    const root = join(dir, "repo");
    mkdirSync(root);
    const reg = registry([repo(join(dir, "missing"), ["cursor"]), repo(root, ["cursor"])]);
    expect(isProviderWorkspacePath(reg, "cursor", root)).toBe(true);
  });

  it("REFUSES when a nearer registration withholds cursor from a parent that allows it", () => {
    // THE ROUND-3 REGRESSION. An any-match containment check returned true here
    // because the permissive parent matched. The nearest enclosing registration
    // is the one the operator meant to apply to this directory.
    const parent = join(dir, "monorepo");
    const child = join(parent, "secret");
    mkdirSync(child, { recursive: true });
    const reg = registry([repo(parent, ["cursor", "claude"]), repo(child, ["claude"])]);
    expect(isProviderWorkspacePath(reg, "cursor", child)).toBe(false);
    // ...and the parent itself is unaffected.
    expect(isProviderWorkspacePath(reg, "cursor", parent)).toBe(true);
  });

  it("grants when a nearer registration ADDS cursor under a parent that omits it", () => {
    // The same rule in the other direction, so nearest-match is not just a
    // one-way deny: a narrower registration can also widen.
    const parent = join(dir, "monorepo");
    const child = join(parent, "reviewed");
    mkdirSync(child, { recursive: true });
    const reg = registry([repo(parent, ["claude"]), repo(child, ["cursor"])]);
    expect(isProviderWorkspacePath(reg, "cursor", child)).toBe(true);
    expect(isProviderWorkspacePath(reg, "cursor", parent)).toBe(false);
  });

  it("refuses everything when no workspace is registered", () => {
    const root = join(dir, "repo");
    mkdirSync(root);
    expect(isProviderWorkspacePath(registry([]), "cursor", root)).toBe(false);
  });
});
