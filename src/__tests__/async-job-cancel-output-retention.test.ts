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
