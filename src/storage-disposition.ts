/**
 * What every storage input did, as one answer.
 *
 * The gateway takes four inputs that all sound like "where does state live":
 * `[persistence].backend`, `[persistence.roles]`, `DATABASE_URL` and
 * `LLM_GATEWAY_LOGS_DB`. They are NOT the same kind of thing, and the design
 * (storage-unification.md 3.3) says to treat them asymmetrically:
 *
 * - `[persistence].backend` selects the job store's ENGINE.
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
import { flightRecorderEngineDecision, resolveFlightRecorderDbPath } from "./flight-recorder.js";
import {
  resolveStorageRole,
  roleSeparationInForce,
  STORAGE_OPERATION_CLASSES,
  STORAGE_ROLES,
  type StorageOperationClass,
  type StorageRole,
} from "./storage/roles.js";

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
    engine: "sqlite" | null;
    path: string | null;
    /** Which input decided on/off. */
    decidedBy: "LLM_GATEWAY_LOGS_DB" | "default";
    /** Always false: the recorder does not follow `[persistence].backend`. */
    followsPersistenceBackend: boolean;
    engineRequested: string | null;
    engineDeferredBecause: string | null;
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
 * @param recorderEnabled The recorder instance's real state, when it is already
 * built. Omitted, the disposition reports the configured intent; a recorder
 * that failed to open logs its own error at construction.
 */
export function storageDisposition(
  persistence: PersistenceConfig,
  recorderEnabled?: boolean
): StorageDisposition {
  const recorderPath = resolveFlightRecorderDbPath();
  const enabled = recorderEnabled ?? recorderPath !== null;
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
      engine: enabled ? engine.engine : null,
      path: enabled ? recorderPath : null,
      decidedBy: process.env.LLM_GATEWAY_LOGS_DB !== undefined ? "LLM_GATEWAY_LOGS_DB" : "default",
      followsPersistenceBackend: false,
      engineRequested: engine.requested ?? null,
      engineDeferredBecause: engine.deferredBecause ?? null,
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

/** One block of stderr at startup, so the answer is in the log and not only in a tool. */
export function formatStorageDisposition(disposition: StorageDisposition): string[] {
  const { jobStore, requestHistory, roles } = disposition;
  const lines = [
    `Storage: job store backend="${jobStore.backend}" (async jobs ${jobStore.asyncJobsEnabled ? "enabled" : "DISABLED"})` +
      `${jobStore.path ? ` at ${jobStore.path}` : ""}`,
    requestHistory.enabled
      ? `Storage: request history is being written to ${requestHistory.path} (engine: ${requestHistory.engine}), which does NOT follow [persistence].backend`
      : "Storage: request history is NOT being written (LLM_GATEWAY_LOGS_DB=none); llm_request_list will return an empty list, which is not evidence that no request ran",
  ];
  if (jobStore.backend === "none" && requestHistory.enabled) {
    lines.push(
      'Storage: backend = "none" disables async job persistence ONLY. Request history is unaffected and is still being written; its switch is LLM_GATEWAY_LOGS_DB=none.'
    );
  }
  if (requestHistory.engineDeferredBecause) {
    lines.push(
      `Storage: request history is NOT following [persistence].backend = "${requestHistory.engineRequested}": ${requestHistory.engineDeferredBecause}`
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
