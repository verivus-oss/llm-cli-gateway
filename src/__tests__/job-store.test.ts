import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryJobStore,
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

function kitExecution() {
  return {
    version: 1 as const,
    releaseId: "capture-kit-release",
    configStamp: "capture-kit-stamp",
    scopeRoot: "/workspace/capture-kit",
    scopeHead: "capture-kit-head",
    contextIdentity: "capture-kit-context",
  };
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

  afterEach(async () => {
    try {
      await store.close();
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
    it("persists a completed job that getById returns", async () => {
      const id = "job-abc";
      const requestKey = computeRequestKey("claude", ["-p", "hi"]);
      const startedAt = new Date().toISOString();

      await store.recordStart({
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
      await store.recordComplete({
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
      expect(await row).not.toBeNull();
      expect((await row!).status).toBe("completed");
      expect((await row!).exitCode).toBe(0);
      expect((await row!).stdout).toBe("result");
      expect((await row!).finishedAt).toBe(finishedAt);
      expect((await row!).expiresAt).toBe("9999-12-31T23:59:59.999Z");
    });
  });

  describe("MCP artifact admission", () => {
    const kitExecution = {
      version: 1 as const,
      releaseId: "job-store-admission-release",
      configStamp: "job-store-admission-stamp",
      scopeRoot: "/workspace/job-store-admission",
      scopeHead: "job-store-admission-head",
      contextIdentity: "job-store-admission-context",
    };

    const validArtifact = {
      cli: "claude",
      transport: "process" as const,
      ownerHostname: "job-store-origin",
      mcpArtifactPath: "/tmp/job-store-request/config.json",
      mcpArtifactScope: "job-store-artifact-scope",
    };

    it("rejects invalid artifact provenance before every local store writes", async () => {
      const stores: Array<[string, JobStore]> = [
        ["sqlite", store],
        ["memory", new MemoryJobStore()],
      ];
      const invalidInputs = [
        { ...validArtifact, kitExecution, kitSessionId: "kit-session" },
        { ...validArtifact, mcpArtifactScope: null },
        { ...validArtifact, mcpArtifactPath: null },
        { ...validArtifact, cli: "codex" },
        { ...validArtifact, transport: "http" as const },
        { ...validArtifact, ownerHostname: "" },
      ];

      for (const [storeName, candidate] of stores) {
        for (const [index, invalid] of invalidInputs.entries()) {
          const id = `${storeName}-invalid-artifact-${index}`;
          await expect(
            candidate.recordStart({
              id,
              correlationId: `corr-${id}`,
              requestKey: `key-${id}`,
              args: ["-p", "review"],
              startedAt: new Date().toISOString(),
              pid: null,
              ...invalid,
            })
          ).rejects.toThrow();
          expect(await candidate.getById(id)).toBeNull();
        }
      }

      const db = openDatabase(dbPath);
      try {
        const fenceCount = db.prepare("SELECT COUNT(*) AS count FROM kit_attempt_fences").get() as {
          count: number;
        };
        expect(fenceCount.count).toBe(0);
      } finally {
        db.close();
      }
    });

    it("persists a complete non-Kit Claude process provenance record", async () => {
      await store.recordStart({
        id: "valid-artifact-provenance",
        correlationId: "corr-valid-artifact-provenance",
        requestKey: "key-valid-artifact-provenance",
        args: ["-p", "review"],
        startedAt: new Date().toISOString(),
        pid: null,
        ...validArtifact,
      });
      expect(await store.getById("valid-artifact-provenance")).toMatchObject({
        ...validArtifact,
        mcpArtifactCleanupPending: true,
      });
    });
  });

  describe("owner principal (F3)", () => {
    it("stamps and returns the owner principal on recordStart", async () => {
      await store.recordStart({
        id: "job-owned",
        correlationId: "c",
        requestKey: computeRequestKey("claude", ["-p", "x"]),
        cli: "claude",
        args: ["-p", "x"],
        startedAt: new Date().toISOString(),
        pid: 1,
        ownerPrincipal: "user-alice@example.com",
      });
      expect((await store.getById("job-owned"))?.ownerPrincipal).toBe("user-alice@example.com");
    });

    it("defaults the owner principal to null when omitted (legacy-unowned)", async () => {
      await store.recordStart({
        id: "job-unowned",
        correlationId: "c",
        requestKey: computeRequestKey("claude", ["-p", "y"]),
        cli: "claude",
        args: ["-p", "y"],
        startedAt: new Date().toISOString(),
        pid: 1,
      });
      expect((await store.getById("job-unowned"))?.ownerPrincipal).toBeNull();
    });

    it("allows only local replay of an exact legacy-unowned recovered Kit fence", async () => {
      const fence = {
        attemptId: "legacy-unowned-recovered-fence",
        cli: "claude",
        kitExecution: {
          version: 1 as const,
          releaseId: "legacy-fence-release",
          configStamp: "legacy-fence-stamp",
          scopeRoot: "/workspace/legacy-fence",
          scopeHead: "legacy-fence-head",
          contextIdentity: "legacy-fence-context",
        },
        kitSessionId: "legacy-unowned-fence-session",
        ownerPrincipal: null,
        fencedAt: new Date().toISOString(),
      };

      expect(await store.fenceUnadmittedKitAttempt(fence)).toBe("reserved");
      expect(await store.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: "local" })).toBe(
        "already_recovered"
      );
      expect(
        await store.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: "remote-reviewer" })
      ).toBe("conflict");
      expect(await store.fenceUnadmittedKitAttempt(fence)).toBe("conflict");
      expect(await store.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: undefined })).toBe(
        "conflict"
      );
      expect(
        await store.fenceUnadmittedKitAttempt({
          ...fence,
          ownerPrincipal: 42 as unknown as string,
        })
      ).toBe("conflict");

      const db = openDatabase(dbPath);
      try {
        const persisted = db
          .prepare("SELECT owner_principal FROM kit_attempt_fences WHERE attempt_id = ?")
          .get(fence.attemptId) as { owner_principal: string | null };
        expect(persisted.owner_principal).toBeNull();
      } finally {
        db.close();
      }

      const memory = new MemoryJobStore();
      expect(await memory.fenceUnadmittedKitAttempt(fence)).toBe("reserved");
      expect(await memory.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: "local" })).toBe(
        "already_recovered"
      );
      expect(
        await memory.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: "remote-reviewer" })
      ).toBe("conflict");
      expect(await memory.fenceUnadmittedKitAttempt(fence)).toBe("conflict");
      expect(await memory.fenceUnadmittedKitAttempt({ ...fence, ownerPrincipal: undefined })).toBe(
        "conflict"
      );
      expect(
        await memory.fenceUnadmittedKitAttempt({
          ...fence,
          ownerPrincipal: 42 as unknown as string,
        })
      ).toBe("conflict");
    });

    it("migrates a pre-existing jobs table by adding owner_principal (NULL for legacy rows)", async () => {
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
          "2000-01-01T00:00:00.000Z"
        );
      seed.close();

      const migrated = new SqliteJobStore(legacyPath, undefined, { retentionMs: null });
      try {
        // Legacy row survives migration; owner is NULL (legacy-unowned).
        expect((await migrated.getById("legacy-1"))?.ownerPrincipal).toBeNull();
        expect(await migrated.getById("legacy-1")).toMatchObject({
          errorCategory: null,
          retryable: null,
          expiresAt: "2000-01-01T00:00:00.000Z",
        });
        expect(await migrated.evictExpired()).toBe(1);
        // New inserts after migration can carry an owner.
        await migrated.recordStart({
          id: "new-1",
          correlationId: "c",
          requestKey: "k2",
          cli: "claude",
          args: [],
          startedAt: new Date().toISOString(),
          pid: null,
          ownerPrincipal: "bob",
        });
        expect((await migrated.getById("new-1"))?.ownerPrincipal).toBe("bob");
        await migrated.recordComplete({
          id: "new-1",
          status: "failed",
          exitCode: 126,
          stdout: "",
          stderr: "input too large",
          outputTruncated: false,
          error: "input too large",
          errorCategory: "input_too_large",
          retryable: false,
          finishedAt: new Date().toISOString(),
        });
        expect(await migrated.getById("new-1")).toMatchObject({
          errorCategory: "input_too_large",
          retryable: false,
        });
      } finally {
        await migrated.close();
        rmSync(legacyDir, { recursive: true, force: true });
      }
    });

    it("rebases only live rows written with the former 30-day default", async () => {
      const policyPath = join(tempDir, "former-default-retention.db");
      const formerDefaultMs = 30 * 24 * 60 * 60 * 1000;
      const formerDefault = new SqliteJobStore(policyPath, undefined, {
        retentionMs: formerDefaultMs,
      });
      const finishedAt = new Date().toISOString();
      await formerDefault.recordStart({
        id: "former-default-row",
        correlationId: "former-default-corr",
        requestKey: "former-default-key",
        cli: "claude",
        args: ["-p", "history"],
        startedAt: finishedAt,
        pid: null,
      });
      await formerDefault.recordComplete({
        id: "former-default-row",
        status: "completed",
        exitCode: 0,
        stdout: "history",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt,
      });
      await formerDefault.close();

      const explicitFiniteMs = 7 * 24 * 60 * 60 * 1000;
      const explicitFinite = new SqliteJobStore(policyPath, undefined, {
        retentionMs: explicitFiniteMs,
      });
      await explicitFinite.recordStart({
        id: "explicit-finite-row",
        correlationId: "explicit-finite-corr",
        requestKey: "explicit-finite-key",
        cli: "claude",
        args: ["-p", "bounded"],
        startedAt: finishedAt,
        pid: null,
      });
      await explicitFinite.recordComplete({
        id: "explicit-finite-row",
        status: "completed",
        exitCode: 0,
        stdout: "bounded",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt,
      });
      await explicitFinite.close();

      const unbounded = new SqliteJobStore(policyPath, undefined, { retentionMs: null });
      try {
        expect(await unbounded.getById("former-default-row")).toMatchObject({
          expiresAt: "9999-12-31T23:59:59.999Z",
        });
        expect(Date.parse((await unbounded.getById("explicit-finite-row"))!.expiresAt)).toBe(
          Date.parse(finishedAt) + explicitFiniteMs
        );
      } finally {
        await unbounded.close();
      }
    });

    it("applies a later finite retention bound to terminal unbounded rows", async () => {
      const policyPath = join(tempDir, "retention-policy-change.db");
      const unbounded = new SqliteJobStore(policyPath, undefined, { retentionMs: null });
      const finishedAt = "2026-01-01T00:00:00.000Z";
      await unbounded.recordStart({
        id: "previously-unbounded",
        correlationId: "previously-unbounded-corr",
        requestKey: "previously-unbounded-key",
        cli: "claude",
        args: ["-p", "history"],
        startedAt: finishedAt,
        pid: null,
      });
      await unbounded.recordComplete({
        id: "previously-unbounded",
        status: "completed",
        exitCode: 0,
        stdout: "history",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt,
      });
      await unbounded.close();

      const bounded = new SqliteJobStore(policyPath, undefined, { retentionMs: 1_000 });
      try {
        expect(Date.parse((await bounded.getById("previously-unbounded"))!.expiresAt)).toBe(
          Date.parse(finishedAt) + 1_000
        );
        expect(await bounded.evictExpired()).toBe(1);
      } finally {
        await bounded.close();
      }
    });

    it("marks terminal rows without capture accounting as unavailable on reopen", async () => {
      const recoveryPath = join(tempDir, "capture-accounting-recovery.db");
      const initial = new SqliteJobStore(recoveryPath, undefined, { retentionMs: null });
      const finishedAt = new Date().toISOString();
      await initial.recordStart({
        id: "capture-accounting-gap",
        correlationId: "capture-accounting-gap-corr",
        requestKey: "capture-accounting-gap-key",
        cli: "claude",
        args: ["-p", "history"],
        startedAt: finishedAt,
        pid: null,
      });
      await initial.recordComplete({
        id: "capture-accounting-gap",
        status: "completed",
        exitCode: 0,
        stdout: "history",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt,
      });
      await initial.close();

      const reopened = new SqliteJobStore(recoveryPath, undefined, { retentionMs: null });
      try {
        expect(await reopened.getById("capture-accounting-gap")).toMatchObject({
          captureStatus: "not_captured",
          captureError: "Gateway stopped before capture accounting completed",
        });
      } finally {
        await reopened.close();
      }
    });
  });

  describe("findByRequestKey (dedup lookup)", () => {
    it("returns null when no matching job exists", async () => {
      const found = store.findByRequestKey("nope");
      expect(await found).toBeNull();
    });

    it("returns a recent queued job with a live lease (#139: recordStart persists queued)", async () => {
      const requestKey = computeRequestKey("grok", ["-p", "test"]);
      await store.recordStart({
        id: "j1",
        correlationId: "c1",
        requestKey,
        cli: "grok",
        args: ["-p", "test"],
        outputFormat: undefined,
        startedAt: new Date().toISOString(),
        pid: 7,
      });

      const found = await store.findByRequestKey(requestKey);
      expect(found?.id).toBe("j1");
      // recordStart now persists 'queued'; a live (lease-valid) queued job is
      // still dedup-eligible.
      expect(found?.status).toBe("queued");
      expect(found?.leaseDeadline).not.toBeNull();
    });

    it("returns the most recent matching completed job within window", async () => {
      const requestKey = computeRequestKey("claude", ["-p", "x"]);
      const older = new Date(Date.now() - 60_000).toISOString();
      const newer = new Date().toISOString();

      await store.recordStart({
        id: "older",
        correlationId: "co",
        requestKey,
        cli: "claude",
        args: ["-p", "x"],
        startedAt: older,
        pid: 1,
      });
      await store.recordComplete({
        id: "older",
        status: "completed",
        exitCode: 0,
        stdout: "old",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: older,
      });

      await store.recordStart({
        id: "newer",
        correlationId: "cn",
        requestKey,
        cli: "claude",
        args: ["-p", "x"],
        startedAt: newer,
        pid: 2,
      });
      await store.recordComplete({
        id: "newer",
        status: "completed",
        exitCode: 0,
        stdout: "new",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: newer,
      });

      const found = await store.findByRequestKey(requestKey);
      expect(found?.id).toBe("newer");
      expect(found?.stdout).toBe("new");
    });

    it("does not return jobs older than the dedup window", async () => {
      // Default dedup window is 1h; insert a job started 2h ago.
      const requestKey = computeRequestKey("codex", ["exec", "ancient"]);
      const ancient = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

      await store.recordStart({
        id: "ancient",
        correlationId: "ca",
        requestKey,
        cli: "codex",
        args: ["exec", "ancient"],
        startedAt: ancient,
        pid: 5,
      });
      await store.recordComplete({
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
      expect(await found).toBeNull();
    });

    it("does not dedup onto failed/canceled/orphaned jobs", async () => {
      const requestKey = computeRequestKey("claude", ["-p", "broken"]);
      const t = new Date().toISOString();
      await store.recordStart({
        id: "bad",
        correlationId: "cb",
        requestKey,
        cli: "claude",
        args: ["-p", "broken"],
        startedAt: t,
        pid: 9,
      });
      await store.recordComplete({
        id: "bad",
        status: "failed",
        exitCode: 1,
        stdout: "",
        stderr: "boom",
        outputTruncated: false,
        error: "boom",
        finishedAt: t,
      });

      expect(await store.findByRequestKey(requestKey)).toBeNull();
    });
  });

  describe("markOrphanedOnStartup (#139: deprecated lease shim)", () => {
    it("orphans a lease-expired (dead-owner) row and leaves live + terminal rows alone", async () => {
      const t = new Date().toISOString();
      // A job whose owner died: recorded, then its lease is aged into the past.
      await store.recordStart({
        id: "dead-owner",
        correlationId: "cr",
        requestKey: "k1",
        cli: "claude",
        args: ["-p", "still going"],
        startedAt: t,
        pid: 100,
      });
      // A job whose owner is still alive (fresh lease): must NOT be swept.
      await store.recordStart({
        id: "live-owner",
        correlationId: "cl",
        requestKey: "k3",
        cli: "claude",
        args: ["-p", "alive"],
        startedAt: t,
        pid: 102,
      });
      // A terminal job: must be left untouched.
      await store.recordStart({
        id: "done",
        correlationId: "cd",
        requestKey: "k2",
        cli: "claude",
        args: ["-p", "done"],
        startedAt: t,
        pid: 101,
      });
      await store.recordComplete({
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

      const changes = await store.markOrphanedOnStartup();
      expect(changes.count).toBe(1);
      expect(changes.orphaned).toHaveLength(1);
      expect(changes.orphaned[0]).toMatchObject({
        id: "dead-owner",
        correlationId: "cr",
        startedAt: t,
      });

      expect((await store.getById("dead-owner"))?.status).toBe("orphaned");
      expect((await store.getById("dead-owner"))?.error).toContain("no longer alive");
      // The live-lease job is NOT orphaned (this is the whole #139 fix).
      expect((await store.getById("live-owner"))?.status).toBe("queued");
      expect((await store.getById("done"))?.status).toBe("completed");
    });
  });

  describe("evictExpired", () => {
    it("deletes rows whose expires_at is in the past", async () => {
      const bounded = new SqliteJobStore(join(tempDir, "bounded.db"), undefined, {
        retentionMs: 1,
      });
      const t = new Date().toISOString();
      await bounded.recordStart({
        id: "expired",
        correlationId: "ce",
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: t,
        pid: 1,
      });
      await bounded.recordComplete({
        id: "expired",
        status: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: new Date(Date.now() - 60_000).toISOString(),
      });

      const removed = bounded.evictExpired();
      expect(await removed).toBe(1);
      expect(await bounded.getById("expired")).toBeNull();
      await bounded.close();
    });

    it("keeps non-terminal jobs (far-future expiry) untouched", async () => {
      await store.recordStart({
        id: "live",
        correlationId: "cl",
        requestKey: "k",
        cli: "claude",
        args: [],
        startedAt: new Date().toISOString(),
        pid: 1,
      });
      await store.evictExpired();
      // recordStart now persists 'queued' (flipped to running by markRunning at
      // launch); either way evictExpired must not delete a non-terminal row.
      expect((await store.getById("live"))?.status).toBe("queued");
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

    it("retention defaults to unbounded", () => {
      const prev = process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
      delete process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
      try {
        expect(resolveJobRetentionMs()).toBeNull();
      } finally {
        if (prev !== undefined) process.env.LLM_GATEWAY_JOB_RETENTION_DAYS = prev;
      }
    });

    it("rejects an invalid retention environment override", () => {
      const prev = process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
      process.env.LLM_GATEWAY_JOB_RETENTION_DAYS = "forever";
      try {
        expect(() => resolveJobRetentionMs()).toThrow(/must be a positive number/);
      } finally {
        if (prev !== undefined) process.env.LLM_GATEWAY_JOB_RETENTION_DAYS = prev;
        else delete process.env.LLM_GATEWAY_JOB_RETENTION_DAYS;
      }
    });
  });

  describe("U22 Mistral jobs persist through the durable store", () => {
    it("persists a Mistral job and rehydrates it via getById", async () => {
      const id = "mistral-job-1";
      const requestKey = computeRequestKey("mistral", ["-p", "hi", "--agent", "auto-approve"]);
      const startedAt = new Date().toISOString();

      await store.recordStart({
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
      await store.recordComplete({
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
      expect(await row).not.toBeNull();
      expect((await row!).cli).toBe("mistral");
      expect((await row!).status).toBe("completed");
      // Dedup lookups should resolve back to the Mistral job
      const dedup = await store.findByRequestKey(requestKey);
      expect(dedup?.id).toBe(id);
    });
  });
  describe("recordComplete guard reporting (cross-backend parity)", () => {
    // The manager uses this boolean to tell "I committed this row" from
    // "someone else already did", and only the former licenses the unfenced
    // recordOutput. A backend that reported the wrong answer would silently
    // re-open the clobber the ownership rule exists to prevent, so every
    // backend has to agree.
    const backends = (): Array<[string, JobStore]> => [
      ["sqlite", new SqliteJobStore(join(tempDir, `parity-${Math.random()}`.replace(".", "")))],
      ["memory", new MemoryJobStore()],
    ];

    it("round-trips replay context and terminal capture accounting", async () => {
      for (const [name, backend] of backends()) {
        const t = new Date().toISOString();
        await backend.recordStart({
          id: "capture-parity",
          correlationId: "capture-corr",
          requestKey: "capture-key",
          cli: "devin",
          args: ["--export", "/tmp/gateway-owned.json"],
          outputFormat: "text",
          startedAt: t,
          pid: 7,
          ownerInstance: "capture-owner",
          cwd: { scope: "workspace", path: "/workspace/repo", workspaceAlias: "repo" },
          replayContext: {
            version: 1,
            repositoryHead: "a".repeat(40),
            instructionFiles: [
              {
                path: "/workspace/repo/AGENTS.md",
                sha256: "b".repeat(64),
                sourceBytes: 18,
                effectiveBytes: 18,
                effectiveLimitBytes: null,
                truncated: false,
                status: "captured",
              },
            ],
          },
          captureFormat: "atif-v1.7",
        });
        expect(
          await backend.recordCapture({
            id: "capture-parity",
            ownerInstance: "other-owner",
            captureStatus: "captured_whole",
            outputDroppedBytes: 0,
            nativeTranscript: "must-not-land",
            nativeTranscriptBytes: 13,
            nativeTranscriptTruncated: false,
            nativeTranscriptDroppedBytes: 0,
            captureError: null,
          }),
          name
        ).toBe(false);
        expect(
          await backend.recordCapture({
            id: "capture-parity",
            ownerInstance: "capture-owner",
            captureStatus: "captured_to_limit",
            outputDroppedBytes: 0,
            nativeTranscript: '{"version":"ATIF-v1.7"}',
            nativeTranscriptBytes: 23,
            nativeTranscriptTruncated: true,
            nativeTranscriptDroppedBytes: 41,
            captureError: null,
          }),
          name
        ).toBe(true);
        expect(
          await backend.recordComplete({
            id: "capture-parity",
            status: "completed",
            exitCode: 0,
            stdout: "done",
            stderr: "",
            outputTruncated: false,
            error: null,
            finishedAt: t,
          }),
          name
        ).toBe(true);
        expect(
          await backend.recordCapture({
            id: "capture-parity",
            ownerInstance: "capture-owner",
            captureStatus: "not_captured",
            outputDroppedBytes: 0,
            nativeTranscript: null,
            nativeTranscriptBytes: 0,
            nativeTranscriptTruncated: false,
            nativeTranscriptDroppedBytes: 0,
            captureError: "must not downgrade",
          }),
          name
        ).toBe(false);

        const row = await backend.getById("capture-parity");
        expect(row?.cwdScope, name).toBe("workspace");
        expect(row?.workspaceAlias, name).toBe("repo");
        expect(row?.replayContext?.repositoryHead, name).toBe("a".repeat(40));
        expect(row?.captureFormat, name).toBe("atif-v1.7");
        expect(row?.captureStatus, name).toBe("captured_to_limit");
        expect(row?.nativeTranscript, name).toContain("ATIF-v1.7");
        expect(row?.nativeTranscriptTruncated, name).toBe(true);
        expect(row?.nativeTranscriptDroppedBytes, name).toBe(41);
        await backend.close();
      }
    });

    it("rejects capture persistence for Personal Agent Config Kit rows", async () => {
      for (const [name, backend] of backends()) {
        const t = new Date().toISOString();
        await backend.recordStart({
          id: "kit-capture-parity",
          correlationId: "kit-capture-parity-corr",
          requestKey: "private-key-must-not-land",
          cli: "claude",
          args: ["private", "arguments"],
          startedAt: t,
          pid: null,
          ownerInstance: "kit-capture-owner",
          kitExecution: kitExecution(),
          kitSessionId: "kit-capture-session",
        });
        expect(
          await backend.recordCapture({
            id: "kit-capture-parity",
            ownerInstance: "kit-capture-owner",
            captureStatus: "not_captured",
            outputDroppedBytes: 9,
            nativeTranscript: "private transcript",
            nativeTranscriptBytes: 18,
            nativeTranscriptTruncated: true,
            nativeTranscriptDroppedBytes: 7,
            captureError: "private capture error",
          }),
          name
        ).toBe(false);
        expect(await backend.getById("kit-capture-parity"), name).toMatchObject({
          captureStatus: null,
          outputDroppedBytes: 0,
          nativeTranscript: null,
          captureError: null,
        });
        await backend.close();
      }
    });

    it("commits terminal output and capture accounting atomically", async () => {
      for (const [name, backend] of backends()) {
        const finishedAt = new Date().toISOString();
        await backend.recordStart({
          id: "atomic-capture-parity",
          correlationId: "atomic-capture-corr",
          requestKey: "atomic-capture-key",
          cli: "claude",
          args: ["-p", "capture"],
          startedAt: finishedAt,
          pid: 7,
          ownerInstance: "atomic-capture-owner",
        });
        expect(
          await backend.recordComplete({
            id: "atomic-capture-parity",
            status: "completed",
            exitCode: 0,
            stdout: "complete wire",
            stderr: "",
            outputTruncated: false,
            error: null,
            finishedAt,
            capture: {
              captureStatus: "captured_whole",
              outputDroppedBytes: 0,
              nativeTranscript: null,
              nativeTranscriptBytes: 0,
              nativeTranscriptTruncated: false,
              nativeTranscriptDroppedBytes: 0,
              captureError: null,
            },
          }),
          name
        ).toBe(true);
        expect(await backend.getById("atomic-capture-parity"), name).toMatchObject({
          status: "completed",
          stdout: "complete wire",
          captureStatus: "captured_whole",
          outputDroppedBytes: 0,
        });
        await backend.close();
      }
    });

    it("returns true on an open row and false once the row is terminal", async () => {
      for (const [name, backend] of backends()) {
        const t = new Date().toISOString();
        await backend.recordStart({
          id: "parity-job",
          correlationId: "parity-corr",
          requestKey: "parity-key",
          cli: "claude",
          args: ["-p", "hi"],
          startedAt: t,
          pid: 4242,
        });
        const terminal = {
          id: "parity-job",
          status: "canceled" as const,
          exitCode: null,
          stdout: "PARTIAL",
          stderr: "",
          outputTruncated: false,
          error: "canceled by caller",
          finishedAt: t,
        };
        expect(await backend.recordComplete(terminal), name).toBe(true);
        expect(await backend.recordComplete({ ...terminal, stdout: "LATER" }), name).toBe(false);
        expect((await backend.getById("parity-job"))?.stdout, name).toBe("PARTIAL");
        await backend.close();
      }
    });

    it("returns false for an id that does not exist", async () => {
      for (const [name, backend] of backends()) {
        expect(
          await backend.recordComplete({
            id: "no-such-row",
            status: "completed",
            exitCode: 0,
            stdout: "",
            stderr: "",
            outputTruncated: false,
            error: null,
            finishedAt: new Date().toISOString(),
          }),
          name
        ).toBe(false);
        await backend.close();
      }
    });

    it("admits a terminal write onto an orphaned row, so recovery still works", async () => {
      // The guard admits 'orphaned' on purpose: a job whose owner died must
      // still be completable by whoever adopts it. If that returned false the
      // adopting instance would treat a row it legitimately owns as foreign
      // and refuse to persist its output. Sqlite only: the lease transition is
      // driven through the real sweep, which needs a file-backed row.
      const orphanPath = join(tempDir, "orphan-parity.db");
      const backend = new SqliteJobStore(orphanPath);
      try {
        const t = new Date().toISOString();
        await backend.recordStart({
          id: "orphan-parity",
          correlationId: "orphan-corr",
          requestKey: "orphan-key",
          cli: "codex",
          args: ["exec", "hi"],
          startedAt: t,
          pid: 7,
          ownerInstance: "dead-instance",
        });
        expireLease(orphanPath, "orphan-parity");
        await backend.recoverStaleJobs(1, 300_000);
        // Guard against a vacuous assertion: the row must really be orphaned.
        expect((await backend.getById("orphan-parity"))?.status).toBe("orphaned");

        expect(
          await backend.recordComplete({
            id: "orphan-parity",
            status: "completed",
            exitCode: 0,
            stdout: "recovered",
            stderr: "",
            outputTruncated: false,
            error: null,
            finishedAt: t,
          })
        ).toBe(true);
        expect((await backend.getById("orphan-parity"))?.stdout).toBe("recovered");
      } finally {
        await backend.close();
      }
    });
  });
});
