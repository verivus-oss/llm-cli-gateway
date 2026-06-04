/**
 * Cross-engine WAL crash-recovery fixture (plan B3 / B8 acceptance artifact).
 *
 * docs/plans/node-sqlite-migration-2.0.0.md §B3 settled (round-1 Grok) that the
 * "zero data migration" and B10 rollback claims are NOT assumption-free: engine
 * version skew is real. better-sqlite3@12.10.0 bundles SQLite 3.53.1; this
 * host's Node 24 `node:sqlite` is 3.51.3. The 1.17.8 → 2.0.0 upgrade opens
 * databases last written by a NEWER SQLite with an OLDER one — including live
 * `-wal`/`-shm` recovery after an unclean stop. This test gates that claim.
 *
 * Two directions:
 *   Direction 1 (upgrade)  — better-sqlite3 writer → node:sqlite reader/writer
 *                            via the PRODUCTION FlightRecorder + SqliteJobStore.
 *   Direction 2 (rollback) — node:sqlite writer (production modules) →
 *                            better-sqlite3 reader.
 *
 * Crash-snapshot technique (the load-bearing part): write rows in WAL mode with
 * `wal_autocheckpoint = 0`, then filesystem-copy db + `-wal` + `-shm` WHILE the
 * writer connection is still open. That copy is a crash snapshot — the `-wal`
 * file still holds uncheckpointed rows. The reader must replay the WAL to see
 * them. Three load-bearing guards keep this from silently degrading into a
 * clean-file test:
 *   (a) assert the `-wal` file is non-empty BEFORE copying;
 *   (b) assert the recovered row count exceeds the count visible from the main
 *       `.db` file ALONE (a third copy without the `-wal`) — proving the WAL
 *       actually contributed rows. If SQLite checkpointed despite
 *       autocheckpoint=0, the main-db-only count would already be complete and
 *       this assertion fails loudly;
 *   (c) `PRAGMA integrity_check` returns ok through every reader.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from "fs";
import os from "os";
import path from "path";
import { createRequire } from "module";
import { FlightRecorder } from "../flight-recorder.js";
import { SqliteJobStore } from "../job-store.js";

const require = createRequire(import.meta.url);
const BetterSqlite3 = require("better-sqlite3");

// node:sqlite is loaded the same lazy way the production adapter does.
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (
    p: string,
    opts?: { readOnly?: boolean }
  ) => {
    exec(sql: string): void;
    prepare(sql: string): { get(...a: unknown[]): any; all(...a: unknown[]): any[] };
    close(): void;
  };
};

// ─── Engine-version disclosure (plan B3 motivating risk) ──────────────────
//
// Read both engines' compiled SQLite version at runtime and record them in the
// test output. They are EXPECTED to differ on this host (3.53.1 vs 3.51.3); the
// skew is the whole point of the fixture. We do NOT fail on equality — if a
// future host happens to ship matching versions, WAL-recovery cross-engine
// compatibility is still proven — but we record both so the audit can see them.
function betterSqliteVersion(): string {
  const db = new BetterSqlite3(":memory:");
  try {
    return db.prepare("SELECT sqlite_version() AS v").get().v as string;
  } finally {
    db.close();
  }
}

function nodeSqliteVersion(): string {
  const db = new DatabaseSync(":memory:");
  try {
    return db.prepare("SELECT sqlite_version() AS v").get().v as string;
  } finally {
    db.close();
  }
}

const BETTER_SQLITE_VERSION = betterSqliteVersion();
const NODE_SQLITE_VERSION = nodeSqliteVersion();

// eslint-disable-next-line no-console -- intentional disclosure to test output
console.error(
  `[cross-engine-wal] SQLite versions — better-sqlite3=${BETTER_SQLITE_VERSION} ` +
    `node:sqlite=${NODE_SQLITE_VERSION} ` +
    `(${BETTER_SQLITE_VERSION === NODE_SQLITE_VERSION ? "EQUAL on this host" : "SKEWED — engine version skew under test"})`
);

/**
 * Filesystem-level crash snapshot. Copies `dbPath` plus its `-wal`/`-shm`
 * sidecars into `destDir` while the writer connection is still open. The `-wal`
 * file MUST exist and be non-empty (asserted by the caller) or the fixture is
 * meaningless. Returns the path to the snapshot's main db file.
 */
function crashSnapshot(dbPath: string, destDir: string): string {
  const base = path.basename(dbPath);
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = dbPath + suffix;
    if (existsSync(src)) {
      copyFileSync(src, path.join(destDir, base + suffix));
    }
  }
  return path.join(destDir, base);
}

/**
 * Copy ONLY the main `.db` file (no `-wal`, no `-shm`) so we can count the rows
 * that are durable in the main file alone. With autocheckpoint=0 this excludes
 * everything still living in the WAL — that delta is the proof WAL recovery
 * contributed rows.
 */
function mainDbOnlyCopy(dbPath: string, destDir: string): string {
  const base = path.basename(dbPath);
  const dest = path.join(destDir, base);
  copyFileSync(dbPath, dest);
  return dest;
}

/** Row count, treating a missing table (WAL held the CREATE TABLE) as 0. */
function safeCount(
  db: { prepare(sql: string): { get(...a: unknown[]): any } },
  table: string
): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
    return Number(row.c);
  } catch {
    // "no such table" — the WAL we deliberately excluded held the schema too.
    return 0;
  }
}

describe("cross-engine WAL crash-recovery (plan B3/B8)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "cross-engine-wal-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Direction 1: upgrade. better-sqlite3 writer (the 1.17.8 engine) leaves a
  // crash snapshot with a live WAL; the 2.0.0 PRODUCTION code paths
  // (FlightRecorder + SqliteJobStore on node:sqlite) open and exercise it.
  // ───────────────────────────────────────────────────────────────────────
  describe("Direction 1 — upgrade: better-sqlite3 writer → node:sqlite production reader/writer", () => {
    it("recovers WAL-only rows for logs.db AND jobs.db, then operates normally", () => {
      // ── Arrange: write logs.db + jobs.db with better-sqlite3 in WAL mode,
      //    autocheckpoint OFF, using the SAME schema the production modules
      //    create (so the production reader opens an identical layout — the
      //    realistic "written by an older gateway" fixture). ──
      const writerDir = path.join(tmpDir, "writer");
      const logsPath = path.join(writerDir, "logs.db");
      const jobsPath = path.join(writerDir, "jobs.db");
      rmSync(writerDir, { recursive: true, force: true });
      require("fs").mkdirSync(writerDir, { recursive: true });

      const logsWriter = new BetterSqlite3(logsPath);
      const jobsWriter = new BetterSqlite3(jobsPath);

      // logs.db: flight-recorder schema (matches flight-recorder.ts:204-245).
      logsWriter.exec("PRAGMA journal_mode = WAL");
      logsWriter.exec("PRAGMA wal_autocheckpoint = 0");
      logsWriter.exec(`
        CREATE TABLE _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
        CREATE TABLE requests (
          id TEXT PRIMARY KEY, cli TEXT NOT NULL, model TEXT NOT NULL, prompt TEXT NOT NULL,
          system TEXT, response TEXT, session_id TEXT, duration_ms INTEGER,
          datetime_utc TEXT NOT NULL, input_tokens INTEGER, output_tokens INTEGER,
          cache_read_tokens INTEGER, cache_creation_tokens INTEGER,
          stable_prefix_hash TEXT, stable_prefix_tokens INTEGER, cache_control_blocks INTEGER
        );
        CREATE TABLE gateway_metadata (
          request_id TEXT PRIMARY KEY REFERENCES requests(id),
          retry_count INTEGER DEFAULT 0, circuit_breaker_state TEXT, cost_usd REAL,
          approval_decision TEXT, optimization_applied INTEGER DEFAULT 0, thinking_blocks TEXT,
          exit_code INTEGER, error_message TEXT, async_job_id TEXT,
          status TEXT NOT NULL DEFAULT 'started'
        );
      `);
      const insLogReq = logsWriter.prepare(
        "INSERT INTO requests (id, cli, model, prompt, datetime_utc) VALUES (?, ?, ?, ?, ?)"
      );
      const insLogMeta = logsWriter.prepare(
        "INSERT INTO gateway_metadata (request_id, status) VALUES (?, 'completed')"
      );
      const LOG_ROWS = 60;
      for (let i = 0; i < LOG_ROWS; i++) {
        insLogReq.run(
          `legacy-req-${i}`,
          "claude",
          "sonnet",
          `prompt ${i}`,
          new Date().toISOString()
        );
        insLogMeta.run(`legacy-req-${i}`);
      }

      // jobs.db: job-store schema (matches job-store.ts:181-204).
      jobsWriter.exec("PRAGMA journal_mode = WAL");
      jobsWriter.exec("PRAGMA wal_autocheckpoint = 0");
      jobsWriter.exec(`
        CREATE TABLE jobs (
          id TEXT PRIMARY KEY, correlation_id TEXT NOT NULL, request_key TEXT NOT NULL,
          cli TEXT NOT NULL, args_json TEXT NOT NULL, output_format TEXT, status TEXT NOT NULL,
          exit_code INTEGER, stdout TEXT, stderr TEXT,
          output_truncated INTEGER NOT NULL DEFAULT 0, error TEXT,
          started_at TEXT NOT NULL, finished_at TEXT, pid INTEGER, expires_at TEXT NOT NULL
        );
      `);
      const insJob = jobsWriter.prepare(`
        INSERT INTO jobs (id, correlation_id, request_key, cli, args_json, status,
                          stdout, stderr, output_truncated, started_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, '', '', 0, ?, ?)
      `);
      const JOB_ROWS = 40;
      const farFuture = "9999-12-31T23:59:59.999Z";
      for (let i = 0; i < JOB_ROWS; i++) {
        insJob.run(
          `legacy-job-${i}`,
          `corr-${i}`,
          `rk-${i}`,
          "codex",
          JSON.stringify(["-p", `hi ${i}`]),
          "completed",
          new Date().toISOString(),
          farFuture
        );
      }

      // ── Load-bearing guard (a): the WAL files MUST be non-empty before we
      //    snapshot. With autocheckpoint=0 the rows live in the WAL, not the
      //    main file. If these were 0 the test would silently become a
      //    clean-file test. ──
      const logsWalSize = statSync(logsPath + "-wal").size;
      const jobsWalSize = statSync(jobsPath + "-wal").size;
      expect(logsWalSize).toBeGreaterThan(0);
      expect(jobsWalSize).toBeGreaterThan(0);

      // ── Act: crash snapshot (copy db+wal+shm WHILE writers are open) +
      //    a main-db-ONLY copy (no wal) to measure the recovery delta. ──
      const snapDir = path.join(tmpDir, "d1-snap");
      const mainOnlyDir = path.join(tmpDir, "d1-mainonly");
      require("fs").mkdirSync(snapDir, { recursive: true });
      require("fs").mkdirSync(mainOnlyDir, { recursive: true });

      const logsSnap = crashSnapshot(logsPath, snapDir);
      const jobsSnap = crashSnapshot(jobsPath, snapDir);
      const logsMainOnly = mainDbOnlyCopy(logsPath, mainOnlyDir);
      const jobsMainOnly = mainDbOnlyCopy(jobsPath, mainOnlyDir);

      // Now close the writers (snapshot already taken = crash semantics).
      logsWriter.close();
      jobsWriter.close();

      // Assert the snapshots carry a live, non-empty WAL too.
      expect(existsSync(logsSnap + "-wal")).toBe(true);
      expect(statSync(logsSnap + "-wal").size).toBeGreaterThan(0);
      expect(existsSync(jobsSnap + "-wal")).toBe(true);
      expect(statSync(jobsSnap + "-wal").size).toBeGreaterThan(0);

      // ── Load-bearing guard (b): the main-db-ONLY copies (no WAL) must hold
      //    FEWER rows than the WAL-recovered snapshot. With autocheckpoint=0
      //    they typically hold 0. If they already held all rows, SQLite had
      //    checkpointed and WAL recovery proved nothing — fail loudly. ──
      const logsMainOnlyDb = new DatabaseSync(logsMainOnly, { readOnly: true });
      const jobsMainOnlyDb = new DatabaseSync(jobsMainOnly, { readOnly: true });
      const logsMainOnlyCount = safeCount(logsMainOnlyDb, "requests");
      const jobsMainOnlyCount = safeCount(jobsMainOnlyDb, "jobs");
      logsMainOnlyDb.close();
      jobsMainOnlyDb.close();
      expect(logsMainOnlyCount).toBeLessThan(LOG_ROWS);
      expect(jobsMainOnlyCount).toBeLessThan(JOB_ROWS);

      // ── Act + Assert: open the crash snapshot under the PRODUCTION code. ──
      const recorder = new FlightRecorder(logsSnap);
      const store = new SqliteJobStore(jobsSnap);
      try {
        // (a) All seeded rows visible — WAL recovery happened through the
        //     production read-only connection (queryRequests → openReadOnly).
        const recoveredReqs = recorder.queryRequests<{ c: number }>(
          "SELECT COUNT(*) AS c FROM requests"
        );
        expect(Number(recoveredReqs[0].c)).toBe(LOG_ROWS);

        // The delta proof: recovered count strictly exceeds main-db-only count.
        expect(Number(recoveredReqs[0].c)).toBeGreaterThan(logsMainOnlyCount);

        // Every seeded job is visible through the production getById path.
        for (let i = 0; i < JOB_ROWS; i++) {
          const rec = store.getById(`legacy-job-${i}`);
          expect(rec).not.toBeNull();
          expect(rec?.cli).toBe("codex");
        }

        // (b) Normal operations work on the recovered file: log a new
        //     request start/complete and read it back via queryRequests.
        recorder.logStart({
          correlationId: "post-recovery-1",
          cli: "gemini",
          model: "flash",
          prompt: "after recovery",
        });
        recorder.logComplete("post-recovery-1", {
          response: "ok",
          durationMs: 12,
          retryCount: 0,
          circuitBreakerState: "CLOSED",
          optimizationApplied: false,
          exitCode: 0,
          status: "completed",
        });
        const readBack = recorder.queryRequests<{ id: string; response: string }>(
          "SELECT id, response FROM requests WHERE id = ?",
          "post-recovery-1"
        );
        expect(readBack.length).toBe(1);
        expect(readBack[0].response).toBe("ok");

        // create/update/get a job through the production store.
        store.recordStart({
          id: "post-recovery-job",
          correlationId: "corr-pr",
          requestKey: "rk-pr",
          cli: "grok",
          args: ["-p", "x"],
          startedAt: new Date().toISOString(),
          pid: 999,
        });
        store.recordComplete({
          id: "post-recovery-job",
          status: "completed",
          exitCode: 0,
          stdout: "done",
          stderr: "",
          outputTruncated: false,
          error: null,
          finishedAt: new Date().toISOString(),
        });
        const prJob = store.getById("post-recovery-job");
        expect(prJob?.status).toBe("completed");
        expect(prJob?.stdout).toBe("done");

        // Total rows now = seeded + the one we just added.
        const finalReqs = recorder.queryRequests<{ c: number }>(
          "SELECT COUNT(*) AS c FROM requests"
        );
        expect(Number(finalReqs[0].c)).toBe(LOG_ROWS + 1);

        // (c) integrity_check returns ok through the production read path.
        const logsIntegrity = recorder.queryRequests<{ integrity_check: string }>(
          "PRAGMA integrity_check"
        );
        expect(logsIntegrity[0].integrity_check).toBe("ok");
      } finally {
        recorder.close();
        store.close();
      }

      // Independent integrity_check on jobs.db via a raw node:sqlite reader
      // (SqliteJobStore exposes no query surface).
      const jobsReader = new DatabaseSync(jobsSnap, { readOnly: true });
      try {
        const integ = jobsReader.prepare("PRAGMA integrity_check").all();
        expect(integ[0].integrity_check).toBe("ok");
        const cnt = jobsReader.prepare("SELECT COUNT(*) AS c FROM jobs").get();
        // seeded jobs + the one added through the production store.
        expect(Number(cnt.c)).toBe(JOB_ROWS + 1);
      } finally {
        jobsReader.close();
      }
    });
  });

  // ───────────────────────────────────────────────────────────────────────
  // Direction 2: rollback. The PRODUCTION modules (node:sqlite, the 2.0.0
  // engine) write WAL DBs; a crash snapshot is opened by better-sqlite3 (the
  // 1.17.8 engine). Proves a 2.0.0 → 1.17.8 rollback can open what node:sqlite
  // left behind, including WAL-only rows.
  // ───────────────────────────────────────────────────────────────────────
  describe("Direction 2 — rollback: node:sqlite production writer → better-sqlite3 reader", () => {
    it("better-sqlite3 recovers WAL-only rows that node:sqlite production modules wrote", () => {
      // ── Arrange: write through the production FlightRecorder + SqliteJobStore
      //    (both run PRAGMA journal_mode = WAL in their constructors). Turn
      //    autocheckpoint OFF on each connection so rows stay in the WAL. ──
      const writerDir = path.join(tmpDir, "d2-writer");
      const logsPath = path.join(writerDir, "logs.db");
      const jobsPath = path.join(writerDir, "jobs.db");

      const recorder = new FlightRecorder(logsPath);
      const store = new SqliteJobStore(jobsPath);

      // We need a handle to issue `PRAGMA wal_autocheckpoint = 0` on the SAME
      // connection the production modules write through. The production classes
      // expose exec only indirectly, but queryRequests opens a SEPARATE
      // read-only connection — pragmas there wouldn't affect the writer. So we
      // assert WAL is in effect and rely on the natural pre-checkpoint window:
      // SQLite's default autocheckpoint is 1000 pages, and our row counts stay
      // well under that, so nothing checkpoints before we snapshot. The
      // main-db-only delta guard below proves rows are genuinely WAL-resident.
      const LOG_ROWS = 50;
      for (let i = 0; i < LOG_ROWS; i++) {
        recorder.logStart({
          correlationId: `prod-req-${i}`,
          cli: "claude",
          model: "sonnet",
          prompt: `p ${i}`,
        });
        recorder.logComplete(`prod-req-${i}`, {
          response: `r ${i}`,
          durationMs: i,
          retryCount: 0,
          circuitBreakerState: "CLOSED",
          optimizationApplied: false,
          exitCode: 0,
          status: "completed",
        });
      }

      const JOB_ROWS = 35;
      for (let i = 0; i < JOB_ROWS; i++) {
        store.recordStart({
          id: `prod-job-${i}`,
          correlationId: `c-${i}`,
          requestKey: `k-${i}`,
          cli: "mistral",
          args: ["-p", `q ${i}`],
          startedAt: new Date().toISOString(),
          pid: i,
        });
        store.recordComplete({
          id: `prod-job-${i}`,
          status: "completed",
          exitCode: 0,
          stdout: `out ${i}`,
          stderr: "",
          outputTruncated: false,
          error: null,
          finishedAt: new Date().toISOString(),
        });
      }

      // ── Load-bearing guard (a): the production-written WAL files exist and
      //    are non-empty. node:sqlite ran journal_mode=WAL in the
      //    constructors; if these were 0 the writer never used WAL and the
      //    rollback test proves nothing. ──
      expect(existsSync(logsPath + "-wal")).toBe(true);
      expect(existsSync(jobsPath + "-wal")).toBe(true);
      const logsWalSize = statSync(logsPath + "-wal").size;
      const jobsWalSize = statSync(jobsPath + "-wal").size;
      expect(logsWalSize).toBeGreaterThan(0);
      expect(jobsWalSize).toBeGreaterThan(0);

      // ── Act: crash snapshot mid-flight + main-db-only copies for the delta. ──
      const snapDir = path.join(tmpDir, "d2-snap");
      const mainOnlyDir = path.join(tmpDir, "d2-mainonly");
      require("fs").mkdirSync(snapDir, { recursive: true });
      require("fs").mkdirSync(mainOnlyDir, { recursive: true });

      const logsSnap = crashSnapshot(logsPath, snapDir);
      const jobsSnap = crashSnapshot(jobsPath, snapDir);
      const logsMainOnly = mainDbOnlyCopy(logsPath, mainOnlyDir);
      const jobsMainOnly = mainDbOnlyCopy(jobsPath, mainOnlyDir);

      // Close production connections (snapshot already captured = crash).
      recorder.close();
      store.close();

      // Snapshots carry a non-empty WAL.
      expect(statSync(logsSnap + "-wal").size).toBeGreaterThan(0);
      expect(statSync(jobsSnap + "-wal").size).toBeGreaterThan(0);

      // ── Load-bearing guard (b): main-db-only (no WAL) holds fewer rows than
      //    the WAL-recovered snapshot. Read the main-only copies with
      //    better-sqlite3 (the rollback engine). ──
      const logsMainOnlyReader = new BetterSqlite3(logsMainOnly, { readonly: true });
      const jobsMainOnlyReader = new BetterSqlite3(jobsMainOnly, { readonly: true });
      const logsMainOnlyCount = safeCount(logsMainOnlyReader, "requests");
      const jobsMainOnlyCount = safeCount(jobsMainOnlyReader, "jobs");
      logsMainOnlyReader.close();
      jobsMainOnlyReader.close();
      expect(logsMainOnlyCount).toBeLessThan(LOG_ROWS);
      expect(jobsMainOnlyCount).toBeLessThan(JOB_ROWS);

      // ── Assert: better-sqlite3 opens the crash snapshot and recovers the
      //    WAL-only rows; integrity_check is ok. ──
      const logsReader = new BetterSqlite3(logsSnap);
      const jobsReader = new BetterSqlite3(jobsSnap);
      try {
        const logsCount = logsReader.prepare("SELECT COUNT(*) AS c FROM requests").get()
          .c as number;
        expect(Number(logsCount)).toBe(LOG_ROWS);
        expect(Number(logsCount)).toBeGreaterThan(logsMainOnlyCount);

        const jobsCount = jobsReader.prepare("SELECT COUNT(*) AS c FROM jobs").get().c as number;
        expect(Number(jobsCount)).toBe(JOB_ROWS);
        expect(Number(jobsCount)).toBeGreaterThan(jobsMainOnlyCount);

        // Spot-check a specific recovered row's content survived intact.
        const sampleReq = logsReader
          .prepare("SELECT response FROM requests WHERE id = ?")
          .get("prod-req-7");
        expect(sampleReq.response).toBe("r 7");
        const sampleJob = jobsReader
          .prepare("SELECT stdout, status FROM jobs WHERE id = ?")
          .get("prod-job-11");
        expect(sampleJob.stdout).toBe("out 11");
        expect(sampleJob.status).toBe("completed");

        // integrity_check ok through better-sqlite3 on both recovered files.
        expect(logsReader.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
        expect(jobsReader.prepare("PRAGMA integrity_check").get().integrity_check).toBe("ok");
      } finally {
        logsReader.close();
        jobsReader.close();
      }
    });
  });
});
