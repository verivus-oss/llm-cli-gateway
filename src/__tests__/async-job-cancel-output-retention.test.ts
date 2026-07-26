import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { readPersistedRequest } from "../cache-stats.js";
import { FlightRecorder } from "../flight-recorder.js";
import { SqliteJobStore, type JobStore } from "../job-store.js";

/** Poll until predicate returns true, or reject after timeoutMs. */
function waitFor(fn: () => boolean, timeoutMs: number, intervalMs = 25): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

/**
 * Build a child that writes `early` immediately, then nothing until it is asked
 * to stop, at which point it flushes `late` and exits. This models every
 * provider CLI that accumulates its answer and writes it in one burst on
 * shutdown (mistral/vibe, cursor, devin) rather than streaming as it goes
 * (codex, claude).
 *
 * Deliberately node rather than a shell `trap`. A POSIX shell only runs a trap
 * once the current foreground command finishes, so a `sleep` loop adds latency
 * that races the gateway's 5s SIGKILL escalation on a loaded CI runner. Node
 * handles the signal immediately, and the write callback guarantees the bytes
 * are flushed before exit rather than truncated by it.
 */
function flushOnSigtermArgs(early: string, late: string): string[] {
  return [
    "-e",
    `process.on("SIGTERM", () => { process.stdout.write(${JSON.stringify(late)}, () => process.exit(0)); });` +
      `process.stdout.write(${JSON.stringify(early)});` +
      `setInterval(() => {}, 1000);`,
  ];
}

const FLUSH_ON_SIGTERM = flushOnSigtermArgs("EARLY_BYTES", "LATE_FLUSH_MARKER");

describe("recordComplete reports whether the completion guard admitted the write", () => {
  let tempDir: string;
  let store: JobStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ajm-record-complete-"));
    store = new SqliteJobStore(join(tempDir, "jobs.db"));
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* ignore */
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns true on an open row and false once the row is already terminal", () => {
    const t = new Date().toISOString();
    store.recordStart({
      id: "guard-job",
      correlationId: "guard-corr",
      requestKey: "guard-key",
      cli: "claude",
      args: ["-p", "hi"],
      startedAt: t,
      pid: 4242,
    });

    const terminal = {
      id: "guard-job",
      status: "canceled" as const,
      exitCode: null,
      stdout: "PARTIAL",
      stderr: "",
      outputTruncated: false,
      error: "canceled by caller",
      finishedAt: t,
    };

    // First write lands: the row was still open.
    expect(store.recordComplete(terminal)).toBe(true);
    // Second write is rejected by the #139 guard, which is exactly why late
    // output cannot ride along on a replayed recordComplete.
    expect(store.recordComplete({ ...terminal, stdout: "PARTIAL+LATE" })).toBe(false);
    expect(store.getById("guard-job")?.stdout).toBe("PARTIAL");

    // ...but the unfenced output write still lands, without disturbing the
    // committed terminal state. That is the path persistComplete falls back to.
    store.recordOutput("guard-job", "PARTIAL+LATE", "", false);
    const row = store.getById("guard-job");
    expect(row?.stdout).toBe("PARTIAL+LATE");
    expect(row?.status).toBe("canceled");
    expect(row?.error).toBe("canceled by caller");
  });
});

describe("late child output survives a terminal-status-before-close transition", () => {
  let tempDir: string;
  let store: JobStore;
  let manager: AsyncJobManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "ajm-late-output-"));
    store = new SqliteJobStore(join(tempDir, "jobs.db"));
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

  it("persists bytes the child emits between cancel and close", async () => {
    const job = manager.startJob("node" as LlmCli, FLUSH_ON_SIGTERM, "corr-cancel-flush");

    // Wait until the child is up and the gateway has seen its first bytes.
    await waitFor(() => (manager.getJobSnapshot(job.id)?.stdoutBytes ?? 0) >= 11, 25_000);

    expect(manager.cancelJob(job.id).canceled).toBe(true);

    // `canceled` is set the instant the signal is requested; the child only
    // closes once it has run its SIGTERM handler. Wait for the real death.
    await waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 25_000);
    // Let the close handler's terminal persistence run.
    await waitFor(() => store.getById(job.id)?.status === "canceled", 25_000);

    const inMemory = manager.getJobResult(job.id);
    expect(inMemory?.stdout).toContain("EARLY_BYTES");
    // The gateway DOES receive the late flush: it is in the in-memory buffer.
    expect(inMemory?.stdout).toContain("LATE_FLUSH_MARKER");

    // ...and it must also reach the durable store, which is the only copy that
    // survives a gateway restart or is visible to another instance.
    const row = store.getById(job.id);
    expect(row?.status).toBe("canceled");
    expect(row?.stdout).toContain("EARLY_BYTES");
    expect(row?.stdout).toContain("LATE_FLUSH_MARKER");
  }, 60_000);

  it("refreshes the flight-recorder response with bytes flushed after cancel", async () => {
    const rec = new FlightRecorder(join(tempDir, "logs.db"));
    const frManager = new AsyncJobManager(undefined, undefined, store, rec);
    try {
      const outcome = frManager.startJobWithDedup(
        "node" as LlmCli,
        FLUSH_ON_SIGTERM,
        "corr-fr-flush",
        {
          writeFlightStart: true,
          flightRecorderEntry: {
            model: "test-model",
            prompt: "assembled prompt",
            sessionId: "sess-fr",
            stablePrefixHash: "deadbeef",
            stablePrefixTokens: 1,
          },
          forceRefresh: true,
        }
      );
      const jobId = outcome.snapshot.id;

      await waitFor(() => (frManager.getJobSnapshot(jobId)?.stdoutBytes ?? 0) >= 11, 25_000);
      expect(frManager.cancelJob(jobId).canceled).toBe(true);
      await waitFor(() => frManager.getJobSnapshot(jobId)?.exited === true, 25_000);

      // llm_request_result reads this row; it is the documented way to read a
      // full response back, so it must not stop at the pre-cancel snapshot.
      await waitFor(
        () => (readPersistedRequest(rec, "corr-fr-flush")?.response ?? "").includes("LATE"),
        25_000
      );
      const persisted = readPersistedRequest(rec, "corr-fr-flush");
      expect(persisted?.response).toContain("EARLY_BYTES");
      expect(persisted?.response).toContain("LATE_FLUSH_MARKER");
    } finally {
      rec.close();
    }
  }, 60_000);

  it("keeps the flight-recorder row refreshable after the dead-process sweep fires", async () => {
    // The dead-process sweep marks a job failed the moment `kill(pid, 0)`
    // reports ESRCH. A vanished pid is NOT a drained pipe: node still delivers
    // buffered stdout before it emits `close`. If the flight row were finalized
    // on that speculative signal, those bytes would never reach the persisted
    // response, even though the job store still picks them up at close.
    const rec = new FlightRecorder(join(tempDir, "logs.db"));
    const frManager = new AsyncJobManager(undefined, undefined, store, rec);
    try {
      const outcome = frManager.startJobWithDedup(
        "node" as LlmCli,
        FLUSH_ON_SIGTERM,
        "corr-esrch",
        {
          writeFlightStart: true,
          flightRecorderEntry: {
            model: "test-model",
            prompt: "assembled prompt",
            sessionId: "sess-esrch",
            stablePrefixHash: "deadbeef",
            stablePrefixTokens: 1,
          },
          forceRefresh: true,
        }
      );
      const jobId = outcome.snapshot.id;
      await waitFor(() => (frManager.getJobSnapshot(jobId)?.stdoutBytes ?? 0) >= 11, 25_000);

      const internals = frManager as unknown as {
        jobs: Map<string, { process: { pid: number } | null }>;
        evictCompletedJobs: () => void;
      };
      const record = internals.jobs.get(jobId)!;
      const realPid = record.process!.pid;
      // Point the manager's handle at a pid that cannot exist, so the sweep
      // takes the ESRCH branch while the real child keeps running and its
      // close handler stays wired up.
      record.process = { pid: 0x7ffffff0 };
      internals.evictCompletedJobs();

      // The sweep wrote the row from the bytes known at that instant.
      expect(readPersistedRequest(rec, "corr-esrch")?.response).toContain("EARLY_BYTES");
      expect(readPersistedRequest(rec, "corr-esrch")?.response ?? "").not.toContain("LATE");

      // Now let the real child flush and close.
      process.kill(realPid, "SIGTERM");
      await waitFor(
        () => (readPersistedRequest(rec, "corr-esrch")?.response ?? "").includes("LATE"),
        25_000
      );
      expect(readPersistedRequest(rec, "corr-esrch")?.response).toContain("LATE_FLUSH_MARKER");
    } finally {
      rec.close();
    }
  }, 60_000);

  it("persists bytes the child emits after the output cap trips and before close", async () => {
    // The overflow branch rejects ONLY the chunk that would cross the cap, so a
    // later smaller chunk still fits and IS appended. Those bytes need the same
    // rescue as the cancel path. (An earlier draft of the diagnosis claimed
    // overflow could never accumulate late bytes; this test is why that was
    // wrong.)
    const capped = new AsyncJobManager(undefined, undefined, store, undefined, {
      maxRunningJobs: 1000,
      maxRunningJobsPerProvider: 1000,
      maxQueuedJobs: 1000,
      queueTimeoutMs: 600_000,
      completedJobMemoryTtlMs: 3_600_000,
      maxJobOutputBytes: 10,
    });

    // 11 bytes crosses the 10-byte cap and is dropped; the 1-byte SIGTERM
    // flush that follows still fits under it.
    const job = capped.startJob(
      "node" as LlmCli,
      flushOnSigtermArgs("AAAAAAAAAAA", "X"),
      "corr-overflow-flush"
    );
    await waitFor(() => capped.getJobSnapshot(job.id)?.exited === true, 15_000);
    await waitFor(() => store.getById(job.id)?.status === "failed", 25_000);

    const row = store.getById(job.id);
    expect(row?.outputTruncated).toBe(true);
    expect(row?.exitCode).toBe(126);
    // The post-cap byte reached the durable store.
    expect(row?.stdout).toBe("X");
  }, 60_000);

  it("never overwrites a row another writer terminalized, including at close", async () => {
    // The dangerous sequence, which a single-persist test does NOT reach:
    //   1. another writer (another gateway instance on a shared Postgres store)
    //      commits this row's terminal state;
    //   2. our cancel calls recordComplete and the guard REJECTS it;
    //   3. the child then closes, and persistComplete runs a SECOND time.
    // Step 3 is where an ownership-blind implementation writes our stdout over
    // their result. recordOutput has no owner predicate, so nothing downstream
    // would catch it.
    const job = manager.startJob("node" as LlmCli, FLUSH_ON_SIGTERM, "corr-foreign-row");
    await waitFor(() => (manager.getJobSnapshot(job.id)?.stdoutBytes ?? 0) >= 11, 25_000);

    // Step 1: a genuinely foreign terminal row, written straight to the store.
    const foreignFinishedAt = new Date().toISOString();
    expect(
      store.recordComplete({
        id: job.id,
        status: "completed",
        exitCode: 0,
        stdout: "FOREIGN_INSTANCE_RESULT",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: foreignFinishedAt,
      })
    ).toBe(true);

    // Steps 2 and 3.
    manager.cancelJob(job.id);
    await waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 25_000);
    await new Promise(r => setTimeout(r, 500));

    const row = store.getById(job.id);
    expect(row?.stdout).toBe("FOREIGN_INSTANCE_RESULT");
    expect(row?.status).toBe("completed");
    expect(row?.exitCode).toBe(0);
    // Our own bytes must not have leaked in through the unfenced write.
    expect(row?.stdout).not.toContain("EARLY_BYTES");
    expect(row?.stdout).not.toContain("LATE_FLUSH_MARKER");
  }, 60_000);

  it("never overwrites a foreign row through the routine throttled flush either", async () => {
    // The ownership rule has to hold for EVERY route that calls the unfenced
    // recordOutput, not just the post-terminal one. The routine flush in
    // maybeFlushOutput is throttled by OUTPUT_FLUSH_INTERVAL_MS (1000ms), so a
    // chunk arriving after that window is its own way onto the row. This case
    // deliberately waits past the throttle before the foreign write, which the
    // post-terminal-only guard does not cover.
    const job = manager.startJob("node" as LlmCli, FLUSH_ON_SIGTERM, "corr-foreign-flush");
    await waitFor(() => (manager.getJobSnapshot(job.id)?.stdoutBytes ?? 0) >= 11, 25_000);
    // Let the flush throttle lapse so the next chunk can flush immediately.
    await new Promise(r => setTimeout(r, 1300));

    expect(
      store.recordComplete({
        id: job.id,
        status: "completed",
        exitCode: 0,
        stdout: "FOREIGN_INSTANCE_RESULT",
        stderr: "",
        outputTruncated: false,
        error: null,
        finishedAt: new Date().toISOString(),
      })
    ).toBe(true);

    manager.cancelJob(job.id);
    await waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 25_000);
    await new Promise(r => setTimeout(r, 800));

    const row = store.getById(job.id);
    expect(row?.stdout).toBe("FOREIGN_INSTANCE_RESULT");
    expect(row?.status).toBe("completed");
  }, 60_000);

  it("persists bytes the child emits between an idle-timeout kill and close", async () => {
    // idleTimeoutMs fires because the child stays silent after its first bytes.
    // Keep it under OUTPUT_FLUSH_INTERVAL_MS (1000ms) so the late flush lands
    // while the throttled output write is still closed; otherwise the unfenced
    // recordOutput would mask the fenced terminal write and this would pass
    // even without the fix.
    const job = manager.startJob(
      "node" as LlmCli,
      FLUSH_ON_SIGTERM,
      "corr-idle-flush",
      undefined,
      400
    );

    await waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 15_000);
    await waitFor(() => store.getById(job.id)?.status === "failed", 25_000);

    const row = store.getById(job.id);
    expect(row?.exitCode).toBe(125);
    expect(row?.stdout).toContain("EARLY_BYTES");
    expect(row?.stdout).toContain("LATE_FLUSH_MARKER");
  }, 60_000);
});
