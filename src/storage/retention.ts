/**
 * One retention policy, over every subsystem the storage port carries (s11).
 *
 * Retention belonged to the job store: `[persistence].retentionDays` sets
 * `jobs.expires_at` and `evictExpired` deletes on a timer. Nothing else was
 * bounded, so the file that actually grows is the one no policy names. This
 * module is the policy as DATA. The sweeper, the drivers and every read-only
 * surface derive from it instead of restating it, which is what stops
 * `doctor.ts` hard-coding `unbounded = ["requests"]` a second time.
 *
 * Deleting transcript history is destructive and user-visible. All transcript
 * bounds default to OFF. An operator can opt into one bound for jobs and
 * requests together, or choose different explicit bounds with full visibility.
 */

/** The subsystems a retention bound can be expressed for. */
export type RetentionSubsystemId = "jobs" | "requests" | "wedgedValidationRuns";

export interface RetentionSubsystem {
  id: RetentionSubsystemId;
  /** The durable tables this bound deletes from, in delete order. */
  tables: readonly string[];
  /** Null means unbounded until an operator writes a number down. */
  defaultDays: number | null;
  /** True when eviction removes text a caller wrote or a provider produced. */
  destructive: boolean;
  rationale: string;
}

export const RETENTION_SUBSYSTEMS = {
  jobs: {
    id: "jobs",
    tables: ["jobs"],
    defaultDays: null,
    destructive: true,
    rationale:
      "Complete provider transcripts, launched argv and replay context remain available until an operator chooses a bound.",
  },
  requests: {
    id: "requests",
    tables: ["gateway_metadata", "requests"],
    defaultDays: null,
    destructive: true,
    rationale:
      "Prompt and response bodies. Applying the 30-day job default would delete a year of transcript history on upgrade, silently, from a host that never asked for it.",
  },
  wedgedValidationRuns: {
    id: "wedgedValidationRuns",
    tables: ["validation_run_jobs", "validation_runs"],
    defaultDays: null,
    destructive: true,
    rationale:
      "`request_json` holds the caller's question. A wedged run is unfinishable, not merely unfinished, but it is still the operator's data.",
  },
} as const satisfies Record<RetentionSubsystemId, RetentionSubsystem>;

export const RETENTION_SUBSYSTEM_IDS: readonly RetentionSubsystemId[] = [
  "jobs",
  "requests",
  "wedgedValidationRuns",
];

/**
 * WHAT MAKES A VALIDATION RUN WEDGED RATHER THAN MERELY LONG.
 *
 * `finalized` runs are never touched: their receipt is immutable and deleting
 * the run would orphan it. Every other status can still be minted by a caller
 * (`tryMint` refuses only `admitting` and `admission_failed`, and both of those
 * can never mint again), so age alone is not evidence of anything.
 *
 * The load-bearing clause is the third. While ANY linked job row survives,
 * `validation_receipt` mint-on-read can still finalize the run: it is
 * unfinished. Once job retention has evicted every linked job,
 * `readVerifiedLinkedJob` can no longer read the outputs a receipt is minted
 * from, so no code path in the gateway can ever move the row again.
 *
 * A zero-seat run has no linked job from the moment it is written, so clause 3
 * is true for it immediately and the horizon is the only thing protecting it.
 * That is deliberate and it is safe: the run row and its links are written in
 * one call milliseconds apart, and the horizon is a whole day at minimum.
 */
export const WEDGED_VALIDATION_RUN_DEFINITION = [
  "status is not 'finalized'",
  "created_at is older than the configured horizon",
  "no row in validation_run_jobs for it still points at a surviving job",
] as const;

/** Statuses a wedge sweep may consider. `finalized` is excluded by definition. */
export const REAPABLE_VALIDATION_RUN_STATUSES = [
  "admitting",
  "running",
  "judge_skipped",
  "admission_failed",
] as const;

/** Resolved bounds. Serialisable, because health surfaces report it verbatim. */
export interface RetentionPolicy {
  readonly days: Readonly<Record<RetentionSubsystemId, number | null>>;
}

export interface RetentionInput {
  /** `[persistence].retentionDays`, which has always meant the job store. */
  jobRetentionDays: number | null;
  /** `[persistence.retention]`, per subsystem. Absent keys keep the default. */
  overrides?: Partial<Record<RetentionSubsystemId, number>>;
}

export function resolveRetentionPolicy(input: RetentionInput): RetentionPolicy {
  const overrides = input.overrides ?? {};
  const days: Record<RetentionSubsystemId, number | null> = {
    jobs: overrides.jobs ?? input.jobRetentionDays,
    requests: overrides.requests ?? RETENTION_SUBSYSTEMS.requests.defaultDays,
    wedgedValidationRuns:
      overrides.wedgedValidationRuns ?? RETENTION_SUBSYSTEMS.wedgedValidationRuns.defaultDays,
  };
  return { days };
}

/**
 * The policy for a persistence config, including one built before this existed.
 *
 * `PersistenceConfig.retention` is optional because 58 test files construct
 * that object by hand and a required field would make every one of them a
 * different, missing-property object at runtime. This is the ONE place the
 * absence is answered, and it answers it with the same resolver
 * `loadPersistenceConfig` uses, so a hand-built config gets today's behaviour
 * rather than a second opinion about what the defaults are.
 */
export function persistenceRetentionPolicy(persistence: {
  retentionDays: number | null;
  retention?: RetentionPolicy;
}): RetentionPolicy {
  return (
    persistence.retention ?? resolveRetentionPolicy({ jobRetentionDays: persistence.retentionDays })
  );
}

export const MILLIS_PER_DAY = 86_400_000;

/** The ISO instant rows older than are eligible, or null when unbounded. */
export function retentionCutoffIso(
  policy: RetentionPolicy,
  id: RetentionSubsystemId,
  nowMs: number = Date.now()
): string | null {
  const days = policy.days[id];
  if (days === null || days === undefined) return null;
  return new Date(nowMs - days * MILLIS_PER_DAY).toISOString();
}

/** Subsystems nothing deletes from under this policy. */
export function unboundedRetentionSubsystems(policy: RetentionPolicy): RetentionSubsystemId[] {
  return RETENTION_SUBSYSTEM_IDS.filter(id => policy.days[id] === null);
}

/** True when at least one bound would actually delete something on a tick. */
export function retentionSweepEnabled(policy: RetentionPolicy): boolean {
  return policy.days.requests !== null || policy.days.wedgedValidationRuns !== null;
}

/**
 * Rows per statement and statements per tick.
 *
 * Both bounds exist for the same reason: the SQLite recorder serialises every
 * operation onto one driver queue, so an unbounded DELETE is an unbounded
 * pause on the request path. Each batch is its own transaction and the sweeper
 * awaits between them, which is what lets a logStart interleave.
 */
export const RETENTION_BATCH_ROWS = 500;
export const RETENTION_MAX_BATCHES_PER_TICK = 20;
export const DEFAULT_RETENTION_SWEEP_INTERVAL_MS = 3_600_000;

/**
 * What one subsystem's sweep did. `eligible` is the dry-run count taken BEFORE
 * the deletes, so a reader can tell "nothing to do" from "bound not set".
 */
export interface RetentionSubsystemOutcome {
  /** Null when the bound is unset, so nothing was counted. */
  eligible: number | null;
  deleted: number;
  /** True when the per-tick batch budget stopped it short of `eligible`. */
  budgetExhausted: boolean;
  error: string | null;
}

export interface RetentionSweepReport {
  at: string;
  subsystems: Record<RetentionSubsystemId, RetentionSubsystemOutcome>;
}

export function unsweptOutcome(): RetentionSubsystemOutcome {
  return { eligible: null, deleted: 0, budgetExhausted: false, error: null };
}

export function emptyRetentionSweepReport(at: string): RetentionSweepReport {
  return {
    at,
    subsystems: {
      jobs: unsweptOutcome(),
      requests: unsweptOutcome(),
      wedgedValidationRuns: unsweptOutcome(),
    },
  };
}
