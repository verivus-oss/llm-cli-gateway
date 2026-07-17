import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { JobProgressTracker, parseStoredJobProgress } from "../job-progress.js";
import { MemoryJobStore, SqliteJobStore, type JobStoreStatus } from "../job-store.js";
import { noopLogger } from "../logger.js";

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

class FlakyProgressStore extends MemoryJobStore {
  nextFailure: "status_mismatch" | "throw" | null = null;
  guardedWrites = 0;

  override recordProgressIfStatus(
    id: string,
    status: JobStoreStatus,
    progressJson: string
  ): boolean {
    this.guardedWrites += 1;
    const failure = this.nextFailure;
    this.nextFailure = null;
    if (failure === "status_mismatch") return false;
    if (failure === "throw") throw new Error("injected progress persistence failure");
    return super.recordProgressIfStatus(id, status, progressJson);
  }
}

interface ProgressJobHarness {
  progress: JobProgressTracker;
  progressDirty: boolean;
}

interface ProgressManagerHarness {
  jobs: Map<string, ProgressJobHarness>;
  maybeFlushProgress(job: ProgressJobHarness, force?: boolean): void;
}

const temporaryDirectories: string[] = [];

function temporaryDatabase(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "job-progress-durability-"));
  temporaryDirectories.push(root);
  return { root, path: join(root, "jobs.db") };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("job progress durability", () => {
  it("keeps progress dirty after a status mismatch or store failure and retries it", async () => {
    const store = new FlakyProgressStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const started = manager.startJob("sleep" as LlmCli, ["30"], "progress-retry");

    try {
      await waitFor(
        () =>
          manager.getJobSnapshot(started.id)?.status === "running" &&
          store.getById(started.id)?.status === "running",
        "running job admission"
      );
      const internals = manager as unknown as ProgressManagerHarness;
      const job = internals.jobs.get(started.id);
      expect(job).toBeDefined();

      // A non-coalescible kind: this test asserts distinct seq advancement, and
      // activity/output/reasoning would merge inside the 1s coalesce window.
      job!.progress.emit("starting", "lifecycle", "Provider request started");
      job!.progressDirty = true;
      store.nextFailure = "status_mismatch";
      internals.maybeFlushProgress(job!, true);
      expect(job!.progressDirty).toBe(true);

      internals.maybeFlushProgress(job!, true);
      expect(job!.progressDirty).toBe(false);
      expect(parseStoredJobProgress(store.getById(started.id)?.progressJson)?.lastSeq).toBe(
        job!.progress.snapshot().lastSeq
      );

      job!.progress.emit("starting", "lifecycle", "Provider request started");
      job!.progressDirty = true;
      store.nextFailure = "throw";
      internals.maybeFlushProgress(job!, true);
      expect(job!.progressDirty).toBe(true);

      internals.maybeFlushProgress(job!, true);
      expect(job!.progressDirty).toBe(false);
      expect(store.guardedWrites).toBeGreaterThanOrEqual(5);
      expect(parseStoredJobProgress(store.getById(started.id)?.progressJson)?.lastSeq).toBe(
        job!.progress.snapshot().lastSeq
      );
    } finally {
      manager.cancelJob(started.id);
      await waitFor(
        () => !["queued", "running"].includes(manager.getJobSnapshot(started.id)?.status ?? ""),
        "canceled job termination"
      );
      await manager.dispose({ timeoutMs: 1_000 });
    }
  });

  it("refreshes a cached running projection when another gateway writes progress and completion", async () => {
    const database = temporaryDatabase();
    const writer = new SqliteJobStore(database.path);
    const reader = new SqliteJobStore(database.path);
    const observer = new AsyncJobManager(noopLogger, undefined, reader);
    const startedAt = "2026-07-15T00:00:00.000Z";
    const tracker = new JobProgressTracker("claude", "stream-json", null, startedAt);

    try {
      writer.recordStart({
        id: "shared-review-job",
        correlationId: "shared-review-correlation",
        requestKey: "shared-review-key",
        cli: "claude",
        args: ["--print", "[review evidence retained elsewhere]"],
        outputFormat: "stream-json",
        startedAt,
        pid: null,
        ownerInstance: "writer-instance",
        transport: "process",
      });
      expect(writer.markRunning("shared-review-job", { pid: null })).toBe(true);
      tracker.emit("starting", "lifecycle", "Review started");
      expect(
        writer.recordProgressIfStatus("shared-review-job", "running", tracker.serialize())
      ).toBe(true);

      const first = observer.getJobSnapshot("shared-review-job");
      expect(first).toMatchObject({ status: "running" });
      expect(first?.progress.lastSeq).toBe(1);

      tracker.emit("tool", "tool_start", "Inspecting repository evidence", "provider");
      expect(
        writer.recordProgressIfStatus("shared-review-job", "running", tracker.serialize())
      ).toBe(true);
      const refreshed = observer.getJobSnapshot("shared-review-job");
      expect(refreshed).toMatchObject({ status: "running" });
      expect(refreshed?.progress.lastSeq).toBe(2);
      expect(refreshed?.progress.events.at(-1)?.message).toBe("Using a provider tool");

      tracker.emit("completed", "terminal", "Review completed");
      writer.recordComplete({
        id: "shared-review-job",
        status: "completed",
        exitCode: 0,
        stdout: "approved",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: "2026-07-15T00:01:00.000Z",
        progressJson: tracker.serialize(),
      });
      const terminal = observer.getJobSnapshot("shared-review-job");
      expect(terminal).toMatchObject({ status: "completed", exitCode: 0 });
      expect(terminal?.progress.events.at(-1)).toMatchObject({
        kind: "terminal",
        message: "Review completed",
      });
    } finally {
      await observer.dispose({ timeoutMs: 100 });
      reader.close();
      writer.close();
    }
  });

  it("preserves stored structured capability through redacted hydration and orphaning", async () => {
    const database = temporaryDatabase();
    const store = new SqliteJobStore(database.path);
    const observer = new AsyncJobManager(noopLogger, undefined, store);
    const startedAt = "2026-07-15T00:00:00.000Z";
    const initial = new JobProgressTracker("codex", "json", null, startedAt);
    const stale = new JobProgressTracker("codex", "json", null, startedAt);

    try {
      initial.emit("starting", "lifecycle", "Review started");
      store.recordStart({
        id: "orphaned-review-job",
        correlationId: "orphaned-review-correlation",
        requestKey: "orphaned-review-key",
        cli: "codex",
        // Personal Agent Config Kit persists a fixed marker rather than the
        // real --json argv. Capability must come from progressJson on reload.
        args: ["[personal-config-kit arguments redacted]"],
        outputFormat: "json",
        startedAt,
        pid: null,
        ownerInstance: "stale-owner",
        transport: "process",
      });
      expect(store.markRunning("orphaned-review-job", { pid: null })).toBe(true);
      expect(
        store.recordProgressIfStatus("orphaned-review-job", "running", initial.serialize())
      ).toBe(true);
      expect(observer.getJobSnapshot("orphaned-review-job")?.progress.capability).toBe(
        "structured"
      );
      store.recordComplete({
        id: "orphaned-review-job",
        status: "orphaned",
        exitCode: null,
        stdout: "",
        stderr: "",
        outputTruncated: false,
        error: "Gateway restarted while job was running",
        finishedAt: "2026-07-15T00:01:00.000Z",
      });

      const internals = observer as unknown as { persistOrphanProgress(jobId: string): void };
      internals.persistOrphanProgress("orphaned-review-job");

      stale.emit("thinking", "activity", "Stale owner is still writing", "provider");
      expect(
        store.recordProgressIfStatus("orphaned-review-job", "running", stale.serialize())
      ).toBe(false);
      const persisted = parseStoredJobProgress(store.getById("orphaned-review-job")?.progressJson);
      expect(persisted?.capability).toBe("structured");
      expect(persisted?.events.at(-1)).toMatchObject({
        kind: "terminal",
        message: "Job orphaned after its gateway lease expired",
      });
      expect(store.getById("orphaned-review-job")?.status).toBe("orphaned");
    } finally {
      await observer.dispose({ timeoutMs: 100 });
      store.close();
    }
  });

  it("rejects an oversized persisted projection before accepting otherwise valid fields", () => {
    const oversized = JSON.stringify({
      version: 1,
      capability: "activity_only",
      lastActivityAt: "2026-07-15T00:00:00.000Z",
      lastSeq: 0,
      droppedCount: 0,
      events: [],
      ignoredPadding: "x".repeat(64 * 1024),
    });

    expect(parseStoredJobProgress(oversized)).toBeNull();
  });
});
