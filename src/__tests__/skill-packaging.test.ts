// Every skill registered as an MCP resource must actually ship.
//
// package.json#files listed 9 of the 17 skills, so a development tree served 17
// skills:// resources while an npm install served 9. The eight missing ones were
// the per-provider guides plus gateway-restart-surfaces, which is exactly the
// material an operator driving seven unfamiliar CLIs needs. Nothing failed
// loudly: the published build simply never registered them, and CLAUDE.md
// described them as shipped.
//
// This ratchet fails the build when a skill is added to the tree without being
// added to the package, rather than waiting for someone to diff a live server
// against a published one.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SKILLS_DIR = join(REPO_ROOT, ".agents", "skills");

function skillsOnDisk(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map(entry => entry.name)
    .sort();
}

function skillsDeclaredInPackage(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    files: string[];
  };
  return pkg.files
    .filter(entry => entry.startsWith(".agents/skills/") && entry.endsWith("/SKILL.md"))
    .map(entry => entry.slice(".agents/skills/".length, -"/SKILL.md".length))
    .sort();
}

describe("skill packaging", () => {
  it("ships every skill that exists in the tree", () => {
    const onDisk = skillsOnDisk();
    const declared = skillsDeclaredInPackage();
    const missing = onDisk.filter(skill => !declared.includes(skill));
    expect(
      missing,
      `these skills exist but package.json#files does not ship them, so npm consumers ` +
        `will not see their skills:// resources: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("does not declare a skill that no longer exists", () => {
    const onDisk = skillsOnDisk();
    const declared = skillsDeclaredInPackage();
    const stale = declared.filter(skill => !onDisk.includes(skill));
    expect(
      stale,
      `package.json#files references skills that are gone: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("covers all seven providers with a per-provider skill", () => {
    const onDisk = skillsOnDisk();
    for (const provider of ["claude", "codex", "gemini", "grok", "mistral", "devin", "cursor"]) {
      expect(onDisk, `no provider-${provider} skill`).toContain(`provider-${provider}`);
    }
  });
});
