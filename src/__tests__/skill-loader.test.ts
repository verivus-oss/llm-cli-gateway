import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadGatewaySkills } from "../skill-loader.js";
import { noopLogger } from "../logger.js";

function skillContent(name: string, description: string): string {
  return ["---", `name: ${name}`, `description: ${description}`, "---", "", `# ${name}`, ""].join(
    "\n"
  );
}

function writeSkill(root: string, name: string, description: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  const content = skillContent(name, description);
  writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
  return content;
}

describe("loadGatewaySkills", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "skill-loader-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads bundled skills plus configured external skills", () => {
    const bundled = path.join(tempDir, "bundled");
    const external = path.join(tempDir, "external");
    writeSkill(bundled, "bundled-skill", "Bundled skill");
    writeSkill(external, "external-skill", "External skill");

    const skills = loadGatewaySkills({
      bundledSkillsDir: bundled,
      configuredPaths: [external],
      userSkillsDir: path.join(tempDir, "missing-user"),
      logger: noopLogger,
    });

    expect(skills.map(skill => skill.name)).toEqual(["bundled-skill", "external-skill"]);
    expect(skills.find(skill => skill.name === "external-skill")?.source).toBe("external");
  });

  it("lets later external roots override bundled skills by name", () => {
    const bundled = path.join(tempDir, "bundled");
    const user = path.join(tempDir, "user");
    writeSkill(bundled, "same-skill", "Bundled description");
    writeSkill(user, "same-skill", "User description");

    const skills = loadGatewaySkills({
      bundledSkillsDir: bundled,
      userSkillsDir: user,
      logger: noopLogger,
    });

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "same-skill",
      description: "User description",
      source: "external",
    });
  });

  it("loads only manifest-listed skills whose SKILL.md hash matches", () => {
    const bundled = path.join(tempDir, "bundled");
    const pack = path.join(tempDir, "pack");
    mkdirSync(bundled, { recursive: true });
    const good = writeSkill(pack, "good-skill", "Good skill");
    writeSkill(pack, "bad-skill", "Bad skill");
    writeSkill(pack, "unlisted-skill", "Unlisted skill");
    const goodHash = createHash("sha256").update(good, "utf8").digest("hex");

    writeFileSync(
      path.join(pack, "skill-pack.json"),
      JSON.stringify(
        {
          name: "test-pack",
          version: "1.0.0",
          skills: [
            { name: "good-skill", sha256: goodHash },
            { name: "bad-skill", sha256: "0".repeat(64) },
          ],
        },
        null,
        2
      ),
      "utf8"
    );

    const skills = loadGatewaySkills({
      bundledSkillsDir: bundled,
      configuredPaths: [pack],
      userSkillsDir: path.join(tempDir, "missing-user"),
      logger: noopLogger,
    });

    expect(skills.map(skill => skill.name)).toEqual(["good-skill"]);
    expect(skills[0]?.pack).toMatchObject({
      name: "test-pack",
      version: "1.0.0",
      verified: true,
    });
  });

  it("parses LLM_GATEWAY_SKILLS_PATH using the host path delimiter", () => {
    const bundled = path.join(tempDir, "bundled");
    const first = path.join(tempDir, "first");
    const second = path.join(tempDir, "second");
    writeSkill(bundled, "bundled-skill", "Bundled skill");
    writeSkill(first, "first-skill", "First skill");
    writeSkill(second, "second-skill", "Second skill");

    const skills = loadGatewaySkills({
      bundledSkillsDir: bundled,
      envSkillsPath: [first, second].join(path.delimiter),
      userSkillsDir: path.join(tempDir, "missing-user"),
      logger: noopLogger,
    });

    expect(skills.map(skill => skill.name)).toEqual([
      "bundled-skill",
      "first-skill",
      "second-skill",
    ]);
  });
});
