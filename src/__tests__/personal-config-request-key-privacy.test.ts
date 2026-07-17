import { randomUUID } from "crypto";
import { existsSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AsyncJobManager, type LlmCli } from "../async-job-manager.js";
import { SqliteJobStore } from "../job-store.js";
import type { KitExecutionRef } from "../personal-config-types.js";

let testDir: string | null = null;

afterEach(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
  testDir = null;
});

function execution(contextIdentity: string): KitExecutionRef {
  return {
    version: 1,
    releaseId: "release-request-key-privacy",
    configStamp: "stamp-request-key-privacy",
    scopeRoot: "/workspace/request-key-privacy",
    scopeHead: "head-request-key-privacy",
    contextIdentity,
  };
}

describe("Personal Agent Config Kit durable request keys", () => {
  it("uses the reserved job id instead of private execution inputs", async () => {
    testDir = join(
      tmpdir(),
      `kit-request-key-privacy-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    mkdirSync(testDir, { recursive: true });

    const firstStore = new SqliteJobStore(join(testDir, "first.db"));
    const secondStore = new SqliteJobStore(join(testDir, "second.db"));
    const firstManager = new AsyncJobManager(undefined, undefined, firstStore);
    const secondManager = new AsyncJobManager(undefined, undefined, secondStore);
    const jobId = randomUUID();
    const firstPrivate = {
      arg: "PRIVATE_KIT_ARG_FIRST",
      stdin: "PRIVATE_KIT_STDIN_FIRST",
      context: "PRIVATE_KIT_CONTEXT_FIRST",
    };
    const secondPrivate = {
      arg: "PRIVATE_KIT_ARG_SECOND",
      stdin: "PRIVATE_KIT_STDIN_SECOND",
      context: "PRIVATE_KIT_CONTEXT_SECOND",
    };

    try {
      const first = firstManager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "sleep 0.2", "kit-private-argv", firstPrivate.arg],
        "kit-request-key-first",
        {
          kitExecution: execution(firstPrivate.context),
          kitSessionId: "gateway-request-key-first",
          jobId,
          forceRefresh: true,
          stdin: firstPrivate.stdin,
          onTerminal: () => {},
        }
      );
      const second = secondManager.startJobWithDedup(
        "sh" as LlmCli,
        ["-c", "sleep 0.2", "kit-private-argv", secondPrivate.arg],
        "kit-request-key-second",
        {
          kitExecution: execution(secondPrivate.context),
          kitSessionId: "gateway-request-key-second",
          jobId,
          forceRefresh: true,
          stdin: secondPrivate.stdin,
          onTerminal: () => {},
        }
      );

      expect(first.deduped).toBe(false);
      expect(second.deduped).toBe(false);

      const firstRecord = firstStore.getById(jobId);
      const secondRecord = secondStore.getById(jobId);
      const expectedRequestKey = `kit:${jobId}`;

      expect(firstRecord?.requestKey).toBe(expectedRequestKey);
      expect(secondRecord?.requestKey).toBe(expectedRequestKey);
      expect(secondRecord?.requestKey).toBe(firstRecord?.requestKey);
      for (const privateValue of Object.values(firstPrivate)) {
        expect(firstRecord?.requestKey).not.toContain(privateValue);
      }
      for (const privateValue of Object.values(secondPrivate)) {
        expect(secondRecord?.requestKey).not.toContain(privateValue);
      }
    } finally {
      await Promise.all([
        firstManager.dispose({ timeoutMs: 1_000 }),
        secondManager.dispose({ timeoutMs: 1_000 }),
      ]);
      firstStore.close();
      secondStore.close();
    }
  });
});
