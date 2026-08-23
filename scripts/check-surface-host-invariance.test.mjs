import { describe, expect, it } from "vitest";
import { buildScenarios, runScenario } from "./check-surface-host-invariance.mjs";

const SCENARIOS = buildScenarios("/tmp/sandbox", "/usr/local/bin");

describe("host-invariance scenarios", () => {
  it("varies every axis that can reach tool registration", () => {
    const keys = new Set(SCENARIOS.flatMap(s => Object.keys(s.env)));
    for (const axis of ["LLM_GATEWAY_CONFIG", "PATH", "HOME", "LLM_GATEWAY_JOBS_DB"]) {
      expect(keys, axis).toContain(axis);
    }
  });

  it("has exactly one scenario that changes nothing, the baseline", () => {
    // A scenario with an empty env tests nothing and reads as coverage. One is
    // the control; a second would be a silent hole in this very file.
    expect(SCENARIOS.filter(s => Object.keys(s.env).length === 0)).toHaveLength(1);
  });

  it("names each scenario, because the failure message is the whole diagnostic", () => {
    for (const scenario of SCENARIOS) expect(scenario.name.length).toBeGreaterThan(8);
    expect(new Set(SCENARIOS.map(s => s.name)).size).toBe(SCENARIOS.length);
  });
});

describe("runScenario", () => {
  it("reports ok for a command that succeeds", () => {
    expect(runScenario({ name: "x", env: {} }, ["-e", "process.exit(0)"]).ok).toBe(true);
  });

  it("reports NOT ok and keeps the tail of the output for a command that fails", () => {
    const result = runScenario({ name: "x", env: {} }, [
      "-e",
      "console.error('fixture is out of date'); process.exit(1)",
    ]);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("fixture is out of date");
  });

  it("actually applies the scenario env to the child", () => {
    const result = runScenario({ name: "x", env: { LLM_GATEWAY_PROBE_MARKER: "set" } }, [
      "-e",
      "process.exit(process.env.LLM_GATEWAY_PROBE_MARKER === 'set' ? 1 : 0)",
    ]);
    expect(result.ok).toBe(false);
  });
});
