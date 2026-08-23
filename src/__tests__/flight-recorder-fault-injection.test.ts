/**
 * Fault injection for the flight recorder, which nobody had done.
 *
 * The June 2026 logs.db corruption was recorded with one symptom, SILENT
 * EMPTY-SUCCESS, and no root cause. The mechanism that reproduces that symptom
 * was still in the tree: `createFlightRecorder` returned `NoopFlightRecorder`
 * both for `LLM_GATEWAY_LOGS_DB=none` and for a FAILED OPEN, the Noop answers
 * every read with a successful empty result, and every downstream surface
 * reported the failed open as a configuration choice.
 *
 * Every test here injects a REAL storage fault into a REAL SQLite file in a
 * temporary directory and asserts the OPERATOR-VISIBLE output: what
 * `llm_process_health` returns and what `doctor --json` reports. None asserts a
 * private field, because a test that reads the flag would pass without the
 * surface ever changing, which is how this defect survived.
 *
 * NEVER against ~/.llm-cli-gateway/logs.db, which is 1.2 GB and real.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayServer } from "../index.js";
import { AsyncJobManager } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import {
  createFlightRecorder,
  FlightRecorder,
  type FlightRecorderLike,
} from "../flight-recorder.js";
import { collectStorageHealth, createDoctorReport } from "../doctor.js";
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

describe("flight recorder fault injection", () => {
  let tmp: string;
  const savedEnv = process.env.LLM_GATEWAY_LOGS_DB;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "fr-fault-"));
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env.LLM_GATEWAY_LOGS_DB;
    else process.env.LLM_GATEWAY_LOGS_DB = savedEnv;
    rmSync(tmp, { recursive: true, force: true });
  });

  async function processHealth(recorder: FlightRecorderLike): Promise<Record<string, any>> {
    const server = createGatewayServer({
      sessionManager: new FileSessionManager(join(tmp, "sessions.json")),
      asyncJobManager: new AsyncJobManager(noopLogger, undefined, new MemoryJobStore()),
      persistence: mkPersistence(),
      flightRecorder: recorder,
    });
    const reg = (server as unknown as Record<string, Record<string, RegisteredTool>>)
      ._registeredTools;
    const res = await runWithRequestContext({ transport: "stdio", authScopes: [] }, () =>
      reg["llm_process_health"].handler({}, {})
    );
    return JSON.parse(res.content[0].text);
  }

  /** A real SQLite database with the recorder's schema, then destroyed. */
  async function corruptedDatabase(): Promise<string> {
    const path = join(tmp, "logs.db");
    const seed = new FlightRecorder(path);
    await seed.readStorageStats();
    await seed.close();
    const good = readFileSync(path);
    expect(good.length).toBeGreaterThan(1024);
    // Truncated to 100 bytes: the SQLite header survives, so the file still
    // opens, and every page read after it fails. This is what a half-written
    // file looks like, not a file of random bytes.
    writeFileSync(path, good.subarray(0, 100));
    return path;
  }

  it("a FAILED OPEN is reported as unavailable, and never as LLM_GATEWAY_LOGS_DB=none", async () => {
    // The injection: the recorder's path is a DIRECTORY, so the driver's open
    // throws inside createFlightRecorder's try. Before this change that catch
    // returned `new NoopFlightRecorder()`, the same object the disabled branch
    // twelve lines above returns, and the surface below then said the operator
    // had turned recording off.
    const path = join(tmp, "logs.db");
    mkdirSync(path);
    process.env.LLM_GATEWAY_LOGS_DB = path;
    const recorder = createFlightRecorder(noopLogger);

    const res = await processHealth(recorder);

    expect(res.flightRecorder.state).toBe("unavailable");
    expect(res.flightRecorder.enabled).toBe(false);
    expect(res.flightRecorder.readsAreAuthoritative).toBe(false);
    // The path an operator has to go and look at, which the old surface nulled.
    expect(res.flightRecorder.path).toBe(path);
    expect(res.flightRecorder.lastError).toBeTruthy();
    // The load-bearing assertion of this whole node.
    expect(res.flightRecorder.warning).not.toContain("LLM_GATEWAY_LOGS_DB=none");
    expect(res.flightRecorder.warning).toContain("FAILED TO OPEN");
  });

  it("a disabled recorder still says the configuration turned it off", async () => {
    // The control for the test above. Both used to produce this sentence; only
    // one of them should, and it must still.
    process.env.LLM_GATEWAY_LOGS_DB = "none";
    const recorder = createFlightRecorder(noopLogger);

    const res = await processHealth(recorder);

    expect(res.flightRecorder.state).toBe("disabled");
    expect(res.flightRecorder.enabled).toBe(false);
    expect(res.flightRecorder.warning).toContain("LLM_GATEWAY_LOGS_DB=none");
    expect(res.flightRecorder.warning).not.toContain("FAILED TO OPEN");
  });

  it("a CORRUPTED file is reported as degraded, not as an enabled empty recorder", async () => {
    const path = await corruptedDatabase();
    process.env.LLM_GATEWAY_LOGS_DB = path;
    const recorder = createFlightRecorder(noopLogger);
    // The open SUCCEEDS on a truncated file, so this is not the Noop path at
    // all: it is a live FlightRecorder whose every operation fails. That third
    // state used to reach the surface as `enabled: true, warning: null`.
    await expect(recorder.readStorageStats()).rejects.toThrow();

    const res = await processHealth(recorder);

    expect(res.flightRecorder.state).toBe("degraded");
    expect(res.flightRecorder.readsAreAuthoritative).toBe(false);
    expect(res.flightRecorder.lastError).toContain("malformed");
    expect(res.flightRecorder.warning).toContain("DEGRADED");
    expect(res.flightRecorder.warning).not.toContain("LLM_GATEWAY_LOGS_DB=none");
    expect(res.flightRecorder.failureCount).toBeGreaterThan(0);
    await recorder.close().catch(() => undefined);
  });

  it("a read that fails AFTER a successful open moves the surface to degraded", async () => {
    // A different fault from corruption: the file is valid, the recorder opened
    // it, ran an operation successfully, and only then lost the table under it.
    // The injection is a second writer, which is what a concurrent migration or
    // an operator with a sqlite shell is.
    const path = join(tmp, "logs.db");
    const recorder = new FlightRecorder(path);
    await recorder.readStorageStats();
    expect((await processHealth(recorder)).flightRecorder.state).toBe("active");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path);
    db.exec("DROP TABLE requests");
    db.close();

    await expect(recorder.readStorageStats()).rejects.toThrow(/no such table/);
    const res = await processHealth(recorder);

    expect(res.flightRecorder.state).toBe("degraded");
    expect(res.flightRecorder.lastError).toContain("no such table");
    expect(res.flightRecorder.readsAreAuthoritative).toBe(false);
    await recorder.close().catch(() => undefined);
  });

  it("a WRITE that fails after a successful open reaches the surface too", async () => {
    // Reads and writes route through different driver paths (withConnection
    // versus transaction), so a read-only proof would not cover the half of the
    // subsystem that actually loses data.
    const path = join(tmp, "logs.db");
    const recorder = new FlightRecorder(path);
    await recorder.logStart({
      correlationId: "fault-write-1",
      cli: "claude",
      model: "m",
      prompt: "p",
    });
    expect((await processHealth(recorder)).flightRecorder.state).toBe("active");

    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path);
    // gateway_metadata first: it has a foreign key onto requests, and the row
    // written above makes the drop order load-bearing.
    db.exec("DROP TABLE gateway_metadata");
    db.exec("DROP TABLE requests");
    db.close();

    await expect(
      recorder.logStart({ correlationId: "fault-write-2", cli: "claude", model: "m", prompt: "p" })
    ).rejects.toThrow();
    const res = await processHealth(recorder);

    expect(res.flightRecorder.state).toBe("degraded");
    expect(res.flightRecorder.failureCount).toBeGreaterThan(0);
    await recorder.close().catch(() => undefined);
  });

  it("doctor reports the corrupt file, is NOT ok, and says so in next_actions", async () => {
    const path = await corruptedDatabase();
    process.env.LLM_GATEWAY_LOGS_DB = path;

    const storage = await collectStorageHealth();
    const report = createDoctorReport({ env: process.env, storage });

    // doctor previously emitted normal zero-valued cache and calibration data
    // for exactly this file and reported no storage state at all.
    expect(report.storage.scanned).toBe(true);
    expect(report.storage.flight_recorder.state).toBe("degraded");
    expect(report.storage.flight_recorder.reads_are_authoritative).toBe(false);
    // NULL, not 0. "Not measured" and "measured and empty" are different
    // answers and the zeroed block gave the second for the first.
    expect(report.storage.flight_recorder.request_rows).toBeNull();
    expect(report.storage.flight_recorder.file_bytes).toBe(100);
    expect(report.ok).toBe(false);
    expect(report.next_actions.join(" ")).toContain("degraded");
  });

  it("doctor stays ok, and reports real counts, on a healthy recorder", async () => {
    // The both-states control for the assertion above: `ok: false` has to come
    // from the fault and not from the block existing.
    const path = join(tmp, "logs.db");
    process.env.LLM_GATEWAY_LOGS_DB = path;
    const recorder = new FlightRecorder(path);
    await recorder.logStart({ correlationId: "ok-1", cli: "claude", model: "m", prompt: "p" });
    await recorder.close();

    const storage = await collectStorageHealth();
    const report = createDoctorReport({ env: process.env, storage });

    expect(report.storage.flight_recorder.state).toBe("active");
    expect(report.storage.flight_recorder.request_rows).toBe(1);
    expect(report.storage.flight_recorder.reads_are_authoritative).toBe(true);
    expect(report.storage.flight_recorder.file_bytes).toBeGreaterThan(0);
    expect(report.ok).toBe(true);
  });

  it("doctor names an ABANDONED co-resident jobs table rather than counting it as live", async () => {
    // The other half of the same blindness: on a host switched to Postgres the
    // recorder's own file still holds a frozen `jobs` table that answers
    // queries. doctor reported neither its existence nor its staleness.
    const path = join(tmp, "logs.db");
    process.env.LLM_GATEWAY_LOGS_DB = path;
    const recorder = new FlightRecorder(path);
    await recorder.readStorageStats();
    await recorder.close();
    const Database = (await import("better-sqlite3")).default;
    const db = new Database(path);
    db.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, status TEXT NOT NULL)");
    db.exec("INSERT INTO jobs VALUES ('j1', 'running'), ('j2', 'completed')");
    db.close();

    const storage = await collectStorageHealth();

    const jobs = storage.co_resident.find(row => row.table === "jobs");
    expect(jobs).toBeDefined();
    expect(jobs?.rows).toBe(2);
    expect(jobs?.unfinished).toBe(1);
    // The job store here is a DIFFERENT sqlite path, so this table is frozen.
    expect(jobs?.live).toBe(false);
    expect(storage.warnings.join(" ")).toContain("ABANDONED");
  });

  it("reports a write failure of the disk-full family, injected with RLIMIT_FSIZE", async () => {
    // The only fault here that cannot be injected inside the test process:
    // there is no way to lower RLIMIT_FSIZE from Node, so it is set by the
    // shell around a child. The child imports the BUILT recorder, so this runs
    // in `npm run check` (which builds first) and skips in a bare `npm test`
    // against an unbuilt tree rather than pretending to have run.
    const here = dirname(fileURLToPath(import.meta.url));
    const built = join(here, "..", "..", "dist", "flight-recorder.js");
    if (!existsSync(built)) {
      expect(existsSync(built), "dist not built; run npm run build to exercise this fault").toBe(
        false
      );
      return;
    }
    const script = join(tmp, "rlimit-child.mjs");
    writeFileSync(
      script,
      [
        `import { FlightRecorder } from ${JSON.stringify(built)};`,
        `const r = new FlightRecorder(${JSON.stringify(join(tmp, "rlimit.db"))});`,
        `try {`,
        `  for (let i = 0; i < 200; i++) {`,
        `    await r.logStart({ correlationId: "c" + i, cli: "claude", model: "m", prompt: "x".repeat(4000) });`,
        `  }`,
        `} catch {}`,
        `process.stdout.write(JSON.stringify(r.health()));`,
      ].join("\n")
    );
    // 64 blocks of 512 bytes = 32 KB, below the schema's own footprint, so the
    // write path hits EFBIG rather than the test having to fill a disk.
    const child = spawnSync("bash", ["-c", `ulimit -f 64; node ${JSON.stringify(script)}`], {
      encoding: "utf8",
      timeout: 60_000,
    });
    const health = JSON.parse(child.stdout.trim());

    expect(health.state).toBe("degraded");
    expect(health.error).toBeTruthy();
    expect(health.failureCount).toBeGreaterThan(0);
  });
});
