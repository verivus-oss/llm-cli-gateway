// Which agent skills ship, and which deliberately do not.
//
// The original version of this ratchet asserted that every git-tracked skill
// must be listed in package.json#files. That premise was wrong, and shipping on
// it tripped the release audit's shipped-skill leak scan: all seven
// `provider-*` skills are MAINTAINER documentation for this repository. Their
// own descriptions say "Track and maintain the upstream <X> CLI contract", and
// their bodies instruct the reader to edit `src/upstream-contracts.ts`. They
// reference internal source paths and identifiers that must not reach a
// consumer, and the audit is right to reject them.
//
// So the invariant is not "everything ships". It is: the workflow skills ship,
// and two categories are excluded on purpose.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const REPO_ROOT = new URL("../..", import.meta.url).pathname;
const SKILLS_DIR = join(REPO_ROOT, ".agents", "skills");

/**
 * Skills excluded from the package on purpose.
 *
 * `provider-*`: maintainer docs for updating this repo's upstream CLI
 * contracts. They cite `src/upstream-contracts.ts`, `UPSTREAM_CLI_CONTRACTS`
 * and `validateUpstreamCliArgs`, which the release audit's leak scan rejects in
 * a shipped artifact, correctly.
 *
 * `gateway-restart-surfaces`: gitignored host-local operational guidance. It is
 * not committed, so it cannot ship regardless.
 */
function isDeliberatelyUnshipped(skill: string): boolean {
  return skill.startsWith("provider-") || skill === "gateway-restart-surfaces";
}

/** Skills git tracks. `npm pack` and a directory listing both also see untracked files. */
function trackedSkills(): string[] {
  return execFileSync("git", ["ls-files", ".agents/skills/*/SKILL.md"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map(path => path.slice(".agents/skills/".length, -"/SKILL.md".length))
    .sort();
}

function skillsOnDisk(): string[] {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(SKILLS_DIR, entry.name, "SKILL.md")))
    .map(entry => entry.name)
    .sort();
}

function declaredInPackage(): string[] {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    files: string[];
  };
  return pkg.files
    .filter(entry => entry.startsWith(".agents/skills/") && entry.endsWith("/SKILL.md"))
    .map(entry => entry.slice(".agents/skills/".length, -"/SKILL.md".length))
    .sort();
}

describe("skill packaging", () => {
  it("ships every tracked skill that is not deliberately excluded", () => {
    const shouldShip = trackedSkills().filter(s => !isDeliberatelyUnshipped(s));
    const declared = declaredInPackage();
    const missing = shouldShip.filter(s => !declared.includes(s));
    expect(
      missing,
      `these skills are tracked and not excluded, but package.json#files omits them, ` +
        `so npm consumers never see their skills:// resources: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("never ships a maintainer or host-local skill", () => {
    // Shipping one of these is what tripped the release audit's leak scan, since
    // they cite internal source paths and identifiers.
    const leaked = declaredInPackage().filter(isDeliberatelyUnshipped);
    expect(
      leaked,
      `these are maintainer or host-local skills and must not be packaged: ${leaked.join(", ")}`
    ).toEqual([]);
  });

  it("does not declare a skill that is not tracked", () => {
    const tracked = trackedSkills();
    const stale = declaredInPackage().filter(s => !tracked.includes(s));
    expect(stale, `package.json#files references untracked skills: ${stale.join(", ")}`).toEqual(
      []
    );
  });

  it("keeps a per-provider maintainer skill for all seven providers", () => {
    // These do not ship, but they must exist: they are how a contract gets
    // updated when a vendor releases.
    const onDisk = skillsOnDisk();
    for (const provider of ["claude", "codex", "gemini", "grok", "mistral", "devin", "cursor"]) {
      expect(onDisk, `no provider-${provider} maintainer skill`).toContain(`provider-${provider}`);
    }
  });
});
