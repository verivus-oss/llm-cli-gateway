/**
 * Per-subsystem operation signatures for the storage port (s3sig).
 *
 * s3 part 1 gave the port its operation classes, roles, connection seam and
 * inventory. This is part 2: what each subsystem asks the port FOR, named and
 * typed. No signature here takes or returns SQL, and none names PRAGMA or
 * VACUUM. That is what makes those two unreachable from the surface rather
 * than translated into it; `scripts/check-storage-port.mjs` holds the other
 * half, which is that no module outside the storage owners may spell them.
 *
 * Only the flight recorder is authored here. Jobs landed at s5 and their
 * surface is `JobStore`; sessions belong to s8. `STATE_GROUP_AUTHORSHIP`
 * records a determination for every inventory group including the ones nothing
 * carries, so an omission has to be written down rather than merely happen.
 */
import type {
  CacheAggregateRow,
  CompressionTelemetry,
  FlightLogResult,
  FlightLogStart,
  LcrPriorSourceRow,
  PersistedRequestRow,
  PersistedRequestSummaryRow,
  RequestSummaryFilter,
  RoutingDecisionRow,
  RoutingRecord,
} from "../flight-recorder.js";
import type { StorageOperationClass } from "./roles.js";
import type { StateGroupId } from "./store.js";

/**
 * An operation class, plus `lifecycle` for the ones that touch no rows.
 * `lifecycle` is deliberately not a `StorageOperationClass`: giving close() a
 * routed class is how an exceptional path starts looking routine, the same
 * reason the drivers keep `bootstrap` outside the four.
 */
export type SubsystemOperationClass = StorageOperationClass | "lifecycle";

/**
 * The flight recorder as the port will expose it, once s7 moves it.
 *
 * Every method is async because the port is. Three consequences that s6 and s7
 * inherit rather than rediscover:
 *
 * 1. Each write returns `Promise<void>` and NOT a boolean. s5 shipped
 *    `Promise<boolean>` meaning "applied" and a second writer read `false` as
 *    "another writer owns this row" when the other writer was itself. A void
 *    return cannot be misread that way; it can only be dropped, and
 *    `no-floating-promises` sees a dropped one.
 * 2. Each read returns a promise, so it is truthy before it resolves. Any
 *    `if (recorder.readRequestById(id))` is now always true;
 *    `npm run promise:conditions:check` is the control, and it covers
 *    `Boolean(p)` and `!!p` as well as the bare condition.
 * 3. `performShutdown` awaits jobStore.close() and does NOT await
 *    flightRecorder.close(), which is harmless only while the recorder is
 *    synchronous. s7 makes it exactly jobStore's old defect.
 */
export interface FlightRecorderOperations {
  /** Phase one of a request row. Await before treating the flight as started. */
  logStart(entry: FlightLogStart): Promise<void>;
  /** Phase two. Await before marking the request terminal, or a drain ends early. */
  logComplete(correlationId: string, result: FlightLogResult): Promise<void>;
  recordCompressionTelemetry(correlationId: string, telemetry: CompressionTelemetry): Promise<void>;
  recordRouting(correlationId: string, routing: RoutingRecord): Promise<void>;
  readCacheRowsBySession(sessionId: string): Promise<CacheAggregateRow[]>;
  readCacheRowsByPrefix(stablePrefixHash: string): Promise<CacheAggregateRow[]>;
  readCacheRowsGlobal(sinceIso?: string): Promise<CacheAggregateRow[]>;
  /** The ONE operation that returns prompt and response text. */
  readRequestById(correlationId: string): Promise<PersistedRequestRow | null>;
  listRequestSummaries(filter: RequestSummaryFilter): Promise<PersistedRequestSummaryRow[]>;
  readLcrPriorRows(): Promise<LcrPriorSourceRow[]>;
  readRoutingDecisions(limit: number): Promise<RoutingDecisionRow[]>;
  /** Drain, then shut the handles. Callers must await it; see note 3 above. */
  close(): Promise<void>;
}

/**
 * The class each recorder operation declares, once, as data. s7 routes with
 * this rather than passing a literal per call site. The difference is not
 * cosmetic: job-store.ts passes `"write"` at every site including its reads,
 * so on a deployment holding all four credentials its reads still run as `app`
 * and role separation is inert for that subsystem.
 *
 * `readRequestById` is the only `transcript_read`. Every other read projects
 * counts, hashes and routing economics; `PersistedRequestSummaryRow` carries
 * `prompt_chars` and `response_chars` but no body, which is why that
 * projection exists separately.
 */
export const FLIGHT_RECORDER_OPERATION_CLASSES = {
  logStart: "write",
  logComplete: "write",
  recordCompressionTelemetry: "write",
  recordRouting: "write",
  readCacheRowsBySession: "analytics_read",
  readCacheRowsByPrefix: "analytics_read",
  readCacheRowsGlobal: "analytics_read",
  readRequestById: "transcript_read",
  listRequestSummaries: "analytics_read",
  readLcrPriorRows: "analytics_read",
  readRoutingDecisions: "analytics_read",
  close: "lifecycle",
} as const satisfies Record<keyof FlightRecorderOperations, SubsystemOperationClass>;

/**
 * Members of the recorder class that are deliberately NOT operations, with the
 * reason each is excluded. The suite compares this plus the operation names
 * against the recorder's real method list, so a new method cannot appear on
 * one side only.
 */
export const FLIGHT_RECORDER_NON_OPERATIONS = {
  queryRequests:
    "Takes caller-supplied SQL, which is the anti-seam s2 removed. It survives as an internal of the SQLite implementation and the gate stops any other module calling it.",
} as const;

/**
 * `flush` was the second exclusion here until s7. s3sig left it unported and
 * said "an operation with no caller is a guess about s7's needs, and s7 can
 * ask". s7's answer is that it is not needed and would now be a lie: it was a
 * no-op because node:sqlite writes synchronously, and on the port a caller
 * reading the name would reasonably expect it to mean "my writes are durable",
 * which nothing here implements. `close()` is the operation that drains.
 * Deleted from the class as well, not merely from this list.
 */

/**
 * The two closures `FlightOwnership` (index.ts) holds, returning promises,
 * because the current fields are `() => void` and `(result) => void`: a slot
 * typed `void` accepts an async thunk in silence, and the class then sets its
 * `started` / `managerOwnsCompletion` idempotence flags against a write that
 * has not happened. s6 owns the conversion; these are the types it converts to.
 */
export type FlightStartSink = () => Promise<void>;
export type FlightCompleteSink = (result: FlightLogResult) => Promise<void>;

/** Where a state group's port operations are written, or why they are not. */
export type OperationAuthorship =
  { authored: true; surface: string } | { authored: false; reason: string };

/**
 * A determination per inventory group. Complete by construction: adding a
 * group to `STATE_INVENTORY` fails the build until it gets an entry here.
 */
export const STATE_GROUP_AUTHORSHIP = {
  sessions: { authored: false, reason: "s8.sessions owns it and is running now." },
  active_session_pointers: { authored: false, reason: "s8.sessions, as above." },
  jobs: { authored: true, surface: "JobStore in job-store.ts, landed at s5." },
  validation_runs: { authored: true, surface: "ValidationRunStore in job-store.ts, landed at s5." },
  validation_receipts: { authored: true, surface: "ValidationRunStore, as above." },
  kit_persistence: { authored: true, surface: "JobStore, landed at s5." },
  requests: { authored: true, surface: "FlightRecorderOperations, for s7 to implement." },
  gateway_metadata: {
    authored: true,
    surface:
      "FlightRecorderOperations: reached only through readRequestById and readRoutingDecisions, never on its own.",
  },
  approvals: {
    authored: false,
    reason:
      "No node in the DAG carries approvals.jsonl. Authoring operations for it would be a surface with no implementer and no caller.",
  },
  admin_audit: { authored: false, reason: "No node carries admin-audit.jsonl either." },
  workspace_registry: { authored: false, reason: "No node carries the file-backed registry." },
  capability_cache: { authored: false, reason: "Not in the port; derived state." },
  settings: { authored: false, reason: "Not in the port; configuration." },
} as const satisfies Record<StateGroupId, OperationAuthorship>;
