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

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "flight-routing-test-"));
    dbPath = path.join(tmpDir, "logs.db");
  });

  afterEach(() => {
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

  function seedStarted(rec: FlightRecorder, id: string): void {
    rec.logStart({ correlationId: id, cli: "claude", model: "sonnet", prompt: "hi" });
  }

  it("a fresh DB opens clean and has the new columns", () => {
    const rec = new FlightRecorder(dbPath);
    rec.close();

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

  it("persists cost_basis and all route_* facts for a routed request", () => {
    const rec = new FlightRecorder(dbPath);
    seedStarted(rec, "r1");
    rec.logComplete("r1", {
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
    rec.recordRouting("r1", {
      estCostUsd: 0.005,
      estConfidence: "high",
      reason: "cheapest-capable",
      considered: 4,
      reroutes: 1,
    });
    rec.close();

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

  it("round-trips both a T1 provider-reported and a T2 derived-from-tokens basis", () => {
    const rec = new FlightRecorder(dbPath);

    // T1: provider reported the cost directly.
    seedStarted(rec, "t1");
    rec.logComplete("t1", {
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
    seedStarted(rec, "t2");
    rec.logComplete("t2", {
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

    rec.close();

    expect(readRequest(dbPath, "t1").cost_basis).toBe("provider-reported");
    expect(readRequest(dbPath, "t2").cost_basis).toBe("derived-from-tokens");
  });

  it("leaves cost_basis and route_* NULL for an unrouted request", () => {
    const rec = new FlightRecorder(dbPath);
    seedStarted(rec, "n1");
    rec.logComplete("n1", {
      response: "plain",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.close();

    expect(readRequest(dbPath, "n1").cost_basis).toBeNull();
    const meta = readMeta(dbPath, "n1");
    expect(meta.routed).toBeNull();
    expect(meta.route_est_cost_usd).toBeNull();
    expect(meta.route_reason).toBeNull();
  });

  it("binds NULL for omitted RoutingRecord fields while still marking routed", () => {
    const rec = new FlightRecorder(dbPath);
    seedStarted(rec, "p1");
    rec.logComplete("p1", {
      response: "partial",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.recordRouting("p1", { reason: "single-candidate" });
    rec.close();

    const meta = readMeta(dbPath, "p1");
    expect(meta.routed).toBe(1);
    expect(meta.route_reason).toBe("single-candidate");
    expect(meta.route_est_cost_usd).toBeNull();
    expect(meta.route_est_confidence).toBeNull();
    expect(meta.route_considered).toBeNull();
    expect(meta.route_reroutes).toBeNull();
  });

  it("auto-migrates a legacy DB created without the new columns", () => {
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
    rec.close();

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

  it("upgraded legacy DB accepts routed writes end-to-end", () => {
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
    seedStarted(rec, "m1");
    rec.logComplete("m1", {
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
    rec.recordRouting("m1", { estCostUsd: 0.031, estConfidence: "low", considered: 2 });
    rec.close();

    expect(readRequest(dbPath, "m1").cost_basis).toBe("derived-from-tokens");
    const meta = readMeta(dbPath, "m1");
    expect(meta.routed).toBe(1);
    expect(meta.route_est_cost_usd).toBe(0.031);
    expect(meta.route_est_confidence).toBe("low");
    expect(meta.route_considered).toBe(2);
  });

  it("NoopFlightRecorder tolerates recordRouting", () => {
    const noop = new NoopFlightRecorder();
    expect(() => noop.recordRouting("x", { estCostUsd: 1, reason: "noop" })).not.toThrow();
  });
});
