import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const entrypoint = join(process.cwd(), "dist", "index.js");

describe.skipIf(!existsSync(entrypoint))("CLI metadata entrypoint", () => {
  function run(args: string[]) {
    return spawnSync(process.execPath, [entrypoint, ...args], {
      encoding: "utf8",
      env: {
        ...process.env,
        LLM_GATEWAY_LOGS_DB: "none",
        LLM_GATEWAY_JOBS_DB: "none",
      },
    });
  }

  it("--version prints only the package version", () => {
    const result = run(["--version"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
    expect(result.stderr).toBe("");
  });

  it("contracts --json prints machine-readable JSON without startup logs", () => {
    const result = run(["contracts", "--json"]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: "upstream-cli-contracts.v1",
    });
  });
});
