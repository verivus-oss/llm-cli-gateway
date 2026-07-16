import { afterEach, describe, expect, it, vi } from "vitest";

const launchFailure = vi.hoisted(() => ({ error: null as Error | null }));

vi.mock("../executor.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../executor.js")>();
  return {
    ...actual,
    spawnCliProcess: (...args: Parameters<typeof actual.spawnCliProcess>) => {
      if (launchFailure.error) throw launchFailure.error;
      return actual.spawnCliProcess(...args);
    },
  };
});

import { AsyncJobManager } from "../async-job-manager.js";
import { CLI_INPUT_TOO_LARGE_CATEGORY } from "../cli-input-limits.js";
import { MemoryJobStore } from "../job-store.js";
import { noopLogger } from "../logger.js";

describe("AsyncJobManager wrapped E2BIG classification", () => {
  afterEach(() => {
    launchFailure.error = null;
  });

  it("preserves a wrapped native E2BIG category in snapshots, results, and storage", async () => {
    const native = Object.assign(new Error("spawn codex E2BIG"), { code: "E2BIG" });
    launchFailure.error = new Error("launch retry wrapper", { cause: native });
    const store = new MemoryJobStore();
    const manager = new AsyncJobManager(noopLogger, undefined, store);
    try {
      const started = manager.startJob("codex", ["exec", "--", "-"], "corr-wrapped-e2big");

      expect(started).toMatchObject({
        status: "failed",
        exitCode: 126,
        errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
        retryable: false,
      });
      expect(started.error).toContain("will not truncate");
      expect(manager.getJobResult(started.id)).toMatchObject({
        errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
        retryable: false,
      });
      expect(store.getById(started.id)).toMatchObject({
        status: "failed",
        errorCategory: CLI_INPUT_TOO_LARGE_CATEGORY,
        retryable: false,
      });
    } finally {
      await manager.dispose();
    }
  });
});
