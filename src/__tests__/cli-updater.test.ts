import { describe, expect, it } from "vitest";
import { buildCliUpgradePlan, runCliUpgrade } from "../cli-updater.js";

describe("cli updater", () => {
  it("uses self-update for Claude latest", () => {
    const plan = buildCliUpgradePlan("claude");

    expect(plan.command).toBe("claude");
    expect(plan.args).toEqual(["update"]);
    expect(plan.strategy).toBe("self-update");
  });

  it("uses self-update for Codex latest", () => {
    const plan = buildCliUpgradePlan("codex", "latest");

    expect(plan.command).toBe("codex");
    expect(plan.args).toEqual(["update"]);
    expect(plan.strategy).toBe("self-update");
  });

  it("uses npm global install for Gemini", () => {
    const plan = buildCliUpgradePlan("gemini", "latest");

    expect(plan.command).toBe("npm");
    expect(plan.args).toEqual(["install", "-g", "@google/gemini-cli@latest"]);
    expect(plan.strategy).toBe("npm-global-install");
  });

  it("uses npm global install for explicit Codex targets", () => {
    const plan = buildCliUpgradePlan("codex", "1.2.3");

    expect(plan.command).toBe("npm");
    expect(plan.args).toEqual(["install", "-g", "@openai/codex@1.2.3"]);
  });

  it("uses self-update for Grok latest", () => {
    const plan = buildCliUpgradePlan("grok");

    expect(plan.command).toBe("grok");
    expect(plan.args).toEqual(["update"]);
    expect(plan.strategy).toBe("self-update");
  });

  it("uses self-update with explicit version for Grok pinned targets", () => {
    const plan = buildCliUpgradePlan("grok", "0.1.210");

    expect(plan.command).toBe("grok");
    expect(plan.args).toEqual(["update", "--version", "0.1.210"]);
    expect(plan.strategy).toBe("self-update");
  });

  it("rejects invalid targets", () => {
    expect(() => buildCliUpgradePlan("gemini", "bad target")).toThrow("Upgrade target");
    expect(() => buildCliUpgradePlan("gemini", "--global")).toThrow("Upgrade target");
  });

  it("does not execute commands for dry runs", async () => {
    const result = await runCliUpgrade({ cli: "gemini", dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.plan.command).toBe("npm");
    expect(result.stdout).toBeUndefined();
  });
});
