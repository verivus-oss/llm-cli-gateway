/**
 * The one thing that runs the retention policy, over every subsystem it names.
 *
 * A retention sweep is the timer-driven void sink this programme keeps finding:
 * `evictExpired` has always returned a count and the only reader was a
 * `logger.debug` guarded on `> 0`, so "swept and found nothing" and "never
 * swept" are the same observation from outside. Every method here returns the
 * report, `start()` KEEPS the last one, and a health surface prints it.
 *
 * `jobs` is deliberately not swept here. Its termination is the async job
 * manager's five-minute tick, interlocked with the durable-admission gate so a
 * gateway whose heartbeat lease has lapsed stops deleting; moving it would
 * change that interlock, which is a different node's work. The policy still
 * NAMES jobs, so a reader of the report sees one bound rather than two systems.
 */
import type { FlightRecorderOperations } from "./operations.js";
import {
  RETENTION_BATCH_ROWS,
  RETENTION_MAX_BATCHES_PER_TICK,
  emptyRetentionSweepReport,
  retentionCutoffIso,
  retentionSweepEnabled,
  type RetentionPolicy,
  type RetentionSubsystemOutcome,
  type RetentionSweepReport,
} from "./retention.js";

/** Only the two operations a sweep needs, so a test can supply exactly them. */
export type RetentionRecorder = Pick<
  FlightRecorderOperations,
  "readStorageStats" | "evictExpiredRequests"
>;

export interface RetentionValidationRuns {
  countWedgedValidationRuns(createdBeforeIso: string): Promise<number>;
  evictWedgedValidationRuns(createdBeforeIso: string, limit: number): Promise<number>;
}

export interface RetentionSweeperLogger {
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  debug?(message: string, meta?: unknown): void;
}

export interface RetentionSweeperOptions {
  recorder: RetentionRecorder;
  /** Null when the backend persists no validation runs (memory, none). */
  validationRuns: RetentionValidationRuns | null;
  policy: RetentionPolicy;
  logger: RetentionSweeperLogger;
  now?: () => number;
  batchRows?: number;
  maxBatches?: number;
}

function failed(error: unknown): RetentionSubsystemOutcome {
  return {
    eligible: null,
    deleted: 0,
    budgetExhausted: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export class RetentionSweeper {
  private readonly options: RetentionSweeperOptions;
  private readonly batchRows: number;
  private readonly maxBatches: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight = false;
  private last: RetentionSweepReport | null = null;

  constructor(options: RetentionSweeperOptions) {
    this.options = options;
    this.batchRows = options.batchRows ?? RETENTION_BATCH_ROWS;
    this.maxBatches = options.maxBatches ?? RETENTION_MAX_BATCHES_PER_TICK;
  }

  /** The last completed sweep, or null when none has run in this process. */
  lastSweep(): RetentionSweepReport | null {
    return this.last;
  }

  /** True when the timer is armed, so a health surface can say so. */
  get armed(): boolean {
    return this.timer !== null;
  }

  /**
   * Arm the timer, but only when a bound is actually set.
   *
   * A sweeper that ticks with every bound unset would issue counting queries
   * against a 1.2 GB file forever to prove there is nothing to do. Returns
   * whether it armed, so the caller can log the real state rather than assume.
   */
  start(intervalMs: number): boolean {
    if (this.timer !== null) return true;
    if (!retentionSweepEnabled(this.options.policy)) return false;
    this.timer = setInterval(() => {
      // The rejection is IMPOSSIBLE by construction (`sweep` catches per
      // subsystem), and the catch is here anyway because a `void` on a timer
      // callback is how an unhandled rejection takes the process down.
      void this.sweep().catch((error: unknown) => {
        this.options.logger.error("retention sweep failed", error);
      });
    }, intervalMs);
    this.timer.unref?.();
    return true;
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Count what a sweep WOULD delete. Deletes nothing.
   *
   * The policy is a PARAMETER because the most useful preview on a host with
   * every bound off is the hypothetical one: "if I set 30 days, what goes".
   * Under the configured policy an unset bound counts nothing, which is
   * correct and also unhelpful for the decision the operator is making.
   */
  async preview(policy: RetentionPolicy = this.options.policy): Promise<RetentionSweepReport> {
    return this.run(false, policy);
  }

  /** Count, then delete, then report what happened. */
  async sweep(): Promise<RetentionSweepReport> {
    // The guard is set in the SYNCHRONOUS prologue, before any await, so two
    // ticks arriving in one turn cannot both pass it. A previous report is a
    // truthful answer for the second caller: nothing new has happened yet.
    if (this.inFlight) return this.last ?? emptyRetentionSweepReport(this.nowIso());
    this.inFlight = true;
    try {
      const report = await this.run(true, this.options.policy);
      this.last = report;
      this.report(report);
      return report;
    } finally {
      this.inFlight = false;
    }
  }

  private nowIso(): string {
    return new Date(this.options.now?.() ?? Date.now()).toISOString();
  }

  private async run(destructive: boolean, policy: RetentionPolicy): Promise<RetentionSweepReport> {
    const nowMs = this.options.now?.() ?? Date.now();
    const report = emptyRetentionSweepReport(new Date(nowMs).toISOString());

    const requestsCutoff = retentionCutoffIso(policy, "requests", nowMs);
    if (requestsCutoff !== null) {
      report.subsystems.requests = await this.sweepRequests(requestsCutoff, destructive);
    }

    const runsCutoff = retentionCutoffIso(policy, "wedgedValidationRuns", nowMs);
    if (runsCutoff !== null && this.options.validationRuns) {
      report.subsystems.wedgedValidationRuns = await this.sweepWedgedRuns(runsCutoff, destructive);
    }
    return report;
  }

  private async sweepRequests(
    cutoffIso: string,
    destructive: boolean
  ): Promise<RetentionSubsystemOutcome> {
    try {
      // Counted BEFORE anything is deleted. `eligible` is what an operator was
      // shown by `preview`, so it has to mean the same number in both.
      const stats = await this.options.recorder.readStorageStats(cutoffIso);
      const eligible = stats.requestsBeyondRetention;
      if (!destructive) return { eligible, deleted: 0, budgetExhausted: false, error: null };
      let deleted = 0;
      let batches = 0;
      for (; batches < this.maxBatches; batches += 1) {
        const removed = await this.options.recorder.evictExpiredRequests(cutoffIso, this.batchRows);
        deleted += removed;
        if (removed < this.batchRows) break;
      }
      return {
        eligible,
        deleted,
        budgetExhausted: batches >= this.maxBatches,
        error: null,
      };
    } catch (error) {
      return failed(error);
    }
  }

  private async sweepWedgedRuns(
    cutoffIso: string,
    destructive: boolean
  ): Promise<RetentionSubsystemOutcome> {
    const store = this.options.validationRuns;
    if (!store) return failed(new Error("no validation run store"));
    try {
      const eligible = await store.countWedgedValidationRuns(cutoffIso);
      if (!destructive) return { eligible, deleted: 0, budgetExhausted: false, error: null };
      let deleted = 0;
      let batches = 0;
      for (; batches < this.maxBatches; batches += 1) {
        const removed = await store.evictWedgedValidationRuns(cutoffIso, this.batchRows);
        deleted += removed;
        if (removed < this.batchRows) break;
      }
      return { eligible, deleted, budgetExhausted: batches >= this.maxBatches, error: null };
    } catch (error) {
      return failed(error);
    }
  }

  /**
   * The count is READ here, not merely returned.
   *
   * `info`, not `debug`: deleting a caller's transcript is an event an operator
   * is entitled to find in a log, and the previous jobs sweep logged at debug
   * and only when it deleted something, so the one line that would have shown
   * a sweep running was invisible on a default log level.
   */
  private report(report: RetentionSweepReport): void {
    for (const [id, outcome] of Object.entries(report.subsystems)) {
      if (outcome.error !== null) {
        this.options.logger.error(`retention: ${id} sweep failed`, outcome.error);
        continue;
      }
      if (outcome.deleted > 0) {
        this.options.logger.info(
          `retention: deleted ${outcome.deleted} ${id} row(s) older than the configured bound` +
            (outcome.budgetExhausted ? "; per-tick budget reached, more remain" : "")
        );
      }
    }
  }
}
