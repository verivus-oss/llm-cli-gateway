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

  describe("Mistral Vibe upgrade dispatch (U22)", () => {
    it("dispatches to pip when vibe-cli is installed via pip", () => {
      const plan = buildCliUpgradePlan("mistral", "latest", () => "pip");
      expect(plan.command).toBe("pip");
      expect(plan.args).toEqual(["install", "-U", "vibe-cli"]);
      expect(plan.strategy).toBe("pip-install");
    });

    it("dispatches to uv tool upgrade when vibe-cli is installed via uv", () => {
      const plan = buildCliUpgradePlan("mistral", "latest", () => "uv");
      expect(plan.command).toBe("uv");
      expect(plan.args).toEqual(["tool", "upgrade", "vibe-cli"]);
      expect(plan.strategy).toBe("uv-tool-upgrade");
    });

    it("dispatches to brew upgrade when mistral-vibe is installed via Homebrew", () => {
      const plan = buildCliUpgradePlan("mistral", "latest", () => "brew");
      expect(plan.command).toBe("brew");
      expect(plan.args).toEqual(["upgrade", "mistral-vibe"]);
      expect(plan.strategy).toBe("brew-upgrade");
    });

    it("pip targets honour an explicit version", () => {
      const plan = buildCliUpgradePlan("mistral", "1.2.3", () => "pip");
      expect(plan.args).toEqual(["install", "-U", "vibe-cli==1.2.3"]);
    });

    it("rejects unknown Mistral installation methods with an actionable error", () => {
      expect(() => buildCliUpgradePlan("mistral", "latest", () => "unknown")).toThrow(
        /Could not detect how Mistral Vibe was installed/
      );
    });

    it("never plans a `vibe update` self-update (Vibe has no self-update command)", () => {
      const plan = buildCliUpgradePlan("mistral", "latest", () => "pip");
      expect(plan.command).not.toBe("vibe");
    });
  });
});
