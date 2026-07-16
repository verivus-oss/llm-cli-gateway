import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PostgreSQLSessionManager } from "../session-manager-pg.js";
import type { KitSessionBinding } from "../personal-config-types.js";

function binding(): KitSessionBinding {
  return {
    execution: {
      version: 1,
      releaseId: "rollback-release",
      configStamp: "rollback-stamp",
      scopeRoot: "/workspace/rollback",
      scopeHead: "rollback-head",
      contextIdentity: "rollback-context",
    },
    nativeSessionId: null,
    resumeEligible: false,
  };
}

function managerWhoseRollbackFails(
  primaryError: Error,
  rollbackError: Error
): {
  manager: PostgreSQLSessionManager;
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
} {
  const release = vi.fn();
  const query = vi.fn(async (statement: string) => {
    if (statement === "ROLLBACK") throw rollbackError;
    if (statement.includes("INSERT INTO sessions")) throw primaryError;
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release } as unknown as PoolClient;
  const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  const manager = new PostgreSQLSessionManager(pool);
  // These suites exercise rollback, not the schema preflight, so both cached
  // readiness gates are pre-satisfied.
  (manager as unknown as { kitPointerSchemaReady: Promise<void> | null }).kitPointerSchemaReady =
    Promise.resolve();
  (manager as unknown as { sessionSchemaReady: Promise<void> | null }).sessionSchemaReady =
    Promise.resolve();
  return { manager, query, release };
}

describe("PostgreSQLSessionManager transaction rollback failures", () => {
  it.each([
    ["createSession", (manager: PostgreSQLSessionManager) => manager.createSession("claude")],
    [
      "createKitSession",
      (manager: PostgreSQLSessionManager) => manager.createKitSession("claude", binding()),
    ],
    [
      "importKitSession",
      (manager: PostgreSQLSessionManager) => manager.importKitSession("claude", binding()),
    ],
  ])("preserves the primary failure for %s", async (_operationName, operation) => {
    const primaryError = new Error("primary database failure");
    const rollbackError = new Error("rollback database failure");
    const { manager, query, release } = managerWhoseRollbackFails(primaryError, rollbackError);

    await expect(operation(manager)).rejects.toBe(primaryError);
    expect(query).toHaveBeenCalledWith("ROLLBACK");
    expect(release).toHaveBeenCalledTimes(1);
  });
});
