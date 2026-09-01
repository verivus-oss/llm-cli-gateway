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

/**
 * Only the two SQL engines implement StorageDriver. The design listed
 * `drivers/memory.ts` alongside them, but memory has no SQL, so it cannot
 * implement a connection seam whose currency is statements; forcing it to would
 * mean inventing a query language to interpret. Memory implements the
 * subsystem interfaces directly instead, which is what MemoryJobStore already
 * does. Recorded here because an unrecorded omission is how a subsystem keeps
 * its own write path.
 */
export const SQL_DRIVER_ENGINES: readonly StorageEngine[] = ["sqlite", "postgres"];

/** A connection already bound to the credential for some operation class. */
export interface StorageConnection {
  query<T>(statement: string, params?: readonly unknown[]): Promise<T[]>;
  execute(statement: string, params?: readonly unknown[]): Promise<{ rowsAffected: number }>;
  /**
   * Run a MULTI-STATEMENT script. Schema bootstrap only, never a routed read or
   * write, and it takes no parameters by design.
   *
   * It exists because `execute` cannot do this and fails in the worst possible
   * way if you assume it can: node:sqlite's `prepare()` compiles exactly ONE
   * statement, so a semicolon-separated DDL batch put through `execute` creates
   * the first table and silently discards the rest. No error at the call site;
   * the failure surfaces much later as "no such table". `db.exec()` is the
   * engine's own multi-statement entry point, and this is the seam for it.
   */
  executeScript(script: string): Promise<void>;
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
  /**
   * One pinned, repeatable snapshot for a READ class, and the mirror image of
   * `transaction`: that method refuses read classes, this one refuses write
   * classes, and neither is the other with a flag.
   *
   * `withConnection` runs each statement on whatever connection it can get, so
   * two successive reads can see two different states. A verify that hashes a
   * table row by row needs them to see ONE, or a concurrent writer moves a row
   * the digest has already passed and the check reports agreement it never had.
   *
   * This exists so that need has an answer inside the port. Without it the only
   * way to hold a snapshot was a private connection, which buys consistency by
   * giving up role routing, shutdown and error handling: the seam stops being a
   * seam precisely where the data matters most.
   */
  readSnapshot<T>(
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
  /**
   * The DAG node that puts this group on the port, or that already did.
   *
   * ABSENT ON AN `inPort` GROUP MEANS NOBODY IS CARRYING IT. s3 part 1 wrote
   * `inPort: true` for all eleven, which reads as a plan; three of them have no
   * node in `storage-unification.dag.toml` and never had one. That is an open
   * gap rather than scheduled work, and the suite pins the set so it cannot
   * grow quietly.
   */
  owningNode?: string;
  /** True once the owning node has landed and the port really does carry it. */
  carried?: boolean;
  /** Why, when it is not in the port. */
  note?: string;
}

export const STATE_INVENTORY = [
  { id: "sessions", current: "sessions.json or Postgres", inPort: true, owningNode: "s8.sessions" },
  {
    id: "active_session_pointers",
    current: "sessions.json or Postgres",
    inPort: true,
    owningNode: "s8.sessions",
  },
  {
    id: "jobs",
    current: "logs.db or Postgres",
    inPort: true,
    owningNode: "s5.job-store-first",
    carried: true,
  },
  {
    id: "validation_runs",
    current: "logs.db or Postgres",
    inPort: true,
    owningNode: "s5.job-store-first",
    carried: true,
    note: "Reached the port as part of JobStore, not as a subsystem of its own: `ValidationRunStore` is a capability the durable job stores add, and MemoryJobStore withholding it IS the durability gate.",
  },
  {
    id: "validation_receipts",
    current: "logs.db or Postgres",
    inPort: true,
    owningNode: "s5.job-store-first",
    carried: true,
    note: "Same surface as validation_runs; see that entry.",
  },
  {
    id: "kit_persistence",
    current: "logs.db or Postgres",
    inPort: true,
    owningNode: "s5.job-store-first",
    carried: true,
  },
  {
    id: "requests",
    current: "logs.db or Postgres",
    inPort: true,
    owningNode: "s7.flight-recorder-onto-the-port",
    carried: true,
    note: "The recorder follows the configured persistence backend through its engine-specific storage driver.",
  },
  {
    id: "gateway_metadata",
    current: "logs.db or Postgres",
    inPort: true,
    owningNode: "s7.flight-recorder-onto-the-port",
    carried: true,
    note: "Same decision as `requests`; it is read only through the joins behind readRequestById and readRoutingDecisions.",
  },
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
] as const satisfies readonly StateGroup[];

export type StateGroupId = (typeof STATE_INVENTORY)[number]["id"];
