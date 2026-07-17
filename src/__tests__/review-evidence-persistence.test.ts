import { describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

async function waitForTerminal(manager: AsyncJobManager, jobId: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const snapshot = manager.getJobSnapshot(jobId);
    if (snapshot && snapshot.status !== "queued" && snapshot.status !== "running") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error("review evidence job did not reach a terminal state");
}

describe("retained review job evidence", () => {
  it("persists the exact retained payload while replacing prompt-bearing argv", async () => {
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    const evidence = "exact fenced repository evidence: 重要🙂";
    const payloadJson = JSON.stringify({
      schemaVersion: "review-job-input.v1",
      promptSha256: "a".repeat(64),
      prompt: evidence,
    });

    const outcome = manager.startJobWithDedup(
      "sh" as LlmCli,
      ["-c", "exit 0", evidence],
      "review-evidence-persistence",
      {
        persistedArgs: ["-c", "exit 0", "[review prompt retained in payload_json]"],
        payloadJson,
      }
    );
    await waitForTerminal(manager, outcome.snapshot.id);

    const row = store.getById(outcome.snapshot.id);
    expect(row).not.toBeNull();
    expect(row!.argsJson).not.toContain(evidence);
    expect(JSON.parse(row!.argsJson)).toEqual([
      "-c",
      "exit 0",
      "[review prompt retained in payload_json]",
    ]);
    expect(row!.payloadJson).toBe(payloadJson);
    expect(JSON.parse(row!.payloadJson!)).toMatchObject({
      schemaVersion: "review-job-input.v1",
      prompt: evidence,
    });
  });
});
