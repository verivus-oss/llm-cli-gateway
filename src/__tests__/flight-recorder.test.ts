import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { FlightRecorder, NoopFlightRecorder } from "../flight-recorder.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

describe("FlightRecorder migrations (U23 cache columns)", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "flight-rec-test-"));
    dbPath = path.join(tmpDir, "logs.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function tableColumns(p: string): Set<string> {
    const db = new BetterSqlite3(p);
    try {
      const rows = db.prepare("PRAGMA table_info(requests)").all() as Array<{
        name: string;
      }>;
      return new Set(rows.map(r => r.name));
    } finally {
      db.close();
    }
  }

  it("auto-migrates a pre-U23 logs.db that lacks the cache columns", () => {
    // Bootstrap an OLD-schema DB (no cache columns)
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE _migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        cli TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system TEXT,
        response TEXT,
        session_id TEXT,
        duration_ms INTEGER,
        datetime_utc TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER
      );
      CREATE TABLE gateway_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        retry_count INTEGER DEFAULT 0,
        circuit_breaker_state TEXT,
        cost_usd REAL,
        approval_decision TEXT,
        optimization_applied INTEGER DEFAULT 0,
        thinking_blocks TEXT,
        exit_code INTEGER,
        error_message TEXT,
        async_job_id TEXT,
        status TEXT NOT NULL DEFAULT 'started'
      );
    `);
    seed
      .prepare("INSERT INTO _migrations(version, applied_at) VALUES(1, ?)")
      .run(new Date().toISOString());
    // Seed a legacy row to confirm it survives migration with NULL cache cols.
    seed
      .prepare(`INSERT INTO requests (id, cli, model, prompt, datetime_utc) VALUES (?, ?, ?, ?, ?)`)
      .run("legacy-1", "claude", "sonnet", "hi", new Date().toISOString());
    seed.close();

    // Sanity: old schema has no cache columns
    expect(tableColumns(dbPath).has("cache_read_tokens")).toBe(false);

    // Opening via FlightRecorder must auto-migrate.
    const rec = new FlightRecorder(dbPath);
    rec.close();

    const cols = tableColumns(dbPath);
    expect(cols.has("cache_read_tokens")).toBe(true);
    expect(cols.has("cache_creation_tokens")).toBe(true);

    // Existing row is preserved with NULL for new columns.
    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare("SELECT cache_read_tokens, cache_creation_tokens FROM requests WHERE id = ?")
      .get("legacy-1") as any;
    db.close();
    expect(row.cache_read_tokens).toBeNull();
    expect(row.cache_creation_tokens).toBeNull();
  });

  it("is idempotent — opening the migrated DB again does not re-add columns or throw", () => {
    // First open creates fresh schema (already includes cache cols).
    new FlightRecorder(dbPath).close();
    const colsFirst = tableColumns(dbPath);
    expect(colsFirst.has("cache_read_tokens")).toBe(true);

    // Second open must not throw (ALTER would fail if columns existed without guard).
    expect(() => {
      new FlightRecorder(dbPath).close();
    }).not.toThrow();

    const colsSecond = tableColumns(dbPath);
    expect(colsSecond.size).toBe(colsFirst.size);
  });

  it("persists cacheReadTokens / cacheCreationTokens via logComplete", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "corr-1",
      cli: "claude",
      model: "sonnet",
      prompt: "test",
    });
    rec.logComplete("corr-1", {
      response: "ok",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheCreationTokens: 7,
      durationMs: 123,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.close();

    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare(
        "SELECT input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens FROM requests WHERE id = ?"
      )
      .get("corr-1") as any;
    db.close();

    expect(row.input_tokens).toBe(100);
    expect(row.output_tokens).toBe(50);
    expect(row.cache_read_tokens).toBe(200);
    expect(row.cache_creation_tokens).toBe(7);
  });

  it("v3: adds stable_prefix_hash / stable_prefix_tokens and index on fresh DB", () => {
    new FlightRecorder(dbPath).close();
    const cols = tableColumns(dbPath);
    expect(cols.has("stable_prefix_hash")).toBe(true);
    expect(cols.has("stable_prefix_tokens")).toBe(true);

    const db = new BetterSqlite3(dbPath);
    const migrations = db
      .prepare("SELECT version FROM _migrations ORDER BY version")
      .all() as Array<{ version: number }>;
    const indexExists = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_requests_stable_hash'"
      )
      .get() as { name: string } | undefined;
    db.close();

    expect(migrations.map(m => m.version)).toContain(3);
    expect(indexExists?.name).toBe("idx_requests_stable_hash");
  });

  it("v3: auto-migrates a v2 logs.db that lacks stable_prefix columns", () => {
    // Bootstrap a v2-schema DB (has cache cols, lacks stable_prefix cols).
    const seed = new BetterSqlite3(dbPath);
    seed.exec(`
      CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
      CREATE TABLE requests (
        id TEXT PRIMARY KEY,
        cli TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        system TEXT,
        response TEXT,
        session_id TEXT,
        duration_ms INTEGER,
        datetime_utc TEXT NOT NULL,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER
      );
      CREATE TABLE gateway_metadata (
        request_id TEXT PRIMARY KEY REFERENCES requests(id),
        retry_count INTEGER DEFAULT 0,
        circuit_breaker_state TEXT,
        cost_usd REAL,
        approval_decision TEXT,
        optimization_applied INTEGER DEFAULT 0,
        thinking_blocks TEXT,
        exit_code INTEGER,
        error_message TEXT,
        async_job_id TEXT,
        status TEXT NOT NULL DEFAULT 'started'
      );
    `);
    seed.prepare("INSERT INTO _migrations(version, applied_at) VALUES(1, ?), (2, ?)").run(
      new Date().toISOString(),
      new Date().toISOString()
    );
    seed
      .prepare(
        `INSERT INTO requests (id, cli, model, prompt, datetime_utc) VALUES (?, ?, ?, ?, ?)`
      )
      .run("legacy-v2", "claude", "sonnet", "hi", new Date().toISOString());
    seed.close();

    expect(tableColumns(dbPath).has("stable_prefix_hash")).toBe(false);

    new FlightRecorder(dbPath).close();

    const cols = tableColumns(dbPath);
    expect(cols.has("stable_prefix_hash")).toBe(true);
    expect(cols.has("stable_prefix_tokens")).toBe(true);

    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare(
        "SELECT stable_prefix_hash, stable_prefix_tokens FROM requests WHERE id = ?"
      )
      .get("legacy-v2") as { stable_prefix_hash: string | null; stable_prefix_tokens: number | null };
    db.close();
    expect(row.stable_prefix_hash).toBeNull();
    expect(row.stable_prefix_tokens).toBeNull();
  });

  it("v3: persists stablePrefixHash / stablePrefixTokens via logStart", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "corr-stable-1",
      cli: "claude",
      model: "sonnet",
      prompt: "assembled prompt body",
      stablePrefixHash: "abc123",
      stablePrefixTokens: 42,
    });
    rec.close();

    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare(
        "SELECT stable_prefix_hash, stable_prefix_tokens FROM requests WHERE id = ?"
      )
      .get("corr-stable-1") as {
      stable_prefix_hash: string | null;
      stable_prefix_tokens: number | null;
    };
    db.close();
    expect(row.stable_prefix_hash).toBe("abc123");
    expect(row.stable_prefix_tokens).toBe(42);
  });

  it("v3: writes NULL when stablePrefixHash / stablePrefixTokens not supplied", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "corr-nostable",
      cli: "codex",
      model: "gpt-5",
      prompt: "plain prompt",
    });
    rec.close();

    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare(
        "SELECT stable_prefix_hash, stable_prefix_tokens FROM requests WHERE id = ?"
      )
      .get("corr-nostable") as {
      stable_prefix_hash: string | null;
      stable_prefix_tokens: number | null;
    };
    db.close();
    expect(row.stable_prefix_hash).toBeNull();
    expect(row.stable_prefix_tokens).toBeNull();
  });

  it("queryRequests returns [] from NoopFlightRecorder", () => {
    const noop = new NoopFlightRecorder();
    expect(noop.queryRequests("SELECT * FROM requests")).toEqual([]);
  });

  it("queryRequests returns seeded rows from a real FlightRecorder", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "q-1",
      cli: "claude",
      model: "sonnet",
      prompt: "p1",
      stablePrefixHash: "h1",
      stablePrefixTokens: 10,
    });
    rec.logStart({
      correlationId: "q-2",
      cli: "claude",
      model: "sonnet",
      prompt: "p2",
      stablePrefixHash: "h1",
      stablePrefixTokens: 10,
    });
    const rows = rec.queryRequests<{ id: string; stable_prefix_hash: string }>(
      "SELECT id, stable_prefix_hash FROM requests WHERE stable_prefix_hash = ? ORDER BY id",
      "h1"
    );
    rec.close();
    expect(rows).toHaveLength(2);
    expect(rows[0].id).toBe("q-1");
    expect(rows[1].id).toBe("q-2");
  });

  it("writes NULL for cache columns when not supplied (back-compat)", () => {
    const rec = new FlightRecorder(dbPath);
    rec.logStart({
      correlationId: "corr-2",
      cli: "codex",
      model: "gpt-5",
      prompt: "test",
    });
    rec.logComplete("corr-2", {
      response: "ok",
      durationMs: 50,
      retryCount: 0,
      circuitBreakerState: "closed",
      optimizationApplied: false,
      exitCode: 0,
      status: "completed",
    });
    rec.close();

    const db = new BetterSqlite3(dbPath);
    const row = db
      .prepare("SELECT cache_read_tokens, cache_creation_tokens FROM requests WHERE id = ?")
      .get("corr-2") as any;
    db.close();

    expect(row.cache_read_tokens).toBeNull();
    expect(row.cache_creation_tokens).toBeNull();
  });
});
