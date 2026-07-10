import { describe, it, expect } from "vitest";
import { providerAtCapacity, type JobLimiterSnapshot } from "../async-job-manager.js";

function makeSnapshot(overrides: Partial<JobLimiterSnapshot> = {}): JobLimiterSnapshot {
  return {
    maxRunning: 8,
    maxRunningPerProvider: 2,
    maxQueued: 16,
    running: 0,
    queued: 0,
    runningByProvider: {},
    queuedByProvider: {},
    rejected: 0,
    timedOut: 0,
    saturated: false,
    ...overrides,
  };
}

describe("providerAtCapacity", () => {
  it("reports at capacity when running count equals the per-provider cap", () => {
    const snapshot = makeSnapshot({
      maxRunningPerProvider: 2,
      runningByProvider: { codex: 2 },
    });
    expect(providerAtCapacity(snapshot, "codex")).toBe(true);
  });

  it("reports at capacity when running count exceeds the per-provider cap", () => {
    const snapshot = makeSnapshot({
      maxRunningPerProvider: 2,
      runningByProvider: { codex: 3 },
    });
    expect(providerAtCapacity(snapshot, "codex")).toBe(true);
  });

  it("reports available when running count is below the per-provider cap", () => {
    const snapshot = makeSnapshot({
      maxRunningPerProvider: 2,
      runningByProvider: { codex: 1 },
    });
    expect(providerAtCapacity(snapshot, "codex")).toBe(false);
  });

  it("treats an absent provider as zero running (available)", () => {
    const snapshot = makeSnapshot({
      maxRunningPerProvider: 2,
      runningByProvider: {},
    });
    expect(providerAtCapacity(snapshot, "claude")).toBe(false);
  });

  it("is independent of the global saturated flag", () => {
    const snapshot = makeSnapshot({
      maxRunningPerProvider: 2,
      runningByProvider: { codex: 1 },
      saturated: true,
    });
    expect(providerAtCapacity(snapshot, "codex")).toBe(false);
  });
});
