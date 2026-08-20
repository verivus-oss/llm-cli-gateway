/**
 * The storage port: one asynchronous surface, pluggable drivers beneath.
 *
 * Async because sync-over-async needs a worker thread and async-over-sync does
 * not. That is a structural simplification, not a performance claim: wrapping
 * SQLite in a promise does not move its I/O off the event loop, and whether the
 * added overhead matters at the recorder's call rate is unassessable until the
 * benchmark in docs/plans/storage-unification.md section 9 exists.
 *
 * Drivers own their own SQL. The dialect audit found 50 of 77 statements
 * binding placeholders PostgreSQL rejects, plus divergent upsert forms, type
 * names and boolean representations, so a shared statement text with translated
 * placeholders would not have been enough. The seam here is connection, role
 * and transaction management; each engine's subsystem implementation writes its
 * own statements against it.
 */
import type { StorageOperationClass, StorageRole } from "./roles.js";

export type StorageEngine = "sqlite" | "postgres" | "memory";

/** A connection already bound to the credential for some operation class. */
export interface StorageConnection {
  query<T>(statement: string, params?: readonly unknown[]): Promise<T[]>;
  execute(statement: string, params?: readonly unknown[]): Promise<{ rowsAffected: number }>;
}

export interface StorageDriver {
  readonly engine: StorageEngine;
  /** Credentials this driver actually holds. Never includes a migrate identity. */
  readonly roles: ReadonlySet<StorageRole>;
  withConnection<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T>;
  transaction<T>(
    operation: StorageOperationClass,
    fn: (connection: StorageConnection) => Promise<T>
  ): Promise<T>;
  close(): Promise<void>;
}

/**
 * Every group of durable state this gateway owns, and whether the port carries
 * it. Recorded as data because the design requires the determination to be
 * explicit: anything omitted keeps its own write path, which is the defect the
 * port exists to remove.
 */
export interface StateGroup {
  id: string;
  /** Where it lives today. */
  current: string;
  inPort: boolean;
  /** Why, when it is not in the port. */
  note?: string;
}

export const STATE_INVENTORY: readonly StateGroup[] = [
  { id: "sessions", current: "sessions.json or Postgres", inPort: true },
  { id: "active_session_pointers", current: "sessions.json or Postgres", inPort: true },
  { id: "jobs", current: "logs.db or Postgres", inPort: true },
  { id: "validation_runs", current: "logs.db or Postgres", inPort: true },
  { id: "validation_receipts", current: "logs.db or Postgres", inPort: true },
  { id: "kit_persistence", current: "logs.db or Postgres", inPort: true },
  { id: "requests", current: "logs.db (SQLite only)", inPort: true },
  { id: "gateway_metadata", current: "logs.db (SQLite only)", inPort: true },
  { id: "approvals", current: "approvals.jsonl, 3.0 MB", inPort: true },
  { id: "admin_audit", current: "admin-audit.jsonl", inPort: true },
  { id: "workspace_registry", current: "file-backed", inPort: true },
  {
    id: "capability_cache",
    current: "capability-cache/",
    inPort: false,
    note: "Derived, not authoritative: rebuilt by probing the installed binaries. Losing it costs a re-probe, not state.",
  },
  {
    id: "settings",
    current: "settings.json, tunnel.json, claude-mcp.generated.json",
    inPort: false,
    note: "Configuration and generated output, not state the gateway accumulates.",
  },
];
