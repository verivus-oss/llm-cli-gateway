import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SqliteJobStore,
  type JobStore,
  computeRequestKey,
  resolveDedupWindowMs,
  resolveJobRetentionMs,
} from "../job-store.js";
import { openDatabase } from "../sqlite-driver.js";

/**
 * #139: force a job's fencing lease into the past on the same DB file, to
 * simulate the owning instance having died (its heartbeat stopped). Uses a
 * second connection (WAL + busy_timeout make this safe).
 */
function expireLease(dbPath: string, jobId: string): void {
  const db = openDatabase(dbPath);
  try {
    db.prepare("UPDATE jobs SET lease_deadline = 1 WHERE id = ?").run(jobId);
  } finally {
    db.close();
  }
}

describe("JobStore", () => {
  let tempDir: string;
  let dbPath: string;
  let store: JobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "job-store-test-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeRequestKey", () => {
    it("is stable for identical inputs", () => {
      const a = computeRequestKey("claude", ["-p", "hello", "--model", "sonnet"]);
      const b = computeRequestKey("claude", ["-p", "hello", "--model", "sonnet"]);
      expect(a).toBe(b);
    });

    it("differs when args change", () => {
      const a = computeRequestKey("claude", ["-p", "hello"]);
      const b = computeRequestKey("claude", ["-p", "world"]);
      expect(a).not.toBe(b);
    });

    it("differs when cli changes", () => {
      const a = computeRequestKey("claude", ["-p", "hello"]);
      const b = computeRequestKey("codex", ["-p", "hello"]);
      expect(a).not.toBe(b);
    });
  });

  describe("recordStart → recordComplete roundtrip", () => {
    it("persists a completed job that getById returns", () => {
      const id = "job-abc";
      const requestKey = computeRequestKey("claude", ["-p", "hi"]);
      const startedAt = new Date().toISOString();

      store.recordStart({
        id,
        correlationId: "corr-1",
        requestKey,
        cli: "claude",
        args: ["-p", "hi"],
        outputFormat: "text",
        startedAt,
        pid: 42,
      });

      const finishedAt = new Date().toISOString();
      store.recordComplete({
        id,
        status: "completed",
        exitCode: 0,
        stdout: "result",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt,
      });

      const row = store.getById(id);
      expect(row).not.toBeNull();
      expect(row!.status).toBe("completed");
      expect(row!.exitCode).toBe(0);
      expect(row!.stdout).toBe("result");
      expect(row!.finishedAt).toBe(finishedAt);
      // expiresAt = finishedAt + retentionMs
      const expectedExpiry = Date.parse(finishedAt) + resolveJobRetentionMs();
      expect(Date.parse(row!.expiresAt)).toBeCloseTo(expectedExpiry, -3);
    });
  });

  describe("owner principal (F3)", () => {
    it("stamps and returns the owner principal on recordStart", () => {
      store.recordStart({
        id: "job-owned",
        correlationId: "c",
        requestKey: computeRequestKey("claude", ["-p", "x"]),
        cli: "claude",
        args: ["-p", "x"],
        startedAt: new Date().toISOString(),
        pid: 1,
        ownerPrincipal: "user-alice@example.com",
      });
      expect(store.getById("job-owned")?.ownerPrincipal).toBe("user-alice@example.com");
    });

    it("defaults the owner principal to null when omitted (legacy-unowned)", () => {
      store.recordStart({
        id: "job-unowned",
        correlationId: "c",
        requestKey: computeRequestKey("claude", ["-p", "y"]),
        cli: "claude",
        args: ["-p", "y"],
        startedAt: new Date().toISOString(),
        pid: 1,
      });
      expect(store.getById("job-unowned")?.ownerPrincipal).toBeNull();
    });

    it("migrates a pre-existing jobs table by adding owner_principal (NULL for legacy rows)", () => {
      const require = createRequire(import.meta.url);
      const BetterSqlite3 = require("better-sqlite3");
      const legacyDir = mkdtempSync(join(tmpdir(), "job-store-legacy-"));
      const legacyPath = join(legacyDir, "jobs.db");
      const seed = new BetterSqlite3(legacyPath);
      seed.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, request_key TEXT NOT NULL,
          cli TEXT NOT NULL, args_json TEXT NOT NULL, output_format TEXT, status TEXT NOT NULL,
          exit_code INTEGER, stdout TEXT, stderr TEXT, output_truncated INTEGER NOT NULL DEFAULT 0,
          error TEXT, started_at TEXT NOT NULL, finished_at TEXT, pid INTEGER, expires_at TEXT NOT NULL
        );
      `);
      seed
        .prepare(
          `INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, status, started_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "legacy-1",
          "c",
          "k",
          "claude",
          "[]",
          "completed",
          new Date().toISOString(),
          "9999-12-31T23:59:59.999Z"
        );
      seed.close();

      const migrated = new SqliteJobStore(legacyPath);
      try {
        // Legacy row survives migration; owner is NULL (legacy-unowned).
        expect(migrated.getById("legacy-1")?.ownerPrincipal).toBeNull();
        // New inserts after migration can carry an owner.
        migrated.recordStart({
          id: "new-1",
          correlationId: "c",
          requestKey: "k2",
          cli: "claude",
          args: [],
          startedAt: new Date().toISOString(),
          pid: null,
          ownerPrincipal: "bob",
        });
        expect(migrated.getById("new-1")?.ownerPrincipal).toBe("bob");
      } finally {
        migrated.close();
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });
  });

  describe("findByRequestKey (dedup lookup)", () => {
    it("returns null when no matching job exists", () => {
      const found = store.findByRequestKey("nope");
      expect(found).toBeNull();
    });

    it("returns a recent queued job with a live lease (#139: recordStart persists queued)", () => {
      const requestKey = computeRequestKey("grok", ["-p", "test"]);
      store.recordStart({
        id: "j1",
        correlationId: "c1",
        requestKey,
        cli: "grok",
        args: ["-p", "test"],
        outputFormat: undefined,
        startedAt: new Date().toISOString(),
        pid: 7,
      });

      const found = store.findByRequestKey(requestKey);
      expect(found?.id).toBe("j1");
      // recordStart now persists 'queued'; a live (lease-valid) queued job is
      // still dedup-eligible.
      expect(found?.status).toBe("queued");
      expect(found?.leaseDeadline).not.toBeNull();
    });

    it("returns the most recent matching completed job within window", () => {
      const requestKey = computeRequestKey("claude", ["-p", "x"]);
      const older = new Date(Date.now() - 60_000).toISOString();
      const newer = new Date().toISOString();

      store.recordStart({
        id: "older",
        correlationId: "co",
        requestKey,
        cli: "claude",
        args: ["-p", "x"],
        startedAt: older,
        pid: 1,
      });
      store.recordComplete({
        id: "older",
        status: "completed",
        exitCode: 0,
        stdout: "old",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: older,
      });

      store.recordStart({
        id: "newer",
        correlationId: "cn",
        requestKey,
        cli: "claude",
        args: ["-p", "x"],
        startedAt: newer,
        pid: 2,
      });
      store.recordComplete({
        id: "newer",
        status: "completed",
        exitCode: 0,
        stdout: "new",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: newer,
      });

      const found = store.findByRequestKey(requestKey);
      expect(found?.id).toBe("newer");
      expect(found?.stdout).toBe("new");
    });

    it("does not return jobs older than the dedup window", () => {
      // Default dedup window is 1h; insert a job started 2h ago.
      const requestKey = computeRequestKey("codex", ["exec", "ancient"]);
      const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      store.recordStart({
        id: "ancient",
        correlationId: "ca",
        requestKey,
        cli: "codex",
        args: ["exec", "ancient"],
        startedAt: ancient,
        pid: 5,
      });
      store.recordComplete({
        id: "ancient",
        status: "completed",
        exitCode: 0,
        stdout: "result",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: ancient,
      });

      const found = store.findByRequestKey(requestKey);
      expect(found).toBeNull();
    });

    it("does not dedup onto failed/canceled/orphaned jobs", () => {
      const requestKey = computeRequestKey("claude", ["-p", "broken"]);
      const t = new Date().toISOString();
      store.recordStart({
        id: "bad",
        correlationId: "cb",
        requestKey,
        cli: "claude",
        args: ["-p", "broken"],
        startedAt: t,
        pid: 9,
      });
      store.recordComplete({
        id: "bad",
        status: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "boom",
        outputTruncated: false,
        error: "boom",
        finishedAt: t,
      });

      expect(store.findByRequestKey(requestKey)).toBeNull();
    });
  });

  describe("markOrphanedOnStartup (#139: deprecated lease shim)", () => {
    it("orphans a lease-expired (dead-owner) row and leaves live + terminal rows alone", () => {
      const t = new Date().toISOString();
      // A job whose owner died: recorded, then its lease is aged into the past.
      store.recordStart({
        id: "dead-owner",
        correlationId: "cr",
        requestKey: "k1",
        cli: "claude",
        args: ["-p", "still going"],
        startedAt: t,
        pid: 100,
      });
      // A job whose owner is still alive (fresh lease): must NOT be swept.
      store.recordStart({
        id: "live-owner",
        correlationId: "cl",
        requestKey: "k3",
        cli: "claude",
        args: ["-p", "alive"],
        startedAt: t,
        pid: 102,
      });
      // A terminal job: must be left untouched.
      store.recordStart({
        id: "done",
        correlationId: "cd",
        requestKey: "k2",
        cli: "claude",
        args: ["-p", "done"],
        startedAt: t,
        pid: 101,
      });
      store.recordComplete({
        id: "done",
        status: "completed",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: t,
      });

      expireLease(dbPath, "dead-owner");

      const changes = store.markOrphanedOnStartup();
      expect(changes.count).toBe(1);
      expect(changes.orphaned).toHaveLength(1);
      expect(changes.orphaned[0]).toMatchObject({
        id: "dead-owner",
        correlationId: "cr",
        startedAt: t,
      });

      expect(store.getById("dead-owner")?.status).toBe("orphaned");
      expect(store.getById("dead-owner")?.error).toContain("no longer alive");
      // The live-lease job is NOT orphaned (this is the whole #139 fix).
      expect(store.getById("live-owner")?.status).toBe("queued");
      expect(store.getById("done")?.status).toBe("completed");
    });
  });

  describe("evictExpired", () => {
    it("deletes rows whose expires_at is in the past", () => {
      const t = new Date().toISOString();
      store.recordStart({
        id: "expired",
        correlationId: "ce",
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: t,
        pid: 1,
      });
      store.recordComplete({
        id: "expired",
        status: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        error: null,
        // finishedAt in the far past so retention has elapsed.
        finishedAt: new Date(Date.now() - resolveJobRetentionMs() - 60_000).toISOString(),
      });

      const removed = store.evictExpired();
      expect(removed).toBe(1);
      expect(store.getById("expired")).toBeNull();
    });

    it("keeps non-terminal jobs (far-future expiry) untouched", () => {
      store.recordStart({
        id: "live",
        correlationId: "cl",
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: 1,
      });
      store.evictExpired();
      // recordStart now persists 'queued' (flipped to running by markRunning at
      // launch); either way evictExpired must not delete a non-terminal row.
      expect(store.getById("live")?.status).toBe("queued");
    });
  });

  describe("env-driven config", () => {
    it("dedup window defaults to 1 hour", () => {
      const prev = process.env.LLM_GATEWAY_DEDUP_WINDOW_MS;
      delete process.env.LLM_GATEWAY_DEDUP_WINDOW_MS;
      try {
        expect(resolveDedupWindowMs()).toBe(60 * 60 * 1000);
      } finally {
        if (prev !== undefined) process.env.LLM_GATEWAY_DEDUP_WINDOW_MS = prev;
      }
    });

    it("dedup window respects override", () => {
      const prev = process.env.LLM_GATEWAY_DEDUP_WINDOW_MS;
      process.env.LLM_GATEWAY_DEDUP_WINDOW_MS = "0";
      try {
        expect(resolveDedupWindowMs()).toBe(0);
      } finally {
        if (prev !== undefined) process.env.LLM_GATEWAY_DEDUP_WINDOW_MS = prev;
        else delete process.env.LLM_GATEWAY_DEDUP_WINDOW_MS;
      }
    });

    it("retention defaults to 30 days", () => {
      const prev = process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
      delete process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
      try {
        expect(resolveJobRetentionMs()).toBe(30 * 24 * 60 * 60 * 1000);
      } finally {
        if (prev !== undefined) process.env.LLM_GATEWAY_JOB_RETENTION_DAYS = prev;
      }
    });
  });

  describe("U22 Mistral jobs persist through the durable store", () => {
    it("persists a Mistral job and rehydrates it via getById", () => {
      const id = "mistral-job-1";
      const requestKey = computeRequestKey("mistral", ["-p", "hi", "--agent", "auto-approve"]);
      const startedAt = new Date().toISOString();

      store.recordStart({
        id,
        correlationId: "mistral-corr-1",
        requestKey,
        cli: "mistral",
        args: ["-p", "hi", "--agent", "auto-approve"],
        outputFormat: "plain",
        startedAt,
        pid: 7777,
      });

      const finishedAt = new Date().toISOString();
      store.recordComplete({
        id,
        status: "completed",
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt,
      });

      const row = store.getById(id);
      expect(row).not.toBeNull();
      expect(row!.cli).toBe("mistral");
      expect(row!.status).toBe("completed");
      // Dedup lookups should resolve back to the Mistral job
      const dedup = store.findByRequestKey(requestKey);
      expect(dedup?.id).toBe(id);
    });
  });
});
