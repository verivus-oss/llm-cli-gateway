/**
 * s5: the fail-closed durable-admission gate must not invert to fail-open.
 *
 * `restoreDurableAdmission` registers this instance inside a try/catch and sets
 * `durableAdmission = true` on success; the catch leaves it false. When the job
 * store became asynchronous, `registerInstance` stopped THROWING and started
 * REJECTING, so an unawaited call could no longer reach that catch: the flag was
 * set true even when registration had failed, and the failure surfaced only as
 * an unhandled rejection.
 *
 * The consequence is not lost output. An instance that admits durable jobs
 * believing it registered leaves those jobs with no `gateway_instances` row, so
 * orphan recovery has nothing to fence them against and they cannot be
 * accounted for after a crash.
 *
 * These assert the PROPERTY (admission refuses), not the mechanism (the call is
 * awaited). A test that only proved the await would pass against a version that
 * awaited and then set the flag anyway.
 */
import { describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore, type JobStore } from "../job-store.js";
import type { LeaseRuntimeConfig } from "../async-job-manager.js";
import { noopLogger } from "../logger.js";

/** A store whose instance registration fails the way a dead database does. */
function storeWithFailingRegistration(): JobStore {
  const store = new MemoryJobStore();
  store.registerInstance = (): Promise<void> =>
    Promise.reject(new Error("durable store unreachable"));
  return store;
}

async function settle(manager: AsyncJobManager): Promise<void> {
  // The constructor cannot await registration, so it starts it. Yield until the
  // startup promise has settled rather than assuming a tick count.
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 5));
  void manager;
}

/**
 * Startup succeeds, then the lease write starts failing.
 *
 * `restoreDurableAdmission` heartbeats as part of registration, so a store that
 * fails EVERY heartbeat never admits at all and could not tell us anything
 * about the ongoing tick. This one lets startup through and then breaks, which
 * is the real scenario: a healthy instance whose database goes away.
 */
function storeHealthyThenFailingHeartbeat(): JobStore {
  const store = new MemoryJobStore();
  let calls = 0;
  store.heartbeat = (): Promise<void> => {
    calls += 1;
    if (calls <= 1) return Promise.resolve();
    return Promise.reject(new Error("lease write failed"));
  };
  return store;
}

const FAST_LEASE: LeaseRuntimeConfig = {
  instanceHeartbeatMs: 10,
  instanceLeaseTtlMs: 20,
  httpJobGraceMs: 1000,
  orphanSweepIntervalMs: 100000,
  instanceGcMs: 100000,
  role: "gateway",
};

describe("a failing heartbeat still counts as a failure", () => {
  it("disables durable admission after sustained heartbeat failure", async () => {
    // The second instance of the same shape: `onHeartbeatTick` zeroed
    // `consecutiveHeartbeatFailures` inside a try whose catch could no longer
    // fire once `heartbeat` rejected instead of throwing. A dead lease then
    // reported healthy for ever, and this instance kept admitting durable jobs
    // while its lease silently lapsed and other instances swept its work.
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      storeHealthyThenFailingHeartbeat(),
      undefined,
      undefined,
      true,
      FAST_LEASE
    );
    await settle(manager);
    expect(manager.canAdmitDurableJobs()).toBe(true);

    // MAX_CONSECUTIVE_HEARTBEAT_FAILURES is 3, at 10ms per tick.
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(manager.canAdmitDurableJobs()).toBe(false);
    expect(manager.getDurableAdmissionHealth().consecutiveHeartbeatFailures).toBeGreaterThanOrEqual(
      3
    );

    await manager.dispose({ timeoutMs: 200 });
  });

  it("keeps admitting while the heartbeat SUCCEEDS, so it is not just a timer", async () => {
    // Control: without this, a manager that disabled admission on any schedule
    // at all would pass the test above.
    const manager = new AsyncJobManager(
      noopLogger,
      undefined,
      new MemoryJobStore(),
      undefined,
      undefined,
      true,
      FAST_LEASE
    );
    await settle(manager);
    await new Promise(resolve => setTimeout(resolve, 250));

    expect(manager.canAdmitDurableJobs()).toBe(true);
    expect(manager.getDurableAdmissionHealth().consecutiveHeartbeatFailures).toBe(0);

    await manager.dispose({ timeoutMs: 200 });
  });
});

describe("durable admission stays fail-CLOSED when registration fails", () => {
  it("does not admit durable jobs after a failed registration", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, storeWithFailingRegistration());
    await settle(manager);

    expect(manager.canAdmitDurableJobs()).toBe(false);

    await manager.dispose({ timeoutMs: 200 });
  });

  it("REFUSES an async job through the real admission path", async () => {
    // The property that matters. canAdmitDurableJobs() is a predicate; this is
    // the gate actually turning a request away, through startJobWithDedup,
    // which calls assertDurableAdmission before anything is spawned.
    const manager = new AsyncJobManager(noopLogger, undefined, storeWithFailingRegistration());
    await settle(manager);

    await expect(
      manager.startJobWithDedup("claude", ["-p", "hello"], "corr-inversion-1")
    ).rejects.toThrow(/could not register or lost its heartbeat lease/);

    await manager.dispose({ timeoutMs: 200 });
  });

  it("reports the failure on the health surface rather than silently", async () => {
    const manager = new AsyncJobManager(noopLogger, undefined, storeWithFailingRegistration());
    await settle(manager);

    const health = manager.getDurableAdmissionHealth();
    expect(health.storeAttached).toBe(true);
    expect(health.admitting).toBe(false);
    expect(health.lastHeartbeatErrorName).toBe("Error");

    await manager.dispose({ timeoutMs: 200 });
  });

  it("ADMITS when registration succeeds, so the gate is not simply stuck shut", async () => {
    // The control. A gate that refuses everything would pass all three tests
    // above while being just as broken in the other direction.
    const manager = new AsyncJobManager(noopLogger, undefined, new MemoryJobStore());
    await settle(manager);

    expect(manager.canAdmitDurableJobs()).toBe(true);

    await manager.dispose({ timeoutMs: 200 });
  });
});
