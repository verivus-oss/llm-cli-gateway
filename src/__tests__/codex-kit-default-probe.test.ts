/**
 * Drives createCodexKitIsolationPlan with NO custom probe, so the production
 * default (the `??` fallback) is what runs. A review found that pinning the
 * factory alone left a wrapper planted at that fallback undetected: every
 * shipped call to the plan supplied its own probe. The spawn chokepoint is
 * mocked to record the options the default probe hands it and to run a
 * trivial Node child that prints a developer prompt surface.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnCalls } = vi.hoisted(() => ({
  spawnCalls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
}));
vi.mock("../executor.js", async () => {
  const actual = await vi.importActual<typeof import("../executor.js")>("../executor.js");
  const developerPrompt = JSON.stringify([
    { type: "message", role: "developer", content: [{ type: "input_text", text: "policy" }] },
  ]);
  return {
    ...actual,
    spawnCliProcess: (command: string, args: string[], options: Record<string, unknown>) => {
      spawnCalls.push({ command, args: [...args], options: { ...options } });
      return actual.spawnCliProcess(
        process.execPath,
        ["-e", `process.stdout.write(${JSON.stringify(developerPrompt)})`],
        {
          cwd: options.cwd as string,
          env: process.env,
          stdio: options.stdio as ["ignore", "pipe", "pipe"],
        }
      );
    },
  };
});

import { createCodexKitIsolationPlan } from "../codex-kit-isolation.js";

const SCRATCH = join(process.cwd(), ".scratch");
let testDir: string | undefined;

afterEach(() => {
  spawnCalls.length = 0;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
  testDir = undefined;
});

describe("Codex Kit default prompt probe", () => {
  it("hands the launch context to the spawn chokepoint when no probe option is given", async () => {
    testDir = mkdtempSync(join(SCRATCH, "codex-kit-default-probe-"));
    const launchContext = { correlationId: "corr-no-probe-option", provider: "codex" };
    await createCodexKitIsolationPlan(testDir, {
      contextPrefix: "<gateway-personal-config>Kit context</gateway-personal-config>",
      sandboxMode: "workspace-write",
      outputFormat: "text",
      baseEnv: { PATH: process.env.PATH },
      launchContext,
    });
    expect(spawnCalls).toHaveLength(2);
    for (const call of spawnCalls) {
      expect(call.command).toBe("codex");
      expect(call.options.launchContext).toEqual(launchContext);
    }
  });
});
