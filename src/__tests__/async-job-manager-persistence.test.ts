import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager } from "../async-job-manager.js";
import { readPersistedRequest } from "../cache-stats.js";
import { FlightRecorder } from "../flight-recorder.js";
import { SqliteJobStore, type JobStore, computeRequestKey } from "../job-store.js";

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

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ajm-store-test-"));
    dbPath = join(tempDir, "jobs.db");
    store = new SqliteJobStore(dbPath);
    manager = new AsyncJobManager(undefined, undefined, store);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("dedups onto a recent completed job without spawning a new process", () => {
    const cli = "claude" as const;
    const args = ["-p", "what is 2+2", "--model", "haiku"];
    const requestKey = computeRequestKey(cli, args);
    const t = new Date().toISOString();

    // Pre-seed the store with a completed job that matches.
    store.recordStart({
      id: "preexisting-job",
      correlationId: "prior-corr",
      requestKey,
      cli,
      args,
      startedAt: t,
      pid: 1234,
    });
    store.recordComplete({
      id: "preexisting-job",
      status: "completed",
      exitCode: 0,
      stdout: "4",
      stderr: "",
      outputTruncated: false,
      error: null,
      finishedAt: t,
    });

    const outcome = manager.startJobWithDedup(cli, args, "new-corr-id");

    expect(outcome.deduped).toBe(true);
    expect(outcome.snapshot.id).toBe("preexisting-job");
    expect(outcome.snapshot.status).toBe("completed");
    expect(outcome.originalCorrelationId).toBe("prior-corr");

    // Result should be retrievable.
    const result = manager.getJobResult("preexisting-job");
    expect(result?.stdout).toBe("4");
    expect(result?.exitCode).toBe(0);
  });

  it("getJobResult falls back to JobStore for jobs not in memory", () => {
    const cli = "gemini" as const;
    const args = ["hello", "--model", "flash"];
    const t = new Date().toISOString();

    store.recordStart({
      id: "historic-job",
      correlationId: "historic",
      requestKey: computeRequestKey(cli, args),
      cli,
      args,
      startedAt: t,
      pid: 9999,
    });
    store.recordComplete({
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
    const snapshot = manager.getJobSnapshot("historic-job");
    expect(snapshot?.status).toBe("completed");

    const result = manager.getJobResult("historic-job");
    expect(result?.stdout).toBe("hi from gemini");
  });

  it("markOrphanedOnStartup runs on construction and rewrites running rows", () => {
    // Seed a 'running' row from a prior gateway run.
    const t = new Date().toISOString();
    store.recordStart({
      id: "orphan-candidate",
      correlationId: "prior",
      requestKey: "k",
      cli: "codex",
      args: ["exec", "hi"],
      startedAt: t,
      pid: 1,
    });

    // Spin up a fresh manager — its constructor should mark the row orphaned.
    const fresh = new AsyncJobManager(undefined, undefined, store);

    const snapshot = fresh.getJobSnapshot("orphan-candidate");
    expect(snapshot?.status).toBe("orphaned");
    expect(snapshot?.error).toContain("Gateway restarted");
  });

  it("orphaned startup readback preserves captured stdout as completed and no-output rows as restart failures", () => {
    const rec = new FlightRecorder(join(tempDir, "logs.db"));
    try {
      const startedAt = new Date(Date.now() - 5000).toISOString();
      store.recordStart({
        id: "captured-output",
        correlationId: "corr-captured-output",
        requestKey: "captured-key",
        cli: "grok",
        args: ["-p", "review"],
        startedAt,
        pid: 123,
      });
      store.recordOutput("captured-output", "usable provider response\n", "", false);
      rec.logStart({
        correlationId: "corr-captured-output",
        cli: "grok",
        model: "default",
        prompt: "review",
        asyncJobId: "captured-output",
      });

      store.recordStart({
        id: "no-output",
        correlationId: "corr-no-output",
        requestKey: "no-output-key",
        cli: "mistral",
        args: ["-p", "review"],
        startedAt,
        pid: 124,
      });
      rec.logStart({
        correlationId: "corr-no-output",
        cli: "mistral",
        model: "default",
        prompt: "review",
        asyncJobId: "no-output",
      });

      const fresh = new AsyncJobManager(undefined, undefined, store, rec);

      expect(fresh.getJobSnapshot("captured-output")?.status).toBe("orphaned");
      expect(fresh.getJobResult("captured-output")?.stdout).toBe("usable provider response\n");
      const captured = readPersistedRequest(rec, "corr-captured-output");
      expect(captured?.status).toBe("completed");
      expect(captured?.exitCode).toBe(0);
      expect(captured?.errorMessage).toBeNull();
      expect(captured?.response).toBe("usable provider response\n");

      expect(fresh.getJobSnapshot("no-output")?.status).toBe("orphaned");
      const missing = readPersistedRequest(rec, "corr-no-output");
      expect(missing?.status).toBe("failed");
      expect(missing?.exitCode).toBe(1);
      expect(missing?.errorMessage).toBe("orphaned after gateway restart");
      expect(missing?.response).toBe("");
    } finally {
      rec.close();
    }
  });

  it("returns null when looking up a job ID that exists nowhere", () => {
    expect(manager.getJobSnapshot("does-not-exist")).toBeNull();
    expect(manager.getJobResult("does-not-exist")).toBeNull();
  });

  it("does not dedup across different cli or args", () => {
    const args1 = ["-p", "first"];
    const t = new Date().toISOString();
    store.recordStart({
      id: "claude-job",
      correlationId: "c1",
      requestKey: computeRequestKey("claude", args1),
      cli: "claude",
      args: args1,
      startedAt: t,
      pid: 1,
    });
    store.recordComplete({
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
    expect(store.findByRequestKey(computeRequestKey("codex", args1))).toBeNull();

    // Different args: should NOT dedup either.
    expect(store.findByRequestKey(computeRequestKey("claude", ["-p", "different"]))).toBeNull();
  });
});
