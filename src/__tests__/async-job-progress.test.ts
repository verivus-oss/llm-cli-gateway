import { describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

async function waitForTerminal(manager: AsyncJobManager, jobId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const job = manager.getJobSnapshot(jobId);
    if (job && job.status !== "queued" && job.status !== "running") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("job did not reach a terminal state");
}

describe("AsyncJobManager normalized progress", () => {
  it("persists bounded lifecycle and activity without raw output", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const secret = "raw-output-must-not-enter-progress";
    const started = manager.startJob(
      "sh" as LlmCli,
      ["-c", `printf '${secret}'`],
      "progress-persist"
    );

    await waitForTerminal(manager, started.id);
    const snapshot = manager.getJobSnapshot(started.id)!;
    const persisted = store.getById(started.id)!;

    expect(snapshot.status).toBe("completed");
    expect(snapshot.progress.capability).toBe("activity_only");
    expect(snapshot.progress.events.map(event => event.kind)).toEqual(
      expect.arrayContaining(["lifecycle", "activity", "terminal"])
    );
    expect(snapshot.progress.events.at(-1)).toMatchObject({
      phase: "completed",
      kind: "terminal",
      message: "Job completed",
    });
    expect(persisted.progressJson).toContain('"version":1');
    expect(persisted.progressJson).not.toContain(secret);

    const hydrated = new AsyncJobManager(noopLogger, undefined, store);
    const restored = hydrated.getJobSnapshot(started.id)!;
    expect(restored.progress.lastSeq).toBe(snapshot.progress.lastSeq);
    expect(restored.progress.events).toEqual(snapshot.progress.events);

    const afterFirst = hydrated.getJobSnapshot(started.id, {
      afterProgressSeq: restored.progress.events[0]!.seq,
      progressLimit: 2,
    })!;
    expect(afterFirst.progress.events.length).toBeLessThanOrEqual(2);
    expect(
      afterFirst.progress.events.every(event => event.seq > restored.progress.events[0]!.seq)
    ).toBe(true);
  });

  it("records failed and canceled terminal events exactly once", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const failed = manager.startJob("sh" as LlmCli, ["-c", "exit 7"], "progress-failed");
    await waitForTerminal(manager, failed.id);

    const failedSnapshot = manager.getJobSnapshot(failed.id)!;
    expect(failedSnapshot.progress.events.filter(event => event.kind === "terminal")).toHaveLength(
      1
    );
    expect(failedSnapshot.progress.events.at(-1)).toMatchObject({
      phase: "failed",
      kind: "terminal",
      message: "Job failed",
    });

    const canceled = manager.startJob("sleep" as LlmCli, ["30"], "progress-canceled");
    expect(manager.cancelJob(canceled.id)).toEqual({ canceled: true });
    await waitForTerminal(manager, canceled.id);
    const canceledSnapshot = manager.getJobSnapshot(canceled.id)!;
    expect(
      canceledSnapshot.progress.events.filter(event => event.kind === "terminal")
    ).toHaveLength(1);
    expect(canceledSnapshot.progress.events.at(-1)?.message).toBe("Job canceled");
  });
});
