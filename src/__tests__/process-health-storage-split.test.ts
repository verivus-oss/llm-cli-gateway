/**
 * `llm_process_health` must disclose both storage subsystems and the
 * authoritative engine selection without exposing a PostgreSQL DSN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer, createRuntimeRetentionSweeper } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import {
  createFlightRecorder,
  FlightRecorder,
  NoopFlightRecorder,
  type FlightRecorderLike,
} from "../flight-recorder.js";
import { PostgresFlightRecorder } from "../flight-recorder-pg.js";
import type { PgPoolLike } from "../storage/drivers/postgres.js";
import { resolveRetentionPolicy } from "../storage/retention.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { runWithRequestContext } from "../request-context.js";
import { collectStorageHealth } from "../doctor.js";

interface RegisteredTool {
  handler: (
    args: Record<string, unknown>,
    extra?: Record<string, unknown>
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

function mkPersistence(overrides: Partial<PersistenceConfig> = {}): PersistenceConfig {
  return {
    backend: "sqlite",
    path: join(tmpdir(), "jobs.db"),
    dsn: null,
    retentionDays: 30,
    dedupWindowMs: 3600000,
    acknowledgeEphemeral: true,
    ownsOrphanRecovery: false,
    asyncJobsEnabled: true,
    sources: { configFile: null, envOverrides: [] },
    ...overrides,
  };
}

describe("llm_process_health discloses storage disposition", () => {
  let tmp: string;
  let flight: FlightRecorder;
  const savedEnv = process.env.LLM_GATEWAY_LOGS_DB;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "health-split-"));
    process.env.LLM_GATEWAY_LOGS_DB = join(tmp, "logs.db");
    flight = new FlightRecorder(join(tmp, "logs.db"));
  });

  afterEach(async () => {
    await flight.close();
    if (savedEnv === undefined) delete process.env.LLM_GATEWAY_LOGS_DB;
    else process.env.LLM_GATEWAY_LOGS_DB = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function health(
    persistence: PersistenceConfig,
    recorder: FlightRecorder | PostgresFlightRecorder | NoopFlightRecorder = flight
  ): Promise<Record<string, any>> {
    const server = createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(
        noopLogger,
        undefined,
        persistence.backend === "postgres" ? null : new MemoryJobStore()
      ),
      persistence,
      flightRecorder: recorder,
    });
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const res = await runWithRequestContext({ transport: "stdio", authScopes: [] }, () =>
      reg["llm_process_health"].handler({}, {})
    );
    return JSON.parse(res.content[0].text);
  }

  function postgresRecorder(
    queryError?: Error,
    logger: typeof noopLogger = noopLogger
  ): PostgresFlightRecorder {
    const client = {
      query: async (): Promise<{ rows: unknown[]; rowCount: number }> => {
        if (queryError) throw queryError;
        return { rows: [], rowCount: 0 };
      },
      release: (): void => {},
    };
    const pool: PgPoolLike = {
      query: client.query,
      connect: async () => client,
      end: async (): Promise<void> => {},
    };
    return new PostgresFlightRecorder(
      { app: "postgresql://app@127.0.0.1/gateway" },
      { poolFactory: () => pool, logger }
    );
  }

  it("joins an in-flight PostgreSQL bootstrap before closing its pool", async () => {
    let rejectBootstrap!: (error: Error) => void;
    let markQueryStarted!: () => void;
    const queryStarted = new Promise<void>(resolve => {
      markQueryStarted = resolve;
    });
    const end = vi.fn(async (): Promise<void> => {});
    const query = vi.fn(
      () =>
        new Promise<{ rows: unknown[]; rowCount: number }>((_resolve, reject) => {
          rejectBootstrap = reject;
          markQueryStarted();
        })
    );
    const client = { query, release: (): void => {} };
    const pool: PgPoolLike = {
      query,
      connect: async () => client,
      end,
    };
    const recorder = new PostgresFlightRecorder(
      { app: "postgresql://app@127.0.0.1/gateway" },
      { poolFactory: () => pool, logger: noopLogger }
    );
    await queryStarted;

    const closing = recorder.close();
    await Promise.resolve();
    expect(end).not.toHaveBeenCalled();
    rejectBootstrap(new Error("bootstrap stopped for close test"));
    await closing;

    expect(end).toHaveBeenCalledOnce();
    expect(recorder.health().closed).toBe(true);
  });

  it("keeps doctor warnings generic when a PostgreSQL recorder operation fails", async () => {
    const configPath = join(tmp, "config.toml");
    writeFileSync(
      configPath,
      '[persistence]\nbackend = "postgres"\ndsn = "postgresql://app@127.0.0.1/gateway"\n'
    );
    vi.stubEnv("LLM_GATEWAY_CONFIG", configPath);
    const marker = "connect ENOENT /tmp/raw-dsn-derived-target/.s.PGSQL.5432";
    const recorder = postgresRecorder(new Error(marker));
    try {
      const storage = await collectStorageHealth(recorder);
      expect(storage.flight_recorder.path).toBe("postgresql");
      expect(storage.flight_recorder.error).toBe("PostgreSQL operation failed");
      expect(storage.warnings.join(" ")).toContain("PostgreSQL operation failed");
      expect(storage.warnings.join(" ")).not.toContain(marker);
    } finally {
      await recorder.close();
    }
  });

  it("constructs the PostgreSQL recorder without creating the configured SQLite file", async () => {
    const sqlitePath = join(tmp, "must-not-exist.db");
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", sqlitePath);
    const recorder = createFlightRecorder(noopLogger, "postgres", {
      app: "postgresql://app@127.0.0.1:1/gateway?connect_timeout=1",
    });
    try {
      expect(recorder).toBeInstanceOf(PostgresFlightRecorder);
      expect(existsSync(sqlitePath)).toBe(false);
    } finally {
      await recorder.close();
    }
  });

  it("names PostgreSQL without exposing its DSN", async () => {
    const recorder = postgresRecorder();
    try {
      const res = await health(
        mkPersistence({ backend: "postgres", path: null, dsn: "postgres://x" }),
        recorder
      );

      // The job store block alone is what misled callers: no path at all.
      expect(res.persistence.backend).toBe("postgres");
      expect(res.persistence.dbPath).toBeNull();

      // The recorder block supplies what was missing.
      expect(res.flightRecorder.engine).toBe("postgres");
      expect(res.flightRecorder.path).toBe("postgresql");
      expect(res.flightRecorder.enabled).toBe(true);
      expect(res.flightRecorder.followsPersistenceBackend).toBe(true);
    } finally {
      await recorder.close();
    }
  });

  it("wires the generic PostgreSQL formatter into runtime retention health", async () => {
    const sweeper = createRuntimeRetentionSweeper({
      recorder: {
        readStorageStats: async () => {
          throw new Error("connect ENOENT /tmp/runtime-dsn-secret/.s.PGSQL.5432");
        },
        evictExpiredRequests: async () => 0,
      } as unknown as FlightRecorderLike,
      validationRuns: null,
      persistence: mkPersistence({
        backend: "postgres",
        path: null,
        dsn: "postgresql://app@127.0.0.1/gateway",
        retention: resolveRetentionPolicy({
          jobRetentionDays: 30,
          overrides: { requests: 1 },
        }),
      }),
      logger: noopLogger,
    });

    const report = await sweeper.sweep();
    expect(report.subsystems.requests.error).toBe("PostgreSQL operation failed");
    expect(report.subsystems.requests.error).not.toContain("runtime-dsn-secret");
  });

  it("keeps recorder health generic while preserving the raw error in internal logs", async () => {
    const marker = "ungated-dsn-health-secret";
    const error = vi.fn();
    const recorder = postgresRecorder(new Error(`connect ENOENT /tmp/${marker}`), {
      ...noopLogger,
      error,
    });
    try {
      await expect(recorder.readStorageStats()).rejects.toThrow(marker);
      expect(recorder.health().error).toBe("PostgreSQL operation failed");
      expect(recorder.health().error).not.toContain(marker);
      const logs = error.mock.calls
        .flat()
        .map(value => (value instanceof Error ? value.message : String(value)))
        .join(" ");
      expect(logs).toContain(marker);
    } finally {
      await recorder.close();
    }
  });

  it("reports preserved pre-switch history without claiming an active split", async () => {
    const recorder = postgresRecorder();
    try {
      const res = await health(
        mkPersistence({ backend: "postgres", path: null, dsn: "postgres://x" }),
        recorder
      );

      expect(res.flightRecorder.warning).not.toContain("SPLIT");
      expect(res.flightRecorder.warning).toContain("Request history is using PostgreSQL");
      expect(res.flightRecorder.warning).not.toContain("moved to PostgreSQL");
      expect(res.flightRecorder.warning).toContain("were NOT migrated");
      expect(res.flightRecorder.warning).toContain(join(tmp, "logs.db"));
    } finally {
      await recorder.close();
    }
  });

  it("does not cry split when both subsystems are SQLite", async () => {
    const res = await health(mkPersistence({ backend: "sqlite" }));

    // NOT `toBeNull()` any more, and the reason is a finding rather than a
    // concession: this assertion used to pass because the surface had nothing
    // else to say. It now reports the recorder's own state, and the state at
    // this point in a real call is `initialising` often enough to be observed
    // here, on a recorder built one `await` earlier whose schema DDL has not
    // finished. Asserting null again would be asserting that a health surface
    // stays quiet about a recorder it cannot yet vouch for.
    expect(res.flightRecorder.warning ?? "").not.toContain("SPLIT");
    expect(["active", "initialising"]).toContain(res.flightRecorder.state);
    // Still discloses the recorder, because "same engine" is not "same file".
    expect(res.flightRecorder.engine).toBe("sqlite");
    expect(res.flightRecorder.path).toBe(join(tmp, "logs.db"));
  });

  it("reports disabled recording as such, not as an empty history", async () => {
    const res = await health(mkPersistence({ backend: "sqlite" }), new NoopFlightRecorder());

    expect(res.flightRecorder.enabled).toBe(false);
    expect(res.flightRecorder.engine).toBeNull();
    expect(res.flightRecorder.path).toBeNull();
    expect(res.flightRecorder.warning).toContain("not evidence");
  });

  // s9. "Configured" and "in force" are different states, and a caller outside
  // the process could not tell them apart: the driver degrades a missing
  // credential onto `app` silently by design, so the health surface is the only
  // place that can say separation is not actually holding.
  it("says which operation classes are running wider than they asked for", async () => {
    const res = await health(
      mkPersistence({
        backend: "postgres",
        path: null,
        dsn: "postgresql://app@x/gw",
        roleDsns: { app: "postgresql://app@x/gw", reader: "postgresql://reader@x/gw" },
      })
    );

    expect(res.persistence.roles.configured).toEqual(["app", "reader"]);
    expect(res.persistence.roles.separationInForce).toBe(false);
    expect(res.persistence.roles.degraded.map((d: { operation: string }) => d.operation)).toContain(
      "retention"
    );
  });

  it("reports role separation as not in force when nothing is configured", async () => {
    const res = await health(mkPersistence({ backend: "sqlite", roleDsns: {} }));

    expect(res.persistence.roles.configured).toEqual([]);
    expect(res.persistence.roles.separationInForce).toBe(false);
  });

  // s9. A refusal an operator can only learn from a one-time boot warning is
  // barely better than a silent one.
  it("says what each deprecated input did", async () => {
    const res = await health(mkPersistence({ backend: "sqlite" }));
    const names = res.persistence.deprecatedInputs.map((i: { name: string }) => i.name);

    expect(names).toContain("DATABASE_URL");
    expect(names).toContain("LLM_GATEWAY_LOGS_DB");
    const logsDb = res.persistence.deprecatedInputs.find(
      (i: { name: string }) => i.name === "LLM_GATEWAY_LOGS_DB"
    );
    expect(logsDb).toMatchObject({ set: true, outcome: "recorder_path" });
  });
});
