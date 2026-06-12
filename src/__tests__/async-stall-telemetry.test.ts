/**
 * Issue #21 — silent-stall telemetry for long async jobs.
 *
 * A running async job that has produced ZERO stdout after the 5/10/15-minute
 * marks is flagged with a structured warning (once per crossed mark), carrying
 * prompt length + model so the recurring stall class is measurable from logs.
 *
 * These tests drive `checkStalledJobs(now)` directly with synthetic clocks so
 * no real time elapses.
 */
import { describe, it, expect, vi } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import type { Logger } from "../logger.js";

function capturingLogger(): { logger: Logger; warns: { message: string; meta?: any }[] } {
  const warns: { message: string; meta?: any }[] = [];
  const logger: Logger = {
    info: () => {},
    error: () => {},
    debug: () => {},
    warn: (message: string, meta?: unknown) => warns.push({ message, meta }),
  };
  return { logger, warns };
}

// Inject a synthetic running job with zero stdout into the manager's private
// map. We reach in deliberately to avoid spawning a real CLI process.
function injectStalledJob(
  mgr: AsyncJobManager,
  opts: { id: string; startedAt: string; stdout?: string; model?: string; prompt?: string }
): void {
  const jobs: Map<string, any> = (mgr as any).jobs;
  jobs.set(opts.id, {
    id: opts.id,
    cli: "claude",
    args: [],
    requestKey: opts.id,
    correlationId: `corr-${opts.id}`,
    status: "running",
    startedAt: opts.startedAt,
    finishedAt: null,
    exitCode: null,
    stdout: opts.stdout ?? "",
    stderr: "",
    outputTruncated: false,
    canceled: false,
    error: null,
    process: null,
    exited: false,
    metricsRecorded: false,
    outputDirty: false,
    lastOutputFlushAt: 0,
    flightRecorderEntry:
      opts.model || opts.prompt
        ? { model: opts.model ?? "", prompt: opts.prompt ?? "" }
        : undefined,
  });
}

describe("Issue #21 — async stall telemetry", () => {
  const T0 = Date.parse("2026-06-09T00:00:00Z");
  const min = (m: number) => T0 + m * 60 * 1000;

  it("does not warn before the first 5-minute mark", () => {
    const { logger, warns } = capturingLogger();
    const mgr = new AsyncJobManager(logger);
    injectStalledJob(mgr, { id: "j1", startedAt: new Date(T0).toISOString() });

    mgr.checkStalledJobs(min(4)); // 4 minutes in, no stdout
    expect(warns).toHaveLength(0);
  });

  it("warns once at each of the 5/10/15-minute marks with model + promptLength", () => {
    const { logger, warns } = capturingLogger();
    const mgr = new AsyncJobManager(logger);
    injectStalledJob(mgr, {
      id: "j2",
      startedAt: new Date(T0).toISOString(),
      model: "claude-opus-4-8",
      prompt: "x".repeat(1234),
    });

    mgr.checkStalledJobs(min(5)); // crosses 5
    mgr.checkStalledJobs(min(6)); // no new mark
    mgr.checkStalledJobs(min(10)); // crosses 10
    mgr.checkStalledJobs(min(15)); // crosses 15
    mgr.checkStalledJobs(min(30)); // no marks left

    expect(warns).toHaveLength(3);
    expect(warns[0].message).toContain("~5min");
    expect(warns[1].message).toContain("~10min");
    expect(warns[2].message).toContain("~15min");
    expect(warns[0].meta).toMatchObject({
      jobId: "j2",
      cli: "claude",
      stdoutBytes: 0,
      model: "claude-opus-4-8",
      promptLength: 1234,
    });
  });

  it("does not warn when the job has produced stdout", () => {
    const { logger, warns } = capturingLogger();
    const mgr = new AsyncJobManager(logger);
    injectStalledJob(mgr, {
      id: "j3",
      startedAt: new Date(T0).toISOString(),
      stdout: "some streamed output",
    });

    mgr.checkStalledJobs(min(20));
    expect(warns).toHaveLength(0);
  });

  it("collapses missed sweeps to a single warning for the highest crossed mark", () => {
    const { logger, warns } = capturingLogger();
    const mgr = new AsyncJobManager(logger);
    injectStalledJob(mgr, { id: "j4", startedAt: new Date(T0).toISOString() });

    // First observation is already past all three marks (e.g. event-loop was busy).
    mgr.checkStalledJobs(min(16));
    expect(warns).toHaveLength(1);
    expect(warns[0].message).toContain("~15min");

    // No further warnings once all marks are exhausted.
    mgr.checkStalledJobs(min(40));
    expect(warns).toHaveLength(1);
  });
});
