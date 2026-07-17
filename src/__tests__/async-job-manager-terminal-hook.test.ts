import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { SqliteJobStore } from "../job-store.js";
import type { KitExecutionRef } from "../personal-config-types.js";

function execution(): KitExecutionRef {
  return {
    version: 1,
    releaseId: "terminal-hook-release",
    configStamp: "terminal-hook-stamp",
    scopeRoot: "/workspace/terminal-hook",
    scopeHead: "terminal-hook-head",
    contextIdentity: "terminal-hook-context",
  };
}

describe("AsyncJobManager terminal hooks", () => {
  it("awaits a successful hook before acknowledging Kit finalization and reports failures", async () => {
    const testDir = mkdtempSync(join(tmpdir(), "kit-terminal-hook-"));
    const store = new SqliteJobStore(join(testDir, "jobs.db"));
    const manager = new AsyncJobManager(undefined, undefined, store);
    let releaseHook!: () => void;
    const hookGate = new Promise<void>(resolve => {
      releaseHook = resolve;
    });
    let signalHookStarted!: () => void;
    const hookStarted = new Promise<void>(resolve => {
      signalHookStarted = resolve;
    });

    try {
      const successful = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "true"],
        "terminal-hook-success",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-terminal-hook-success",
          jobId: randomUUID(),
          forceRefresh: true,
          onTerminal: async () => {
            signalHookStarted();
            await hookGate;
          },
        }
      );

      const successfulOutcome = manager.awaitTerminalHook(successful.snapshot.id);
      await hookStarted;
      expect(store.getById(successful.snapshot.id)?.kitTerminalFinalized).toBe(false);

      releaseHook();
      await expect(successfulOutcome).resolves.toBe(true);
      expect(store.getById(successful.snapshot.id)?.kitTerminalFinalized).toBe(true);

      const failed = manager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "true"],
        "terminal-hook-failure",
        {
          kitExecution: execution(),
          kitSessionId: "gateway-terminal-hook-failure",
          jobId: randomUUID(),
          forceRefresh: true,
          onTerminal: () => {
            throw new Error("terminal finalization failed");
          },
        }
      );

      await expect(manager.awaitTerminalHook(failed.snapshot.id)).resolves.toBe(false);
      expect(store.getById(failed.snapshot.id)?.kitTerminalFinalized).toBe(false);
    } finally {
      await manager.dispose();
      store.close();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
