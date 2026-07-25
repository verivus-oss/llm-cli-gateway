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
 * A child that emits nothing until it is asked to stop, then flushes a marker
 * on SIGTERM before exiting. This models every provider CLI that accumulates
 * its answer and writes it in one burst on shutdown (mistral/vibe, cursor,
 * devin), rather than streaming it as it goes (codex, claude).
 */
const FLUSH_ON_SIGTERM = `trap 'printf "%s" "LATE_FLUSH_MARKER"; exit 0' TERM
printf "%s" "EARLY_BYTES"
while :; do sleep 0.05; done`;

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
    const job = manager.startJob("sh" as LlmCli, ["-c", FLUSH_ON_SIGTERM], "corr-cancel-flush");

    // Wait until the child is up and the gateway has seen its first bytes.
    await waitFor(() => (manager.getJobSnapshot(job.id)?.stdoutBytes ?? 0) >= 11, 10_000);

    expect(manager.cancelJob(job.id).canceled).toBe(true);

    // `canceled` is set the instant the signal is requested; the child only
    // closes once it has run its SIGTERM handler. Wait for the real death.
    await waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 10_000);
    // Let the close handler's terminal persistence run.
    await waitFor(() => store.getById(job.id)?.status === "canceled", 10_000);

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
  }, 30_000);

  it("refreshes the flight-recorder response with bytes flushed after cancel", async () => {
    const rec = new FlightRecorder(join(tempDir, "logs.db"));
    const frManager = new AsyncJobManager(undefined, undefined, store, rec);
    try {
      const outcome = frManager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", FLUSH_ON_SIGTERM],
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

      await waitFor(() => (frManager.getJobSnapshot(jobId)?.stdoutBytes ?? 0) >= 11, 10_000);
      expect(frManager.cancelJob(jobId).canceled).toBe(true);
      await waitFor(() => frManager.getJobSnapshot(jobId)?.exited === true, 10_000);

      // llm_request_result reads this row; it is the documented way to read a
      // full response back, so it must not stop at the pre-cancel snapshot.
      await waitFor(
        () => (readPersistedRequest(rec, "corr-fr-flush")?.response ?? "").includes("LATE"),
        10_000
      );
      const persisted = readPersistedRequest(rec, "corr-fr-flush");
      expect(persisted?.response).toContain("EARLY_BYTES");
      expect(persisted?.response).toContain("LATE_FLUSH_MARKER");
    } finally {
      rec.close();
    }
  }, 30_000);

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
    const script = `trap 'printf "X"; exit 0' TERM
printf "AAAAAAAAAAA"
while :; do sleep 0.05; done`;

    const job = capped.startJob("sh" as LlmCli, ["-c", script], "corr-overflow-flush");
    await waitFor(() => capped.getJobSnapshot(job.id)?.exited === true, 15_000);
    await waitFor(() => store.getById(job.id)?.status === "failed", 10_000);

    const row = store.getById(job.id);
    expect(row?.outputTruncated).toBe(true);
    expect(row?.exitCode).toBe(126);
    // The post-cap byte reached the durable store.
    expect(row?.stdout).toBe("X");
  }, 30_000);

  it("leaves a row alone when the completion guard rejects this instance's write", () => {
    // A rejected guard means another writer already committed a terminal state
    // for this row. recordOutput has no owner predicate, so the manager must
    // NOT force its bytes in over an outcome it does not own.
    const lateWrites: string[] = [];
    const realRecordOutput = store.recordOutput.bind(store);
    // Simulate another writer having already committed this row's terminal
    // state: the guard rejects our completion.
    store.recordComplete = () => false;
    store.recordOutput = (id, stdout, stderr, truncated) => {
      lateWrites.push(stdout);
      realRecordOutput(id, stdout, stderr, truncated);
    };

    const job = manager.startJob("sh" as LlmCli, ["-c", "printf OURS"], "corr-foreign-row");

    return waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 10_000).then(async () => {
      await new Promise(r => setTimeout(r, 300));
      // Throttled mid-flight flushes may legitimately have written; what must
      // NOT happen is a post-terminal write forced in over a row we lost.
      const row = store.getById(job.id);
      expect(row?.status).not.toBe("completed");
      expect(lateWrites.filter(w => w === "OURS").length).toBe(0);
    });
  }, 20_000);

  it("persists bytes the child emits between an idle-timeout kill and close", async () => {
    // idleTimeoutMs fires because the child stays silent after its first bytes.
    // Keep it under OUTPUT_FLUSH_INTERVAL_MS (1000ms) so the late flush lands
    // while the throttled output write is still closed; otherwise the unfenced
    // recordOutput would mask the fenced terminal write and this would pass
    // even without the fix.
    const job = manager.startJob(
      "sh" as LlmCli,
      ["-c", FLUSH_ON_SIGTERM],
      "corr-idle-flush",
      undefined,
      400
    );

    await waitFor(() => manager.getJobSnapshot(job.id)?.exited === true, 15_000);
    await waitFor(() => store.getById(job.id)?.status === "failed", 10_000);

    const row = store.getById(job.id);
    expect(row?.exitCode).toBe(125);
    expect(row?.stdout).toContain("EARLY_BYTES");
    expect(row?.stdout).toContain("LATE_FLUSH_MARKER");
  }, 30_000);
});
