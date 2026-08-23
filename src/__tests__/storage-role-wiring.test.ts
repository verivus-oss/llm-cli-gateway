/**
 * `[persistence.roles]` must reach the DRIVER.
 *
 * `PostgresStorageDriver` has taken a per-role DSN map since s4 and kept a pool
 * per role, and nothing ever produced one: both production construction sites
 * passed `{ app: <the one dsn> }`, so every operation class degraded onto `app`
 * and the per-role pools were unreachable from configuration. Asserting that
 * the config PARSES a reader credential would not have caught that, which is
 * why what is asserted here is the argument the constructor received.
 *
 * No PostgreSQL server is involved: the driver module is mocked and the
 * constructions are recorded.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PersistenceConfig } from "../config.js";

const driverConstructions: Array<Record<string, string>> = [];

vi.mock("../storage/drivers/postgres.js", () => ({
  PostgresStorageDriver: class {
    constructor(dsns: Record<string, string>) {
      driverConstructions.push({ ...dsns });
    }
    async withConnection<T>(_operation: string, fn: (c: unknown) => Promise<T>): Promise<T> {
      return fn({ query: async () => [] });
    }
    async close(): Promise<void> {}
  },
  nodePostgresPoolFactory: async () => () => ({
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    end: async () => {},
  }),
  SESSION_POOL_SETTINGS: {},
}));

vi.mock("../postgres-job-store-ops.js", () => ({
  createPostgresJobStoreOps: () => ({
    init: async () => {},
    op: async () => null,
  }),
}));

const { createJobStore } = await import("../job-store.js");
const { DatabaseConnection } = await import("../db.js");

const APP = "postgresql://llmgw_app@db.example/gw";
const READER = "postgresql://llmgw_reader@db.example/gw";
const ANALYTICS = "postgresql://llmgw_analytics@db.example/gw";
const RETENTION = "postgresql://llmgw_retention@db.example/gw";
const FOUR = { app: APP, reader: READER, analytics: ANALYTICS, retention: RETENTION };

function persistence(roleDsns: Record<string, string>): PersistenceConfig {
  return {
    backend: "postgres",
    path: null,
    dsn: APP,
    roleDsns,
    retentionDays: 30,
    dedupWindowMs: 0,
    acknowledgeEphemeral: false,
    ownsOrphanRecovery: false,
    instanceHeartbeatMs: 15000,
    instanceLeaseTtlMs: 90000,
    httpJobGraceMs: 300000,
    orphanSweepIntervalMs: 30000,
    instanceGcMs: 3600000,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
    explicitBackend: true,
  };
}

describe("per-role credentials reach the Postgres driver", () => {
  beforeEach(() => {
    driverConstructions.length = 0;
  });

  it("the job store's driver holds every configured role", async () => {
    const store = createJobStore(persistence(FOUR));
    expect(store).not.toBeNull();
    // The store builds its driver on the first operation, not in the ctor.
    await store!.evictExpired().catch(() => undefined);
    expect(driverConstructions).toHaveLength(1);
    expect(driverConstructions[0]).toEqual(FOUR);
    await store!.close?.();
  });

  it("the job store's driver holds app alone when no roles are configured", async () => {
    const store = createJobStore(persistence({ app: APP }));
    await store!.evictExpired().catch(() => undefined);
    expect(driverConstructions[0]).toEqual({ app: APP });
    await store!.close?.();
  });

  it("[persistence].dsn is the single source for app, whatever the map carries", async () => {
    const store = createJobStore(persistence({ ...FOUR, app: "postgresql://impostor@x/y" }));
    await store!.evictExpired().catch(() => undefined);
    expect(driverConstructions[0].app).toBe(APP);
    await store!.close?.();
  });

  it("the session store's driver holds every configured role", async () => {
    const connection = new DatabaseConnection({
      database: {
        connectionString: APP,
        pool: {
          max: 10,
          idleTimeoutMillis: 1,
          connectionTimeoutMillis: 1,
          statementTimeout: 1,
        },
      },
      roleDsns: FOUR,
      sessionTtl: 1,
    });
    await connection.connect();
    expect(driverConstructions).toHaveLength(1);
    expect(driverConstructions[0]).toEqual(FOUR);
    await connection.disconnect();
  });

  it("the session store's driver holds app alone on a legacy DATABASE_URL host", async () => {
    const connection = new DatabaseConnection({
      database: {
        connectionString: APP,
        pool: {
          max: 10,
          idleTimeoutMillis: 1,
          connectionTimeoutMillis: 1,
          statementTimeout: 1,
        },
      },
      roleDsns: {},
      sessionTtl: 1,
    });
    await connection.connect();
    expect(driverConstructions[0]).toEqual({ app: APP });
    await connection.disconnect();
  });
});
