/**
 * I2: subprocess test for the billable-script safety gate
 * (`docs/plans/slice-kappa-smoke-test.mjs`).
 *
 * The smoke script makes two live Anthropic API calls (~$0.08). It must
 * exit 0 with a clear skip banner whenever the `SMOKE_CACHE_CONTROL`
 * env var is unset, so accidental invocation in CI does not burn live
 * Anthropic credit.
 *
 * Closes the gap Codex round-3 flagged at
 * `slice-kappa-smoke-test.mjs:178`.
 *
 * Mutation that must trip these:
 * - removing the `if (!process.env.SMOKE_CACHE_CONTROL) { … process.exit(0) }`
 *   block from the smoke script → the test goes red because the script
 *   either makes a live call (would fail in test env without Anthropic
 *   auth) or proceeds past the gate.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const SMOKE_SCRIPT = resolve(__dirname, "..", "..", "docs", "plans", "slice-kappa-smoke-test.mjs");

function runSmoke(env: NodeJS.ProcessEnv): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("node", [SMOKE_SCRIPT], {
    env: { ...process.env, ...env, SMOKE_CACHE_CONTROL: env.SMOKE_CACHE_CONTROL ?? "" },
    encoding: "utf8",
    timeout: 10_000,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

describe("rec #6 (I2): smoke:cache-control billable-gate", () => {
  it("exits 0 and prints the BILLABLE banner + skip line when SMOKE_CACHE_CONTROL is unset", () => {
    // Explicitly DELETE the env var rather than leaving it inherited.
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.SMOKE_CACHE_CONTROL;
    const r = spawnSync("node", [SMOKE_SCRIPT], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/BILLABLE TEST/);
    expect(r.stdout).toMatch(/SMOKE_CACHE_CONTROL not set/);
    // Crucially, the script must NOT print "Call 1" / "Call 2" lines
    // (those would mean it tried to invoke `claude` for real).
    expect(r.stdout).not.toMatch(/Call 1 \(cache should be WRITTEN/);
    expect(r.stdout).not.toMatch(/Call 2 \(cache should be READ/);
  }, 10_000);

  it("exits 0 with empty-string SMOKE_CACHE_CONTROL (falsy gate guard)", () => {
    const r = runSmoke({ SMOKE_CACHE_CONTROL: "" });
    expect(r.status, `stderr=${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/SMOKE_CACHE_CONTROL not set/);
    expect(r.stdout).not.toMatch(/Call 1 \(cache should be WRITTEN/);
  });
});
