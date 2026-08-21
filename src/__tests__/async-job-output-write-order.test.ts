/**
 * C-ORDER and C-DRAIN, from section 5.6 of the s5 design.
 *
 * The design says both landed in C3. Neither did: there was no write chain
 * anywhere in src/, and `pendingWrites` held only the HTTP settle and async
 * onTerminal paths. This is that missing pair.
 *
 * THE DEFECT. Every flush writes the WHOLE accumulated job.stdout, not a delta,
 * and maybeFlushOutput clears outputDirty and stamps lastOutputFlushAt BEFORE
 * it awaits. That was safe while the write was synchronous. Once a write can
 * outlast the 1000ms throttle, a second flush starts while the first is in
 * flight, and if the OLDER snapshot commits last the durable row is truncated
 * back to it. Output already stored disappears, with no error: the same shape
 * as the recordOutput swallow and the close() drain, a write that appears to
 * succeed and does not land.
 *
 * Made deterministic rather than raced: the store below releases writes in an
 * order the test chooses, so "the older snapshot lands last" is arranged, not
 * hoped for.
 */
import { describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { mockLogger } from "./setup.js";

/**
 * A real MemoryJobStore whose recordOutput is gated, rather than a subclass.
 *
 * Subclassing it first produced a store the manager silently declined to write
 * to at all, and the test then measured nothing: `waiting` stayed 0 and the
 * assertion would have passed for the wrong reason had it been written the
 * other way round. Patching one method on a real instance keeps every other
 * behaviour the manager depends on intact.
 */
interface Gated {
  store: MemoryJobStore;
  landed: string[];
  waiting: () => number;
  releaseNext: () => Promise<void>;
}

function gatedStore(): Gated {
  const store = new MemoryJobStore();
  const landed: string[] = [];
  const gates: Array<() => void> = [];
  const real = store.recordOutput.bind(store);
  store.recordOutput = async (id, stdout, stderr, truncated) => {
    await new Promise<void>(release => gates.push(release));
    landed.push(stdout);
    return real(id, stdout, stderr, truncated);
  };
  return {
    store,
    landed,
    waiting: () => gates.length,
    releaseNext: async () => {
      const gate = gates.shift();
      expect(gate, "no write was waiting").toBeDefined();
      gate!();
      // Let the released write, and anything chained behind it, be scheduled.
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

function jobRecord(manager: AsyncJobManager, id: string) {
  const internals = manager as unknown as {
    jobs: Map<string, Record<string, unknown>>;
    maybeFlushOutput(job: Record<string, unknown>, force?: boolean): Promise<void>;
    pendingWrites: Set<Promise<unknown>>;
  };
  const job: Record<string, unknown> = {
    id,
    cli: "claude",
    correlationId: `corr-${id}`,
    status: "running",
    stdout: "",
    stderr: "",
    outputTruncated: false,
    outputDirty: false,
    lastOutputFlushAt: 0,
    ownerPrincipal: null,
    terminalPersisted: false,
    terminalRowOwned: true,
  };
  internals.jobs.set(id, job);
  return { internals, job };
}

describe("durable output writes are ordered per job (s5 section 5.6)", () => {
  it("a slow earlier flush cannot truncate the row back to its older snapshot", async () => {
    const gate = gatedStore();
    const manager = new AsyncJobManager(mockLogger, undefined, gate.store);
    const { internals, job } = jobRecord(manager, "order-1");

    // Flush A sees "abc".
    job.stdout = "abc";
    job.outputDirty = true;
    const first = internals.maybeFlushOutput(job, true);

    // Flush B sees "abcdef" and is issued while A is still in flight.
    job.stdout = "abcdef";
    job.outputDirty = true;
    const second = internals.maybeFlushOutput(job, true);

    // Let both flushes run as far as they can. The chain is built from
    // promise continuations, so neither reaches recordOutput on the same tick.
    await new Promise(resolve => setTimeout(resolve, 0));

    // THE PROPERTY. Only A has reached the store; B is chained behind it and is
    // not even queued yet. Without the chain BOTH would be waiting here, and
    // the test could then release them in either order.
    expect(gate.waiting()).toBe(1);

    await gate.releaseNext(); // A lands, which unblocks B
    expect(gate.waiting()).toBe(1);
    await gate.releaseNext(); // B lands
    await Promise.all([first, second]);

    // The order the flushes were DECIDED in is the order they landed in, so the
    // row ends on the longer snapshot rather than being truncated back.
    expect(gate.landed).toEqual(["abc", "abcdef"]);

    await manager.dispose();
  });

  it("dispose() drains an in-flight output write before it returns", async () => {
    const gate = gatedStore();
    const manager = new AsyncJobManager(mockLogger, undefined, gate.store);
    const { internals, job } = jobRecord(manager, "drain-1");

    job.stdout = "pending bytes";
    job.outputDirty = true;
    const flush = internals.maybeFlushOutput(job, true);
    await new Promise(resolve => setTimeout(resolve, 0));

    // THE PROPERTY: the write is registered for the drain. Without it, dispose()
    // sees a quiet manager and can deregister the instance while this write is
    // still going.
    expect(internals.pendingWrites.size).toBeGreaterThan(0);

    await gate.releaseNext();
    await flush;
    expect(gate.landed).toEqual(["pending bytes"]);
    await manager.dispose();
  });
});
