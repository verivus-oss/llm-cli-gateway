/**
 * Write ordering for the flight recorder's two phases (s6, design 3.4).
 *
 * A rule written in a plan is an unexecuted assertion. Every entry here names
 * the test that runs it, and `write-ordering-spec.test.ts` fails if that test
 * does not exist, so a rule cannot quietly stop being enforced. An entry that
 * nothing runs must say `unenforced` and say why, which is the only honest
 * third option.
 *
 * Owners: s6 converted FlightOwnership and the three flight sinks; s7 moves
 * the recorder itself onto the port and owns everything durable below it.
 */
export type WriteOrderingOwner = "s6" | "s7";

/** Rule ids: design 3.4's own failure list, its four unspecified items, and
 *  the three in-process invariants s6 added while converting the state machine. */
export type WriteOrderingRuleId =
  | "in_process_start_before_complete"
  | "idempotence_flags_not_straddled"
  | "inline_vs_manager_double_complete"
  | "crash_between_start_and_complete"
  | "cross_process_orphan_completion"
  | "rejected_start_poisons_chain"
  | "status_guarded_complete_updates_zero_rows"
  | "telemetry_before_start_row"
  | "immediate_read_after_write"
  | "correlation_id_reuse"
  | "unbounded_queue_growth"
  | "start_failure_policy"
  | "complete_timeout_semantics"
  | "unattached_completion_side_table"
  | "merge_fence";

interface RuleBase {
  /** The hazard, as design 3.4 states it. */
  mode: string;
  /** What must hold. */
  rule: string;
  owner: WriteOrderingOwner;
}

/**
 * `enforced` means the rule is a property of the code and a test fails without
 * it. `characterised` means the test pins what happens TODAY, including a loss,
 * so s7 has a target rather than a paragraph. `unenforced` means decided but
 * not yet running anywhere.
 */
export type WriteOrderingRule = RuleBase &
  (
    | { status: "enforced" | "characterised"; verifiedBy: readonly [string, ...string[]] }
    | { status: "unenforced"; unenforcedBecause: string }
  );

export const WRITE_ORDERING_RULES = {
  in_process_start_before_complete: {
    mode: "A completion can reach the database before the start row it attaches to.",
    rule: "FlightOwnership serialises this request's writes on one chain, so completeInline's sink runs only after start's sink has settled. Independently, every caller awaits start() before execute dispatches, which puts the start row down before the async manager can be armed to complete it.",
    owner: "s6",
    status: "enforced",
    verifiedBy: [
      "orders the completion sink behind a still-pending start sink",
      "does not complete the flight while logStart is still pending",
      "awaits every flight.start and flight.completeInline call site in index.ts",
    ],
  },
  idempotence_flags_not_straddled: {
    mode: "Awaiting inside a state machine whose idempotence is a boolean makes the boolean a race.",
    rule: "started and managerOwnsCompletion are read and set in the synchronous prologue, before the first await. A concurrent second call therefore cannot pass a guard the first has already claimed.",
    owner: "s6",
    status: "enforced",
    verifiedBy: [
      "a second concurrent start() enqueues exactly one start write",
      "a flag set after an await would admit a second write (negative control)",
    ],
  },
  inline_vs_manager_double_complete: {
    mode: "H-DoubleComplete: the handler inline-completes a flight the async manager was armed to finish.",
    rule: "transferCompletionToManager is synchronous and completeInline reads the flag before yielding, so a transfer taken while an earlier write is in flight still fences every later inline completion.",
    owner: "s6",
    status: "enforced",
    verifiedBy: ["fences a completion transferred while an earlier write is in flight"],
  },
  crash_between_start_and_complete: {
    mode: "Process crash or SIGKILL between start and complete.",
    rule: "The start row must survive the crash so a later instance can attach a completion to it. Nothing in process can cover this, which is why design revision 1's in-process queue was withdrawn.",
    owner: "s7",
    status: "characterised",
    verifiedBy: [
      "a SIGKILL after logStart leaves a durable started row a new process can complete",
    ],
  },
  cross_process_orphan_completion: {
    mode: "Orphan completion by a different gateway instance (async-job-manager #139 sweep).",
    rule: "A second instance completing another instance's row must land on the existing row and must not duplicate it. An in-process queue cannot see this case at all.",
    owner: "s7",
    status: "characterised",
    verifiedBy: ["a second recorder instance completes the first instance's started row"],
  },
  rejected_start_poisons_chain: {
    mode: "A rejected logStart promise poisoning or bypassing the chain.",
    rule: "The chain tail is a swallowed copy, so a rejected start neither stops later writes nor lets them jump ahead, and it raises no unhandled rejection at any of the terminal branches.",
    owner: "s6",
    status: "enforced",
    verifiedBy: ["a rejected start sink neither poisons nor bypasses the chain"],
  },
  status_guarded_complete_updates_zero_rows: {
    mode: "A status-guarded logComplete matching zero rows.",
    rule: "The metadata half of logComplete is fenced to status started, so a completion with no start row silently changes nothing and the response body is lost. s7 must route it to reconciliation rather than dropping it.",
    owner: "s7",
    status: "characterised",
    verifiedBy: ["a completion with no start row changes nothing and loses the response"],
  },
  telemetry_before_start_row: {
    mode: "recordRouting or compression telemetry racing a missing start row.",
    rule: "Both are post-hoc updates keyed on the request id, so before the start row exists they match nothing and the telemetry is lost. They are not on FlightOwnership's chain: s6 did not convert them, deliberately.",
    owner: "s7",
    status: "characterised",
    verifiedBy: ["routing telemetry written before the start row is lost"],
  },
  immediate_read_after_write: {
    mode: "Immediate read-after-write.",
    rule: "The recorder reads through a separate read-only connection. A read issued straight after a write must observe it.",
    owner: "s7",
    status: "characterised",
    verifiedBy: ["a read issued immediately after logStart observes the row"],
  },
  correlation_id_reuse: {
    mode: "Correlation-id reuse attaching a stale completion to an unrelated later start.",
    rule: "The request id is the primary key, so a reused id cannot start a second flight, and a later completion attaches to the FIRST row. The sinks swallow the collision, so nothing today tells the caller.",
    owner: "s7",
    status: "characterised",
    verifiedBy: ["a reused correlation id attaches the completion to the first row"],
  },
  unbounded_queue_growth: {
    mode: "Unbounded growth of the per-correlation queue map.",
    rule: "There is no map. The chain is a field on the request-scoped FlightOwnership and is collected with the request, which is the structural answer rather than an eviction policy.",
    owner: "s6",
    status: "enforced",
    verifiedBy: ["keeps no cross-request state, so there is no queue map to grow"],
  },
  start_failure_policy: {
    mode: "logStart failure policy: propagating fails the request, swallowing leaves no row to attach to.",
    rule: "Swallow and log, and make it structural rather than per call site: the sinks catch with the await INSIDE the try, and FlightOwnership hands callers a tail that cannot reject. Design 3.4 asks the port to establish logging must never FAIL a request; this is that half. The lost-row half is the side table, below.",
    owner: "s6",
    status: "enforced",
    verifiedBy: ["logs and survives a rejecting logStart rather than failing the request"],
  },
  complete_timeout_semantics: {
    mode: "A bounded completion write, where a race-style timeout neither cancels the query nor establishes whether it committed.",
    rule: "The bound must cancel the query and destroy the connection, never merely stop waiting. That is the same mechanism s13 owns for the whole-operation deadline, so the recorder inherits it rather than growing a second one.",
    owner: "s7",
    status: "unenforced",
    unenforcedBecause:
      "No bound exists on a recorder write today and adding one before the recorder is on the port would bound a synchronous call. s13 builds the cancelling deadline; s7 applies it.",
  },
  unattached_completion_side_table: {
    mode: "A completion with no start row cannot fabricate one: FlightLogResult carries no cli, model, prompt or start time and those columns are not nullable.",
    rule: "Such completions go to a reconciliation side table, never dropped and never fabricated. Its owner, access policy, retention and reuse protection are s7's to define with the transcript schema, because the side table is part of that schema.",
    owner: "s7",
    status: "unenforced",
    unenforcedBecause:
      "The side table is new authorship in the transcript schema s7 writes; defining it here would be a surface with no implementer, which this programme has paid for twice.",
  },
  merge_fence: {
    mode: "A delayed first completion arriving after the final one overwrites the final response.",
    rule: "Completion is a merge, not a no-op: last writer wins on the response body, terminal status is monotonic. Today the body update is unfenced and the status update is fenced to started, which gives monotonic status and last-writer-wins bodies but NO revision fence, so out-of-order arrivals are not distinguished.",
    owner: "s7",
    status: "characterised",
    verifiedBy: ["a late second completion refreshes the response and leaves the status monotonic"],
  },
} as const satisfies Record<WriteOrderingRuleId, WriteOrderingRule>;
