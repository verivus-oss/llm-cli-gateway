import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

// Native compressor PR-1 (spec Section 8): additive compression_* telemetry on
// gateway_metadata, written write-once via recordCompressionTelemetry, never
// through logComplete.
describe("FlightRecorder compression telemetry (native compressor PR-1)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "flight-compress-test-"));
    dbPath = path.join(tmpDir, "logs.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function metaColumns(p: string): Set<string> {
    const db = new BetterSqlite3(p);
    try {
      const rows = db.prepare("PRAGMA table_info(gateway_metadata)").all() as Array<{
        name: string;
      }>;
      return new Set(rows.map(r => r.name));
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

  it("creates the additive compression_* columns", () => {
    const rec = new FlightRecorder(dbPath);
    rec.close();
    const cols = metaColumns(dbPath);
    for (const c of [
      "compression_route",
      "compression_transforms",
      "compression_original_chars",
      "compression_compressed_chars",
      "compression_tokens_saved_est",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });

  it("records exact chars and the transform list, leaving optimization_applied alone", () => {
    const rec = new FlightRecorder(dbPath);
    seedStarted(rec, "c1");
    rec.logComplete("c1", {
      response: "compressed body",
      durationMs: 10,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.recordCompressionTelemetry("c1", {
      route: "log",
      transforms: ["lit-escape", "dedup", "leading-note"],
      originalChars: 1500,
      compressedChars: 900,
      estimatedTokensSaved: 176,
    });
    rec.close();

    const meta = readMeta(dbPath, "c1");
    expect(meta.compression_route).toBe("log");
    expect(meta.compression_transforms).toBe("lit-escape,dedup,leading-note");
    expect(meta.compression_original_chars).toBe(1500);
    expect(meta.compression_compressed_chars).toBe(900);
    expect(meta.compression_tokens_saved_est).toBe(176);
    // optimization_applied is never repurposed by the compressor.
    expect(meta.optimization_applied).toBe(0);
  });

  it("is write-once: a second telemetry write does not overwrite the first", () => {
    const rec = new FlightRecorder(dbPath);
    seedStarted(rec, "c2");
    rec.logComplete("c2", {
      response: "x",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.recordCompressionTelemetry("c2", {
      route: "json",
      transforms: ["json-minify"],
      originalChars: 100,
      compressedChars: 70,
      estimatedTokensSaved: 10,
    });
    // A repeated llm_job_result read recomputes identical values; simulate a
    // divergent second write and confirm first-write-wins.
    rec.recordCompressionTelemetry("c2", {
      route: "plain",
      transforms: ["whitespace"],
      originalChars: 999,
      compressedChars: 1,
      estimatedTokensSaved: 999,
    });
    rec.close();

    const meta = readMeta(dbPath, "c2");
    expect(meta.compression_route).toBe("json");
    expect(meta.compression_original_chars).toBe(100);
  });

  it("leaves columns NULL when compression never ran", () => {
    const rec = new FlightRecorder(dbPath);
    seedStarted(rec, "c3");
    rec.logComplete("c3", {
      response: "plain",
      durationMs: 1,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: true,
      exitCode: 0,
      status: "completed",
    });
    rec.close();

    const meta = readMeta(dbPath, "c3");
    expect(meta.compression_route).toBeNull();
    expect(meta.compression_tokens_saved_est).toBeNull();
    // The regex-optimizer flag still works independently.
    expect(meta.optimization_applied).toBe(1);
  });

  it("auto-migrates a pre-compressor gateway_metadata table", () => {
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

    expect(metaColumns(dbPath).has("compression_route")).toBe(false);
    const rec = new FlightRecorder(dbPath);
    rec.close();
    expect(metaColumns(dbPath).has("compression_route")).toBe(true);
  });

  it("NoopFlightRecorder tolerates the telemetry call", () => {
    const noop = new NoopFlightRecorder();
    expect(() =>
      noop.recordCompressionTelemetry("x", {
        route: "log",
        transforms: [],
        originalChars: 0,
        compressedChars: 0,
        estimatedTokensSaved: 0,
      })
    ).not.toThrow();
  });
});
