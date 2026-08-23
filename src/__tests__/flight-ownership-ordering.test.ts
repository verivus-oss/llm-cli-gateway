import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FlightOwnership } from "../flight-ownership.js";
import type { FlightLogResult } from "../flight-recorder.js";

// s6, design 3.4. FlightOwnership is the one synchronous class every inline
// flight write funnels through, and the port makes its two sinks async. The
// hazard is not that a write is slow, it is that `started` and
// `managerOwnsCompletion` are idempotence fences: a boolean an await can
// straddle is a race, which is the defect s5 shipped in persistComplete.
//
// The unfixed state is not runnable here: the pre-s6 class took `() => void`
// sinks, so the race did not exist to fail against. Each fence therefore
// carries an ADD-form negative control in this file: the same test driven
// through a deliberately straddled or unchained variant, which must fail the
// assertion the real class passes. Every interleaving is driven by a gate, not
// by a timer.

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open!: () => void;
  const promise = new Promise<void>(resolve => {
    open = () => resolve();
  });
  return { promise, open };
}

/** Flush every pending microtask. A macrotask turn, not a delay. */
function drainMicrotasks(): Promise<void> {
  return new Promise<void>(resolve => setImmediate(resolve));
}

function result(response: string): FlightLogResult {
  return {
    response,
    durationMs: 1,
    retryCount: 0,
    circuitBreakerState: "closed",
    optimizationApplied: false,
    exitCode: 0,
    status: "completed",
  };
}

/** Negative control: the sinks called directly, with no chain. */
class UnchainedOwnership {
  private started = false;
  constructor(
    private readonly startFn: () => Promise<void>,
    private readonly completeFn: (r: FlightLogResult) => Promise<void>
  ) {}
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.started = true;
    return this.startFn();
  }
  completeInline(r: FlightLogResult): Promise<void> {
    return this.completeFn(r);
  }
}

/** Negative control: the idempotence flag set AFTER the await it guards. */
class StraddledOwnership {
  private started = false;
  constructor(private readonly startFn: () => Promise<void>) {}
  async start(): Promise<void> {
    if (this.started) return;
    await this.startFn();
    this.started = true;
  }
}

describe("FlightOwnership write ordering (s6, design 3.4)", () => {
  it("orders the completion sink behind a still-pending start sink", async () => {
    const order: string[] = [];
    const startGate = gate();
    const flight = new FlightOwnership(
      async () => {
        order.push("start:enter");
        await startGate.promise;
        order.push("start:exit");
      },
      async () => {
        order.push("complete");
      }
    );

    const started = flight.start();
    const completed = flight.completeInline(result("body"));
    await drainMicrotasks();

    // The completion has not reached the sink while the start write is open.
    expect(order).toEqual(["start:enter"]);
    startGate.open();
    await Promise.all([started, completed]);
    expect(order).toEqual(["start:enter", "start:exit", "complete"]);
  });

  it("an unchained variant completes before its own start write lands (negative control)", async () => {
    const order: string[] = [];
    const startGate = gate();
    const flight = new UnchainedOwnership(
      async () => {
        order.push("start:enter");
        await startGate.promise;
        order.push("start:exit");
      },
      async () => {
        order.push("complete");
      }
    );

    const started = flight.start();
    const completed = flight.completeInline(result("body"));
    await drainMicrotasks();

    // The control the real class must not match: the completion overtook the
    // start row it attaches to, which is the zero-row update of failure mode 4.
    expect(order).toEqual(["start:enter", "complete"]);
    startGate.open();
    await Promise.all([started, completed]);
  });

  it("a second concurrent start() enqueues exactly one start write", async () => {
    let calls = 0;
    const startGate = gate();
    const flight = new FlightOwnership(
      async () => {
        calls += 1;
        await startGate.promise;
      },
      async () => {}
    );

    const first = flight.start();
    const second = flight.start();
    startGate.open();
    await Promise.all([first, second]);

    expect(calls).toBe(1);
    expect(flight.hasStarted).toBe(true);
  });

  it("a flag set after an await would admit a second write (negative control)", async () => {
    let calls = 0;
    const startGate = gate();
    const flight = new StraddledOwnership(async () => {
      calls += 1;
      await startGate.promise;
    });

    const first = flight.start();
    const second = flight.start();
    startGate.open();
    await Promise.all([first, second]);

    // Both callers passed a guard neither had set yet. This is the shape s5
    // shipped, and the reason `started` is claimed in the sync prologue.
    expect(calls).toBe(2);
  });

  it("fences a completion transferred while an earlier write is in flight", async () => {
    let completes = 0;
    const startGate = gate();
    const flight = new FlightOwnership(
      async () => {
        await startGate.promise;
      },
      async () => {
        completes += 1;
      }
    );

    const started = flight.start();
    // The deferral is observed while the start write is still open: the manager
    // owns completion from this instant, so no inline completion may follow.
    flight.transferCompletionToManager();
    const completed = flight.completeInline(result("late"));
    startGate.open();
    await Promise.all([started, completed]);

    expect(completes).toBe(0);
  });

  it("still writes a completion decided before the transfer", async () => {
    const order: string[] = [];
    const completeGate = gate();
    const flight = new FlightOwnership(
      async () => {
        order.push("start");
      },
      async () => {
        order.push("complete:enter");
        await completeGate.promise;
        order.push("complete:exit");
      }
    );

    await flight.start();
    const completed = flight.completeInline(result("inline"));
    // No drain between the two: the transfer lands in exactly the window a
    // straddled implementation would still be yielding in, and such an
    // implementation drops this write. The synchronous class wrote it, so
    // reading the flag in the prologue is what preserves that behaviour. This
    // is the discriminating half of the fence pair.
    flight.transferCompletionToManager();
    completeGate.open();
    await completed;

    expect(order).toEqual(["start", "complete:enter", "complete:exit"]);
  });

  it("a rejected start sink neither poisons nor bypasses the chain", async () => {
    const order: string[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const flight = new FlightOwnership(
        async () => {
          order.push("start");
          throw new Error("logStart rejected");
        },
        async () => {
          order.push("complete");
        }
      );

      const started = flight.start();
      const completed = flight.completeInline(result("body"));
      await expect(started).resolves.toBeUndefined();
      await expect(completed).resolves.toBeUndefined();
      await drainMicrotasks();

      // Not bypassed: the completion still ran, and it ran AFTER the failed
      // start rather than overtaking it.
      expect(order).toEqual(["start", "complete"]);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("keeps no cross-request state, so there is no queue map to grow", async () => {
    const seen: string[] = [];
    const make = (id: string): FlightOwnership =>
      new FlightOwnership(
        async () => {
          seen.push(`${id}:start`);
        },
        async () => {
          seen.push(`${id}:complete`);
        }
      );

    const a = make("a");
    const b = make("b");
    await Promise.all([a.start(), b.start()]);
    await Promise.all([a.completeInline(result("a")), b.completeInline(result("b"))]);
    expect(seen.filter(entry => entry.startsWith("a:"))).toEqual(["a:start", "a:complete"]);
    expect(seen.filter(entry => entry.startsWith("b:"))).toEqual(["b:start", "b:complete"]);

    // Structural half: design revision 1's per-correlation queue map is what
    // grows unboundedly, and the answer is that there is no map. A static
    // member or a module-level Map would reintroduce exactly that.
    const source = readFileSync(join(process.cwd(), "src", "flight-ownership.ts"), "utf8");
    expect(source).not.toMatch(/\bstatic\b/);
    expect(source).not.toMatch(/new Map\b/);
  });
});
