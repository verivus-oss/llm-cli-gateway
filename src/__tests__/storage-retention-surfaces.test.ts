import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPersistenceConfig, DEFAULT_JOB_RETENTION_DAYS } from "../config.js";
import { collectStorageHealth } from "../doctor.js";
import { FlightRecorder } from "../flight-recorder.js";
import { openDatabase } from "../sqlite-driver.js";
import { runStorageCommand } from "../storage-cli.js";
import { DEFAULT_RETENTION_SWEEP_INTERVAL_MS } from "../storage/retention.js";
import { noopLogger } from "../logger.js";

describe("[persistence.retention] as a configuration surface", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "s11-cfg-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function config(toml: string): void {
    const p = join(tempDir, "config.toml");
    writeFileSync(p, toml);
    vi.stubEnv("LLM_GATEWAY_CONFIG", p);
  }

  it("leaves an existing installation's bounds exactly where they were", () => {
    config(`[persistence]\nbackend = "sqlite"\n`);
    const loaded = loadPersistenceConfig(noopLogger);
    expect(loaded.retentionDays).toBe(DEFAULT_JOB_RETENTION_DAYS);
    expect(loaded.retention?.days).toEqual({
      jobs: DEFAULT_JOB_RETENTION_DAYS,
      requests: null,
      wedgedValidationRuns: null,
    });
    expect(loaded.retentionSweepIntervalMs).toBe(DEFAULT_RETENTION_SWEEP_INTERVAL_MS);
  });

  it("takes a bound only when it is written down", () => {
    config(
      `[persistence]\nbackend = "sqlite"\n[persistence.retention]\nrequests = 90\nwedgedValidationRuns = 14\nsweepIntervalMs = 60000\n`
    );
    const loaded = loadPersistenceConfig(noopLogger);
    expect(loaded.retention?.days.requests).toBe(90);
    expect(loaded.retention?.days.wedgedValidationRuns).toBe(14);
    expect(loaded.retentionSweepIntervalMs).toBe(60000);
  });

  it("refuses a misspelled key instead of silently applying no bound", () => {
    // The [persistence.roles] precedent: under a permissive schema `request =
    // 90` is no bound at all, and the operator has no way to tell that from a
    // bound that ran and found nothing.
    config(`[persistence]\nbackend = "sqlite"\n[persistence.retention]\nrequest = 90\n`);
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/Invalid \[persistence\] config/);
  });

  it("refuses a zero or negative bound, which would delete everything", () => {
    config(`[persistence]\nbackend = "sqlite"\n[persistence.retention]\nrequests = 0\n`);
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/Invalid \[persistence\] config/);
  });

  it("keeps the wedge horizon at a day or more", () => {
    // Below a day the horizon stops protecting a zero-seat run from a sweep
    // arriving between the run row and its link rows.
    config(
      `[persistence]\nbackend = "sqlite"\n[persistence.retention]\nwedgedValidationRuns = 0.5\n`
    );
    expect(() => loadPersistenceConfig(noopLogger)).toThrow(/Invalid \[persistence\] config/);
  });
});

describe("doctor reports the policy rather than deciding one", () => {
  let dir: string;
  let dbPath: string;
  let recorder: FlightRecorder;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "s11-doc-"));
    dbPath = join(dir, "logs.db");
    writeFileSync(join(dir, "config.toml"), `[persistence]\nbackend = "sqlite"\n`);
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(dir, "config.toml"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", dbPath);
    recorder = new FlightRecorder(dbPath, { redactSecrets: false });
    await recorder.logStart({ correlationId: "r1", cli: "claude", model: "m", prompt: "p" });
  });

  afterEach(async () => {
    await recorder.close().catch(() => undefined);
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it("carries the resolved bounds and the unbounded set out to the report", async () => {
    const storage = await collectStorageHealth(recorder);
    expect(storage.retention.policy).toEqual({
      jobs: 30,
      requests: null,
      wedgedValidationRuns: null,
    });
    // DERIVED from the policy. It was a hard-coded ["requests"], which is a
    // second place a retention decision was being taken.
    expect(storage.retention.unbounded).toEqual(["requests", "wedgedValidationRuns"]);
    expect(storage.retention.days).toBe(30);
  });

  it("measures reclaimable bytes rather than reporting a bare file size", async () => {
    const storage = await collectStorageHealth(recorder);
    expect(storage.retention.reclaimable_bytes).not.toBeNull();
    expect(storage.retention.reclaimable_bytes).toBeGreaterThanOrEqual(0);
    expect(storage.flight_recorder.file_bytes).toBe(statSync(dbPath).size);
  });

  it("stops telling an operator that nothing can cover validation_runs", async () => {
    // A co-resident validation_runs table with a non-terminal row, which is the
    // shape the measured host has. The warning used to end "no retention policy
    // covers validation_runs", which s11 made untrue; it must name the key.
    const db = openDatabase(dbPath);
    try {
      db.exec(
        "CREATE TABLE IF NOT EXISTS validation_runs (validation_id TEXT PRIMARY KEY, status TEXT)"
      );
      db.prepare("INSERT INTO validation_runs VALUES (?, ?)").run("v-stuck", "running");
    } finally {
      db.close();
    }
    const storage = await collectStorageHealth(recorder);
    const warning = storage.warnings.find(line => line.includes("validation run(s)"));
    expect(warning).toBeDefined();
    expect(warning).toMatch(/\[persistence\.retention\]\.wedgedValidationRuns/);
    expect(warning).not.toMatch(/no retention policy covers/);
  });

  it("counts what a bound would take, without one being set", async () => {
    // With no transcript bound the count falls back to the job window, which is
    // the only transcript-shaped number an operator had before this node.
    const storage = await collectStorageHealth(recorder);
    expect(storage.retention.requests_beyond_retention).toBe(0);
    expect(storage.flight_recorder.request_rows).toBe(1);
  });

  describe("#296: the inverted window is reported once it has actually cost something", () => {
    /** Backdate the one seeded request so it sits outside the job window. */
    function backdateSeededRequest(daysAgo: number): void {
      const db = openDatabase(dbPath);
      try {
        db.prepare("UPDATE requests SET datetime_utc = ?").run(
          new Date(Date.now() - daysAgo * 86_400_000).toISOString()
        );
      } finally {
        db.close();
      }
    }

    const inversionWarning = (warnings: string[]): string | undefined =>
      warnings.find(line => line.includes("Retention is inverted"));

    it("warns once a request has outlived the job bound", async () => {
      // The request row survives and its job row does not, so the launched argv
      // and the raw provider stream for that correlation id are already gone.
      backdateSeededRequest(45);
      const storage = await collectStorageHealth(recorder);
      const warning = inversionWarning(storage.warnings);
      expect(warning).toBeDefined();
      expect(warning).toMatch(/'jobs' is bounded at 30 day\(s\)/);
      expect(warning).toMatch(/\[persistence\.retention\]\.jobs/);
    });

    it("stays silent while every request is still inside the job window", async () => {
      // NEGATIVE CONTROL. The default configuration is inverted on every host,
      // so a warning keyed on the configuration alone would fire always and be
      // read as background. It must key on the loss having happened here.
      const storage = await collectStorageHealth(recorder);
      expect(inversionWarning(storage.warnings)).toBeUndefined();
    });

    it("stays silent once the operator has bounded requests too", async () => {
      // Both bounded is a taken decision, not an inversion, whatever the two
      // numbers are.
      writeFileSync(
        join(dir, "config.toml"),
        `[persistence]\nbackend = "sqlite"\n[persistence.retention]\nrequests = 90\n`
      );
      backdateSeededRequest(45);
      const storage = await collectStorageHealth(recorder);
      expect(storage.retention.unbounded).not.toContain("requests");
      expect(inversionWarning(storage.warnings)).toBeUndefined();
    });
  });

  it("reports invalid persistence configuration even with an existing recorder", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      '[persistence]\nbackend = "postgres"\ndsn = "postgresql://unterminated'
    );
    const storage = await collectStorageHealth(recorder);
    expect(storage.flight_recorder).toMatchObject({
      state: "unavailable",
      path: null,
      error: "Persistence configuration is invalid",
    });
    expect(storage.warnings.join(" ")).toContain("persistence configuration is invalid");
  });

  it("reports invalid persistence even when the recorder is explicitly disabled", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      '[persistence]\nbackend = "postgres"\ndsn = "postgresql://unterminated'
    );
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "none");
    const storage = await collectStorageHealth();
    expect(storage.flight_recorder).toMatchObject({
      state: "unavailable",
      path: null,
      error: "Persistence configuration is invalid",
    });
    expect(storage.warnings.join(" ")).toContain("persistence configuration is invalid");
  });
});

describe("`storage compact` is an operator action, never a timer", () => {
  let dir: string;
  let dbPath: string;
  let out: string[];
  let err: string[];
  let exit: number | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "s11-cli-"));
    dbPath = join(dir, "logs.db");
    writeFileSync(join(dir, "config.toml"), `[persistence]\nbackend = "sqlite"\n`);
    vi.stubEnv("LLM_GATEWAY_CONFIG", join(dir, "config.toml"));
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", dbPath);
    const recorder = new FlightRecorder(dbPath, { redactSecrets: false });
    await recorder.logStart({ correlationId: "r1", cli: "claude", model: "m", prompt: "p" });
    await recorder.close();
    out = [];
    err = [];
    exit = process.exitCode as number | undefined;
    vi.spyOn(process.stdout, "write").mockImplementation(text => {
      out.push(String(text));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation(text => {
      err.push(String(text));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = exit;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to take the exclusive lock without --yes", async () => {
    const before = statSync(dbPath).size;
    await runStorageCommand(["compact"]);
    expect(process.exitCode).toBe(2);
    expect(err.join("")).toMatch(/STOP the gateway first/);
    expect(statSync(dbPath).size).toBe(before);
    expect(out.join("")).toBe("");
  });

  it("compacts and reports the bytes when asked", async () => {
    await runStorageCommand(["compact", "--yes"]);
    expect(out.join("")).toMatch(/freed:/);
  });

  it("reports the bounds and the file without touching either", async () => {
    const before = statSync(dbPath).size;
    await runStorageCommand(["status"]);
    const text = out.join("");
    expect(text).toMatch(/unbounded:\s+requests, wedgedValidationRuns/);
    expect(text).toMatch(/transcript file/);
    expect(statSync(dbPath).size).toBe(before);
  });

  it("reports an explicitly disabled PostgreSQL recorder as disabled", async () => {
    writeFileSync(
      join(dir, "config.toml"),
      `[persistence]\nbackend = "postgres"\ndsn = "postgresql://app@127.0.0.1/gateway"\n`
    );
    vi.stubEnv("LLM_GATEWAY_LOGS_DB", "none");

    await runStorageCommand(["status"]);

    expect(out.join(" ")).toContain("flight recorder is disabled");
    expect(out.join(" ")).not.toContain("Request history is in PostgreSQL");
  });

  it("refuses an unknown subcommand instead of doing something", async () => {
    await runStorageCommand(["vacuum"]);
    expect(process.exitCode).toBe(2);
    expect(err.join("")).toMatch(/Usage:/);
  });
});
