import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureJobReplayContext } from "../job-replay-context.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "job-replay-context-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("job replay context", () => {
  it("hashes only the effective Codex instruction prefix and records repository HEAD", () => {
    const root = tempRoot();
    const home = join(root, "home");
    const repo = join(root, "repo");
    mkdirSync(join(home, ".codex"), { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(home, ".codex", "AGENTS.md"), "global\n");
    const project = Buffer.alloc(40 * 1024, "p");
    writeFileSync(join(repo, "AGENTS.md"), project);
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "add", "AGENTS.md"]);
    execFileSync("git", [
      "-C",
      repo,
      "-c",
      "user.name=Replay Test",
      "-c",
      "user.email=replay@example.invalid",
      "commit",
      "-qm",
      "fixture",
    ]);
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();

    const captured = captureJobReplayContext(
      "codex",
      { scope: "caller", path: repo, workspaceAlias: null },
      false,
      { home }
    );
    expect(captured?.repositoryHead).toBe(head);
    expect(captured?.instructionFiles).toHaveLength(2);
    expect(captured?.instructionFiles.reduce((sum, entry) => sum + entry.effectiveBytes, 0)).toBe(
      32 * 1024
    );
    const repositoryEntry = captured?.instructionFiles[1];
    expect(repositoryEntry?.truncated).toBe(true);
    const effectivePrefix = project.subarray(0, 32 * 1024 - Buffer.byteLength("global\n"));
    expect(repositoryEntry?.sha256).toBe(
      createHash("sha256").update(effectivePrefix).digest("hex")
    );
  });

  it("records only global instructions for a neutral job", () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".gemini"), { recursive: true });
    writeFileSync(join(home, ".gemini", "GEMINI.md"), "global only\n");
    const captured = captureJobReplayContext(
      "gemini",
      { scope: "neutral", path: null, workspaceAlias: null },
      false,
      { home }
    );
    expect(captured?.repositoryHead).toBeNull();
    expect(captured?.instructionFiles.map(entry => entry.path)).toEqual([
      join(home, ".gemini", "GEMINI.md"),
    ]);
  });

  it("withholds Kit context and refuses an oversized instruction file", () => {
    const root = tempRoot();
    const home = join(root, "home");
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "CLAUDE.md"), Buffer.alloc(1024 * 1024 + 1, "x"));
    const cwd = { scope: "neutral" as const, path: null, workspaceAlias: null };
    expect(captureJobReplayContext("claude", cwd, true, { home })).toBeNull();
    expect(
      captureJobReplayContext("claude", cwd, false, { home })?.instructionFiles[0]
    ).toMatchObject({
      status: "too_large",
      sha256: null,
      effectiveBytes: 0,
    });
  });
});
