import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JobStore,
  computeRequestKey,
  resolveDedupWindowMs,
  resolveJobRetentionMs,
} from "../job-store.js";

describe("JobStore", () => {
  let tempDir: string;
  let dbPath: string;
  let store: JobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "job-store-test-"));
    dbPath = join(tempDir, "jobs.db");
    store = new JobStore(dbPath);
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

  describe("findByRequestKey (dedup lookup)", () => {
    it("returns null when no matching job exists", () => {
      const found = store.findByRequestKey("nope");
      expect(found).toBeNull();
    });

    it("returns a recent running job", () => {
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
      expect(found?.status).toBe("running");
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

  describe("markOrphanedOnStartup", () => {
    it("flips running rows to orphaned and leaves terminal rows alone", () => {
      const t = new Date().toISOString();
      store.recordStart({
        id: "running",
        correlationId: "cr",
        requestKey: "k1",
        cli: "claude",
        args: ["-p", "still going"],
        startedAt: t,
        pid: 100,
      });
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

      const changes = store.markOrphanedOnStartup();
      expect(changes).toBe(1);

      expect(store.getById("running")?.status).toBe("orphaned");
      expect(store.getById("running")?.error).toContain("Gateway restarted");
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

    it("keeps running jobs (far-future expiry) untouched", () => {
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
      expect(store.getById("live")?.status).toBe("running");
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
});
