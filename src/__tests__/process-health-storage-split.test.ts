/**
 * `llm_process_health` must disclose BOTH storage subsystems.
 *
 * The flight recorder does not follow `[persistence].backend`; it is always
 * SQLite. Reporting only the job store is what made the split invisible: on a
 * postgres host this tool answered `backend: "postgres", dbPath: null` while
 * every request body sat in an unnamed SQLite file, so a caller hunting for
 * request history went to Postgres and found none of it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";
import { noopLogger } from "../logger.js";
import type { PersistenceConfig } from "../config.js";
import { FileSessionManager } from "../session-manager.js";
import { runWithRequestContext } from "../request-context.js";

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

describe("llm_process_health discloses the storage split", () => {
  let tmp: string;
  let flight: FlightRecorder;
  const savedEnv = process.env.LLM_GATEWAY_LOGS_DB;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "health-split-"));
    process.env.LLM_GATEWAY_LOGS_DB = join(tmp, "logs.db");
    flight = new FlightRecorder(join(tmp, "logs.db"));
  });

  afterEach(() => {
    flight.close();
    if (savedEnv === undefined) delete process.env.LLM_GATEWAY_LOGS_DB;
    else process.env.LLM_GATEWAY_LOGS_DB = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function health(
    persistence: PersistenceConfig,
    recorder: FlightRecorder | NoopFlightRecorder = flight
  ): Promise<Record<string, any>> {
    const server = createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
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

  it("names the recorder's own engine and path, which the job store block never carries", async () => {
    const res = await health(
      mkPersistence({ backend: "postgres", path: null, dsn: "postgres://x" })
    );

    // The job store block alone is what misled callers: no path at all.
    expect(res.persistence.backend).toBe("postgres");
    expect(res.persistence.dbPath).toBeNull();

    // The recorder block supplies what was missing.
    expect(res.flightRecorder.engine).toBe("sqlite");
    expect(res.flightRecorder.path).toBe(join(tmp, "logs.db"));
    expect(res.flightRecorder.enabled).toBe(true);
    expect(res.flightRecorder.followsPersistenceBackend).toBe(false);
  });

  it("warns explicitly when the two subsystems are on different engines", async () => {
    const res = await health(
      mkPersistence({ backend: "postgres", path: null, dsn: "postgres://x" })
    );

    expect(res.flightRecorder.warning).toContain("SPLIT");
    // The two facts a caller needs: where requests actually are, and that the
    // old jobs table left behind in that same file still answers queries.
    expect(res.flightRecorder.warning).toContain(join(tmp, "logs.db"));
    expect(res.flightRecorder.warning).toContain("abandoned");
  });

  it("does not cry split when both subsystems are SQLite", async () => {
    const res = await health(mkPersistence({ backend: "sqlite" }));

    expect(res.flightRecorder.warning).toBeNull();
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
});
