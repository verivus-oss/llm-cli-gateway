import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import type { KitSessionBinding } from "../personal-config-types.js";

/** Every `sessions` column a fully migrated database exposes. */
const ALL_SESSION_COLUMNS = [
  "id",
  "cli",
  "description",
  "metadata",
  "created_at",
  "last_used_at",
  "owner_principal",
  "session_generation",
];

function isSessionSchemaProbe(statement: string): boolean {
  return statement.includes("to_regclass('sessions')");
}

function isKitSchemaProbe(statement: string): boolean {
  return statement.includes("to_regclass('kit_active_sessions')");
}

function binding(): KitSessionBinding {
  return {
    execution: {
      version: 1,
      releaseId: "preflight-release",
      configStamp: "preflight-stamp",
      scopeRoot: "/workspace/preflight",
      scopeHead: "preflight-head",
      contextIdentity: "preflight-context",
    },
    nativeSessionId: null,
    resumeEligible: false,
  };
}

/**
 * A pool whose catalog probe reports exactly `columns` on `sessions`. Passing
 * `tableMissing` models a database that never ran any session migration.
 */
function managerWithSessionColumns(
  columns: readonly string[],
  options: { tableMissing?: boolean } = {}
): {
  manager: PostgreSQLSessionManager;
  poolQuery: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  clientQuery: ReturnType<typeof vi.fn>;
} {
  const poolQuery = vi.fn(async (statement: string) => {
    if (isSessionSchemaProbe(statement)) {
      if (options.tableMissing) return { rows: [{ table_name: null, column_name: null }] };
      return {
        rows: columns.map(column => ({ table_name: "sessions", column_name: column })),
      };
    }
    if (isKitSchemaProbe(statement)) {
      return {
        rows: ["cli", "scope_key", "session_id", "updated_at"].map(column => ({
          table_name: "kit_active_sessions",
          column_name: column,
        })),
      };
    }
    return { rows: [], rowCount: 0 };
  });
  const clientQuery = vi.fn(async () => ({ rows: [], rowCount: 1 }));
  const client = { query: clientQuery, release: vi.fn() } as unknown as PoolClient;
  const connect = vi.fn().mockResolvedValue(client);
  const pool = { query: poolQuery, connect } as unknown as Pool;
  return { manager: new PostgreSQLSessionManager(pool), poolQuery, connect, clientQuery };
}

const withoutGeneration = ALL_SESSION_COLUMNS.filter(column => column !== "session_generation");

describe("PostgreSQLSessionManager session schema preflight", () => {
  it.each([
    ["createSession", (manager: PostgreSQLSessionManager) => manager.createSession("claude")],
    [
      "createSessionWithMetadata",
      (manager: PostgreSQLSessionManager) =>
        manager.createSessionWithMetadata("claude", undefined, "gw-preflight", {}),
    ],
    [
      "createKitSession",
      (manager: PostgreSQLSessionManager) => manager.createKitSession("claude", binding()),
    ],
  ])(
    "fails %s closed with the migration remedy when session_generation is absent",
    async (_operationName, operation) => {
      const { manager, connect } = managerWithSessionColumns(withoutGeneration);

      await expect(operation(manager)).rejects.toThrow(
        /sessions is missing: session_generation \(migration 021_session_generation_fence\)/
      );
      await expect(operation(manager)).rejects.toThrow(/npm run migrate/);
      // Fail closed: the remedy must surface before any write is attempted.
      expect(connect).not.toHaveBeenCalled();
    }
  );

  it("names every missing column and its migration", async () => {
    const { manager } = managerWithSessionColumns(
      ALL_SESSION_COLUMNS.filter(
        column => column !== "owner_principal" && column !== "session_generation"
      )
    );

    await expect(manager.createSession("claude")).rejects.toThrow(
      /sessions is missing: owner_principal \(migration 004_session_owner_principal\), session_generation \(migration 021_session_generation_fence\)/
    );
  });

  it("reports the missing table rather than a missing column", async () => {
    const { manager, connect } = managerWithSessionColumns([], { tableMissing: true });

    await expect(manager.createSession("claude")).rejects.toThrow(
      /Session PostgreSQL schema is missing sessions\. Run `DATABASE_URL=\.\.\. npm run migrate`/
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it.each([
    ["getSession", (manager: PostgreSQLSessionManager) => manager.getSession("gw-1")],
    ["listSessions", (manager: PostgreSQLSessionManager) => manager.listSessions()],
    ["clearAllSessions", (manager: PostgreSQLSessionManager) => manager.clearAllSessions()],
    [
      "compareAndSetSession",
      (manager: PostgreSQLSessionManager) =>
        manager.compareAndSetSession(
          {
            id: "gw-1",
            cli: "claude",
            createdAt: new Date().toISOString(),
            ownerPrincipal: "local",
            generation: "11111111-1111-4111-8111-111111111111",
          },
          { kind: "replace_metadata", metadata: {} }
        ),
    ],
  ])("fails %s closed when session_generation is absent", async (_operationName, operation) => {
    const { manager } = managerWithSessionColumns(withoutGeneration);

    await expect(operation(manager)).rejects.toThrow(/session_generation/);
  });

  it("probes the catalog once per pool and then proceeds to the write", async () => {
    const { manager, poolQuery, connect } = managerWithSessionColumns(ALL_SESSION_COLUMNS);

    const session = await manager.createSession("claude");
    await manager.createSession("codex");

    expect(session.generation).toBeTruthy();
    expect(connect).toHaveBeenCalledTimes(2);
    expect(
      poolQuery.mock.calls.filter(([sql]) => isSessionSchemaProbe(sql as string))
    ).toHaveLength(1);
  });

  it("re-probes after a failure so a later migrate heals the pool", async () => {
    const columns = [...withoutGeneration];
    const { manager, poolQuery } = managerWithSessionColumns(columns);

    await expect(manager.createSession("claude")).rejects.toThrow(/session_generation/);

    // The operator runs `npm run migrate`; the next call must not serve a
    // cached rejection.
    columns.push("session_generation");
    await expect(manager.createSession("claude")).resolves.toMatchObject({ cli: "claude" });
    expect(
      poolQuery.mock.calls.filter(([sql]) => isSessionSchemaProbe(sql as string))
    ).toHaveLength(2);
  });

  it("verifies the session schema before the Kit pointer repair statement", async () => {
    const { manager, poolQuery } = managerWithSessionColumns(withoutGeneration);

    await expect(manager.createKitSession("claude", binding())).rejects.toThrow(
      /session_generation/
    );
    // The Kit repair UPDATE reads sessions, so it must never run first.
    expect(poolQuery.mock.calls.some(([sql]) => (sql as string).includes("UPDATE sessions"))).toBe(
      false
    );
  });
});
