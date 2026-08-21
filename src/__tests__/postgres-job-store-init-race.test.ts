/**
 * Two callers racing the FIRST store call must build exactly one driver.
 *
 * C4 deleted the worker thread. Under the worker the parent was a
 * single-threaded RPC caller blocked in Atomics.wait, so only one store
 * operation could ever be in flight and this race could not be expressed. After
 * C4 the caller is concurrent, and the first version of `ensureInit` awaited the
 * pool factory INSIDE an `if (!this.ops)` guard, assigning the memo only
 * afterwards. Both callers passed the guard, both built a driver, and the
 * second overwrote `this.driver`/`this.ops` before awaiting the FIRST caller's
 * init, then returned its own ops on which init had never run. The first
 * driver's pool was orphaned where close() could not reach it.
 *
 * The existing pg retry test does not cover this: it clears the memo and calls
 * again SEQUENTIALLY, which is a different property. A race needs a race.
 *
 * No PostgreSQL server is involved. The defect is in the construction path, so
 * the pool factory is mocked and driver constructions are counted. Both calls
 * are expected to REJECT (there is nothing to connect to); what is asserted is
 * how many drivers were built on the way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const driverConstructions: string[] = [];

vi.mock("../storage/drivers/postgres.js", () => ({
  PostgresStorageDriver: class {
    constructor(dsns: Record<string, string>) {
      driverConstructions.push(JSON.stringify(dsns));
    }
    async close(): Promise<void> {}
  },
  nodePostgresPoolFactory: async () => {
    // A real await, so the race window this test exists for actually exists.
    // Without it both callers would run to the memo assignment synchronously
    // and the test would pass against the broken code too.
    await new Promise(resolve => setTimeout(resolve, 5));
    return () => ({
      query: async () => ({ rows: [], rowCount: 0 }),
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
      end: async () => {},
    });
  },
}));

vi.mock("../postgres-job-store-ops.js", () => ({
  createPostgresJobStoreOps: () => ({
    init: async () => {
      throw new Error("init refused: no server in this test");
    },
    op: async () => null,
  }),
}));

const { PostgresJobStore } = await import("../job-store.js");

describe("PostgresJobStore initialisation race (C4)", () => {
  beforeEach(() => {
    driverConstructions.length = 0;
  });

  it("builds ONE driver when two callers race the first call", async () => {
    const store = new PostgresJobStore("postgresql://unused/init-race");

    // Both start before either has finished constructing. Settled, not awaited
    // in sequence: sequencing them would rebuild the very property under test.
    const results = await Promise.allSettled([
      store.getById("a"),
      store.getById("b"),
      store.getById("c"),
    ]);

    // Every one fails, because the stubbed init refuses. That is not the point.
    expect(results.every(r => r.status === "rejected")).toBe(true);

    // THE PROPERTY. Two drivers means two pools, one of them unreachable from
    // close(), and a caller holding ops whose init never ran.
    expect(driverConstructions).toHaveLength(1);
  });

  it("still retries after a failure rather than poisoning the store", async () => {
    const store = new PostgresJobStore("postgresql://unused/init-retry");

    await expect(store.getById("a")).rejects.toThrow(/init refused/);
    // A second call must reach init again. If the rejected promise were
    // memoised it would reject with the same settled promise and never retry,
    // and the driver would not be rebuilt either.
    await expect(store.getById("b")).rejects.toThrow(/init refused/);

    // The driver is REUSED across the retry, not rebuilt, so a failing init
    // cannot leak one pool per attempt.
    expect(driverConstructions).toHaveLength(1);
  });
});
