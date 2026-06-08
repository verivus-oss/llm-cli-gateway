import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkspace, loadWorkspaceRegistry } from "../workspace-registry.js";

describe("workspace creation", () => {
  let tempDir: string;
  let rootDir: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "workspace-create-test-"));
    rootDir = join(tempDir, "projects");
    mkdirSync(rootDir);
    configPath = join(tempDir, "config.toml");
    writeFileSync(
      configPath,
      [
        "[workspaces]",
        "",
        "[[workspaces.allowed_roots]]",
        'alias = "projects"',
        `path = "${rootDir}"`,
        "allow_register_existing_git_repos = true",
        "allow_create_directories = true",
        "allow_init_git_repos = true",
        "max_create_depth = 2",
        "",
      ].join("\n")
    );
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates and registers a local git repository under an allowed root", () => {
    const repo = createWorkspace({
      alias: "client",
      rootAlias: "projects",
      slug: "client",
      kind: "git",
      setDefault: true,
      configPath,
    });

    expect(repo.alias).toBe("client");
    expect(existsSync(join(repo.path, ".git"))).toBe(true);
    const registry = loadWorkspaceRegistry(undefined, configPath);
    expect(registry.defaultAlias).toBe("client");
    expect(registry.repos[0]?.path).toBe(repo.path);
  });

  it("creates a folder workspace without running git init", () => {
    const repo = createWorkspace({
      alias: "folder",
      rootAlias: "projects",
      slug: "folder",
      kind: "folder",
      configPath,
    });

    expect(existsSync(repo.path)).toBe(true);
    expect(existsSync(join(repo.path, ".git"))).toBe(false);
  });

  it("rejects absolute paths, traversal, denied dirs, and existing non-empty targets", () => {
    expect(() =>
      createWorkspace({
        alias: "abs",
        rootAlias: "projects",
        slug: "/tmp/abs",
        kind: "folder",
        configPath,
      })
    ).toThrow(/relative/);

    expect(() =>
      createWorkspace({
        alias: "walk",
        rootAlias: "projects",
        slug: "../walk",
        kind: "folder",
        configPath,
      })
    ).toThrow(/traverse/);

    expect(() =>
      createWorkspace({
        alias: "sshdir",
        rootAlias: "projects",
        slug: ".ssh",
        kind: "folder",
        configPath,
      })
    ).toThrow(/not allowed/);

    const occupied = join(rootDir, "occupied");
    mkdirSync(occupied);
    writeFileSync(join(occupied, "README.md"), "occupied");
    expect(readdirSync(occupied)).toHaveLength(1);
    expect(() =>
      createWorkspace({
        alias: "occupied",
        rootAlias: "projects",
        slug: "occupied",
        kind: "git",
        configPath,
      })
    ).toThrow(/not empty/);
  });

  it("does not provide a network clone creation kind", () => {
    expect(() =>
      createWorkspace({
        alias: "clone",
        rootAlias: "projects",
        slug: "clone",
        kind: "clone" as "git",
        configPath,
      })
    ).toThrow();
  });
});
