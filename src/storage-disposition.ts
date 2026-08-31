/**
 * What every storage input did, as one answer.
 *
 * The gateway takes four inputs that all sound like "where does state live":
 * `[persistence].backend`, `[persistence.roles]`, `DATABASE_URL` and
 * `LLM_GATEWAY_LOGS_DB`. They are NOT the same kind of thing, and the design
 * (storage-unification.md 3.3) says to treat them asymmetrically:
 *
 * - `[persistence].backend` selects the durable subsystems' ENGINE.
 * - `DATABASE_URL` is a deprecated DSN that also selects an engine, so it can
 *   contradict the backend; `[persistence]` wins and the refusal is reported.
 * - `LLM_GATEWAY_LOGS_DB` is a PATH, or the literal "none". It does not select
 *   an engine, and it is the flight recorder's own on/off switch.
 * - `[persistence.roles]` selects CREDENTIALS, not a database.
 *
 * The reconciliation this settles: `backend = "none"` disables async job
 * persistence and does NOT disable the flight recorder. Two subsystems, two
 * switches. Wiring `none` to the recorder as well would delete request history
 * on every host that set it to turn async jobs off, silently, and the recorder
 * already has a switch that says what it does.
 *
 * That leaves the real obligation: an operator must be able to tell what
 * happened to their request history. This is reporting only. Nothing gates on
 * it, so it can be a snapshot without becoming a fail-closed gate that reads
 * one.
 */
import { resolveDatabaseUrlPrecedence, type PersistenceConfig } from "./config.js";
import {
  flightRecorderEngineDecision,
  flightRecorderHealthMessage,
  resolveFlightRecorderDbPath,
  type FlightRecorderHealth,
  type FlightRecorderState,
} from "./flight-recorder.js";
import {
  resolveStorageRole,
  roleSeparationInForce,
  STORAGE_OPERATION_CLASSES,
  STORAGE_ROLES,
  type StorageOperationClass,
  type StorageRole,
} from "./storage/roles.js";
import { POSTGRES_RECORDER_TARGET } from "./storage/postgres-diagnostics.js";

export interface DeprecatedInputReport {
  name: string;
  set: boolean;
  outcome: string;
  reason: string | null;
}

export interface StorageDisposition {
  jobStore: {
    backend: PersistenceConfig["backend"];
    asyncJobsEnabled: boolean;
    path: string | null;
    dsnConfigured: boolean;
  };
  requestHistory: {
    enabled: boolean;
    /**
     * The recorder's OBSERVED state, or null when no recorder was handed over
     * and this disposition is reporting configured intent. `enabled` alone
     * cannot separate "the operator turned it off" from "it failed to open",
     * which is exactly how a corrupt logs.db read as a configuration choice.
     */
    state: FlightRecorderState | null;
    /** The failure behind `unavailable` / `degraded`, never a guess at one. */
    unavailableBecause: string | null;
    engine: "sqlite" | "postgres" | null;
    path: string | null;
    /** Which input decided on/off. */
    decidedBy: "LLM_GATEWAY_LOGS_DB" | "default";
    /**
     * True when `[persistence].backend` was honoured. It was hard-coded false,
     * which was correct while the recorder was SQLite-only and is now the
     * question an operator is actually asking.
     */
    followsPersistenceBackend: boolean;
    engineRequested: string | null;
  };
  roles: {
    configured: StorageRole[];
    separationInForce: boolean;
    /** Operation classes running on a wider credential than they asked for. */
    degraded: Array<{ operation: StorageOperationClass; wanted: StorageRole }>;
  };
  deprecatedInputs: DeprecatedInputReport[];
}

function roleReport(
  roleDsns: PersistenceConfig["roleDsns"] | undefined
): StorageDisposition["roles"] {
  // Filtered through STORAGE_ROLES so a key that is not a role cannot inflate
  // the report into claiming a credential the driver will never resolve to.
  // Tolerates an absent map because a hand-built config must not make a health
  // surface throw; absent means no credentials, which is the honest answer.
  const held0 = roleDsns ?? {};
  const configured = STORAGE_ROLES.filter(role => Boolean(held0[role]));
  const held = new Set(configured);
  if (held.size === 0) {
    return { configured: [], separationInForce: false, degraded: [] };
  }
  const degraded: StorageDisposition["roles"]["degraded"] = [];
  for (const operation of STORAGE_OPERATION_CLASSES) {
    const resolution = resolveStorageRole(operation, held);
    if (resolution.degradedFrom) degraded.push({ operation, wanted: resolution.degradedFrom });
  }
  return { configured: [...configured], separationInForce: roleSeparationInForce(held), degraded };
}

/**
 * @param persistence Resolved persistence config.
 * @param recorder The recorder instance's real health, when it is already
 * built. It used to be a BOOLEAN, and that is the defect this parameter now
 * carries the fix for: `false` was produced both by `LLM_GATEWAY_LOGS_DB=none`
 * and by a failed open, and the startup line then named the environment
 * variable in both cases. Omitted, the disposition reports configured intent
 * and says so by leaving `state` null.
 */
export function storageDisposition(
  persistence: PersistenceConfig,
  recorder?: FlightRecorderHealth
): StorageDisposition {
  const recorderPath = resolveFlightRecorderDbPath();
  const enabled = recorder
    ? recorder.state !== "disabled" && recorder.state !== "unavailable"
    : recorderPath !== null;
  const engine = flightRecorderEngineDecision(persistence.backend);
  const databaseUrl = resolveDatabaseUrlPrecedence({
    databaseUrl: process.env.DATABASE_URL,
    persistenceDsn: persistence.backend === "postgres" ? persistence.dsn : null,
    explicitBackend: persistence.explicitBackend,
    backend: persistence.backend,
  });
  return {
    jobStore: {
      backend: persistence.backend,
      asyncJobsEnabled: persistence.asyncJobsEnabled,
      path: persistence.path,
      dsnConfigured: Boolean(persistence.dsn),
    },
    requestHistory: {
      enabled,
      state: recorder?.state ?? null,
      unavailableBecause: recorder?.error ?? null,
      engine: enabled ? engine.engine : null,
      // The path is reported for a FAILED open too. "Which file could not be
      // opened" is the first thing an operator needs and the old boolean
      // nulled it out alongside a message blaming the configuration.
      // PostgreSQL is deliberately opaque here. Reporting the SQLite path for
      // configured intent would name a file the gateway will not write.
      path:
        recorder?.path ??
        (enabled ? (engine.engine === "postgres" ? POSTGRES_RECORDER_TARGET : recorderPath) : null),
      decidedBy: process.env.LLM_GATEWAY_LOGS_DB !== undefined ? "LLM_GATEWAY_LOGS_DB" : "default",
      followsPersistenceBackend: true,
      engineRequested: engine.requested ?? null,
    },
    roles: roleReport(persistence.roleDsns),
    deprecatedInputs: [
      {
        name: "DATABASE_URL",
        set: databaseUrl.outcome !== "absent",
        outcome: databaseUrl.outcome,
        reason: databaseUrl.reason,
      },
      logsDbReport(persistence),
    ],
  };
}

function logsDbReport(persistence: PersistenceConfig): DeprecatedInputReport {
  const raw = process.env.LLM_GATEWAY_LOGS_DB;
  if (raw === undefined || raw.length === 0) {
    return { name: "LLM_GATEWAY_LOGS_DB", set: false, outcome: "absent", reason: null };
  }
  const disablesRecorder = raw.trim().toLowerCase() === "none";
  const tookJobStore = persistence.sources.envOverrides.includes("LLM_GATEWAY_LOGS_DB");
  return {
    name: "LLM_GATEWAY_LOGS_DB",
    set: true,
    outcome: disablesRecorder ? "recorder_disabled" : "recorder_path",
    reason: disablesRecorder
      ? "LLM_GATEWAY_LOGS_DB=none turns the flight recorder OFF. It is deprecated as a job-store selector but remains the recorder's own switch; " +
        (tookJobStore
          ? 'it also set [persistence].backend = "none" here.'
          : "[persistence] governs the job store separately.")
      : "LLM_GATEWAY_LOGS_DB is deprecated; it still paths the flight recorder. " +
        (tookJobStore
          ? "It also selected the job store's SQLite file, because no [persistence].backend was written down."
          : "[persistence] governs the job store separately."),
  };
}

/**
 * The recorder half of the startup block, in the recorder's own words.
 *
 * `state === null` means no recorder was handed over, so the only honest thing
 * to report is the configured intent; every other case defers to
 * `flightRecorderHealthMessage`, which is the single owner of these sentences.
 */
function recorderLine(requestHistory: StorageDisposition["requestHistory"]): string {
  if (requestHistory.state === null) {
    return "request history is NOT being written (LLM_GATEWAY_LOGS_DB=none); llm_request_list will return an empty list, which is not evidence that no request ran";
  }
  const message =
    flightRecorderHealthMessage({
      state: requestHistory.state,
      path: requestHistory.path,
      error: requestHistory.unavailableBecause,
      errorAt: null,
      failureCount: 0,
      closed: false,
    }) ?? `request history is being written to ${requestHistory.path}`;
  const lead = requestHistory.enabled
    ? "request history may be INCOMPLETE."
    : "request history is NOT being written.";
  return `${lead} ${message}`;
}

/** One block of stderr at startup, so the answer is in the log and not only in a tool. */
export function formatStorageDisposition(disposition: StorageDisposition): string[] {
  const { jobStore, requestHistory, roles } = disposition;
  const lines = [
    `Storage: job store backend="${jobStore.backend}" (async jobs ${jobStore.asyncJobsEnabled ? "enabled" : "DISABLED"})` +
      `${jobStore.path ? ` at ${jobStore.path}` : ""}`,
    requestHistory.enabled && requestHistory.state !== "degraded"
      ? `Storage: request history is being written to ${requestHistory.path} (engine: ${requestHistory.engine}), which ` +
        (requestHistory.followsPersistenceBackend
          ? "DOES follow [persistence].backend"
          : "does NOT follow [persistence].backend")
      : // Derived, never authored here. The startup line used to name
        // LLM_GATEWAY_LOGS_DB=none whenever the recorder was absent, including
        // when the file was there and unreadable.
        `Storage: ${recorderLine(requestHistory)}`,
  ];
  if (jobStore.backend === "none" && requestHistory.enabled) {
    lines.push(
      'Storage: backend = "none" disables async job persistence ONLY. Request history is unaffected and is still being written; its switch is LLM_GATEWAY_LOGS_DB=none.'
    );
  }
  if (requestHistory.engineRequested === "postgres" && requestHistory.enabled) {
    lines.push(
      `Storage: request history IS following [persistence].backend = "postgres". Rows written before this switch stay in the SQLite file and are NOT migrated.`
    );
  }
  lines.push(
    roles.configured.length === 0
      ? "Storage: no [persistence.roles] credentials; role separation is NOT in force"
      : roles.separationInForce
        ? `Storage: role separation IS in force (${roles.configured.join(", ")})`
        : `Storage: role separation is PARTIAL (${roles.configured.join(", ")}); ` +
          `${roles.degraded.map(d => `${d.operation} wanted "${d.wanted}"`).join(", ")} degraded onto "app"`
  );
  for (const input of disposition.deprecatedInputs) {
    if (input.set && input.reason) lines.push(`Storage: ${input.reason}`);
  }
  return lines;
}
