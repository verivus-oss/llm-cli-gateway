import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { readPersistedRequest } from "../cache-stats.js";
import { FlightRecorder } from "../flight-recorder.js";
import { SqliteJobStore, type JobStore, computeRequestKey } from "../job-store.js";
import { openDatabase } from "../sqlite-driver.js";

/**
 * #139: force a job's fencing lease into the past on the same DB file, to
 * simulate the owning gateway instance having died (its heartbeat stopped).
 */
function expireLease(dbPath: string, jobId: string): void {
  const db = openDatabase(dbPath);
  try {
    db.prepare("UPDATE jobs SET lease_deadline = 1 WHERE id = ?").run(jobId);
  } finally {
    db.close();
  }
}

/**
 * These tests focus on the durability + dedup behavior added on top of the
 * existing in-memory job manager. They do not spawn real CLI processes; the
 * dedup short-circuit must return BEFORE any spawn happens.
 */
describe("AsyncJobManager + JobStore (durability + dedup)", () => {
  let tempDir: string;
  let dbPath: string;
  let store: JobStore;
  let manager: AsyncJobManager;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "ajm-store-test-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath);
    manager = new AsyncJobManager(undefined, undefined, store);
    // Durable admission is restored asynchronously and Kit/durable paths refuse
    // to start until it settles. C5 made the store's own initialisation genuinely
    // async, so without this the test runs INSIDE the startup window that
    // design section 4.1 describes, and the refusal it sees is correct behaviour
    // rather than the thing under test.
    await manager.whenStartupSettled();
  });

  afterEach(async () => {
    try {
      await store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dedups onto a recent completed job without spawning a new process", async () => {
    const cli = "claude" as const;
    const args = ["-p", "what is 2+2", "--model", "haiku"];
    const requestKey = computeRequestKey(cli, args);
    const t = new Date().toISOString();

    // Pre-seed the store with a completed job that matches.
    await store.recordStart({
      id: "preexisting-job",
      correlationId: "prior-corr",
      requestKey,
      cli,
      args,
      startedAt: t,
      pid: 1234,
    });
    await store.recordComplete({
      id: "preexisting-job",
      status: "completed",
      exitCode: 0,
      stdout: "4",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: t,
    });

    const outcome = await manager.startJobWithDedup(cli, args, "new-corr-id");

    expect(outcome.deduped).toBe(true);
    expect(outcome.snapshot.id).toBe("preexisting-job");
    expect(outcome.snapshot.status).toBe("completed");
    expect(outcome.originalCorrelationId).toBe("prior-corr");

    // Result should be retrievable.
    const result = await manager.getJobResult("preexisting-job");
    expect(result?.stdout).toBe("4");
    expect(result?.exitCode).toBe(0);
  });

  it("getJobResult falls back to JobStore for jobs not in memory", async () => {
    const cli = "gemini" as const;
    const args = ["hello", "--model", "flash"];
    const t = new Date().toISOString();

    await store.recordStart({
      id: "historic-job",
      correlationId: "historic",
      requestKey: computeRequestKey(cli, args),
      cli,
      args,
      startedAt: t,
      pid: 9999,
    });
    await store.recordComplete({
      id: "historic-job",
      status: "completed",
      exitCode: 0,
      stdout: "hi from gemini",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: t,
    });

    // The manager has not seen this job — it was created before manager existed.
    const snapshot = await manager.getJobSnapshot("historic-job");
    expect(snapshot?.status).toBe("completed");

    const result = await manager.getJobResult("historic-job");
    expect(result?.stdout).toBe("hi from gemini");
  });

  it("#139: startup lease sweep orphans a dead-owner (lease-expired) row on construction", async () => {
    // Seed a row from a prior gateway run, then age its lease (owner died).
    const t = new Date().toISOString();
    await store.recordStart({
      id: "orphan-candidate",
      correlationId: "prior",
      requestKey: "k",
      cli: "codex",
      args: ["exec", "hi"],
      startedAt: t,
      pid: 1,
      ownerInstance: "prior-instance",
    });
    expireLease(dbPath, "orphan-candidate");

    // Spin up a fresh manager; its constructor runs the lease sweep.
    const fresh = new AsyncJobManager(undefined, undefined, store);
    // Durable admission is restored asynchronously and Kit/durable paths refuse
    // to start until it settles. C5 made the store's own initialisation genuinely
    // async, so without this the test runs INSIDE the startup window that
    // design section 4.1 describes, and the refusal it sees is correct behaviour
    // rather than the thing under test.
    await fresh.whenStartupSettled();

    const snapshot = await fresh.getJobSnapshot("orphan-candidate");
    expect(snapshot?.status).toBe("orphaned");
    expect(snapshot?.error).toContain("no longer alive");
  });

  it("#139: a fresh instance does NOT orphan a live-lease job, but DOES once the lease expires", async () => {
    // Seed a row owned by a DIFFERENT, still-live instance (fresh lease).
    const t = new Date().toISOString();
    await store.recordStart({
      id: "other-instance-running",
      correlationId: "other",
      requestKey: "k2",
      cli: "codex",
      args: ["exec", "hi"],
      startedAt: t,
      pid: 1,
      ownerInstance: "live-instance",
    });

    // A fresh instance (e.g. an ephemeral stdio spawn on a shared postgres store)
    // must NOT orphan another instance's live-lease job. This is the #139 fix.
    const b = new AsyncJobManager(undefined, undefined, store);
    // Durable admission is restored asynchronously and Kit/durable paths refuse
    // to start until it settles. C5 made the store's own initialisation genuinely
    // async, so without this the test runs INSIDE the startup window that
    // design section 4.1 describes, and the refusal it sees is correct behaviour
    // rather than the thing under test.
    await b.whenStartupSettled();
    expect((await b.getJobSnapshot("other-instance-running"))?.status).toBe("queued");

    // Now the owner dies (lease lapses): a subsequent instance's sweep recovers it.
    expireLease(dbPath, "other-instance-running");
    const c = new AsyncJobManager(undefined, undefined, store);
    expect((await c.getJobSnapshot("other-instance-running"))?.status).toBe("orphaned");
  });

  it("orphaned startup readback preserves captured stdout as completed and no-output rows as restart failures", async () => {
    const rec = new FlightRecorder(join(tempDir, "logs.db"));
    try {
      const startedAt = new Date(Date.now() - 5000).toISOString();
      await store.recordStart({
        id: "captured-output",
        correlationId: "corr-captured-output",
        requestKey: "captured-key",
        cli: "grok",
        args: ["-p", "review"],
        startedAt,
        pid: 123,
      });
      await store.recordOutput("captured-output", "usable provider response\n", "", false);
      await rec.logStart({
        correlationId: "corr-captured-output",
        cli: "grok",
        model: "default",
        prompt: "review",
        asyncJobId: "captured-output",
      });

      await store.recordStart({
        id: "no-output",
        correlationId: "corr-no-output",
        requestKey: "no-output-key",
        cli: "mistral",
        args: ["-p", "review"],
        startedAt,
        pid: 124,
      });
      await rec.logStart({
        correlationId: "corr-no-output",
        cli: "mistral",
        model: "default",
        prompt: "review",
        asyncJobId: "no-output",
      });

      // #139: both rows' owners are gone, so age their leases into the past; the
      // fresh manager's startup sweep then orphans them.
      expireLease(dbPath, "captured-output");
      expireLease(dbPath, "no-output");

      const fresh = new AsyncJobManager(undefined, undefined, store, rec);

      expect((await fresh.getJobSnapshot("captured-output"))?.status).toBe("orphaned");
      expect((await fresh.getJobResult("captured-output"))?.stdout).toBe(
        "usable provider response\n"
      );
      const captured = await readPersistedRequest(rec, "corr-captured-output");
      expect(captured?.status).toBe("completed");
      expect(captured?.exitCode).toBe(0);
      expect(captured?.errorMessage).toBeNull();
      expect(captured?.response).toBe("usable provider response\n");

      expect((await fresh.getJobSnapshot("no-output"))?.status).toBe("orphaned");
      const missing = await readPersistedRequest(rec, "corr-no-output");
      expect(missing?.status).toBe("failed");
      expect(missing?.exitCode).toBe(1);
      expect(missing?.errorMessage).toBe("orphaned after gateway restart");
      expect(missing?.response).toBe("");
    } finally {
      await rec.close();
    }
  });

  it("returns null when looking up a job ID that exists nowhere", async () => {
    expect(await manager.getJobSnapshot("does-not-exist")).toBeNull();
    expect(await manager.getJobResult("does-not-exist")).toBeNull();
  });

  it("does not dedup across different cli or args", async () => {
    const args1 = ["-p", "first"];
    const t = new Date().toISOString();
    await store.recordStart({
      id: "claude-job",
      correlationId: "c1",
      requestKey: computeRequestKey("claude", args1),
      cli: "claude",
      args: args1,
      startedAt: t,
      pid: 1,
    });
    await store.recordComplete({
      id: "claude-job",
      status: "completed",
      exitCode: 0,
      stdout: "first",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: t,
    });

    // Different cli: should NOT dedup. We can verify by checking that
    // findByRequestKey misses on the codex key.
    expect(await store.findByRequestKey(computeRequestKey("codex", args1))).toBeNull();

    // Different args: should NOT dedup either.
    expect(
      await store.findByRequestKey(computeRequestKey("claude", ["-p", "different"]))
    ).toBeNull();
  });
});
