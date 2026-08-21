/**
 * Tier-B T3 FlightOwnership, converted for the async storage port (s6).
 *
 * WHO writes a sync request's two flight-recorder phases, and in what ORDER.
 * Extracted from index.ts so the ordering contract has a unit surface. Modes:
 * A, the handler writes both ends; B, the handler wrote logStart and the sync
 * deadline handed logComplete to the async manager, after which every inline
 * completion must no-op (the H-DoubleComplete fence); C, manager-owned, which
 * these sync handlers never construct.
 *
 * Rules, failure modes and what is NOT fixed here: src/storage/write-ordering.ts.
 */
import type { FlightLogResult } from "./flight-recorder.js";
import type { FlightCompleteSink, FlightStartSink } from "./storage/operations.js";

/** Swallow, twice over: see `enqueue`. */
const IGNORE = (): void => {};

export class FlightOwnership {
  /**
   * Both flags are read AND set in the synchronous prologue of the method that
   * owns them, before the first await. That is the conversion: an idempotence
   * flag a yield can straddle is not a fence, it is a race, and s5 shipped
   * exactly that defect. Only the WRITE is deferred, never the decision.
   */
  private started = false;
  private managerOwnsCompletion = false;
  /**
   * Serialises this request's writes and orders complete behind start. Never
   * rejects, so a rejected logStart neither poisons the chain nor bypasses it.
   * Request-scoped, so there is no per-correlation map to grow unboundedly;
   * design revision 1's queue is not re-proposed.
   */
  private tail: Promise<void> = Promise.resolve();
  private readonly startFn: FlightStartSink;
  private readonly completeFn: FlightCompleteSink;

  constructor(startFn: FlightStartSink, completeFn: FlightCompleteSink) {
    this.startFn = startFn;
    this.completeFn = completeFn;
  }

  /**
   * Write `logStart`. Idempotent, and AWAITED by every caller: that await is
   * the fence putting the start row in the database before `execute`
   * dispatches, hence before `armFlightCompleteForDeferral` can let the async
   * manager write a completion into a row that does not exist yet.
   */
  start(): Promise<void> {
    if (this.started) return this.tail;
    this.started = true;
    return this.enqueue(() => this.startFn());
  }

  /** Mode A to B: the manager owns logComplete from here on. */
  transferCompletionToManager(): void {
    this.managerOwnsCompletion = true;
  }

  /** True once `start()` has claimed the start write. A completion without one
   *  cannot fabricate a row: FlightLogResult carries no cli/model/prompt. */
  get hasStarted(): boolean {
    return this.started;
  }

  /**
   * Write an inline `logComplete`, a no-op once the manager owns completion.
   * The returned promise settles when this request's writes have settled, so
   * awaiting it at a terminal branch is what keeps the response body from
   * being lost to an exit between the handler returning and the write landing.
   */
  completeInline(result: FlightLogResult): Promise<void> {
    if (this.managerOwnsCompletion) return this.tail;
    return this.enqueue(() => this.completeFn(result));
  }

  /** Settles when every write enqueued so far has settled. For drains. */
  settled(): Promise<void> {
    return this.tail;
  }

  /**
   * Returns the SWALLOWED tail rather than the raw run. Design 3.4 asks the
   * port to establish "logging must never fail a request"; structural here
   * beats asking fifteen terminal branches to remember a catch.
   */
  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.tail.then(op);
    this.tail = run.then(IGNORE, IGNORE);
    return this.tail;
  }
}
