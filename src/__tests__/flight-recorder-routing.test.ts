import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

// LCR phase_1: least-cost-routing flight-recorder migration.
// - requests gains `cost_basis TEXT` (how cost_usd was derived; index.ts owns
//   the derivation, this only round-trips the value).
// - gateway_metadata gains additive route_* telemetry columns written post-hoc
//   via recordRouting (never through logComplete).
describe("FlightRecorder least-cost-routing telemetry (LCR phase_1)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "flight-routing-test-"));
    dbPath = path.join(tmpDir, "logs.db");
  });

  afterEach(async () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function tableColumns(p: string, table: string): Set<string> {
    const db = new BetterSqlite3(p);
    try {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      return new Set(rows.map(r => r.name));
    } finally {
      db.close();
    }
  }

  function readRequest(p: string, id: string): any {
    const db = new BetterSqlite3(p);
    try {
      return db.prepare("SELECT * FROM requests WHERE id = ?").get(id);
    } finally {
      db.close();
    }
  }

  function readMeta(p: string, id: string): any {
    const db = new BetterSqlite3(p);
    try {
      return db.prepare("SELECT * FROM gateway_metadata WHERE request_id = ?").get(id);
    } finally {
      db.close();
    }
  }

  async function seedStarted(rec: FlightRecorder, id: string): Promise<void> {
    await rec.logStart({ correlationId: id, cli: "claude", model: "sonnet", prompt: "hi" });
  }

  // The reserved migrated rank (3) cannot be produced through the recorder API
  // by design, so simulate the transcript cutover's import the way #287 does.
  function setCompletionRank(p: string, id: string, rank: number): void {
    const db = new BetterSqlite3(p);
    try {
      const info = db
        .prepare("UPDATE gateway_metadata SET completion_rank = ? WHERE request_id = ?")
        .run(rank, id);
      if (info.changes !== 1)
        throw new Error(`expected to rank exactly one row, changed ${info.changes}`);
    } finally {
      db.close();
    }
  }

  const completed = {
    response: "body",
    durationMs: 1,
    retryCount: 0,
    circuitBreakerState: "closed" as const,
    costUsd: 0,
    costBasis: "provider-reported" as const,
    optimizationApplied: false,
    exitCode: 0,
    status: "completed" as const,
  };

  it("a fresh DB opens clean and has the new columns", async () => {
    const rec = new FlightRecorder(dbPath);
    await rec.close();

    expect(tableColumns(dbPath, "requests").has("cost_basis")).toBe(true);
    const metaCols = tableColumns(dbPath, "gateway_metadata");
    for (const c of [
      "routed",
      "route_est_cost_usd",
      "route_est_confidence",
      "route_reason",
      "route_considered",
      "route_reroutes",
    ]) {
      expect(metaCols.has(c)).toBe(true);
    }
  });

  it("persists cost_basis and all route_* facts for a routed request", async () => {
    const rec = new FlightRecorder(dbPath);
    await seedStarted(rec, "r1");
    await rec.logComplete("r1", {
      response: "routed body",
      durationMs: 12,
      retryCount: 0,
      circuitBreakerState: "closed",
      costUsd: 0.0042,
      costBasis: "provider-reported",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    await rec.recordRouting("r1", {
      estCostUsd: 0.005,
      estConfidence: "high",
      reason: "cheapest-capable",
      considered: 4,
      reroutes: 1,
    });
    await rec.close();

    const req = readRequest(dbPath, "r1");
    expect(req.cost_basis).toBe("provider-reported");

    const meta = readMeta(dbPath, "r1");
    expect(meta.routed).toBe(1);
    expect(meta.route_est_cost_usd).toBe(0.005);
    expect(meta.route_est_confidence).toBe("high");
    expect(meta.route_reason).toBe("cheapest-capable");
    expect(meta.route_considered).toBe(4);
    expect(meta.route_reroutes).toBe(1);
  });

  it("does not rewrite routing or compression on a migrated (rank 3) row (#287)", async () => {
    const rec = new FlightRecorder(dbPath);
    await seedStarted(rec, "migrated-1");
    await rec.logComplete("migrated-1", { ...completed, response: "imported body" });
    // Reserved rank 3 marks a row the cutover imported from a predecessor logs.db.
    setCompletionRank(dbPath, "migrated-1", 3);

    // A live request colliding on the migrated correlationId tries to write its
    // own telemetry onto that row. The rank fence must refuse both writes.
    await rec.recordRouting("migrated-1", { reason: "cheapest-capable", considered: 4 });
    await rec.recordCompressionTelemetry("migrated-1", {
      route: "native",
      transforms: ["dedupe"],
      originalChars: 10,
      compressedChars: 5,
      estimatedTokensSaved: 2,
    });
    await rec.close();

    const meta = readMeta(dbPath, "migrated-1");
    expect(meta.completion_rank).toBe(3);
    expect(meta.routed).toBeNull();
    expect(meta.route_reason).toBeNull();
    expect(meta.compression_route).toBeNull();
  });

  it("still applies routing and compression to a live (rank < 3) row (#287)", async () => {
    const rec = new FlightRecorder(dbPath);
    await seedStarted(rec, "live-1");
    // An observed completion lands at rank 2, below the reserved migrated rank.
    await rec.logComplete("live-1", { ...completed, response: "live body" });

    await rec.recordRouting("live-1", { reason: "cheapest-capable", considered: 4 });
    await rec.recordCompressionTelemetry("live-1", {
      route: "native",
      transforms: ["dedupe"],
      originalChars: 10,
      compressedChars: 5,
      estimatedTokensSaved: 2,
    });
    await rec.close();

    const meta = readMeta(dbPath, "live-1");
    expect(meta.completion_rank).toBe(2);
    expect(meta.routed).toBe(1);
    expect(meta.route_reason).toBe("cheapest-capable");
    expect(meta.compression_route).toBe("native");
  });

  it("round-trips both a T1 provider-reported and a T2 derived-from-tokens basis", async () => {
    const rec = new FlightRecorder(dbPath);

    // T1: provider reported the cost directly.
    await seedStarted(rec, "t1");
    await rec.logComplete("t1", {
      response: "t1",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      costUsd: 0.01,
      costBasis: "provider-reported",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });

    // T2: gateway derived the cost from token counts.
    await seedStarted(rec, "t2");
    await rec.logComplete("t2", {
      response: "t2",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      costUsd: 0.02,
      costBasis: "derived-from-tokens",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });

    await rec.close();

    expect(readRequest(dbPath, "t1").cost_basis).toBe("provider-reported");
    expect(readRequest(dbPath, "t2").cost_basis).toBe("derived-from-tokens");
  });

  it("leaves cost_basis and route_* NULL for an unrouted request", async () => {
    const rec = new FlightRecorder(dbPath);
    await seedStarted(rec, "n1");
    await rec.logComplete("n1", {
      response: "plain",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    await rec.close();

    expect(readRequest(dbPath, "n1").cost_basis).toBeNull();
    const meta = readMeta(dbPath, "n1");
    expect(meta.routed).toBeNull();
    expect(meta.route_est_cost_usd).toBeNull();
    expect(meta.route_reason).toBeNull();
  });

  it("binds NULL for omitted RoutingRecord fields while still marking routed", async () => {
    const rec = new FlightRecorder(dbPath);
    await seedStarted(rec, "p1");
    await rec.logComplete("p1", {
      response: "partial",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    await rec.recordRouting("p1", { reason: "single-candidate" });
    await rec.close();

    const meta = readMeta(dbPath, "p1");
    expect(meta.routed).toBe(1);
    expect(meta.route_reason).toBe("single-candidate");
    expect(meta.route_est_cost_usd).toBeNull();
    expect(meta.route_est_confidence).toBeNull();
    expect(meta.route_considered).toBeNull();
    expect(meta.route_reroutes).toBeNull();
  });

  it("auto-migrates a legacy DB created without the new columns", async () => {
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, cli TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL,
        system TEXT, response TEXT, session_id TEXT, duration_ms INTEGER, datetime_utc TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER
      );
      CREATE TABLE gateway_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        retry_count INTEGER DEFAULT 0, circuit_breaker_state TEXT, cost_usd REAL,
        approval_decision TEXT, optimization_applied INTEGER DEFAULT 0, thinking_blocks TEXT,
        exit_code INTEGER, error_message TEXT, async_job_id TEXT, status TEXT NOT NULL DEFAULT 'started'
      );
    `);
    seed
      .prepare("INSERT INTO _migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());
    seed.close();

    // Pre-migration: none of the new columns exist yet.
    expect(tableColumns(dbPath, "requests").has("cost_basis")).toBe(false);
    expect(tableColumns(dbPath, "gateway_metadata").has("routed")).toBe(false);

    const rec = new FlightRecorder(dbPath);
    await rec.close();

    // Post-migration: the recorder added them without error.
    expect(tableColumns(dbPath, "requests").has("cost_basis")).toBe(true);
    const metaCols = tableColumns(dbPath, "gateway_metadata");
    for (const c of [
      "routed",
      "route_est_cost_usd",
      "route_est_confidence",
      "route_reason",
      "route_considered",
      "route_reroutes",
    ]) {
      expect(metaCols.has(c)).toBe(true);
    }
  });

  it("upgraded legacy DB accepts routed writes end-to-end", async () => {
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE requests (
        id TEXT PRIMARY KEY, cli TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL,
        system TEXT, response TEXT, session_id TEXT, duration_ms INTEGER, datetime_utc TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER
      );
      CREATE TABLE gateway_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        retry_count INTEGER DEFAULT 0, circuit_breaker_state TEXT, cost_usd REAL,
        approval_decision TEXT, optimization_applied INTEGER DEFAULT 0, thinking_blocks TEXT,
        exit_code INTEGER, error_message TEXT, async_job_id TEXT, status TEXT NOT NULL DEFAULT 'started'
      );
    `);
    seed
      .prepare("INSERT INTO _migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());
    seed.close();

    const rec = new FlightRecorder(dbPath);
    await seedStarted(rec, "m1");
    await rec.logComplete("m1", {
      response: "ok",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      costUsd: 0.03,
      costBasis: "derived-from-tokens",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    await rec.recordRouting("m1", { estCostUsd: 0.031, estConfidence: "low", considered: 2 });
    await rec.close();

    expect(readRequest(dbPath, "m1").cost_basis).toBe("derived-from-tokens");
    const meta = readMeta(dbPath, "m1");
    expect(meta.routed).toBe(1);
    expect(meta.route_est_cost_usd).toBe(0.031);
    expect(meta.route_est_confidence).toBe("low");
    expect(meta.route_considered).toBe(2);
  });

  it("NoopFlightRecorder tolerates recordRouting", async () => {
    const noop = new NoopFlightRecorder();
    await expect(
      noop.recordRouting("x", { estCostUsd: 1, reason: "noop" })
    ).resolves.toBeUndefined();
  });
});
