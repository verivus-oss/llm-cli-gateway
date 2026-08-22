/**
 * What both flight recorders are, minus the engine.
 *
 * A second engine arrived (s7pg) and exactly two things had to be shared rather
 * than copied: the FIVE-state health snapshot, which is the obs node's operator
 * contract, and the in-flight tracking that makes `close()` a real drain. Two
 * engines each keeping their own copy of that state machine is how one of them
 * quietly starts reporting `active` for a recorder whose bootstrap failed. The
 * SQL, the schema and the row shapes stay per engine, as the port requires.
 *
 * It imports only TYPES from `flight-recorder.ts`, so there is no runtime edge
 * back and the factory there can import the Postgres recorder without a cycle.
 */
import type { FlightRecorderHealth, FlightRecorderState } from "./flight-recorder.js";

const MAX_THINKING_BYTES = 1_000_000;

const TRUNCATION_SUFFIX = "[TRUNCATED]";
const TRUNCATION_SUFFIX_BYTES = Buffer.byteLength(TRUNCATION_SUFFIX, "utf8");

export function truncateThinkingBlocks(blocks: string[]): string[] {
  const result: string[] = [];
  let used = 0;

  for (const block of blocks) {
    const bytes = Buffer.byteLength(block, "utf8");
    if (used + bytes <= MAX_THINKING_BYTES) {
      result.push(block);
      used += bytes;
      continue;
    }

    // Reserve space for the suffix so total stays within budget
    const budget = Math.max(0, MAX_THINKING_BYTES - used - TRUNCATION_SUFFIX_BYTES);
    if (budget > 0) {
      // Truncate on code point boundaries by using string iteration
      let charBytes = 0;
      let safeEnd = 0;
      for (const char of block) {
        const charSize = Buffer.byteLength(char, "utf8");
        if (charBytes + charSize > budget) break;
        charBytes += charSize;
        safeEnd += char.length; // char.length handles surrogate pairs
      }
      const sliced = block.slice(0, safeEnd);
      result.push(sliced ? `${sliced}${TRUNCATION_SUFFIX}` : TRUNCATION_SUFFIX);
    } else {
      result.push(TRUNCATION_SUFFIX);
    }
    break;
  }

  return result;
}

/**
 * The lifecycle every recorder has, whatever engine is underneath it.
 *
 * Extracted at the point a second engine appeared, and deliberately only this
 * much: the FIVE-state health snapshot is the obs node's operator contract, and
 * two engines each keeping their own copy of that state machine is how one of
 * them quietly starts reporting `active` for a recorder whose bootstrap failed.
 * The SQL, the schema and the row shapes stay per engine, which is what the
 * port requires.
 *
 * `run` registers SYNCHRONOUSLY, before the caller receives the promise, so
 * `logStart(x); close()` in one tick still drains the write. The driver's own
 * bounded drain cannot: it covers work already submitted to its queue, and
 * every operation has at least one await in front of that.
 */
export class FlightRecorderRuntime {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly target: string | null;
  private schemaState: "initialising" | "ready" | "failed" = "initialising";
  private lastFailure: { error: string; at: string } | null = null;
  private failureCount = 0;
  private closed = false;

  constructor(target: string | null) {
    this.target = target;
  }

  markReady(): void {
    this.schemaState = "ready";
  }

  /**
   * Recorded here and not only where a constructor swallows the first failure:
   * that catch fires once, and an operation that retries the bootstrap and
   * fails again must still leave the failure on the health snapshot.
   */
  markFailed(error: unknown): void {
    this.schemaState = "failed";
    this.noteFailure(error);
  }

  private noteFailure(error: unknown): void {
    this.failureCount += 1;
    this.lastFailure = {
      error: error instanceof Error ? error.message : String(error),
      at: new Date().toISOString(),
    };
  }

  /**
   * SYNCHRONOUS deliberately: this is a report, nothing gates on it, and a
   * health surface that has to await the subsystem it reports on cannot answer
   * while that subsystem is wedged. The cost is that it can be taken
   * mid-bootstrap, which is why `initialising` is a state and not an optimistic
   * `active`.
   */
  health(): FlightRecorderHealth {
    const state: FlightRecorderState =
      this.schemaState === "failed" || this.lastFailure
        ? "degraded"
        : this.schemaState === "initialising"
          ? "initialising"
          : "active";
    return {
      state,
      path: this.target,
      error: this.lastFailure?.error ?? null,
      errorAt: this.lastFailure?.at ?? null,
      failureCount: this.failureCount,
      closed: this.closed,
    };
  }

  /**
   * Start one operation, track it, and watch its outcome WITHOUT changing it.
   * The rejection is re-thrown: a failure that reached a caller before must
   * still reach it. All this adds is that it also lands on the snapshot.
   */
  run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("flight recorder is closed"));
    const tracked = operation().then(
      value => {
        this.lastFailure = null;
        return value;
      },
      (error: unknown) => {
        this.noteFailure(error);
        throw error;
      }
    );
    this.inFlight.add(tracked);
    const forget = (): void => {
      this.inFlight.delete(tracked);
    };
    void tracked.then(forget, forget);
    return tracked;
  }

  /** Refuse new work, then let what is already running settle. */
  async close(): Promise<void> {
    this.closed = true;
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }
}

/**
 * SQLite implementation of `FlightRecorderOperations`, over the storage port.
 *
 * s7 of docs/plans/storage-unification.dag.toml. The recorder no longer holds a
 * `GatewayDatabase`: it holds a `SqliteStorageDriver`, so its writes share one
 * serialised queue, one bounded drain and one whole-operation deadline with
 * every other subsystem on the port.
 *
 * ASYNC, and three consequences the port's header spells out. Construction no
 * longer implies the schema exists, so every operation awaits `ensureSchema()`.
 * Every write returns `Promise<void>`, so a dropped one is a floating promise a
 * lint rule can see. Every read returns a promise, so it is truthy before it
 * resolves and `npm run promise:conditions:check` is the control for that.
 *
 * What it does NOT do, by operator decision 0a: choose Postgres. See
 * `flightRecorderEngineDecision`.
 */
